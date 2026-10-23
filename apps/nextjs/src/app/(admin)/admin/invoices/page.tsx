import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface InvoiceRow {
  id: number;
  serie_nr?: string;
  client?: { first_name?: string; last_name?: string; email?: string };
  total?: string | number;
  currency?: string;
  status?: string;
  created_at?: string;
  due_at?: string;
}

export default async function AdminInvoicesPage() {
  const opts = await sessionOpts();
  let rows: InvoiceRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<InvoiceRow>(await adminApi.invoiceList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Invoices</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error}</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Number</th>
              <th>Client</th>
              <th>Total</th>
              <th>Status</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inv) => (
              <tr key={inv.id} className="border-b">
                <td className="py-2">{inv.serie_nr ?? inv.id}</td>
                <td>{inv.client ? `${inv.client.first_name ?? ""} ${inv.client.last_name ?? ""}`.trim() || inv.client.email : ""}</td>
                <td>
                  {inv.total} {inv.currency}
                </td>
                <td>{inv.status}</td>
                <td>{inv.due_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
