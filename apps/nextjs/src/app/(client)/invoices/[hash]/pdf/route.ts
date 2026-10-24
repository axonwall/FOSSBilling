import type { NextRequest } from "next/server";
import { invoicePdfByHash } from "@/server/pdf";

/**
 * Invoice PDF, generated in TS (Phase 4 batch 2) instead of being
 * proxied from PHP's mPDF route. The hash is the capability, as with
 * the guest invoice view. Layout is a clean-room approximation of
 * the PHP document: same data, not a pixel clone.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ hash: string }> },
) {
  const { hash } = await ctx.params;
  if (!/^[a-z0-9]+$/i.test(hash)) {
    return new Response("Invalid invoice hash", { status: 400 });
  }
  const pdf = invoicePdfByHash(hash);
  if (!pdf) {
    return new Response("Invoice not found", { status: 404 });
  }
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="invoice-${hash}.pdf"`,
    },
  });
}
