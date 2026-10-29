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
  findDefaultCurrency,
  findInvoiceRow,
  getDb,
  getDbWrite,
  type ClientRow,
} from "./db";
import { FbError } from "./dispatch";
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
 * PHP float rendering (precision-14 %G, same algorithm as the R5a
 * config writer): PHP casts floats to strings with 14 significant
 * digits before Doctrine binds them, so a value like 60/0.9 is stored
 * as "66.666666666667", not as the raw JS double 66.66666666666667.
 * Binding this string keeps SQLite REALs (and Postgres numerics)
 * byte-identical to PHP's. Used for every base-currency write below.
 */
export function phpFloat(n: number): string {
  if (Object.is(n, -0)) return "-0.0";
  if (n === 0) return "0.0";
  const s = n.toPrecision(14);
  const [m, e] = s.split("e");
  let mant = m.replace(/(\.\d*?)0+$/, "$1");
  if (mant.endsWith(".")) mant = mant.slice(0, -1);
  if (!mant.includes(".")) mant += ".0";
  if (e !== undefined) {
    const exp = parseInt(e, 10);
    return `${mant}E${exp >= 0 ? "+" : "-"}${Math.abs(exp)}`;
  }
  return mant;
}

/**
 * Currency\Service::toBaseCurrency — convert an amount in the given
 * currency to the default currency: the amount itself when it already
 * is the default, else amount x (1 / conversion_rate). The rate is
 * read LIVE at call time (PHP reads it at payment/refund/debit, never
 * from a frozen invoice rate). Throws exactly as PHP does when the
 * rate row is missing or zero.
 */
export async function toBaseCurrency(code: string, amount: number): Promise<string> {
  const def = await findDefaultCurrency();
  if (def && def.code === code) return phpFloat(amount);
  const row = await findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  const rate = Number(row.conversion_rate);
  if (!(rate > 0)) throw new FbError("Currency conversion rate cannot be zero.");
  return phpFloat(amount / rate);
}

/**
 * Pre-write FX precondition check for every countIncome call site.
 * PHP wraps payment (markAsPaid:1050), refund (1861) and debit (2516)
 * in wrapInTransaction, so a countIncome throw there rolls EVERYTHING
 * back: the observable outcome is "error + nothing changed". TS has
 * no transaction across these handlers, so each call site validates
 * BEFORE its first write, throwing exactly the messages PHP's
 * toBaseCurrency path throws (getBaseCurrencyRate: null row/rate →
 * "Currency not found.", zero rate → "Currency conversion rate
 * cannot be zero.", missing default row → "Default currency not
 * found."). For the invoice's own currency the payment path's live
 * rate lookup (above) already throws "not configured" first, so this
 * helper's null branch is a backstop there and the live check on the
 * refund/debit paths (which have no rate lookup of their own).
 * Default-currency invoices short-circuit exactly as PHP does: only
 * the default-row check applies, never a rate check.
 */
export async function assertCountIncomeWritable(code: string): Promise<void> {
  const def = await findDefaultCurrency();
  if (!def) throw new FbError("Default currency not found.");
  if (def.code === code) return;
  const row = await findCurrencyByCode(code);
  if (!row || row.conversion_rate === null || row.conversion_rate === undefined) {
    throw new FbError("Currency not found.");
  }
  if (!(Number(row.conversion_rate) > 0)) {
    throw new FbError("Currency conversion rate cannot be zero.");
  }
}

/**
 * Invoice\Service::countIncome — the ONLY writer of base_income /
 * base_refund (payment, refund, debit-note creation all funnel here).
 * base_income = toBaseCurrency(SUM(price x quantity) over items —
 * NO tax: PHP's getTotal excludes tax, unlike invoiceTotals' total).
 * base_refund = toBaseCurrency(running refund) when refund is non-null,
 * else NULL (never 0: a paid-but-unrefunded invoice has NULL refund
 * and NULL base_refund on PHP).
 */
export async function countIncome(invoiceId: number): Promise<void> {
  const row = await findInvoiceRow(invoiceId);
  if (!row) return;
  const items = await listInvoiceItems(invoiceId);
  let subtotal = 0;
  for (const it of items) subtotal += (it.price ?? 0) * (it.quantity ?? 1);
  const refundRaw = row["refund"];
  const baseIncome = await toBaseCurrency(String(row["currency"] ?? "USD"), subtotal);
  const baseRefund =
    refundRaw === null || refundRaw === undefined
      ? null
      : await toBaseCurrency(String(row["currency"] ?? "USD"), Number(refundRaw));
  await getDbWrite()
    .prepare("UPDATE invoice SET base_income = ?, base_refund = ? WHERE id = ?")
    .run(baseIncome, baseRefund, invoiceId);
}

/**
 * Invoice\Service::prepareInvoice — creates the DRAFT (status unpaid,
 * issued = 0, nr claimed later at issuance), freezing currency, tax
 * rate/name, serie and hash. Items start pending_payment and move
 * to pending_setup when the invoice is paid.
 * R5b: PHP leaves currency_rate, base_income and base_refund NULL at
 * creation (no setter is called for them); they are first written by
 * payment (rate + countIncome), refund (countIncome) or debit-note
 * creation (countIncome). The old code froze the rate and zeroed the
 * other two here; staff checkout used to patch them back to NULL.
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
  const id = await insertInvoice({
    client_id: client.id,
    serie,
    nr: null,
    // PHP: bin2hex(random_bytes(random_int(15, 30))) — variable 30-60 hex.
    hash: randomBytes(15 + Math.floor(Math.random() * 16)).toString("hex"),
    hash_expires_at: hashExpires,
    currency,
    currency_rate: null,
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

/**
 * Invoice\Service::recordJournalEvent snapshot, as
 * Invoice\Service::toApiArray computes it: serie_nr (padding 5),
 * status, issued, subtotal/tax/total, buyer/seller blocks,
 * gateway_id + gateway name-or-code, paid/due/created dates.
 * Drafts with no frozen buyer fields display the live client record
 * (including the phone_cc key); issued invoices keep their frozen
 * copy. Used by the R5f cron events (generate, reminder,
 * expired-unpaid cancel); pre-existing issue/paid/canceled callers
 * keep their partial snapshots (see db.ts insertInvoiceEvent).
 */
export async function buildJournalSnapshot(invoiceId: number): Promise<Record<string, unknown>> {
  const row = await findInvoiceRow(invoiceId);
  const items = await listInvoiceItems(invoiceId);
  const { subtotal, tax, total } = invoiceTotals(items, String(row?.["taxrate"] ?? "0"));
  const isDraft = !row?.["issued"];
  const client =
    row?.["client_id"] !== null && row?.["client_id"] !== undefined
      ? await findClientById(Number(row["client_id"]))
      : undefined;
  let buyer: Record<string, unknown> = {
    first_name: row?.["buyer_first_name"] ?? null,
    last_name: row?.["buyer_last_name"] ?? null,
    company: row?.["buyer_company"] ?? null,
    company_vat: row?.["buyer_company_vat"] ?? null,
    company_number: row?.["buyer_company_number"] ?? null,
    address: row?.["buyer_address"] ?? null,
    city: row?.["buyer_city"] ?? null,
    state: row?.["buyer_state"] ?? null,
    country: row?.["buyer_country"] ?? null,
    phone: row?.["buyer_phone"] ?? null,
    email: row?.["buyer_email"] ?? null,
    zip: row?.["buyer_zip"] ?? null,
  };
  if (
    isDraft && client &&
    !row?.["buyer_first_name"] && !row?.["buyer_last_name"] && !row?.["buyer_company"]
  ) {
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
  const company = await getCompany();
  const liveAddress = [company.address_1, company.address_2, company.address_3]
    .filter(Boolean)
    .join(" ");
  const frozenAddress = !isDraft ? (row?.["seller_address"] as string | null) : null;
  const seller: Record<string, unknown> = {
    company: row?.["seller_company"] || company.name || "",
    company_vat: isDraft ? (company.vat_number ?? "") : (row?.["seller_company_vat"] ?? ""),
    company_number: isDraft ? (company.number ?? "") : (row?.["seller_company_number"] ?? ""),
    address: frozenAddress || liveAddress,
    address_1: frozenAddress || (company.address_1 ?? ""),
    address_2: frozenAddress !== null ? "" : (company.address_2 ?? ""),
    address_3: frozenAddress !== null ? "" : (company.address_3 ?? ""),
    phone: !isDraft ? ((row?.["seller_phone"] as string | null) ?? company.tel ?? "") : (company.tel ?? ""),
    email: !isDraft ? ((row?.["seller_email"] as string | null) ?? company.email ?? "") : (company.email ?? ""),
    account_number: company.account_number ?? null,
    bank_name: company.bank_name ?? null,
    bic: company.bic ?? null,
  };
  const gatewayId = (row?.["gateway_id"] as number | null) ?? null;
  let gateway: string | null = null;
  if (gatewayId !== null) {
    const gw = (await getDb()
      .prepare("SELECT name, gateway FROM pay_gateway WHERE id = ?")
      .get(gatewayId)) as unknown as { name: string | null; gateway: string | null } | undefined;
    gateway = gw ? (gw.name || gw.gateway) : null;
  }
  const nr = row?.["nr"];
  const serieNr = `${row?.["serie"] ?? ""}${(/^\d+$/.test(String(nr ?? "")) ? String(nr) : String(invoiceId)).padStart(5, "0")}`;
  return {
    serie_nr: serieNr,
    status: row?.["status"] ?? null,
    issued: !!row?.["issued"],
    subtotal,
    tax,
    total,
    buyer,
    seller,
    paid_at: row?.["paid_at"] ?? null,
    due_at: row?.["due_at"] ?? null,
    created_at: row?.["created_at"] ?? null,
    gateway_id: gatewayId,
    gateway,
  };
}

/** Freeze buyer (client) + seller (company) onto the invoice, as PHP
 * does once at issuance. Already-issued invoices are left untouched
 * (PHP snapshotPartiesFromLiveRecords returns early when issued). */
async function snapshotParties(invoiceId: number, client: ClientRow): Promise<void> {
  const existing = await findInvoiceRow(invoiceId);
  if (existing?.["issued"]) return;
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
 * Invoice\Service::issueInvoice — snapshots the parties (skipped when
 * already issued), claims the number (skipped when a numeric nr
 * already exists — legacy drafts keep their number), marks issued,
 * writes the journal event, then optionally pays from the client's
 * credit balance. The 'Invoice Created' email is queued AFTER the
 * credit payment, exactly as PHP's AfterAdminInvoiceIssueEvent
 * listener runs after tryPay: a credits-paid invoice gets no created
 * email (status is paid by then), and zero-total invoices get none
 * either (PHP requires total > 0). R5f: fullJournal writes the full
 * recordJournalEvent snapshot with the real client_id (generate
 * path); other callers keep the legacy partial snapshot.
 */
export async function issueInvoice(
  invoiceId: number,
  client: ClientRow,
  opts: { useCredits?: boolean; fullJournal?: boolean } = {},
): Promise<void> {
  const row = await findInvoiceRow(invoiceId);
  if (!row) throw new FbError("Invoice not found");
  if (!row["issued"] && row["status"] !== "unpaid") {
    throw new FbError("Only unpaid draft invoices can be issued.");
  }
  await snapshotParties(invoiceId, client);
  const existingNr = row["nr"];
  if (typeof existingNr === "string" && /^\d+$/.test(existingNr)) {
    await getDbWrite()
      .prepare("UPDATE invoice SET issued = 1, updated_at = ? WHERE id = ?")
      .run(nowTimestamp(), invoiceId);
  } else {
    const serie = await findSettingValue("invoice_series");
    const nr = await nextInvoiceNumber(serie);
    await getDbWrite()
      .prepare("UPDATE invoice SET serie = ?, nr = ?, issued = 1, updated_at = ? WHERE id = ?")
      .run(serie, nr, nowTimestamp(), invoiceId);
  }
  if (opts.fullJournal) {
    const snapshot = await buildJournalSnapshot(invoiceId);
    await insertInvoiceEvent(invoiceId, "issued", snapshot, {
      clientId: typeof row["client_id"] === "number" ? row["client_id"] : null,
    });
  } else {
    const fresh = await findInvoiceRow(invoiceId);
    await insertInvoiceEvent(invoiceId, "issued", {
      serie_nr: `${fresh?.["serie"] ?? ""}${fresh?.["nr"] ?? ""}`,
      status: "unpaid",
      issued: true,
    });
  }
  if (opts.useCredits) await tryPayWithCredits(invoiceId);
  // PHP queues the 'Invoice Created' email via the issued event,
  // which fires after the credit payment above.
  const after = await findInvoiceRow(invoiceId);
  const items = await listInvoiceItems(invoiceId);
  const { total } = invoiceTotals(items, String(after?.["taxrate"] ?? "0"));
  if (total > 0 && after?.["status"] !== "paid" && after?.["client_id"] !== null && after?.["client_id"] !== undefined) {
    await queueInvoiceEmail("mod_invoice_created", invoiceId);
  }
}

/** Invoice\Service::tryPayWithCredits + markAsPaid(charge: false).
 * Guards live here (PHP locks + refreshes the row first): unissued
 * or already-paid invoices return false. Zero/negative totals PAY
 * (PHP pays them without a balance row when the balance covers the
 * total — a zero total is always covered unless the balance is
 * negative); only a positive total writes a balance deduction. */
export async function tryPayWithCredits(invoiceId: number): Promise<boolean> {
  const row = await findInvoiceRow(invoiceId);
  if (!row || !row["issued"]) return false;
  if (row["status"] === "paid") return false;
  const items = await listInvoiceItems(invoiceId);
  const { total } = invoiceTotals(items, await currentTaxrate(invoiceId));
  const clientId = await currentClientId(invoiceId);
  if (clientId === null) return false;
  const balance = await clientBalanceSum(clientId);
  if (round2(balance) < round2(total)) return false;
  if (total > 0) {
    const nr = await currentNr(invoiceId);
    await insertBalanceRow({
      client_id: clientId,
      type: "invoice",
      rel_id: invoiceId,
      amount: -total,
      description: `Payment for invoice #${nr ?? invoiceId} using account credit.`,
    });
  }
  await markInvoicePaid(invoiceId);
  return true;
}

export async function markInvoicePaid(invoiceId: number): Promise<void> {
  // PHP markAsPaidInTransaction: the rate is read LIVE at payment
  // (getRateByCode throws when the currency has no rate row — the
  // invoice's creation-time rate is always NULL now, so there is no
  // frozen rate to read), the invoice is marked issued + paid, and
  // countIncome writes base_income / base_refund. Items move from
  // pending_payment to pending_setup (awaiting execution). The
  // charged amounts stay untouched on the admin/Custom path — they
  // are written when item tasks actually execute.
  // R5b also sets issued = 1 here, as PHP does (setIssued(true)):
  // TS-paid invoices previously kept issued = 0, which excluded them
  // from the stats income queries (issued = 1 filter).
  const row = await findInvoiceRow(invoiceId);
  const currency = String(row?.["currency"] ?? "USD");
  const rateRow = await findCurrencyByCode(currency);
  // PHP getRateByCode returns null when the row is missing OR its
  // conversion_rate is NULL, and markAsPaidInTransaction throws
  // "not configured" BEFORE any write in that case. A bare row-exists
  // check would let a NULL rate through to a partial write (paid
  // status + rate 0.0, then countIncome throws) — so validate the
  // VALUE here, pre-write. A zero rate is NOT this case: PHP passes
  // the lookup with 0.0 and throws later from getBaseCurrencyRate
  // (countIncome), after the paid flush — TS mirrors that shape.
  if (!rateRow || rateRow.conversion_rate === null || rateRow.conversion_rate === undefined) {
    throw new FbError(`Currency rate for code '${currency}' is not configured.`);
  }
  // PHP's wrapInTransaction rolls the payment back on any countIncome
  // throw, so validate countIncome's preconditions BEFORE the first
  // write (a zero rate would otherwise leave a paid invoice behind).
  await assertCountIncomeWritable(currency);
  const rate = Number(rateRow.conversion_rate);
  await updateInvoiceRow(invoiceId, { status: "paid", issued: 1, paid_at: nowTimestamp() });
  await getDbWrite()
    .prepare("UPDATE invoice SET currency_rate = ? WHERE id = ?")
    .run(phpFloat(rate), invoiceId);
  await countIncome(invoiceId);
  await getDbWrite()
    .prepare(
      "UPDATE invoice_item SET status = 'pending_setup', updated_at = ? WHERE invoice_id = ? AND status = 'pending_payment'",
    )
    .run(nowTimestamp(), invoiceId);
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
