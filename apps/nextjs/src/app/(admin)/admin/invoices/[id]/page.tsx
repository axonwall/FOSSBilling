import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";
import InvoiceActions from "./InvoiceActions";

export const dynamic = "force-dynamic";

interface Line {
  id: number;
  title?: string;
  period?: string;
  quantity?: number;
  price?: string | number;
  total?: string | number;
  type?: string;
}

interface Tx {
  id: number;
  gateway?: string;
  amount?: string | number;
  currency?: string;
  status?: string;
  created_at?: string;
  type?: string;
}

interface Invoice {
  id: number;
  serie_nr?: string;
  hash?: string;
  client_id?: number;
  client?: { first_name?: string; last_name?: string; email?: string };
  buyer?: { first_name?: string; last_name?: string; company?: string; email?: string };
  status?: string;
  currency?: string;
  subtotal?: string | number;
  tax?: string | number;
  total?: string | number;
  taxname?: string;
  taxrate?: string | number;
  created_at?: string;
  due_at?: string;
  paid_at?: string;
  notes?: string;
  text_1?: string;
  text_2?: string;
  lines?: Line[];
  orders?: { id?: number; title?: string }[];
  deletable?: boolean;
  editable?: boolean;
}

export default async function AdminInvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let inv: Invoice | null = null;
  let txs: Tx[] = [];
  let error: string | null = null;
  try {
    inv = (await adminApi.invoiceGet(id, opts)) as Invoice;
    txs = listOf<Tx>(await adminApi.invoiceTransactionList({ invoice_id: id, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/invoices" className="text-sm text-blue-700 underline">
        ← Invoices
      </Link>
      {error || !inv ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Invoice not found."} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.
        </p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{inv.serie_nr ?? `Invoice ${inv.id}`}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {inv.status} · {inv.total} {inv.currency}
            {inv.client_id ? (
              <>
                {" · "}
                <Link href={`/admin/clients/${inv.client_id}`} className="text-blue-700 underline">
                  {inv.client ? `${inv.client.first_name ?? ""} ${inv.client.last_name ?? ""}`.trim() || inv.client.email : `Client ${inv.client_id}`}
                </Link>
              </>
            ) : null}
            {inv.hash ? (
              <>
                {" · "}
                <Link href={`/invoices/${inv.hash}/pdf`} className="text-blue-700 underline">
                  PDF
                </Link>
              </>
            ) : null}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Subtotal", `${inv.subtotal ?? ""} ${inv.currency ?? ""}`],
                ["Tax", `${inv.tax ?? ""} ${inv.currency ?? ""} ${inv.taxname ? `(${inv.taxname} ${inv.taxrate ?? ""}%)` : ""}`],
                ["Created", inv.created_at],
                ["Due", inv.due_at],
                ["Paid", inv.paid_at],
                ["Buyer", inv.buyer ? [inv.buyer.first_name, inv.buyer.last_name, inv.buyer.company, inv.buyer.email].filter(Boolean).join(" ") : undefined],
                ["Notes", inv.notes],
              ] as [string, unknown][]
            )
              .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
          <h2 className="mt-8 text-lg font-semibold">Lines</h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="border-b text-zinc-500">
                <th className="py-2">Title</th>
                <th>Period</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(inv.lines ?? []).map((l) => (
                <tr key={l.id} className="border-b">
                  <td className="py-2">{l.title}</td>
                  <td>{l.period ?? ""}</td>
                  <td>{l.quantity ?? 1}</td>
                  <td>
                    {l.price} {inv.currency}
                  </td>
                  <td>
                    {l.total} {inv.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {txs.length > 0 && (
            <>
              <h2 className="mt-8 text-lg font-semibold">Transactions</h2>
              <table className="mt-2 w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-zinc-500">
                    <th className="py-2">ID</th>
                    <th>Gateway</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {txs.map((t) => (
                    <tr key={t.id} className="border-b">
                      <td className="py-2">{t.id}</td>
                      <td>{t.gateway ?? ""}</td>
                      <td>
                        {t.amount} {t.currency ?? inv.currency}
                      </td>
                      <td>{t.status ?? ""}</td>
                      <td>{t.created_at ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <InvoiceActions invoiceId={inv.id} status={inv.status ?? ""} deletable={!!inv.deletable} />
        </>
      )}
    </main>
  );
}
