import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ClientRow {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  status?: string;
  created_at?: string;
}

export default async function AdminClientsPage() {
  const opts = await sessionOpts();
  let rows: ClientRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<ClientRow>(await adminApi.clientList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Clients</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error}</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/admin/clients/${c.id}`}>
                    {c.first_name} {c.last_name}
                  </Link>
                </td>
                <td>{c.email}</td>
                <td>{c.status ?? ""}</td>
                <td>{c.created_at ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
