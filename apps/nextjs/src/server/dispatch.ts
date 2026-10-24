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
  session: SessionInfo | null;
  /** Whether any session cookie was presented (drives CSRF enforcement). */
  hasSessionCookie: boolean;
  /** Set-Cookie header values the handler wants on the response (e.g. a
   * freshly created session cookie). The route appends them verbatim. */
  setCookies: string[];
}

export type Handler = (ctx: CallContext) => unknown | Promise<unknown>;

const registry = new Map<string, Handler>();

export function register(role: string, module: string, method: string, handler: Handler) {
  registry.set(`${role}/${module}/${method}`, handler);
}

export function findHandler(role: string, module: string, method: string): Handler | undefined {
  return registry.get(`${role}/${module}/${method}`);
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
