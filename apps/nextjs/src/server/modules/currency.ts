import {
  findCurrencyByCode,
  findDefaultCurrency,
  listCurrencies,
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

register("guest", "currency", "get_pairs", guestGetPairs);
register("guest", "currency", "get", guestGet);
register("guest", "currency", "format", guestFormat);
register("admin", "currency", "get_list", adminGetList);
register("admin", "currency", "get_pairs", adminGetPairs);
register("admin", "currency", "get", adminGet);
register("admin", "currency", "get_default", adminGetDefault);
