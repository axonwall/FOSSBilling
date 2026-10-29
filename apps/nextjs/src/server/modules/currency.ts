import {
  deleteCurrencyRow,
  findCurrencyByCode,
  findDefaultCurrency,
  insertCurrency,
  listCurrencies,
  setDefaultCurrencyRow,
  updateCurrencyRow,
  type CurrencyRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { readExtensionConfig } from "../crypt";
import namesJson from "../data/currency-names.json";
import pairsJson from "../data/currency-pairs.json";

/**
 * Currency module (guest + admin reads) — TS port of
 * src/modules/Currency/Api/{Guest,Admin}.php read methods.
 *
 * The code→name table is static reference data (Symfony Intl currency
 * names, en) vendored from the PHP implementation's own output
 * (docs/nextjs-strangler/phase2/captures, admin_currency_get_pairs) —
 * it changes only when upstream refreshes its Intl data.
 */

const NAMES = namesJson as Record<string, string>;
const ADMIN_PAIRS = pairsJson as Record<string, string>;

function currencyName(code: string): string {
  if (NAMES[code]) return NAMES[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function currencySymbol(code: string): string {
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

function fractionDigits(code: string, override: number | null): number {
  if (override !== null && override !== undefined) return override;
  try {
    const opts = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions();
    return opts.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Currency::toApiArray() equivalent. */
export function currencyToApi(row: CurrencyRow) {
  return {
    code: row.code,
    name: currencyName(row.code),
    symbol: currencySymbol(row.code),
    conversion_rate: row.conversion_rate,
    is_rate_manual: !!row.is_rate_manual,
    format_pattern: row.format_pattern,
    fraction_digits: row.fraction_digits,
    default: !!row.is_default,
  };
}

async function resolveCurrency(ctx: CallContext): Promise<CurrencyRow> {
  const code = ctx.params["code"];
  const row = code ? await findCurrencyByCode(code) : await findDefaultCurrency();
  if (!row) throw new FbError("Currency not found.");
  return row;
}

async function guestGetPairs() {
  const out: Record<string, string> = {};
  for (const row of await listCurrencies()) out[row.code] = currencyName(row.code);
  return out;
}

async function guestGet(ctx: CallContext) {
  return currencyToApi(await resolveCurrency(ctx));
}

function truthy(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return !["0", "false", "no", ""].includes(v.toLowerCase());
}

async function guestFormat(ctx: CallContext) {
  const row = await resolveCurrency(ctx);
  let price = parseFloat(ctx.params["price"] ?? "0") || 0;
  if (truthy(ctx.params["convert"], true)) price = price * row.conversion_rate;
  const digits = fractionDigits(row.code, row.fraction_digits);
  // PHP order: without_currency -> formatNumber (pattern ignored);
  // otherwise formatCurrency, which applies format_pattern if one is set.
  if (truthy(ctx.params["without_currency"], false)) {
    return new Intl.NumberFormat("en-US", {
      style: "decimal",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(price);
  }
  if (row.format_pattern) {
    const num = new Intl.NumberFormat("en-US", {
      style: "decimal",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(price);
    return row.format_pattern.replace("{amount}", num);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: row.code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(price);
}

async function adminGetList(ctx: CallContext) {
  requireAdmin(ctx);
  const all = (await listCurrencies()).map(currencyToApi);
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const total = all.length;
  const list = all.slice((page - 1) * perPage, page * perPage);
  return { pages: Math.max(1, Math.ceil(total / perPage)), page, per_page: perPage, total, list };
}

function adminGetPairs(ctx: CallContext) {
  requireAdmin(ctx);
  return { ...ADMIN_PAIRS };
}

async function adminGet(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = await findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  return currencyToApi(row);
}

async function adminGetDefault(ctx: CallContext) {
  requireAdmin(ctx);
  const row = await findDefaultCurrency();
  if (!row) throw new FbError("Currency not found.");
  return currencyToApi(row);
}

// --- Mutations (Phase 2 batch 2). Error messages/codes mirror the PHP
// Admin API + Service, verified against captures6. Staff fine-grained
// permissions (checkPermissions) are not yet modeled — admin identity is
// required; see phase2/findings.md.

function validCurrencyCode(code: string): boolean {
  return code in NAMES || Intl.supportedValuesOf("currency").includes(code);
}

function normalizeFormatPattern(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 100) {
    throw new FbError("Currency format pattern cannot exceed 100 characters.");
  }
  if ((trimmed.match(/\{amount\}/g) ?? []).length !== 1) {
    throw new FbError("Currency format pattern must contain exactly one {amount} placeholder.");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new FbError("Currency format pattern must be a single line of plain text.");
  }
  return trimmed;
}

function normalizeFractionDigits(raw: string): number | null {
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 6) {
    throw new FbError("Currency fraction digits must be a whole number between 0 and 6.");
  }
  return n;
}

async function adminCreate(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  if (await findCurrencyByCode(code)) throw new FbError("Currency already registered.");
  if (!validCurrencyCode(code)) throw new FbError("Currency code is invalid.");
  const manual = truthy(ctx.params["is_rate_manual"], false);
  const rateRaw = ctx.params["conversion_rate"];
  let rate: number;
  if (manual && (rateRaw === undefined || rateRaw === "")) {
    throw new FbError("A conversion rate is required when manual override is enabled.");
  }
  if (rateRaw === undefined || rateRaw === "") {
    // PHP first tries its external rate provider and falls back to 1.0 on
    // failure; TS uses the fallback directly (documented divergence).
    rate = 1.0;
  } else {
    if (!/^-?\d+(\.\d+)?$/.test(rateRaw) || Number(rateRaw) <= 0) {
      throw new FbError("Currency conversion rate must be a positive number.");
    }
    rate = Number(rateRaw);
  }
  await insertCurrency({ code, conversion_rate: rate, is_rate_manual: manual ? 1 : 0 });
  return code;
}

async function adminUpdate(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = await findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  const fields: Parameters<typeof updateCurrencyRow>[1] = {};
  if ("format_pattern" in ctx.params) {
    fields.format_pattern = normalizeFormatPattern(ctx.params["format_pattern"] ?? "");
  }
  if ("fraction_digits" in ctx.params) {
    fields.fraction_digits = normalizeFractionDigits(ctx.params["fraction_digits"] ?? "");
  }
  const manual = "is_rate_manual" in ctx.params ? truthy(ctx.params["is_rate_manual"], false) : null;
  if (manual === true && row.is_default === 1) {
    throw new FbError("The default currency cannot use a manual rate override.");
  }
  const rateRaw = ctx.params["conversion_rate"];
  if (rateRaw !== undefined && rateRaw !== "") {
    if (!/^-?\d+(\.\d+)?$/.test(rateRaw) || Number(rateRaw) <= 0) {
      throw new FbError("Currency conversion rate is invalid.", 151);
    }
    fields.conversion_rate = Number(rateRaw);
  }
  if (manual !== null) fields.is_rate_manual = manual ? 1 : 0;
  await updateCurrencyRow(code, fields);
  return true;
}

async function adminDelete(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = await findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  if (row.is_default === 1) throw new FbError("Cannot remove the default currency.");
  await deleteCurrencyRow(code);
  return true;
}

async function adminSetDefault(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = await findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  if (row.is_default !== 1) await setDefaultCurrencyRow(code);
  return true;
}

// --- Phase 5 R1 decisions batch (D1): update_rates. TS port of
// Currency Service::updateCurrencyRates + getRate + the three provider
// fetchers. PHP caches provider responses (sync_rate TTL); TS has no
// cache, so every call fetches — the TTL only affects request count,
// never the returned rates. PHP flushes once at the end, so a provider
// failure mid-loop persists nothing: TS computes every rate first and
// only then writes. Transport/JSON failures propagate as plain Errors
// (envelope 9999 with a transport message), mirroring PHP's uncaught
// HttpClient exceptions; provider-level failures use the verbatim
// InformationException messages. The live happy path cannot be verified
// in the sandbox (external fetch fails at the TLS layer) — see
// phase5/findings-r1i.md.
async function fetchProviderJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected response from exchange rate provider (${res.status})`);
  }
}

/** Currency Data API / currencylayer quote normalization: strip the
 * from-currency prefix from each quotes key, skip non-numeric rates. */
function apilayerRates(body: Record<string, unknown>, from: string): Record<string, unknown> {
  const quotes = body["quotes"];
  const out: Record<string, unknown> = {};
  if (quotes && typeof quotes === "object" && !Array.isArray(quotes)) {
    for (const [k, v] of Object.entries(quotes as Record<string, unknown>)) {
      if (v === null || v === "" || !Number.isFinite(Number(v))) continue;
      out[k.slice(from.length)] = v;
    }
  }
  return out;
}

async function getRate(
  from: string,
  to: string,
  config: Record<string, unknown>,
): Promise<number> {
  const provider = typeof config["provider"] === "string" ? config["provider"] : "";
  let rates: Record<string, unknown>;
  if (provider === "currency_data_api") {
    const key = config["currencydata_key"];
    if (!key) {
      throw new FbError(
        "You must configure your API key to use Currency Data API as an exchange rate data source.",
      );
    }
    const body = await fetchProviderJson(
      `https://api.apilayer.com/currency_data/live?source=${encodeURIComponent(from)}`,
      { "Content-Type": "text/plain", apikey: String(key) },
    );
    if (body["success"] !== true) {
      throw new FbError(
        "There was an error when fetching currency rates from Currency Data API. See the error log for details.",
      );
    }
    rates = apilayerRates(body, from);
  } else if (provider === "currencylayer") {
    const key = config["currencylayer_key"];
    if (!key) {
      throw new FbError(
        "You must configure your API key to use currencylayer as an exchange rate data source.",
      );
    }
    const body = await fetchProviderJson(
      `https://api.apilayer.com/currency_data/live?access_key=${encodeURIComponent(String(key))}&source=${encodeURIComponent(from)}`,
    );
    if (body["success"] !== true) {
      throw new FbError(
        "There was an error when fetching currency rates from currencylayer. See the error log for details.",
      );
    }
    rates = apilayerRates(body, from);
  } else {
    const key = typeof config["exchangerate_api_key"] === "string" ? config["exchangerate_api_key"] : "";
    const url = key
      ? `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/${encodeURIComponent(from)}`
      : `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
    const body = await fetchProviderJson(url);
    if (body["result"] !== "success") {
      throw new FbError(
        "There was an error when fetching currency rates from ExchangeRate-API. See the error log for details.",
      );
    }
    const raw = key ? body["conversion_rates"] : body["rates"];
    rates =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }
  const v = rates[to];
  if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new FbError(`Unable to fetch conversion rate for currency: ${to}.`);
}

/**
 * Currency\Service::updateRatesBeforeAdminCronRun (R5f Before
 * listener): runs only when the mod_currency config's sync_rate is
 * not 'never' (default 'auto'). Default currency → 1.0, manual-rate
 * currencies skipped, others live-fetched; computed first, then
 * written (so a fetch failure writes nothing, as PHP's flush-at-end
 * does). The caller catches failures per-effect, as PHP's listener
 * does. Sandbox asymmetry, pinned: TS fetches fine while PHP dies
 * at sandbox TLS and swallows it — so a crafted non-default,
 * non-manual currency updates on TS but not PHP; parity proves the
 * default/manual/never-gate paths, NOT live fetch.
 */
export async function runCurrencyRatesBeforeCron(): Promise<boolean> {
  const config = await readExtensionConfig("mod_currency");
  if ((config["sync_rate"] ?? "auto") === "never") return false;
  const def = await findDefaultCurrency();
  if (!def) throw new FbError("Default currency not found. Cannot update rates.");
  const computed: { code: string; rate: number }[] = [];
  for (const row of await listCurrencies()) {
    if (row.is_default === 1) {
      computed.push({ code: row.code, rate: 1.0 });
    } else if (row.is_rate_manual === 1) {
      continue;
    } else {
      computed.push({ code: row.code, rate: await getRate(def.code, row.code, config) });
    }
  }
  for (const c of computed) await updateCurrencyRow(c.code, { conversion_rate: c.rate });
  return true;
}

async function adminUpdateRates(ctx: CallContext) {
  requireAdmin(ctx);
  const def = await findDefaultCurrency();
  if (!def) throw new FbError("Default currency not found. Cannot update rates.");
  const config = await readExtensionConfig("mod_currency");
  const computed: { code: string; rate: number }[] = [];
  for (const row of await listCurrencies()) {
    if (row.is_default === 1) {
      computed.push({ code: row.code, rate: 1.0 });
    } else if (row.is_rate_manual === 1) {
      continue;
    } else {
      computed.push({ code: row.code, rate: await getRate(def.code, row.code, config) });
    }
  }
  for (const c of computed) await updateCurrencyRow(c.code, { conversion_rate: c.rate });
  return true;
}

register("admin", "currency", "update_rates", adminUpdateRates);

register("guest", "currency", "get_pairs", guestGetPairs);
register("guest", "currency", "get", guestGet);
register("guest", "currency", "format", guestFormat);
register("admin", "currency", "get_list", adminGetList);
register("admin", "currency", "get_pairs", adminGetPairs);
register("admin", "currency", "get", adminGet);
register("admin", "currency", "get_default", adminGetDefault);
register("admin", "currency", "create", adminCreate);
register("admin", "currency", "update", adminUpdate);
register("admin", "currency", "delete", adminDelete);
register("admin", "currency", "set_default", adminSetDefault);
