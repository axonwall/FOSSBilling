import Link from "next/link";
import { clientApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface TicketRow {
  id: number;
  subject?: string;
  status?: string;
  updated_at?: string;
  helpdesk?: { name?: string };
}

export default async function SupportPage() {
  const opts = await sessionOpts();
  let rows: TicketRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<TicketRow>(await clientApi.ticketList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Support tickets</h1>
        <Link className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white" href="/support/new">
          New ticket
        </Link>
      </div>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error}</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Subject</th>
              <th>Helpdesk</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/support/${t.id}`}>
                    {t.subject ?? `Ticket ${t.id}`}
                  </Link>
                </td>
                <td>{t.helpdesk?.name ?? ""}</td>
                <td>{t.status ?? ""}</td>
                <td>{t.updated_at ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="py-3 text-zinc-500" colSpan={4}>
                  No tickets.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
