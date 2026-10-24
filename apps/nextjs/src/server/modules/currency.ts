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

function resolveCurrency(ctx: CallContext): CurrencyRow {
  const code = ctx.params["code"];
  const row = code ? findCurrencyByCode(code) : findDefaultCurrency();
  if (!row) throw new FbError("Currency not found.");
  return row;
}

function guestGetPairs() {
  const out: Record<string, string> = {};
  for (const row of listCurrencies()) out[row.code] = currencyName(row.code);
  return out;
}

function guestGet(ctx: CallContext) {
  return currencyToApi(resolveCurrency(ctx));
}

function truthy(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return !["0", "false", "no", ""].includes(v.toLowerCase());
}

function guestFormat(ctx: CallContext) {
  const row = resolveCurrency(ctx);
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

function adminGetList(ctx: CallContext) {
  requireAdmin(ctx);
  const all = listCurrencies().map(currencyToApi);
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

function adminGet(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  return currencyToApi(row);
}

function adminGetDefault(ctx: CallContext) {
  requireAdmin(ctx);
  const row = findDefaultCurrency();
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

function adminCreate(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  if (findCurrencyByCode(code)) throw new FbError("Currency already registered.");
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
  insertCurrency({ code, conversion_rate: rate, is_rate_manual: manual ? 1 : 0 });
  return code;
}

function adminUpdate(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = findCurrencyByCode(code);
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
  updateCurrencyRow(code, fields);
  return true;
}

function adminDelete(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  if (row.is_default === 1) throw new FbError("Cannot remove the default currency.");
  deleteCurrencyRow(code);
  return true;
}

function adminSetDefault(ctx: CallContext) {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Currency code is missing");
  const row = findCurrencyByCode(code);
  if (!row) throw new FbError("Currency not found.");
  if (row.is_default !== 1) setDefaultCurrencyRow(code);
  return true;
}

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
