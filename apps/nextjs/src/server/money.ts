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
import { queueInvoiceEmail } from "./emailer";

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
export async function isClientTaxable(client: ClientRow): Promise<boolean> {
  const enabled = await findSettingValue("tax_enabled");
  if (!enabled || enabled === "0") return false;
  return !client.tax_exempt;
}

/**
 * Tax rate resolution (Invoice Tax service): state+country rule wins,
 * then any rule for the country, then the global rule, else 0. The
 * stored rate is a PERCENTAGE (21 = 21%) — see money-map.md.
 */
export async function resolveTaxForClient(client: ClientRow): Promise<{ rate: string; name: string }> {
  if (!await isClientTaxable(client)) return { rate: "0", name: "" };
  const country = client.country ?? null;
  const state = client.state ?? null;
  let rule = undefined;
  if (state !== null && country !== null) rule = await findTaxRule(state, country);
  if (!rule && country !== null) rule = await findTaxRuleByCountry(country);
  if (!rule) rule = await findGlobalTaxRule();
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
export async function nextInvoiceNumber(serie: string | null): Promise<string> {
  const raw = await findSettingValue("invoice_starting_number");
  let candidate = raw ? parseInt(raw, 10) : 1;
  if (!Number.isFinite(candidate) || candidate < 1) candidate = 1;
  if (await invoiceNrExists(serie, String(candidate))) {
    candidate = await maxInvoiceNr(serie) + 1;
  }
  await setSettingValue("invoice_starting_number", String(candidate + 1));
  return String(candidate);
}

/**
 * Invoice\Service::prepareInvoice — creates the DRAFT (status unpaid,
 * issued = 0, nr claimed later at issuance), freezing currency, tax
 * rate/name, serie and hash. Items start pending_payment and move
 * to pending_setup when the invoice is paid.
 */
export async function prepareInvoice(
  client: ClientRow,
  items: InvoiceItemInput[],
  gatewayId: number | null,
): Promise<number> {
  const serie = await findSettingValue("invoice_series");
  const tax = await resolveTaxForClient(client);
  const dueDaysRaw = await findSettingValue("invoice_due_days");
  const dueDays = dueDaysRaw ? parseInt(dueDaysRaw, 10) : 5;
  const due = new Date(Date.now() + dueDays * 86400_000);
  const dueAt = due.toISOString().slice(0, 19).replace("T", " ");
  const hashLifetimeRaw = await findSettingValue("invoice_hash_lifetime_days");
  const hashDays = hashLifetimeRaw ? parseInt(hashLifetimeRaw, 10) : 90;
  const hashExpires = new Date(Date.now() + hashDays * 86400_000)
    .toISOString().slice(0, 19).replace("T", " ");
  const currency = client.currency ?? "USD";
  const currencyRate = (await findCurrencyByCode(currency))?.conversion_rate ?? 1;
  const id = await insertInvoice({
    client_id: client.id,
    serie,
    nr: null,
    // PHP: bin2hex(random_bytes(random_int(15, 30))) — variable 30-60 hex.
    hash: randomBytes(15 + Math.floor(Math.random() * 16)).toString("hex"),
    hash_expires_at: hashExpires,
    currency,
    currency_rate: currencyRate,
    credit: 0,
    status: "unpaid",
    taxname: tax.name,
    taxrate: tax.rate,
    gateway_id: gatewayId,
    due_at: dueAt,
    notes: await findSettingValue("invoice_default_note"),
  });
  for (const it of items) {
    await insertInvoiceItem({
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
async function snapshotParties(invoiceId: number, client: ClientRow): Promise<void> {
  const company = await getCompany();
  const address = [client.address_1, client.address_2].filter(Boolean).join(" ") || null;
  await updateInvoiceRow(invoiceId, {
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
export async function issueInvoice(
  invoiceId: number,
  client: ClientRow,
  opts: { useCredits?: boolean } = {},
): Promise<void> {
  await snapshotParties(invoiceId, client);
  const serie = await findSettingValue("invoice_series");
  const nr = await nextInvoiceNumber(serie);
  await getDbWrite()
    .prepare("UPDATE invoice SET serie = ?, nr = ?, issued = 1, updated_at = ? WHERE id = ?")
    .run(serie, nr, nowTimestamp(), invoiceId);
  await insertInvoiceEvent(invoiceId, "issued", {
    serie_nr: `${serie ?? ""}${nr}`,
    status: "unpaid",
    issued: true,
  });
  // PHP queues the 'Invoice Created' email via the issued event.
  await queueInvoiceEmail("mod_invoice_created", invoiceId);
  if (opts.useCredits) await tryPayWithCredits(invoiceId);
}

/** Invoice\Service::tryPayWithCredits + markAsPaid(charge: false). */
export async function tryPayWithCredits(invoiceId: number): Promise<boolean> {
  const items = await listInvoiceItems(invoiceId);
  const { total } = invoiceTotals(items, await currentTaxrate(invoiceId));
  if (total <= 0) return false;
  const clientId = await currentClientId(invoiceId);
  if (clientId === null) return false;
  const balance = await clientBalanceSum(clientId);
  if (round2(balance) < round2(total)) return false;
  const nr = await currentNr(invoiceId);
  await insertBalanceRow({
    client_id: clientId,
    type: "invoice",
    rel_id: invoiceId,
    amount: -total,
    description: `Payment for invoice #${nr ?? invoiceId} using account credit.`,
  });
  await markInvoicePaid(invoiceId);
  return true;
}

export async function markInvoicePaid(invoiceId: number): Promise<void> {
  // PHP records base_income (total converted at the invoice's frozen
  // rate) when an invoice is paid, and moves items from
  // pending_payment to pending_setup (awaiting execution). The
  // charged amounts stay untouched on the admin/Custom path — they
  // are written when item tasks actually execute.
  const row = await findInvoiceRow(invoiceId);
  const rate = Number(row?.["currency_rate"] ?? 1) || 1;
  const { total } = invoiceTotals(await listInvoiceItems(invoiceId), await currentTaxrate(invoiceId));
  await updateInvoiceRow(invoiceId, { status: "paid", paid_at: nowTimestamp() });
  const w = getDbWrite();
  await w.prepare("UPDATE invoice SET base_income = ? WHERE id = ?")
    .run(round2(total * rate), invoiceId);
  await w.prepare(
    "UPDATE invoice_item SET status = 'pending_setup', updated_at = ? WHERE invoice_id = ? AND status = 'pending_payment'",
  ).run(nowTimestamp(), invoiceId);
  await insertInvoiceEvent(invoiceId, "paid", { status: "paid" });
  // PHP queues the 'Payment Received' email via the paid event.
  await queueInvoiceEmail("mod_invoice_paid", invoiceId);
}

async function currentTaxrate(invoiceId: number): Promise<string> {
  const row = await findInvoiceRow(invoiceId);
  return String(row?.["taxrate"] ?? "0");
}
async function currentClientId(invoiceId: number): Promise<number | null> {
  const row = await findInvoiceRow(invoiceId);
  const v = row?.["client_id"];
  return typeof v === "number" ? v : null;
}
async function currentNr(invoiceId: number): Promise<string | null> {
  const row = await findInvoiceRow(invoiceId);
  const v = row?.["nr"];
  return typeof v === "string" && v !== "" ? v : null;
}
