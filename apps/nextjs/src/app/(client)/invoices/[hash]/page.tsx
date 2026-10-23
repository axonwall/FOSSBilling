import Link from "next/link";
import { clientApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface InvoiceLine {
  id: number;
  title?: string;
  quantity?: number;
  price?: string | number;
  total?: string | number;
}

interface Invoice {
  id: number;
  serie_nr?: string;
  hash?: string;
  status?: string;
  currency?: string;
  subtotal?: string | number;
  tax?: string | number;
  total?: string | number;
  due_at?: string;
  paid_at?: string;
  created_at?: string;
  lines?: InvoiceLine[];
}

/** Invoice detail — client-role access is by hash, not id. */
export default async function InvoiceDetailPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const opts = await sessionOpts();
  let inv: Invoice | null = null;
  let error: string | null = null;
  try {
    inv = (await clientApi.invoiceGet(hash, opts)) as Invoice;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/invoices" className="text-sm text-blue-700 underline">
        ← Invoices
      </Link>
      {error || !inv ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Invoice not found."}
        </p>
      ) : (
        <>
          <div className="mt-2 flex items-baseline justify-between">
            <h1 className="text-2xl font-semibold">Invoice {inv.serie_nr ?? inv.id}</h1>
            <a
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white"
              href={`/invoices/${hash}/pdf`}
            >
              Download PDF
            </a>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Status", inv.status],
                ["Issued", inv.created_at],
                ["Due", inv.due_at],
                ["Paid", inv.paid_at],
              ] as [string, unknown][]
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
          <table className="mt-6 w-full text-left text-sm">
            <thead>
              <tr className="border-b text-zinc-500">
                <th className="py-2">Item</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(inv.lines ?? []).map((l) => (
                <tr key={l.id} className="border-b">
                  <td className="py-2">{l.title ?? ""}</td>
                  <td>{l.quantity ?? ""}</td>
                  <td>{l.price ?? ""}</td>
                  <td>{l.total ?? ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="text-sm">
              <tr>
                <td colSpan={3} className="py-2 text-right text-zinc-500">
                  Subtotal
                </td>
                <td>
                  {inv.subtotal} {inv.currency}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="text-right text-zinc-500">
                  Tax
                </td>
                <td>
                  {inv.tax} {inv.currency}
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={3} className="text-right">
                  Total
                </td>
                <td>
                  {inv.total} {inv.currency}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </main>
  );
}
