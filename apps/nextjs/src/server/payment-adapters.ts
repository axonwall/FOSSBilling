import { createHash, createHmac } from "node:crypto";
import { getDb, getDbWrite, nowTimestamp } from "./db";
import { FbError } from "./dispatch";
import { renderTemplateStrict } from "./twig";
import { STRIPE_ONE_TIME_FORM, STRIPE_SUBSCRIPTION_FORM } from "./stripe-forms";

/**
 * Payment adapter getHtml() ports for guest invoice payment
 * (Invoice Service::processInvoice, getHtml branch).
 *
 * Supported adapters: Custom, PayPalEmail, Stripe — the three adapters
 * with gateway rows in the reference install. Any other gateway code
 * throws a clear not-ported error (never silently proxied, never a
 * fabricated form). ClientBalance has no getHtml path in PHP (it uses
 * singlePayment/recurrentPayment), so it is out of scope here too.
 *
 * Known fidelity limits (see phase5/findings-r1i.md):
 * - Custom templates are rendered with the TS Twig subset and a
 *   conservative sanitizer approximation (safe elements kept, event
 *   attributes and unsafe schemes dropped, text nodes escaped). The
 *   reference install's Custom config is NULL, so parity exercises
 *   only the fallback literal, which matches PHP exactly.
 * - Stripe success paths call the live Stripe API and cannot be
 *   verified in the sandbox (external fetch fails at the TLS layer);
 *   params, idempotency keys, and caching mirror PHP exactly, and
 *   API/transport failures map to PHP's generic envelope, as PHP's
 *   dispatcher does for Stripe SDK exceptions.
 * - withStripeObjectLock's DBAL NamedLock becomes an in-process mutex:
 *   the Next server is a single process, so cross-request serialization
 *   holds; the 10s PHP lock timeout has no TS equivalent.
 */

export interface GatewayRow {
  id: number;
  gateway: string;
  name: string | null;
  enabled: number;
  test_mode: number;
  allow_single: number;
  allow_recurrent: number;
  config: string | null;
}

export interface PaymentInvoiceView {
  id: number;
  nr: string;
  serie: string;
  hash: string;
  client_id: number;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  lines: { title: string | null }[];
  buyer: {
    first_name: string | null;
    last_name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    zip: string | null;
    email: string | null;
  };
  /** Subscription period from the pure isSubscribable query (NOT the
   * type-filtered invoiceArray subscription): {unit, cycle, period}. */
  subscriptionPeriod: string | null;
}

export interface AdapterConfig {
  [key: string]: unknown;
}

/** PHP htmlspecialchars(ENT_QUOTES | ENT_SUBSTITUTE, UTF-8). */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** PHP json_encode() with default flags: / escaped, non-ASCII as
 * \uXXXX, control chars JSON-escaped. Used for Stripe idempotency keys,
 * where the hashed bytes must match PHP's exactly. */
export function phpJsonEncode(v: unknown): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Cannot JSON-encode a non-finite number");
    return String(v);
  }
  if (typeof v === "string") return phpJsonString(v);
  if (Array.isArray(v)) return "[" + v.map(phpJsonEncode).join(",") + "]";
  if (typeof v === "object") {
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined) continue;
      parts.push(phpJsonString(k) + ":" + phpJsonEncode(x));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error("Cannot JSON-encode value");
}

function phpJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "/") out += "\\/";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else if (code > 0x7e) {
      if (code > 0xffff) {
        const v = code - 0x10000;
        out +=
          "\\u" +
          (0xd800 + (v >> 10)).toString(16) +
          "\\u" +
          (0xdc00 + (v & 0x3ff)).toString(16);
      } else {
        out += "\\u" + code.toString(16).padStart(4, "0");
      }
    } else out += ch;
  }
  return out + '"';
}

/** Stripe's encodeJsString: json_encode with HEX_TAG | HEX_APOS |
 * HEX_QUOT | HEX_AMP | UNESCAPED_UNICODE (uppercase \uXXXX for
 * < > ' " &, slash escaped as \/ — verified live against the sandbox
 * PHP: the HEX probe output ends "f\u00e9\/g"). */
export function encodeJsString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += "\\u0022";
    else if (ch === "'") out += "\\u0027";
    else if (ch === "&") out += "\\u0026";
    else if (ch === "<") out += "\\u003C";
    else if (ch === ">") out += "\\u003E";
    else if (ch === "/") out += "\\/";
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/** PHP strtr() with an array: single pass, longest keys first, no
 * re-replacement of substituted text. */
export function strtr(template: string, bindings: Record<string, string>): string {
  const keys = Object.keys(bindings).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return template;
  const re = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return template.replace(re, (m) => bindings[m]);
}

/** AdapterAbstract::moneyFormat: CLDR fraction digits (Symfony Intl),
 * number_format with '.' and no thousands separator (half away from zero). */
export function moneyFormat(amount: number, currency: string | null): string {
  let digits = 2;
  if (currency) {
    try {
      digits =
        new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
  }
  const m = 10 ** digits;
  const rounded = Math.sign(amount) * Math.round(Math.abs(amount) * m) / m;
  return rounded.toFixed(digits);
}

function systemBase(): string {
  return (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
}

function toolsUrl(path: string): string {
  return systemBase() + path;
}

function link(path: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return systemBase() + path + (q ? "?" + q : "");
}

/** ServicePayGateway::getPaymentAdapter config merge: stored config
 * first, defaults OVER it (array_merge($config, $defaults)). */
export function adapterConfig(gw: GatewayRow, inv: PaymentInvoiceView): AdapterConfig {
  let stored: Record<string, unknown> = {};
  try {
    const parsed = gw.config ? JSON.parse(gw.config) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      stored = parsed as Record<string, unknown>;
    }
  } catch {
    stored = {};
  }
  const base = systemBase();
  return {
    ...stored,
    auto_redirect: false,
    gateway_id: gw.id,
    test_mode: gw.test_mode === 1,
    return_url: link("/invoice/payment-return", { status: "ok", ...(inv.hash ? { hash: inv.hash } : {}) }),
    cancel_url: link("/invoice/payment-return", { status: "cancel", ...(inv.hash ? { hash: inv.hash } : {}) }),
    notify_url: `${base}/ipn.php?gateway_id=${gw.id}&invoice_id=${inv.id}`,
    redirect_url: `${base}/ipn.php?gateway_id=${gw.id}&invoice_id=${inv.id}&invoice_hash=${inv.hash}&redirect=1`,
    continue_shopping_url: toolsUrl("/order"),
    single_page: true,
    thankyou_url: link("/invoice/payment-return", { status: "thankyou", ...(inv.hash ? { hash: inv.hash } : {}) }),
    invoice_url: toolsUrl(`/invoice/${inv.hash}`),
    logo: null,
  };
}

function callbackSalt(): string {
  return process.env.FB_CALLBACK_SALT ?? "";
}

/** Tools::signCallbackParams: HMAC-SHA256("<gatewayId>|<invoiceId>", salt). */
export function signCallbackParams(gatewayId: number, invoiceId: number): string {
  return createHmac("sha256", callbackSalt()).update(`${gatewayId}|${invoiceId}`).digest("hex");
}

// --- Custom ---------------------------------------------------------------

/**
 * BrowserHtmlSanitizer::sanitizeAdapterHtml approximation (Symfony
 * HtmlSanitizer, allowSafeElements + relative links/medias). Safe
 * elements and their safe attributes are kept; every other tag is
 * stripped but its text kept; event attributes and unsafe schemes are
 * dropped; text nodes are escaped with " as &#34; (the serializer's
 * observed form for plain text). The fallback literal has no tags, so
 * it reduces to plain-text escaping — exactly PHP's output there.
 */
const SAFE_ELEMENTS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dd", "dfn", "div", "dl", "dt",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "i", "kbd", "li", "mark", "ol", "p", "pre", "q",
  "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "ul",
  "var", "wbr", "img", "audio", "video", "source", "track",
]);
const VOID_ELEMENTS = new Set(["br", "wbr", "img", "source", "track"]);

function sanitizeAdapterHtml(html: string): string {
  if (html === "") return "";
  let out = "";
  let i = 0;
  const open: string[] = [];
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9]*)\b([^>]*)>/g;
  let last = 0;
  const escText = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;");
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    out += escText(html.slice(last, m.index));
    const closing = m[0].startsWith("</");
    const name = m[1].toLowerCase();
    const attrsRaw = m[2];
    if (!SAFE_ELEMENTS.has(name)) {
      // Stripped tag: keep inner text (already emitted as text nodes).
      if (!closing) {
        // Skip to the matching close tag's text? No: inner text is
        // emitted by the next loop iterations as plain text, which is
        // what Symfony does for disallowed elements.
      }
      last = tagRe.lastIndex;
      continue;
    }
    if (closing) {
      if (open.includes(name)) {
        while (open.length > 0) {
          const popped = open.pop()!;
          out += `</${popped}>`;
          if (popped === name) break;
        }
      }
      last = tagRe.lastIndex;
      continue;
    }
    // Attribute filter: drop event handlers and unsafe schemes.
    const kept: string[] = [];
    const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrsRaw)) !== null) {
      const an = am[1].toLowerCase();
      if (an.startsWith("on")) continue;
      const val = am[2] ?? am[3] ?? am[4] ?? "";
      if ((an === "href" || an === "src") && /^\s*(javascript|data|vbscript):/i.test(val)) continue;
      kept.push(val === "" && am[2] === undefined && am[3] === undefined && am[4] === undefined
        ? an
        : `${an}="${val.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
    }
    out += `<${name}${kept.length ? " " + kept.join(" ") : ""}>`;
    if (!VOID_ELEMENTS.has(name) && !m[0].endsWith("/>")) open.push(name);
    last = tagRe.lastIndex;
  }
  out += escText(html.slice(last));
  while (open.length > 0) out += `</${open.pop()!}>`;
  return out.trim();
}

function customHtml(cfg: AdapterConfig, inv: PaymentInvoiceView, subscription: boolean): string {
  const key = subscription ? "recurrent" : "single";
  const tpl =
    typeof cfg[key] === "string"
      ? (cfg[key] as string)
      : '"Custom" payment adapter is not fully configured.';
  const rendered = renderTemplateStrict(tpl, { invoice: inv });
  return sanitizeAdapterHtml(rendered);
}

// --- PayPalEmail ----------------------------------------------------------

function paypalInvoiceTitle(inv: PaymentInvoiceView): string {
  const nr = parseInt(inv.nr, 10);
  const id = Number.isNaN(nr) ? "00000" : String(nr).padStart(5, "0");
  return `Payment for invoice ${inv.serie}${id} [${inv.lines[0]?.title ?? ""}]`;
}

function paypalSignNotifyUrl(url: string, gatewayId: number, invoiceId: number): string {
  const sig = signCallbackParams(gatewayId, invoiceId);
  const sep = url.includes("?") ? "&" : "?";
  return url + sep + "sig=" + encodeURIComponent(sig);
}

function paypalForm(url: string, data: [string, string][], autoRedirect: boolean): string {
  let form = `<form name="payment_form" action="${htmlEscape(url)}" method="post">\n`;
  for (const [k, v] of data) {
    form += `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}" />\n`;
  }
  form += `<input class="btn btn-primary" type="submit" value="Pay with PayPal" id="payment_button"/>\n`;
  form += "</form>\n\n";
  if (autoRedirect) {
    form += "<h2>Redirecting to PayPal.com</h2>";
    form += `<script>
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('payment_button').style.display = 'none';
    document.forms['payment_form'].submit();
});
</script>`;
  }
  return form;
}

function paypalHtml(cfg: AdapterConfig, inv: PaymentInvoiceView, subscription: boolean): string {
  const url = cfg["test_mode"] ? "https://www.sandbox.paypal.com/cgi-bin/webscr" : "https://www.paypal.com/cgi-bin/webscr";
  const notify = paypalSignNotifyUrl(String(cfg["notify_url"]), Number(cfg["gateway_id"]), inv.id);
  const auto = !!cfg["auto_redirect"];
  if (subscription) {
    const subs = inv.subscriptionPeriod;
    const qty = subs ? parseInt(subs, 10) || 1 : 1;
    const unit = subs ? subs.slice(-1) : "M";
    const b = inv.buyer;
    const fields: [string, string][] = [
      ["item_name", paypalInvoiceTitle(inv)],
      ["item_number", inv.nr],
      ["no_shipping", "1"],
      ["no_note", "1"],
      ["currency_code", inv.currency],
      ["return", String(cfg["thankyou_url"])],
      ["cancel_return", String(cfg["cancel_url"])],
      ["notify_url", notify],
      ["business", String(cfg["email"] ?? "")],
      ["cmd", "_xclick-subscriptions"],
      ["rm", "1"],
      ["invoice", String(inv.id)],
      ["a3", moneyFormat(inv.total, inv.currency)],
      ["p3", String(qty)],
      ["t3", unit],
      ["src", "1"],
      ["sra", "1"],
      ["charset", "UTF-8"],
      ["address1", b.address ?? ""],
      ["city", b.city ?? ""],
      ["email", b.email ?? ""],
      ["first_name", b.first_name ?? ""],
      ["last_name", b.last_name ?? ""],
      ["zip", b.zip ?? ""],
      ["state", b.state ?? ""],
      ["bn", "FOSSBilling_SP"],
    ];
    return paypalForm(url, fields, auto);
  }
  const fields: [string, string][] = [
    ["item_name", paypalInvoiceTitle(inv)],
    ["item_number", inv.nr],
    ["no_shipping", "1"],
    ["no_note", "1"],
    ["currency_code", inv.currency],
    ["rm", "1"],
    ["return", String(cfg["thankyou_url"])],
    ["cancel_return", String(cfg["cancel_url"])],
    ["notify_url", notify],
    ["business", String(cfg["email"] ?? "")],
    ["cmd", "_xclick"],
    ["amount", moneyFormat(inv.subtotal, inv.currency)],
    ["tax", moneyFormat(inv.tax, inv.currency)],
    ["bn", "FOSSBilling_SP"],
    ["charset", "utf-8"],
  ];
  return paypalForm(url, fields, auto);
}

// --- Stripe ---------------------------------------------------------------

const STRIPE_ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF",
  "XOF", "XPF",
]);
const STRIPE_THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

function stripeFractionDigits(currency: string): number {
  const c = currency.toUpperCase();
  if (STRIPE_ZERO_DECIMAL.has(c)) return 0;
  if (STRIPE_THREE_DECIMAL.has(c)) return 3;
  return 2;
}

function stripeAmountMinor(total: number, currency: string): number {
  return Math.round(total * 10 ** stripeFractionDigits(currency));
}

/** PHP's dispatcher maps non-FOSSBilling exceptions (Stripe SDK
 * ApiErrorException included) to this generic envelope. */
function stripeGenericError(): FbError {
  return new FbError("An unexpected error occurred. Please try again later.", 9999);
}

interface StripeClient {
  secret: string;
}

function stripeClient(cfg: AdapterConfig): StripeClient {
  if (cfg["test_mode"]) {
    if (!cfg["test_api_key"]) {
      throw new FbError(
        'The "Stripe" payment gateway is not fully configured. Please configure the Test API Key',
        4001,
      );
    }
    if (!cfg["test_pub_key"]) {
      throw new FbError(
        'The "Stripe" payment gateway is not fully configured. Please configure the Test publishable key',
        4001,
      );
    }
    return { secret: String(cfg["test_api_key"]) };
  }
  if (!cfg["api_key"]) {
    throw new FbError(
      'The "Stripe" payment gateway is not fully configured. Please configure the API key',
      4001,
    );
  }
  if (!cfg["pub_key"]) {
    throw new FbError(
      'The "Stripe" payment gateway is not fully configured. Please configure the Publishable key',
      4001,
    );
  }
  return { secret: String(cfg["api_key"]) };
}

function stripePubKey(cfg: AdapterConfig): string {
  return String(cfg["test_mode"] ? cfg["test_pub_key"] : cfg["pub_key"]);
}

/** Form-encode Stripe params the way stripe-php does: nested objects as
 * key[sub], nulls skipped, booleans as true/false strings. */
function stripeFormEncode(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  const enc = (k: string, v: string) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      parts.push(stripeFormEncode(v as Record<string, unknown>, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          parts.push(stripeFormEncode(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          parts.push(enc(`${key}[${i}]`, String(item)));
        }
      });
    } else if (typeof v === "boolean") {
      parts.push(enc(key, v ? "true" : "false"));
    } else {
      parts.push(enc(key, String(v)));
    }
  }
  return parts.join("&");
}

async function stripeRequest(
  client: StripeClient,
  method: string,
  path: string,
  params: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${client.secret}` };
  let url = `https://api.stripe.com/v1/${path}`;
  let body: string | undefined;
  if (method === "GET") {
    const q = stripeFormEncode(params);
    if (q) url += "?" + q;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = stripeFormEncode(params);
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
  } catch {
    throw stripeGenericError();
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    throw stripeGenericError();
  }
  if (!res.ok || !parsed || typeof parsed !== "object") throw stripeGenericError();
  return parsed as Record<string, unknown>;
}

function stripeInvoiceTitle(inv: PaymentInvoiceView): string {
  // PHP sprintf('%05s'): space-padded, never truncated.
  const id = String(inv.nr).padStart(5, " ");
  const title = `Payment for invoice ${inv.serie}${id} [${inv.lines[0]?.title ?? ""}]`;
  if (inv.lines.length > 1) return `Payment for invoice ${inv.serie}${id}`;
  return title;
}

function stripePeriod(inv: PaymentInvoiceView): { interval: string; interval_count: number } {
  const period = inv.subscriptionPeriod ?? "1M";
  const m = /^(\d+)([DWMY])$/.exec(period);
  if (!m) throw stripeGenericError();
  const qty = parseInt(m[1], 10);
  const interval =
    m[2] === "D" ? "day" : m[2] === "W" ? "week" : m[2] === "Y" ? "year" : "month";
  const max = interval === "day" ? 1095 : interval === "week" ? 156 : interval === "year" ? 3 : 36;
  if (qty > max) {
    throw new FbError(
      `The billing period "${period}" is not supported by the Stripe payment gateway. The maximum supported interval is ${max} ${interval}(s)`,
    );
  }
  return { interval, interval_count: qty };
}

function escapeStripeSearchValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isValidEmail(v: string | null): boolean {
  if (!v) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function stripeGetOrCreateCustomer(
  client: StripeClient,
  gatewayId: number,
  inv: PaymentInvoiceView,
): Promise<string> {
  const db = getDb();
  if (inv.client_id !== null && inv.client_id !== undefined) {
    const cached = db
      .prepare("SELECT external_customer_id FROM pay_gateway_customer WHERE pay_gateway_id = ? AND client_id = ?")
      .get(gatewayId, inv.client_id) as { external_customer_id: string } | undefined;
    if (cached) return cached.external_customer_id;
  }
  let customerId: string;
  const email = inv.buyer.email;
  if (isValidEmail(email)) {
    const found = await stripeRequest(client, "GET", "customers/search", {
      query: `email:'${escapeStripeSearchValue(email!)}'`,
      limit: 1,
    });
    const data = found["data"];
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      customerId = String((data[0] as Record<string, unknown>)["id"]);
    } else {
      customerId = await stripeCreateCustomer(client, inv);
    }
  } else {
    customerId = await stripeCreateCustomer(client, inv);
  }
  if (inv.client_id !== null && inv.client_id !== undefined) {
    try {
      getDbWrite()
        .prepare(
          "INSERT INTO pay_gateway_customer (client_id, external_customer_id, created_at, updated_at, pay_gateway_id) VALUES (?, ?, ?, ?, ?)",
        )
        .run(inv.client_id, customerId, nowTimestamp(), nowTimestamp(), gatewayId);
    } catch {
      const winner = db
        .prepare("SELECT external_customer_id FROM pay_gateway_customer WHERE pay_gateway_id = ? AND client_id = ?")
        .get(gatewayId, inv.client_id) as { external_customer_id: string } | undefined;
      if (winner) return winner.external_customer_id;
    }
  }
  return customerId;
}

async function stripeCreateCustomer(client: StripeClient, inv: PaymentInvoiceView): Promise<string> {
  const b = inv.buyer;
  const address: Record<string, unknown> = {};
  if (b.address) address["line1"] = b.address;
  if (b.city) address["city"] = b.city;
  if (b.state) address["state"] = b.state;
  if (b.zip) address["postal_code"] = b.zip;
  if (b.country) address["country"] = b.country;
  const created = await stripeRequest(client, "POST", "customers", {
    email: b.email ?? "",
    name: `${b.first_name ?? ""} ${b.last_name ?? ""}`.trim(),
    address,
  });
  const id = created["id"];
  if (typeof id !== "string") throw stripeGenericError();
  return id;
}

async function stripeGetOrCreatePriceId(
  client: StripeClient,
  gatewayId: number,
  inv: PaymentInvoiceView,
): Promise<string> {
  const productName = inv.lines[0]?.title ?? null;
  if (!productName) throw stripeGenericError();
  const amount = stripeAmountMinor(inv.total, inv.currency);
  const currency = inv.currency.toLowerCase();
  const recurring = stripePeriod(inv);
  const cacheKey = createHash("sha256")
    .update(`${productName}|${currency}|${amount}|${recurring.interval}|${recurring.interval_count}`)
    .digest("hex");
  const db = getDb();
  const cached = db
    .prepare("SELECT external_price_id FROM pay_gateway_product WHERE pay_gateway_id = ? AND cache_key = ?")
    .get(gatewayId, cacheKey) as { external_price_id: string } | undefined;
  if (cached) return cached.external_price_id;
  const found = await stripeRequest(client, "GET", "products/search", {
    query: `name:'${escapeStripeSearchValue(productName)}'`,
    limit: 1,
  });
  const pdata = found["data"];
  let productId: string;
  if (Array.isArray(pdata) && pdata.length > 0 && typeof pdata[0] === "object" && pdata[0] !== null) {
    productId = String((pdata[0] as Record<string, unknown>)["id"]);
  } else {
    const created = await stripeRequest(client, "POST", "products", {
      name: productName,
      description: stripeInvoiceTitle(inv),
    });
    if (typeof created["id"] !== "string") throw stripeGenericError();
    productId = created["id"] as string;
  }
  const prices = await stripeRequest(client, "GET", "prices", {
    product: productId,
    recurring: { interval: recurring.interval },
    currency,
    limit: 100,
  });
  const pricedata = prices["data"];
  if (Array.isArray(pricedata)) {
    for (const p of pricedata) {
      if (typeof p !== "object" || p === null) continue;
      const pr = p as Record<string, unknown>;
      const rec = pr["recurring"];
      if (
        pr["unit_amount"] === amount &&
        rec !== null &&
        typeof rec === "object" &&
        (rec as Record<string, unknown>)["interval_count"] === recurring.interval_count &&
        typeof pr["id"] === "string"
      ) {
        return pr["id"] as string;
      }
    }
  }
  const price = await stripeRequest(client, "POST", "prices", {
    product: productId,
    unit_amount: amount,
    currency,
    recurring,
  });
  if (typeof price["id"] !== "string") throw stripeGenericError();
  const priceId = price["id"] as string;
  try {
    getDbWrite()
      .prepare(
        "INSERT INTO pay_gateway_product (cache_key, name, external_product_id, external_price_id, created_at, updated_at, pay_gateway_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(cacheKey, productName, productId, priceId, nowTimestamp(), nowTimestamp(), gatewayId);
  } catch {
    const winner = db
      .prepare("SELECT external_price_id FROM pay_gateway_product WHERE pay_gateway_id = ? AND cache_key = ?")
      .get(gatewayId, cacheKey) as { external_price_id: string } | undefined;
    if (winner) return winner.external_price_id;
  }
  return priceId;
}

/** In-process mutex standing in for PHP's DBAL NamedLock (see header):
 * each waiter chains on the previous holder's completion promise. */
const stripeLocks = new Map<string, Promise<void>>();

async function withStripeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = stripeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  stripeLocks.set(key, prev.then(() => current));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function stripeOneTimeHtml(cfg: AdapterConfig, inv: PaymentInvoiceView): Promise<string> {
  const client = stripeClient(cfg);
  const intentParams: Record<string, unknown> = {
    amount: stripeAmountMinor(inv.total, inv.currency),
    currency: inv.currency.toLowerCase(),
    description: stripeInvoiceTitle(inv),
    automatic_payment_methods: { enabled: true },
    receipt_email: inv.buyer.email ?? "",
    metadata: {
      client_id: String(inv.client_id),
      invoice_id: String(inv.id),
      gateway_id: String(cfg["gateway_id"]),
    },
  };
  const idempotencyKey = `one_time_invoice_${inv.id}_gateway_${cfg["gateway_id"]}_${createHash("sha256").update(phpJsonEncode(intentParams)).digest("hex")}`;
  const intent = await stripeRequest(client, "POST", "payment_intents", intentParams, idempotencyKey);
  const secret = intent["client_secret"];
  if (typeof secret !== "string") throw stripeGenericError();
  const b = inv.buyer;
  return strtr(STRIPE_ONE_TIME_FORM, {
    ":pub_key": stripePubKey(cfg),
    ":intent_secret": secret,
    ":buyer_email": encodeJsString(b.email ?? ""),
    ":buyer_name": encodeJsString(`${b.first_name ?? ""} ${b.last_name ?? ""}`.trim()),
    ":callbackUrl": String(cfg["notify_url"]),
    ":invoice_hash": inv.hash,
  });
}

async function stripeSubscriptionHtml(cfg: AdapterConfig, inv: PaymentInvoiceView): Promise<string> {
  const client = stripeClient(cfg);
  return withStripeLock(`gen_subscription_form_invoice_${inv.id}`, async () => {
    const customerId = await stripeGetOrCreateCustomer(client, Number(cfg["gateway_id"]), inv);
    const priceId = await stripeGetOrCreatePriceId(client, Number(cfg["gateway_id"]), inv);
    const setupParams: Record<string, unknown> = {
      customer: customerId,
      allowed_payment_method_types: ["card"],
      usage: "off_session",
      metadata: {
        invoice_id: String(inv.id),
        price_id: priceId,
        gateway_id: String(cfg["gateway_id"]),
      },
    };
    const idempotencyKey = `setup_invoice_${inv.id}_gateway_${cfg["gateway_id"]}_${createHash("sha256").update(phpJsonEncode(setupParams)).digest("hex")}`;
    const setup = await stripeRequest(client, "POST", "setup_intents", setupParams, idempotencyKey);
    const secret = setup["client_secret"];
    if (typeof secret !== "string") throw stripeGenericError();
    const b = inv.buyer;
    return strtr(STRIPE_SUBSCRIPTION_FORM, {
      ":pub_key": stripePubKey(cfg),
      ":setup_intent_secret": secret,
      ":buyer_email": encodeJsString(b.email ?? ""),
      ":buyer_name": encodeJsString(`${b.first_name ?? ""} ${b.last_name ?? ""}`.trim()),
      ":callbackUrl": String(cfg["notify_url"]),
      ":invoice_hash": inv.hash,
    });
  });
}

// --- Dispatcher -------------------------------------------------------------

/**
 * processInvoice's getHtml branch. Returns the adapter HTML plus the
 * iframe flag from the adapter's static getConfig (Custom: true, the
 * others: no can_load_in_iframe key -> false).
 */
export async function getPaymentHtml(
  gw: GatewayRow,
  inv: PaymentInvoiceView,
  subscription: boolean,
): Promise<{ iframe: boolean; html: string }> {
  const cfg = adapterConfig(gw, inv);
  if (gw.gateway === "Custom") {
    return { iframe: true, html: customHtml(cfg, inv, subscription) };
  }
  if (gw.gateway === "PayPalEmail") {
    return { iframe: false, html: paypalHtml(cfg, inv, subscription) };
  }
  if (gw.gateway === "Stripe") {
    const html = subscription
      ? await stripeSubscriptionHtml(cfg, inv)
      : await stripeOneTimeHtml(cfg, inv);
    return { iframe: false, html };
  }
  throw new FbError(
    `Payment adapter ${gw.gateway} is not supported by the TypeScript port.`,
  );
}
