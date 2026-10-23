/**
 * Typed client for the FOSSBilling dispatcher API.
 *
 * Contract (verified against src/modules/Api/Controller/Client.php and
 * src/library/FOSSBilling/Api/Dispatcher.php):
 *   POST|GET /api/<role>/<module>/<method>     role: guest | client | admin
 *   Envelope: { result: <mixed>, error: { message, code } | null }
 *
 * Auth models:
 *   - Browser flows use the PHP session cookie (forwarded by the /api/fb
 *     proxy route handler) plus the CSRFToken cookie/header pair.
 *   - Server-to-server admin calls may use HTTP Basic auth with
 *     "email:api_token" (the admin API token), which the PHP API maps to a
 *     synthetic session. Keep those calls server-side only.
 *
 * This client is the single seam of the strangler: as Scope B phases move a
 * module from PHP to TypeScript, only the base URL / transport for that
 * module changes here.
 */

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

const phpBaseUrl = () =>
  (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export interface CallOptions {
  /** Admin API token auth (server-side only). */
  adminBasicAuth?: { email: string; apiToken: string };
  /** Raw Cookie header to forward (session flows). */
  cookieHeader?: string;
  /** CSRF token from the CSRFToken cookie, sent as X-CSRF-Token. */
  csrfToken?: string;
  method?: "GET" | "POST";
}

/**
 * Server-side call to the PHP dispatcher. Returns the unwrapped `result`.
 * Throws FbApiError on an error envelope or a non-2xx response.
 */
export async function fbCall<T = unknown>(
  role: FbRole,
  module: string,
  method: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  const verb = options.method ?? "POST";
  const url = new URL(`/api/${role}/${module}/${method}`, `${phpBaseUrl()}/`);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.adminBasicAuth) {
    const raw = `${options.adminBasicAuth.email}:${options.adminBasicAuth.apiToken}`;
    headers.Authorization = `Basic ${Buffer.from(raw).toString("base64")}`;
  }
  if (options.cookieHeader) headers.Cookie = options.cookieHeader;
  if (options.csrfToken) headers["X-CSRF-Token"] = options.csrfToken;

  let body: BodyInit | undefined;
  if (verb === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    if (options.csrfToken) form.set("CSRFToken", options.csrfToken);
    body = form;
  }

  const res = await fetch(url, { method: verb, headers, body, cache: "no-store" });
  const json = (await res.json().catch(() => null)) as
    | { result: T; error: FbError | null }
    | null;
  if (!res.ok || !json || json.error) {
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
  profile: (opts?: CallOptions) => fbCall("client", "profile", "get", {}, opts),
};
