import { FbError, type CallContext } from "./dispatch";
import { adminGroupIdsFor, findAdminFullById, listAdminGroups } from "./db";

/**
 * Staff permission model, ported from PHP Staff\Service::hasPermission
 * (src/modules/Staff/Service.php) + AdminGroupMemberRepository
 * (src/modules/Staff/Repository/AdminGroupMemberRepository.php).
 *
 * Data: `admin_group_member` rows join an admin to groups; each group's
 * `permissions` column is JSON keyed by lowercase module name, each
 * value a map of permission key -> boolean-ish. Multi-group membership
 * merges per key with OR (a key granted by any group is granted).
 *
 * PHP semantics, in order:
 *  1. cron admin (admin.system_name = 'cron') -> always true.
 *  2. always-allowed modules (index, dashboard, profile) -> always true,
 *     even for a keyed check.
 *  3. super administrator (member of the group whose system_name is
 *     'super_admin') -> always true.
 *  4. modules whose Service declares can_always_access (page, profile)
 *     skip the module `access` gate, but a keyed check still needs the
 *     key present and truthy in the merged permissions.
 *  5. otherwise the module's `access` key must be truthy; a keyed check
 *     then needs that key present and truthy (with an optional strict
 *     constraint comparison, unused by any Admin.php guard today).
 * Case-sensitive throughout, as in PHP (permission keys are lowercase
 * module names; an unknown module simply has no permissions).
 */

const ALWAYS_ALLOWED = new Set(["index", "dashboard", "profile"]);

/** Modules whose Service::getModulePermissions sets can_always_access. */
const CAN_ALWAYS_ACCESS = new Set(["page", "profile"]);

export type PermissionMap = Record<string, Record<string, unknown>>;

export async function getAdminPermissions(adminId: number): Promise<PermissionMap> {
  const groups = await listAdminGroups();
  const byId = new Map(groups.map((g) => [g.id, g]));
  const merged: PermissionMap = {};
  for (const groupId of await adminGroupIdsFor(adminId)) {
    const group = byId.get(groupId);
    if (!group || !group.permissions) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(group.permissions);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    for (const [mod, modPerms] of Object.entries(parsed as Record<string, unknown>)) {
      if (!modPerms || typeof modPerms !== "object" || Array.isArray(modPerms)) continue;
      merged[mod] ??= {};
      for (const [key, value] of Object.entries(modPerms as Record<string, unknown>)) {
        merged[mod][key] = Boolean(merged[mod][key]) || Boolean(value);
      }
    }
  }
  return merged;
}

export async function isSuperAdmin(adminId: number): Promise<boolean> {
  const groups = await listAdminGroups();
  const byId = new Map(groups.map((g) => [g.id, g]));
  return (await adminGroupIdsFor(adminId)).some((id) => byId.get(id)?.system_name === "super_admin");
}

export async function hasPermission(
  adminId: number,
  module: string,
  key: string | null = null,
  constraint: unknown = null,
): Promise<boolean> {
  const admin = await findAdminFullById(adminId);
  if (!admin) return false;
  if (admin.system_name === "cron") return true;
  if (ALWAYS_ALLOWED.has(module)) return true;
  if (await isSuperAdmin(adminId)) return true;
  const permissions = await getAdminPermissions(adminId);
  if (!CAN_ALWAYS_ACCESS.has(module)) {
    const modPerms = permissions[module];
    if (!modPerms || !modPerms["access"]) return false;
  }
  if (key !== null) {
    const modPerms = permissions[module] ?? {};
    if (!(key in modPerms)) return false;
    if (constraint !== null) return modPerms[key] === constraint;
    return Boolean(modPerms[key]);
  }
  return true;
}

/**
 * Guard: admin identity required (201, as requireAdmin), then the PHP
 * checkPermissions denial (InformationException from
 * checkPermissionsAndThrowException): `You need the "mod" permission
 * to perform this action` or `You need the "mod.key" permission ...`,
 * code 403.
 */
export async function requirePermission(ctx: CallContext, module: string, key?: string | null) {
  const admin = ctx.session?.admin;
  if (!admin) throw new FbError("Authentication Failed", 201);
  const k = key ?? null;
  if (!await hasPermission(admin.id, module, k)) {
    const required = k === null ? module : `${module}.${k}`;
    throw new FbError(`You need the "${required}" permission to perform this action`, 403);
  }
}
