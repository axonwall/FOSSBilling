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

export function invoiceArray(
  inv: InvoiceRowFull,
  opts: { adminDetail?: boolean; guestDetail?: boolean } = {},
): Record<string, unknown> {
  const items = listInvoiceItems(inv.id);
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
    ...(opts.adminDetail ? { remaining_quantity: it.quantity ?? 1 } : {}),
  }));
  const { tax, subtotal, total } = invoiceTotals(items, inv.taxrate ?? "0");
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
    refunded_by_invoice_ids: [],
    refunded_total: round2(inv.refund ?? 0),
    remaining_refundable: round2(Math.max(0, total - round2(inv.refund ?? 0))),
    income: (inv.base_income ?? 0) - (inv.base_refund ?? 0),
    refund: inv.refund ?? 0,
    credit: inv.credit ?? 0,
    subscribable: false,
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
