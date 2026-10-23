import { getSetting, getSettings } from "../db";
import { register, type CallContext } from "../dispatch";

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
  const base = (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  return `${base}/`;
}

function withSystemUrl(value: string | null): string | null {
  if (value !== null && !value.includes("http")) return systemUrl() + value;
  return value;
}

export function getCompany() {
  const r = getSettings(COMPANY_PARAMS);
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

function company(ctx: CallContext) {
  const info: Record<string, unknown> = { ...getCompany() };
  const loggedIn = !!(ctx.session?.admin || ctx.session?.client);
  const hide = getSetting("hide_company_public");
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
