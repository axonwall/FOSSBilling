// Profile module (Phase 5 R1) — admin + client self-service:
// update, password change, logout, session invalidation, API keys.
// Plus the small R1 mop-ups: support KB toggles + category pairs,
// cron settings/hash, currency cron flag.
//
// Pinned by capture17.py. Notes on fidelity:
// - Password strength mirrors PHP's validator exactly: required,
//   8-256 chars, at least one digit, one lowercase, one
//   uppercase letter. No special-character requirement.
// - Admin vs client change-password messages differ in PHP
//   itself (admin: "New password is required" / "Passwords do
//   not match"; client: "New password required" / "Passwords do
//   not match.") — both forms are reproduced, not unified.
// - PHP's profile password-change rate limiter is NOT mirrored
//   (TS has no limiter yet; see Phase 5 plan R5).
// - Cron settings live in PHP's encrypted extension config;
//   the TS side stores them in the settings table instead,
//   which is also what the TS guest cron trigger reads —
//   self-consistent within the TS stack, divergent from PHP's
//   store. Currency sync_rate likewise defaults to enabled.
// - Support KB toggles read the same encrypted config, so TS
//   returns the no-stored-config defaults (kb enabled, views
//   enabled, suggestions disabled for contact/ticket, false
//   for unknown areas).

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { FbError, register, requireAdmin, requireClient } from "../dispatch";
import {
  findAdminById, findClientByEmail, findClientById, getDb, getDbWrite,
  nowTimestamp, setSettingValue, updateAdminRow,
} from "../db";
import { parseSessionContent } from "../php-serialize";

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateToken(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += TOKEN_CHARS[b % TOKEN_CHARS.length];
  return out;
}

export function assertPasswordStrong(pwd: string | undefined): void {
  if (!pwd) throw new FbError("Password is required.");
  if (pwd.length < 8) throw new FbError("Minimum password length is 8 characters.");
  if (pwd.length > 256) throw new FbError("Maximum password length is 256 characters.");
  if (!/[0-9]/.test(pwd)) throw new FbError("Password must include at least one number.");
  if (!/[a-z]/.test(pwd)) throw new FbError("Password must include at least one lowercase letter.");
  if (!/[A-Z]/.test(pwd)) throw new FbError("Password must include at least one uppercase letter.");
}

export function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new FbError(`Invalid timezone: ${tz}`);
  }
}

export function validateEmail(email: string): string {
  const clean = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new FbError("Email address is invalid");
  return clean;
}

async function deleteSessionRow(id: string): Promise<void> {
  await getDbWrite().prepare("DELETE FROM session WHERE id = ?").run(id);
}

export async function invalidateSessions(type: "admin" | "client", id: number): Promise<void> {
  const rows = await getDb().prepare("SELECT id, content FROM session").all() as unknown as { id: string; content: string | Uint8Array }[];
  for (const row of rows) {
    const content = typeof row.content === "string" ? row.content : new TextDecoder().decode(row.content);
    let attrs: Record<string, unknown> = {};
    try {
      const segments = parseSessionContent(content);
      attrs = (segments["_sf2_attributes"] ?? {}) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (type === "admin") {
      const admin = attrs["admin"] as { id?: unknown } | undefined;
      if (admin && typeof admin.id === "number" && admin.id === id) await deleteSessionRow(row.id);
    } else if (attrs["client_id"] === id) {
      await deleteSessionRow(row.id);
    } else {
      const client = attrs["client"] as { id?: unknown } | undefined;
      if (client && typeof client.id === "number" && client.id === id) await deleteSessionRow(row.id);
    }
  }
}

async function adminPassHash(id: number): Promise<string | null> {
  const row = await getDb().prepare("SELECT pass FROM admin WHERE id = ?").get(id) as { pass: string } | undefined;
  return row?.pass ?? null;
}

async function clientPassHash(id: number): Promise<string | null> {
  const row = await getDb().prepare("SELECT pass FROM client WHERE id = ?").get(id) as { pass: string } | undefined;
  return row?.pass ?? null;
}

// ---------------------------------------------------------------- admin

register("admin", "profile", "update", async (ctx) => {
  requireAdmin(ctx);
  const admin = await findAdminById(ctx.session!.admin!.id);
  if (!admin) throw new FbError("Admin not found");
  const fields: { email?: string; name?: string; signature?: string | null; timezone?: string | null } = {};
  if (ctx.params["email"] !== undefined) fields.email = validateEmail(ctx.params["email"]);
  if (ctx.params["name"] !== undefined) fields.name = ctx.params["name"];
  if (ctx.params["signature"] !== undefined) fields.signature = ctx.params["signature"];
  if (ctx.params["timezone"] !== undefined) {
    validateTimezone(ctx.params["timezone"]);
    fields.timezone = ctx.params["timezone"];
  }
  await updateAdminRow(admin.id, fields);
  return true;
});

register("admin", "profile", "generate_api_key", async (ctx) => {
  requireAdmin(ctx);
  const admin = await findAdminById(ctx.session!.admin!.id);
  if (!admin) throw new FbError("Admin not found");
  await getDbWrite().prepare("UPDATE admin SET api_token = ?, updated_at = ? WHERE id = ?").run(generateToken(32), nowTimestamp(), admin.id);
  await invalidateSessions("admin", admin.id);
  return true;
});

register("admin", "profile", "change_password", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["current_password"]) throw new FbError("Current password is required");
  if (!ctx.params["new_password"]) throw new FbError("New password is required");
  if (!ctx.params["confirm_password"]) throw new FbError("New password confirmation is required");
  assertPasswordStrong(ctx.params["new_password"]);
  if (ctx.params["new_password"] !== ctx.params["confirm_password"]) throw new FbError("Passwords do not match");
  const admin = await findAdminById(ctx.session!.admin!.id);
  if (!admin) throw new FbError("Admin not found");
  const hash = await adminPassHash(admin.id);
  if (!hash || !bcrypt.compareSync(ctx.params["current_password"], hash)) throw new FbError("Current password incorrect");
  await invalidateSessions("admin", admin.id);
  await updateAdminRow(admin.id, { pass: bcrypt.hashSync(ctx.params["new_password"], 12) });
  return true;
});

register("admin", "profile", "destroy_sessions", async (ctx) => {
  requireAdmin(ctx);
  await invalidateSessions("admin", ctx.session!.admin!.id);
  return true;
});

register("admin", "profile", "api_key_reset", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Client ID was not passed");
  const client = await findClientById(parseInt(ctx.params["id"], 10));
  if (!client) throw new FbError("Client not found");
  const token = generateToken(32);
  await getDbWrite().prepare("UPDATE client SET api_token = ? WHERE id = ?").run(token, client.id);
  await invalidateSessions("client", client.id);
  return token;
});

register("admin", "profile", "logout", async (ctx) => {
  requireAdmin(ctx);
  if (ctx.session) await deleteSessionRow(ctx.session.id);
  ctx.setCookies.push("fossbilling_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return true;
});

// ---------------------------------------------------------------- client

const CLIENT_UPDATE_COLS: Record<string, string> = {
  first_name: "first_name", last_name: "last_name", gender: "gender", birthday: "birthday",
  company: "company", company_vat: "company_vat", company_number: "company_number", type: "type",
  address_1: "address_1", address_2: "address_2", postcode: "postcode", city: "city", state: "state",
  country: "country", phone_cc: "phone_cc", phone: "phone", notes: "notes", lang: "lang",
  timezone: "timezone", billing_email: "billing_email", aid: "aid",
};
for (let i = 1; i <= 20; i++) CLIENT_UPDATE_COLS[`custom_${i}`] = `custom_${i}`;

register("client", "profile", "update", async (ctx) => {
  requireClient(ctx);
  const client = await findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  const db = getDbWrite();
  if (ctx.params["email"] !== undefined) {
    const email = validateEmail(ctx.params["email"]);
    const other = await findClientByEmail(email);
    if (other && other.id !== client.id) throw new FbError("This email address is already registered.");
    if (client.email !== email) {
      await db.prepare("UPDATE client SET email = ?, email_approved = NULL WHERE id = ?").run(email, client.id);
      // PHP revokes pending confirmations stored as extension_meta
      // rows (extension mod_client, meta_key confirm_email).
      await db.prepare("DELETE FROM extension_meta WHERE extension = 'mod_client' AND client_id = ? AND meta_key = 'confirm_email'").run(client.id);
    }
  }
  if (ctx.params["billing_email"] !== undefined) {
    const be = ctx.params["billing_email"] === "" ? null : validateEmail(ctx.params["billing_email"]);
    await db.prepare("UPDATE client SET billing_email = ? WHERE id = ?").run(be, client.id);
  }
  const sets: string[] = [];
  const values: (string | null)[] = [];
  for (const [param, col] of Object.entries(CLIENT_UPDATE_COLS)) {
    if (ctx.params[param] !== undefined) {
      if (param === "timezone") validateTimezone(ctx.params[param]);
      sets.push(`${col} = ?`);
      values.push(ctx.params[param]);
    }
  }
  if (sets.length > 0) {
    await db.prepare(`UPDATE client SET ${sets.join(", ")} WHERE id = ?`).run(...values, client.id);
  }
  return true;
});

register("client", "profile", "api_key_get", async (ctx) => {
  requireClient(ctx);
  const client = await findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  const row = await getDb().prepare("SELECT api_token FROM client WHERE id = ?").get(client.id) as { api_token: string | null } | undefined;
  return row?.api_token ?? null;
});

register("client", "profile", "api_key_reset", async (ctx) => {
  requireClient(ctx);
  const client = await findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  const token = generateToken(32);
  await getDbWrite().prepare("UPDATE client SET api_token = ? WHERE id = ?").run(token, client.id);
  await invalidateSessions("client", client.id);
  return token;
});

register("client", "profile", "change_password", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params["current_password"]) throw new FbError("Current password required");
  if (!ctx.params["new_password"]) throw new FbError("New password required");
  if (!ctx.params["confirm_password"]) throw new FbError("New password confirmation required");
  assertPasswordStrong(ctx.params["new_password"]);
  if (ctx.params["new_password"] !== ctx.params["confirm_password"]) throw new FbError("Passwords do not match.");
  const client = await findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  const hash = await clientPassHash(client.id);
  if (!hash || !bcrypt.compareSync(ctx.params["current_password"], hash)) throw new FbError("Current password incorrect");
  await invalidateSessions("client", client.id);
  await getDbWrite().prepare("UPDATE client SET pass = ? WHERE id = ?").run(bcrypt.hashSync(ctx.params["new_password"], 12), client.id);
  return true;
});

register("client", "profile", "logout", async (ctx) => {
  requireClient(ctx);
  if (ctx.session) await deleteSessionRow(ctx.session.id);
  ctx.setCookies.push("fossbilling_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return true;
});

register("client", "profile", "destroy_sessions", async (ctx) => {
  requireClient(ctx);
  await invalidateSessions("client", ctx.session!.client!.id);
  return true;
});

// ---------------------------------------------------------------- mop-ups

register("admin", "support", "kb_category_get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const c of await getDb().prepare("SELECT * FROM support_kb_article_category ORDER BY id ASC").all() as unknown as { id: number; title: string }[]) out[String(c.id)] = c.title;
  return out;
});

register("guest", "support", "kb_enabled", () => true);

register("guest", "support", "kb_suggestions_enabled", (ctx) => {
  // Unknown area -> false; known areas -> stored flag ?? false.
  // With no stored config both paths are false.
  void ctx;
  return false;
});

register("guest", "support", "public_tickets_enabled", () => true);

register("admin", "cron", "save_settings", async (ctx) => {
  requireAdmin(ctx);
  const guestCron = ctx.params["guest_cron"] ? true : false;
  await setSettingValue("cron_guest_enabled", guestCron ? "1" : "0");
  if (guestCron) {
    const existing = await getDb().prepare("SELECT value FROM setting WHERE param = 'cron_hash'").get() as { value: string | null } | undefined;
    if (!existing?.value) await setSettingValue("cron_hash", randomBytes(32).toString("hex"));
  } else {
    await setSettingValue("cron_hash", "");
  }
  return true;
});

register("admin", "cron", "regenerate_cron_hash", async (ctx) => {
  requireAdmin(ctx);
  const hash = randomBytes(32).toString("hex");
  await setSettingValue("cron_hash", hash);
  return { cron_hash: hash };
});

register("admin", "currency", "is_cron_enabled", (ctx) => {
  requireAdmin(ctx);
  return true;
});
