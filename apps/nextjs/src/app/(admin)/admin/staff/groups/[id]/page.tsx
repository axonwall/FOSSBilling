import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import { isSuperAdmin } from "@/server/permissions";
import GroupDetailsForm from "./GroupDetailsForm";
import GroupPermissionsForm from "./GroupPermissionsForm";
import GroupMembersForm from "./GroupMembersForm";
import GroupDeleteButton from "./GroupDeleteButton";

export const dynamic = "force-dynamic";

interface GroupDetail {
  id: number;
  name?: string;
  system_name?: string;
  parent_id?: number | null;
  parent_name?: string | null;
  path?: string;
  depth?: number;
  permissions?: Record<string, Record<string, unknown>> | unknown[];
  protected?: boolean;
  created_at?: string;
}

interface MemberRow {
  id: number;
  name?: string;
  email?: string;
}

/** Group editor. Access rule (mirrors the PHP group template, which
 *  receives is_super_admin and hides the permission UI otherwise):
 *  non-super viewers get a notice box and NO group data — the editor
 *  form, the matrix, and the members list never render for them, even
 *  when the group read itself succeeded (a Lead holds manage_groups,
 *  so the read passes but the mutation would 403). Protected groups
 *  render read-only for super-admins: the API refuses all
 *  modifications to them. */
export default async function AdminGroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let g: GroupDetail | null = null;
  let error: string | null = null;
  let members: MemberRow[] = [];
  let pairs: Record<string, string> = {};
  let staffPairs: Record<string, string> = {};
  try {
    g = (await adminApi.staffGroupGet(id, opts)) as GroupDetail;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  let superAdmin = false;
  try {
    const session = readSession(opts.cookieHeader ?? null);
    if (session?.admin) superAdmin = isSuperAdmin(session.admin.id);
  } catch {
    superAdmin = false;
  }
  if (g && superAdmin) {
    try {
      members = (await adminApi.staffGroupMembers(g.id, opts)) as MemberRow[];
    } catch {
      members = [];
    }
    try {
      pairs = (await adminApi.staffGroupPairs(opts)) as Record<string, string>;
    } catch {
      pairs = {};
    }
    try {
      staffPairs = (await adminApi.staffPairs(opts)) as Record<string, string>;
    } catch {
      staffPairs = {};
    }
  }
  const permissions =
    g && g.permissions && !Array.isArray(g.permissions)
      ? (g.permissions as Record<string, Record<string, unknown>>)
      : {};
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/staff/groups" className="text-sm text-blue-700 underline">
        ← Groups
      </Link>
      {error || !g ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error ?? "Group not found."} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.</p>
      ) : !superAdmin ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          Only super administrators can manage staff groups.
        </p>
      ) : g.protected ? (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{g.name}</h1>
          <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
            This is a protected system group. Its permissions are controlled by FOSSBilling and cannot be edited.
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <div className="contents">
              <dt className="text-zinc-500">Path</dt>
              <dd>{g.path ?? ""}</dd>
            </div>
            <div className="contents">
              <dt className="text-zinc-500">Parent</dt>
              <dd>{g.parent_name ?? ""}</dd>
            </div>
          </dl>
          <GroupMembersForm groupId={g.id} members={members} readOnly />
        </>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{g.name}</h1>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <div className="contents">
              <dt className="text-zinc-500">Path</dt>
              <dd>{g.path ?? ""}</dd>
            </div>
            <div className="contents">
              <dt className="text-zinc-500">Parent</dt>
              <dd>{g.parent_name ?? ""}</dd>
            </div>
          </dl>
          <GroupDetailsForm groupId={g.id} initialName={g.name ?? ""} parentId={g.parent_id ?? null} pairs={pairs} selfPath={g.path ?? ""} />
          <GroupPermissionsForm groupId={g.id} initial={permissions} />
          <GroupMembersForm groupId={g.id} members={members} staffPairs={staffPairs} />
          <GroupDeleteButton groupId={g.id} />
        </>
      )}
    </main>
  );
}
