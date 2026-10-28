import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";
import StaffEditForm, { type StaffEditable } from "./StaffEditForm";
import StaffPasswordForm from "./StaffPasswordForm";
import StaffGroupsForm from "./StaffGroupsForm";
import StaffDeleteButton from "./StaffDeleteButton";

export const dynamic = "force-dynamic";

interface StaffGroup {
  id: number;
  name?: string;
  path?: string;
}

interface StaffDetail extends StaffEditable {
  id: number;
  system_name?: string;
  created_at?: string;
  updated_at?: string;
  groups?: StaffGroup[];
}

interface HistoryItem {
  id: number;
  ip?: string;
  created_at?: string;
  staff?: { id?: number };
}

export default async function AdminStaffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let s: StaffDetail | null = null;
  let error: string | null = null;
  let pairs: Record<string, string> = {};
  let history: HistoryItem[] = [];
  try {
    s = (await adminApi.staffGet(id, opts)) as StaffDetail;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (s) {
    try {
      pairs = (await adminApi.staffGroupPairs(opts)) as Record<string, string>;
    } catch {
      pairs = {};
    }
    try {
      const all = listOf<HistoryItem>(
        await adminApi.staffLoginHistory({ page: 1, per_page: 50 }, opts),
      ).list;
      history = all.filter((h) => h.staff?.id === s!.id).slice(0, 10);
    } catch {
      history = [];
    }
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/staff" className="text-sm text-blue-700 underline">
        ← Staff
      </Link>
      {error || !s ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error ?? "Staff member not found."} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.</p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{s.name}</h1>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Email", s.email],
                ["Status", s.status],
                ["System name", s.system_name],
                ["Groups", (s.groups ?? []).map((g) => g.name).join(", ")],
                ["Staff since", s.created_at],
              ] as [string, unknown][]
            )
              .filter(([, v]) => v !== undefined && v !== null && v !== "")
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
          <StaffEditForm staffId={s.id} initial={s} />
          <StaffPasswordForm staffId={s.id} />
          <StaffGroupsForm staffId={s.id} groups={s.groups ?? []} pairs={pairs} />
          {history.length > 0 && (
            <div className="mt-8">
              <h2 className="text-lg font-semibold">Recent logins</h2>
              <table className="mt-2 w-full text-left text-sm">
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id} className="border-b">
                      <td className="py-1">{h.ip ?? ""}</td>
                      <td>{h.created_at ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.system_name !== "cron" && <StaffDeleteButton staffId={s.id} />}
        </>
      )}
    </main>
  );
}
