import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface TicketRow {
  id: number;
  subject?: string;
  status?: string;
  client?: { first_name?: string; last_name?: string; email?: string };
  author_name?: string;
  updated_at?: string;
}

export default async function AdminTicketsPage() {
  const opts = await sessionOpts();
  let rows: TicketRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<TicketRow>(await adminApi.ticketList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Support tickets</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error}</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Subject</th>
              <th>Client</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/admin/tickets/${t.id}`}>
                    {t.subject ?? `Ticket ${t.id}`}
                  </Link>
                </td>
                <td>{t.client ? `${t.client.first_name ?? ""} ${t.client.last_name ?? ""}`.trim() || t.client.email : t.author_name ?? ""}</td>
                <td>{t.status}</td>
                <td>{t.updated_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
