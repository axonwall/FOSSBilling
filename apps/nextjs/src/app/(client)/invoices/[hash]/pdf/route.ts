import type { NextRequest } from "next/server";

/**
 * Streams the PHP invoice PDF (web route GET /invoice/pdf/<hash>, session
 * authenticated) through the Next origin, forwarding the visitor's
 * cookies. Verified Phase 1: PHP returns a real application/pdf document.
 */
const phpBaseUrl = () =>
  (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ hash: string }> },
) {
  const { hash } = await ctx.params;
  if (!/^[a-z0-9]+$/i.test(hash)) {
    return new Response("Invalid invoice hash", { status: 400 });
  }
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${phpBaseUrl()}/invoice/pdf/${hash}`, { headers, cache: "no-store" });
  const out = new Headers({
    "content-type": res.headers.get("content-type") ?? "application/pdf",
    "content-disposition": res.headers.get("content-disposition") ?? `inline; filename="invoice-${hash}.pdf"`,
  });
  return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
}
