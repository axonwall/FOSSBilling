import type { SessionInfo } from "./session";

/**
 * Dispatcher for TS-ported modules, speaking the exact FOSSBilling
 * envelope: `{ result, error: null }` or
 * `{ result: null, error: { message, code } }`.
 *
 * Error codes mirror PHP: 201 authentication failed, 403 CSRF invalid,
 * 9999 domain exceptions (FOSSBilling\\Exception default).
 */

export class FbError extends Error {
  constructor(
    message: string,
    readonly code: number = 9999,
  ) {
    super(message);
  }
}

export interface CallContext {
  params: Record<string, string>;
  /** The parsed JSON body when the call was JSON-encoded — nested
   * structures (invoice new_item, items maps) survive here; `params`
   * only carries their stringified form. */
  rawParams: Record<string, unknown>;
  /** Best-effort client IP (first X-Forwarded-For entry, else loopback). */
  ip: string;
  session: SessionInfo | null;
  /** Whether any session cookie was presented (drives CSRF enforcement). */
  hasSessionCookie: boolean;
  /** Uploaded files for multipart/form-data calls, keyed by field name
   * (the $_FILES equivalent; only populated for multipart requests). */
  files?: Record<string, { name: string; type: string; bytes: Buffer }>;
  /** The PHP-equivalent request URI: /api/<role>/<module>/<method> plus
   * the raw query string, as PHP's Request::getRequestUri() returns it
   * for API calls (NOT the /api/fb/... seam path). */
  requestUri: string;
  /** Set-Cookie header values the handler wants on the response (e.g. a
   * freshly created session cookie). The route appends them verbatim. */
  setCookies: string[];
}

/**
 * A handler returns either a JSON-serializable value (wrapped in the
 * envelope by the route) or a full Response for binary/text endpoints
 * (CSV exports, invoice PDFs, file downloads), which the route returns
 * verbatim with the handler's setCookies appended.
 */
export type Handler = (ctx: CallContext) => unknown | Response | Promise<unknown | Response>;

const registry = new Map<string, Handler>();

export function register(role: string, module: string, method: string, handler: Handler) {
  registry.set(`${role}/${module}/${method}`, handler);
}

export function findHandler(role: string, module: string, method: string): Handler | undefined {
  return registry.get(`${role}/${module}/${method}`);
}

/**
 * Magic-method handlers (Phase 5 R4d): PHP Api classes may define
 * __call, which the dispatcher invokes for any method the class does
 * not declare (Dispatcher checks hasMethod('__call') before throwing
 * 740). Only admin/servicecustom registers one today. A magic handler
 * receives the called method name alongside the call context; the
 * route falls back to it when no exact handler exists. It is kept in
 * a separate map so a literal method named "__call" never collides
 * with the fallback itself (see the route's "__call" exclusion).
 */
export type MagicHandler = (ctx: CallContext, method: string) => unknown | Response | Promise<unknown | Response>;

const magicRegistry = new Map<string, MagicHandler>();

export function registerMagic(role: string, module: string, handler: MagicHandler) {
  magicRegistry.set(`${role}/${module}`, handler);
}

export function findMagicHandler(role: string, module: string): MagicHandler | undefined {
  return magicRegistry.get(`${role}/${module}`);
}

/** Modules whose TS implementation is active (env FB_TS_MODULES, comma list). */
export function tsModulesEnabled(): Set<string> {
  return new Set(
    (process.env.FB_TS_MODULES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function envelope(result: unknown): Response {
  return Response.json({ result, error: null });
}

export function errorEnvelope(err: unknown): Response {
  if (err instanceof FbError) {
    return Response.json({ result: null, error: { message: err.message, code: err.code } });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ result: null, error: { message, code: 9999 } });
}

/**
 * PHP required-param check, mirroring both the RequiredParams
 * attribute (Dispatcher::validateRequiredParams) and
 * Validate::checkRequiredParamsForArray: a param is missing when
 * unset, blank (string trims to empty), or empty-and-not-numeric
 * (false, [], null). '0' and 0 pass (numeric). Throws FbError with
 * the PHP message and code (attribute checks carry no code → 9999;
 * body checks carry their explicit code, e.g. 2391, 9958).
 */
export function requireParam(
  params: Record<string, string>,
  name: string,
  message: string,
  code = 9999,
): string {
  const v = params[name];
  if (v === undefined || v === null) throw new FbError(message, code);
  if (typeof v === "string" && v.trim() === "") throw new FbError(message, code);
  if (!isPhpNumeric(v) && isPhpEmpty(v)) throw new FbError(message, code);
  return v;
}

function isPhpNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  return v.trim() !== "" && !Number.isNaN(Number(v));
}

function isPhpEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return true;
  if (typeof v === "string") return v === "" || v === "0";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "number") return v === 0;
  return false;
}

/** Guard: admin identity required (PHP: Authentication Failed / 201). */
export function requireAdmin(ctx: CallContext) {
  if (!ctx.session?.admin) throw new FbError("Authentication Failed", 201);
}

/** Guard: client identity required (PHP: Authentication Failed / 201). */
export function requireClient(ctx: CallContext) {
  if (!ctx.session?.client) throw new FbError("Authentication Failed", 201);
}

/**
 * CSRF double-submit check, mirroring the PHP API controller: when a
 * session is in play, the CSRFToken param must equal the token stored
 * in the session. Mirrors the observed PHP error (403).
 */
export function enforceCsrf(ctx: CallContext, presented: string | undefined) {
  if (!ctx.session) return;
  if (!presented || presented !== ctx.session.csrfToken) {
    throw new FbError("CSRF token invalid", 403);
  }
}
