import { randomBytes } from "node:crypto";
import {
  clientBalanceSum,
  findClientById,
  findSettingValue,
  findTaxRule,
  findTaxRuleByCountry,
  findGlobalTaxRule,
  insertBalanceRow,
  insertInvoice,
  insertInvoiceEvent,
  insertInvoiceItem,
  invoiceNrExists,
  listInvoiceItems,
  maxInvoiceNr,
  nowTimestamp,
  setSettingValue,
  updateInvoiceRow,
  findCurrencyByCode,
  findInvoiceRow,
  getDbWrite,
  type ClientRow,
} from "./db";
import { getCompany } from "./modules/system";

/**
 * Invoice core (Phase 3) — the shared money semantics the Cart checkout
 * needs now and the Invoice module port builds on next: tax resolution,
 * totals, prepare/issue, credit payment. Mirrors
 * src/modules/Invoice/Service.php + the Tax service, verified against
 * the fixture corpus (docs/nextjs-strangler/phase3/fixtures).
 *
 * Rounding: money is rounded to cents per item tax, matching PHP's
 * ServiceInvoiceItem::getTax / getTotal arithmetic on the fixture set.
 */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Client\Service::isClientTaxable — the tax_enabled gate + tax_exempt. */
export function isClientTaxable(client: ClientRow): boolean {
  const enabled = findSettingValue("tax_enabled");
  if (!enabled || enabled === "0") return false;
  return !client.tax_exempt;
}

/**
 * Tax rate resolution (Invoice Tax service): state+country rule wins,
 * then any rule for the country, then the global rule, else 0. The
 * stored rate is a PERCENTAGE (21 = 21%) — see money-map.md.
 */
export function resolveTaxForClient(client: ClientRow): { rate: string; name: string } {
  if (!isClientTaxable(client)) return { rate: "0", name: "" };
  const country = client.country ?? null;
  const state = client.state ?? null;
  let rule = undefined;
  if (state !== null && country !== null) rule = findTaxRule(state, country);
  if (!rule && country !== null) rule = findTaxRuleByCountry(country);
  if (!rule) rule = findGlobalTaxRule();
  if (!rule) return { rate: "0", name: "" };
  return { rate: String(rule.taxrate), name: rule.name ?? "" };
}

export interface InvoiceItemInput {
  title: string;
  price: number;
  quantity: number;
  unit?: string | null;
  period?: string | null;
  taxed: boolean;
  type?: string;
  rel_id?: number | null;
  task?: string;
}

/** Invoice totals exactly as the PHP `get` array computes them. */
export function invoiceTotals(
  items: { price: number; quantity: number; taxed: number | boolean }[],
  taxrate: string,
): { subtotal: number; tax: number; total: number } {
  const rate = parseFloat(taxrate || "0");
  let subtotal = 0;
  let tax = 0;
  for (const it of items) {
    const line = it.price * it.quantity;
    subtotal += line;
    if (it.taxed) tax += round2((line * rate) / 100);
  }
  subtotal = round2(subtotal);
  tax = round2(tax);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

/** reserveNextNumericParamValue('invoice_starting_number') + max guard. */
export function nextInvoiceNumber(serie: string | null): string {
  const raw = findSettingValue("invoice_starting_number");
  let candidate = raw ? parseInt(raw, 10) : 1;
  if (!Number.isFinite(candidate) || candidate < 1) candidate = 1;
  if (invoiceNrExists(serie, String(candidate))) {
    candidate = maxInvoiceNr(serie) + 1;
  }
  setSettingValue("invoice_starting_number", String(candidate + 1));
  return String(candidate);
}

/**
 * Invoice\Service::prepareInvoice — creates the DRAFT (status unpaid,
 * issued = 0, nr claimed later at issuance), freezing currency, tax
 * rate/name, serie and hash. Items start pending_payment and move
 * to pending_setup when the invoice is paid.
 */
export function prepareInvoice(
  client: ClientRow,
  items: InvoiceItemInput[],
  gatewayId: number | null,
): number {
  const serie = findSettingValue("invoice_series");
  const tax = resolveTaxForClient(client);
  const dueDaysRaw = findSettingValue("invoice_due_days");
  const dueDays = dueDaysRaw ? parseInt(dueDaysRaw, 10) : 5;
  const due = new Date(Date.now() + dueDays * 86400_000);
  const dueAt = due.toISOString().slice(0, 19).replace("T", " ");
  const hashLifetimeRaw = findSettingValue("invoice_hash_lifetime_days");
  const hashDays = hashLifetimeRaw ? parseInt(hashLifetimeRaw, 10) : 90;
  const hashExpires = new Date(Date.now() + hashDays * 86400_000)
    .toISOString().slice(0, 19).replace("T", " ");
  const currency = client.currency ?? "USD";
  const currencyRate = findCurrencyByCode(currency)?.conversion_rate ?? 1;
  const id = insertInvoice({
    client_id: client.id,
    serie,
    nr: "",
    hash: randomBytes(24).toString("hex"),
    hash_expires_at: hashExpires,
    currency,
    currency_rate: currencyRate,
    credit: 0,
    status: "unpaid",
    taxname: tax.name,
    taxrate: tax.rate,
    gateway_id: gatewayId,
    due_at: dueAt,
    notes: findSettingValue("invoice_default_note"),
  });
  for (const it of items) {
    insertInvoiceItem({
      invoice_id: id,
      type: it.type ?? "custom",
      rel_id: it.rel_id ?? null,
      task: it.task ?? "void",
      status: "pending_payment",
      title: it.title,
      period: it.period ?? null,
      quantity: it.quantity,
      unit: it.unit ?? null,
      price: it.price,
      taxed: it.taxed ? 1 : 0,
    });
  }
  return id;
}

/** Freeze buyer (client) + seller (company) onto the invoice, as PHP
 * does once at issuance. */
function snapshotParties(invoiceId: number, client: ClientRow): void {
  const company = getCompany();
  const address = [client.address_1, client.address_2].filter(Boolean).join(" ") || null;
  updateInvoiceRow(invoiceId, {
    buyer_first_name: client.first_name,
    buyer_last_name: client.last_name,
    buyer_company: client.company,
    buyer_company_vat: client.company_vat,
    buyer_company_number: client.company_number,
    buyer_address: address,
    buyer_city: client.city,
    buyer_state: client.state,
    buyer_country: client.country,
    buyer_zip: client.postcode,
    buyer_phone: client.phone
      ? [client.phone_cc, client.phone].filter(Boolean).join(" ")
      : null,
    buyer_email: client.email,
    seller_company: company.name,
    seller_company_vat: company.vat_number,
    seller_company_number: company.number,
    seller_address: [company.address_1, company.address_2, company.address_3]
      .filter(Boolean)
      .join(" ") || null,
    seller_phone: company.tel,
    seller_email: company.email,
  });
}

/**
 * Invoice\Service::issueInvoice — claims the number, snapshots the
 * parties, marks issued, writes the journal event, then optionally
 * pays from the client's credit balance.
 */
export function issueInvoice(
  invoiceId: number,
  client: ClientRow,
  opts: { useCredits?: boolean } = {},
): void {
  snapshotParties(invoiceId, client);
  const serie = findSettingValue("invoice_series");
  const nr = nextInvoiceNumber(serie);
  getDbWrite()
    .prepare("UPDATE invoice SET serie = ?, nr = ?, issued = 1, updated_at = ? WHERE id = ?")
    .run(serie, nr, nowTimestamp(), invoiceId);
  insertInvoiceEvent(invoiceId, "issued", {
    serie_nr: `${serie ?? ""}${nr}`,
    status: "unpaid",
    issued: true,
  });
  if (opts.useCredits) tryPayWithCredits(invoiceId);
}

/** Invoice\Service::tryPayWithCredits + markAsPaid(charge: false). */
export function tryPayWithCredits(invoiceId: number): boolean {
  const items = listInvoiceItems(invoiceId);
  const { total } = invoiceTotals(items, currentTaxrate(invoiceId));
  if (total <= 0) return false;
  const clientId = currentClientId(invoiceId);
  if (clientId === null) return false;
  const balance = clientBalanceSum(clientId);
  if (round2(balance) < round2(total)) return false;
  const nr = currentNr(invoiceId);
  insertBalanceRow({
    client_id: clientId,
    type: "invoice",
    rel_id: invoiceId,
    amount: -total,
    description: `Payment for invoice #${nr ?? invoiceId} using account credit.`,
  });
  markInvoicePaid(invoiceId);
  return true;
}

export function markInvoicePaid(invoiceId: number): void {
  // PHP records base_income (total converted at the invoice's frozen
  // rate) when an invoice is paid, and moves items from
  // pending_payment to pending_setup (awaiting execution). The
  // charged amounts stay untouched on the admin/Custom path — they
  // are written when item tasks actually execute.
  const row = findInvoiceRow(invoiceId);
  const rate = Number(row?.["currency_rate"] ?? 1) || 1;
  const { total } = invoiceTotals(listInvoiceItems(invoiceId), currentTaxrate(invoiceId));
  updateInvoiceRow(invoiceId, { status: "paid", paid_at: nowTimestamp() });
  const w = getDbWrite();
  w.prepare("UPDATE invoice SET base_income = ? WHERE id = ?")
    .run(round2(total * rate), invoiceId);
  w.prepare(
    "UPDATE invoice_item SET status = 'pending_setup', updated_at = ? WHERE invoice_id = ? AND status = 'pending_payment'",
  ).run(nowTimestamp(), invoiceId);
  insertInvoiceEvent(invoiceId, "paid", { status: "paid" });
}

function currentTaxrate(invoiceId: number): string {
  const row = findInvoiceRow(invoiceId);
  return String(row?.["taxrate"] ?? "0");
}
function currentClientId(invoiceId: number): number | null {
  const row = findInvoiceRow(invoiceId);
  const v = row?.["client_id"];
  return typeof v === "number" ? v : null;
}
function currentNr(invoiceId: number): string | null {
  const row = findInvoiceRow(invoiceId);
  const v = row?.["nr"];
  return typeof v === "string" && v !== "" ? v : null;
}
