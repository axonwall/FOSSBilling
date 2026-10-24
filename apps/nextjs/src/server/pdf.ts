// Minimal dependency-free PDF writer + invoice document builder.
// The layout is a clean-room approximation of PHP's mPDF invoice:
// same data (header, seller/buyer blocks, item table, totals),
// not a pixel clone.

import { findDefaultCurrency, getDb, getSetting } from "./db";
import { formatCurrencyValue, formatDateValue } from "./twig";

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, " ");
}

interface Line { text: string; size: number; bold?: boolean; gap?: number }

function buildPdf(pages: Line[][]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // ids: 1 catalog, 2 pages, 3 font regular, 4 font bold, then per page: content + page
  let nextId = 5;
  const pageObjs: { pageId: number; contentId: number; lines: Line[] }[] = [];
  for (const lines of pages) {
    const contentId = nextId++;
    const pageId = nextId++;
    pageObjs.push({ pageId, contentId, lines });
    pageIds.push(pageId);
  }
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  for (const p of pageObjs) {
    let stream = "";
    let y = 792;
    for (const line of p.lines) {
      y -= (line.gap ?? line.size + 6);
      stream += `BT /F${line.bold ? 2 : 1} ${line.size} Tf 50 ${y.toFixed(1)} Td (${esc(line.text)}) Tj ET\n`;
    }
    objects[p.contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
    objects[p.pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${p.contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, "latin1");
  const size = objects.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    out += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function invoicePdfByHash(hash: string): Buffer | null {
  const db = getDb();
  const inv = db.prepare("SELECT * FROM invoice WHERE hash = ?").get(hash) as Record<string, unknown> | undefined;
  if (!inv) return null;
  const client = db.prepare("SELECT * FROM client WHERE id = ?").get(inv.client_id as number) as Record<string, unknown> | undefined;
  const items = db.prepare("SELECT * FROM invoice_item WHERE invoice_id = ? ORDER BY id ASC").all(inv.id as number) as unknown as Record<string, unknown>[];
  const sums = db.prepare(
    `SELECT COALESCE(SUM(price * quantity), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN taxed THEN price * quantity ELSE 0 END), 0) AS taxable
     FROM invoice_item WHERE invoice_id = ?`
  ).get(inv.id as number) as { subtotal: number; taxable: number };
  const taxrate = parseFloat(String(inv.taxrate ?? 0)) || 0;
  const tax = Math.round(sums.taxable * taxrate) / 100;
  const total = Math.round((sums.subtotal + tax) * 100) / 100;
  const code = String(inv.currency ?? findDefaultCurrency()?.code ?? "USD");
  const money = (v: number) => formatCurrencyValue(v, code, {});
  const serieNr = `${inv.serie ?? ""}${String(inv.nr ?? inv.id).padStart(5, "0")}`;
  const status = String(inv.status ?? "");
  const company = {
    name: getSetting("company_name") ?? "",
    email: getSetting("company_email") ?? "",
    phone: getSetting("company_phone") ?? "",
    address: [getSetting("company_address_1"), getSetting("company_address_2"), getSetting("company_address_3")].filter(Boolean).join(", "),
    signature: getSetting("company_signature") ?? "",
  };
  const lines: Line[] = [
    { text: `Invoice Number: ${serieNr}`, size: 16, bold: true },
    { text: `Invoice Date: ${formatDateValue(inv.created_at)}`, size: 10 },
    { text: `Due Date: ${formatDateValue(inv.due_at)}`, size: 10 },
    { text: `Invoice Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`, size: 10 },
    { text: "", size: 10 },
    { text: company.name, size: 12, bold: true },
    { text: company.address, size: 10 },
    { text: `Phone : ${company.phone}`, size: 10 },
    { text: company.email, size: 10 },
    { text: "", size: 10 },
    { text: "Client", size: 12, bold: true },
    { text: `${client?.first_name ?? ""} ${client?.last_name ?? ""}`.trim(), size: 10 },
    { text: String(client?.address_1 ?? ""), size: 10 },
    { text: String(client?.city ?? ""), size: 10 },
    { text: `${client?.state ?? ""} ${client?.postcode ?? ""}`.trim(), size: 10 },
    { text: String(client?.country ?? ""), size: 10 },
    { text: `Phone : ${client?.phone_cc ?? ""} ${client?.phone ?? ""}`.trim(), size: 10 },
    { text: `Email: ${client?.email ?? ""}`, size: 10 },
    { text: "", size: 10 },
    { text: "#   Product   Quantity & Price   Total", size: 11, bold: true },
  ];
  items.forEach((it, i) => {
    const qty = Number(it.quantity ?? 1);
    const price = Number(it.price ?? 0);
    lines.push({
      text: `${i + 1}   ${String(it.title ?? "")}   ${qty}x ${money(price)}   ${money(price * qty)}`,
      size: 10,
    });
  });
  lines.push(
    { text: "", size: 10 },
    { text: `Subtotal: ${money(sums.subtotal)}`, size: 10 },
    { text: `Tax: ${money(tax)}`, size: 10 },
    { text: `Total: ${money(total)}`, size: 12, bold: true },
    { text: "", size: 10 },
    { text: company.signature, size: 9 },
  );
  // Simple pagination: 46 lines per page.
  const pages: Line[][] = [];
  for (let i = 0; i < lines.length; i += 46) pages.push(lines.slice(i, i + 46));
  return buildPdf(pages.length ? pages : [[]]);
}
