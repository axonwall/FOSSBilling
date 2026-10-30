import {
  findPublicSetting,
  findSession,
  findSettingValue,
  getAllSettings,
  getSetting,
  getSettings,
  updateSessionContent,
  upsertSetting,
} from "../db";
import {
  getConfigProperty,
  phpBoolCast,
  phpNormalizeBoolean,
  phpStringCast,
  setConfigProperty,
  type PhpConfigValue,
} from "../config-store";
import { FbError, register, requireAdmin, requireParam, type CallContext } from "../dispatch";
import { hasPermission } from "../permissions";
import { publicOrigin } from "../public-url";
import { parseSessionContent, replaceSessionSegment } from "../php-serialize";
import countriesJson from "../data/countries.json";
import phoneCodesJson from "../data/phone-codes.json";
import timezonesJson from "../data/timezones.json";

/**
 * System module (guest reads) — TS port of
 * src/modules/System/Api/Guest.php + Service::getCompany()/getPeriod().
 * Parity oracle: docs/nextjs-strangler/phase2/captures (capture5.py).
 */

const COMPANY_PARAMS = [
  "company_name",
  "company_email",
  "company_tel",
  "company_signature",
  "company_logo",
  "company_logo_dark",
  "company_favicon",
  "company_address_1",
  "company_address_2",
  "company_address_3",
  "company_bank_name",
  "company_bic",
  "company_display_bank_info",
  "company_bank_info_pagebottom",
  "company_account_number",
  "company_number",
  "company_note",
  "company_privacy_policy",
  "company_tos",
  "company_vat_number",
];

function systemUrl(): string {
  const base = publicOrigin();
  return `${base}/`;
}

function withSystemUrl(value: string | null): string | null {
  if (value !== null && !value.includes("http")) return systemUrl() + value;
  return value;
}

export async function getCompany() {
  const r = await getSettings(COMPANY_PARAMS);
  const get = (k: string) => r.get(k) ?? null;
  const logo = withSystemUrl(get("company_logo"));
  return {
    www: systemUrl(),
    name: get("company_name"),
    email: get("company_email"),
    tel: get("company_tel"),
    signature: get("company_signature"),
    logo_url: logo,
    logo_url_dark: withSystemUrl(get("company_logo_dark")) ?? logo,
    favicon_url: withSystemUrl(get("company_favicon")),
    address_1: get("company_address_1"),
    address_2: get("company_address_2"),
    address_3: get("company_address_3"),
    account_number: get("company_account_number"),
    bank_name: get("company_bank_name"),
    bic: get("company_bic"),
    display_bank_info: get("company_display_bank_info"),
    bank_info_pagebottom: get("company_bank_info_pagebottom"),
    number: get("company_number"),
    note: get("company_note"),
    privacy_policy: get("company_privacy_policy"),
    tos: get("company_tos"),
    vat_number: get("company_vat_number"),
  };
}

const GUEST_HIDDEN_WHEN_PUBLIC = [
  "vat_number",
  "email",
  "tel",
  "account_number",
  "number",
  "address_1",
  "address_2",
  "address_3",
  "bank_name",
  "bic",
] as const;

async function company(ctx: CallContext) {
  const info: Record<string, unknown> = { ...await getCompany() };
  const loggedIn = !!(ctx.session?.admin || ctx.session?.client);
  const hide = await getSetting("hide_company_public");
  if (!loggedIn && hide && hide !== "0") {
    for (const k of GUEST_HIDDEN_WHEN_PUBLIC) delete info[k];
  }
  return info;
}

/** Period::getPredefined(true) — code → title. */
export const PERIODS: Record<string, string> = {
  "1W": "Every Week",
  "1M": "Every Month",
  "3M": "Every 3 Months",
  "6M": "Every 6 Months",
  "1Y": "Every Year",
  "2Y": "Every 2 Years",
  "3Y": "Every 3 Years",
  "4Y": "Every 4 Years",
  "5Y": "Every 5 Years",
};

const UNIT_TITLES: Record<string, [string, string]> = {
  D: ["day", "days"],
  W: ["week", "weeks"],
  M: ["month", "months"],
  Y: ["year", "years"],
};

function periodTitle(ctx: CallContext) {
  const code = ctx.params["code"] ?? "";
  if (code === "" || code === "0") return "-";
  if (PERIODS[code]) return PERIODS[code];
  const m = /^(\d+)([DWMY])$/.exec(code);
  if (!m) return "-";
  const qty = parseInt(m[1], 10);
  const [singular, plural] = UNIT_TITLES[m[2]];
  return `Every ${qty} ${qty === 1 ? singular : plural}`;
}

register("guest", "system", "company", company);
register("guest", "system", "periods", () => ({ ...PERIODS }));
register("guest", "system", "period_title", periodTitle);

// --- Batch 4: remaining guest data methods + admin settings.
// Static reference data (country names, calling codes, timezone groups)
// is vendored from the PHP implementation's own output (captures8), the
// same approach as the currency tables: it changes only when upstream
// refreshes its Intl data.

register("guest", "system", "countries", () => ({ ...(countriesJson as Record<string, string>) }));
register("guest", "system", "phone_codes", () => [...(phoneCodesJson as number[])]);
register("guest", "system", "timezones", () => timezonesJson);
register("guest", "system", "default_country", async () => await findSettingValue("default_country"));
register("guest", "system", "locale", () => "en_US");

register("guest", "system", "param", async (ctx: CallContext) => {
  const key = ctx.params["key"] ?? "";
  const value = await findPublicSetting(key);
  if (value === undefined) throw new FbError(`Parameter ${key} does not exist`);
  return value;
});

/**
 * Pending messages live in the PHP session's attribute bag
 * (`pending_messages`); reading them clears them, exactly as PHP does.
 * Clearing is the one place TS rewrites a session row: the attributes
 * segment is re-serialized without the key, every other segment is
 * preserved byte-for-byte (see php-serialize.ts).
 */
register("guest", "system", "get_pending_messages", async (ctx: CallContext) => {
  if (!ctx.session) return [];
  const row = await findSession(ctx.session.id);
  if (!row) return [];
  let attrs: Record<string, unknown> = {};
  try {
    attrs = (parseSessionContent(row.content)["_sf2_attributes"] ?? {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const messages = attrs["pending_messages"];
  if (!Array.isArray(messages)) return [];
  const nextAttrs = { ...attrs };
  delete nextAttrs["pending_messages"];
  await updateSessionContent(row.id, replaceSessionSegment(row.content, "_sf2_attributes", nextAttrs as import("../php-serialize").PhpValue));
  return messages;
});

// --- Phase 5 R1 decisions batch (D2): system remainder. ---
//
// PORTED: guest paginator (pure port of FOSSBilling\Paginator +
// Guest::paginator; page_param defaults to 'page', per_page to 20,
// total to 0; PHP (int) casts truncate floats and map non-numeric
// strings to 0) and guest current_url (the request URI, which the
// seam route supplies as ctx.requestUri, NOT the /api/fb/... path).
//
// DELETED (19): these handlers exist ONLY to throw the removal error.
// A registered handler's throw becomes the error envelope, never a
// proxy — proxying would defeat the deletion. No auth check runs
// first: the endpoint no longer exists in any role, so unauthenticated
// callers see the removal error rather than PHP's 201. The four
// mutating update endpoints (update_core, finalize_update,
// complete_update_finalization, manual_update) were never called live
// against the reference install — they download/apply updates — so
// their PHP behavior is documented from source in findings-r1i.md.
//
// DEFERRED (7, intentionally NOT registered — they stay PHP-proxied):
// localization_settings + update_localization_settings (config.php
// writes; home: R5 installer/config ownership),
// error_reporting_enabled + toggle_error_reporting +
// last_error_reporting_change (config.php + Sentry; home: R5),
// instance_id (install identity; home: R5 installer).
// (is_allowed was deferred here; it landed in R2a below once the
// permission model existed.)

/** PHP (int) cast for API params: leading integer, else 0. */
function phpInt(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

function paginatorArray(total: number, page: number, perPage: number) {
  const currentPage = page < 1 ? 1 : page;
  const limit = perPage < 1 ? 0 : perPage;
  const midrange = 7;
  let numPages: number;
  if (limit < 1 || limit > total) {
    numPages = 1;
  } else {
    const rest = total % limit;
    numPages = rest > 0 ? Math.floor(total / limit) + 1 : Math.floor(total / limit);
  }
  let startRange = currentPage - Math.floor(midrange / 2);
  let endRange = currentPage + Math.floor(midrange / 2);
  if (startRange <= 0) {
    endRange += Math.abs(startRange) + 1;
    startRange = 1;
  }
  if (endRange > numPages) {
    endRange = numPages;
    startRange = Math.max(1, endRange - midrange + 1);
  }
  const range: number[] = [];
  for (let i = startRange; i <= endRange; i++) range.push(i);
  return {
    currentpage: currentPage,
    numpages: numPages,
    midrange,
    range,
    start: range[0],
    end: range[range.length - 1],
  };
}

register("guest", "system", "paginator", (ctx: CallContext) => {
  const pageParam = ctx.params["page_param"] ?? "page";
  return paginatorArray(
    phpInt(ctx.params["total"], 0),
    phpInt(ctx.params[pageParam], 1),
    phpInt(ctx.params["per_page"], 20),
  );
});

register("guest", "system", "current_url", (ctx: CallContext) => ctx.requestUri);

export const REMOVED_SYSTEM_ADMIN = [
  "update_available",
  "update_info",
  "recheck_update",
  "update_core",
  "update_finalization_status",
  "finalize_update",
  "complete_update_finalization",
  "manual_update",
  "is_behind_on_patches",
  "cache_settings",
  "update_cache_settings",
  "clear_cache",
  "template_exists",
  "env",
  "get_interface_ips",
  "set_interface_ip",
  "messages",
  "cas_messages",
];

for (const m of REMOVED_SYSTEM_ADMIN) {
  register("admin", "system", m, () => {
    throw new FbError(`Endpoint admin/system/${m} was removed in the Next.js port.`);
  });
}

register("guest", "system", "template_exists", () => {
  throw new FbError("Endpoint guest/system/template_exists was removed in the Next.js port.");
});

// --- Phase 5 R2a: is_allowed (closes the R1 deferral). ---
// System Admin::is_allowed: RequiredParams 'mod' ("mod" key is
// missing, code 9999), then Staff::hasPermission(identity, mod, f).
// No checkPermissions guard of its own: asking about a permission is
// allowed for any logged-in admin, and the answer for a super admin
// is always true.
register("admin", "system", "is_allowed", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const mod = requireParam(ctx.params, "mod", '"mod" key is missing');
  const f = ctx.params["f"] ?? null;
  return await hasPermission(ctx.session!.admin!.id, mod, f);
});

register("admin", "system", "get_params", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const out: Record<string, string | null> = {};
  for (const row of await getAllSettings()) out[row.param] = row.value;
  return out;
});

/**
 * R5a — TS port of System\Service::updateParams()' first (validate)
 * loop. PHP validates every key BEFORE the write loop runs, so a
 * single invalid value rejects the whole call and nothing is
 * written (parity34 §D proves the nothing-written half).
 *
 * invoice_starting_number: FILTER_VALIDATE_INT, min 1, max
 * PHP_INT_MAX - 1 (9223372036854775806). String inputs are compared
 * exactly via BigInt (JS numbers cannot hold the boundary); JSON
 * numbers must be integers in range (imprecise past 2^53 — the
 * urlencoded string path is the exact one, and the realistic one).
 * Non-int/non-string JSON values (null, bool, object) fail, exactly
 * as PHP's (!is_int && !is_string) branch does.
 * invoice_reminder_send_time: null or blank passes; otherwise the
 * trimmed value must match ^([01]\d|2[0-3]):[0-5]\d$.
 * Key matching is case-insensitive (PHP lowercases the key); the
 * write loop below still stores the original-case key.
 * Deliberately NOT added here: canUpdateParam's company-field
 * permission checks (a separate concern, untouched by R5a scope).
 */
const MAX_STARTING_NUMBER = 9223372036854775806n;

function validateSystemParam(key: string, val: unknown): void {
  const lower = key.toLowerCase();
  if (lower === "invoice_starting_number") {
    let ok = false;
    if (typeof val === "string") {
      if (/^[+-]?\d+$/.test(val)) {
        const n = BigInt(val);
        ok = n >= 1n && n <= MAX_STARTING_NUMBER;
      }
    } else if (typeof val === "number") {
      ok = Number.isInteger(val) && val >= 1 && val <= 9223372036854775806;
    }
    if (!ok) {
      throw new FbError(
        "Next invoice number must be a positive whole number no greater than 9223372036854775806.",
      );
    }
  }
  if (lower === "invoice_reminder_send_time") {
    if (
      val !== null &&
      String(val).trim() !== "" &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(val).trim())
    ) {
      throw new FbError("Reminder send time must be empty or a valid 24-hour time (HH:MM).");
    }
  }
}

/** Raw-aware param read: JSON bodies carry native types in rawParams. */
function rawOrParam(ctx: CallContext, key: string): unknown {
  if (ctx.rawParams && key in ctx.rawParams) return ctx.rawParams[key];
  return ctx.params[key];
}

register("admin", "system", "update_params", async (ctx: CallContext) => {
  requireAdmin(ctx);
  for (const [k, v] of Object.entries(ctx.params)) {
    if (k === "CSRFToken") continue;
    // Presence-checked, NOT `??`: a JSON null is a real value (PHP
    // validates it as non-int/non-string), and `??` would replace it
    // with the stringified params form ("null") — same verdict for
    // starting_number, but the WRONG verdict for reminder_send_time,
    // where null is explicitly allowed. Caught by parity34.
    const val = ctx.rawParams && k in ctx.rawParams ? ctx.rawParams[k] : v;
    validateSystemParam(k, val);
  }
  for (const [k, v] of Object.entries(ctx.params)) {
    if (k === "CSRFToken") continue;
    await upsertSetting(k, v ?? "");
  }
  return true;
});

/**
 * R5a — the six deferred system endpoints (the other three deferred,
 * security ip_lookup/run_check/run_checks, were ported in R5i).
 * Permission keys are PHP's, including the pinned asymmetry:
 * update_localization_settings uses system/update_params, NOT
 * system/manage_settings — do not "fix" this into uniformity.
 */
register("admin", "system", "localization_settings", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return {
    locale: phpStringCast(getConfigProperty("i18n.locale", "en_US")),
    auto_detect_locale: phpNormalizeBoolean(getConfigProperty("i18n.auto_detect_locale", true), true),
  };
});

register("admin", "system", "update_localization_settings", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const locale = rawOrParam(ctx, "locale");
  // PHP: writes locale only when set AND non-empty; always writes
  // auto_detect_locale normalized (absent/null -> true -> true).
  if (locale !== undefined && locale !== null && locale !== "") {
    // Stored as-is, as PHP stores $data['locale'] (a JSON number or
    // array would land verbatim too; the writer handles both).
    setConfigProperty("i18n.locale", locale as PhpConfigValue);
  }
  setConfigProperty(
    "i18n.auto_detect_locale",
    phpNormalizeBoolean(rawOrParam(ctx, "auto_detect_locale") ?? true, true),
  );
  return true;
});

register("admin", "system", "error_reporting_enabled", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return phpBoolCast(getConfigProperty("debug_and_monitoring.report_errors", false));
});

register("admin", "system", "toggle_error_reporting", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const current = getConfigProperty("debug_and_monitoring.report_errors", false);
  setConfigProperty("debug_and_monitoring.report_errors", !phpBoolCast(current));
  return true;
});

register("admin", "system", "last_error_reporting_change", async (ctx: CallContext) => {
  requireAdmin(ctx);
  // A code constant (SentryHelper::last_change), NOT a setting.
  return "0.8.8";
});

register("admin", "system", "instance_id", async (ctx: CallContext) => {
  requireAdmin(ctx);
  // PHP defines INSTANCE_ID from info.instance_id at load, default 'Unknown'.
  return phpStringCast(getConfigProperty("info.instance_id", "Unknown"));
});
