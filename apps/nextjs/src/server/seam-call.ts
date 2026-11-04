/**
 * Shared TS-seam dispatch pipeline (R6a).
 *
 * This is the exact pipeline the HTTP seam route used to run inline
 * (route.ts, pre-R6a), factored out so the Next UI pages can call it
 * in-process (decision D6-7) instead of posting to the PHP dispatcher:
 *   pre-auth limiter -> CSRF -> removed-endpoint hoist -> identity
 *   201 -> post-auth limiter -> dispatcher gates (715/725/403) ->
 *   per-endpoint limiter -> handler (or magic handler, or 740/9998).
 *
 * Both entry points run this function, so the HTTP seam and the
 * server-component pages cannot drift apart:
 *   - route.ts: HTTP framing only (body parsing, cookie/session
 *     reading, 429 rendering, error envelopes, 879 for non-API
 *     paths). It calls dispatchSeamCall for 3-segment paths with a
 *     valid role.
 *   - lib/fossbilling.ts fbCall: builds the CallContext from its
 *     options (session cookie + CSRF token) and unwraps the result.
 *
 * Gate order mirrors PHP's Api\Dispatcher (see findings-r6a.md for
 * the precedence table): activation 715 before permission 725
 * before method-existence 740, and the route-hoisted removal error
 * before all of them (except pre-auth limiter + CSRF, as before).
 * The one deliberate difference from PHP: the HTTP status is always
 * 200 with the code in the envelope (seam-wide convention) — PHP
 * renders 740 as HTTP 404, 201 as 401, 879 as 400. Compare envelopes,
 * never HTTP status (except the R5g real-429, which keeps its 429).
 */
import {
  FbError,
  enforceCsrf,
  envelope,
  findHandler,
  findMagicHandler,
  type CallContext,
} from "./dispatch";
import {
  enforcePerEndpointLimit,
  enforcePostAuthLimit,
  enforcePreAuthLimit,
} from "./ratelimit";
import { enforceDispatcherGates } from "./guards";
import { REMOVED_SYSTEM_ADMIN } from "./modules/system";
import {
  REMOVED_EXTENSION_ADMIN,
  REMOVED_EXTENSION_GUEST,
} from "./modules/extension";
import { REMOVED_THEME_ADMIN } from "./modules/theme";
// Side-effect import: populates the handler registry for in-process
// callers (server-component pages), which never import the HTTP route.
import "@/server/modules";

export const VALID_ROLES = new Set(["admin", "client", "guest"]);

/**
 * Expand form-encoded bracket keys (new_item[price], items[490][title],
 * ids[0]) into nested objects — the shape PHP builds natively from
 * $_POST/$_GET and JSON bodies already carry in rawParams. R6b: the
 * route previously left rawParams EMPTY for urlencoded bodies, so
 * every handler reading a nested object from rawParams (invoice
 * update's new_item/items, refund/debit items, theme client) silently
 * dropped form-posted nested params while returning success — the
 * shadow harness caught invoice update losing its line. Expansion
 * applies to rawParams ONLY: params keeps the flat literal keys, so
 * handlers that expand specific bracket keys themselves (cart
 * staffAddParams, client/email ids[]) are unaffected. Values stay
 * strings (PHP form values are strings too); CSRFToken is skipped
 * (auth material, enforced separately from params/header).
 */
/** PHP form parsing turns `a[0]=x&a[1]=y` (and `a[][x]` sequences)
 * into a LIST, not a map with "0"/"1" keys — Admin::debit does
 * `array_values($items)` on exactly that shape. The builder above
 * only ever produces plain objects, so a post-order pass converts
 * any object whose keys are exactly 0..n-1 (canonical integers, so
 * "01" or id-keyed maps like invoice update's items[490] never
 * convert) into a real array. Without this, every handler that
 * requires an array from rawParams (debit items, support
 * batch_delete ids) 9998s/throws on form posts while JSON posts
 * work — the goldens batch's debit probe proved it (PHP minted
 * note 490, TS answered "Debit items are missing"). */
export function arraysFromNumericKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(arraysFromNumericKeys);
  if (typeof v !== "object" || v === null) return v;
  const entries = Object.entries(v).map(([k, val]) => [k, arraysFromNumericKeys(val)] as const);
  const keys = entries.map(([k]) => k);
  if (
    keys.length > 0 &&
    keys.every((k) => String(Number(k)) === k && Number.isInteger(Number(k)) && Number(k) >= 0)
  ) {
    const sorted = [...entries].sort(([a], [b]) => Number(a) - Number(b));
    if (sorted.every(([k], i) => Number(k) === i)) return sorted.map(([, val]) => val);
  }
  return Object.fromEntries(entries);
}

export function expandBracketParams(
  params: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "CSRFToken") continue;
    const m = /^([^\[]+)((?:\[[^\]]*\])*)$/.exec(k);
    if (!m) {
      out[k] = v;
      continue;
    }
    const parts = [m[1]];
    for (const seg of m[2].matchAll(/\[([^\]]*)\]/g)) parts.push(seg[1]);
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i] === "" ? String(Object.keys(cur).length) : parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p]))
        cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  }
  return arraysFromNumericKeys(out) as Record<string, unknown>;
}

/** PHP router error for paths the API router does not recognize. */
export function unknownApiError(path: string[]): FbError {
  return new FbError(`Unknown API call ${path.join("/")}`, 879);
}

function roleTitle(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Runs the full TS pipeline for one 3-segment API call and returns
 * the Response to send (envelope, or the handler's raw Response for
 * binary/text endpoints, with the handler's setCookies appended).
 * Throws FbError (740/9998/715/725/403/201/removal) or
 * RateLimitError; the caller renders those (route: errorEnvelope /
 * real 429; lib: FbApiError).
 */
export async function dispatchSeamCall(
  ctx: CallContext,
  roleIn: string,
  moduleIn: string,
  methodIn: string,
  presentedCsrf: string | undefined,
): Promise<Response> {
  const role = roleIn.toLowerCase();
  const module = moduleIn.toLowerCase();
  const method = methodIn.toLowerCase();

  // Handler resolution is a pure registry lookup (no side effects),
  // so it happens up front exactly as the old route did — before
  // the gates, which need gateMethod for the magic case.
  const exact = findHandler(role, module, method);
  const magic =
    !exact && role === "admin" && module === "servicecustom" && method !== "__call"
      ? findMagicHandler(role, module)
      : undefined;
  const gateMethod = magic ? "__call" : method;
  const handler = exact ?? (magic ? (c: CallContext) => magic(c, method) : undefined);

  const methodKey = `${module}_${method}`;
  const isRemoved =
    (role === "admin" && module === "system" && REMOVED_SYSTEM_ADMIN.includes(method)) ||
    (role === "admin" && module === "extension" && REMOVED_EXTENSION_ADMIN.includes(method)) ||
    (role === "admin" && module === "theme" && REMOVED_THEME_ADMIN.includes(method)) ||
    (role === "guest" && module === "extension" && REMOVED_EXTENSION_GUEST.includes(method));

  // R5g limiter layering, mirroring Client.php _apiCall order.
  await enforcePreAuthLimit(role, methodKey, ctx);
  enforceCsrf(ctx, presentedCsrf);
  if (!isRemoved) {
    if (role === "admin" && !ctx.session?.admin) throw new FbError("Authentication Failed", 201);
    if (role === "client" && !ctx.session?.client) throw new FbError("Authentication Failed", 201);
    await enforcePostAuthLimit(role, methodKey, ctx);
    // R2a dispatcher gates (Api\Dispatcher order: identity 201,
    // activation 715, admin module access 725, method guards 403).
    await enforceDispatcherGates(ctx, role, module, gateMethod);
    await enforcePerEndpointLimit(role, module, method, ctx);
  }

  if (isRemoved) {
    // Removed endpoints keep their registered removal handlers, so
    // this branch normally invokes one and its removal error
    // propagates. The fallback covers a hypothetical unregistered
    // removal entry with the same message shape.
    if (!handler) {
      throw new FbError(`Endpoint ${role}/${module}/${method} was removed in the Next.js port.`);
    }
    const result = await handler(ctx);
    if (result instanceof Response) {
      for (const c of ctx.setCookies) result.headers.append("set-cookie", c);
      return result;
    }
    const res = envelope(result);
    for (const c of ctx.setCookies) res.headers.append("set-cookie", c);
    return res;
  }

  if (!handler) {
    if (role === "admin" && module === "servicecustom" && method === "__call") {
      // PHP's Dispatcher reaches __call (method_exists is true) and
      // then crashes calling it with 1 arg instead of 2: 9998, NOT
      // 740. TS mirrors the code; the message omits PHP's file path
      // (a deployment-dependent leak — TS has no PHP file to cite).
      throw new FbError(
        "Too few arguments to function Box\\Mod\\Servicecustom\\Api\\Admin::__call(), 1 passed and exactly 2 expected",
        9998,
      );
    }
    throw new FbError(
      `${roleTitle(role)} API call ${method} does not exist in module ${module}`,
      740,
    );
  }

  const result = await handler(ctx);
  // Binary/text endpoints return a full Response: pass it through
  // verbatim (plus handler cookies), never wrapped in the envelope.
  if (result instanceof Response) {
    for (const c of ctx.setCookies) result.headers.append("set-cookie", c);
    return result;
  }
  const res = envelope(result);
  for (const c of ctx.setCookies) res.headers.append("set-cookie", c);
  return res;
}
