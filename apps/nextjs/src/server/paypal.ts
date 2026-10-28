// PayPalEmail adapter — a TS port of
// src/library/Payment/Adapter/PayPalEmail.php::processTransaction.
// Verification (POST cmd=_notify-validate back to PayPal + receiver
// check) runs unless FB_PAYPAL_SKIP_VERIFY=1; PHP skips it only in
// its 'testing' environment, and the reference install runs 'dev',
// so verification runs there too — in the sandbox it fails at the
// TLS/proxy layer and the IPN parks as an error, exactly like PHP.

import { createHmac, timingSafeEqual } from "node:crypto";
import { FbError } from "./dispatch";
import {
  findClientById, findGatewayFull, findInvoiceById, findSubscriptionBySid, findTransactionById, getDb,
  insertBalanceRow, insertSubscription, listInvoiceItems, updateSubscriptionRow, updateTransactionRow,
} from "./db";
import { invoiceTotals, issueInvoice, markInvoicePaid, tryPayWithCredits } from "./money";

type Post = Record<string, string>;

async function gatewayConfig(gatewayId: number): Promise<Record<string, unknown>> {
  const row = await getDb().prepare("SELECT config FROM pay_gateway WHERE id = ?").get(gatewayId) as { config: string | null } | undefined;
  try {
    return row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function gatewayTestMode(gatewayId: number): Promise<boolean> {
  const row = await getDb().prepare("SELECT test_mode FROM pay_gateway WHERE id = ?").get(gatewayId) as { test_mode: number } | undefined;
  return !!row?.test_mode;
}

async function verifyIpn(post: Post, rawBody: string, gatewayId: number): Promise<void> {
  if (process.env.FB_PAYPAL_SKIP_VERIFY === "1") return;
  const config = await gatewayConfig(gatewayId);
  const url = await gatewayTestMode(gatewayId)
    ? "https://www.sandbox.paypal.com/cgi-bin/webscr"
    : "https://www.paypal.com/cgi-bin/webscr";
  const params = new URLSearchParams({ cmd: "_notify-validate" });
  // PHP re-posts the raw body parsed as form fields, urlencoded.
  for (const [k, v] of new URLSearchParams(rawBody)) params.set(k, v);
  let text: string;
  try {
    // Bound the verification call: a hung PayPal endpoint must fail
    // the IPN fast instead of hanging the callback (PHP's download
    // path surfaces its own transport failure the same way).
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    text = await res.text();
  } catch (e) {
    throw new FbError(e instanceof Error ? e.message : "IPN verification failed");
  }
  if (text.trim() !== "VERIFIED") throw new FbError("IPN is invalid");
  const configured = String(config.email ?? "").trim().toLowerCase();
  const payees = [(post.receiver_email ?? "").trim().toLowerCase(), (post.business ?? "").trim().toLowerCase()];
  if (!payees.some((p) => p !== "" && p === configured)) throw new FbError("IPN is invalid");
}

async function verifyCallbackBinding(get: Record<string, string>, post: Post, gatewayId: number, boundInvoiceId: number | null, currentTxId: number | null): Promise<number | null> {
  const invoiceId = boundInvoiceId ?? (get.invoice_id ? parseInt(get.invoice_id, 10) : null);
  if (!invoiceId) return null;
  const salt = process.env.FB_CALLBACK_SALT ?? "";
  const sig = get.sig ?? null;
  if (sig && salt) {
    const expected = createHmac("sha256", salt).update(`${gatewayId}|${invoiceId}`).digest("hex");
    try {
      if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return invoiceId;
    } catch {
      // fall through to the other binding proofs
    }
  }
  const subscrId = post.subscr_id ?? post.recurring_payment_id ?? "";
  if (subscrId) {
    const sub = await findSubscriptionBySid(subscrId);
    if (sub && sub.rel_type === "invoice" && sub.rel_id === invoiceId) return invoiceId;
  }
  if (currentTxId !== null) {
    for (const candidate of [post.txn_id, post.parent_txn_id]) {
      if (!candidate) continue;
      const earlier = await getDb().prepare(
        `SELECT invoice_id FROM "transaction" WHERE txn_id = ? AND gateway_id = ? AND id != ? LIMIT 1`
      ).get(candidate, gatewayId, currentTxId) as { invoice_id: number | null } | undefined;
      if (earlier?.invoice_id === invoiceId) return invoiceId;
    }
  }
  throw new FbError("PayPal callback signature is invalid");
}

function validateCurrency(received: string | undefined, expected: string | undefined): void {
  const r = (received ?? "").trim();
  const e = (expected ?? "").trim();
  if (r === "" || e === "") throw new FbError("PayPal payment is missing currency details");
  if (r.toLowerCase() !== e.toLowerCase()) {
    throw new FbError(`PayPal payment currency ${r} does not match invoice currency ${e}`);
  }
}

async function isIpnDuplicate(ipn: Post): Promise<boolean> {
  const rows = await getDb().prepare(
    `SELECT id FROM "transaction" WHERE txn_id = ? AND txn_status = ? AND type = ? AND amount = ? LIMIT 2`
  ).all(ipn.txn_id ?? null, ipn.payment_status ?? null, ipn.txn_type ?? null, ipn.mc_gross ?? null) as unknown[];
  return rows.length > 1;
}

async function fillTxFields(txId: number, ipn: Post, tx: Record<string, unknown>): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (!tx.type && ipn.txn_type) updates.type = ipn.txn_type;
  if (!tx.txn_id && ipn.txn_id) updates.txn_id = ipn.txn_id;
  if (!tx.txn_status && ipn.payment_status) updates.txn_status = ipn.payment_status;
  if (!tx.amount && ipn.mc_gross) updates.amount = ipn.mc_gross;
  if (!tx.currency && ipn.mc_currency) updates.currency = ipn.mc_currency;
  if (Object.keys(updates).length) await updateTransactionRow(txId, updates);
}

/** Process one PayPalEmail IPN transaction row. Throws FbError; the
 * caller parks the row as 'error' with the message (ipn.php flow). */
export async function processPayPalTransaction(
  txId: number,
  post: Post,
  get: Record<string, string>,
  rawBody: string,
  gatewayId: number,
): Promise<void> {
  if (Object.keys(post).length === 0) {
    throw new FbError("PayPal payment data is missing.", 7021);
  }
  await verifyIpn(post, rawBody, gatewayId);
  const txRow = await findTransactionById(txId);
  if (!txRow) throw new FbError("Transaction not found");
  const tx = txRow as unknown as Record<string, unknown>;
  const verifiedInvoiceId = await verifyCallbackBinding(get, post, gatewayId, (tx.invoice_id as number | null) ?? null, txId);
  const ipn: Post = { ...post };
  if (!ipn.subscr_id && ipn.recurring_payment_id) ipn.subscr_id = ipn.recurring_payment_id;
  if (!ipn.mc_gross && ipn.amount) ipn.mc_gross = ipn.amount;
  if (!ipn.amount3 && ipn.amount) ipn.amount3 = ipn.amount;
  if (!ipn.mc_currency && ipn.amount_currency) ipn.mc_currency = ipn.amount_currency;
  let invoiceId = tx.invoice_id as number | null;
  if (!invoiceId) {
    if (verifiedInvoiceId === null) throw new FbError("PayPal transaction is not associated with an invoice");
    invoiceId = verifiedInvoiceId;
    await updateTransactionRow(txId, { invoice_id: invoiceId });
  }
  await fillTxFields(txId, ipn, tx);
  const invoice = await findInvoiceById(invoiceId);
  if (!invoice) throw new FbError("Invoice was not found");
  const clientId = invoice.client_id;
  const txnType = ipn.txn_type ?? "";
  let awaitingCompletion = false;

  switch (txnType) {
    case "web_accept":
    case "subscr_payment":
    case "recurring_payment": {
      if (ipn.payment_status === "Completed") {
        const fresh = await findTransactionById(txId) as unknown as Record<string, unknown>;
        if (fresh.status === "processed" && fresh.txn_status === "Completed") {
          await updateTransactionRow(txId, { error: "", error_code: null, status: "processed" });
          return;
        }
        if (!ipn.mc_gross || !ipn.txn_id) {
          throw new FbError("PayPal payment is missing transaction details");
        }
        validateCurrency(ipn.mc_currency, invoice.currency);
        const isSub = txnType === "subscr_payment" || txnType === "recurring_payment";
        if (isSub && !ipn.subscr_id) {
          throw new FbError("PayPal subscription payment is missing the subscription ID");
        }
        if (isSub) {
          const sub = await findSubscriptionBySid(ipn.subscr_id);
          if (sub && sub.rel_type === "invoice" && sub.rel_id !== null && sub.rel_id !== invoiceId) {
            throw new FbError(`PayPal subscription ${ipn.subscr_id} is not linked to invoice ${invoiceId}`);
          }
        }
        // Reload to the post-fill state, then force Completed.
        if (((await findTransactionById(txId)) as unknown as Record<string, unknown>).txn_status !== "Completed") {
          await updateTransactionRow(txId, { txn_status: "Completed" });
        }
        if (await isIpnDuplicate(ipn)) {
          throw new FbError("Cannot process duplicate IPN");
        }
        if (ipn.invoice && parseInt(ipn.invoice, 10) !== invoiceId) {
          throw new FbError(`PayPal invoice reference does not match invoice ${invoiceId}`);
        }
        const expected = invoiceTotals(await listInvoiceItems(invoiceId), invoice.taxrate ?? "0").total;
        const received = parseFloat(ipn.mc_gross);
        if (received < expected - 0.01) {
          throw new FbError(
            `Payment amount does not match the expected invoice total. Expected ${expected.toFixed(2)}, received ${received.toFixed(2)}.`
          );
        }
        await insertBalanceRow({
          client_id: clientId,
          type: "PayPal",
          rel_id: ipn.txn_id,
          amount: received,
          description: `PayPal transaction ${ipn.txn_id}`,
        });
        const isDeposit = (await listInvoiceItems(invoiceId)).some((it) => it.type === "deposit");
        if (isDeposit) {
          // Plain markAsPaid: no second balance credit (the adapter's
          // addFunds above is the credit).
          if (invoice.status !== "paid") await markInvoicePaid(invoiceId);
        } else {
          if (!invoice.issued) {
            const client = await findClientById(clientId);
            if (client) await issueInvoice(invoiceId, client, {});
          }
          if (!await tryPayWithCredits(invoiceId)) {
            throw new FbError("Client balance is insufficient to pay the invoice");
          }
        }
        break;
      }
      if (ipn.payment_status === "Refunded") break;
      await updateTransactionRow(txId, {
        txn_status: ipn.payment_status ?? "",
        status: "received",
        error: `PayPal payment not completed: ${ipn.payment_status ?? "unknown"}`,
      });
      awaitingCompletion = true;
      break;
    }
    case "subscr_signup":
    case "recurring_payment_profile_created": {
      const subscrId = ipn.subscr_id ?? "";
      if (subscrId === "") throw new FbError("PayPal subscription signup is missing the subscription ID");
      validateCurrency(ipn.mc_currency, invoice.currency);
      const period = (ipn.period3 ?? "").replace(/ /g, "");
      const existing = await findSubscriptionBySid(subscrId);
      if (!existing) {
        await insertSubscription({
          sid: subscrId,
          period: period || null,
          amount: ipn.amount3 ?? null,
          currency: ipn.mc_currency ?? null,
          status: "active",
          client_id: clientId,
          pay_gateway_id: gatewayId,
          rel_id: invoiceId,
          rel_type: "invoice",
        });
      }
      await updateTransactionRow(txId, { s_id: subscrId, s_period: period || null });
      break;
    }
    case "subscr_modify": {
      const modifySid = ipn.subscr_id ?? "";
      if (modifySid === "") throw new FbError("PayPal subscription update is missing the subscription ID");
      const modified = await findSubscriptionBySid(modifySid);
      if (!modified) break; // unknown sid: acknowledge, do not fail
      const updates: Record<string, unknown> = {};
      if (ipn.amount3) updates.amount = ipn.amount3;
      if (ipn.period3) updates.period = ipn.period3.replace(/ /g, "");
      if (Object.keys(updates).length) await updateSubscriptionRow(modified.id, updates);
      await updateTransactionRow(txId, { s_id: modifySid, s_period: (updates.period as string | undefined) ?? modified.period });
      break;
    }
    case "recurring_payment_suspended_due_to_max_failed_payment":
    case "recurring_payment_profile_cancel":
    case "recurring_payment_suspended":
    case "recurring_payment_expired":
    case "subscr_eot":
    case "subscr_cancel": {
      const cancelSid = ipn.subscr_id ?? "";
      if (cancelSid === "") throw new FbError("PayPal subscription update is missing the subscription ID");
      const stored = await findSubscriptionBySid(cancelSid);
      if (!stored) break; // unknown sid: acknowledge
      await updateSubscriptionRow(stored.id, { status: "canceled" });
      break;
    }
    case "recurring_payment_failed":
    case "subscr_failed": {
      const failedSid = ipn.subscr_id ?? "";
      if (failedSid === "") throw new FbError("PayPal subscription update is missing the subscription ID");
      const failed = await findSubscriptionBySid(failedSid);
      if (!failed) break;
      await updateTransactionRow(txId, { s_id: failedSid });
      break;
    }
    case "recurring_payment_skipped": {
      const skippedSid = ipn.subscr_id ?? "";
      if (skippedSid === "") throw new FbError("PayPal subscription update is missing the subscription ID");
      break;
    }
    default:
      break;
  }

  if (ipn.payment_status === "Refunded" && ["web_accept", "subscr_payment", "recurring_payment"].includes(txnType)) {
    // PHP issues a credit-note refund for the invoice. The note text
    // ('PayPal refund <parent>') is PHP's refund note parameter; the
    // TS note carries the standard audit line (documented deviation).
    const { refundInvoiceCore } = await import("./modules/invoice");
    const invRow = await findInvoiceById(invoiceId);
    if (invRow && invRow.status === "paid") refundInvoiceCore(invRow, null);
  }
  if (awaitingCompletion) return;
  await updateTransactionRow(txId, { error: "", error_code: null, status: "processed" });
}

export async function gatewayName(gatewayId: number): Promise<string> {
  const g = await findGatewayFull(gatewayId);
  return g?.name ?? g?.gateway ?? "";
}
