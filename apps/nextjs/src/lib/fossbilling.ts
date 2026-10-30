/**
 * Typed client for the FOSSBilling dispatcher API.
 *
 * Contract (verified against src/modules/Api/Controller/Client.php and
 * src/library/FOSSBilling/Api/Dispatcher.php):
 *   POST|GET /api/<role>/<module>/<method>     role: guest | client | admin
 *   Envelope: { result: <mixed>, error: { message, code } | null }
 *
 * Transport (R6a, decision D6-7): IN-PROCESS dispatch. fbCall runs the
 * same seam pipeline as the HTTP route (server/seam-call.ts:
 * limiter, CSRF, gates, handler) directly, with no HTTP round-trip
 * and no PHP. The pages that use this client are all server
 * components, so importing server code is safe; there are no
 * client-component callers of fbCall (browser code uses
 * lib/browser.ts fbPost/fbPostJson through /api/fb instead).
 *
 * Auth models:
 *   - Server-component pages forward the request's session cookie
 *     (lib/session.ts sessionOpts) plus the CSRFToken cookie value;
 *     the seam enforces the pair exactly as the HTTP route does.
 *   - adminBasicAuth (HTTP Basic "email:api_token", which the PHP API
 *     mapped to a synthetic session) is NOT supported by the TS seam
 *     — session-cookie auth only — and fbCall throws if it is passed.
 *     No caller uses it today (verified by grep); it is kept in the
 *     options type so a future caller fails loudly, not silently.
 *
 * Params: values are stringified (the old urlencoded wire shape);
 * rawParams is empty, matching what the HTTP route passes handlers
 * for urlencoded bodies. The method option (GET vs POST) is accepted
 * and ignored — handlers never branch on the verb.
 */

import { dispatchSeamCall } from "@/server/seam-call";
import { readSession } from "@/server/session";
import { FbError as DispatchFbError } from "@/server/dispatch";
import { RateLimitError } from "@/server/ratelimit";

export type FbRole = "guest" | "client" | "admin";

export interface FbError {
  message: string;
  code?: number | string;
}

export class FbApiError extends Error {
  code?: number | string;
  constructor(error: FbError) {
    super(error.message);
    this.name = "FbApiError";
    this.code = error.code;
  }
}

export interface CallOptions {
  /** NOT supported by the TS seam (session-cookie auth only) — throws if passed. */
  adminBasicAuth?: { email: string; apiToken: string };
  /** Raw Cookie header to forward (session flows). */
  cookieHeader?: string;
  /** CSRF token from the CSRFToken cookie. */
  csrfToken?: string;
  /** Accepted and ignored — handlers never branch on the verb. */
  method?: "GET" | "POST";
}

/**
 * Server-side call to the TS seam, in-process. Returns the unwrapped
 * `result`. Throws FbApiError on any seam error (including 740s,
 * 715s, 403s, and the R5g 429, whose Retry-After is not surfaced
 * here — pages never hit limited endpoints).
 */
export async function fbCall<T = unknown>(
  role: FbRole,
  module: string,
  method: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  if (options.adminBasicAuth) {
    throw new FbApiError({
      message: "adminBasicAuth is not supported by the TS seam (session-cookie auth only)",
      code: 9999,
    });
  }
  const stringParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) stringParams[k] = String(v);
  }
  const session = await readSession(options.cookieHeader ?? null);
  const callCtx = {
    params: stringParams,
    rawParams: {} as Record<string, unknown>,
    requestUri: `/api/${role}/${module}/${method}`,
    ip: "127.0.0.1",
    session,
    hasSessionCookie: !!options.cookieHeader?.includes("fossbilling_session="),
    setCookies: [] as string[],
  };
  let res: Response;
  try {
    res = await dispatchSeamCall(callCtx, role, module, method, options.csrfToken);
  } catch (e) {
    if (e instanceof RateLimitError) {
      throw new FbApiError({ message: e.message, code: 429 });
    }
    if (e instanceof DispatchFbError) {
      throw new FbApiError({ message: e.message, code: e.code });
    }
    throw new FbApiError({ message: e instanceof Error ? e.message : String(e), code: 9999 });
  }
  // Handlers that return a full Response are binary/text endpoints;
  // pages never call those. A JSON envelope unwraps normally.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new FbApiError({ message: "fbCall cannot unwrap a non-JSON response", code: 9999 });
  }
  const json = (await res.json().catch(() => null)) as
    | { result: T; error: FbError | null }
    | null;
  if (!json || json.error) {
    throw new FbApiError(
      json?.error ?? { message: `FOSSBilling API HTTP ${res.status}`, code: res.status },
    );
  }
  return json.result;
}

/** Convenience wrappers used by the Phase 1 pages. */
export const guest = {
  company: (opts?: CallOptions) => fbCall("guest", "system", "company", {}, opts),
  periods: (opts?: CallOptions) => fbCall("guest", "system", "periods", {}, opts),
};

export const clientApi = {
  invoiceList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("client", "invoice", "get_list", params, opts),
  /** Client-role invoice access is by hash, not id (verified Phase 1). */
  invoiceGet: (hash: string, opts?: CallOptions) =>
    fbCall("client", "invoice", "get", { hash }, opts),
  orderList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("client", "order", "get_list", params, opts),
  orderGet: (id: number | string, opts?: CallOptions) =>
    fbCall("client", "order", "get", { id }, opts),
  helpdeskPairs: (opts?: CallOptions) =>
    fbCall("client", "support", "helpdesk_get_pairs", {}, opts),
  ticketList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("client", "support", "ticket_get_list", params, opts),
  ticketGet: (id: number | string, opts?: CallOptions) =>
    fbCall("client", "support", "ticket_get", { id }, opts),
  profile: (opts?: CallOptions) => fbCall("client", "profile", "get", {}, opts),
};

export const adminApi = {
  getNavigation: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "extension", "get_navigation", params, opts),
  extensionGetList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "extension", "get_list", params, opts),
  extensionConfigGet: (ext: string, opts?: CallOptions) =>
    fbCall("admin", "extension", "config_get", { ext }, opts),
  profile: (opts?: CallOptions) => fbCall("admin", "profile", "get", {}, opts),
  statsSummary: (opts?: CallOptions) => fbCall("admin", "stats", "get_summary", {}, opts),
  statsOrderStatuses: (opts?: CallOptions) =>
    fbCall("admin", "stats", "get_orders_statuses", {}, opts),
  clientList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "client", "get_list", params, opts),
  clientGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "client", "get", { id }, opts),
  orderList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "order", "get_list", params, opts),
  orderGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "order", "get", { id }, opts),
  orderService: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "order", "service", { id }, opts),
  productList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "product", "get_list", params, opts),
  productGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "product", "get", { id }, opts),
  invoiceList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "invoice", "get_list", params, opts),
  invoiceGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "invoice", "get", { id }, opts),
  invoiceTransactionList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "invoice", "transaction_get_list", params, opts),
  ticketList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "support", "ticket_get_list", params, opts),
  ticketGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "support", "ticket_get", { id }, opts),
  staffList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "staff", "get_list", params, opts),
  staffGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "staff", "get", { id }, opts),
  staffPairs: (opts?: CallOptions) => fbCall("admin", "staff", "get_pairs", {}, opts),
  staffIsSuperAdmin: (opts?: CallOptions) =>
    fbCall("admin", "staff", "is_super_administrator", {}, opts),
  staffGroupList: (opts?: CallOptions) =>
    fbCall("admin", "staff", "group_get_list", {}, opts),
  staffGroupGet: (id: number | string, opts?: CallOptions) =>
    fbCall("admin", "staff", "group_get", { id }, opts),
  staffGroupMembers: (groupId: number | string, opts?: CallOptions) =>
    fbCall("admin", "staff", "group_member_get_list", { group_id: groupId }, opts),
  staffGroupPairs: (opts?: CallOptions) =>
    fbCall("admin", "staff", "group_get_pairs", {}, opts),
  staffLoginHistory: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall("admin", "staff", "login_history_get_list", params, opts),
  systemGetParams: (opts?: CallOptions) =>
    fbCall<Record<string, string | null>>("admin", "system", "get_params", {}, opts),
  systemUpdateParams: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<boolean>("admin", "system", "update_params", params, opts),
  currencyList: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<{ list: unknown[]; total: number; page: number; per_page: number; pages: number }>(
      "admin",
      "currency",
      "get_list",
      params,
      opts,
    ),
  currencyGetDefault: (opts?: CallOptions) =>
    fbCall<Record<string, unknown>>("admin", "currency", "get_default", {}, opts),
  currencyUpdateRates: (opts?: CallOptions) =>
    fbCall<boolean>("admin", "currency", "update_rates", {}, opts),
  statsSummaryIncome: (opts?: CallOptions) =>
    fbCall<Record<string, number>>("admin", "stats", "get_summary_income", {}, opts),
  statsIncomeVsRefunds: (opts?: CallOptions) =>
    fbCall<{ income: number; refund: number }>("admin", "stats", "get_income_vs_refunds", {}, opts),
  statsProductSummary: (opts?: CallOptions) =>
    fbCall<{ id: number; title: string; orders: number }[]>(
      "admin",
      "stats",
      "get_product_summary",
      {},
      opts,
    ),
  statsProductSales: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<Record<string, number>>("admin", "stats", "get_product_sales", params, opts),
  statsIncome: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<[number, number][]> ("admin", "stats", "get_income", params, opts),
  statsRefunds: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<[number, number][]> ("admin", "stats", "get_refunds", params, opts),
  statsOrders: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<[number, number][]> ("admin", "stats", "get_orders", params, opts),
  statsClients: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<[number, number][]> ("admin", "stats", "get_clients", params, opts),
  statsInvoices: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<[number, number][]> ("admin", "stats", "get_invoices", params, opts),
  statsTickets: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<[number, number][]> ("admin", "stats", "get_tickets", params, opts),
  statsClientCountries: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<Record<string, number>>("admin", "stats", "client_countries", params, opts),
  statsSalesCountries: (params: Record<string, unknown> = {}, opts?: CallOptions) =>
    fbCall<Record<string, number>>("admin", "stats", "sales_countries", params, opts),
};
