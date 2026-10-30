import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import {
  addAdminToGroup,
  adminGroupIdsFor,
  countAdminGroupMembers,
  deleteAdminGroupRow,
  deleteAdminPasswordResets,
  deleteAdminRow,
  deleteSessionRow,
  findAdminAuthByEmail,
  findAdminByEmail,
  findAdminFullById,
  findAdminGroupById,
  findAdminLoginHistoryById,
  findAdminPasswordResetByHash,
  insertAdmin,
  insertAdminGroup,
  insertAdminLoginHistory,
  listAdminGroups,
  listAdminLoginHistory,
  listAdminPairs,
  listAdmins,
  listSessionRows,
  removeAdminFromGroup,
  replaceAdminPasswordReset,
  updateAdminGroupRow,
  updateAdminRow,
  type AdminFullRow,
  type AdminGroupRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { consume } from "../ratelimit";
import { queueTemplatedEmail } from "../emailer";
import { getOrCreateTemplateId } from "../emailDefaults";
import { parseSessionContent } from "../php-serialize";
import { loginAsAdmin } from "../session";
import { paginate } from "../util";

/**
 * Staff module — TS port of Staff/Api/Admin.php + Guest.php (reads,
 * group management, group pairs, login history, and the guest auth
 * trio: login, passwordreset, update_password). The API-level staff
 * shape excludes api_token and embeds the admin's groups (with computed
 * path/depth/parent_name), mirroring the PHP service output in
 * captures7. Parity oracle: capture25.py + parity22.py.
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

export async function staffArray(row: AdminFullRow) {
  const all = await listAdminGroups();
  const groups = (await adminGroupIdsFor(row.id))
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

register("admin", "staff", "get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginate(await Promise.all((await listAdmins()).map(staffArray)), ctx.params);
});

register("admin", "staff", "get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Staff ID was not passed");
  const row = await findAdminFullById(Number(id));
  if (!row) throw new FbError("Staff member not found");
  return await staffArray(row);
});

register("admin", "staff", "get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const p of await listAdminPairs()) out[String(p.id)] = p.name ?? "";
  return out;
});

register("admin", "staff", "is_super_administrator", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const all = await listAdminGroups();
  const mine = await adminGroupIdsFor(ctx.session!.admin!.id);
  return mine.some((id) => all.find((g) => g.id === id)?.system_name === "super_admin");
});

// --- Mutations + group management (Phase 2 batch 4). Messages/codes
// mirror Staff Api/Service incl. the 788954 duplicate-email code and
// the 403 super-admin group guard. PHP hashes with password_hash
// (bcrypt $2y$ cost 12); bcryptjs emits $2b$, which PHP's
// password_verify accepts — new hashes are interchangeable.

async function isSuperAdmin(ctx: CallContext): Promise<boolean> {
  const all = await listAdminGroups();
  return (await adminGroupIdsFor(ctx.session!.admin!.id)).some(
    (id) => all.find((g) => g.id === id)?.system_name === "super_admin",
  );
}

async function requireSuperAdminGroups(ctx: CallContext) {
  if (!await isSuperAdmin(ctx)) {
    throw new FbError("Only super administrators can manage staff groups", 403);
  }
}

// --- Staff hierarchy (Phase 5 R2d) -----------------------------------------
// Port of Staff\Service::assertCanManageAdmin / assertCanManageGroup /
// assertCanRemoveActiveSuperAdministrator + AdminGroupRepository::
// getDescendantIdsForGroups. PHP's hierarchy rules, verified against
// source: cron actors and super administrators bypass everything;
// otherwise a target group must be a STRICT descendant of one of the
// actor's groups (a group is not its own descendant), and a target
// staff member's groups must ALL be strict descendants of the actor's
// groups. These checks were missing from the TS port (a Lead with
// create_and_edit_staff could mint super-admin accounts through the
// seam); the R2d staff pages made them load-bearing, so they land
// here. Order inside handlers mirrors PHP: after the load, after the
// method guard (which the route already enforced), before mutation.

async function actorBypassesHierarchy(ctx: CallContext): Promise<boolean> {
  const actor = await findAdminFullById(ctx.session!.admin!.id);
  if (actor?.system_name === "cron") return true;
  return await isSuperAdmin(ctx);
}

/** Strict descendants of the given groups (children, grandchildren, …). */
async function descendantGroupIds(groupIds: number[]): Promise<number[]> {
  const all = await listAdminGroups();
  const childrenByParent = new Map<number, number[]>();
  for (const g of all) {
    const key = g.parent_id ?? 0;
    const list = childrenByParent.get(key) ?? [];
    list.push(g.id);
    childrenByParent.set(key, list);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const queue = groupIds.flatMap((id) => childrenByParent.get(id) ?? []);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(childrenByParent.get(id) ?? []));
  }
  return out;
}

async function assertCanManageGroup(ctx: CallContext, groupId: number): Promise<void> {
  if (await actorBypassesHierarchy(ctx)) return;
  const descendants = await descendantGroupIds(await adminGroupIdsFor(ctx.session!.admin!.id));
  if (!descendants.includes(groupId)) {
    throw new FbError("You can only manage lower staff groups");
  }
}

async function assertCanManageAdmin(ctx: CallContext, target: AdminFullRow): Promise<void> {
  if (await actorBypassesHierarchy(ctx)) return;
  if (target.id === ctx.session!.admin!.id) {
    throw new FbError("You cannot manage your own staff account here");
  }
  if (target.system_name === "cron") {
    throw new FbError("You can only manage staff accounts in lower groups");
  }
  const targetGroups = await adminGroupIdsFor(target.id);
  if (targetGroups.length === 0) {
    throw new FbError("You can only manage staff accounts in lower groups");
  }
  const descendants = await descendantGroupIds(await adminGroupIdsFor(ctx.session!.admin!.id));
  if (targetGroups.some((id) => !descendants.includes(id))) {
    throw new FbError("You can only manage staff accounts in lower groups");
  }
}

async function assertCanRemoveActiveSuperAdministrator(target: AdminFullRow): Promise<void> {
  if (target.status !== "active") return;
  const all = await listAdminGroups();
  const superGroup = all.find((g) => g.system_name === "super_admin");
  if (!superGroup) return;
  if (!(await adminGroupIdsFor(target.id)).includes(superGroup.id)) return;
  let activeCount = 0;
  for (const a of await listAdmins()) {
    if (a.status === "active" && (await adminGroupIdsFor(a.id)).includes(superGroup.id)) activeCount += 1;
  }
  if (activeCount <= 1) {
    throw new FbError("Cannot remove the last active super administrator");
  }
}

function assertStrongPassword(pw: string | undefined) {
  if (!pw) throw new FbError("Password is required.");
  if (pw.length < 8) throw new FbError("Minimum password length is 8 characters.");
  if (pw.length > 256) throw new FbError("Maximum password length is 256 characters.");
  if (!/[0-9]/.test(pw)) throw new FbError("Password must include at least one number.");
  if (!/[a-z]/.test(pw)) throw new FbError("Password must include at least one lowercase letter.");
  if (!/[A-Z]/.test(pw)) throw new FbError("Password must include at least one uppercase letter.");
}

async function getStaffOrThrow(idRaw: string | undefined): Promise<AdminFullRow> {
  if (!idRaw) throw new FbError("ID was not passed");
  const row = await findAdminFullById(Number(idRaw));
  if (!row) throw new FbError("Staff member not found");
  return row;
}

async function getGroupOrThrow(idRaw: string | undefined): Promise<AdminGroupRow> {
  if (!idRaw) throw new FbError("Group ID was not passed");
  const row = await findAdminGroupById(Number(idRaw));
  if (!row) throw new FbError("Group not found");
  return row;
}

register("admin", "staff", "create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const email = ctx.params["email"];
  if (!email) throw new FbError("Email was not passed");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password was not passed");
  const name = ctx.params["name"];
  if (!name) throw new FbError("Name was not passed");
  const groupIdRaw = ctx.params["group_id"];
  if (!groupIdRaw) throw new FbError("Group ID was not passed");
  assertStrongPassword(password);
  const group = await findAdminGroupById(Number(groupIdRaw));
  if (!group) throw new FbError("Group not found");
  await assertCanManageGroup(ctx, group.id);
  if (await findAdminByEmail(email)) {
    throw new FbError(`Staff member with email ${email} is already registered.`, 788954);
  }
  const id = await insertAdmin({
    email,
    pass: bcrypt.hashSync(password, 12),
    name,
    status: (ctx.params["status"] ?? "inactive").toLowerCase(),
    signature: ctx.params["signature"] ?? null,
    timezone: ctx.params["timezone"] ?? null,
  });
  await addAdminToGroup(id, group.id);
  return id;
});

register("admin", "staff", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const row = await getStaffOrThrow(ctx.params["id"]);
  const fields: Parameters<typeof updateAdminRow>[1] = {};
  let newStatus = row.status ?? "active";
  if (ctx.params["status"] !== undefined) {
    const s = ctx.params["status"].toLowerCase();
    newStatus = s === "active" || s === "inactive" ? s : "active";
    if (ctx.session!.admin!.id === row.id && row.status === "active" && newStatus !== "active") {
      throw new FbError("You cannot deactivate your own staff account");
    }
    fields.status = newStatus;
  }
  if (ctx.params["email"] !== undefined) {
    const clash = await findAdminByEmail(ctx.params["email"]);
    if (clash && clash.id !== row.id) {
      throw new FbError(
        `Staff member with email ${ctx.params["email"]} is already registered.`,
        788954,
      );
    }
    fields.email = ctx.params["email"];
  }
  if (ctx.params["name"] !== undefined) fields.name = ctx.params["name"];
  if (ctx.params["signature"] !== undefined) fields.signature = ctx.params["signature"];
  if (ctx.params["timezone"] !== undefined) fields.timezone = ctx.params["timezone"];
  await assertCanManageAdmin(ctx, row);
  const deactivating = row.status === "active" && newStatus !== "active";
  if (deactivating) await assertCanRemoveActiveSuperAdministrator(row);
  // PHP clears the API token whenever the resulting status is inactive
  // (not only on the active->inactive transition); sessions are
  // invalidated only on the transition itself.
  if (newStatus !== "active") fields.api_token = null;
  await updateAdminRow(row.id, fields);
  if (deactivating) await invalidateAdminSessions(row.id);
  return true;
});

register("admin", "staff", "delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const row = await getStaffOrThrow(ctx.params["id"]);
  if (row.system_name === "cron") {
    throw new FbError("The cron administrator account cannot be removed");
  }
  await assertCanManageAdmin(ctx, row);
  await assertCanRemoveActiveSuperAdministrator(row);
  await deleteAdminPasswordResets(row.id);
  await deleteAdminRow(row.id);
  return true;
});

register("admin", "staff", "change_password", async (ctx: CallContext) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("ID was not passed");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password required");
  const confirm = ctx.params["password_confirm"];
  if (!confirm) throw new FbError("Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertStrongPassword(password);
  const row = await getStaffOrThrow(ctx.params["id"]);
  await assertCanManageAdmin(ctx, row);
  await updateAdminRow(row.id, { pass: bcrypt.hashSync(password, 12) });
  await invalidateAdminSessions(row.id);
  return true;
});

register("admin", "staff", "group_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  await requireSuperAdminGroups(ctx);
  const name = ctx.params["name"];
  if (!name) throw new FbError("Group name was not passed");
  let parentId: number;
  if (ctx.params["parent_id"]) {
    parentId = (await getGroupOrThrow(ctx.params["parent_id"])).id;
  } else {
    const root = (await listAdminGroups()).find((g) => g.system_name === "super_admin");
    parentId = root ? root.id : 0;
  }
  return await insertAdminGroup(name, parentId);
});

register("admin", "staff", "group_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const group = await getGroupOrThrow(ctx.params["id"]);
  return groupArray(group, await listAdminGroups());
});

register("admin", "staff", "group_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const all = await listAdminGroups();
  return { list: all.map((g) => groupArray(g, all)) };
});

register("admin", "staff", "group_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  await requireSuperAdminGroups(ctx);
  const group = await getGroupOrThrow(ctx.params["id"]);
  if (group.protected) throw new FbError("Protected staff groups cannot be modified");
  const fields: Parameters<typeof updateAdminGroupRow>[1] = {};
  if (ctx.params["name"] !== undefined) fields.name = ctx.params["name"];
  if (ctx.params["parent_id"] !== undefined) {
    fields.parent_id = ctx.params["parent_id"] ? Number(ctx.params["parent_id"]) : null;
  }
  if (ctx.params["permissions"] !== undefined) {
    // The PHP admin UI submits permissions as nested form fields, which
    // the flat param map cannot represent; a JSON string is accepted.
    fields.permissions = ctx.params["permissions"] || null;
  }
  // PHP-native nested form shape (R2d parity28): permissions[module][key]
  // arrives as flat keys because the route does not expand brackets, and
  // posting only that shape previously silently left permissions
  // unchanged. Expand it verbatim — PHP stores the array as-is
  // (strings included, minus _submitted, which never matches the
  // two-level pattern) — so seam and PHP read-backs match exactly.
  // A bracket payload wins over a plain permissions param when both
  // are present (a request never mixes them).
  const bracket: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(ctx.params)) {
    const m = /^permissions\[([^\]]+)\]\[([^\]]+)\]$/.exec(k);
    if (m) {
      (bracket[m[1]] ??= {})[m[2]] = v;
    }
  }
  if (Object.keys(bracket).length > 0) {
    fields.permissions = JSON.stringify(bracket);
  }
  await updateAdminGroupRow(group.id, fields);
  return true;
});

register("admin", "staff", "group_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  await requireSuperAdminGroups(ctx);
  const group = await getGroupOrThrow(ctx.params["id"]);
  if (group.protected) throw new FbError("Protected staff groups cannot be removed");
  if (await countAdminGroupMembers(group.id) > 0) {
    throw new FbError("Cannot remove group which has staff members");
  }
  if ((await listAdminGroups()).some((g) => g.parent_id === group.id)) {
    throw new FbError("Cannot remove group which has child groups");
  }
  await deleteAdminGroupRow(group.id);
  return true;
});

register("admin", "staff", "group_member_add", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const adminId = ctx.params["admin_id"];
  if (!adminId) throw new FbError("Staff member ID was not passed");
  const group = await getGroupOrThrow(ctx.params["group_id"]);
  const staff = await getStaffOrThrow(adminId);
  await assertCanManageAdmin(ctx, staff);
  await assertCanManageGroup(ctx, group.id);
  if (!(await adminGroupIdsFor(staff.id)).includes(group.id)) await addAdminToGroup(staff.id, group.id);
  return true;
});

register("admin", "staff", "group_member_remove", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const adminId = ctx.params["admin_id"];
  if (!adminId) throw new FbError("Staff member ID was not passed");
  const group = await getGroupOrThrow(ctx.params["group_id"]);
  const staff = await getStaffOrThrow(adminId);
  await assertCanManageAdmin(ctx, staff);
  await assertCanManageGroup(ctx, group.id);
  // PHP returns true before the super-admin check when not a member.
  if (!(await adminGroupIdsFor(staff.id)).includes(group.id)) return true;
  if (group.system_name === "super_admin") await assertCanRemoveActiveSuperAdministrator(staff);
  await removeAdminFromGroup(staff.id, group.id);
  return true;
});

register("admin", "staff", "group_member_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const group = await getGroupOrThrow(ctx.params["group_id"]);
  const members = [];
  for (const a of await listAdmins()) {
    if ((await adminGroupIdsFor(a.id)).includes(group.id)) members.push(a);
  }
  return await Promise.all(members.map(staffArray));
});

register("admin", "staff", "admin_group_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const adminId = ctx.params["admin_id"];
  if (!adminId) throw new FbError("Staff member ID was not passed");
  const all = await listAdminGroups();
  return (await adminGroupIdsFor(Number(adminId)))
    .map((id) => all.find((g) => g.id === id))
    .filter((g): g is AdminGroupRow => !!g)
    .map((g) => groupArray(g, all));
});

register("admin", "staff", "login_history_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const items = (await listAdminLoginHistory()).map((h) => {
    const item: Record<string, unknown> = { id: h.id, ip: h.ip, created_at: h.created_at };
    if (h.staff_id !== null && h.staff_id !== undefined) {
      item["staff"] = { id: h.staff_id, name: h.staff_name, email: h.staff_email };
    }
    return item;
  });
  return paginate(items, ctx.params);
});

register("admin", "staff", "group_get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const all = await listAdminGroups();
  const out: Record<string, string> = {};
  for (const g of all) out[String(g.id)] = groupArray(g, all).path;
  return out;
});

register("admin", "staff", "login_history_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Event ID was not passed");
  const row = await findAdminLoginHistoryById(Number(ctx.params["id"]));
  if (!row) throw new FbError("Event not found");
  const out: Record<string, unknown> = { id: row.id, ip: row.ip, created_at: row.created_at };
  if (row.staff_id !== null && row.staff_id !== undefined) {
    out["staff"] = { id: row.staff_id, name: row.staff_name, email: row.staff_email };
  }
  return out;
});

// --- Guest staff auth (Staff/Api/Guest.php + Staff/Service.php) -----------

/**
 * Tools::validateAndSanitizeEmail under APP_ENV=dev: RFC validation
 * only (no DNS check). Mirrors the RFC shape closely enough for the
 * envelope contract: one @, non-empty labels, no spaces or empty
 * labels. Single-label domains pass, as they do under RFCValidation.
 */
function isValidEmail(email: string): boolean {
  if (/\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return false;
  const labels = parts[1].split(".");
  for (const label of labels) {
    if (label === "" || label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
  }
  return true;
}

function parseBcryptCost(hash: string | null): number | null {
  if (!hash) return null;
  const m = /^\$2[aby]\$(\d\d)\$/.exec(hash);
  return m ? parseInt(m[1], 10) : null;
}

/** Profile\Service::invalidateSessions for staff identities. */
async function invalidateAdminSessions(adminId: number): Promise<void> {
  for (const row of await listSessionRows()) {
    let admin: unknown;
    try {
      const attrs = parseSessionContent(row.content)["_sf2_attributes"];
      admin =
        attrs && typeof attrs === "object" && !Array.isArray(attrs)
          ? (attrs as Record<string, unknown>)["admin"]
          : undefined;
    } catch {
      continue;
    }
    if (admin && typeof admin === "object" && (admin as Record<string, unknown>)["id"] === adminId) {
      await deleteSessionRow(row.id);
    }
  }
}

register("guest", "staff", "login", async (ctx: CallContext) => {
  const email = ctx.params["email"];
  if (!email) throw new FbError("Email required");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password required");
  if (!isValidEmail(email)) throw new FbError("Email address is invalid");
  // IP allowlist: skipped — the reference install has no mod_staff
  // config row, so PHP skips the check too (documented).
  const auth = await findAdminAuthByEmail(email);
  if (!auth || auth.status !== "active" || auth.system_name === "cron") {
    // PHP runs a dummy verify for timing; the envelope is identical
    // either way, so no dummy hash work is done here.
    throw new FbError("Check your login details", 403);
  }
  if (!auth.pass || !bcrypt.compareSync(password, auth.pass)) {
    throw new FbError("Check your login details", 403);
  }
  // PHP rehashes when password_needs_rehash (bcrypt cost 12 default).
  if (parseBcryptCost(auth.pass) !== 12) {
    await updateAdminRow(auth.id, { pass: bcrypt.hashSync(password, 12) });
  }
  await insertAdminLoginHistory(auth.id, ctx.ip);
  await loginAsAdmin(ctx, { id: auth.id, email: auth.email, name: auth.name });
  return { id: auth.id, email: auth.email, name: auth.name };
});

register("guest", "staff", "passwordreset", async (ctx: CallContext) => {
  const email = ctx.params["email"];
  if (!email) throw new FbError("Email required");
  if (!isValidEmail(email)) throw new FbError("Email address is invalid");
  // R5g silent-limit (PHP Staff Guest::reset_password): a limited ip
  // or email quota returns true, NOT 429, to avoid enumeration. The
  // antispam captcha is unset (checkCaptcha no-op) — still skipped.
  if ((await consume("staff_password_reset_ip", ctx.ip, { requestIp: ctx.ip })).limited) return true;
  if ((await consume("staff_password_reset_email", email, { requestIp: ctx.ip })).limited) return true;
  const admin = await findAdminByEmail(email);
  if (!admin || admin.status !== "active" || admin.system_name === "cron") return true;
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  await replaceAdminPasswordReset(admin.id, hash, ctx.ip);
  await getOrCreateTemplateId("mod_staff_password_reset_request", {});
  await queueTemplatedEmail(
    "mod_staff_password_reset_request",
    admin.email,
    {
      c: { id: admin.id, email: admin.email, name: admin.name, signature: admin.signature },
      hash,
    },
    { toName: admin.name, adminId: admin.id },
  );
  return true;
});

register("guest", "staff", "update_password", async (ctx: CallContext) => {
  const code = ctx.params["code"];
  if (!code) throw new FbError("Code required");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password required");
  const confirm = ctx.params["password_confirm"];
  if (!confirm) throw new FbError("Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertStrongPassword(password);
  const reset = await findAdminPasswordResetByHash(code);
  if (!reset) {
    throw new FbError("The link has expired or you have already confirmed the password reset.");
  }
  const createdMs = reset.created_at ? Date.parse(reset.created_at.replace(" ", "T") + "Z") : NaN;
  if (Number.isNaN(createdMs) || createdMs + 900 * 1000 < Date.now()) {
    throw new FbError("The link has expired or you have already confirmed the password reset.");
  }
  const admin = reset.admin_id ? await findAdminFullById(reset.admin_id) : undefined;
  if (!admin || admin.status !== "active" || admin.system_name === "cron") {
    throw new FbError("The link has expired or you have already confirmed the password reset.");
  }
  await deleteAdminPasswordResets(admin.id);
  await updateAdminRow(admin.id, { pass: bcrypt.hashSync(password, 12) });
  await invalidateAdminSessions(admin.id);
  await getOrCreateTemplateId("mod_staff_password_reset_approve", {});
  await queueTemplatedEmail(
    "mod_staff_password_reset_approve",
    admin.email,
    {
      c: { id: admin.id, email: admin.email, name: admin.name, signature: admin.signature },
    },
    { toName: admin.name, adminId: admin.id },
  );
  return null;
});

