import type { NextRequest } from "next/server";
import { enforceCsrf, envelope, errorEnvelope, findHandler, tsModulesEnabled } from "@/server/dispatch";
import { enforceDispatcherGates } from "@/server/guards";
import { REMOVED_SYSTEM_ADMIN } from "@/server/modules/system";
import { REMOVED_EXTENSION_ADMIN, REMOVED_EXTENSION_GUEST } from "@/server/modules/extension";
import { REMOVED_THEME_ADMIN } from "@/server/modules/theme";
import { readSession } from "@/server/session";
import "@/server/modules";

/**
 * Same-origin proxy + strangler seam: browser -> Next
 * (/api/fb/<role>/<module>/<method>) -> PHP dispatcher, EXCEPT modules
 * ported to TypeScript (Phase 2+, env FB_TS_MODULES) which are served by
 * the TS implementations in src/server/modules against the same database.
 *
 * Keeps the PHP session cookie + CSRF pair working from the Next origin
 * during the strangler phase, so browser code never talks to PHP directly.
 *
 * FB_PARITY=1: TS-served calls also hit PHP and the parsed envelopes are
 * deep-compared; mismatches are logged as [parity] lines (TS response is
 * still the one returned).
 */

const phpBaseUrl = () =>
  (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

function forwardCookies(res: Response, out: Headers) {
  const all =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter((v): v is string => !!v);
  for (const c of all) out.append("set-cookie", c);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

async function fetchPhp(req: NextRequest, path: string[], bodyText: string | undefined): Promise<Response> {
  const target = new URL(`/api/${path.join("/")}`, `${phpBaseUrl()}/`);
  target.search = req.nextUrl.search;
  const headers = new Headers();
  for (const name of ["cookie", "x-csrf-token", "content-type", "accept"]) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  return fetch(target, {
    method: req.method,
    headers,
    body: bodyText,
    cache: "no-store",
  });
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;

  // Cookie priming: the dispatcher's CSRF cookie (fossbilling_csrf) is set
  // ONLY by PHP web pages, never by API responses (verified live, Phase 1).
  // GET /api/fb/__prime relays the cookies of the PHP login page so the
  // browser holds the CSRF cookie before its first form POST.
  if (path.length === 1 && path[0] === "__prime") {
    const res = await fetch(`${phpBaseUrl()}/login`, { cache: "no-store" });
    const out = new Headers({ "content-type": "application/json" });
    forwardCookies(res, out);
    return new Response(JSON.stringify({ primed: res.ok }), { status: 200, headers: out });
  }

  // Strangler seam: serve from TypeScript when the module is ported and
  // enabled. Any failure in the TS path (e.g. DB not configured) falls
  // back to PHP — the seam must never take the API down. The handler is
  // resolved BEFORE reading the body so multipart requests can be
  // parsed with formData() (req.text() would consume the stream first).
  if (path.length === 3) {
    const [role, module, method] = path.map((s) => s.toLowerCase());
    const handler = tsModulesEnabled().has(module) ? findHandler(role, module, method) : undefined;
    if (handler) {
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
        enforceCsrf(callCtx, params["CSRFToken"] ?? req.headers.get("x-csrf-token") ?? undefined);
        // R2a dispatcher gates (Api\Dispatcher order: identity 201,
        // activation 715, admin module access 725, method guards 403):
        // after CSRF, before the handler. Removed system endpoints are
        // exempt by R1 design, removed extension endpoints by R4a
        // design, and removed theme endpoints by R4c design — they
        // throw the removal error before any auth check, for every
        // caller.
        const isRemoved =
          (role === "admin" && module === "system" && REMOVED_SYSTEM_ADMIN.includes(method)) ||
          (role === "admin" && module === "extension" && REMOVED_EXTENSION_ADMIN.includes(method)) ||
          (role === "admin" && module === "theme" && REMOVED_THEME_ADMIN.includes(method)) ||
          (role === "guest" && module === "extension" && REMOVED_EXTENSION_GUEST.includes(method));
        if (!isRemoved) {
          await enforceDispatcherGates(callCtx, role, module, method);
        }
        const result = await handler(callCtx);
        // Binary/text endpoints return a full Response: pass it through
        // verbatim (plus handler cookies), never wrapped in the envelope.
        if (result instanceof Response) {
          for (const c of callCtx.setCookies) result.headers.append("set-cookie", c);
          return result;
        }
        const tsResponse = envelope(result);
        for (const c of callCtx.setCookies) tsResponse.headers.append("set-cookie", c);

        // Multipart requests carry no replayable bodyText, so the PHP
        // comparison is skipped for them (it would POST an empty body).
        if (process.env.FB_PARITY === "1" && !files) {
          try {
            const phpRes = await fetchPhp(req, path, bodyText);
            const phpJson = await phpRes.clone().json().catch(() => null);
            const tsJson = { result, error: null };
            if (JSON.stringify(sortKeys(phpJson)) !== JSON.stringify(sortKeys(tsJson))) {
              console.error(
                `[parity] MISMATCH ${role}/${module}/${method}\n  php: ${JSON.stringify(phpJson)}\n  ts:  ${JSON.stringify(tsJson)}`,
              );
            } else {
              console.log(`[parity] ok ${role}/${module}/${method}`);
            }
          } catch (e) {
            console.error(`[parity] check failed for ${role}/${module}/${method}:`, e);
          }
        }
        return tsResponse;
      } catch (e) {
        if (e instanceof Error && e.message.includes("FB_DATABASE_PATH")) {
          console.error("[ts-modules] DB not configured, falling back to PHP:", e.message);
        } else {
          return errorEnvelope(e);
        }
      }
    }
  }

  const bodyText =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

  const res = await fetchPhp(req, path, bodyText);

  const out = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
  // PHP sets Content-Disposition on file downloads; forward it so
  // proxied send_file responses keep their attachment filename.
  const disposition = res.headers.get("content-disposition");
  if (disposition) out.set("content-disposition", disposition);
  forwardCookies(res, out);
  // Binary passthrough (invoice PDFs, CSV exports) must not go through
  // res.text(), which mangles non-UTF-8 bytes; JSON is unchanged.
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json") ? await res.text() : await res.arrayBuffer();
  return new Response(body, { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
