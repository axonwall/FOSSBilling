import type { NextRequest } from "next/server";

/**
 * Same-origin proxy: browser -> Next (/api/fb/<role>/<module>/<method>)
 * -> FOSSBilling PHP dispatcher (/api/<role>/<module>/<method>).
 *
 * Keeps the PHP session cookie + CSRF pair working from the Next origin
 * during the strangler phase, so browser code never talks to PHP directly.
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

  const target = new URL(`/api/${path.join("/")}`, `${phpBaseUrl()}/`);
  target.search = req.nextUrl.search;

  const headers = new Headers();
  for (const name of ["cookie", "x-csrf-token", "content-type", "accept"]) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }

  const res = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
    cache: "no-store",
  });

  const out = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
  forwardCookies(res, out);
  return new Response(await res.text(), { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
