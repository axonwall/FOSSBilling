import type { NextRequest } from "next/server";
import { enforceCsrf, envelope, errorEnvelope, findHandler, tsModulesEnabled } from "@/server/dispatch";
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

  const bodyText =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

  // Strangler seam: serve from TypeScript when the module is ported and
  // enabled. Any failure in the TS path (e.g. DB not configured) falls
  // back to PHP — the seam must never take the API down.
  if (path.length === 3) {
    const [role, module, method] = path.map((s) => s.toLowerCase());
    const handler = tsModulesEnabled().has(module) ? findHandler(role, module, method) : undefined;
    if (handler) {
      try {
        const params: Record<string, string> = {};
        for (const [k, v] of req.nextUrl.searchParams) params[k] = v;
        if (bodyText) {
          const ct = req.headers.get("content-type") ?? "";
          if (ct.includes("json")) {
            for (const [k, v] of Object.entries(JSON.parse(bodyText) as Record<string, unknown>)) {
              params[k] = String(v);
            }
          } else {
            for (const [k, v] of new URLSearchParams(bodyText)) params[k] = v;
          }
        }
        const cookieHeader = req.headers.get("cookie");
        const session = readSession(cookieHeader);
        const callCtx = {
          params,
          session,
          hasSessionCookie: !!cookieHeader?.includes("fossbilling_session="),
          setCookies: [] as string[],
        };
        enforceCsrf(callCtx, params["CSRFToken"] ?? req.headers.get("x-csrf-token") ?? undefined);
        const result = await handler(callCtx);
        const tsResponse = envelope(result);
        for (const c of callCtx.setCookies) tsResponse.headers.append("set-cookie", c);

        if (process.env.FB_PARITY === "1") {
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

  const res = await fetchPhp(req, path, bodyText);

  const out = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
  forwardCookies(res, out);
  return new Response(await res.text(), { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
