import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface GroupRow {
  id: number;
  name?: string;
  path?: string;
  parent_name?: string | null;
  protected?: boolean;
  created_at?: string;
}

export default async function AdminGroupListPage() {
  const opts = await sessionOpts();
  let rows: GroupRow[] = [];
  let error: string | null = null;
  try {
    const data = (await adminApi.staffGroupList(opts)) as { list?: GroupRow[] };
    rows = data.list ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/staff" className="text-sm text-blue-700 underline">
        ← Staff
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Staff groups</h1>
      <p className="mt-2 text-sm">
        <Link className="text-blue-700 underline" href="/admin/staff/groups/new">
          New group
        </Link>
      </p>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Name</th>
              <th>Path</th>
              <th>Parent</th>
              <th>Protected</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/admin/staff/groups/${g.id}`}>
                    {g.name}
                  </Link>
                </td>
                <td>{g.path ?? ""}</td>
                <td>{g.parent_name ?? ""}</td>
                <td>{g.protected ? "yes" : ""}</td>
                <td>{g.created_at ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
