import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface StaffGroup {
  id: number;
  name?: string;
  path?: string;
}

interface StaffRow {
  id: number;
  email?: string;
  name?: string;
  system_name?: string;
  status?: string;
  created_at?: string;
  groups?: StaffGroup[];
}

export default async function AdminStaffPage() {
  const opts = await sessionOpts();
  let rows: StaffRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<StaffRow>(await adminApi.staffList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Staff</h1>
      <p className="mt-2 flex gap-4 text-sm">
        <Link className="text-blue-700 underline" href="/admin/staff/new">
          New staff member
        </Link>
        <Link className="text-blue-700 underline" href="/admin/staff/groups">
          Groups
        </Link>
      </p>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Groups</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/admin/staff/${s.id}`}>
                    {s.name}
                  </Link>
                </td>
                <td>{s.email}</td>
                <td>{s.status ?? ""}</td>
                <td>{(s.groups ?? []).map((g) => g.name).join(", ")}</td>
                <td>{s.created_at ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
