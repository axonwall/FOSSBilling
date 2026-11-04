import { createHash } from "node:crypto";
import {
  deleteInvoiceCascade,
  deleteSubscriptionRow,
  deleteTransactionRow,
  findGatewayFull,
  findSubscriptionById,
  findTransactionById,
  insertSubscription,
  insertTransactionFull,
  listSubscriptions,
  listTransactions,
  transactionStatusCounts,
  updateSubscriptionRow,
  updateTransactionRow,
  type SubscriptionRowFull,
  type TransactionRowFull,
  deleteInvoiceItemRow,
  deleteTaxRow,
  findClientById,
  findGateway,
  getDb,
  getSetting,
  findInvoiceByHash,
  findInvoiceById,
  findPayGatewayRow,
  findInvoiceItemRow,
  findTaxById,
  findTransactionByTxnId,
  insertBalanceRow,
  insertInvoice,
  insertInvoiceItem,
  insertTax,
  insertTransaction,
  listGateways,
  listInvoiceItems,
  listInvoices,
  listTaxRules,
  ordersForInvoice,
  promoApplicationsForInvoice,
  updateInvoiceFields,
  updateInvoiceItemRow,
  updateTaxRow,
  creditNoteIdsFor,
  findCurrencyByCode,
  findOrderById,
  findProductById,
  findProductPayment,
  listProductPeriods,
  getDbWrite,
  insertInvoiceNote,
  insertInvoiceEvent,
  listInvoiceEvents,
  listOrders,
  nowTimestamp,
  reserveNumericParamValue,
  setSettingValue,
  updateOrderRow,
  type ClientRow,
  type InvoiceRowFull,
  type OrderRowFull,
} from "../db";
import {
  FbError,
  register,
  requireAdmin,
  requireClient,
  type CallContext,
} from "../dispatch";
import { requirePermission } from "../permissions";
import { getCompany } from "./system";
import { randomBytes } from "node:crypto";
import { activateOrderRow } from "./order";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

async function isDepositInvoice(invoiceId: number): Promise<boolean> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS c FROM invoice_item WHERE invoice_id = ? AND type = 'deposit'")
    .get(invoiceId) as { c: number };
  return row.c > 0;
}
import { clientSubscriptionArray } from "./client";
import {
  assertCountIncomeWritable,
  buildJournalSnapshot,
  countIncome,
  invoiceTotals,
  isClientTaxable,
  issueInvoice,
  markInvoicePaid,
  prepareInvoice,
  resolveTaxForClient,
  round2,
  tryPayWithCredits,
  type InvoiceItemInput,
} from "../money";
import { formatZoneDateTime, parseZoneDateTime, resolveZone, zoneTodayString } from "../tz";
import { queueInvoiceEmail } from "../emailer";
import { publicOrigin } from "../public-url";
import { invoicePdfByHash } from "../pdf";
import {
  getPaymentHtml,
  type PaymentInvoiceView,
} from "../payment-adapters";
import { exportCsvResponse, requestedCsvHeaders } from "../csv";

/**
 * Invoice module (Phase 3 batch 2) — TS port of
 * src/modules/Invoice/Api/{Admin,Client,Guest}.php core paths on top
 * of the money.ts invoice core: reads (get/get_list incl. summary
 * mode), prepare/update/issue, mark_as_paid (Custom gateway path with
 * its transaction record), pay_with_credits, delete, item_delete, and
 * tax CRUD. Deferred: refunds/credit notes, debit, reissue, renewal
 * invoices, transactions/subscriptions CRUD, batch jobs, reminders.
 * Parity oracle: capture10.py corpus + the fixture gate.
 */

export function serieNr(inv: InvoiceRowFull): string {
  const padding = 5;
  const nr = inv.nr && /^\d+$/.test(inv.nr) ? inv.nr : String(inv.id);
  return `${inv.serie ?? ""}${nr.padStart(padding, "0")}`;
}

export function clientBlock(client: ClientRow): Record<string, unknown> {
  return {
    id: client.id,
    email: client.email,
    email_approved: client.email_approved === null ? null : !!client.email_approved,
    type: client.type,
    first_name: client.first_name,
    last_name: client.last_name,
    gender: client.gender,
    birthday: client.birthday,
    phone_cc: client.phone_cc,
    phone: client.phone,
    company: client.company,
    company_vat: client.company_vat,
    company_number: client.company_number,
    address_1: client.address_1,
    address_2: client.address_2,
    city: client.city,
    state: client.state,
    postcode: client.postcode,
    country: client.country,
    currency: client.currency,
    lang: client.lang,
    timezone: client.timezone,
  };
}

function isEditable(inv: InvoiceRowFull): boolean {
  if (["paid", "refunded", "canceled"].includes(inv.status)) return false;
  return !inv.issued;
}

function isCancellable(inv: InvoiceRowFull): boolean {
  return (
    !!inv.issued &&
    inv.status === "unpaid" &&
    inv.credit_note_for_invoice_id === null &&
    inv.debit_note_for_invoice_id === null &&
    inv.replaced_by_invoice_id === null
  );
}

function isDeletable(inv: InvoiceRowFull): boolean {
  if (
    inv.credit_note_for_invoice_id !== null ||
    inv.debit_note_for_invoice_id !== null ||
    inv.replaces_invoice_id !== null ||
    inv.replaced_by_invoice_id !== null
  ) {
    return false;
  }
  return !inv.issued && inv.status === "unpaid";
}

async function refundedQuantities(invoiceId: number): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const noteId of await creditNoteIdsFor(invoiceId)) {
    for (const l of await listInvoiceItems(noteId)) {
      const rid = (l as { refunded_item_id?: number | null }).refunded_item_id;
      if (rid) map.set(rid, (map.get(rid) ?? 0) + l.quantity);
    }
  }
  return map;
}

export async function invoiceArray(
  inv: InvoiceRowFull,
  opts: { adminDetail?: boolean; guestDetail?: boolean } = {},
): Promise<Record<string, unknown>> {
  const items = await listInvoiceItems(inv.id);
  const refundedQty = opts.adminDetail ? await refundedQuantities(inv.id) : new Map<number, number>();
  const lines = items.map((it) => ({
    id: it.id,
    title: it.title,
    period: it.period,
    quantity: it.quantity ?? 1,
    unit: it.unit,
    price: formatDecimal(it.price),
    tax: 0,
    taxed: it.taxed ? 1 : 0,
    charged: it.charged ? 1 : 0,
    total: round2((it.price ?? 0) * (it.quantity ?? 1)),
    order_id: it.type === "order" ? it.rel_id : null,
    type: it.type,
    rel_id: it.rel_id,
    task: it.task,
    status: it.status,
    ...(opts.adminDetail
      ? { remaining_quantity: (it.quantity ?? 1) - (refundedQty.get(it.id) ?? 0) }
      : {}),
  }));
  const { tax, subtotal, total } = invoiceTotals(items, inv.taxrate ?? "0");
  // R6b: PHP's rule is NOT "has an order line with a period" (the old
  // TS rule): Subscription::getSubscriptionPeriodByInvoiceId scans
  // ALL lines by id — skips zero/negative lines, returns null if any
  // positive line has an empty period or if positive periods differ,
  // else the single period. A recurring checkout's setup line (positive
  // price, no period) therefore makes the invoice NOT subscribable,
  // where TS previously said true. The shadow harness caught it.
  const subscriptionPeriod = subscriptionPeriodForItems(items);
  const client = await findClientById(inv.client_id);
  const company = await getCompany();
  const isDraft = !inv.issued;

  let buyer: Record<string, unknown> = {
    first_name: inv.buyer_first_name,
    last_name: inv.buyer_last_name,
    company: inv.buyer_company,
    company_vat: inv.buyer_company_vat,
    company_number: inv.buyer_company_number,
    address: inv.buyer_address,
    city: inv.buyer_city,
    state: inv.buyer_state,
    country: inv.buyer_country,
    phone: inv.buyer_phone,
    email: inv.buyer_email,
    zip: inv.buyer_zip,
  };
  if (isDraft && client && !inv.buyer_first_name && !inv.buyer_last_name && !inv.buyer_company) {
    buyer = {
      first_name: client.first_name,
      last_name: client.last_name,
      company: client.company,
      company_vat: client.company_vat,
      company_number: client.company_number,
      address: [client.address_1, client.address_2].filter(Boolean).join(" "),
      city: client.city,
      state: client.state,
      country: client.country,
      phone: [client.phone_cc, client.phone].filter(Boolean).join(" "),
      phone_cc: client.phone_cc ?? "",
      email: client.email,
      zip: client.postcode,
    };
  }

  const liveAddress = [company.address_1, company.address_2, company.address_3]
    .filter(Boolean)
    .join(" ");
  const frozenAddress = !isDraft ? inv.seller_address : null;
  const seller: Record<string, unknown> = {
    company: inv.seller_company || company.name || "",
    company_vat: isDraft ? (company.vat_number ?? "") : (inv.seller_company_vat ?? ""),
    company_number: isDraft ? (company.number ?? "") : (inv.seller_company_number ?? ""),
    address: frozenAddress || liveAddress,
    address_1: frozenAddress || (company.address_1 ?? ""),
    address_2: frozenAddress !== null ? "" : (company.address_2 ?? ""),
    address_3: frozenAddress !== null ? "" : (company.address_3 ?? ""),
    phone: !isDraft ? (inv.seller_phone ?? company.tel ?? "") : (company.tel ?? ""),
    email: !isDraft ? (inv.seller_email ?? company.email ?? "") : (company.email ?? ""),
    account_number: company.account_number ?? null,
    bank_name: company.bank_name ?? null,
    bic: company.bic ?? null,
  };

  const out: Record<string, unknown> = {
    id: inv.id,
    serie: inv.serie,
    nr: inv.nr,
    client_id: inv.client_id,
    serie_nr: serieNr(inv),
    hash: inv.hash,
    hash_expires_at: inv.hash_expires_at,
    gateway_id: inv.gateway_id,
    taxname: inv.taxname,
    taxrate: inv.taxrate,
    currency: inv.currency,
    currency_rate: Number(inv.currency_rate ?? 1),
    tax,
    subtotal,
    total,
    status: inv.status,
    notes: inv.notes,
    text_1: inv.text_1,
    text_2: inv.text_2,
    due_at: inv.due_at,
    paid_at: inv.paid_at,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
    lines,
    buyer,
    seller,
    client: client ? clientBlock(client) : null,
    reminded_at: inv.reminded_at,
    issued: !!inv.issued,
    editable: isEditable(inv),
    cancellable: isCancellable(inv),
    deletable: isDeletable(inv),
    credit_note_for_invoice_id: inv.credit_note_for_invoice_id,
    debit_note_for_invoice_id: inv.debit_note_for_invoice_id,
    replaces_invoice_id: inv.replaces_invoice_id,
    replaced_by_invoice_id: inv.replaced_by_invoice_id,
    refunded_by_invoice_ids: await creditNoteIdsFor(inv.id),
    refunded_total: round2(inv.refund ?? 0),
    remaining_refundable: round2(Math.max(0, total - round2(inv.refund ?? 0))),
    income: (inv.base_income ?? 0) - (inv.base_refund ?? 0),
    refund: inv.refund === null || inv.refund === undefined ? 0 : formatDecimal(inv.refund),
    credit: inv.credit === null || inv.credit === undefined ? 0 : formatDecimal(inv.credit),
    subscribable: subscriptionPeriod !== null,
    ...(subscriptionPeriod
      ? {
          subscription: {
            unit: subscriptionPeriod.slice(-1),
            cycle: parseInt(subscriptionPeriod, 10) || 1,
            period: subscriptionPeriod,
          },
        }
      : {}),
    orders: await ordersForInvoice(inv.id),
  };
  if (opts.adminDetail) {
    out["promo_applications"] = await promoApplicationsForInvoice(inv.id);
    out["debited_by_invoice_ids"] = await debitedBy(inv.id);
  }
  if (opts.guestDetail) {
    out["debited_by_invoice_ids"] = await debitedBy(inv.id);
    out["related_invoices"] = [];
  }
  return out;
}

async function debitedBy(invoiceId: number): Promise<number[]> {
  return (await listInvoices({}))
    .filter((i) => i.debit_note_for_invoice_id === invoiceId)
    .map((i) => i.id);
}

/** DECIMAL columns surface as strings in PHP's arrays. */
function formatDecimal(v: number): string {
  return Number.isInteger(v) ? String(v) : String(round2(v));
}

async function summaryArray(inv: InvoiceRowFull): Promise<Record<string, unknown>> {
  const items = await listInvoiceItems(inv.id);
  const { tax, subtotal, total } = invoiceTotals(items, inv.taxrate ?? "0");
  const subscriptionPeriod = subscriptionPeriodForItems(items);
  const client = await findClientById(inv.client_id);
  return {
    id: inv.id,
    serie: inv.serie,
    nr: inv.nr,
    serie_nr: serieNr(inv),
    client_id: inv.client_id,
    client: client ? { id: client.id } : null,
    currency: inv.currency,
    tax,
    subtotal,
    total,
    status: inv.status,
    due_at: inv.due_at,
    paid_at: inv.paid_at,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
    buyer: {
      first_name: inv.buyer_first_name,
      last_name: inv.buyer_last_name,
      email: inv.buyer_email,
    },
    issued: !!inv.issued,
    cancellable: isCancellable(inv),
  };
}

async function getInvoiceOrThrow(ctx: CallContext): Promise<InvoiceRowFull> {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Invoice ID is missing");
  const inv = await findInvoiceById(Number(id));
  if (!inv) throw new FbError("Invoice was not found");
  return inv;
}

// --- Admin ----------------------------------------------------------------

register("admin", "invoice", "get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  return await invoiceArray(inv, { adminDetail: true });
});

register("admin", "invoice", "get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const filters: { client_id?: number; status?: string; currency?: string } = {};
  if (ctx.params["client_id"]) filters.client_id = Number(ctx.params["client_id"]);
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  if (ctx.params["currency"]) filters.currency = ctx.params["currency"];
  const all = await listInvoices(filters);
  if (ctx.params["summary"]) {
    return paginateLocal(await Promise.all(all.map(summaryArray)), ctx.params);
  }
  return paginateLocal(await Promise.all(all.map(async (i) => await invoiceArray(i))), ctx.params);
});

function paginateLocal<T>(items: T[], params: Record<string, string>) {
  const page = Math.max(1, parseInt(params["page"] ?? "1", 10) || 1);
  const perPage = Math.max(1, parseInt(params["per_page"] ?? "100", 10) || 100);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { pages, page, per_page: perPage, total, list: items.slice(start, start + perPage) };
}

register("admin", "invoice", "prepare", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const clientId = ctx.params["client_id"];
  if (!clientId) throw new FbError("Client ID is missing");
  const client = await findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const rawItems = ctx.rawParams["items"];
  // JSON bodies carry items as an array; form posts carry them as
  // items[0][title] bracket keys (the admin UI's encoding). The old
  // code dropped form-posted items entirely.
  const items: InvoiceItemInput[] = Array.isArray(rawItems)
    ? rawItems.map((it) => toItemInput(it as Record<string, unknown>))
    : formItems(ctx);
  const gatewayId = ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : null;
  return await prepareInvoice(client, items, gatewayId);
});

function toItemInput(raw: Record<string, unknown>): InvoiceItemInput {
  const relRaw = raw["rel_id"];
  const relId =
    typeof relRaw === "number"
      ? relRaw
      : typeof relRaw === "string" && /^\d+$/.test(relRaw)
        ? Number(relRaw)
        : null;
  return {
    title: String(raw["title"] ?? ""),
    price: Number(raw["price"] ?? 0),
    quantity: Number(raw["quantity"] ?? 1),
    unit: typeof raw["unit"] === "string" ? raw["unit"] : null,
    period: typeof raw["period"] === "string" ? raw["period"] : null,
    taxed: raw["taxed"] === true || raw["taxed"] === 1 || raw["taxed"] === "1",
    type: typeof raw["type"] === "string" ? raw["type"] : "custom",
    rel_id: relId,
    task: typeof raw["task"] === "string" ? raw["task"] : "void",
  };
}

/** Form bracket scan for prepare items: items[0][title], ... */
function formItems(ctx: CallContext): InvoiceItemInput[] {
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [k, v] of Object.entries(ctx.params)) {
    const m = /^items\[(\d+)\]\[([^\]]+)\]$/.exec(k);
    if (!m || v === undefined) continue;
    const idx = Number(m[1]);
    if (!byIndex.has(idx)) byIndex.set(idx, {});
    byIndex.get(idx)![m[2]] = v;
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, raw]) => toItemInput(raw));
}

register("admin", "invoice", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  if (!isEditable(inv)) {
    throw new FbError(
      "This invoice can no longer be edited. Issued invoices are immutable; correct them with a credit note or a replacement invoice.",
    );
  }
  const p = ctx.params;
  const fields: Parameters<typeof updateInvoiceFields>[1] = {};
  if (p["notes"] !== undefined) fields.notes = p["notes"];
  if (p["text_1"] !== undefined) fields.text_1 = p["text_1"];
  if (p["text_2"] !== undefined) fields.text_2 = p["text_2"];
  if (p["due_at"] !== undefined) fields.due_at = p["due_at"];
  if (p["taxname"] !== undefined) fields.taxname = p["taxname"];
  if (p["taxrate"] !== undefined) fields.taxrate = p["taxrate"];
  if (p["gateway_id"] !== undefined) {
    const gw = await findGateway(Number(p["gateway_id"]));
    if (!gw) throw new FbError("Payment gateway not found");
    if (!gw.enabled) throw new FbError("Payment gateway is not enabled");
    fields.gateway_id = gw.id;
  }
  if (p["status"] !== undefined && !inv.issued) {
    if (!["unpaid", "canceled"].includes(p["status"])) {
      throw new FbError(
        `Invalid invoice status: ${p["status"]}. Draft invoices can only be unpaid or canceled.`,
      );
    }
    fields.status = p["status"];
  }
  await updateInvoiceFields(inv.id, fields);

  const newItem = ctx.rawParams["new_item"] as Record<string, unknown> | undefined;
  if (newItem && typeof newItem === "object") {
    const input = toItemInput(newItem);
    await insertInvoiceItem({
      invoice_id: inv.id,
      type: input.type ?? "custom",
      rel_id: input.rel_id ?? null,
      task: input.task ?? "void",
      status: "pending_payment",
      title: input.title,
      period: input.period ?? null,
      quantity: input.quantity,
      unit: input.unit ?? null,
      price: input.price,
      taxed: input.taxed ? 1 : 0,
    });
  }
  const itemsMap = ctx.rawParams["items"] as Record<string, Record<string, unknown>> | undefined;
  if (itemsMap && typeof itemsMap === "object") {
    for (const [itemId, vals] of Object.entries(itemsMap)) {
      const existing = await findInvoiceItemRow(Number(itemId));
      if (!existing || existing.invoice_id !== inv.id) continue;
      const f: Parameters<typeof updateInvoiceItemRow>[1] = {};
      if (vals["title"] !== undefined) f.title = String(vals["title"]);
      if (vals["price"] !== undefined) f.price = Number(vals["price"]);
      if (vals["quantity"] !== undefined) f.quantity = Number(vals["quantity"]);
      if (vals["taxed"] !== undefined) f.taxed = vals["taxed"] ? 1 : 0;
      await updateInvoiceItemRow(Number(itemId), f);
    }
  }

  if (p["issue"]) {
    const client = await findClientById(inv.client_id);
    if (client) await issueInvoice(inv.id, client, {});
    return true;
  }
  return true;
});

register("admin", "invoice", "issue", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  if (inv.issued) return true;
  if (inv.status !== "unpaid") {
    throw new FbError("Only unpaid draft invoices can be issued.");
  }
  const client = await findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  await issueInvoice(inv.id, client, { useCredits: ctx.params["use_credits"] === "1" });
  return true;
});

register("admin", "invoice", "mark_as_paid", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  // R2a conditional guard (Invoice Admin::mark_as_paid): marking a
  // deposit invoice as paid credits the client balance, so it needs
  // client/manage_balance in addition to the table's manage_invoices.
  if (await isDepositInvoice(inv.id)) await requirePermission(ctx, "client", "manage_balance");
  if (inv.status === "paid") return true;
  if (inv.status === "canceled" || inv.replaced_by_invoice_id !== null) {
    throw new FbError("This invoice was canceled and cannot be marked as paid");
  }
  // PHP validateAdminMarkAsPaidRequest order: non-empty gateway_id wins
  // (cast to int; non-numeric casts to 0), else the invoice's gateway,
  // else 0 -> "required". Then missing row -> "not found", then disabled.
  const rawGateway = ctx.params["gateway_id"];
  const hasRaw =
    rawGateway !== undefined && rawGateway !== null && rawGateway !== "" &&
    rawGateway !== "0" && Number(rawGateway) !== 0;
  const gatewayId = hasRaw ? Math.trunc(Number(rawGateway)) || 0 : (inv.gateway_id ?? 0);
  if (gatewayId <= 0) throw new FbError("Payment gateway is required when marking an invoice as paid.");
  const gateway = await findGatewayFull(gatewayId);
  if (!gateway) throw new FbError("Payment gateway not found");
  if (!gateway.enabled) throw new FbError("Payment gateway is not enabled");
  const transactionId = ctx.params["transactionId"] ?? null;
  if (transactionId) {
    const existing = await findTransactionByTxnId(transactionId);
    if (existing && existing.invoice_id !== inv.id) {
      throw new FbError("Transaction ID is already associated with another invoice.");
    }
  }
  if (gateway.gateway === "Custom" && !transactionId) {
    throw new FbError("Transaction ID is required when using the Custom payment gateway.");
  }
  if (gateway.id !== inv.gateway_id) {
    await updateInvoiceFields(inv.id, { gateway_id: gateway.id });
  }
  if (gateway.gateway === "Custom") {
    const items = await listInvoiceItems(inv.id);
    const { total } = invoiceTotals(items, inv.taxrate ?? "0");
    const ipn = JSON.stringify({
      source: "admin",
      get: null,
      post: { invoice_id: inv.id, txn_id: transactionId },
      http_raw_post_data: null,
      server: null,
    });
    await insertTransaction({
      txn_id: transactionId,
      amount: total,
      currency: inv.currency,
      status: "processed",
      // R6b: PHP records the request IP on admin-created transactions.
      ip: ctx.ip ?? null,
      ipn,
      ipn_hash: createHash("sha256").update(ipn).digest("hex"),
      note: transactionId ? `Custom transaction No: ${transactionId}` : null,
      invoice_id: inv.id,
      gateway_id: gateway.id,
    });
  }
  const paidAt = ctx.params["paid_at"];
  await markInvoicePaid(inv.id);
  if (paidAt) await updateInvoiceFields(inv.id, { paid_at: paidAt });
  // PHP's markAsPaidByAdmin credits deposit invoices to the balance
  // (type 'invoice', rel_id = invoice id) — plain markAsPaid does not.
  if (await isDepositInvoice(inv.id)) {
    const gatewayName = gateway.name ?? gateway.gateway;
    const totals = invoiceTotals(await listInvoiceItems(inv.id), inv.taxrate ?? "0");
    await insertBalanceRow({
      client_id: inv.client_id,
      type: "invoice",
      rel_id: inv.id,
      amount: totals.total,
      description: transactionId
        ? `${gatewayName} transaction No: ${transactionId}`
        : `${gatewayName} manual payment`,
    });
  }
  return true;
});

register("admin", "invoice", "pay_with_credits", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  if (!inv.issued || inv.status === "paid") return false;
  return await tryPayWithCredits(inv.id);
});

register("admin", "invoice", "batch_pay_with_credits", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idsRaw = ctx.rawParams["ids"] ?? ctx.params["ids"];
  const ids: number[] = Array.isArray(idsRaw)
    ? idsRaw.map(Number)
    : String(idsRaw ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean);
  const out: Record<string, boolean> = {};
  for (const id of ids) {
    const inv = await findInvoiceById(id);
    out[String(id)] = inv && inv.issued && inv.status !== "paid" ? await tryPayWithCredits(id) : false;
  }
  return out;
});

register("admin", "invoice", "delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  if (!isDeletable(inv)) {
    throw new FbError(
      "Only unissued, unpaid invoices (drafts) can be deleted. Cancel (void) an issued unpaid invoice, or reissue/refund it instead. Relax invoice immutability to delete issued invoices for cleanup.",
    );
  }
  await deleteInvoiceCascade(inv.id);
  return true;
});

register("admin", "invoice", "item_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Invoice item ID was not passed");
  const item = await findInvoiceItemRow(Number(id));
  if (!item) throw new FbError("Invoice item was not found");
  await deleteInvoiceItemRow(Number(id));
  return true;
});

// --- Tax CRUD ---------------------------------------------------------------

function taxArray(row: {
  id: number; level: string | null; name: string | null; country: string | null;
  state: string | null; taxrate: string; created_at: string | null; updated_at: string | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    level: row.level,
    name: row.name,
    country: row.country,
    state: row.state,
    taxrate: row.taxrate,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

register("admin", "invoice", "tax_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const name = ctx.params["name"];
  if (!name) throw new FbError("Tax name is missing");
  const taxrate = ctx.params["taxrate"];
  if (!taxrate || Number.isNaN(Number(taxrate))) throw new FbError("Tax rate is missing or is invalid");
  return await insertTax({
    name,
    taxrate,
    country: ctx.params["country"] || null,
    state: ctx.params["state"] || null,
    level: ctx.params["level"] || null,
  });
});

register("admin", "invoice", "tax_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Tax ID was not passed");
  const tax = await findTaxById(Number(id));
  if (!tax) throw new FbError("Tax rule not found");
  return taxArray(tax);
});

register("admin", "invoice", "tax_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginateLocal((await listTaxRules()).map(taxArray), ctx.params);
});

register("admin", "invoice", "tax_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Tax ID is missing");
  if (!ctx.params["name"]) throw new FbError("Tax name is missing");
  if (!ctx.params["taxrate"]) throw new FbError("Tax rate is missing");
  const tax = await findTaxById(Number(id));
  if (!tax) throw new FbError("Tax rule not found");
  await updateTaxRow(Number(id), {
    name: ctx.params["name"],
    taxrate: ctx.params["taxrate"],
    country: ctx.params["country"] !== undefined ? ctx.params["country"] || null : tax.country,
    state: ctx.params["state"] !== undefined ? ctx.params["state"] || null : tax.state,
  });
  return true;
});

register("admin", "invoice", "tax_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Tax ID was not passed");
  const tax = await findTaxById(Number(id));
  if (!tax) throw new FbError("Tax rule not found");
  await deleteTaxRow(Number(id));
  return true;
});

// --- Client + guest ---------------------------------------------------------

register("client", "invoice", "get", async (ctx: CallContext) => {
  requireClient(ctx);
  const hash = ctx.params["hash"];
  if (!hash) throw new FbError("Invoice hash was not passed");
  const inv = await findInvoiceByHash(hash);
  if (!inv || inv.client_id !== ctx.session!.client!.id) {
    throw new FbError("Invoice was not found");
  }
  const out = await invoiceArray(inv);
  out["debited_by_invoice_ids"] = await debitedBy(inv.id);
  out["related_invoices"] = [];
  return out;
});

register("client", "invoice", "get_list", async (ctx: CallContext) => {
  requireClient(ctx);
  const filters: { client_id?: number; status?: string } = {
    client_id: ctx.session!.client!.id,
  };
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  const all = await listInvoices(filters);
  return paginateLocal(await Promise.all(all.map(async (i) => await invoiceArray(i))), ctx.params);
});

register("client", "invoice", "funds_invoice", async (ctx: CallContext) => {
  requireClient(ctx);
  if (ctx.params["amount"] === undefined || ctx.params["amount"] === null || ctx.params["amount"] === "") {
    throw new FbError("Amount is required");
  }
  const amount = parseFloat(ctx.params["amount"]);
  if (Number.isNaN(amount)) {
    throw new FbError("You need to enter numeric value");
  }
  const client = await findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  if (!client.currency) {
    throw new FbError("You must have at least one active order before you can add funds so you cannot proceed at the current time!");
  }
  if ((await getSetting("funds_enabled") ?? "1") === "0") {
    throw new FbError("Adding funds to the account balance is currently disabled", 980);
  }
  const minRaw = await getSetting("funds_min_amount");
  if (minRaw && amount < parseFloat(minRaw)) {
    throw new FbError(`Amount must be at least ${minRaw}`, 981);
  }
  const maxRaw = await getSetting("funds_max_amount");
  if (maxRaw && amount > parseFloat(maxRaw)) {
    throw new FbError(`Amount cannot exceed ${maxRaw}`, 982);
  }
  const dueDaysRaw = await getSetting("invoice_due_days");
  const dueDays = dueDaysRaw ? parseInt(dueDaysRaw, 10) : 5;
  const dueAt = new Date(Date.now() + dueDays * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const hash = randomHex(24);
  const id = await insertInvoice({
    client_id: client.id,
    serie: null,
    nr: null,
    hash,
    hash_expires_at: await hashExpiry(),
    currency: client.currency,
    // R5b: PHP generateFundsInvoice sets no rate — NULL until payment.
    currency_rate: null,
    credit: 0,
    status: "unpaid",
    taxname: "",
    taxrate: "0",
    gateway_id: null,
    due_at: dueAt,
    notes: null,
  });
  await insertInvoiceItem({
    invoice_id: id,
    type: "deposit",
    rel_id: null,
    task: "void",
    status: "pending_payment",
    title: "Add funds to account",
    period: null,
    quantity: 1,
    unit: null,
    price: amount,
    taxed: 0,
    charged: 1,
  });
  await issueInvoice(id, client, {});
  return hash;
});

register("guest", "invoice", "get", async (ctx: CallContext) => {
  const hash = ctx.params["hash"];
  if (!hash) throw new FbError("Invoice hash was not passed");
  if (!/^[a-f0-9]{30,60}$/.test(hash)) {
    throw new FbError("Invalid invoice hash", 4001);
  }
  const inv = await findInvoiceByHash(hash);
  if (!inv) throw new FbError("Invoice was not found");
  // checkInvoiceAuth(READ): admins and the owning client pass; anyone
  // else needs the invoice_accessible_from_hash setting, and an
  // expired hash link is refused first. (Per-endpoint rate limits for
  // this endpoint live in the seam's R5g table, not here.)
  const isAdmin = !!ctx.session?.admin;
  const isOwner = ctx.session?.client?.id === inv.client_id;
  if (!isAdmin && !isOwner) {
    const expired =
      inv.hash_expires_at !== null &&
      new Date(inv.hash_expires_at.replace(" ", "T") + "Z").getTime() < Date.now();
    if (expired) throw new FbError("This invoice link has expired", 403);
    if ((await getSetting("invoice_accessible_from_hash") ?? "0") !== "1") {
      throw new FbError("You do not have permission to perform this action", 403);
    }
  }
  return await invoiceArray(inv, { guestDetail: true });
});

// --- Phase 5 R1 decisions batch (D3): guest payment + pdf, admin export_csv. ---

/** Invoice Service::checkInvoiceAuth, shared by guest get/payment/pdf:
 * admins and the owning client pass; anyone else needs the
 * invoice_accessible_from_hash setting, and an expired hash link is
 * refused first. (Per-endpoint rate limits for these endpoints live
 * in the seam's R5g table, not here.) */
async function checkGuestInvoiceAuth(inv: InvoiceRowFull, ctx: CallContext): Promise<void> {
  const isAdmin = !!ctx.session?.admin;
  const isOwner = ctx.session?.client?.id === inv.client_id;
  if (isAdmin || isOwner) return;
  const expired =
    inv.hash_expires_at !== null &&
    new Date(inv.hash_expires_at.replace(" ", "T") + "Z").getTime() < Date.now();
  if (expired) throw new FbError("This invoice link has expired", 403);
  if ((await getSetting("invoice_accessible_from_hash") ?? "0") !== "1") {
    throw new FbError("You do not have permission to perform this action", 403);
  }
}

/** ServiceSubscription::getSubscriptionPeriodByInvoiceId: all priced
 * lines must share one non-empty period (zero-price lines skipped, no
 * items -> null). Deliberately NOT the type-filtered invoiceArray
 * subscription: PHP's payment path uses this pure query. */
function subscriptionPeriodForItems(
  items: { price: number; quantity: number; period: string | null }[],
): string | null {
  if (items.length === 0) return null;
  let period: string | null = null;
  for (const it of items) {
    const lineTotal = (it.price ?? 0) * (it.quantity ?? 1);
    if (lineTotal <= 0) continue;
    const p = it.period ?? null;
    if (!p) return null;
    if (period === null) {
      period = p;
      continue;
    }
    if (period !== p) return null;
  }
  return period;
}

async function subscriptionPeriodForInvoice(invoiceId: number): Promise<string | null> {
  return subscriptionPeriodForItems(await listInvoiceItems(invoiceId));
}

register("guest", "invoice", "payment", async (ctx: CallContext) => {
  // Guest Api::payment param checks, then Service::processInvoice.
  const hash = ctx.params["hash"];
  if (!hash) throw new FbError("Invoice hash not passed. Missing param hash", 810);
  if (!/^[a-f0-9]{30,60}$/.test(hash)) {
    throw new FbError("Invalid invoice hash", 4001);
  }
  const gatewayRaw = ctx.params["gateway_id"];
  if (!gatewayRaw || gatewayRaw === "0") {
    throw new FbError("Payment method not found. Missing param gateway_id", 811);
  }
  const inv = await findInvoiceByHash(hash);
  if (!inv) throw new FbError("Invoice not found", 812);
  await checkGuestInvoiceAuth(inv, ctx);
  if (inv.status === "canceled" || inv.replaced_by_invoice_id !== null) {
    throw new FbError("This invoice was canceled and cannot be paid", 403);
  }
  if (inv.status === "paid") {
    throw new FbError("This invoice is already paid", 403);
  }
  const gatewayId = parseInt(gatewayRaw, 10);
  const gw = await findPayGatewayRow(Number.isNaN(gatewayId) ? 0 : gatewayId);
  if (!gw) throw new FbError("Payment method not found", 813);
  if (!gw.enabled) throw new FbError("Payment method not enabled", 814);
  const period = await subscriptionPeriodForInvoice(inv.id);
  // PHP: $allowSubscribe = $data['allow_subscription'] ?? true, tested
  // with PHP truthiness ("0"/"" false, every other string true).
  const allowRaw = ctx.params["allow_subscription"];
  const allowSubscribe = allowRaw === undefined ? true : !(allowRaw === "0" || allowRaw === "");
  const subscribe = period !== null && gw.allow_recurrent === 1 && allowSubscribe;
  if (!subscribe && gw.allow_single !== 1) {
    throw new FbError("One-time payments are not enabled for the selected payment gateway", 815);
  }
  // Adapter forms render toApiArray(invoice, deep=true); TS invoiceArray
  // with adminDetail carries the same buyer/lines/totals.
  const view = await invoiceArray(inv, { adminDetail: true });
  const buyer = view["buyer"] as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const paymentView: PaymentInvoiceView = {
    id: inv.id,
    nr: String(inv.nr ?? ""),
    serie: inv.serie ?? "",
    hash: inv.hash,
    client_id: inv.client_id,
    currency: inv.currency,
    subtotal: view["subtotal"] as number,
    tax: view["tax"] as number,
    total: view["total"] as number,
    lines: (view["lines"] as { title: string | null }[]).map((l) => ({ title: l.title })),
    buyer: {
      first_name: str(buyer["first_name"]),
      last_name: str(buyer["last_name"]),
      address: str(buyer["address"]),
      city: str(buyer["city"]),
      state: str(buyer["state"]),
      country: str(buyer["country"]),
      zip: str(buyer["zip"]),
      email: str(buyer["email"]),
    },
    subscriptionPeriod: period,
  };
  const { iframe, html } = await getPaymentHtml(gw, paymentView, subscribe);
  return { iframe, type: "html", service_url: "", subscription: subscribe, result: html };
});

register("guest", "invoice", "pdf", async (ctx: CallContext) => {
  // Guest Api::pdf param checks, then Service::generatePDF.
  const hash = ctx.params["hash"];
  if (!hash) throw new FbError("Invoice hash was not passed");
  if (!/^[a-f0-9]{30,60}$/.test(hash)) {
    throw new FbError("Invalid invoice hash", 4001);
  }
  const inv = await findInvoiceByHash(hash);
  if (!inv) throw new FbError("Invoice not found");
  await checkGuestInvoiceAuth(inv, ctx);
  const buf = await invoicePdfByHash(hash);
  if (!buf) throw new FbError("Invoice not found");
  // Service::createPdfResponse disposition (serie_nr + '.pdf'); the TS
  // PDF is a clean-room layout, not dompdf bytes, so parity compares
  // status/headers/magic, never PHP bytes.
  const name = serieNr(inv);
  const safe = name.trim().replace(/[/\\%]/g, "-") || "invoice";
  const fallback =
    name.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "invoice";
  const disposition =
    safe + ".pdf" === fallback + ".pdf"
      ? `inline; filename=${safe}.pdf`
      : `inline; filename=${fallback}.pdf; filename*=utf-8''${rawurlencode(safe + ".pdf")}`;
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "application/pdf", "content-disposition": disposition },
  });
});

/** PHP rawurlencode: encodeURIComponent plus ! ' ( ) * (which it leaves). */
function rawurlencode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

const INVOICE_EXPORTABLE = [
  "id", "client_id", "serie", "nr", "currency", "currency_rate",
  "credit", "base_income", "base_refund", "refund", "notes",
  "text_1", "text_2", "status", "seller_company", "seller_company_vat",
  "seller_company_number", "seller_address", "seller_phone", "seller_email",
  "buyer_first_name", "buyer_last_name", "buyer_company", "buyer_company_vat",
  "buyer_company_number", "buyer_address", "buyer_city", "buyer_state",
  "buyer_country", "buyer_zip", "buyer_phone",
  "buyer_email", "gateway_id", "issued", "taxname", "taxrate",
  "due_at", "reminded_at", "paid_at", "created_at", "updated_at",
];

const INVOICE_DEFAULT_EXPORT = [
  "id", "client_id", "nr", "currency", "credit", "base_income", "base_refund",
  "refund", "notes", "status", "buyer_first_name", "buyer_last_name",
  "buyer_company", "buyer_company_vat", "buyer_company_number", "buyer_address",
  "buyer_city", "buyer_state", "buyer_country", "buyer_zip", "buyer_phone",
  "buyer_email", "issued", "taxname", "taxrate",
  "due_at", "reminded_at", "paid_at",
];

register("admin", "invoice", "export_csv", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await exportCsvResponse(
    "invoice",
    "invoices.csv",
    INVOICE_EXPORTABLE,
    INVOICE_DEFAULT_EXPORT,
    requestedCsvHeaders(ctx.rawParams, ctx.params),
  );
});

register("guest", "invoice", "gateways", async () => {
  return (await listGateways())
    .filter((g) => g.enabled)
    .map((g) => ({ id: g.id, code: g.gateway, name: g.name, enabled: !!g.enabled }));
});

// ---------------------------------------------------------------------------
// Transactions + subscriptions (Invoice module, Phase 3 batch 3).
// ---------------------------------------------------------------------------

async function transactionArray(row: TransactionRowFull): Promise<Record<string, unknown>> {
  const gateway = row.gateway_id ? await findGatewayFull(row.gateway_id) : undefined;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    txn_id: row.txn_id,
    txn_status: row.txn_status,
    gateway_id: row.gateway_id,
    gateway: gateway?.name ?? null,
    gateway_code: gateway?.gateway ?? null,
    // Derived from the gateway adapter in PHP; only the Custom gateway
    // supports manual approval in the bundled set.
    requires_manual_approval: gateway?.gateway === "Custom",
    amount: row.amount !== null ? Number(row.amount) : 0,
    currency: row.currency,
    type: row.type,
    status: row.status,
    ip: row.ip,
    error: row.error,
    error_code: row.error_code,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ipn: row.ipn ? (JSON.parse(row.ipn) as unknown) : null,
  };
}

async function getTransactionOrThrow(ctx: CallContext): Promise<TransactionRowFull> {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Transaction ID is missing");
  const tx = await findTransactionById(Number(id));
  if (!tx) throw new FbError("Transaction not found");
  return tx;
}

register("admin", "invoice", "transaction_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = await getTransactionOrThrow(ctx);
  const out = await transactionArray(tx);
  return out;
});

register("admin", "invoice", "transaction_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const filters: { invoice_id?: number; status?: string } = {};
  if (ctx.params["invoice_id"]) filters.invoice_id = Number(ctx.params["invoice_id"]);
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  const items = await Promise.all((await listTransactions(filters)).map(async (t) => {
    const a = await transactionArray(t);
    delete a["ipn"];
    return a;
  }));
  return paginateLocal(items, ctx.params);
});

/** Recursively key-sorted JSON, matching PHP's normalizeIpn (ksort). */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${sortedJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Form bracket scan for a root key (get[foo], post[bar], ...). */
function bracketObject(params: Record<string, string | undefined>, root: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const prefix = `${root}[`;
  let found = false;
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith(prefix) || v === undefined || !k.endsWith("]")) continue;
    const key = k.slice(prefix.length, -1);
    if (!key || key.includes("[")) continue;
    out[key] = v;
    found = true;
  }
  return found ? out : null;
}

function nestedObjectParam(ctx: CallContext, root: string): Record<string, unknown> | null {
  const raw = ctx.rawParams?.[root];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return bracketObject(ctx.params, root);
}

register("admin", "invoice", "transaction_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const invoiceId = ctx.params["invoice_id"] ? Number(ctx.params["invoice_id"]) : null;
  const gatewayId = ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : null;
  // PHP's create validates the gateway FIRST ('Invalid payment
  // gateway'), then invoice presence, gateway presence, invoice
  // existence — in that order.
  if (gatewayId !== null && !await findGatewayFull(gatewayId)) {
    throw new FbError("Invalid payment gateway");
  }
  if (invoiceId === null) throw new FbError("Transaction invoice ID is missing");
  if (gatewayId === null) throw new FbError("Payment gateway ID is missing");
  if (!await findInvoiceById(invoiceId)) {
    throw new FbError("Invoice was not found");
  }
  // PHP's create IGNORES type/status/txn_status from the caller: a new
  // row is always status=received with NULL type/txn_status, and
  // amount/currency stay unset until gateway processing fills them.
  const get = nestedObjectParam(ctx, "get");
  const post = nestedObjectParam(ctx, "post");
  const ipnObj = {
    source: typeof ctx.params["source"] === "string" ? ctx.params["source"] : "admin",
    get,
    post,
    http_raw_post_data: null,
    server: null,
  };
  const ipn = sortedJson(ipnObj);
  const txnId = ctx.params["txn_id"] ?? post?.["txn_id"] ?? get?.["txn_id"] ?? post?.["payment_intent"] ?? get?.["payment_intent"] ?? null;
  const db = getDb();
  // Early duplicate: same (txn_id, gateway) already processed -> its id.
  if (txnId !== null && txnId !== "" && gatewayId !== null) {
    const dup = await db.prepare(
      'SELECT id FROM "transaction" WHERE txn_id = ? AND gateway_id = ? AND status = \'processed\' ORDER BY id ASC LIMIT 1',
    ).get(String(txnId), gatewayId) as { id: number } | undefined;
    if (dup) return dup.id;
  }
  // IPN-hash dedupe: same (gateway, ipn hash) -> its id, any status.
  if (gatewayId !== null) {
    try {
      const hash = createHash("sha256").update(ipn).digest("hex");
      const dupHash = await db.prepare(
        'SELECT id FROM "transaction" WHERE gateway_id = ? AND ipn_hash = ? ORDER BY id ASC LIMIT 1',
      ).get(gatewayId, hash) as { id: number } | undefined;
      if (dupHash) return dupHash.id;
    } catch { /* transaction table without ipn_hash: no dedupe */ }
  }
  return await insertTransactionFull({
    txn_id: txnId !== null ? String(txnId) : null,
    txn_status: null,
    amount: null,
    currency: null,
    type: null,
    status: "received",
    ip: ctx.ip,
    ipn,
    note: ctx.params["note"] ?? null,
    invoice_id: invoiceId,
    gateway_id: gatewayId,
  });
});

register("admin", "invoice", "transaction_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = await getTransactionOrThrow(ctx);
  const p = ctx.params;
  const fields: Parameters<typeof updateTransactionRow>[1] = {};
  if (p["invoice_id"] !== undefined) {
    if (!await findInvoiceById(Number(p["invoice_id"]))) throw new FbError("Invoice not found");
    fields.invoice_id = Number(p["invoice_id"]);
  }
  if (p["gateway_id"] !== undefined) {
    if (!await findGatewayFull(Number(p["gateway_id"]))) throw new FbError("Payment gateway not found");
    fields.gateway_id = Number(p["gateway_id"]);
  }
  if (p["txn_id"] !== undefined) fields.txn_id = p["txn_id"];
  if (p["txn_status"] !== undefined) fields.txn_status = p["txn_status"];
  if (p["amount"] !== undefined) fields.amount = p["amount"];
  if (p["currency"] !== undefined) fields.currency = p["currency"];
  if (p["type"] !== undefined) fields.type = p["type"];
  if (p["s_id"] !== undefined) fields.s_id = p["s_id"];
  if (p["s_period"] !== undefined) fields.s_period = p["s_period"];
  if (p["note"] !== undefined) fields.note = p["note"];
  if (p["status"] !== undefined) fields.status = p["status"];
  if (p["error"] !== undefined) fields.error = p["error"];
  if (p["error_code"] !== undefined) fields.error_code = Number(p["error_code"]);
  await updateTransactionRow(tx.id, fields);
  return true;
});

/** Shared by transaction_delete and batch_delete_transaction. */
async function deleteTransactionById(tx: TransactionRowFull): Promise<void> {
  // Processed transactions record moved money and are never deletable.
  if (tx.status === "processed") {
    throw new FbError("Processed transactions cannot be deleted because they record money that already moved.");
  }
  // Unprocessed deletes drop balance rows referencing the transaction.
  await getDbWrite()
    .prepare("DELETE FROM client_balance WHERE type = 'transaction' AND rel_id = ?")
    .run(String(tx.id));
  await deleteTransactionRow(tx.id);
}

register("admin", "invoice", "transaction_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = await getTransactionOrThrow(ctx);
  await deleteTransactionById(tx);
  return true;
});

register("admin", "invoice", "transaction_get_statuses", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const counts = await transactionStatusCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    total,
    received: counts["received"] ?? 0,
    approved: counts["approved"] ?? 0,
    processing: counts["processing"] ?? 0,
    processed: counts["processed"] ?? 0,
    error: counts["error"] ?? 0,
  };
});

register("admin", "invoice", "transaction_get_statuses_pairs", () => {
  return {
    received: "Received",
    approved: "Approved",
    processing: "Processing",
    processed: "Processed",
    error: "Error",
  };
});

register("admin", "invoice", "transaction_statuses", (ctx: CallContext) => {
  requireAdmin(ctx);
  return ["received", "approved", "processing", "processed", "error"];
});

register("admin", "invoice", "transaction_gateway_statuses", () => {
  return {
    succeeded: "Succeeded",
    complete: "Complete",
    pending: "Pending validation",
    failed: "Failed",
    unknown: "Unknown",
  };
});

register("admin", "invoice", "transaction_types", () => {
  return {
    payment: "Payment",
    refund: "Refund",
    subscription_create: "Subscription create",
    subscription_cancel: "Subscription cancel",
    unknown: "Unknown",
  };
});

// --- Subscriptions ------------------------------------------------------------

async function subscriptionArray(row: SubscriptionRowFull): Promise<Record<string, unknown>> {
  const client = row.client_id ? await findClientById(row.client_id) : undefined;
  return {
    id: row.id,
    sid: row.sid,
    period: row.period,
    amount: row.amount !== null ? String(Number(row.amount)) : null,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client: client ? await clientSubscriptionArray(client) : null,
    gateway: row.pay_gateway_id ? await gatewayArray(row.pay_gateway_id) : null,
  };
}

/**
 * The PayGateway API array (ServicePayGateway::toApiArray). The admin
 * extras are gated on the ADMIN identity, not on the deep flag, so
 * gateway_get, gateway_get_list and subscription.gateway all share
 * this shape. Adapter metadata (form, description, supports flags,
 * secret fields) is snapshotted from the four bundled adapters in
 * src/library/Payment/Adapter at 0.8.9; unknown adapters fall back
 * to the generic shape. Secret config values are nulled and exposed
 * only as `<field>_set` booleans.
 */
export interface GatewayRow {
  id: number; name: string | null; gateway: string; accepted_currencies: string | null;
  enabled: number; allow_single: number; allow_recurrent: number; test_mode: number;
  config: string | null; custom_logo: string | null;
}

const ADAPTER_META: Record<string, {
  supports_one_time_payments: boolean; supports_subscriptions: boolean;
  description: string | null; form: Record<string, unknown> | unknown[];
}> = {
  Custom: {
    supports_one_time_payments: true,
    supports_subscriptions: true,
    description: "Custom payment gateway allows you to give instructions how can your client pay invoice. All system, client, order and invoice details can be printed. HTML code is supported.",
    form: {
      single: ["textarea", { label: "Enter Your Text for Single Payment Information" }],
      recurrent: ["textarea", { label: "Enter Your Text for Subscription Information" }],
    },
  },
  PayPalEmail: {
    supports_one_time_payments: true,
    supports_subscriptions: true,
    description: "Enter your PayPal email to start accepting payments by PayPal.",
    form: {
      email: ["text", { label: "PayPal email address for payments", validators: ["EmailAddress"] }],
    },
  },
  Stripe: {
    supports_one_time_payments: true,
    supports_subscriptions: true,
    description: "You authenticate to the Stripe API by providing one of your API keys in the request. You can manage your API keys from your account.",
    form: {
      pub_key: ["text", { label: "Live Publishable Key:", required_when: { enabled: true, test_mode: false } }],
      api_key: ["password", { label: "Live Secret Key:", required_when: { enabled: true, test_mode: false }, secret: true }],
      webhook_secret: ["password", { label: "Live Webhook signing secret:", required_when: { enabled: true, test_mode: false }, secret: true }],
      test_pub_key: ["text", { label: "Test Publishable Key:", required_when: { enabled: true, test_mode: true } }],
      test_api_key: ["password", { label: "Test Secret Key:", required_when: { enabled: true, test_mode: true }, secret: true }],
      test_webhook_secret: ["password", { label: "Test Webhook signing secret:", required_when: { enabled: true, test_mode: true }, secret: true }],
    },
  },
  ClientBalance: {
    supports_one_time_payments: true,
    supports_subscriptions: false,
    description: null,
    form: [],
  },
};

function adapterSecretFields(code: string): string[] {
  const form = ADAPTER_META[code]?.form;
  if (!form || Array.isArray(form)) return [];
  const out: string[] = [];
  for (const [name, element] of Object.entries(form)) {
    const options = (element as unknown[])[1] as Record<string, unknown> | undefined;
    if (options && options["secret"]) out.push(name);
  }
  return out;
}

async function gatewayRowToApiArray(row: GatewayRow): Promise<Record<string, unknown>> {
  const meta = ADAPTER_META[row.gateway];
  let currencies: string[] = [];
  try {
    const parsed = JSON.parse(row.accepted_currencies ?? "null") as unknown;
    if (Array.isArray(parsed)) currencies = parsed.map(String);
  } catch { /* keep empty */ }
  if (currencies.length === 0) {
    // PHP falls back to ALL currency codes, not just the default.
    currencies = ((await getDb().prepare("SELECT code FROM currency ORDER BY id").all()) as { code: string }[]).map((r) => r.code);
  }
  const www = `${publicOrigin()}/`;
  let config: Record<string, unknown> | unknown[] = [];
  try {
    const parsed = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
    // PHP's empty decoded config encodes as [] (array), not {}.
    config = parsed && Object.keys(parsed).length ? parsed : [];
  } catch { /* keep [] */ }
  const secrets = adapterSecretFields(row.gateway);
  if (!Array.isArray(config)) {
    for (const field of secrets) {
      const value = config[field] ?? null;
      config[field] = null;
      config[`${field}_set`] = value !== null && value !== "";
    }
  }
  let customLogoUrl: string | null = null;
  let customLogoAvifUrl: string | null = null;
  if (row.custom_logo && /^[a-f0-9]{64}\.(png|jpg|webp|avif|svg)$/.test(row.custom_logo)) {
    customLogoUrl = `${www}public/gateways/custom/${row.custom_logo}`;
    if (row.custom_logo.endsWith(".png")) {
      customLogoAvifUrl = `${www}public/gateways/custom/${row.custom_logo.slice(0, -4)}.avif`;
    }
  }
  return {
    id: row.id,
    code: row.gateway,
    title: row.name,
    allow_single: !!row.allow_single,
    allow_recurrent: !!row.allow_recurrent,
    accepted_currencies: currencies,
    supports_one_time_payments: meta?.supports_one_time_payments ?? true,
    supports_subscriptions: meta?.supports_subscriptions ?? true,
    config,
    secret_fields: secrets,
    form: meta?.form ?? [],
    description: meta?.description ?? null,
    enabled: !!row.enabled,
    test_mode: !!row.test_mode,
    callback: `${www}ipn.php?gateway_id=${row.id}`,
    custom_logo_url: customLogoUrl,
    custom_logo_avif_url: customLogoAvifUrl,
  };
}

export async function gatewayArray(gatewayId: number): Promise<Record<string, unknown> | null> {
  const row = await getDb()
    .prepare(
      "SELECT id, name, gateway, accepted_currencies, enabled, allow_single, allow_recurrent, test_mode, config, custom_logo FROM pay_gateway WHERE id = ?",
    )
    .get(gatewayId) as GatewayRow | undefined;
  if (!row) return null;
  return await gatewayRowToApiArray(row);
}

async function findGatewayRow(id: number): Promise<GatewayRow | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, name, gateway, accepted_currencies, enabled, allow_single, allow_recurrent, test_mode, config, custom_logo FROM pay_gateway WHERE id = ?",
    )
    .get(id) as GatewayRow | undefined;
}

async function getSubscriptionOrThrow(ctx: CallContext): Promise<SubscriptionRowFull> {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Subscription ID was not passed");
  const sub = await findSubscriptionById(Number(id));
  if (!sub) throw new FbError("Subscription not found");
  return sub;
}

register("admin", "invoice", "subscription_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const clientId = ctx.params["client_id"];
  if (!clientId) throw new FbError("Client ID was not passed");
  const gatewayId = ctx.params["gateway_id"];
  if (!gatewayId) throw new FbError("Payment gateway ID was not passed");
  const currency = ctx.params["currency"];
  if (!currency) throw new FbError("Subscription currency was not passed");
  const client = await findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const gateway = await findGatewayFull(Number(gatewayId));
  if (!gateway) throw new FbError("Payment gateway not found");
  if ((client.currency ?? "").toUpperCase() !== currency.toUpperCase()) {
    throw new FbError(
      "Client currency must match subscription currency. Check if clients currency is defined.",
    );
  }
  return await insertSubscription({
    sid: ctx.params["sid"] ?? null,
    period: ctx.params["period"] ?? null,
    amount: ctx.params["amount"] ?? null,
    currency,
    status: ctx.params["status"] ?? null,
    client_id: client.id,
    pay_gateway_id: gateway.id,
    rel_id: ctx.params["rel_id"] ? Number(ctx.params["rel_id"]) : null,
    rel_type: ctx.params["rel_type"] ?? null,
  });
});

register("admin", "invoice", "subscription_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await subscriptionArray(await getSubscriptionOrThrow(ctx));
});

register("admin", "invoice", "subscription_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginateLocal(await Promise.all((await listSubscriptions()).map(subscriptionArray)), ctx.params);
});

register("admin", "invoice", "subscription_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const sub = await getSubscriptionOrThrow(ctx);
  const p = ctx.params;
  const fields: Parameters<typeof updateSubscriptionRow>[1] = {};
  if (p["sid"] !== undefined) fields.sid = p["sid"];
  if (p["period"] !== undefined) fields.period = p["period"];
  if (p["amount"] !== undefined) fields.amount = p["amount"];
  if (p["currency"] !== undefined) fields.currency = p["currency"];
  if (p["status"] !== undefined) fields.status = p["status"];
  if (p["rel_id"] !== undefined) fields.rel_id = Number(p["rel_id"]);
  if (p["rel_type"] !== undefined) fields.rel_type = p["rel_type"];
  // PHP cancels at the gateway when status flips to canceled; the
  // gateway side effect is not mirrored for the Custom gateway (no-op
  // there in practice).
  await updateSubscriptionRow(sub.id, fields);
  return true;
});

register("admin", "invoice", "subscription_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const sub = await getSubscriptionOrThrow(ctx);
  await deleteSubscriptionRow(sub.id);
  return true;
});

// ---------------------------------------------------------------------------
// Invoice corrections, renewals, journal, reminders, batch jobs
// (Phase 3 batch 4). Parity oracle: capture12.py corpus.
// ---------------------------------------------------------------------------

function noteRowFrom(
  inv: InvoiceRowFull,
  overrides: Partial<Parameters<typeof insertInvoiceNote>[0]>,
): Parameters<typeof insertInvoiceNote>[0] {
  return {
    client_id: inv.client_id,
    serie: "",
    nr: null,
    hash: randomHex(24),
    currency: inv.currency ?? "USD",
    // R5b: PHP sets no rate on notes (neither refund credit notes nor
    // debit notes); the old copy of the original's rate was the R1
    // divergence. A debit note's base_income comes from countIncome
    // after its items exist; a credit note gets neither base column.
    currency_rate: null,
    status: "unpaid",
    credit_note_for_invoice_id: null,
    debit_note_for_invoice_id: null,
    replaces_invoice_id: null,
    seller_company: inv.seller_company,
    seller_company_vat: inv.seller_company_vat,
    seller_company_number: inv.seller_company_number,
    seller_address: inv.seller_address,
    seller_phone: inv.seller_phone,
    seller_email: inv.seller_email,
    buyer_first_name: inv.buyer_first_name,
    buyer_last_name: inv.buyer_last_name,
    buyer_company: inv.buyer_company,
    buyer_company_vat: inv.buyer_company_vat,
    buyer_company_number: inv.buyer_company_number,
    buyer_address: inv.buyer_address,
    buyer_city: inv.buyer_city,
    buyer_state: inv.buyer_state,
    buyer_country: inv.buyer_country,
    buyer_zip: inv.buyer_zip,
    buyer_phone: inv.buyer_phone,
    buyer_email: inv.buyer_email,
    issued: 1,
    taxname: inv.taxname ?? "",
    taxrate: inv.taxrate ?? "0",
    due_at: null,
    paid_at: null,
    notes: null,
    gateway_id: null,
    ...overrides,
  };
}

/** PHP appends audit lines to invoice notes: "<ts>: <msg>" + padding. */
function auditLine(message: string): string {
  return `${nowTimestamp()}: ${message}       \n`;
}

function appendNote(existing: string | null, message: string): string {
  return (existing ?? "") + auditLine(message);
}

async function hashExpiry(): Promise<string> {
  const days = parseInt(await getSetting("invoice_hash_lifetime_days") ?? "90", 10) || 90;
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
}

/** Shared refund core: the admin handler and the PayPal Refunded
 * IPN branch both land here. onlyIds restricts the note to given
 * lines; null means a full refund of the remaining amount. */
export async function refundInvoiceCore(inv: InvoiceRowFull, onlyIds: Set<number> | null): Promise<number> {
  const totals = invoiceTotals(await listInvoiceItems(inv.id), inv.taxrate ?? "0");
  const alreadyRefunded = round2(inv.refund ?? 0);
  const remaining = round2(totals.total - alreadyRefunded);
  if (remaining <= 0) {
    throw new FbError("Only paid invoices can be refunded");
  }
  // R5b review fix: PHP wraps refund in wrapInTransaction, so a
  // countIncome throw rolls the note back too. Validate BEFORE the
  // first write (note creation + nr claim) so the observable outcome
  // matches: error + nothing changed. Placed after the remaining
  // check so PHP's validation-error precedence is preserved.
  await assertCountIncomeWritable(String(inv.currency ?? "USD"));
  const lines = (await listInvoiceItems(inv.id)).filter((l) => !onlyIds || onlyIds.has(l.id));
  const refundAmount = round2(
    lines.reduce((s, l) => s + Math.abs(round2(l.price * l.quantity)), 0) *
      (lines.length === (await listInvoiceItems(inv.id)).length ? remaining / Math.max(totals.total, remaining) : 1),
  );
  const amount = onlyIds ? refundAmount : remaining;
  const serie = "CN-";
  // R6b: PHP numbers credit notes from the dedicated counter, not
  // MAX(nr)+1 (see reserveNumericParamValue).
  const nr = String(await reserveNumericParamValue("invoice_cn_starting_number", 1));
  const noteId = await insertInvoiceNote(
    noteRowFrom(inv, {
      serie,
      nr,
      status: "refunded",
      credit_note_for_invoice_id: inv.id,
      paid_at: nowTimestamp(),
      notes: auditLine(`Refund for #${inv.id} invoice.`),
      hash_expires_at: await hashExpiry(),
    }),
  );
  for (const l of lines) {
    await insertInvoiceItem({
      invoice_id: noteId,
      type: l.type ?? "custom",
      rel_id: l.rel_id,
      refunded_item_id: l.id,
      task: "void",
      status: "executed",
      title: l.title ?? "",
      period: l.period,
      quantity: l.quantity,
      unit: l.unit,
      price: -Math.abs(l.price),
      taxed: l.taxed ? 1 : 0,
    });
    // 'charged' on credit-note lines mirrors the refunded quantity.
    const items = await listInvoiceItems(noteId);
    const created = items[items.length - 1];
    if (created) {
      await getDbWrite()
        .prepare("UPDATE invoice_item SET charged = ? WHERE id = ?")
        .run(l.quantity, created.id);
    }
  }
  const newRefundTotal = round2(alreadyRefunded + amount);
  await updateInvoiceFields(inv.id, {
    status: newRefundTotal >= totals.total ? "refunded" : inv.status,
    notes: appendNote(inv.notes, `Refund invoice #${noteId} generated.`),
  });
  // refund is a DECIMAL column — bind as a string like PHP.
  await getDbWrite()
    .prepare("UPDATE invoice SET refund = ? WHERE id = ?")
    .run(String(newRefundTotal), inv.id);
  // R5b: PHP recomputes base_refund via countIncome from the RUNNING
  // refund (toBaseCurrency(refund)), it does not increment the old
  // base_refund by amount x frozen rate. countIncome also rewrites
  // base_income identically (same items, same rate), so the single
  // call mirrors both PHP writes.
  await countIncome(inv.id);
  await insertInvoiceEvent(inv.id, "refunded", { status: "refunded" });
  // R6b: the refunded template renders original_invoice.serie_nr
  // (mod_invoice_refunded.html.twig:40); without it TS rendered an
  // empty "against invoice" slot. Same serie_nr formula as
  // invoiceEmailContext.
  await queueInvoiceEmail("mod_invoice_refunded", noteId, {
    original_invoice: {
      serie_nr: `${inv.serie ?? ""}${String(inv.nr ?? inv.id).padStart(5, "0")}`,
    },
  });
  return noteId;
}

register("admin", "invoice", "refund", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  // R2a conditional guard (Invoice Admin::refund): refunding a deposit
  // returns wallet credit, so with gateway_refund (default true) it
  // needs client/manage_balance in addition to manage_invoices.
  const gatewayRefundRaw =
    ctx.rawParams["gateway_refund"] !== undefined ? ctx.rawParams["gateway_refund"] : ctx.params["gateway_refund"];
  const gatewayRefund =
    gatewayRefundRaw === undefined
      ? true
      : typeof gatewayRefundRaw === "boolean"
        ? gatewayRefundRaw
        : typeof gatewayRefundRaw === "number"
          ? gatewayRefundRaw !== 0
          : ["1", "true", "yes", "on"].includes(String(gatewayRefundRaw).toLowerCase());
  if (gatewayRefund && await isDepositInvoice(inv.id)) await requirePermission(ctx, "client", "manage_balance");
  if (inv.status !== "paid") {
    throw new FbError("Only paid invoices can be refunded");
  }
  const client = await findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  // Full-refund path (optionally restricted to the given line ids).
  // Partial-quantity refunds and live gateway refunds are deferred:
  // for the Custom gateway there is no gateway money movement.
  const itemsParam = ctx.rawParams["items"];
  const onlyIds = Array.isArray(itemsParam)
    ? new Set(
        itemsParam.map((x) =>
          typeof x === "object" && x !== null ? Number((x as { id?: unknown }).id) : Number(x),
        ),
      )
    : null;
  return await refundInvoiceCore(inv, onlyIds);
});

register("admin", "invoice", "debit", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  const items = ctx.rawParams["items"];
  if (!Array.isArray(items) || items.length === 0) {
    throw new FbError("Debit items are missing", 9998);
  }
  const client = await findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  // R5b review fix: PHP wraps debit in wrapInTransaction, so a
  // countIncome throw rolls the note back too. Validate BEFORE the
  // first write (nr claim + note creation) so the observable outcome
  // matches: error + nothing changed.
  await assertCountIncomeWritable(String(inv.currency ?? "USD"));
  const serie = "DN-";
  // R6b: same counter rule as credit notes (invoice_dn_starting_number).
  const nr = String(await reserveNumericParamValue("invoice_dn_starting_number", 1));
  const noteId = await insertInvoiceNote(
    noteRowFrom(inv, {
      serie,
      nr,
      status: "unpaid",
      debit_note_for_invoice_id: inv.id,
      due_at: new Date(Date.now() + (parseInt(await getSetting("invoice_due_days") ?? "5", 10) || 5) * 86400_000)
        .toISOString().slice(0, 19).replace("T", " "),
      // R5b: PHP creates the note with NULL base_income, then runs
      // countIncome AFTER inserting items — the old inline
      // sum x frozen rate was wrong on both the rate direction and
      // the (taxed) item values. See the countIncome call below.
      notes: auditLine(`Debit for #${inv.id} invoice.`),
      hash_expires_at: await hashExpiry(),
    }),
  );
  await updateInvoiceFields(inv.id, {
    notes: appendNote(inv.notes, `Debit invoice #${noteId} generated.`),
  });
  for (const item of items) {
    const it = item as Record<string, unknown>;
    await insertInvoiceItem({
      invoice_id: noteId,
      type: "custom",
      rel_id: null,
      task: "void",
      status: "pending_payment",
      title: typeof it["title"] === "string" ? it["title"] : "",
      period: null,
      quantity: Number(it["quantity"] ?? 1),
      unit: null,
      price: Number(it["price"] ?? 0),
      taxed: it["taxed"] ? 1 : 0,
    });
  }
  // PHP debitInvoice: countIncome(note) after items exist — note
  // base_income = toBaseCurrency(no-tax item sum), currency_rate
  // stays NULL, base_refund stays NULL.
  await countIncome(noteId);
  // Same shape as the R6b refund fix (invoice.ts refund path): the
  // debited template renders original_invoice.serie_nr
  // (mod_invoice_debited.html.twig:40); without it TS rendered an
  // empty "against invoice" slot where PHP renders FOSS00358 —
  // proven by the goldens batch's debit probe, which compared the
  // email_queue content row-for-row.
  await queueInvoiceEmail("mod_invoice_debited", noteId, {
    original_invoice: {
      serie_nr: `${inv.serie ?? ""}${String(inv.nr ?? inv.id).padStart(5, "0")}`,
    },
  });
  return noteId;
});

register("admin", "invoice", "cancel", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  await updateInvoiceFields(inv.id, {
    status: "canceled",
    notes: appendNote(inv.notes, "Invoice canceled (voided) without replacement."),
  });
  await insertInvoiceEvent(inv.id, "canceled", { status: "canceled" });
  return true;
});

register("admin", "invoice", "reissue", async (ctx: CallContext) => {
  requireAdmin(ctx);
  // R2a conditional guard (Invoice Admin::reissue): order/manage fires
  // only when an order or product is attached; PHP checks it before
  // loading the invoice, so this sits before getInvoiceOrThrow. PHP
  // !empty treats '0' as empty, hence the exclusion below.
  const attachParam = (v: string | undefined) => v !== undefined && v !== "" && v !== "0";
  if (attachParam(ctx.params["order_id"]) || attachParam(ctx.params["product_id"])) {
    await requirePermission(ctx, "order", "manage");
  }
  const inv = await getInvoiceOrThrow(ctx);
  const client = await findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  const totals = invoiceTotals(await listInvoiceItems(inv.id), inv.taxrate ?? "0");
  void totals;
  const newId = await prepareInvoice(
    client,
    (await listInvoiceItems(inv.id)).map((l) => ({
      title: l.title ?? "",
      price: l.price,
      quantity: l.quantity,
      unit: l.unit,
      period: l.period,
      taxed: !!l.taxed,
      type: l.type ?? undefined,
      rel_id: l.rel_id,
      task: l.task ?? undefined,
    })),
    inv.gateway_id,
  );
  await getDbWrite()
    .prepare("UPDATE invoice SET replaces_invoice_id = ? WHERE id = ?")
    .run(inv.id, newId);
  await issueInvoice(newId, client, {});
  await updateInvoiceFields(newId, { notes: auditLine(`Replacement for invoice #${inv.id}.`) });
  await updateInvoiceFields(inv.id, {
    status: "canceled",
    replaced_by_invoice_id: newId,
    notes: appendNote(inv.notes, `Reissued as invoice #${newId}.`),
  });
  return newId;
});

register("admin", "invoice", "renewal_invoice", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const orderId = ctx.params["id"];
  if (!orderId) throw new FbError("Order ID was not passed");
  const order = await findOrderById(Number(orderId));
  if (!order) throw new FbError("Order not found");
  const client = await findClientById(order.client_id);
  if (!client) throw new FbError("Client not found");
  const invoiceId = await prepareInvoice(
    client,
    [
      {
        title: order.title ?? "",
        price: order.price,
        quantity: order.quantity,
        unit: order.unit,
        period: order.period,
        taxed: true,
        type: "order",
        rel_id: order.id,
        task: "renew",
      },
    ],
    null,
  );
  await issueInvoice(invoiceId, client, {});
  await updateOrderRow(order.id, { unpaid_invoice_id: invoiceId });
  return invoiceId;
});

register("admin", "invoice", "journal", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  return (await listInvoiceEvents(inv.id)).map((e) => ({
    id: e.id,
    type: e.type,
    admin_id: e.admin_id,
    client_id: e.client_id,
    snapshot: e.snapshot ? (JSON.parse(e.snapshot) as unknown) : null,
    created_at: e.created_at,
  }));
});

register("admin", "invoice", "attach_order", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  const orderId = ctx.params["order_id"];
  if (!orderId) throw new FbError("Order ID was not passed");
  const order = await findOrderById(Number(orderId));
  if (!order) throw new FbError("Order not found");
  await insertInvoiceItem({
    invoice_id: inv.id,
    type: "order",
    rel_id: order.id,
    task: "activate",
    status: "pending_payment",
    title: order.title ?? "",
    period: order.period,
    quantity: order.quantity,
    unit: order.unit,
    price: order.price,
    taxed: 1,
  });
  const items = await listInvoiceItems(inv.id);
  return items[items.length - 1]?.id ?? 0;
});

register("admin", "invoice", "send_reminder", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = await getInvoiceOrThrow(ctx);
  // PHP also queues the rendered payment-reminder email.
  await queueInvoiceEmail("mod_invoice_payment_reminder", inv.id);
  await updateInvoiceFields(inv.id, { reminded_at: nowTimestamp() });
  return true;
});

// --- Batch jobs (cron, R5f) ---------------------------------------------------
// PHP order in Cron\Service::runCrons: pay_with_credits and
// activate_paid are NON-isolated (a throw aborts the run before
// last_cron_exec); the rest are isolated by the runner in cron.ts.

/** PHP's (int) cast: numeric strings truncate, non-numeric → 0. */
function phpInt(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return 0;
}

/** PHP is_numeric for the backfill nr/padding checks. */
function phpIsNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function cronLog(task: string, message: string): void {
  console.error(`[cron] ${task}: ${message}`);
}

// --- pay_with_credits ---------------------------------------------------------

/**
 * Invoice\Service::doBatchPayWithCredits (no-ids path — the runner's
 * path; the ids-based endpoint handler is unchanged, and PHP ignores
 * ids entirely, reading only an optional client_id filter). The SQL
 * pre-filter is issued + unpaid + a balance ROW >= a non-deposit
 * item's PRICE (per-row, not a sum); the SQL says ORDER BY id DESC
 * but doBatchPayWithCredits reloads via findBy with NO orderBy, so
 * the effective order is the repository's natural ASC order — the
 * reload below sorts ASC, so a shared limited balance pays the
 * lower id first (capture42 §H). Per-invoice try/catch; always true.
 */
export async function runBatchPayWithCredits(clientId?: number): Promise<boolean> {
  const rows = (await getDb()
    .prepare(
      `SELECT m.id FROM invoice m
         LEFT JOIN client_balance cb ON m.client_id = cb.client_id
         LEFT JOIN invoice_item pi ON pi.invoice_id = m.id
       WHERE m.status = 'unpaid' AND m.issued = 1
         AND cb.amount >= pi.price AND pi.type != 'deposit'
         ${clientId !== undefined ? "AND m.client_id = ?" : ""}
       GROUP BY m.id ORDER BY m.id DESC`,
    )
    .all(...(clientId !== undefined ? [clientId] : []))) as unknown as { id: number }[];
  const ids = rows.map((r) => r.id).sort((a, b) => a - b);
  for (const id of ids) {
    try {
      await tryPayWithCredits(id);
    } catch (e) {
      cronLog("invoice_batch_pay_with_credits", `Failed to cover invoice #${id} with client credits: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return true;
}

// --- activate_paid ------------------------------------------------------------

/**
 * Invoice\Service::doBatchPaidInvoiceActivation, bounded to the
 * order-driven shape the TS runner already had: pending_setup orders
 * whose paid invoice satisfies the 10-minute cutoff (paid_at NULL or
 * <= now-10min — a just-paid invoice is NOT activated on the same
 * run) are activated, and the order's activate-task items are marked
 * executed. Renew-task execution is a pinned gap (TS has order-renew
 * logic but wiring renew-task execution into the batch is a separate
 * piece); deposit/custom items are likewise not marked here (PHP
 * marks them executed unconditionally — since R6b the custom/deposit
 * branch below covers them; only renew-task execution stays a pinned
 * gap). Divergence,
 * proven by capture42 §I: a bare order with service_type NULL fails
 * PHP activation (mod_service('service') throws "Module service
 * does not have a service class") leaving attempts 1 + a note and
 * pending_setup, while TS activateOrderRow succeeds — parity39
 * asserts both shapes explicitly.
 */
export async function runBatchActivatePaid(): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const pending = await listOrders({ status: "pending_setup" });
  for (const order of pending) {
    if (!order.unpaid_invoice_id) continue;
    const inv = await findInvoiceById(order.unpaid_invoice_id);
    if (!inv || inv.status !== "paid") continue;
    if (inv.paid_at !== null && inv.paid_at !== undefined && inv.paid_at > cutoff) continue;
    await activateOrderRow(order);
    await getDbWrite()
      .prepare(
        `UPDATE invoice_item SET status = 'executed', updated_at = ?
         WHERE invoice_id = ? AND type = 'order' AND CAST(rel_id AS INTEGER) = ?
           AND task = 'activate' AND status NOT IN ('executed', 'failed')`,
      )
      .run(nowTimestamp(), inv.id, order.id);
  }
  // R6b: PHP's doBatchPaidInvoiceActivation executes EVERY
  // non-executed item of every paid invoice (Service.php:4125-4165),
  // and executeTask marks custom + deposit items executed
  // unconditionally (ServiceInvoiceItem.php:193-205). The order loop
  // above never touched them, so the 106 custom/void items of paid
  // reference invoices never executed on TS — the shadow harness
  // caught it. Order-task items keep the order-driven path above
  // (renew-task execution remains a pinned gap).
  await getDbWrite()
    .prepare(
      `UPDATE invoice_item SET status = 'executed', updated_at = ?
       WHERE status NOT IN ('executed', 'failed')
         AND type IN ('custom', 'deposit')
         AND invoice_id IN (SELECT id FROM invoice WHERE status = 'paid')`,
    )
    .run(nowTimestamp());
}

// --- generate -----------------------------------------------------------------

/** Order\Service::getSoonExpiringActiveOrdersQuery, zone-aware:
 * expires_before is zone-today + (issue_days_before_expire + 1) at
 * 00:00:00 (PHP's DateTimeImmutable('today') in the process TZ).
 * The underscore invoice_option 'issue_invoice' does NOT qualify —
 * only the hyphenated 'issue-invoice' does. */
async function getSoonExpiringActiveOrders(): Promise<OrderRowFull[]> {
  const daysRaw = await getSetting("invoice_issue_days_before_expire");
  const days = daysRaw === null || daysRaw === undefined ? 14 : phpInt(daysRaw);
  const expiresBefore = zoneTodayString(days + 1);
  return (await getDb()
    .prepare(
      `SELECT co.* FROM client_order co
         LEFT JOIN invoice i ON i.id = co.unpaid_invoice_id AND i.status = 'unpaid'
       WHERE co.status = 'active' AND co.invoice_option = 'issue-invoice'
         AND co.period IS NOT NULL AND co.expires_at IS NOT NULL AND i.id IS NULL
         AND NOT EXISTS (SELECT 1 FROM client_order_meta cm WHERE cm.client_order_id = co.id
           AND cm.name = 'cancel_at_period_end' AND cm.value = '1')
         AND NOT EXISTS (SELECT 1 FROM invoice_item pi INNER JOIN invoice pinv ON pinv.id = pi.invoice_id
           WHERE CAST(pi.rel_id AS INTEGER) = co.id AND pi.type = 'order' AND pi.task = 'renew'
             AND pi.status != 'executed' AND pinv.status = 'paid')
         AND co.expires_at < ? ORDER BY co.client_id DESC`,
    )
    .all(expiresBefore)) as unknown as OrderRowFull[];
}

/** Invoice\Service::shouldMergeRenewalsForOrder: per-order meta
 * override ('1'/'0'), then the client column, then the
 * invoice_merge_renewals setting (default false). Meta pairs are
 * last-write-wins, as getPairsForOrder builds them. */
async function shouldMergeRenewalsForOrder(order: OrderRowFull): Promise<boolean> {
  const metas = (await getDb()
    .prepare("SELECT value FROM client_order_meta WHERE client_order_id = ? AND name = 'merge_renewals' ORDER BY id")
    .all(order.id)) as unknown as { value: string | null }[];
  const override = metas.length ? metas[metas.length - 1].value : null;
  if (override === "1") return true;
  if (override === "0") return false;
  const client = await findClientById(order.client_id);
  const preference = client?.merge_renewals;
  if (preference !== null && preference !== undefined) return !!preference;
  const setting = await getSetting("invoice_merge_renewals");
  if (setting === null || setting === undefined) return false;
  return !(setting === "" || setting === "0");
}

/** Invoice\ServiceSubscription::hasActiveSubscriptionForOrder: an
 * 'active' subscription (non-blank sid) joined to an order item for
 * this order. Reference: 0 subscription rows → always false. */
async function hasActiveSubscriptionForOrder(order: OrderRowFull): Promise<boolean> {
  const rows = (await getDb()
    .prepare(
      `SELECT s.sid FROM subscription s INNER JOIN invoice_item ii ON ii.invoice_id = s.rel_id
       WHERE s.rel_type = 'invoice' AND ii.type = 'order' AND CAST(ii.rel_id AS INTEGER) = ?
         AND s.status = 'active'`,
    )
    .all(order.id)) as unknown as { sid: string | null }[];
  return rows.some((r) => String(r.sid ?? "").trim() !== "");
}

/**
 * Invoice\Service::resolveRenewalLine. Non-domain orders keep the
 * order price/quantity. Domain repricing (TLD renewal via
 * getProductRenewalLineConfig + getRateByCode) is a PINNED GAP: the
 * rate lookup still throws PHP's exact message when unconfigured,
 * but a configured domain order is skipped (logged) rather than
 * generated at a wrong price — parity39 uses non-domain orders only.
 */
async function resolveRenewalLine(order: OrderRowFull): Promise<{ price: number; line: { price: number; quantity: number; title?: string } }> {
  let price = order.price;
  let line: { price: number; quantity: number; title?: string } = { price: order.price, quantity: order.quantity };
  if (["active", "failed_renew", "suspended"].includes(order.status)) {
    const product = order.product_id ? await findProductById(order.product_id) : undefined;
    if (product && product.type === "domain") {
      const rateRow = await findCurrencyByCode(order.currency ?? "USD");
      if (!rateRow || rateRow.conversion_rate === null || rateRow.conversion_rate === undefined) {
        throw new FbError(`Currency rate for '${order.currency}' is not configured`);
      }
      throw new FbError("Domain renewal repricing is not ported to the TS runner");
    }
  }
  if (price * (line.quantity ?? 1) < 0) {
    throw new FbError("Invoices are not generated for negative amount orders.");
  }
  return { price, line };
}

/** Invoice\Service::setInvoiceDefaults, as far as a generated draft
 * observes it: serie from invoice_series, 30–60 hex hash, hash
 * expiry from invoice_hash_lifetime_days (default '90', ≤0 → null),
 * tax from getTaxRateForClient, notes from invoice_default_note.
 * The due_at default (now + invoice_due_days) is overwritten by the
 * caller below, so it is not written. */
async function generateInvoiceDefaults(client: ClientRow): Promise<{
  serie: string | null; hash: string; hashExpiresAt: string | null;
  taxname: string; taxrate: string; notes: string | null;
}> {
  const serie = await getSetting("invoice_series");
  const lifetimeRaw = await getSetting("invoice_hash_lifetime_days");
  const lifetimeDays = lifetimeRaw === null || lifetimeRaw === undefined ? 90 : phpInt(lifetimeRaw);
  const hashExpiresAt =
    lifetimeDays <= 0
      ? null
      : new Date(Date.now() + lifetimeDays * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const tax = await resolveTaxForClient(client);
  return {
    serie,
    hash: randomHex(15 + Math.floor(Math.random() * 16)),
    hashExpiresAt,
    taxname: tax.name,
    taxrate: tax.rate,
    notes: await getSetting("invoice_default_note"),
  };
}

/**
 * Invoice\Service::generateForOrder. The unpaid-invoice REUSE branch
 * (return the existing unpaid draft) is unreachable from the batch —
 * the qualifying query excludes unpaid-linked orders — but is
 * implemented faithfully; a link to a non-unpaid invoice is cleared
 * first. Currency is the ORDER's, not the client's. The renew item
 * is taxed via isClientTaxable (the admin renewal handler's hardcoded
 * taxed:true is wrong for the batch path). Renewal promos are a
 * PINNED GAP (TS has no renewal-promo path); parity39 uses orders
 * without recurrent promos. Due = expires_at (batch passes null
 * due_days); merged invoices use MAX expires_at.
 */
export async function generateForOrder(order: OrderRowFull): Promise<number> {
  if (order.unpaid_invoice_id !== null && order.unpaid_invoice_id !== undefined) {
    const existing = await findInvoiceById(order.unpaid_invoice_id);
    if (existing && existing.status === "unpaid") return existing.id;
    await updateOrderRow(order.id, { unpaid_invoice_id: null });
  }
  const { price, line } = await resolveRenewalLine(order);
  const client = await findClientById(order.client_id);
  if (!client) throw new FbError("Client not found");
  const defaults = await generateInvoiceDefaults(client);
  const id = await insertInvoice({
    client_id: client.id,
    serie: defaults.serie,
    nr: null,
    hash: defaults.hash,
    hash_expires_at: defaults.hashExpiresAt,
    currency: order.currency ?? "USD",
    currency_rate: null,
    credit: 0,
    status: "unpaid",
    taxname: defaults.taxname,
    taxrate: defaults.taxrate,
    gateway_id: null,
    due_at: order.expires_at as string,
    notes: defaults.notes,
  });
  const taxed = await isClientTaxable(client);
  await insertInvoiceItem({
    invoice_id: id,
    type: "order",
    rel_id: order.id,
    task: "renew",
    status: "pending_payment",
    title: line.title ?? order.title ?? "",
    period: order.period,
    quantity: line.quantity ?? order.quantity,
    unit: order.unit,
    price,
    taxed: taxed ? 1 : 0,
  });
  await updateOrderRow(order.id, { unpaid_invoice_id: id });
  const snapshot = await buildJournalSnapshot(id);
  await insertInvoiceEvent(id, "created", snapshot, { clientId: client.id });
  return id;
}

/** Invoice\Service::generateMergedInvoiceForOrders: all lines resolve
 * before anything persists; one draft for the bucket, due = MAX
 * expires_at, every order stamped. */
export async function generateMergedInvoiceForOrders(orders: OrderRowFull[]): Promise<number> {
  const first = orders[0];
  if (!first) throw new FbError("No orders were provided for the merged renewal invoice.");
  const client = await findClientById(first.client_id);
  if (!client) throw new FbError("Client not found");
  const resolved: { order: OrderRowFull; price: number; line: { price: number; quantity: number; title?: string } }[] = [];
  for (const order of orders) {
    const r = await resolveRenewalLine(order);
    resolved.push({ order, price: r.price, line: r.line });
  }
  let maxExpires: string | null = null;
  for (const order of orders) {
    if (order.expires_at && (maxExpires === null || order.expires_at > maxExpires)) maxExpires = order.expires_at;
  }
  const defaults = await generateInvoiceDefaults(client);
  const id = await insertInvoice({
    client_id: client.id,
    serie: defaults.serie,
    nr: null,
    hash: defaults.hash,
    hash_expires_at: defaults.hashExpiresAt,
    currency: first.currency ?? "USD",
    currency_rate: null,
    credit: 0,
    status: "unpaid",
    taxname: defaults.taxname,
    taxrate: defaults.taxrate,
    gateway_id: null,
    due_at: maxExpires as string,
    notes: defaults.notes,
  });
  const taxed = await isClientTaxable(client);
  for (const { order, price, line } of resolved) {
    await insertInvoiceItem({
      invoice_id: id,
      type: "order",
      rel_id: order.id,
      task: "renew",
      status: "pending_payment",
      title: line.title ?? order.title ?? "",
      period: order.period,
      quantity: line.quantity ?? order.quantity,
      unit: order.unit,
      price,
      taxed: taxed ? 1 : 0,
    });
    await updateOrderRow(order.id, { unpaid_invoice_id: id });
  }
  const snapshot = await buildJournalSnapshot(id);
  await insertInvoiceEvent(id, "created", snapshot, { clientId: client.id });
  return id;
}

/**
 * Invoice\Service::generateInvoicesForExpiringOrders. Non-mergeable
 * orders generate + issue inline (one try/catch each); mergeable
 * orders bucket by client|currency|expires-date|period, single
 * buckets via generateForOrder, multi buckets via the merged path,
 * generation failure falling back per-order (TS has no
 * EntityManager to close, so the fallback mirrors PHP's
 * non-EM-closed path). Issuance runs OUTSIDE generation: an issue
 * failure never re-generates.
 */
export async function runBatchGenerate(): Promise<boolean> {
  const orders = await getSoonExpiringActiveOrders();
  const buckets = new Map<string, OrderRowFull[]>();
  for (const order of orders) {
    let mergeable = false;
    try {
      mergeable = (await shouldMergeRenewalsForOrder(order)) && !(await hasActiveSubscriptionForOrder(order));
    } catch (e) {
      cronLog("invoice_batch_generate", `Merge evaluation failed for order #${order.id}: ${e instanceof Error ? e.message : String(e)}`);
      mergeable = false;
    }
    if (!mergeable) {
      try {
        const invoiceId = await generateForOrder(order);
        const client = await findClientById(order.client_id);
        if (!client) throw new FbError("Client not found");
        await issueInvoice(invoiceId, client, { useCredits: true, fullJournal: true });
      } catch (e) {
        cronLog("invoice_batch_generate", `Failed to generate invoice for order #${order.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    const key = `${order.client_id}|${order.currency}|${(order.expires_at ?? "").slice(0, 10)}|${order.period ?? ""}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(order);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    let invoiceIds: number[] = [];
    try {
      invoiceIds =
        bucket.length === 1
          ? [await generateForOrder(bucket[0])]
          : [await generateMergedInvoiceForOrders(bucket)];
    } catch (e) {
      cronLog("invoice_batch_generate", `Merged generation failed: ${e instanceof Error ? e.message : String(e)}`);
      if (bucket.length > 1) {
        for (const order of bucket) {
          try {
            invoiceIds.push(await generateForOrder(order));
          } catch (e2) {
            cronLog("invoice_batch_generate", `Fallback generation failed for order #${order.id}: ${e2 instanceof Error ? e2.message : String(e2)}`);
          }
        }
      }
    }
    for (const invoiceId of invoiceIds) {
      try {
        const row = await findInvoiceById(invoiceId);
        const client = row ? await findClientById(row.client_id) : undefined;
        if (!row || !client) throw new FbError("Client not found");
        await issueInvoice(invoiceId, client, { useCredits: true, fullJournal: true });
      } catch (e) {
        cronLog("invoice_batch_generate", `Failed to issue invoice #${invoiceId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return true;
}

// --- due-event reminders ------------------------------------------------------

/** Invoice\Service::parseInvoiceReminderIntervals: split on
 * /[,\s]+/, numeric only, int-cast, >0, unique, sorted. */
function parseReminderIntervals(value: string | null | undefined): number[] {
  const days: number[] = [];
  for (const part of String(value ?? "").split(/[,\s]+/)) {
    if (part === "" || !phpIsNumeric(part)) continue;
    const day = Math.trunc(Number(part));
    if (day > 0) days.push(day);
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Invoice\Service::isReminderSendTimeReached: read failure, empty,
 * bad format, or out-of-range hour/minute all mean "reached" (legacy
 * behavior); otherwise true once the zone-local time reaches HH:MM. */
async function isReminderSendTimeReached(): Promise<boolean> {
  let configured: string | null;
  try {
    configured = await getSetting("invoice_reminder_send_time");
  } catch {
    return true;
  }
  const text = (configured ?? "").trim();
  if (text === "") return true;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return true;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) return true;
  const zone = resolveZone();
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + min >= hour * 60 + minute;
}

/**
 * Invoice\Service::sendInvoiceReminder (the BEFORE-due path only):
 * paid → no-op; else stamp reminded_at, queue the payment-reminder
 * email, write the REMINDER journal event. Pinned gaps: NO PDF
 * attachment (the R5e template_send attachment gap) and NO
 * hash-lifetime extension (TS has no extendInvoiceHashLifetime).
 */
export async function sendInvoiceReminder(inv: InvoiceRowFull): Promise<boolean> {
  if (inv.status === "paid") return true;
  await updateInvoiceFields(inv.id, { reminded_at: nowTimestamp() });
  await queueInvoiceEmail("mod_invoice_payment_reminder", inv.id);
  const snapshot = await buildJournalSnapshot(inv.id);
  await insertInvoiceEvent(inv.id, "reminder", snapshot, { clientId: inv.client_id });
  return true;
}

/**
 * Invoice\Service::onEventAfterInvoiceIsDue (the AFTER-due path) —
 * deliberately NOT sendInvoiceReminder: PHP sends a DIFFERENT
 * template here (mod_invoice_due_after, with days_passed) and writes
 * NO journal event, and does not re-stamp reminded_at (the claim
 * already did). A missing client throws, like PHP's 'Invoice
 * client data is unavailable', so the handler releases the claim.
 * Pinned gap: NO PDF attachment (same R5e gap as the before path).
 */
export async function sendOverdueInvoiceEmail(inv: InvoiceRowFull, daysPassed: number): Promise<boolean> {
  const client = await findClientById(inv.client_id);
  if (!client) throw new FbError("Invoice client data is unavailable.");
  await queueInvoiceEmail("mod_invoice_due_after", inv.id, { days_passed: daysPassed });
  return true;
}

async function handleBeforeInvoiceIsDue(invoiceId: number, daysLeft: number, intervals: number[]): Promise<void> {
  let claimed = false;
  try {
    if (!(await isReminderSendTimeReached())) return;
    if (daysLeft < 1 || !intervals.includes(daysLeft)) return;
    const zone = resolveZone();
    const nowStr = formatZoneDateTime(zone, Date.now());
    const todayStart = zoneTodayString(0);
    const res = await getDbWrite()
      .prepare(
        `UPDATE invoice SET reminded_at = ?, updated_at = ? WHERE id = ? AND status = 'unpaid'
         AND issued = 1 AND due_at > ? AND (reminded_at IS NULL OR reminded_at < ?)`,
      )
      .run(nowStr, nowStr, invoiceId, nowStr, todayStart);
    claimed = res.changes > 0;
    if (!claimed) return;
    const inv = await findInvoiceById(invoiceId);
    if (inv) await sendInvoiceReminder(inv);
  } catch (e) {
    if (claimed) {
      await getDbWrite().prepare("UPDATE invoice SET reminded_at = NULL WHERE id = ?").run(invoiceId);
    }
    cronLog("invoice_batch_invoke_due_event", `Failed to send invoice reminder email ${invoiceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleAfterInvoiceIsDue(invoiceId: number, daysPassed: number, intervals: number[]): Promise<void> {
  let claimed = false;
  try {
    if (!(await isReminderSendTimeReached())) return;
    if (daysPassed < 1 || !intervals.includes(daysPassed)) return;
    const zone = resolveZone();
    const nowStr = formatZoneDateTime(zone, Date.now());
    const todayStart = zoneTodayString(0);
    const tomorrowStart = zoneTodayString(1);
    const res = await getDbWrite()
      .prepare(
        `UPDATE invoice SET reminded_at = ?, updated_at = ? WHERE id = ? AND status = 'unpaid'
         AND issued = 1 AND due_at < ? AND (reminded_at IS NULL OR reminded_at < ?)`,
      )
      .run(nowStr, nowStr, invoiceId, tomorrowStart, todayStart);
    claimed = res.changes > 0;
    if (!claimed) return;
    const inv = await findInvoiceById(invoiceId);
    if (inv) await sendOverdueInvoiceEmail(inv, daysPassed);
  } catch (e) {
    if (claimed) {
      await getDbWrite().prepare("UPDATE invoice SET reminded_at = NULL WHERE id = ?").run(invoiceId);
    }
    cronLog("invoice_batch_invoke_due_event", `Failed to send overdue invoice email ${invoiceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Invoice\Service::fireDueReminderEvents: before list = unpaid +
 * issued + due_at > now (days_left = calendar-date diff); after list
 * = unpaid + issued + due_at < tomorrow-start (days_passed = ABS
 * calendar-date diff). No other listeners exist for these events —
 * the built-in handlers above run inline (TS has no event bus).
 */
export async function fireDueReminderEvents(): Promise<void> {
  const beforeRaw = await getSetting("invoice_reminder_before_due_days");
  const afterRaw = await getSetting("invoice_reminder_after_due_days");
  const beforeIntervals = parseReminderIntervals(beforeRaw ?? "");
  const afterIntervals = parseReminderIntervals(afterRaw ?? "5");
  const zone = resolveZone();
  const nowStr = formatZoneDateTime(zone, Date.now());
  const tomorrowStart = zoneTodayString(1);
  const diffExpr = "CAST(julianday(date(due_at)) - julianday(date(?)) AS INTEGER)";
  const beforeRows = (await getDb()
    .prepare(
      `SELECT id, ${diffExpr} AS days_left FROM invoice
       WHERE status = 'unpaid' AND issued = 1 AND due_at > ? ORDER BY id`,
    )
    .all(nowStr, nowStr)) as unknown as { id: number; days_left: number }[];
  for (const r of beforeRows) await handleBeforeInvoiceIsDue(r.id, r.days_left, beforeIntervals);
  const afterRows = (await getDb()
    .prepare(
      `SELECT id, ABS(${diffExpr}) AS days_passed FROM invoice
       WHERE status = 'unpaid' AND issued = 1 AND due_at < ? ORDER BY id`,
    )
    .all(nowStr, tomorrowStart)) as unknown as { id: number; days_passed: number }[];
  for (const r of afterRows) await handleAfterInvoiceIsDue(r.id, r.days_passed, afterIntervals);
}

/**
 * Invoice\Service::doBatchInvokeDueEvent: once_per_day (default true)
 * gate on invoice_overdue_invoked — within 86400s → false, no fire,
 * no update; exactly 86400s ago → gate open. Else fire + stamp + true.
 */
export async function runBatchInvokeDueEvent(opts: { oncePerDay?: boolean } = {}): Promise<boolean> {
  const once = opts.oncePerDay ?? true;
  const last = await getSetting("invoice_overdue_invoked");
  if (once && last) {
    // PHP compares second-precision timestamps (time() vs
    // strtotime): age < 86400s → gate closed; exactly 86400s → open.
    const lastMs = parseZoneDateTime(resolveZone(), last);
    if (lastMs !== null && Math.floor(Date.now() / 1000) - Math.floor(lastMs / 1000) < 86400) return false;
  }
  await fireDueReminderEvents();
  await setSettingValue("invoice_overdue_invoked", nowTimestamp());
  return true;
}

/**
 * Invoice\Service::doBatchRemindersSend — REPLACES the old TS job
 * (which queued for every overdue issued unpaid invoice + stamped
 * reminded_at, with no gate, no intervals, no claiming). Dispatch
 * the Before event (no listeners → no-op), run the once-per-day
 * due-event batch; when it returns false (gate already set today),
 * fire the pending reminders WITHOUT updating the gate. Always true
 * in practice (the pending path returns true); the runner ignores
 * return values anyway — only throws mark a task failed.
 */
export async function doBatchRemindersSend(): Promise<boolean> {
  let result = await runBatchInvokeDueEvent({ oncePerDay: true });
  if (!result) {
    await fireDueReminderEvents();
    result = true;
  }
  return result;
}

// --- journal heal + expired-unpaid removal (After listeners) ------------------

/**
 * UpdatePatcher::healInvoiceJournal via Invoice\Service::
 * healMissingJournalEntries: ONE page of 500, keyset id > last,
 * invoices with NO invoice_event row. Per row an atomic claim
 * (UPDATE ... WHERE NOT EXISTS event), then a BACKFILL snapshot —
 * NOT a recordJournalEvent snapshot: subtotal/tax/total null,
 * buyer/seller from the invoice row's own fields (buyer_address is
 * the row's SINGLE field), serie_nr with the invoice_number_padding
 * setting (default 5), type 'created' if unissued else paid/
 * canceled/refunded/issued by status, event created_at = the
 * invoice's created_at (not now).
 */
export async function healInvoiceJournal(): Promise<void> {
  const paddingRaw = await getSetting("invoice_number_padding");
  const padding = paddingRaw !== null && phpIsNumeric(paddingRaw) && phpInt(paddingRaw) > 0 ? phpInt(paddingRaw) : 5;
  const rows = (await getDb()
    .prepare(
      `SELECT i.id, i.nr, i.serie, i.status, i.issued, i.client_id,
         i.buyer_first_name, i.buyer_last_name, i.buyer_company, i.buyer_company_vat,
         i.buyer_company_number, i.buyer_address, i.buyer_city, i.buyer_state,
         i.buyer_country, i.buyer_phone, i.buyer_email, i.buyer_zip,
         i.seller_company, i.seller_company_vat, i.seller_company_number,
         i.seller_address, i.seller_phone, i.seller_email,
         i.paid_at, i.due_at, i.created_at
       FROM invoice i LEFT JOIN invoice_event e ON e.invoice_id = i.id
       WHERE e.id IS NULL AND i.id > ? ORDER BY i.id LIMIT 500`,
    )
    .all(0)) as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const id = Number(row["id"]);
    const claim = await getDbWrite()
      .prepare("UPDATE invoice SET updated_at = updated_at WHERE id = ? AND NOT EXISTS (SELECT 1 FROM invoice_event WHERE invoice_id = ?)")
      .run(id, id);
    if (claim.changes === 0) continue;
    const nr = phpIsNumeric(row["nr"]) ? Math.trunc(Number(row["nr"])) : id;
    const snapshot = {
      serie_nr: `${row["serie"] ?? ""}${String(nr).padStart(padding, "0")}`,
      status: row["status"] ?? null,
      issued: !!row["issued"],
      subtotal: null,
      tax: null,
      total: null,
      buyer: {
        first_name: row["buyer_first_name"] ?? null,
        last_name: row["buyer_last_name"] ?? null,
        company: row["buyer_company"] ?? null,
        company_vat: row["buyer_company_vat"] ?? null,
        company_number: row["buyer_company_number"] ?? null,
        address: row["buyer_address"] ?? null,
        city: row["buyer_city"] ?? null,
        state: row["buyer_state"] ?? null,
        country: row["buyer_country"] ?? null,
        phone: row["buyer_phone"] ?? null,
        email: row["buyer_email"] ?? null,
        zip: row["buyer_zip"] ?? null,
      },
      seller: {
        company: row["seller_company"] ?? null,
        company_vat: row["seller_company_vat"] ?? null,
        company_number: row["seller_company_number"] ?? null,
        address: row["seller_address"] ?? null,
        phone: row["seller_phone"] ?? null,
        email: row["seller_email"] ?? null,
      },
      paid_at: row["paid_at"] ?? null,
      due_at: row["due_at"] ?? null,
      created_at: row["created_at"] ?? null,
    };
    let type = "created";
    if (row["issued"]) {
      type =
        row["status"] === "paid" ? "paid"
        : row["status"] === "canceled" ? "canceled"
        : row["status"] === "refunded" ? "refunded"
        : "issued";
    }
    await insertInvoiceEvent(id, type, snapshot, {
      clientId: typeof row["client_id"] === "number" ? row["client_id"] : null,
      createdAt: typeof row["created_at"] === "string" ? row["created_at"] : null,
    });
  }
}

function isInvoiceCancellableRow(inv: InvoiceRowFull): boolean {
  return (
    !!inv.issued &&
    inv.status === "unpaid" &&
    inv.credit_note_for_invoice_id === null &&
    inv.debit_note_for_invoice_id === null &&
    inv.replaced_by_invoice_id === null
  );
}

/**
 * Invoice\Service::removeExpiredUnpaidInvoices (After listener):
 * remove_after_days unset/falsy → no-op. Else invoices unpaid with a
 * due date more than `days` calendar days old (SQLite
 * CAST(julianday(date('now')) - julianday(date(due_at))) > days):
 * cancellable → cancelInvoice with the exact reason (voided note +
 * reason note, canceled journal event with reason extra, transaction
 * detach; cancel email only when invoice_send_cancel_email is '1');
 * unissued + unpaid + all note links null → rmInvoice (order unlink
 * unpaid_invoice_id=NULL, transaction DETACH not delete, items
 * delete, journal delete for drafts, invoice delete). Issued notes
 * are left alone. Per-invoice try/catch.
 */
export async function removeExpiredUnpaidInvoices(): Promise<void> {
  const raw = await getSetting("remove_after_days");
  if (raw === null || raw === undefined || raw === "" || raw === "0") return;
  const days = phpInt(raw);
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM invoice WHERE status = 'unpaid' AND due_at IS NOT NULL
       AND CAST(julianday(date('now')) - julianday(date(due_at)) AS INTEGER) > ? ORDER BY id`,
    )
    .all(days)) as unknown as InvoiceRowFull[];
  for (const row of rows) {
    try {
      const fresh = await findInvoiceById(row.id);
      if (!fresh) continue;
      if (isInvoiceCancellableRow(fresh)) {
        const reason = `Expired unpaid — automatically voided after ${days} days.`;
        await updateInvoiceFields(fresh.id, {
          status: "canceled",
          notes: appendNote(fresh.notes, "Invoice canceled (voided) without replacement."),
        });
        const afterFirst = await findInvoiceById(fresh.id);
        await updateInvoiceFields(fresh.id, { notes: appendNote(afterFirst?.notes ?? null, reason) });
        await getDbWrite().prepare('UPDATE "transaction" SET invoice_id = NULL WHERE invoice_id = ?').run(fresh.id);
        const snapshot = (await buildJournalSnapshot(fresh.id)) as Record<string, unknown>;
        snapshot["reason"] = reason;
        await insertInvoiceEvent(fresh.id, "canceled", snapshot, { clientId: fresh.client_id });
        if ((await getSetting("invoice_send_cancel_email")) === "1") {
          await queueInvoiceEmail("mod_invoice_canceled", fresh.id);
        }
      } else if (
        !fresh.issued && fresh.status === "unpaid" &&
        fresh.credit_note_for_invoice_id === null && fresh.debit_note_for_invoice_id === null &&
        fresh.replaces_invoice_id === null && fresh.replaced_by_invoice_id === null
      ) {
        await getDbWrite().prepare("UPDATE client_order SET unpaid_invoice_id = NULL WHERE unpaid_invoice_id = ?").run(fresh.id);
        await getDbWrite().prepare('UPDATE "transaction" SET invoice_id = NULL WHERE invoice_id = ?').run(fresh.id);
        await getDbWrite().prepare("DELETE FROM invoice_item WHERE invoice_id = ?").run(fresh.id);
        await getDbWrite().prepare("DELETE FROM invoice_event WHERE invoice_id = ?").run(fresh.id);
        await getDbWrite().prepare("DELETE FROM invoice WHERE id = ?").run(fresh.id);
      }
    } catch (e) {
      cronLog("cron_after_expired_unpaid", `Could not expire unpaid invoice #${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

register("admin", "invoice", "batch_activate_paid", async (ctx: CallContext) => {
  requireAdmin(ctx);
  await runBatchActivatePaid();
  return true;
});

register("admin", "invoice", "batch_send_reminders", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await doBatchRemindersSend();
});

register("admin", "invoice", "batch_generate", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await runBatchGenerate();
});

register("admin", "invoice", "batch_invoke_due_event", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await runBatchInvokeDueEvent();
});

// ---------------------------------------------------------------------------
// Transaction processing + approval (Phase 4 batch 1). Parity oracle:
// capture13.py. The Custom gateway is manual-approval: processing it
// is refused (7002) and settlement happens through approve, which
// pays the invoice from the existing transaction record.
// ---------------------------------------------------------------------------

const MANUAL_APPROVAL_GATEWAYS = new Set(["Custom"]);

export function manualApprovalMessage(gatewayCode: string): string {
  return `${gatewayCode} payments must be approved by an administrator.`;
}

export async function processTransactionRow(
  tx: TransactionRowFull,
  payload?: { post: Record<string, string>; get: Record<string, string>; rawBody: string },
): Promise<void> {
  const gateway = tx.gateway_id ? await findGatewayFull(tx.gateway_id) : undefined;
  if (!gateway) {
    throw new FbError("Cannot handle transaction received from unknown payment gateway", 704);
  }
  if (MANUAL_APPROVAL_GATEWAYS.has(gateway.gateway)) {
    throw new FbError(manualApprovalMessage(gateway.gateway), 7002);
  }
  if (gateway.gateway === "PayPalEmail") {
    // Admin process replays the stored IPN envelope; the live route
    // passes the fresh request payload.
    let post = payload?.post ?? {};
    let get = payload?.get ?? {};
    let rawBody = payload?.rawBody ?? "";
    if (!payload && tx.ipn) {
      try {
        const env = JSON.parse(tx.ipn) as { post?: Record<string, string>; get?: Record<string, string>; http_raw_post_data?: string };
        post = env.post ?? {};
        get = env.get ?? {};
        rawBody = env.http_raw_post_data ?? "";
      } catch {
        post = {};
      }
    }
    const { processPayPalTransaction } = await import("../paypal");
    await processPayPalTransaction(tx.id, post, get, rawBody, gateway.id);
    return;
  }
  // Other non-manual gateways settle through their webhook/IPN
  // adapters (Stripe); a bare process call has no adapter payload.
  throw new FbError("Transaction could not be processed", 9999);
}

export async function approveTransactionRow(tx: TransactionRowFull): Promise<void> {
  const gateway = tx.gateway_id ? await findGatewayFull(tx.gateway_id) : undefined;
  if (!gateway || !MANUAL_APPROVAL_GATEWAYS.has(gateway.gateway)) {
    throw new FbError("This payment gateway does not require manual approval.", 7003);
  }
  if (!tx.invoice_id) throw new FbError("Invoice not found");
  const inv = await findInvoiceById(tx.invoice_id);
  if (!inv) throw new FbError("Invoice not found");
  const totals = invoiceTotals(await listInvoiceItems(inv.id), inv.taxrate ?? "0");
  const gatewayName = gateway.name ?? gateway.gateway;
  await updateTransactionRow(tx.id, {
    status: "processed",
    amount: String(totals.total),
    currency: inv.currency,
    note: `${gatewayName} transaction No: ${tx.txn_id ?? ""}`,
    error: null,
    error_code: null,
  });
  if (inv.status !== "paid") {
    await markInvoicePaid(inv.id);
  }
  // The transaction-approve path credits deposits differently from
  // mark_as_paid: type 'gift', no rel_id (PHP's approve service calls
  // addFunds with no type/rel data).
  if (await isDepositInvoice(inv.id)) {
    await insertBalanceRow({
      client_id: inv.client_id,
      type: "gift",
      rel_id: null,
      amount: totals.total,
      description: `${gatewayName} transaction No: ${tx.txn_id ?? ""}`,
    });
  }
}

register("admin", "invoice", "transaction_process", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = await getTransactionOrThrow(ctx);
  await processTransactionRow(tx);
  return true;
});

register("admin", "invoice", "transaction_approve", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = await getTransactionOrThrow(ctx);
  await approveTransactionRow(tx);
  return true;
});

register("admin", "invoice", "transaction_process_all", async (ctx: CallContext) => {
  requireAdmin(ctx);
  // processReceivedATransactions: every 'received' row is attempted;
  // failures land on the transaction's error fields, not the caller.
  for (const tx of await listTransactions({ status: "received" })) {
    try {
      await processTransactionRow(tx);
    } catch (e) {
      await updateTransactionRow(tx.id, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return true;
});

register("admin", "invoice", "transaction_claim_for_processing", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = await getTransactionOrThrow(ctx);
  if (tx.status !== "received") return false;
  await updateTransactionRow(tx.id, { status: "processing" });
  return true;
});

/* ------------------------------------------------------------------ */
/* Phase 5 R1 invoice leftovers (parity oracle: captures21)            */
/* ------------------------------------------------------------------ */

import { paginate } from "../util";

/** PHP Tools::normalizeBoolean for filter params. */
function normalizeBoolParam(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  if (v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes" || v.toLowerCase() === "on") return 1;
  return 0;
}

/** ids[] from a JSON body array or form bracket keys, in index order. */
function idsParam(ctx: CallContext): unknown[] | undefined {
  const raw = ctx.rawParams?.["ids"];
  if (Array.isArray(raw)) return raw;
  const byIndex = new Map<number, string>();
  for (const [k, v] of Object.entries(ctx.params)) {
    const m = /^ids\[(\d+)\]$/.exec(k);
    if (m && v !== undefined) byIndex.set(Number(m[1]), v);
  }
  if (byIndex.size) {
    return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  }
  return undefined;
}

/* ------------------------- statuses / failed items ------------------------- */

register("admin", "invoice", "get_statuses", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT status, COUNT(1) AS c FROM invoice GROUP BY status").all() as { status: string; c: number }[];
  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    counts[r.status] = r.c;
    total += r.c;
  }
  return {
    total,
    paid: counts["paid"] ?? 0,
    unpaid: counts["unpaid"] ?? 0,
    refunded: counts["refunded"] ?? 0,
    canceled: counts["canceled"] ?? 0,
  };
});

/** InvoiceItem entity toApiArray (NOT the invoice-lines shape). */
function failedItemArray(it: {
  id: number; invoice_id: number | null; type: string | null; rel_id: string | number | null;
  task: string | null; status: string | null; title: string | null; period: string | null;
  quantity: number; unit: string | null; price: number | string | null; charged: number;
  taxed: number; attempts: number; created_at: string | null; updated_at: string | null;
}): Record<string, unknown> {
  return {
    id: it.id,
    invoice_id: it.invoice_id,
    type: it.type,
    rel_id: it.rel_id,
    task: it.task,
    status: it.status,
    title: it.title,
    period: it.period,
    quantity: it.quantity,
    unit: it.unit,
    price: it.price === null ? null : Number(it.price),
    charged: Number(it.charged),
    taxed: Number(it.taxed),
    attempts: it.attempts,
    created_at: it.created_at,
    updated_at: it.updated_at,
  };
}

register("admin", "invoice", "get_failed_items", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const rows = await getDb()
    .prepare("SELECT id, invoice_id, type, rel_id, task, status, title, period, quantity, unit, price, charged, taxed, attempts, created_at, updated_at FROM invoice_item WHERE status = 'failed' ORDER BY id DESC")
    .all() as Parameters<typeof failedItemArray>[0][];
  return rows.map(failedItemArray);
});

register("admin", "invoice", "item_requeue", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Invoice item ID was not passed");
  const item = await findInvoiceItemRow(Number(idRaw));
  if (!item) throw new FbError("Invoice item was not found");
  const full = await getDb().prepare("SELECT status FROM invoice_item WHERE id = ?").get(Number(idRaw)) as { status: string } | undefined;
  if (full?.status !== "failed") throw new FbError("Invoice item is not in a failed state");
  await getDbWrite()
    .prepare("UPDATE invoice_item SET status = 'pending_setup', attempts = 0, updated_at = ? WHERE id = ?")
    .run(nowTimestamp(), Number(idRaw));
  return true;
});

/* -------------------------------- gateways -------------------------------- */

const KNOWN_ADAPTERS = ["ClientBalance", "Custom", "PayPalEmail", "Stripe"];

async function installedGatewayCodes(): Promise<string[]> {
  return ((await getDb().prepare("SELECT gateway FROM pay_gateway").all()) as { gateway: string }[]).map((r) => r.gateway);
}

register("admin", "invoice", "gateway_get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const r of await getDb().prepare("SELECT id, name FROM pay_gateway ORDER BY id ASC").all() as { id: number; name: string }[]) {
    out[String(r.id)] = r.name;
  }
  return out;
});

register("admin", "invoice", "gateway_get_available", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const installed = new Set(await installedGatewayCodes());
  return KNOWN_ADAPTERS.filter((code) => !installed.has(code));
});

register("admin", "invoice", "gateway_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  let rows = await getDb().prepare("SELECT id, name, gateway, accepted_currencies, enabled, allow_single, allow_recurrent, test_mode, config, custom_logo FROM pay_gateway").all() as unknown as GatewayRow[];
  const p = ctx.params;
  if (p["search"]) {
    const q = p["search"].toLowerCase();
    rows = rows.filter((r) => (r.name ?? "").toLowerCase().includes(q) || (r.gateway ?? "").toLowerCase().includes(q));
  }
  for (const [param, col] of [["enabled", "enabled"], ["allow_single", "allow_single"], ["allow_recurrent", "allow_recurrent"], ["test_mode", "test_mode"]] as const) {
    const want = normalizeBoolParam(p[param]);
    if (want !== null) rows = rows.filter((r) => (r[col] ? 1 : 0) === want);
  }
  const sortKey = p["sort"] ?? "id";
  const dir = (p["dir"] ?? "asc").toLowerCase() === "desc" ? -1 : 1;
  const keyOf = (r: GatewayRow): string | number =>
    sortKey === "title" ? (r.name ?? "") : sortKey === "code" ? r.gateway : r.id;
  rows = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return (a.id - b.id) * dir;
  });
  return paginate(await Promise.all(rows.map(gatewayRowToApiArray)), p);
});

register("admin", "invoice", "gateway_install", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Payment gateway code is missing");
  const installed = new Set(await installedGatewayCodes());
  if (installed.has(code) || !KNOWN_ADAPTERS.includes(code)) {
    throw new FbError("Payment gateway is not available for installation.");
  }
  await getDbWrite()
    .prepare("INSERT INTO pay_gateway (name, gateway, accepted_currencies, enabled, allow_single, allow_recurrent, test_mode, config, custom_logo) VALUES (?, ?, NULL, 0, 1, 1, 0, NULL, NULL)")
    .run(code, code);
  return true;
});

register("admin", "invoice", "gateway_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Gateway ID was not passed");
  const row = await findGatewayRow(Number(idRaw));
  if (!row) throw new FbError("Gateway not found");
  return await gatewayRowToApiArray(row);
});

register("admin", "invoice", "gateway_copy", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Gateway ID was not passed");
  const row = await findGatewayRow(Number(idRaw));
  if (!row) throw new FbError("Gateway not found");
  // Copy does NOT carry allow_single/allow_recurrent: entity defaults
  // (true/true) apply to the new row.
  const info = await getDbWrite().insertAndGetId("INSERT INTO pay_gateway (name, gateway, accepted_currencies, enabled, allow_single, allow_recurrent, test_mode, config, custom_logo) VALUES (?, ?, ?, 0, 1, 1, ?, ?, ?)", `${row.name} (Copy)`, row.gateway, row.accepted_currencies, row.test_mode ? 1 : 0, row.config, row.custom_logo);
  return Number(info);
});

function validateGatewayConfigOnEnable(row: GatewayRow, mergedConfig: Record<string, unknown>, testMode: boolean): void {
  const fail = (missing: string, adapter: string): never => {
    throw new FbError(`The "${adapter}" payment gateway is not fully configured. Please configure the ${missing}`, 819);
  };
  if (row.gateway === "Stripe") {
    if (testMode) {
      if (mergedConfig["test_api_key"] === undefined || mergedConfig["test_api_key"] === null) fail("Test API Key", "Stripe");
      if (mergedConfig["test_pub_key"] === undefined || mergedConfig["test_pub_key"] === null) fail("Test publishable key", "Stripe");
    } else {
      if (mergedConfig["api_key"] === undefined || mergedConfig["api_key"] === null) fail("API key", "Stripe");
      if (mergedConfig["pub_key"] === undefined || mergedConfig["pub_key"] === null) fail("Publishable key", "Stripe");
    }
  } else if (row.gateway === "PayPalEmail") {
    if (mergedConfig["email"] === undefined || mergedConfig["email"] === null) fail("PayPal Email address", "PayPal");
  }
  // Custom, ClientBalance and unknown adapters impose no requirements.
}

register("admin", "invoice", "gateway_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Gateway ID was not passed");
  const row = await findGatewayRow(Number(idRaw));
  if (!row) throw new FbError("Gateway not found");
  const p = ctx.params;
  const newEnabled = p["enabled"] !== undefined ? toBoolParam(p["enabled"]) : !!row.enabled;
  const newTestMode = p["test_mode"] !== undefined ? toBoolParam(p["test_mode"]) : !!row.test_mode;
  let config: Record<string, unknown> = {};
  try {
    config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
  } catch { /* keep {} */ }
  const submittedConfig = nestedObjectParam(ctx, "config");
  if (submittedConfig) {
    const secrets = adapterSecretFields(row.gateway);
    for (const [key, value] of Object.entries(submittedConfig)) {
      if (secrets.includes(key)) {
        // Blank, whitespace-only or __KEEP__ preserves the stored value.
        if (value === null || typeof value !== "string" || value.trim() === "" || value === "__KEEP__") continue;
      }
      config[key] = value;
    }
  }
  if (newEnabled) validateGatewayConfigOnEnable(row, config, newTestMode);
  const db = getDbWrite();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (p["title"] !== undefined) set("name", p["title"]);
  if (p["remove_custom_logo"] !== undefined && toBoolParam(p["remove_custom_logo"])) set("custom_logo", null);
  // logo_url download and logo_file upload are file/network work the TS
  // seam does not perform (documented gap); other fields update normally.
  if (submittedConfig) set("config", JSON.stringify(config));
  const currencies = (() => {
    const raw = ctx.rawParams?.["accepted_currencies"];
    if (Array.isArray(raw)) return raw;
    const scanned = bracketObject(ctx.params, "accepted_currencies");
    if (scanned) {
      const idx = Object.keys(scanned).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
      if (idx.length) return idx.map((k) => scanned[k]);
    }
    return undefined;
  })();
  if (currencies !== undefined) set("accepted_currencies", JSON.stringify(currencies));
  set("enabled", newEnabled ? 1 : 0);
  if (p["allow_single"] !== undefined) set("allow_single", toBoolParam(p["allow_single"]) ? 1 : 0);
  if (p["allow_recurrent"] !== undefined) set("allow_recurrent", toBoolParam(p["allow_recurrent"]) ? 1 : 0);
  set("test_mode", newTestMode ? 1 : 0);
  await db.prepare(`UPDATE pay_gateway SET ${sets.join(", ")} WHERE id = ?`).run(...vals, row.id);
  return true;
});

/** PHP (bool) cast for form/JSON flags ("0" false, "false" TRUE). */
function toBoolParam(v: string | number | boolean): boolean {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "false") return true;
  if (v === false || v === 0 || v === "0" || v === "") return false;
  return true;
}

register("admin", "invoice", "gateway_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Gateway ID was not passed");
  const row = await findGatewayRow(Number(idRaw));
  if (!row) throw new FbError("Gateway not found");
  const db = getDb();
  const hasInvoices = ((await db.prepare("SELECT COUNT(1) AS c FROM invoice WHERE gateway_id = ?").get(row.id)) as { c: number }).c > 0;
  if (hasInvoices) throw new FbError("Cannot remove payment gateway with existing invoices");
  const hasSubs = ((await db.prepare("SELECT COUNT(1) AS c FROM subscription WHERE pay_gateway_id = ?").get(row.id)) as { c: number }).c > 0;
  if (hasSubs) throw new FbError("Cannot remove payment gateway with existing subscriptions");
  const hasTx = ((await db.prepare('SELECT COUNT(1) AS c FROM "transaction" WHERE gateway_id = ?').get(row.id)) as { c: number }).c > 0;
  if (hasTx) throw new FbError("Cannot remove payment gateway with existing transactions");
  await getDbWrite().prepare("DELETE FROM pay_gateway WHERE id = ?").run(row.id);
  return true;
});

/* ------------------------------- batch deletes ------------------------------- */

async function deleteInvoiceAdminById(id: number): Promise<void> {
  const inv = await findInvoiceById(id);
  if (!inv) throw new FbError("Invoice not found");
  if (!isDeletable(inv)) {
    throw new FbError(
      "Only unissued, unpaid invoices (drafts) can be deleted. Cancel (void) an issued unpaid invoice, or reissue/refund it instead. Relax invoice immutability to delete issued invoices for cleanup.",
    );
  }
  await deleteInvoiceCascade(inv.id);
}

register("admin", "invoice", "batch_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (!ids) throw new FbError("IDs were not passed");
  for (const id of ids) await deleteInvoiceAdminById(Number(id));
  return true;
});

register("admin", "invoice", "batch_delete_subscription", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (!ids) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const sub = await findSubscriptionById(Number(id));
    if (!sub) throw new FbError("Subscription not found");
    await deleteSubscriptionRow(sub.id);
  }
  return true;
});

register("admin", "invoice", "batch_delete_transaction", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (!ids) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const tx = await findTransactionById(Number(id));
    if (!tx) throw new FbError("Transaction not found");
    await deleteTransactionById(tx);
  }
  return true;
});

register("admin", "invoice", "batch_delete_tax", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (!ids) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const tax = await findTaxById(Number(id));
    if (!tax) throw new FbError("Tax rule not found");
    await deleteTaxRow(tax.id);
  }
  return true;
});

/* ------------------------------ promo engine ------------------------------ */

interface PromoRowFull {
  id: number; code: string | null; description: string | null; type: string | null;
  value: number | null; maxuses: number | null; used: number | null; freesetup: number;
  once_per_client: number; recurring: number; active: number; products: string | null;
  periods: string | null; client_groups: string | null; requires_products: string | null;
  start_at: string | null; end_at: string | null; auto_apply: number; priority: number | null;
  stackable: number; created_at: string | null; updated_at: string | null;
}

const PROMO_COLS_FULL = "id, code, description, type, value, maxuses, used, freesetup, once_per_client, recurring, active, products, periods, client_groups, requires_products, start_at, end_at, auto_apply, priority, stackable, created_at, updated_at";

async function findPromoRow(id: number): Promise<PromoRowFull | undefined> {
  return await getDb().prepare(`SELECT ${PROMO_COLS_FULL} FROM promo WHERE id = ?`).get(id) as PromoRowFull | undefined;
}

function decodePromoSelection(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** PHP strtotime for Y-m-d H:i:s values (server-local time, UTC here). */
function promoTime(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? null : t;
}

function promoCanBeApplied(promo: PromoRowFull): boolean {
  if (!promo.active) return false;
  const maxUses = promo.maxuses ?? 0;
  const used = promo.used ?? 0;
  if (maxUses > 0 && maxUses <= used) return false;
  const now = Date.now();
  const start = promoTime(promo.start_at);
  if (start !== null && start - now > 0) return false;
  const end = promoTime(promo.end_at);
  if (end !== null && end - now < 0) return false;
  return true;
}

async function clientGroupIds(clientId: number): Promise<number[]> {
  return ((await getDb().prepare("SELECT client_group_id FROM client_group_members WHERE client_id = ?").all(clientId)) as { client_group_id: number }[]).map((r) => r.client_group_id);
}

async function isPromoAvailableForClientGroup(promo: PromoRowFull, clientId: number | null): Promise<boolean> {
  const groups = decodePromoSelection(promo.client_groups);
  if (groups.length === 0) return true;
  if (clientId === null) return false;
  const owned = await clientGroupIds(clientId);
  if (owned.length === 0) return false;
  return owned.some((g) => groups.map(Number).includes(g));
}

async function clientHasActivePromoApplication(clientId: number, promoId: number): Promise<boolean> {
  const row = await getDb()
    .prepare("SELECT COUNT(1) AS c FROM promo_redemption WHERE promo_id = ? AND client_id = ? AND phase = 'checkout' AND status IN ('reserved', 'committed')")
    .get(promoId, clientId) as { c: number };
  return row.c > 0;
}

async function canClientUsePromo(clientId: number, promo: PromoRowFull): Promise<boolean> {
  if (!promoCanBeApplied(promo)) return false;
  if (!promo.once_per_client) return true;
  return !await clientHasActivePromoApplication(clientId, promo.id);
}

async function usePromo(promo: PromoRowFull): Promise<void> {
  const info = await getDbWrite()
    .prepare("UPDATE promo SET used = COALESCE(used, 0) + 1, updated_at = ? WHERE id = ? AND (maxuses = 0 OR maxuses IS NULL OR maxuses > COALESCE(used, 0))")
    .run(nowTimestamp(), promo.id);
  if (info.changes === 0) {
    throw new FbError("This promo code has reached its maximum number of uses.");
  }
}

function isPromoLinkedToProduct(promo: PromoRowFull, product: { id: number; is_addon: number }): boolean {
  if (product.is_addon) return false;
  const products = decodePromoSelection(promo.products);
  if (products.length === 0) return true;
  return products.map(Number).includes(product.id);
}

function isPromoApplicableToProduct(promo: PromoRowFull, product: { id: number; is_addon: number }, config: Record<string, unknown>): boolean {
  if (!isPromoLinkedToProduct(promo, product)) return false;
  if (config["period"] !== undefined) {
    const periods = decodePromoSelection(promo.periods);
    if (periods.length > 0 && !periods.map(String).includes(String(config["period"]))) return false;
  }
  return true;
}

async function getProductPriceForPromo(product: { id: number; type: string | null; product_payment_id: number | null }, config: Record<string, unknown>): Promise<number> {
  if (product.type === "domain") {
    // Domain renewal/catalog pricing lives in the TLD tables; the
    // percentage path never calls this, and absolute promos on domain
    // products are a documented gap (parity pins custom products).
    throw new FbError("Absolute promos on domain products are not supported by the TS port");
  }
  const payment = product.product_payment_id ? await findProductPayment(product.product_payment_id) : undefined;
  if (!payment) throw new FbError("Product not found");
  if (payment.type === "free") return 0;
  if (payment.type === "once") return payment.once_price ?? 0;
  if (payment.type === "recurrent") {
    const period = config["period"];
    if (period === undefined) {
      throw new FbError(`Product ${product.id} payment type is recurrent, but period was not selected`);
    }
    const row = (await listProductPeriods(payment.id)).find((p) => p.code === String(period));
    if (!row || !row.enabled) {
      throw new FbError("Selected billing period is not available for this product");
    }
    return row.price;
  }
  throw new FbError(`Product ${product.id} has an invalid pricing type. Please contact the administrator.`);
}

async function getProductDiscountForPromo(
  product: { id: number; type: string | null; product_payment_id: number | null; is_addon: number },
  promo: PromoRowFull,
  config: Record<string, unknown>,
): Promise<number> {
  if (!isPromoApplicableToProduct(promo, product, config)) return 0;
  const price = await getProductPriceForPromo(product, config);
  const quantity = Math.max(1, parseInt(String(config["quantity"] ?? 1), 10) || 1);
  const total = price * quantity;
  if (total === 0) return 0;
  if (promo.type === "absolute") return Number(promo.value ?? 0);
  if (promo.type === "percentage") return round2((total * Number(promo.value ?? 0)) / 100);
  return 0;
}

async function resolvePromoReference(code: string | undefined, id: number | undefined): Promise<PromoRowFull | null> {
  if (code !== undefined && code.trim() !== "") {
    const promo = await getDb()
      .prepare(`SELECT ${PROMO_COLS_FULL} FROM promo WHERE code = ? AND active = 1 ORDER BY id ASC LIMIT 1`)
      .get(code.trim()) as PromoRowFull | undefined;
    if (!promo) throw new FbError("The promo code has expired or does not exist");
    return promo;
  }
  if (id !== undefined && id > 0) {
    const promo = await findPromoRow(id);
    if (!promo) throw new FbError("Promo not found");
    if (!promoCanBeApplied(promo)) throw new FbError("The promo code has expired or does not exist");
    return promo;
  }
  return null;
}

async function orderBelongsToInvoice(invoiceId: number, orderId: number): Promise<boolean> {
  const order = await findOrderById(orderId);
  if (order && order.unpaid_invoice_id === invoiceId) return true;
  return (await listInvoiceItems(invoiceId)).some((it) => it.rel_id !== null && Number(it.rel_id) === orderId);
}

async function findPromoTargetOrder(invoiceId: number, orderOpt: { id: number } | null): Promise<import("../db").OrderRowFull> {
  if (orderOpt) {
    if (await orderBelongsToInvoice(invoiceId, orderOpt.id)) {
      const found = await findOrderById(orderOpt.id);
      if (found) return found;
    }
    throw new FbError("The selected order is not on this invoice");
  }
  const ids = new Set<number>();
  for (const it of await listInvoiceItems(invoiceId)) {
    if (it.type === "order" && it.rel_id !== null && /^\d+$/.test(String(it.rel_id))) ids.add(Number(it.rel_id));
  }
  for (const o of await listOrders({})) {
    if (o.unpaid_invoice_id === invoiceId) ids.add(o.id);
  }
  const list = [...ids];
  if (list.length === 0) throw new FbError("This invoice has no orders to apply the promotion to");
  if (list.length > 1) throw new FbError("This invoice covers several orders; select which order to apply the promotion to");
  const order = await findOrderById(list[0]);
  if (!order) throw new FbError("This invoice has no orders to apply the promotion to");
  return order;
}

async function getOrderLineTotal(invoiceId: number, order: { id: number; price: number; quantity: number }): Promise<number> {
  for (const it of await listInvoiceItems(invoiceId)) {
    if (it.type === "order" && it.rel_id !== null && Number(it.rel_id) === order.id) {
      return Number(it.price) * (Number(it.quantity) || 1);
    }
  }
  return Number(order.price) * (Number(order.quantity) || 1);
}

async function findOrderDiscountLine(invoiceId: number, orderId: number): Promise<{ id: number; price: number } | undefined> {
  return (await listInvoiceItems(invoiceId))
    .filter((it) => it.unit === "discount" && it.rel_id !== null && Number(it.rel_id) === orderId)
    .map((it) => ({ id: it.id, price: Number(it.price) }))[0];
}

/** PHP isInvoiceEditable: paid/refunded/canceled never; unissued always;
 * issued only when invoice immutability is relaxed (setting, or the
 * retired per-action keys as fallback). */
async function isInvoiceEditablePHP(inv: InvoiceRowFull): Promise<boolean> {
  if (["paid", "refunded", "canceled"].includes(inv.status)) return false;
  if (!inv.issued) return true;
  const mode = await getSetting("invoice_immutability");
  if (mode === null || mode === "") {
    const editUnpaid = await getSetting("invoice_allow_edit_unpaid");
    const deleteApproved = await getSetting("invoice_allow_delete_approved");
    const phpBool = (v: string | null): boolean => v !== null && v !== "" && v !== "0";
    return phpBool(editUnpaid) || phpBool(deleteApproved);
  }
  return mode === "relaxed";
}

async function insertDiscountLine(invoiceId: number, order: { id: number; title: string | null }, amount: number, taxed: boolean): Promise<void> {
  await insertInvoiceItem({
    invoice_id: invoiceId,
    type: "custom",
    rel_id: order.id,
    task: "void",
    status: "pending_payment",
    title: `Discount: ${order.title ?? ""}`,
    period: null,
    quantity: 1,
    unit: "discount",
    price: -amount,
    taxed: taxed ? 1 : 0,
  });
}

async function createPromoRedemption(
  promoId: number, clientId: number, orderId: number, invoiceId: number,
  phase: string, amount: number, currency: string | null, createdAt: string | null, status: string,
): Promise<void> {
  const now = nowTimestamp();
  await getDbWrite()
    .prepare("INSERT INTO promo_redemption (promo_id, client_id, client_order_id, invoice_id, phase, status, discount_amount, currency, committed_at, released_at, release_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)")
    .run(promoId, clientId, orderId, invoiceId, phase, status, amount, currency, createdAt ?? now, now);
}

async function releaseCheckoutPromoRedemptions(orderId: number, promoId: number, reason: string, invoiceId: number): Promise<number> {
  const db = getDb();
  const rows = await db.prepare(
    "SELECT id FROM promo_redemption WHERE client_order_id = ? AND promo_id = ? AND phase = 'checkout' AND status = 'reserved' AND invoice_id = ?",
  ).all(orderId, promoId, invoiceId) as { id: number }[];
  if (rows.length === 0) return 0;
  const now = nowTimestamp();
  const w = getDbWrite();
  for (const r of rows) {
    await w.prepare("UPDATE promo_redemption SET status = 'released', released_at = ?, release_reason = ?, updated_at = ? WHERE id = ?").run(now, reason, now, r.id);
  }
  await w.prepare("UPDATE promo SET used = MAX(COALESCE(used, 0) - ?, 0), updated_at = ? WHERE id = ?").run(rows.length, now, promoId);
  return rows.length;
}

async function resolvePromoAndOrder(ctx: CallContext): Promise<[PromoRowFull, { id: number } | null]> {
  const code = ctx.params["promo_code"];
  const promoIdRaw = ctx.params["promo_id"];
  const promo = await resolvePromoReference(
    code !== undefined ? code : undefined,
    promoIdRaw !== undefined ? Number(promoIdRaw) : undefined,
  );
  if (!promo) throw new FbError("Promo code or promo ID was not passed");
  let order: { id: number } | null = null;
  if (ctx.params["order_id"]) {
    order = await findOrderById(Number(ctx.params["order_id"])) as unknown as { id: number } | null;
  }
  return [promo, order];
}

register("admin", "invoice", "promo_add", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Invoice ID is missing");
  const inv = await findInvoiceById(Number(idRaw));
  if (!inv) throw new FbError("Invoice was not found");
  const [promo, orderOpt] = await resolvePromoAndOrder(ctx);
  if (inv.status !== "unpaid") throw new FbError("Promotions can only be applied to unpaid invoices");
  if (!await isInvoiceEditablePHP(inv)) {
    throw new FbError("This invoice can no longer be edited. Issued invoices are immutable; correct them with a credit note or a replacement invoice.");
  }
  const order = await findPromoTargetOrder(inv.id, orderOpt);
  const client = await findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  if (!promoCanBeApplied(promo)) throw new FbError("The promo code has expired or does not exist");
  if (!await isPromoAvailableForClientGroup(promo, client.id)) throw new FbError("Promo code cannot be applied to this client");
  if (!await canClientUsePromo(client.id, promo)) throw new FbError("This client has already used this promo code");
  const product = order.product_id ? await findProductById(order.product_id) : undefined;
  if (!product) throw new FbError("Product not found");
  let promoConfig: Record<string, unknown> = {};
  try {
    promoConfig = order.config ? (JSON.parse(order.config) as Record<string, unknown>) : {};
  } catch { /* keep {} */ }
  if (product.type !== "domain" && promoConfig["period"] === undefined && order.period) {
    promoConfig["period"] = order.period;
  }
  if (!isPromoApplicableToProduct(promo, product, promoConfig)) {
    throw new FbError("This promo code does not apply to the selected product or billing period");
  }
  const rateRow = order.currency ? await findCurrencyByCode(order.currency) : undefined;
  if (!rateRow) throw new FbError(`Currency rate for '${order.currency}' is not configured`);
  const rate = rateRow.conversion_rate ?? 1;
  let discountBase: number;
  if (promo.type === "percentage") {
    discountBase = round2((await getOrderLineTotal(inv.id, order) * Number(promo.value ?? 0)) / 100);
  } else {
    discountBase = await getProductDiscountForPromo(product, promo, promoConfig) * rate;
  }
  if (discountBase <= 0) throw new FbError("This promo code gives no discount on the selected order");
  // Re-checks under the (single-writer) sequence, mirroring PHP's
  // in-transaction re-checks.
  const invNow = (await findInvoiceById(inv.id))!;
  if (invNow.status !== "unpaid") throw new FbError("Promotions can only be applied to unpaid invoices");
  if (!await isInvoiceEditablePHP(invNow)) {
    throw new FbError("This invoice can no longer be edited. Issued invoices are immutable; correct them with a credit note or a replacement invoice.");
  }
  if (promo.once_per_client && await clientHasActivePromoApplication(client.id, promo.id)) {
    throw new FbError("This client has already used this promo code");
  }
  await usePromo(promo);
  const orderNow = (await findOrderById(order.id))!;
  const remaining = await getOrderLineTotal(inv.id, orderNow) - (Number(orderNow.discount) || 0);
  const amount = Math.min(discountBase, remaining);
  if (amount <= 0) throw new FbError("This promo code gives no discount on the selected order");
  const db = getDbWrite();
  const prevPromoId = orderNow.promo_id;
  if (prevPromoId === null) {
    await db.prepare("UPDATE client_order SET discount = ?, promo_id = ?, promo_recurring = ?, promo_used = 1, updated_at = ? WHERE id = ?").run(
      (Number(orderNow.discount) || 0) + amount, promo.id, promo.recurring ? 1 : 0, nowTimestamp(), order.id,
    );
  } else {
    const primary = await findPromoRow(prevPromoId);
    await db.prepare("UPDATE client_order SET discount = ?, promo_recurring = ?, promo_used = 1, updated_at = ? WHERE id = ?").run(
      (Number(orderNow.discount) || 0) + amount, primary ? (primary.recurring ? 1 : 0) : (orderNow.promo_recurring ?? 0), nowTimestamp(), order.id,
    );
  }
  const line = await findOrderDiscountLine(inv.id, order.id);
  if (line) {
    await db.prepare("UPDATE invoice_item SET price = ?, updated_at = ? WHERE id = ?").run(String(line.price - amount), nowTimestamp(), line.id);
  } else {
    await insertDiscountLine(inv.id, orderNow, amount, await isClientTaxable(client));
  }
  await createPromoRedemption(promo.id, client.id, order.id, inv.id, "checkout", amount, order.currency, orderNow.created_at, "reserved");
  return amount;
});

register("admin", "invoice", "promo_remove", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Invoice ID is missing");
  const inv = await findInvoiceById(Number(idRaw));
  if (!inv) throw new FbError("Invoice was not found");
  const [promo, orderOpt] = await resolvePromoAndOrder(ctx);
  if (inv.status !== "unpaid") throw new FbError("Promotions can only be removed from unpaid invoices");
  if (!await isInvoiceEditablePHP(inv)) {
    throw new FbError("This invoice can no longer be edited. Issued invoices are immutable; correct them with a credit note or a replacement invoice.");
  }
  const order = await findPromoTargetOrder(inv.id, orderOpt);
  const reserved = await getDb().prepare(
    "SELECT id, discount_amount FROM promo_redemption WHERE client_order_id = ? AND promo_id = ? AND phase = 'checkout' AND status = 'reserved'",
  ).all(order.id, promo.id) as { id: number; discount_amount: number }[];
  if (reserved.length === 0) throw new FbError("This promotion is not applied to the selected order");
  let amount = 0;
  for (const r of reserved) amount += Number(r.discount_amount) || 0;
  if (amount <= 0) throw new FbError("This promotion has no discount recorded on the selected order");
  const released = await releaseCheckoutPromoRedemptions(order.id, promo.id, "admin_removed", inv.id);
  if (released === 0) throw new FbError("This promotion is not applied to the selected order");
  const orderNow = (await findOrderById(order.id))!;
  const db = getDbWrite();
  await db.prepare("UPDATE client_order SET discount = ?, updated_at = ? WHERE id = ?").run(
    Math.max(0, (Number(orderNow.discount) || 0) - amount), nowTimestamp(), order.id,
  );
  const remaining = await getDb().prepare(
    "SELECT promo_id FROM promo_redemption WHERE client_order_id = ? AND phase = 'checkout' AND status IN ('reserved', 'committed') ORDER BY id ASC",
  ).all(order.id) as { promo_id: number }[];
  const remainingIds = [...new Set(remaining.map((r) => r.promo_id))];
  if (remainingIds.length === 0) {
    await db.prepare("UPDATE client_order SET promo_id = NULL, promo_recurring = 0, promo_used = 0, updated_at = ? WHERE id = ?").run(nowTimestamp(), order.id);
  } else {
    let primaryId = orderNow.promo_id;
    if (primaryId === null || !remainingIds.includes(primaryId)) primaryId = remainingIds[0];
    const primary = (await findPromoRow(primaryId))!;
    await db.prepare("UPDATE client_order SET promo_id = ?, promo_recurring = ?, promo_used = 1, updated_at = ? WHERE id = ?").run(
      primaryId, primary.recurring ? 1 : 0, nowTimestamp(), order.id,
    );
  }
  const line = await findOrderDiscountLine(inv.id, order.id);
  if (line) {
    const newPrice = line.price + amount;
    if (newPrice >= 0) {
      await db.prepare("DELETE FROM invoice_item WHERE id = ?").run(line.id);
    } else {
      await db.prepare("UPDATE invoice_item SET price = ?, updated_at = ? WHERE id = ?").run(String(newPrice), nowTimestamp(), line.id);
    }
  }
  return amount;
});

/* ------------------------------ client / guest ------------------------------ */

register("client", "invoice", "get_tax_rate", async (ctx: CallContext) => {
  requireClient(ctx);
  const client = await findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  if (!await isClientTaxable(client)) return 0;
  return (await resolveTaxForClient(client)).rate;
});

register("client", "invoice", "renewal_invoice", async (ctx: CallContext) => {
  requireClient(ctx);
  const orderIdRaw = ctx.params["order_id"];
  if (!orderIdRaw) throw new FbError("Order ID (order_id) was not passed");
  const order = await findOrderById(Number(orderIdRaw));
  if (!order || order.client_id !== ctx.session!.client!.id) throw new FbError("Order not found");
  const client = await findClientById(order.client_id);
  if (!client) throw new FbError("Client not found");
  let invoiceId: number | null = null;
  const existing = order.unpaid_invoice_id ? await findInvoiceById(order.unpaid_invoice_id) : undefined;
  if (existing && existing.status === "unpaid") {
    invoiceId = existing.id;
  } else {
    if (existing) await updateOrderRow(order.id, { unpaid_invoice_id: null });
    const price = Number(order.price) || 0;
    const quantity = Number(order.quantity) || 1;
    if (price * quantity < 0) throw new FbError("Invoices are not generated for negative amount orders.");
    // Non-domain renewal lines price from the order itself; domain
    // renewal repricing (TLD price x rate) is a documented gap.
    invoiceId = await prepareInvoice(client, [{
      title: order.title ?? "",
      price,
      quantity,
      unit: order.unit,
      period: order.period,
      taxed: await isClientTaxable(client),
      type: "order",
      rel_id: order.id,
      task: "renew",
    }], null);
    // PHP generateForOrder dues the renewal at the order's expiry, not
    // at now + invoice_due_days (prepareInvoice's default).
    if (order.expires_at) {
      await getDbWrite().prepare("UPDATE invoice SET due_at = ? WHERE id = ?").run(order.expires_at, invoiceId);
    }
    await updateOrderRow(order.id, { unpaid_invoice_id: invoiceId });
  }
  await issueInvoice(invoiceId, client, { useCredits: true });
  return (await findInvoiceById(invoiceId))!.hash;
});

register("client", "invoice", "transaction_get_list", async (ctx: CallContext) => {
  requireClient(ctx);
  const clientId = ctx.session!.client!.id;
  const p = ctx.params;
  let rows = await getDb().prepare('SELECT * FROM "transaction"').all() as unknown as TransactionRowFull[];
  {
    const kept: TransactionRowFull[] = [];
    for (const t of rows) {
      const inv = t.invoice_id ? await findInvoiceById(t.invoice_id) : undefined;
      if (!inv || inv.client_id !== clientId) continue;
      if (t.status !== "processed") continue;
      kept.push(t);
    }
    rows = kept;
  }
  if (p["invoice_hash"]) {
    const inv = await findInvoiceByHash(p["invoice_hash"]);
    rows = rows.filter((t) => inv !== undefined && t.invoice_id === inv.id);
  }
  if (p["gateway_id"]) rows = rows.filter((t) => t.gateway_id === Number(p["gateway_id"]));
  if (p["currency"]) rows = rows.filter((t) => t.currency === p["currency"]);
  if (p["type"]) rows = rows.filter((t) => t.type === p["type"]);
  if (p["txn_id"]) rows = rows.filter((t) => t.txn_id === p["txn_id"]);
  if (p["date_from"]) {
    const from = new Date(`${p["date_from"]}T00:00:00Z`).getTime();
    if (!Number.isNaN(from)) rows = rows.filter((t) => t.created_at !== null && Date.parse(t.created_at.replace(" ", "T") + "Z") >= from);
  }
  if (p["date_to"]) {
    const to = new Date(`${p["date_to"]}T23:59:59Z`).getTime();
    if (!Number.isNaN(to)) rows = rows.filter((t) => t.created_at !== null && Date.parse(t.created_at.replace(" ", "T") + "Z") <= to);
  }
  if (p["search"]) {
    const q = p["search"];
    rows = rows.filter((t) =>
      (t.note ?? "").includes(q) || String(t.invoice_id ?? "").includes(q) || (t.txn_id ?? "").includes(q) || (t.ipn ?? "").includes(q),
    );
  }
  const sortKey = p["sort"] ?? "id";
  const dir = (p["dir"] ?? "desc").toLowerCase() === "asc" ? 1 : -1;
  const keyOf = (t: TransactionRowFull): string | number => {
    switch (sortKey) {
      case "status": return t.status ?? "";
      case "currency": return t.currency ?? "";
      case "type": return t.type ?? "";
      case "txn_id": return t.txn_id ?? "";
      case "amount": return Number(t.amount) || 0;
      case "created_at": return t.created_at ?? "";
      case "updated_at": return t.updated_at ?? "";
      default: return t.id;
    }
  };
  rows = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return (a.id - b.id) * dir;
  });
  const items = await Promise.all(rows.map(async (t) => {
    const a = await transactionArray(t);
    delete a["ipn"];
    return a;
  }));
  return paginate(items, p);
});

register("guest", "invoice", "funds_enabled", async () => {
  const v = await getSetting("funds_enabled");
  // PHP (bool) of the stored value, default true when unset.
  if (v === null) return true;
  return v !== "" && v !== "0";
});

// NOTE (deliberate, documented): guest invoice payment and pdf are NOT
// registered here. payment returns adapter-generated HTML/payment data
// (Stripe/PayPal/Custom/ClientBalance adapter PHP code) that the TS
// seam cannot reproduce, and pdf is a binary Response; both stay
// PHP-served through the proxy (binary-safe since the arrayBuffer fix).
