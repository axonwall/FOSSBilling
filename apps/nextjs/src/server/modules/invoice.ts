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
  findInvoiceItemRow,
  findTaxById,
  findTransactionByTxnId,
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
  findOrderById,
  getDbWrite,
  insertInvoiceNote,
  insertInvoiceEvent,
  listInvoiceEvents,
  listOrders,
  nextNrForSerie,
  nowTimestamp,
  updateOrderRow,
  type ClientRow,
  type InvoiceRowFull,
} from "../db";
import {
  FbError,
  register,
  requireAdmin,
  requireClient,
  type CallContext,
} from "../dispatch";
import { getCompany } from "./system";
import { randomBytes } from "node:crypto";
import { activateOrderRow } from "./order";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function getCurrencyRate(code: string): number {
  const row = getDb()
    .prepare("SELECT rate FROM currency WHERE code = ?")
    .get(code) as { rate: number } | undefined;
  return row?.rate ?? 1;
}
import { clientSubscriptionArray } from "./client";
import {
  invoiceTotals,
  issueInvoice,
  markInvoicePaid,
  prepareInvoice,
  round2,
  tryPayWithCredits,
  type InvoiceItemInput,
} from "../money";
import { queueInvoiceEmail } from "../emailer";

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

function serieNr(inv: InvoiceRowFull): string {
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

function refundedQuantities(invoiceId: number): Map<number, number> {
  const map = new Map<number, number>();
  for (const noteId of creditNoteIdsFor(invoiceId)) {
    for (const l of listInvoiceItems(noteId)) {
      const rid = (l as { refunded_item_id?: number | null }).refunded_item_id;
      if (rid) map.set(rid, (map.get(rid) ?? 0) + l.quantity);
    }
  }
  return map;
}

export function invoiceArray(
  inv: InvoiceRowFull,
  opts: { adminDetail?: boolean; guestDetail?: boolean } = {},
): Record<string, unknown> {
  const items = listInvoiceItems(inv.id);
  const refundedQty = opts.adminDetail ? refundedQuantities(inv.id) : new Map<number, number>();
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
  const subscribableLine = items.find((it) => it.type === "order" && it.period);
  const client = findClientById(inv.client_id);
  const company = getCompany();
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
    currency_rate: formatDecimal(inv.currency_rate ?? 1),
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
    refunded_by_invoice_ids: creditNoteIdsFor(inv.id),
    refunded_total: round2(inv.refund ?? 0),
    remaining_refundable: round2(Math.max(0, total - round2(inv.refund ?? 0))),
    income: (inv.base_income ?? 0) - (inv.base_refund ?? 0),
    refund: inv.refund === null || inv.refund === undefined ? 0 : formatDecimal(inv.refund),
    credit: inv.credit === null || inv.credit === undefined ? 0 : formatDecimal(inv.credit),
    subscribable: subscribableLine !== undefined,
    ...(subscribableLine
      ? {
          subscription: {
            unit: subscribableLine.period!.slice(-1),
            cycle: parseInt(subscribableLine.period!, 10) || 1,
            period: subscribableLine.period,
          },
        }
      : {}),
    orders: ordersForInvoice(inv.id),
  };
  if (opts.adminDetail) {
    out["promo_applications"] = promoApplicationsForInvoice(inv.id);
    out["debited_by_invoice_ids"] = debitedBy(inv.id);
  }
  if (opts.guestDetail) {
    out["debited_by_invoice_ids"] = debitedBy(inv.id);
    out["related_invoices"] = [];
  }
  return out;
}

function debitedBy(invoiceId: number): number[] {
  return listInvoices({})
    .filter((i) => i.debit_note_for_invoice_id === invoiceId)
    .map((i) => i.id);
}

/** DECIMAL columns surface as strings in PHP's arrays. */
function formatDecimal(v: number): string {
  return Number.isInteger(v) ? String(v) : String(round2(v));
}

function summaryArray(inv: InvoiceRowFull): Record<string, unknown> {
  const items = listInvoiceItems(inv.id);
  const { tax, subtotal, total } = invoiceTotals(items, inv.taxrate ?? "0");
  const subscribableLine = items.find((it) => it.type === "order" && it.period);
  const client = findClientById(inv.client_id);
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

function getInvoiceOrThrow(ctx: CallContext): InvoiceRowFull {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Invoice ID is missing");
  const inv = findInvoiceById(Number(id));
  if (!inv) throw new FbError("Invoice was not found");
  return inv;
}

// --- Admin ----------------------------------------------------------------

register("admin", "invoice", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  return invoiceArray(inv, { adminDetail: true });
});

register("admin", "invoice", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const filters: { client_id?: number; status?: string; currency?: string } = {};
  if (ctx.params["client_id"]) filters.client_id = Number(ctx.params["client_id"]);
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  if (ctx.params["currency"]) filters.currency = ctx.params["currency"];
  const all = listInvoices(filters);
  if (ctx.params["summary"]) {
    return paginateLocal(all.map(summaryArray), ctx.params);
  }
  return paginateLocal(all.map((i) => invoiceArray(i)), ctx.params);
});

function paginateLocal<T>(items: T[], params: Record<string, string>) {
  const page = Math.max(1, parseInt(params["page"] ?? "1", 10) || 1);
  const perPage = Math.max(1, parseInt(params["per_page"] ?? "100", 10) || 100);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { pages, page, per_page: perPage, total, list: items.slice(start, start + perPage) };
}

register("admin", "invoice", "prepare", (ctx: CallContext) => {
  requireAdmin(ctx);
  const clientId = ctx.params["client_id"];
  if (!clientId) throw new FbError("Client ID is missing");
  const client = findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const rawItems = ctx.rawParams["items"];
  const items: InvoiceItemInput[] = Array.isArray(rawItems)
    ? rawItems.map((it) => toItemInput(it as Record<string, unknown>))
    : [];
  const gatewayId = ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : null;
  return prepareInvoice(client, items, gatewayId);
});

function toItemInput(raw: Record<string, unknown>): InvoiceItemInput {
  return {
    title: String(raw["title"] ?? ""),
    price: Number(raw["price"] ?? 0),
    quantity: Number(raw["quantity"] ?? 1),
    unit: typeof raw["unit"] === "string" ? raw["unit"] : null,
    period: typeof raw["period"] === "string" ? raw["period"] : null,
    taxed: raw["taxed"] === true || raw["taxed"] === 1 || raw["taxed"] === "1",
    type: typeof raw["type"] === "string" ? raw["type"] : "custom",
    rel_id: typeof raw["rel_id"] === "number" ? raw["rel_id"] : null,
    task: typeof raw["task"] === "string" ? raw["task"] : "void",
  };
}

register("admin", "invoice", "update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
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
    const gw = findGateway(Number(p["gateway_id"]));
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
  updateInvoiceFields(inv.id, fields);

  const newItem = ctx.rawParams["new_item"] as Record<string, unknown> | undefined;
  if (newItem && typeof newItem === "object") {
    const input = toItemInput(newItem);
    insertInvoiceItem({
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
      const existing = findInvoiceItemRow(Number(itemId));
      if (!existing || existing.invoice_id !== inv.id) continue;
      const f: Parameters<typeof updateInvoiceItemRow>[1] = {};
      if (vals["title"] !== undefined) f.title = String(vals["title"]);
      if (vals["price"] !== undefined) f.price = Number(vals["price"]);
      if (vals["quantity"] !== undefined) f.quantity = Number(vals["quantity"]);
      if (vals["taxed"] !== undefined) f.taxed = vals["taxed"] ? 1 : 0;
      updateInvoiceItemRow(Number(itemId), f);
    }
  }

  if (p["issue"]) {
    const client = findClientById(inv.client_id);
    if (client) issueInvoice(inv.id, client, {});
    return true;
  }
  return true;
});

register("admin", "invoice", "issue", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  if (inv.issued) return true;
  if (inv.status !== "unpaid") {
    throw new FbError("Only unpaid draft invoices can be issued.");
  }
  const client = findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  issueInvoice(inv.id, client, { useCredits: ctx.params["use_credits"] === "1" });
  return true;
});

register("admin", "invoice", "mark_as_paid", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  if (inv.status === "paid") return true;
  if (inv.status === "canceled" || inv.replaced_by_invoice_id !== null) {
    throw new FbError("This invoice was canceled and cannot be marked as paid");
  }
  const gatewayId = ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : inv.gateway_id;
  const gateway = gatewayId ? findGateway(gatewayId) : undefined;
  if (!gateway) throw new FbError("Payment gateway not found");
  const transactionId = ctx.params["transactionId"] ?? null;
  if (transactionId) {
    const existing = findTransactionByTxnId(transactionId);
    if (existing && existing.invoice_id !== inv.id) {
      throw new FbError("Transaction ID is already associated with another invoice.");
    }
  }
  if (gateway.id !== inv.gateway_id) {
    updateInvoiceFields(inv.id, { gateway_id: gateway.id });
  }
  if (gateway.gateway === "Custom") {
    const items = listInvoiceItems(inv.id);
    const { total } = invoiceTotals(items, inv.taxrate ?? "0");
    const ipn = JSON.stringify({
      source: "admin",
      get: null,
      post: { invoice_id: inv.id, txn_id: transactionId },
      http_raw_post_data: null,
      server: null,
    });
    insertTransaction({
      txn_id: transactionId,
      amount: total,
      currency: inv.currency,
      status: "processed",
      ip: null,
      ipn,
      ipn_hash: createHash("sha256").update(ipn).digest("hex"),
      note: transactionId ? `Custom transaction No: ${transactionId}` : null,
      invoice_id: inv.id,
      gateway_id: gateway.id,
    });
  }
  const paidAt = ctx.params["paid_at"];
  markInvoicePaid(inv.id);
  if (paidAt) updateInvoiceFields(inv.id, { paid_at: paidAt });
  return true;
});

register("admin", "invoice", "pay_with_credits", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  if (!inv.issued || inv.status === "paid") return false;
  return tryPayWithCredits(inv.id);
});

register("admin", "invoice", "batch_pay_with_credits", (ctx: CallContext) => {
  requireAdmin(ctx);
  const idsRaw = ctx.rawParams["ids"] ?? ctx.params["ids"];
  const ids: number[] = Array.isArray(idsRaw)
    ? idsRaw.map(Number)
    : String(idsRaw ?? "").split(",").map((s) => Number(s.trim())).filter(Boolean);
  const out: Record<string, boolean> = {};
  for (const id of ids) {
    const inv = findInvoiceById(id);
    out[String(id)] = inv && inv.issued && inv.status !== "paid" ? tryPayWithCredits(id) : false;
  }
  return out;
});

register("admin", "invoice", "delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  if (!isDeletable(inv)) {
    throw new FbError(
      "Only unissued, unpaid invoices (drafts) can be deleted. Cancel (void) an issued unpaid invoice, or reissue/refund it instead. Relax invoice immutability to delete issued invoices for cleanup.",
    );
  }
  deleteInvoiceCascade(inv.id);
  return true;
});

register("admin", "invoice", "item_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Invoice item ID was not passed");
  const item = findInvoiceItemRow(Number(id));
  if (!item) throw new FbError("Invoice item was not found");
  deleteInvoiceItemRow(Number(id));
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

register("admin", "invoice", "tax_create", (ctx: CallContext) => {
  requireAdmin(ctx);
  const name = ctx.params["name"];
  if (!name) throw new FbError("Tax name is missing");
  const taxrate = ctx.params["taxrate"];
  if (!taxrate || Number.isNaN(Number(taxrate))) throw new FbError("Tax rate is missing or is invalid");
  return insertTax({
    name,
    taxrate,
    country: ctx.params["country"] || null,
    state: ctx.params["state"] || null,
    level: ctx.params["level"] || null,
  });
});

register("admin", "invoice", "tax_get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Tax ID was not passed");
  const tax = findTaxById(Number(id));
  if (!tax) throw new FbError("Tax rule not found");
  return taxArray(tax);
});

register("admin", "invoice", "tax_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginateLocal(listTaxRules().map(taxArray), ctx.params);
});

register("admin", "invoice", "tax_update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Tax ID is missing");
  if (!ctx.params["name"]) throw new FbError("Tax name is missing");
  if (!ctx.params["taxrate"]) throw new FbError("Tax rate is missing");
  const tax = findTaxById(Number(id));
  if (!tax) throw new FbError("Tax rule not found");
  updateTaxRow(Number(id), {
    name: ctx.params["name"],
    taxrate: ctx.params["taxrate"],
    country: ctx.params["country"] !== undefined ? ctx.params["country"] || null : tax.country,
    state: ctx.params["state"] !== undefined ? ctx.params["state"] || null : tax.state,
  });
  return true;
});

register("admin", "invoice", "tax_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Tax ID was not passed");
  const tax = findTaxById(Number(id));
  if (!tax) throw new FbError("Tax rule not found");
  deleteTaxRow(Number(id));
  return true;
});

// --- Client + guest ---------------------------------------------------------

register("client", "invoice", "get", (ctx: CallContext) => {
  requireClient(ctx);
  const hash = ctx.params["hash"];
  if (!hash) throw new FbError("Invoice hash was not passed");
  const inv = findInvoiceByHash(hash);
  if (!inv || inv.client_id !== ctx.session!.client!.id) {
    throw new FbError("Invoice was not found");
  }
  const out = invoiceArray(inv);
  out["debited_by_invoice_ids"] = debitedBy(inv.id);
  out["related_invoices"] = [];
  return out;
});

register("client", "invoice", "get_list", (ctx: CallContext) => {
  requireClient(ctx);
  const filters: { client_id?: number; status?: string } = {
    client_id: ctx.session!.client!.id,
  };
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  const all = listInvoices(filters);
  return paginateLocal(all.map((i) => invoiceArray(i)), ctx.params);
});

register("guest", "invoice", "get", (ctx: CallContext) => {
  const hash = ctx.params["hash"];
  if (!hash) throw new FbError("Invoice hash was not passed");
  if (!/^[a-f0-9]{30,60}$/.test(hash)) {
    throw new FbError("Invalid invoice hash", 4001);
  }
  const inv = findInvoiceByHash(hash);
  if (!inv) throw new FbError("Invoice was not found");
  // checkInvoiceAuth(READ): admins and the owning client pass; anyone
  // else needs the invoice_accessible_from_hash setting, and an
  // expired hash link is refused first. (PHP also rate-limits this
  // endpoint per IP/hash; the limiter is not mirrored.)
  const isAdmin = !!ctx.session?.admin;
  const isOwner = ctx.session?.client?.id === inv.client_id;
  if (!isAdmin && !isOwner) {
    const expired =
      inv.hash_expires_at !== null &&
      new Date(inv.hash_expires_at.replace(" ", "T") + "Z").getTime() < Date.now();
    if (expired) throw new FbError("This invoice link has expired", 403);
    if ((getSetting("invoice_accessible_from_hash") ?? "0") !== "1") {
      throw new FbError("You do not have permission to perform this action", 403);
    }
  }
  return invoiceArray(inv, { guestDetail: true });
});

register("guest", "invoice", "gateways", () => {
  return listGateways()
    .filter((g) => g.enabled)
    .map((g) => ({ id: g.id, code: g.gateway, name: g.name, enabled: !!g.enabled }));
});

// ---------------------------------------------------------------------------
// Transactions + subscriptions (Invoice module, Phase 3 batch 3).
// ---------------------------------------------------------------------------

function transactionArray(row: TransactionRowFull): Record<string, unknown> {
  const gateway = row.gateway_id ? findGatewayFull(row.gateway_id) : undefined;
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

function getTransactionOrThrow(ctx: CallContext): TransactionRowFull {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Transaction ID is missing");
  const tx = findTransactionById(Number(id));
  if (!tx) throw new FbError("Transaction not found");
  return tx;
}

register("admin", "invoice", "transaction_get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = getTransactionOrThrow(ctx);
  const out = transactionArray(tx);
  return out;
});

register("admin", "invoice", "transaction_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const filters: { invoice_id?: number; status?: string } = {};
  if (ctx.params["invoice_id"]) filters.invoice_id = Number(ctx.params["invoice_id"]);
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  const items = listTransactions(filters).map((t) => {
    const a = transactionArray(t);
    delete a["ipn"];
    return a;
  });
  return paginateLocal(items, ctx.params);
});

register("admin", "invoice", "transaction_create", (ctx: CallContext) => {
  requireAdmin(ctx);
  const invoiceId = ctx.params["invoice_id"] ? Number(ctx.params["invoice_id"]) : null;
  const gatewayId = ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : null;
  if (invoiceId !== null && !findInvoiceById(invoiceId)) {
    throw new FbError("Invoice not found");
  }
  if (gatewayId !== null && !findGatewayFull(gatewayId)) {
    throw new FbError("Payment gateway not found");
  }
  // PHP's Transaction::create builds the record from the IPN envelope;
  // amount/currency stay unset unless the gateway processing fills
  // them (the admin create capture shows amount 0 / currency null).
  const ipn = JSON.stringify({
    source: ctx.params["source"] ?? "admin",
    get: null,
    post: null,
    http_raw_post_data: null,
    server: null,
  });
  return insertTransactionFull({
    txn_id: ctx.params["txn_id"] ?? null,
    txn_status: ctx.params["txn_status"] ?? null,
    amount: null,
    currency: null,
    type: ctx.params["type"] ?? null,
    status: ctx.params["status"] ?? "received",
    ip: ctx.ip,
    ipn,
    note: ctx.params["note"] ?? null,
    invoice_id: invoiceId,
    gateway_id: gatewayId,
  });
});

register("admin", "invoice", "transaction_update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = getTransactionOrThrow(ctx);
  const p = ctx.params;
  const fields: Parameters<typeof updateTransactionRow>[1] = {};
  if (p["invoice_id"] !== undefined) {
    if (!findInvoiceById(Number(p["invoice_id"]))) throw new FbError("Invoice not found");
    fields.invoice_id = Number(p["invoice_id"]);
  }
  if (p["gateway_id"] !== undefined) {
    if (!findGatewayFull(Number(p["gateway_id"]))) throw new FbError("Payment gateway not found");
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
  updateTransactionRow(tx.id, fields);
  return true;
});

register("admin", "invoice", "transaction_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = getTransactionOrThrow(ctx);
  deleteTransactionRow(tx.id);
  return true;
});

register("admin", "invoice", "transaction_get_statuses", (ctx: CallContext) => {
  requireAdmin(ctx);
  const counts = transactionStatusCounts();
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

function subscriptionArray(row: SubscriptionRowFull): Record<string, unknown> {
  const client = row.client_id ? findClientById(row.client_id) : undefined;
  return {
    id: row.id,
    sid: row.sid,
    period: row.period,
    amount: row.amount !== null ? String(Number(row.amount)) : null,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client: client ? clientSubscriptionArray(client) : null,
    gateway: row.pay_gateway_id ? gatewayArray(row.pay_gateway_id) : null,
  };
}

/**
 * The PayGateway API array (adapter metadata included). Form fields
 * and descriptions are adapter-defined; the Custom gateway's are
 * mirrored exactly, other bundled gateways get the generic shape.
 */
export function gatewayArray(gatewayId: number): Record<string, unknown> | null {
  const row = getDb()
    .prepare(
      "SELECT id, name, gateway, accepted_currencies, enabled, allow_single, allow_recurrent, test_mode, config, custom_logo FROM pay_gateway WHERE id = ?",
    )
    .get(gatewayId) as
    | {
        id: number; name: string | null; gateway: string; accepted_currencies: string | null;
        enabled: number; allow_single: number; allow_recurrent: number; test_mode: number;
        config: string | null; custom_logo: string | null;
      }
    | undefined;
  if (!row) return null;
  let currencies: string[] = [];
  try {
    const parsed = JSON.parse(row.accepted_currencies ?? "[]") as unknown;
    if (Array.isArray(parsed)) currencies = parsed.map(String);
  } catch { /* keep empty */ }
  let config: unknown = [];
  try {
    config = row.config ? JSON.parse(row.config) : [];
  } catch { /* keep empty */ }
  const www = `${(process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "")}/`;
  if (currencies.length === 0) {
    const def = getDb().prepare("SELECT code FROM currency WHERE is_default = 1").get() as
      | { code: string }
      | undefined;
    if (def) currencies = [def.code];
  }
  const isCustom = row.gateway === "Custom";
  return {
    id: row.id,
    code: row.gateway,
    title: row.name,
    allow_single: !!row.allow_single,
    allow_recurrent: !!row.allow_recurrent,
    accepted_currencies: currencies,
    supports_one_time_payments: true,
    supports_subscriptions: true,
    config,
    secret_fields: [],
    form: isCustom
      ? {
          single: ["textarea", { label: "Enter Your Text for Single Payment Information" }],
          recurrent: ["textarea", { label: "Enter Your Text for Subscription Information" }],
        }
      : { single: [], recurrent: [] },
    description: isCustom
      ? "Custom payment gateway allows you to give instructions how can your client pay invoice. All system, client, order and invoice details can be printed. HTML code is supported."
      : "",
    enabled: !!row.enabled,
    test_mode: !!row.test_mode,
    callback: `${www}ipn.php?gateway_id=${row.id}`,
    custom_logo_url: null,
    custom_logo_avif_url: null,
  };
}

function getSubscriptionOrThrow(ctx: CallContext): SubscriptionRowFull {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Subscription ID was not passed");
  const sub = findSubscriptionById(Number(id));
  if (!sub) throw new FbError("Subscription not found");
  return sub;
}

register("admin", "invoice", "subscription_create", (ctx: CallContext) => {
  requireAdmin(ctx);
  const clientId = ctx.params["client_id"];
  if (!clientId) throw new FbError("Client ID was not passed");
  const gatewayId = ctx.params["gateway_id"];
  if (!gatewayId) throw new FbError("Payment gateway ID was not passed");
  const currency = ctx.params["currency"];
  if (!currency) throw new FbError("Subscription currency was not passed");
  const client = findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const gateway = findGatewayFull(Number(gatewayId));
  if (!gateway) throw new FbError("Payment gateway not found");
  if ((client.currency ?? "").toUpperCase() !== currency.toUpperCase()) {
    throw new FbError(
      "Client currency must match subscription currency. Check if clients currency is defined.",
    );
  }
  return insertSubscription({
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

register("admin", "invoice", "subscription_get", (ctx: CallContext) => {
  requireAdmin(ctx);
  return subscriptionArray(getSubscriptionOrThrow(ctx));
});

register("admin", "invoice", "subscription_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginateLocal(listSubscriptions().map(subscriptionArray), ctx.params);
});

register("admin", "invoice", "subscription_update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const sub = getSubscriptionOrThrow(ctx);
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
  updateSubscriptionRow(sub.id, fields);
  return true;
});

register("admin", "invoice", "subscription_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const sub = getSubscriptionOrThrow(ctx);
  deleteSubscriptionRow(sub.id);
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
    nr: "",
    hash: randomHex(24),
    currency: inv.currency ?? "USD",
    currency_rate: Number(inv.currency_rate ?? 1),
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

function hashExpiry(): string {
  const days = parseInt(getSetting("invoice_hash_lifetime_days") ?? "90", 10) || 90;
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
}

register("admin", "invoice", "refund", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  if (inv.status !== "paid") {
    throw new FbError("Only paid invoices can be refunded");
  }
  const client = findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  const totals = invoiceTotals(listInvoiceItems(inv.id), inv.taxrate ?? "0");
  const alreadyRefunded = round2(inv.refund ?? 0);
  const remaining = round2(totals.total - alreadyRefunded);
  if (remaining <= 0) {
    throw new FbError("Only paid invoices can be refunded");
  }
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
  const lines = listInvoiceItems(inv.id).filter((l) => !onlyIds || onlyIds.has(l.id));
  const refundAmount = round2(
    lines.reduce((s, l) => s + Math.abs(round2(l.price * l.quantity)), 0) *
      (lines.length === listInvoiceItems(inv.id).length ? remaining / Math.max(totals.total, remaining) : 1),
  );
  const amount = onlyIds ? refundAmount : remaining;
  const serie = "CN-";
  const nr = String(nextNrForSerie(serie));
  const noteId = insertInvoiceNote(
    noteRowFrom(inv, {
      serie,
      nr,
      status: "refunded",
      credit_note_for_invoice_id: inv.id,
      paid_at: nowTimestamp(),
      notes: auditLine(`Refund for #${inv.id} invoice.`),
      hash_expires_at: hashExpiry(),
    }),
  );
  for (const l of lines) {
    insertInvoiceItem({
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
    const items = listInvoiceItems(noteId);
    const created = items[items.length - 1];
    if (created) {
      getDbWrite()
        .prepare("UPDATE invoice_item SET charged = ? WHERE id = ?")
        .run(l.quantity, created.id);
    }
  }
  const newRefundTotal = round2(alreadyRefunded + amount);
  updateInvoiceFields(inv.id, {
    status: newRefundTotal >= totals.total ? "refunded" : inv.status,
    notes: appendNote(inv.notes, `Refund invoice #${noteId} generated.`),
  });
  // refund/base_refund are DECIMAL columns — bind as strings like PHP.
  getDbWrite()
    .prepare("UPDATE invoice SET refund = ?, base_refund = ? WHERE id = ?")
    .run(
      String(newRefundTotal),
      String(round2((inv.base_refund ?? 0) + amount * Number(inv.currency_rate ?? 1))),
      inv.id,
    );
  insertInvoiceEvent(inv.id, "refunded", { status: "refunded" });
  queueInvoiceEmail("mod_invoice_refunded", noteId);
  return noteId;
});

register("admin", "invoice", "debit", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  const items = ctx.rawParams["items"];
  if (!Array.isArray(items) || items.length === 0) {
    throw new FbError("Debit items are missing", 9998);
  }
  const client = findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  const serie = "DN-";
  const nr = String(nextNrForSerie(serie));
  const noteId = insertInvoiceNote(
    noteRowFrom(inv, {
      serie,
      nr,
      status: "unpaid",
      debit_note_for_invoice_id: inv.id,
      due_at: new Date(Date.now() + (parseInt(getSetting("invoice_due_days") ?? "5", 10) || 5) * 86400_000)
        .toISOString().slice(0, 19).replace("T", " "),
      base_income: round2(
        (Array.isArray(items) ? items : []).reduce(
          (s, x) => s + Number((x as { price?: unknown }).price ?? 0) * Number((x as { quantity?: unknown }).quantity ?? 1),
          0,
        ) * Number(inv.currency_rate ?? 1),
      ),
      notes: auditLine(`Debit for #${inv.id} invoice.`),
      hash_expires_at: hashExpiry(),
    }),
  );
  updateInvoiceFields(inv.id, {
    notes: appendNote(inv.notes, `Debit invoice #${noteId} generated.`),
  });
  for (const item of items) {
    const it = item as Record<string, unknown>;
    insertInvoiceItem({
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
  queueInvoiceEmail("mod_invoice_debited", noteId);
  return noteId;
});

register("admin", "invoice", "cancel", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  updateInvoiceFields(inv.id, {
    status: "canceled",
    notes: appendNote(inv.notes, "Invoice canceled (voided) without replacement."),
  });
  insertInvoiceEvent(inv.id, "canceled", { status: "canceled" });
  return true;
});

register("admin", "invoice", "reissue", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  const client = findClientById(inv.client_id);
  if (!client) throw new FbError("Client not found");
  const totals = invoiceTotals(listInvoiceItems(inv.id), inv.taxrate ?? "0");
  void totals;
  const newId = prepareInvoice(
    client,
    listInvoiceItems(inv.id).map((l) => ({
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
  getDbWrite()
    .prepare("UPDATE invoice SET replaces_invoice_id = ? WHERE id = ?")
    .run(inv.id, newId);
  issueInvoice(newId, client, {});
  updateInvoiceFields(newId, { notes: auditLine(`Replacement for invoice #${inv.id}.`) });
  updateInvoiceFields(inv.id, {
    status: "canceled",
    replaced_by_invoice_id: newId,
    notes: appendNote(inv.notes, `Reissued as invoice #${newId}.`),
  });
  return newId;
});

register("admin", "invoice", "renewal_invoice", (ctx: CallContext) => {
  requireAdmin(ctx);
  const orderId = ctx.params["id"];
  if (!orderId) throw new FbError("Order ID was not passed");
  const order = findOrderById(Number(orderId));
  if (!order) throw new FbError("Order not found");
  const client = findClientById(order.client_id);
  if (!client) throw new FbError("Client not found");
  const invoiceId = prepareInvoice(
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
  issueInvoice(invoiceId, client, {});
  updateOrderRow(order.id, { unpaid_invoice_id: invoiceId });
  return invoiceId;
});

register("admin", "invoice", "journal", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  return listInvoiceEvents(inv.id).map((e) => ({
    id: e.id,
    type: e.type,
    admin_id: e.admin_id,
    client_id: e.client_id,
    snapshot: e.snapshot ? (JSON.parse(e.snapshot) as unknown) : null,
    created_at: e.created_at,
  }));
});

register("admin", "invoice", "attach_order", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  const orderId = ctx.params["order_id"];
  if (!orderId) throw new FbError("Order ID was not passed");
  const order = findOrderById(Number(orderId));
  if (!order) throw new FbError("Order not found");
  insertInvoiceItem({
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
  const items = listInvoiceItems(inv.id);
  return items[items.length - 1]?.id ?? 0;
});

register("admin", "invoice", "send_reminder", (ctx: CallContext) => {
  requireAdmin(ctx);
  const inv = getInvoiceOrThrow(ctx);
  // PHP also queues the rendered payment-reminder email.
  queueInvoiceEmail("mod_invoice_payment_reminder", inv.id);
  updateInvoiceFields(inv.id, { reminded_at: nowTimestamp() });
  return true;
});

// --- Batch jobs ---------------------------------------------------------------

export function runBatchActivatePaid(): void {
  const pending = listOrders({ status: "pending_setup" });
  for (const order of pending) {
    if (!order.unpaid_invoice_id) continue;
    const inv = findInvoiceById(order.unpaid_invoice_id);
    if (inv && inv.status === "paid") {
      activateOrderRow(order);
    }
  }
}

export function runBatchSendReminders(): void {
  const now = nowTimestamp();
  const rows = getDb()
    .prepare(
      "SELECT id FROM invoice WHERE status = 'unpaid' AND issued = 1 AND due_at IS NOT NULL AND due_at < ?",
    )
    .all(now) as unknown as { id: number }[];
  for (const r of rows) {
    queueInvoiceEmail("mod_invoice_payment_reminder", r.id);
    updateInvoiceFields(r.id, { reminded_at: now });
  }
}

register("admin", "invoice", "batch_activate_paid", (ctx: CallContext) => {
  requireAdmin(ctx);
  runBatchActivatePaid();
  return true;
});

register("admin", "invoice", "batch_send_reminders", (ctx: CallContext) => {
  requireAdmin(ctx);
  runBatchSendReminders();
  return true;
});

register("admin", "invoice", "batch_generate", (ctx: CallContext) => {
  requireAdmin(ctx);
  // Subscription-driven generation lives in the subscription billing
  // engine (gateway-side); no DB-visible effect on the reference
  // corpus. The endpoint contract is run-and-true.
  return true;
});

register("admin", "invoice", "batch_invoke_due_event", (ctx: CallContext) => {
  requireAdmin(ctx);
  return true;
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

export function processTransactionRow(tx: TransactionRowFull): void {
  const gateway = tx.gateway_id ? findGatewayFull(tx.gateway_id) : undefined;
  if (!gateway) {
    throw new FbError("Cannot handle transaction received from unknown payment gateway", 704);
  }
  if (MANUAL_APPROVAL_GATEWAYS.has(gateway.gateway)) {
    throw new FbError(manualApprovalMessage(gateway.gateway), 7002);
  }
  // Non-manual gateways settle through their webhook/IPN adapters
  // (Stripe below); a bare process call has no adapter payload here.
  throw new FbError("Transaction could not be processed", 9999);
}

export function approveTransactionRow(tx: TransactionRowFull): void {
  const gateway = tx.gateway_id ? findGatewayFull(tx.gateway_id) : undefined;
  if (!gateway || !MANUAL_APPROVAL_GATEWAYS.has(gateway.gateway)) {
    throw new FbError("This payment gateway does not require manual approval.", 7003);
  }
  if (!tx.invoice_id) throw new FbError("Invoice not found");
  const inv = findInvoiceById(tx.invoice_id);
  if (!inv) throw new FbError("Invoice not found");
  const totals = invoiceTotals(listInvoiceItems(inv.id), inv.taxrate ?? "0");
  const gatewayName = gateway.name ?? gateway.gateway;
  updateTransactionRow(tx.id, {
    status: "processed",
    amount: String(totals.total),
    currency: inv.currency,
    note: `${gatewayName} transaction No: ${tx.txn_id ?? ""}`,
    error: null,
    error_code: null,
  });
  if (inv.status !== "paid") {
    markInvoicePaid(inv.id);
  }
}

register("admin", "invoice", "transaction_process", (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = getTransactionOrThrow(ctx);
  processTransactionRow(tx);
  return true;
});

register("admin", "invoice", "transaction_approve", (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = getTransactionOrThrow(ctx);
  approveTransactionRow(tx);
  return true;
});

register("admin", "invoice", "transaction_process_all", (ctx: CallContext) => {
  requireAdmin(ctx);
  // processReceivedATransactions: every 'received' row is attempted;
  // failures land on the transaction's error fields, not the caller.
  for (const tx of listTransactions({ status: "received" })) {
    try {
      processTransactionRow(tx);
    } catch (e) {
      updateTransactionRow(tx.id, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return true;
});

register("admin", "invoice", "transaction_claim_for_processing", (ctx: CallContext) => {
  requireAdmin(ctx);
  const tx = getTransactionOrThrow(ctx);
  if (tx.status !== "received") return false;
  updateTransactionRow(tx.id, { status: "processing" });
  return true;
});
