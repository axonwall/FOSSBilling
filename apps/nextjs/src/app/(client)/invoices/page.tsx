import { clientApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface InvoiceRow {
  id: number;
  serie?: string;
  nr?: string;
  serie_nr?: string;
  hash?: string;
  currency?: string;
  total?: string | number;
  status?: string;
  created_at?: string;
  due_at?: string;
}

/**
 * Client invoice list — calls client/invoice/get_list with the visitor's
 * PHP session cookie forwarded server-side. Redirects are intentionally
 * left to a later phase; an unauthenticated visitor sees the API error.
 */
export default async function InvoicesPage() {
  const opts = await sessionOpts();
  let rows: InvoiceRow[] = [];
  let error: string | null = null;
  try {
    const data = (await clientApi.invoiceList(
      { page: 1, per_page: 25 },
      opts,
    )) as { list?: InvoiceRow[] } | InvoiceRow[];
    rows = Array.isArray(data) ? data : (data.list ?? []);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">My invoices</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error} — sign in through the PHP client area first (session sharing is Phase 1
          work in progress).
        </p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Number</th>
              <th>Total</th>
              <th>Status</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inv) => (
              <tr key={inv.id} className="border-b">
                <td className="py-2">
                  {inv.hash ? (
                    <a className="text-blue-700 underline" href={`/invoices/${inv.hash}`}>
                      {inv.serie_nr ?? `${inv.serie ?? ""}${inv.nr ?? inv.id}`}
                    </a>
                  ) : (
                    (inv.serie_nr ?? `${inv.serie ?? ""}${inv.nr ?? inv.id}`)
                  )}
                </td>
                <td>
                  {inv.total ?? ""} {inv.currency ?? ""}
                </td>
                <td>{inv.status ?? ""}</td>
                <td>{inv.due_at ?? inv.created_at ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="py-3 text-zinc-500" colSpan={4}>
                  No invoices.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
