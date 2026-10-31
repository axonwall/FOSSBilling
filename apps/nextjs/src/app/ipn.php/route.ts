import { createHmac, timingSafeEqual } from "node:crypto";
import {
  deleteTransactionRow,
  findGatewayFull,
  findInvoiceById,
  findTransactionById,
  getDb,
  insertTransactionFull,
  listInvoiceItems,
  updateTransactionRow,
} from "@/server/db";
import { FbError } from "@/server/dispatch";
import { invoiceTotals, markInvoicePaid } from "@/server/money";
import { processTransactionRow } from "@/server/modules/invoice";
import "@/server/modules";

/**
 * POST /ipn.php — the gateway callback endpoint, mirroring PHP's
 * src/ipn.php (Phase 4 batch 1). Form callbacks create + process a
 * transaction (manual-approval gateways park it as 'error' with the
 * 7002 envelope, exactly like PHP); JSON webhooks are authenticated
 * first — Stripe by HMAC signature — and unhandled event types are
 * recorded then deleted, as PHP's adapter does.
 */

function envelope(result: unknown, error: { message: string; code: number } | null, status = 200) {
  return Response.json({ result, error }, { status });
}

function fail(message: string, code = 9999, status = 200) {
  return envelope(null, { message, code }, status);
}

interface GatewayRow {
  id: number;
  gateway: string;
  config: string | null;
  test_mode: number;
}

async function gatewayRow(id: number): Promise<GatewayRow | undefined> {
  return await getDb()
    .prepare("SELECT id, gateway, config, test_mode FROM pay_gateway WHERE id = ?")
    .get(id) as GatewayRow | undefined;
}

function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") timestamp = v;
    if (k === "v1") signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((sig) => {
    try {
      const given = Buffer.from(sig, "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    } catch {
      return false;
    }
  });
}

const STRIPE_HANDLED = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice_payment.paid",
  "invoice_payment.failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
  "charge.refunded",
  "refund.created",
]);

export async function POST(req: Request) {
  const url = new URL(req.url);
  const gatewayParam = url.searchParams.get("gateway_id");
  const invoiceParam = url.searchParams.get("invoice_id");
  if (gatewayParam !== null && !/^\d+$/.test(gatewayParam)) {
    return fail("Invalid gateway ID", 9999, 400);
  }
  if (invoiceParam !== null && !/^\d+$/.test(invoiceParam)) {
    return fail("Invalid invoice ID", 9999, 400);
  }
  const gatewayId = gatewayParam ? Number(gatewayParam) : null;
  const rawBody = await req.text();
  if (rawBody.length > 1_048_576) {
    return fail("Callback body is too large", 9999, 413);
  }
  const contentType = req.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json") && rawBody.length > 0;

  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  try {
    if (isJson) {
      return await handleJsonWebhook(req, rawBody, gatewayId, query);
    }
    // Form callback (Custom and friends).
    const form = new URLSearchParams(rawBody);
    const post: Record<string, string> = {};
    form.forEach((v, k) => {
      post[k] = v;
    });
    const invoiceId = invoiceParam ? Number(invoiceParam) : post["invoice_id"] ? Number(post["invoice_id"]) : null;
    if (invoiceId === null) throw new FbError("Transaction invoice ID is missing");
    if (gatewayId === null) throw new FbError("Payment gateway ID is missing");
    const invoice = await findInvoiceById(invoiceId);
    if (!invoice) throw new FbError("Invoice was not found");
    const gateway = await findGatewayFull(gatewayId);
    if (!gateway) throw new FbError("Invalid payment gateway");
    // Idempotency: a processed txn with the same external id wins.
    const txnIdCandidate = post["txn_id"] ?? query["txn_id"] ?? null;
    if (txnIdCandidate) {
      const existing = await getDb()
        .prepare(
          'SELECT id FROM "transaction" WHERE txn_id = ? AND gateway_id = ? AND status = \'processed\'',
        )
        .get(txnIdCandidate, gatewayId) as { id: number } | undefined;
      if (existing) return envelope(existing.id, null);
    }
    const ipn = JSON.stringify({
      source: "ipn",
      get: query,
      post,
      http_raw_post_data: rawBody,
      server: null,
    });
    // R6b: PHP's create leaves amount unset (NULL) until gateway
    // processing fills it, and records the request IP; the "0"/null
    // defaults here diverged on every parked transaction.
    const requestIp = (
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      "127.0.0.1"
    ).replace(/^::ffff:/, "");
    const txId = await insertTransactionFull({
      txn_id: null,
      txn_status: null,
      amount: null,
      currency: null,
      type: null,
      status: "received",
      ip: requestIp,
      ipn,
      note: null,
      invoice_id: invoiceId,
      gateway_id: gatewayId,
    });
    const tx = await findTransactionById(txId);
    if (!tx) throw new FbError("Transaction not found");
    try {
      await processTransactionRow(tx, { post, get: query, rawBody });
    } catch (e) {
      // createAndProcess parks the failure on the transaction and the
      // caller still sees the error envelope (PHP behavior).
      // markTransactionError persists the exception's CODE as
      // error_code (ServiceTransaction.php:717-732) — e.g. 7002 for
      // the Custom manual-approval park, which the route dropped.
      await updateTransactionRow(txId, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        error_code:
          e instanceof FbError ? e.code : e instanceof Error ? 9999 : null,
      });
      throw e;
    }
    return envelope(txId, null);
  } catch (e) {
    if (e instanceof FbError) return fail(e.message, e.code);
    return fail(e instanceof Error ? e.message : "Unknown error");
  }
}

async function handleJsonWebhook(
  req: Request,
  rawBody: string,
  gatewayId: number | null,
  query: Record<string, string>,
) {
  if (gatewayId === null) return fail("Payment gateway ID is missing");
  const gateway = await gatewayRow(gatewayId);
  if (!gateway) return fail("Invalid payment gateway");
  if (gateway.gateway !== "Stripe") {
    return fail("Unsupported JSON webhook gateway");
  }
  let config: Record<string, unknown> = {};
  try {
    config = gateway.config ? (JSON.parse(gateway.config) as Record<string, unknown>) : {};
  } catch {
    config = {};
  }
  const secret = String(
    gateway.test_mode ? (config["test_webhook_secret"] ?? "") : (config["webhook_secret"] ?? ""),
  );
  // Authentication happens before any row is created (PHP parity:
  // a bad signature leaves no transaction behind).
  if (!verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), secret)) {
    return fail("Invalid Stripe webhook signature", 9999);
  }
  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return fail("Invalid Stripe webhook signature", 9999);
  }
  const ipn = JSON.stringify({
    source: "ipn",
    get: query,
    post: null,
    http_raw_post_data: rawBody,
    server: null,
  });
  const txId = await insertTransactionFull({
    txn_id: event.id ?? null,
    txn_status: event.type ?? null,
    // R6b: same PHP-create rule as the form path — amount unset
    // (NULL) until processing fills it; ip recorded, not null.
    amount: null,
    currency: null,
    type: null,
    status: "received",
    ip: ((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      "127.0.0.1").replace(/^::ffff:/, ""),
    ipn,
    note: null,
    invoice_id: null,
    gateway_id: gatewayId,
  });
  const type = event.type ?? "";
  if (!STRIPE_HANDLED.has(type)) {
    // Unhandled events are recorded then deleted by PHP's adapter.
    await deleteTransactionRow(txId);
    return envelope(txId, null);
  }
  if (type === "payment_intent.succeeded") {
    const obj = event.data?.object ?? {};
    const metadata = (obj["metadata"] ?? {}) as Record<string, unknown>;
    const invoiceId = Number(metadata["invoice_id"] ?? 0);
    const amountReceived = Number(obj["amount_received"] ?? -1);
    const invoice = invoiceId ? await findInvoiceById(invoiceId) : undefined;
    if (invoice) {
      const totals = invoiceTotals(await listInvoiceItems(invoice.id), invoice.taxrate ?? "0");
      if (Math.round(totals.total * 100) === amountReceived) {
        await updateTransactionRow(txId, {
          invoice_id: invoice.id,
          status: "processed",
          amount: String(totals.total),
          currency: invoice.currency,
          txn_status: type,
        });
        if (invoice.status !== "paid") await markInvoicePaid(invoice.id);
        return envelope(txId, null);
      }
    }
    // Amount/invoice mismatch: keep the row for review, like a
    // received transaction awaiting processing.
    await updateTransactionRow(txId, {
      ...(invoiceId ? { invoice_id: invoiceId } : {}),
      error: "Stripe payment did not match an unpaid invoice total",
    });
    return envelope(txId, null);
  }
  // Other handled types (subscription lifecycle, refunds) are kept
  // as received rows; their settlement paths need the Stripe API,
  // which PHP reaches with live keys — deferred there too.
  return envelope(txId, null);
}
