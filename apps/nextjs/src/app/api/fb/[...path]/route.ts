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

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
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
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) out.set("set-cookie", setCookie);
  return new Response(await res.text(), { status: res.status, headers: out });
}

export { proxy as GET, proxy as POST };
