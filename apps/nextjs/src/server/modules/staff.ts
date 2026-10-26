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

// --- Mutations + group management (Phase 2 batch 4). Messages/codes
// mirror Staff Api/Service incl. the 788954 duplicate-email code and
// the 403 super-admin group guard. PHP hashes with password_hash
// (bcrypt $2y$ cost 12); bcryptjs emits $2b$, which PHP's
// password_verify accepts — new hashes are interchangeable.

function isSuperAdmin(ctx: CallContext): boolean {
  const all = listAdminGroups();
  return adminGroupIdsFor(ctx.session!.admin!.id).some(
    (id) => all.find((g) => g.id === id)?.system_name === "super_admin",
  );
}

function requireSuperAdminGroups(ctx: CallContext) {
  if (!isSuperAdmin(ctx)) {
    throw new FbError("Only super administrators can manage staff groups", 403);
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

function getStaffOrThrow(idRaw: string | undefined): AdminFullRow {
  if (!idRaw) throw new FbError("ID was not passed");
  const row = findAdminFullById(Number(idRaw));
  if (!row) throw new FbError("Staff member not found");
  return row;
}

function getGroupOrThrow(idRaw: string | undefined): AdminGroupRow {
  if (!idRaw) throw new FbError("Group ID was not passed");
  const row = findAdminGroupById(Number(idRaw));
  if (!row) throw new FbError("Group not found");
  return row;
}

register("admin", "staff", "create", (ctx: CallContext) => {
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
  const group = findAdminGroupById(Number(groupIdRaw));
  if (!group) throw new FbError("Group not found");
  if (findAdminByEmail(email)) {
    throw new FbError(`Staff member with email ${email} is already registered.`, 788954);
  }
  const id = insertAdmin({
    email,
    pass: bcrypt.hashSync(password, 12),
    name,
    status: (ctx.params["status"] ?? "inactive").toLowerCase(),
    signature: ctx.params["signature"] ?? null,
    timezone: ctx.params["timezone"] ?? null,
  });
  addAdminToGroup(id, group.id);
  return id;
});

register("admin", "staff", "update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const row = getStaffOrThrow(ctx.params["id"]);
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
    const clash = findAdminByEmail(ctx.params["email"]);
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
  updateAdminRow(row.id, fields);
  return true;
});

register("admin", "staff", "delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const row = getStaffOrThrow(ctx.params["id"]);
  if (row.system_name === "cron") {
    throw new FbError("The cron administrator account cannot be removed");
  }
  deleteAdminRow(row.id);
  return true;
});

register("admin", "staff", "change_password", (ctx: CallContext) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("ID was not passed");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password required");
  const confirm = ctx.params["password_confirm"];
  if (!confirm) throw new FbError("Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertStrongPassword(password);
  const row = getStaffOrThrow(ctx.params["id"]);
  updateAdminRow(row.id, { pass: bcrypt.hashSync(password, 12) });
  return true;
});

register("admin", "staff", "group_create", (ctx: CallContext) => {
  requireAdmin(ctx);
  requireSuperAdminGroups(ctx);
  const name = ctx.params["name"];
  if (!name) throw new FbError("Group name was not passed");
  let parentId: number;
  if (ctx.params["parent_id"]) {
    parentId = getGroupOrThrow(ctx.params["parent_id"]).id;
  } else {
    const root = listAdminGroups().find((g) => g.system_name === "super_admin");
    parentId = root ? root.id : 0;
  }
  return insertAdminGroup(name, parentId);
});

register("admin", "staff", "group_get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const group = getGroupOrThrow(ctx.params["id"]);
  return groupArray(group, listAdminGroups());
});

register("admin", "staff", "group_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const all = listAdminGroups();
  return { list: all.map((g) => groupArray(g, all)) };
});

register("admin", "staff", "group_update", (ctx: CallContext) => {
  requireAdmin(ctx);
  requireSuperAdminGroups(ctx);
  const group = getGroupOrThrow(ctx.params["id"]);
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
  updateAdminGroupRow(group.id, fields);
  return true;
});

register("admin", "staff", "group_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  requireSuperAdminGroups(ctx);
  const group = getGroupOrThrow(ctx.params["id"]);
  if (group.protected) throw new FbError("Protected staff groups cannot be removed");
  if (countAdminGroupMembers(group.id) > 0) {
    throw new FbError("Cannot remove group which has staff members");
  }
  if (listAdminGroups().some((g) => g.parent_id === group.id)) {
    throw new FbError("Cannot remove group which has child groups");
  }
  deleteAdminGroupRow(group.id);
  return true;
});

register("admin", "staff", "group_member_add", (ctx: CallContext) => {
  requireAdmin(ctx);
  const adminId = ctx.params["admin_id"];
  if (!adminId) throw new FbError("Staff member ID was not passed");
  const group = getGroupOrThrow(ctx.params["group_id"]);
  const staff = getStaffOrThrow(adminId);
  if (!adminGroupIdsFor(staff.id).includes(group.id)) addAdminToGroup(staff.id, group.id);
  return true;
});

register("admin", "staff", "group_member_remove", (ctx: CallContext) => {
  requireAdmin(ctx);
  const adminId = ctx.params["admin_id"];
  if (!adminId) throw new FbError("Staff member ID was not passed");
  const group = getGroupOrThrow(ctx.params["group_id"]);
  const staff = getStaffOrThrow(adminId);
  removeAdminFromGroup(staff.id, group.id);
  return true;
});

register("admin", "staff", "group_member_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const group = getGroupOrThrow(ctx.params["group_id"]);
  return listAdmins()
    .filter((a) => adminGroupIdsFor(a.id).includes(group.id))
    .map(staffArray);
});

register("admin", "staff", "admin_group_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const adminId = ctx.params["admin_id"];
  if (!adminId) throw new FbError("Staff member ID was not passed");
  const all = listAdminGroups();
  return adminGroupIdsFor(Number(adminId))
    .map((id) => all.find((g) => g.id === id))
    .filter((g): g is AdminGroupRow => !!g)
    .map((g) => groupArray(g, all));
});

register("admin", "staff", "login_history_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const items = listAdminLoginHistory().map((h) => {
    const item: Record<string, unknown> = { id: h.id, ip: h.ip, created_at: h.created_at };
    if (h.staff_id !== null && h.staff_id !== undefined) {
      item["staff"] = { id: h.staff_id, name: h.staff_name, email: h.staff_email };
    }
    return item;
  });
  return paginate(items, ctx.params);
});

register("admin", "staff", "group_get_pairs", (ctx: CallContext) => {
  requireAdmin(ctx);
  const all = listAdminGroups();
  const out: Record<string, string> = {};
  for (const g of all) out[String(g.id)] = groupArray(g, all).path;
  return out;
});

register("admin", "staff", "login_history_get", (ctx: CallContext) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Event ID was not passed");
  const row = findAdminLoginHistoryById(Number(ctx.params["id"]));
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
function invalidateAdminSessions(adminId: number): void {
  for (const row of listSessionRows()) {
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
      deleteSessionRow(row.id);
    }
  }
}

register("guest", "staff", "login", (ctx: CallContext) => {
  const email = ctx.params["email"];
  if (!email) throw new FbError("Email required");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password required");
  if (!isValidEmail(email)) throw new FbError("Email address is invalid");
  // IP allowlist: skipped — the reference install has no mod_staff
  // config row, so PHP skips the check too (documented).
  const auth = findAdminAuthByEmail(email);
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
    updateAdminRow(auth.id, { pass: bcrypt.hashSync(password, 12) });
  }
  insertAdminLoginHistory(auth.id, ctx.ip);
  loginAsAdmin(ctx, { id: auth.id, email: auth.email, name: auth.name });
  return { id: auth.id, email: auth.email, name: auth.name };
});

register("guest", "staff", "passwordreset", (ctx: CallContext) => {
  const email = ctx.params["email"];
  if (!email) throw new FbError("Email required");
  if (!isValidEmail(email)) throw new FbError("Email address is invalid");
  // Rate limiters are disabled on the reference install and the
  // antispam captcha is unset (checkCaptcha no-op) — both skipped.
  const admin = findAdminByEmail(email);
  if (!admin || admin.status !== "active" || admin.system_name === "cron") return true;
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  replaceAdminPasswordReset(admin.id, hash, ctx.ip);
  getOrCreateTemplateId("mod_staff_password_reset_request", {});
  queueTemplatedEmail(
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

register("guest", "staff", "update_password", (ctx: CallContext) => {
  const code = ctx.params["code"];
  if (!code) throw new FbError("Code required");
  const password = ctx.params["password"];
  if (!password) throw new FbError("Password required");
  const confirm = ctx.params["password_confirm"];
  if (!confirm) throw new FbError("Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertStrongPassword(password);
  const reset = findAdminPasswordResetByHash(code);
  if (!reset) {
    throw new FbError("The link has expired or you have already confirmed the password reset.");
  }
  const createdMs = reset.created_at ? Date.parse(reset.created_at.replace(" ", "T") + "Z") : NaN;
  if (Number.isNaN(createdMs) || createdMs + 900 * 1000 < Date.now()) {
    throw new FbError("The link has expired or you have already confirmed the password reset.");
  }
  const admin = reset.admin_id ? findAdminFullById(reset.admin_id) : undefined;
  if (!admin || admin.status !== "active" || admin.system_name === "cron") {
    throw new FbError("The link has expired or you have already confirmed the password reset.");
  }
  deleteAdminPasswordResets(admin.id);
  updateAdminRow(admin.id, { pass: bcrypt.hashSync(password, 12) });
  invalidateAdminSessions(admin.id);
  getOrCreateTemplateId("mod_staff_password_reset_approve", {});
  queueTemplatedEmail(
    "mod_staff_password_reset_approve",
    admin.email,
    {
      c: { id: admin.id, email: admin.email, name: admin.name, signature: admin.signature },
    },
    { toName: admin.name, adminId: admin.id },
  );
  return null;
});

