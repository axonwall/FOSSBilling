import {
  adminGroupIdsFor,
  findAdminFullById,
  listAdminGroups,
  listAdminPairs,
  listAdmins,
  type AdminFullRow,
  type AdminGroupRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { paginate } from "../util";

/**
 * Staff module (admin reads) — TS port of Staff/Api/Admin.php read
 * methods. The API-level staff shape excludes api_token and embeds the
 * admin's groups (with computed path/depth/parent_name), mirroring the
 * PHP service output in captures7. Staff mutations and group management
 * are not ported yet (they intersect the permissions model).
 */

function groupArray(g: AdminGroupRow, all: AdminGroupRow[]) {
  const byId = new Map(all.map((x) => [x.id, x]));
  const chain: string[] = [];
  let depth = 0;
  let cur: AdminGroupRow | undefined = g;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur.name);
    if (cur.parent_id) {
      depth += 1;
      cur = byId.get(cur.parent_id);
    } else {
      break;
    }
  }
  let permissions: unknown = [];
  if (g.permissions) {
    try {
      permissions = JSON.parse(g.permissions);
    } catch {
      permissions = [];
    }
  }
  return {
    id: g.id,
    name: g.name,
    system_name: g.system_name,
    parent_id: g.parent_id,
    parent_name: g.parent_id ? (byId.get(g.parent_id)?.name ?? null) : null,
    path: chain.join(" / "),
    depth,
    permissions,
    protected: !!g.protected,
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
}

export function staffArray(row: AdminFullRow) {
  const all = listAdminGroups();
  const groups = adminGroupIdsFor(row.id)
    .map((id) => all.find((g) => g.id === id))
    .filter((g): g is AdminGroupRow => !!g)
    .map((g) => groupArray(g, all));
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    system_name: row.system_name,
    status: row.status,
    signature: row.signature,
    timezone: row.timezone,
    created_at: row.created_at,
    updated_at: row.updated_at,
    groups,
  };
}

register("admin", "staff", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginate(listAdmins().map(staffArray), ctx.params);
});

register("admin", "staff", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Staff ID was not passed");
  const row = findAdminFullById(Number(id));
  if (!row) throw new FbError("Staff member not found");
  return staffArray(row);
});

register("admin", "staff", "get_pairs", (ctx: CallContext) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const p of listAdminPairs()) out[String(p.id)] = p.name ?? "";
  return out;
});

register("admin", "staff", "is_super_administrator", (ctx: CallContext) => {
  requireAdmin(ctx);
  const all = listAdminGroups();
  const mine = adminGroupIdsFor(ctx.session!.admin!.id);
  return mine.some((id) => all.find((g) => g.id === id)?.system_name === "super_admin");
});
