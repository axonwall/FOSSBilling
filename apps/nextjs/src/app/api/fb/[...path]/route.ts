import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { errorEnvelope } from "@/server/dispatch";
import { RateLimitError } from "@/server/ratelimit";
import {
  VALID_ROLES,
  dispatchSeamCall,
  unknownApiError,
} from "@/server/seam-call";
import { readSession } from "@/server/session";

/**
 * TS-only seam (R6a): browser -> Next (/api/fb/<role>/<module>/<method>)
 * -> TS implementations in src/server/modules against the same
 * database. The PHP proxy (fetchPhp) is DELETED: after R6a nothing
 * serves from PHP through the seam.
 *
 * Same-origin CSRF pair: the browser holds fossbilling_csrf (set by
 * __prime below or by login) plus the session cookie; the seam
 * enforces the pair exactly as before (see server/dispatch
 * enforceCsrf: no session -> no check; session -> presented token
 * must equal the session's csrfToken).
 *
 * Error shapes (envelopes, always HTTP 200 except the R5g real-429):
 *   740 unknown method, 715 module not installed/activated, 725
 *   module access denied, 403 method guard / CSRF invalid, 201
 *   authentication failed, 9999 removal + domain errors, 9998
 *   literal admin/servicecustom/__call (mirrors PHP's
 *   ArgumentCountError), 879 unknown API path (non-3-segment or
 *   invalid role — mirrors PHP's router). PHP renders 740 as HTTP
 *   404, 201 as 401, 879 as 400; the seam keeps HTTP 200 + code in
 *   the envelope (seam-wide convention — compare envelopes, never
 *   HTTP status, except the real 429).
 *
 * DB-not-configured (FB_DATABASE_PATH unset) previously fell through
 * to the PHP proxy and silently served PHP data. It now returns the
 * TS error envelope (9999) — a loud failure, not a silent fallback.
 *
 * FB_PARITY=1 is REMOVED with the proxy (its PHP comparison call
 * died with PHP deletion; parity suites + R6b's harness supersede
 * its logging value). The flag is gone, not a no-op.
 */

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;

  // Cookie priming, TS-native (R6a): issue a CSRF cookie without PHP.
  // With a session, the cookie carries the SESSION's csrfToken, so
  // subsequent POSTs pass enforceCsrf. Without a session, a fresh
  // random token is issued (login carries it over or regenerates it
  // — same as TS login's own token issuance). Unlike PHP's /login
  // relay, this sets NO session cookie and creates no session row:
  // priming is CSRF-only. The token format matches TS login's
  // (16 random bytes, hex); PHP's /login issued 32-byte hex tokens.
  if (path.length === 1 && path[0] === "__prime") {
    const cookieHeader = req.headers.get("cookie");
    const session = await readSession(cookieHeader);
    const token = session?.csrfToken ?? randomBytes(16).toString("hex");
    const out = new Headers({ "content-type": "application/json" });
    // Flags mirror TS login's csrf cookie (Path=/, readable by
    // browser JS for ensureCsrf/csrfFromCookie). PHP's /login set
    // samesite=strict; TS login does not — prime matches login.
    out.append("set-cookie", `fossbilling_csrf=${encodeURIComponent(token)}; Path=/`);
    return new Response(JSON.stringify({ primed: true }), { status: 200, headers: out });
  }

  // TS dispatch: 3 segments with a valid role. Anything else is not
  // an API call the router recognizes — PHP's router 879s it
  // ("Unknown API call <path>"), and so does the seam now.
  if (path.length !== 3) {
    return errorEnvelope(unknownApiError(path));
  }
  const [role, module, method] = path.map((s) => s.toLowerCase());
  if (!VALID_ROLES.has(role)) {
    return errorEnvelope(unknownApiError(path));
  }

  // Handler resolution happens inside dispatchSeamCall (pure lookup,
  // before the gates that need gateMethod for the servicecustom magic
  // case). The body is parsed here so multipart requests can use
  // formData() (req.text() would consume the stream first).
  try {
    const params: Record<string, string> = {};
    let rawParams: Record<string, unknown> = {};
    let files: Record<string, { name: string; type: string; bytes: Buffer }> | undefined;
    let bodyText: string | undefined;
    for (const [k, v] of req.nextUrl.searchParams) params[k] = v;
    const contentType = req.headers.get("content-type") ?? "";
    if (req.method !== "GET" && req.method !== "HEAD" && contentType.includes("multipart/form-data")) {
      // Multipart in (servicedownloadable upload/update): text fields
      // land in params/rawParams, files in ctx.files.
      const form = await req.formData();
      files = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") {
          params[k] = v;
          rawParams[k] = v;
        } else {
          files[k] = {
            name: v.name,
            type: v.type,
            bytes: Buffer.from(await v.arrayBuffer()),
          };
        }
      }
    } else {
      bodyText = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
      if (bodyText) {
        const ct = req.headers.get("content-type") ?? "";
        if (ct.includes("json")) {
          rawParams = JSON.parse(bodyText) as Record<string, unknown>;
          for (const [k, v] of Object.entries(rawParams)) {
            params[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
          }
        } else {
          for (const [k, v] of new URLSearchParams(bodyText)) params[k] = v;
        }
      }
    }
    const cookieHeader = req.headers.get("cookie");
    const session = await readSession(cookieHeader);
    const callCtx = {
      params,
      rawParams,
      files,
      requestUri: `/api/${role}/${module}/${method}${req.nextUrl.search}`,
      ip:
        ((req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "127.0.0.1").replace(
          /^::ffff:/,
          "",
        ),
      session,
      hasSessionCookie: !!cookieHeader?.includes("fossbilling_session="),
      setCookies: [] as string[],
    };
    return await dispatchSeamCall(
      callCtx,
      role,
      module,
      method,
      params["CSRFToken"] ?? req.headers.get("x-csrf-token") ?? undefined,
    );
  } catch (e) {
    if (e instanceof RateLimitError) {
      // R5g: PHP renders a REAL HTTP 429 + Retry-After header (in
      // whole seconds) + the envelope body (ApiResponseFactory).
      // This is the seam's one non-200 error shape; every other
      // FbError keeps the HTTP-200 envelope convention.
      // (No handler cookies can exist here: limiter throws precede
      // the handler, so setCookies is always empty on this path.)
      return Response.json(
        { result: null, error: { message: e.message, code: 429 } },
        { status: 429, headers: { "retry-after": String(e.retryAfterSeconds) } },
      );
    }
    return errorEnvelope(e);
  }
}

export { proxy as GET, proxy as POST };
