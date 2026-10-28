import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  clientBalanceSum,
  clientGroups,
  deleteInvoiceCascade,
  deleteOrderCascade,
  findAdminById,
  findClientByEmail,
  findClientById,
  findSession,
  getDb,
  getDbWrite,
  insertSession,
  listClientPairs,
  listClients,
  nowTimestamp,
  updateSessionContent,
  type ClientRow,
} from "../db";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { isClientTaxable } from "../money";
import { parseSessionContent, phpSerialize, replaceSessionSegment } from "../php-serialize";
import { queueTemplatedEmail } from "../emailer";
import { exportCsvResponse, requestedCsvHeaders } from "../csv";
import countriesJson from "../data/countries.json";
import {
  assertPasswordStrong,
  invalidateSessions,
  validateEmail,
  validateTimezone,
} from "./profile";

/**
 * Client entity → API array, mirroring Client::toApiArray() +
 * Client Service::toClientApiArray() field-for-field (order included).
 */

export function clientBaseArray(row: ClientRow) {
  return {
    id: row.id,
    email: row.email,
    email_approved: row.email_approved,
    type: row.type,
    first_name: row.first_name,
    last_name: row.last_name,
    gender: row.gender,
    birthday: row.birthday ? String(row.birthday).slice(0, 10) : null,
    phone_cc: row.phone_cc,
    phone: row.phone,
    company: row.company,
    company_vat: row.company_vat,
    company_number: row.company_number,
    address_1: row.address_1,
    address_2: row.address_2,
    city: row.city,
    state: row.state,
    postcode: row.postcode,
    country: row.country,
    currency: row.currency,
    lang: row.lang,
    timezone: row.timezone,
  };
}

async function adminExtras(row: ClientRow) {
  const groups = await clientGroups(row.id);
  return {
    aid: row.aid,
    group_ids: groups.map((g) => g.id),
    role: row.role,
    auth_type: row.auth_type,
    status: row.status,
    tax_exempt: row.tax_exempt === null ? null : !!row.tax_exempt,
    merge_renewals: row.merge_renewals === null ? null : !!row.merge_renewals,
    notes: row.notes,
    ip: row.ip,
    referred_by: row.referred_by,
    billing_email: row.billing_email,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`custom_${i + 1}`, row[`custom_${i + 1}`] ?? null]),
    ),
    groups,
  };
}

/** Admin single-get shape: base + extras + balance + group info + api_token. */
export async function clientAdminArray(row: ClientRow) {
  const { groups, ...extras } = await adminExtras(row);
  return {
    ...clientBaseArray(row),
    ...extras,
    balance: await clientBalanceSum(row.id),
    group: groups.length ? groups.map((g) => g.title).join(", ") : null,
    client_groups: groups.map((g) => ({ id: g.id, title: g.title })),
    api_token: row.api_token,
  };
}

/** Admin list-item shape: base + extras + balance + group (no client_groups/api_token). */
export async function clientListArray(row: ClientRow) {
  const { groups, ...extras } = await adminExtras(row);
  return {
    ...clientBaseArray(row),
    ...extras,
    balance: await clientBalanceSum(row.id),
    group: groups.length ? groups.map((g) => g.title).join(", ") : null,
  };
}

/** Self shape (profile/get): base + billing_email + balance. */
export async function clientSelfArray(row: ClientRow) {
  return {
    ...clientBaseArray(row),
    billing_email: row.billing_email,
    balance: await clientBalanceSum(row.id),
  };
}

register("client", "profile", "get", async (ctx: CallContext) => {
  requireClient(ctx);
  const row = await findClientById(ctx.session!.client!.id);
  if (!row) throw new FbError("Client not found");
  return await clientSelfArray(row);
});

register("admin", "profile", "get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const row = await findAdminById(ctx.session!.admin!.id);
  if (!row) throw new FbError("Admin not found");
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    signature: row.signature,
    status: row.status,
    api_token: row.api_token,
    timezone: row.timezone,
    created_at: row.created_at ? String(row.created_at).slice(0, 10) : null,
    updated_at: row.updated_at ? String(row.updated_at).slice(0, 10) : null,
  };
});

register("admin", "client", "get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  const email = ctx.params["email"];
  if (!id && !email) throw new FbError("Client ID or email is required");
  const row = id ? await findClientById(Number(id)) : await findClientByEmail(email!);
  if (!row) throw new FbError("Client not found");
  return await clientAdminArray(row);
});

register("admin", "client", "get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const rows = await listClients({
    id: ctx.params["id"],
    name: ctx.params["name"],
    email: ctx.params["email"],
    company: ctx.params["company"],
    status: ctx.params["status"],
    search: ctx.params["search"],
  });
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const total = rows.length;
  const list = await Promise.all(rows.slice((page - 1) * perPage, page * perPage).map(clientListArray));
  return { pages: Math.max(1, Math.ceil(total / perPage)), page, per_page: perPage, total, list };
});

register("admin", "client", "get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const perPageRaw = ctx.params["per_page"] ?? "30";
  const perPage = Number(perPageRaw);
  if (!Number.isFinite(perPage) || perPage < 1) throw new FbError("Invalid per page number");
  const out: Record<string, string> = {};
  for (const p of await listClientPairs(perPage)) out[String(p.id)] = p.name;
  return out;
});

/** Subscription-embedded shape: base + admin extras + group info,
 * without balance or api_token (Invoice Subscription::toApiArray). */
export async function clientSubscriptionArray(row: ClientRow) {
  const { groups, ...extras } = await adminExtras(row);
  return {
    ...clientBaseArray(row),
    ...extras,
    group: groups.length ? groups.map((g) => g.title).join(", ") : null,
    client_groups: groups.map((g) => ({ id: g.id, title: g.title })),
  };
}

// ---------------------------------------------------------------------------
// Client admin CRUD + client/guest auth (Phase 5 R1, core CRUD batch 1).
// Pinned by capture19.py. Notes on fidelity:
// - export_csv is NOT ported: it returns a CSV download, not a JSON
//   envelope, so it needs a download route rather than an API handler.
//   The proxy still serves it from PHP.
// - Guest signup's Antispam temp-email check (default ON) fetches a
//   remote disposable-domain list; TS does not fetch it (same class
//   of gap as the plan's R5 antispam-list decision). In the sandbox
//   the PHP fetch fails at the TLS layer, so capture19 disables the
//   check via PHP's own config API and restores the default after.
// - PHP's rate limiters are dev-disabled on the reference install
//   (enforce_in_development=false), so TS skipping them matches the
//   reference environment; the plan's R5 limiter is still open.
// - Client config (required fields, custom fields, email-confirm
//   requirement, signup toggles) lives in PHP's encrypted extension
//   config, unreadable by TS: TS returns the no-config defaults
//   ([], [], false, signup enabled, auto-login on).
// - Admin balance list amounts are numbers (raw PDO query); the
//   client-scoped list amounts are strings (Doctrine DECIMAL via
//   toApiArray). Both shapes are reproduced, not unified.

async function clientPass(id: number): Promise<string> {
  const r = await getDb().prepare("SELECT pass FROM client WHERE id = ?").get(id) as { pass: string } | undefined;
  return r?.pass ?? "";
}

async function clientOrThrow(id: number): Promise<ClientRow> {
  const row = await findClientById(id);
  if (!row) throw new FbError("Client not found");
  return row;
}

function fullName(row: ClientRow): string {
  return [row.first_name, row.last_name].filter((s) => s).join(" ");
}

function toSessionArray(row: ClientRow) {
  return { id: row.id, email: row.email, name: fullName(row), role: row.role ?? "client" };
}

/** PHP RequiredParams semantics: unset/null, blank string, or an
 * empty non-numeric value all fail; numeric 0 passes. */
function required(ctx: CallContext, name: string, message: string): string {
  const v = ctx.params[name];
  if (v === undefined || v === null || v.trim() === "") throw new FbError(message);
  return v;
}

function arrayParam(ctx: CallContext, name: string): unknown[] | undefined {
  const raw = (ctx.rawParams as Record<string, unknown>)[name];
  if (Array.isArray(raw)) return raw;
  if (raw !== undefined) return [raw];
  // Form-encoded arrays arrive as literal "name[0]", "name[1]" keys —
  // the route does not expand bracket notation, so expand here.
  const bracket: [number, string][] = [];
  for (const [k, v] of Object.entries(ctx.params)) {
    const m = new RegExp(`^${name}\\[(\\d+)\\]$`).exec(k);
    if (m) bracket.push([Number(m[1]), v]);
  }
  if (bracket.length) return bracket.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return undefined;
}

function ucwords(s: string): string {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

// PHP Tools::validatePhoneCC: is_numeric + 1..999, intval'd.
// (is_numeric accepts "1.0" and "1e2"; the digits-only check I first
// wrote rejects "1.0", which PHP accepts.)
function validatePhoneCc(v: string | number): number {
  const s = String(v).trim();
  const n = Number(s);
  if (s === "" || !Number.isFinite(n) || n <= 0 || n > 999) {
    throw new FbError("The provided phone country code does not appear to be valid.");
  }
  return Math.trunc(n);
}

function validatePhone(v: string): string {
  const digits = v.replace(/\D+/g, "");
  if (digits.length < 1 || digits.length > 12) {
    throw new FbError("The provided phone number does not appear to be valid.");
  }
  if (v.startsWith("+")) {
    throw new FbError("Please use the separate field for the phone country code.");
  }
  return digits;
}

function validateBirthday(v: string): void {
  if (v.trim() !== "" && Number.isNaN(Date.parse(v))) {
    throw new FbError("Birthdate: is invalid");
  }
}

// PHP Locales::exists: a real ISO 639-1 language, optionally with a
// real ISO country region. (Symfony's list is a subset of this, but
// every locale the reference install accepts passes this check, and
// the pinned rejects — xx_XX, xx — do not.)
const ISO639_1 = new Set(
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt mu mv my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(" "),
);

function validateLocale(lang: string): void {
  const m = /^([a-z]{2})(?:_([A-Z]{2}))?$/.exec(lang);
  if (!m || !ISO639_1.has(m[1]) || (m[2] && !(m[2] in (countriesJson as Record<string, string>)))) {
    throw new FbError(`Invalid locale code: ${lang}`);
  }
}

function validateCountry(code: string): void {
  if (!(code in (countriesJson as Record<string, string>))) {
    throw new FbError(`Invalid country code: ${code}`);
  }
}

async function setClientGroups(clientId: number, groupIds: unknown[]): Promise<void> {
  const db = getDbWrite();
  const clean: number[] = [];
  for (const g of groupIds) {
    const n = Number(g);
    if (!Number.isInteger(n) || n <= 0) throw new FbError(`Invalid client group ID: ${g}`);
    const exists = await db.prepare("SELECT 1 FROM client_group WHERE id = ?").get(n);
    if (!exists) throw new FbError(`Invalid client group ID: ${g}`);
    if (!clean.includes(n)) clean.push(n);
  }
  await db.prepare("DELETE FROM client_group_members WHERE client_id = ?").run(clientId);
  for (const g of clean) {
    await db.prepare("INSERT INTO client_group_members (client_id, client_group_id) VALUES (?, ?)").run(clientId, g);
  }
}

const CLIENT_SIMPLE_FIELDS = [
  "email", "first_name", "last_name", "aid", "gender", "company", "company_vat",
  "address_1", "address_2", "notes", "country", "postcode", "state", "city",
  "status", "company_number", "type", "lang", "timezone",
  ...Array.from({ length: 20 }, (_, i) => `custom_${i + 1}`),
];

async function insertClientRow(fields: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(fields);
  const placeholders = cols.map(() => "?").join(", ");
  const info = await getDbWrite().insertAndGetId(`INSERT INTO client (${cols.join(", ")}) VALUES (${placeholders})`, ...cols.map((c) => (fields[c] as string | number | null) ?? null));
  return Number(info);
}

/** Shared createClient semantics (admin + guest), minus the
 * role-specific field whitelists and side effects. */
async function createClientRow(
  data: Record<string, string | undefined>,
  ip: string | null,
  groupIds?: unknown[],
): Promise<number> {
  const password = data["password"] ?? randomBytes(16).toString("hex");
  const email = validateEmail(data["email"] ?? "").toLowerCase();
  const billingEmail = data["billing_email"] ? validateEmail(data["billing_email"]).toLowerCase() : null;
  // phone_cc is VARCHAR: node:sqlite binds a JS number into a text
  // column as "1.0" (float formatting), while PHP/PDO stores "1".
  // Store the string form everywhere.
  let phoneCc: string | null = null;
  if (data["phone_cc"]) phoneCc = String(validatePhoneCc(data["phone_cc"]));
  let phone: string | null = null;
  if (data["phone"]) phone = validatePhone(data["phone"]);
  const country = data["country"] ?? null;
  if (country) validateCountry(country);
  const lang = data["lang"] ?? null;
  if (lang) validateLocale(lang);
  if (data["timezone"]) validateTimezone(data["timezone"]);
  const fields: Record<string, unknown> = {
    auth_type: data["auth_type"] ?? null,
    email,
    billing_email: billingEmail,
    first_name: ucwords(data["first_name"] ?? ""),
    pass: bcrypt.hashSync(password, 12),
    status: data["status"] ?? "active",
    gender: data["gender"] ?? null,
    birthday: data["birthday"] ? new Date(data["birthday"]).toISOString().slice(0, 10) : null,
    company: data["company"] ?? null,
    company_vat: data["company_vat"] ?? null,
    company_number: data["company_number"] ?? null,
    type: data["type"] ?? null,
    address_1: data["address_1"] ?? null,
    address_2: data["address_2"] ?? null,
    city: data["city"] ?? null,
    state: data["state"] ?? null,
    postcode: data["postcode"] ?? null,
    country,
    notes: data["notes"] ?? null,
    lang,
    timezone: data["timezone"] ?? null,
    currency: data["currency"] ?? null,
    phone_cc: phoneCc,
    phone,
    aid: data["aid"] ?? null,
    ip,
    created_at: data["created_at"] ?? nowTimestamp(),
    updated_at: nowTimestamp(),
  };
  for (let i = 1; i <= 20; i++) fields[`custom_${i}`] = data[`custom_${i}`] ?? null;
  const id = await insertClientRow(fields);
  if (groupIds !== undefined) await setClientGroups(id, groupIds);
  return id;
}

async function deleteClientCascade(row: ClientRow): Promise<void> {
  const db = getDb();
  const w = getDbWrite();
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const existing = new Set(tables.map((t) => t.name));
  const labels: [string, string][] = [
    ["service_hosting", "hosting"],
    ["service_domain", "domain"],
    ["service_downloadable", "downloadable"],
    ["service_license", "license"],
    ["service_custom", "custom"],
    ["service_apikey", "API keys"],
  ];
  const active: string[] = [];
  for (const [table, label] of labels) {
    if (!existing.has(table)) continue;
    const hit = await db.prepare(`SELECT 1 FROM ${table} WHERE client_id = ? LIMIT 1`).get(row.id);
    if (hit) active.push(label);
  }
  if (active.length) {
    throw new FbError(
      `Client cannot be deleted while they have service records (${active.join(", ")}). Delete their services or orders first, then delete the client.`,
    );
  }
  for (const o of await db.prepare("SELECT id FROM client_order WHERE client_id = ?").all(row.id) as { id: number }[]) {
    await deleteOrderCascade(o.id);
  }
  for (const i of await db.prepare("SELECT id FROM invoice WHERE client_id = ?").all(row.id) as { id: number }[]) {
    await deleteInvoiceCascade(i.id);
  }
  for (const t of await db.prepare("SELECT id FROM support_ticket WHERE client_id = ?").all(row.id) as { id: number }[]) {
    await w.prepare("DELETE FROM support_ticket_message WHERE support_ticket_id = ?").run(t.id);
    await w.prepare("DELETE FROM support_ticket_note WHERE support_ticket_id = ?").run(t.id);
    await w.prepare("DELETE FROM support_ticket WHERE id = ?").run(t.id);
  }
  await w.prepare("DELETE FROM client_balance WHERE client_id = ?").run(row.id);
  await w.prepare("DELETE FROM activity_client_history WHERE client_id = ?").run(row.id);
  await w.prepare("DELETE FROM activity_client_email WHERE client_id = ?").run(row.id);
  await w.prepare("DELETE FROM client_password_reset WHERE client_id = ?").run(row.id);
  await w.prepare("DELETE FROM extension_meta WHERE client_id = ?").run(row.id);
  await w.prepare("DELETE FROM client_group_members WHERE client_id = ?").run(row.id);
  await w.prepare("DELETE FROM client WHERE id = ?").run(row.id);
}

/** Rewrite one session row's attribute bag (impersonation), keeping
 * every other segment byte-for-byte. */
async function rewriteSessionAttrs(sessionId: string, mutate: (attrs: Record<string, unknown>) => void): Promise<void> {
  const row = await findSession(sessionId);
  if (!row) return;
  const segments = parseSessionContent(row.content);
  const attrs = (segments["_sf2_attributes"] ?? {}) as Record<string, unknown>;
  mutate(attrs);
  await updateSessionContent(sessionId, replaceSessionSegment(row.content, "_sf2_attributes", attrs as never));
}

/** Log a client in: new session id (PHP regenerates), same CSRF
 * token carried over, old row dropped, both cookies queued. The guest
 * cart is re-keyed to the new session id first, mirroring PHP
 * Guest::login's transferFromOtherSession call — without it a cart
 * built as a guest is orphaned on the old session and checkout sees
 * an empty cart. */
async function loginClientSession(ctx: CallContext, row: ClientRow) {
  const token = ctx.session?.csrfToken ?? randomBytes(16).toString("hex");
  const id = randomBytes(16).toString("hex");
  const empty = phpSerialize({});
  const content =
    `_sf2_attributes|${phpSerialize({ csrf_token: token, client_id: row.id })}_symfony_flashes|${empty}_sf2_meta|${empty}`;
  await insertSession(id, content, Math.floor(Date.now() / 1000) + 86400);
  if (ctx.session) {
    await getDbWrite().prepare("UPDATE cart SET session_id = ? WHERE session_id = ?").run(id, ctx.session.id);
    await getDbWrite().prepare("DELETE FROM session WHERE id = ?").run(ctx.session.id);
  }
  ctx.setCookies.push(`fossbilling_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  ctx.setCookies.push(`fossbilling_csrf=${token}; Path=/`);
  return toSessionArray(row);
}

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateToken(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += TOKEN_CHARS[b % TOKEN_CHARS.length];
  return out;
}

// --- admin: client CRUD -----------------------------------------------

register("admin", "client", "login", async (ctx) => {
  requireAdmin(ctx);
  const row = await clientOrThrow(Number(required(ctx, "id", "Client ID was not passed")));
  const strip = ["1", "true", "yes", "on"].includes((ctx.params["strip_admin_identity"] ?? "").toLowerCase());
  if (ctx.session) {
    await rewriteSessionAttrs(ctx.session.id, (attrs) => {
      attrs["client_id"] = row.id;
      if (strip) delete attrs["admin"];
    });
  }
  return toSessionArray(row);
});

register("admin", "client", "create", async (ctx) => {
  requireAdmin(ctx);
  const email = required(ctx, "email", "Email required").toLowerCase();
  const firstName = required(ctx, "first_name", "First name is required");
  validateEmail(email);
  if (ctx.params["billing_email"]) validateEmail(ctx.params["billing_email"]);
  if (await findClientByEmail(email)) throw new FbError("This email address is already registered.");
  const sendWelcome = ctx.params["send_welcome_email"] === undefined
    ? true
    : !["0", "false", "no", "off"].includes(ctx.params["send_welcome_email"].toLowerCase());
  const password = (ctx.params["password"] ?? "").trim();
  const status = ctx.params["status"] ?? "active";
  if (!sendWelcome && password === "") {
    throw new FbError("A password is required when the welcome email is disabled.");
  }
  if (sendWelcome && status !== "active") {
    throw new FbError("Welcome email can only be sent for active clients.");
  }
  if (password !== "") assertPasswordStrong(ctx.params["password"]);
  const groupIds = arrayParam(ctx, "group_ids") ?? (ctx.params["group_ids"] ? [ctx.params["group_ids"]] : undefined);
  const id = await createClientRow({ ...ctx.params, email, first_name: firstName }, null, groupIds);
  if (sendWelcome) {
    // Welcome email: a reset row (for the set-password link) plus the
    // template. Failures are swallowed by PHP too (logged, not thrown).
    const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
    await getDbWrite().prepare("DELETE FROM client_password_reset WHERE client_id = ?").run(id);
    await getDbWrite()
      .prepare("INSERT INTO client_password_reset (hash, ip, created_at, updated_at, client_id) VALUES (?, ?, ?, ?, ?)")
      .run(hash, ctx.ip, nowTimestamp(), nowTimestamp(), id);
    await queueTemplatedEmail("mod_client_signup_admin", email, { hash }, { clientId: id });
  }
  return id;
});

register("admin", "client", "update", async (ctx) => {
  requireAdmin(ctx);
  const id = Number(required(ctx, "id", "Client ID was not passed"));
  const row = await clientOrThrow(id);
  const w = getDbWrite();
  const updates: Record<string, unknown> = {};
  const previousStatus = row.status;
  if (ctx.params["email"] !== undefined && ctx.params["email"] !== null) {
    const email = validateEmail(ctx.params["email"]).toLowerCase();
    const other = await findClientByEmail(email);
    if (other && other.id !== row.id) throw new FbError("This email address is already registered.");
    updates["email"] = email;
    if (email !== row.email) {
      await w.prepare("DELETE FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = ?").run(row.id);
    }
  }
  if (ctx.params["billing_email"] !== undefined) {
    updates["billing_email"] = ctx.params["billing_email"] === "" ? null : validateEmail(ctx.params["billing_email"]).toLowerCase();
  }
  if (ctx.params["birthday"] !== undefined && ctx.params["birthday"] !== "") {
    validateBirthday(ctx.params["birthday"]);
  }
  if (ctx.params["currency"] !== undefined) {
    const currency = ctx.params["currency"];
    if (currency && row.currency !== currency) {
      const hasInvoice = await getDb().prepare("SELECT 1 FROM invoice WHERE client_id = ? LIMIT 1").get(row.id);
      if (hasInvoice) throw new FbError("Currency cannot be changed. Client already has invoices issued.");
      const hasOrder = await getDb().prepare("SELECT 1 FROM client_order WHERE client_id = ? LIMIT 1").get(row.id);
      if (hasOrder) throw new FbError("Currency cannot be changed. Client already has orders.");
      updates["currency"] = currency;
    }
  }
  const phoneCc = ctx.params["phone_cc"] ?? (row.phone_cc !== null ? String(row.phone_cc) : undefined);
  if (phoneCc !== undefined && phoneCc !== "") updates["phone_cc"] = String(validatePhoneCc(phoneCc));
  const phone = ctx.params["phone"] ?? row.phone ?? undefined;
  if (phone !== undefined && phone !== "") updates["phone"] = validatePhone(phone);
  if (ctx.params["country"] !== undefined && ctx.params["country"] !== "") validateCountry(ctx.params["country"]);
  if (ctx.params["lang"] !== undefined && ctx.params["lang"] !== "") validateLocale(ctx.params["lang"]);
  if (ctx.params["timezone"] !== undefined && ctx.params["timezone"] !== "" && ctx.params["timezone"] !== null) {
    validateTimezone(ctx.params["timezone"]);
  }
  for (const f of CLIENT_SIMPLE_FIELDS) {
    if (f === "email") continue; // handled above (lowercased + dup-checked)
    if (ctx.params[f] !== undefined) updates[f] = ctx.params[f];
  }
  // group_ids may arrive as a bracket-encoded array (group_ids[0])
  // with no bare group_ids key at all, or as "" (clear all).
  const groupIdsParam = arrayParam(ctx, "group_ids") ??
    (ctx.params["group_ids"] !== undefined ? [ctx.params["group_ids"]] : undefined);
  if (groupIdsParam !== undefined) {
    const ids = groupIdsParam.length === 1 && groupIdsParam[0] === "" ? [] : groupIdsParam;
    await setClientGroups(row.id, ids.filter((g) => g !== "" && g !== null));
  }
  if (ctx.params["email_approved"] !== undefined) {
    updates["email_approved"] = ["1", "true", "yes", "on"].includes(ctx.params["email_approved"].toLowerCase()) ? 1 : 0;
  }
  if (ctx.params["tax_exempt"] !== undefined) {
    updates["tax_exempt"] = ["1", "true", "yes", "on"].includes(ctx.params["tax_exempt"].toLowerCase()) ? 1 : 0;
  }
  if (ctx.params["merge_renewals"] !== undefined) {
    const v = ctx.params["merge_renewals"];
    updates["merge_renewals"] = v === null || v === "" ? null : (["1", "true", "yes", "on"].includes(v.toLowerCase()) ? 1 : 0);
  }
  if (ctx.params["birthday"] !== undefined) {
    updates["birthday"] = ctx.params["birthday"] === "" || ctx.params["birthday"] === null
      ? null
      : new Date(ctx.params["birthday"]).toISOString().slice(0, 10);
  }
  if (ctx.params["created_at"] !== undefined) {
    updates["created_at"] = ctx.params["created_at"] === "" || ctx.params["created_at"] === null ? null : ctx.params["created_at"];
  }
  const newStatus = (updates["status"] as string | undefined) ?? row.status;
  if (newStatus !== "active") updates["api_token"] = null;
  updates["updated_at"] = nowTimestamp();
  const cols = Object.keys(updates);
  if (cols.length) {
    await w.prepare(`UPDATE client SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
      .run(...cols.map((c) => updates[c] as string | number | null), row.id);
  }
  if (newStatus !== "active" && previousStatus === "active") await invalidateSessions("client", row.id);
  return true;
});

register("admin", "client", "delete", async (ctx) => {
  requireAdmin(ctx);
  const raw = ctx.params["id"];
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) throw new FbError("Invalid client ID");
  const row = await clientOrThrow(Number(raw));
  await deleteClientCascade(row);
  return true;
});

register("admin", "client", "batch_delete", async (ctx) => {
  requireAdmin(ctx);
  const ids = arrayParam(ctx, "ids");
  if (!ids || ids.length === 0) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const raw = String(id);
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new FbError("Invalid client ID");
    await deleteClientCascade(await clientOrThrow(Number(raw)));
  }
  return true;
});

register("admin", "client", "change_password", async (ctx) => {
  requireAdmin(ctx);
  const id = required(ctx, "id", "ID required");
  const password = required(ctx, "password", "Password required");
  const confirm = required(ctx, "password_confirm", "Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertPasswordStrong(password);
  const row = await clientOrThrow(Number(id));
  await getDbWrite().prepare("UPDATE client SET pass = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), row.id);
  await invalidateSessions("client", row.id);
  return true;
});

register("admin", "client", "get_statuses", async (ctx) => {
  requireAdmin(ctx);
  const counts = await getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM client GROUP BY status")
    .all() as { status: string; n: number }[];
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const c of counts) {
    byStatus[c.status] = c.n;
    total += c.n;
  }
  return {
    total,
    active: byStatus["active"] ?? 0,
    suspended: byStatus["suspended"] ?? 0,
    canceled: byStatus["canceled"] ?? 0,
  };
});

register("admin", "client", "group_get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const g of await getDb().prepare("SELECT id, title FROM client_group ORDER BY id").all() as { id: number; title: string }[]) {
    out[String(g.id)] = g.title;
  }
  return out;
});

register("admin", "client", "group_create", async (ctx) => {
  requireAdmin(ctx);
  const title = required(ctx, "title", "Group title is missing");
  const info = await getDbWrite().insertAndGetId("INSERT INTO client_group (title, created_at, updated_at) VALUES (?, ?, ?)", title, nowTimestamp(), nowTimestamp());
  return Number(info);
});

register("admin", "client", "group_update", async (ctx) => {
  requireAdmin(ctx);
  const id = Number(required(ctx, "id", "Group ID is missing"));
  const g = await getDb().prepare("SELECT id, title FROM client_group WHERE id = ?").get(id) as { id: number; title: string } | undefined;
  if (!g) throw new FbError("Group not found");
  if (ctx.params["title"] !== undefined) {
    await getDbWrite().prepare("UPDATE client_group SET title = ?, updated_at = ? WHERE id = ?").run(ctx.params["title"], nowTimestamp(), id);
  }
  return true;
});

register("admin", "client", "group_delete", async (ctx) => {
  requireAdmin(ctx);
  const id = Number(required(ctx, "id", "Group ID is missing"));
  const g = await getDb().prepare("SELECT id FROM client_group WHERE id = ?").get(id);
  if (!g) throw new FbError("Group not found");
  const members = await getDb().prepare("SELECT COUNT(*) AS n FROM client_group_members WHERE client_group_id = ?").get(id) as { n: number };
  if (members.n > 0) throw new FbError("Group has clients assigned. Please reassign them first.");
  await getDbWrite().prepare("DELETE FROM client_group WHERE id = ?").run(id);
  return true;
});

register("admin", "client", "group_get", async (ctx) => {
  requireAdmin(ctx);
  const id = Number(required(ctx, "id", "Group ID is missing"));
  const g = await getDb().prepare("SELECT id, title, created_at, updated_at FROM client_group WHERE id = ?").get(id) as
    | { id: number; title: string; created_at: string; updated_at: string }
    | undefined;
  if (!g) throw new FbError("Group not found");
  return g;
});

// --- admin: client balances --------------------------------------------

const BALANCE_SORTS: Record<string, string> = {
  id: "m.id", amount: "m.amount", description: "m.description", created_at: "m.created_at", updated_at: "m.updated_at",
};

async function balanceListQuery(ctx: CallContext, clientId: number | null) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (ctx.params["id"]) {
    where.push("m.id = ?");
    args.push(Number(ctx.params["id"]));
  }
  const cid = clientId ?? (ctx.params["client_id"] ? Number(ctx.params["client_id"]) : null);
  if (cid !== null) {
    where.push("m.client_id = ?");
    args.push(cid);
  }
  // PHP binds strtotime() ints against the text column — an int
  // sorts below every text value in SQLite, so date_from alone is
  // a no-op and date_to alone empties the result. Mirrored, not fixed.
  if (ctx.params["date_from"]) {
    where.push("m.created_at >= ?");
    args.push(Math.floor(Date.parse(ctx.params["date_from"]) / 1000) || 0);
  }
  if (ctx.params["date_to"]) {
    where.push("m.created_at <= ?");
    args.push(Math.floor(Date.parse(ctx.params["date_to"]) / 1000) || 0);
  }
  let order = "m.id DESC";
  const sort = ctx.params["sort"];
  if (sort && BALANCE_SORTS[sort]) {
    const dir = (ctx.params["direction"] ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
    order = `${BALANCE_SORTS[sort]} ${dir}, m.id ${dir}`;
  }
  const q = `SELECT m.*, c.currency AS currency FROM client_balance AS m LEFT JOIN client AS c ON c.id = m.client_id` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY ${order}`;
  return await getDb().prepare(q).all(...args) as Record<string, unknown>[];
}

register("admin", "client", "balance_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await balanceListQuery(ctx, null);
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const list = rows.slice((page - 1) * perPage, page * perPage).map((r) => ({
    id: r["id"],
    description: r["description"],
    amount: Number(r["amount"]),
    currency: r["currency"],
    created_at: r["created_at"],
  }));
  return { pages: Math.max(1, Math.ceil(rows.length / perPage)), page, per_page: perPage, total: rows.length, list };
});

register("admin", "client", "balance_delete", async (ctx) => {
  requireAdmin(ctx);
  const id = required(ctx, "id", "Client ID was not passed");
  const row = await getDb().prepare("SELECT id FROM client_balance WHERE id = ?").get(Number(id));
  if (!row) throw new FbError("Balance line not found");
  await getDbWrite().prepare("DELETE FROM client_balance WHERE id = ?").run(Number(id));
  return true;
});

register("admin", "client", "balance_add_funds", async (ctx) => {
  requireAdmin(ctx);
  const id = required(ctx, "id", "Client ID required");
  const amount = required(ctx, "amount", "Amount is required");
  const description = required(ctx, "description", "Description is required");
  const row = await clientOrThrow(Number(id));
  if (!row.currency) throw new FbError("You must define the client's currency before adding funds.");
  if (Number.isNaN(Number(amount))) throw new FbError("Funds amount is invalid");
  await getDbWrite()
    .prepare("INSERT INTO client_balance (client_id, type, rel_id, amount, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.id, ctx.params["type"] ?? "gift", ctx.params["rel_id"] ? String(ctx.params["rel_id"]) : null, amount, description, nowTimestamp(), nowTimestamp());
  return true;
});

register("admin", "client", "batch_expire_password_reminders", async (ctx) => {
  requireAdmin(ctx);
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  await getDbWrite().prepare("DELETE FROM client_password_reset WHERE created_at < ?").run(cutoff);
  return true;
});

register("admin", "client", "login_history_get_list", async (ctx) => {
  requireAdmin(ctx);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (ctx.params["id"]) {
    where.push("ach.id = ?");
    args.push(Number(ctx.params["id"]));
  }
  if (ctx.params["search"]) {
    where.push("(c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.id LIKE ?)");
    const s = `%${ctx.params["search"]}%`;
    args.push(s, s, s, s);
  }
  if (ctx.params["client_id"]) {
    where.push("ach.client_id = ?");
    args.push(Number(ctx.params["client_id"]));
  }
  if (ctx.params["ip"]) {
    where.push("ach.ip = ?");
    args.push(ctx.params["ip"]);
  }
  if (ctx.params["date_from"]) {
    where.push("ach.created_at >= ?");
    args.push(ctx.params["date_from"]);
  }
  if (ctx.params["date_to"]) {
    where.push("ach.created_at <= ?");
    args.push(ctx.params["date_to"]);
  }
  const sorts: Record<string, string> = { id: "ach.id", ip: "ach.ip", created_at: "ach.created_at" };
  let order = "ach.id DESC";
  const sort = ctx.params["sort"];
  if (sort && sorts[sort]) {
    const dir = (ctx.params["direction"] ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
    order = `${sorts[sort]} ${dir}`;
  }
  const q = `SELECT ach.*, c.first_name, c.last_name, c.email FROM activity_client_history AS ach LEFT JOIN client AS c ON ach.client_id = c.id` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY ${order}`;
  const rows = await getDb().prepare(q).all(...args) as Record<string, unknown>[];
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const list = rows.slice((page - 1) * perPage, page * perPage).map((r) => ({
    id: r["id"],
    ip: r["ip"],
    created_at: r["created_at"],
    client: { id: r["client_id"], first_name: r["first_name"], last_name: r["last_name"], email: r["email"] },
  }));
  return { pages: Math.max(1, Math.ceil(rows.length / perPage)), page, per_page: perPage, total: rows.length, list };
});

// --- client role ---------------------------------------------------------

register("client", "client", "balance_get_list", async (ctx) => {
  requireClient(ctx);
  const rows = await balanceListQuery(ctx, ctx.session!.client!.id);
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const list = rows.slice((page - 1) * perPage, page * perPage).map((r) => ({
    id: r["id"],
    description: r["description"],
    amount: String(r["amount"]),
    currency: r["currency"],
    created_at: r["created_at"],
  }));
  return { pages: Math.max(1, Math.ceil(rows.length / perPage)), page, per_page: perPage, total: rows.length, list };
});

register("client", "client", "balance_get_total", async (ctx) => {
  requireClient(ctx);
  return await clientBalanceSum(ctx.session!.client!.id);
});

register("client", "client", "is_taxable", async (ctx) => {
  requireClient(ctx);
  const row = await clientOrThrow(ctx.session!.client!.id);
  return await isClientTaxable(row);
});

register("client", "client", "resend_email_verification", async (ctx) => {
  requireClient(ctx);
  const row = await clientOrThrow(ctx.session!.client!.id);
  if (row.email_approved) return true;
  const w = getDbWrite();
  await w.prepare("DELETE FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = ?").run(row.id);
  const hash = generateToken(50).toLowerCase();
  await w.prepare("INSERT INTO extension_meta (extension, client_id, meta_key, meta_value, rel_type, rel_id) VALUES ('mod_client', ?, 'confirm_email', ?, 'email_confirmation_v1', ?)")
    .run(row.id, hash, createHash("sha256").update(row.email).digest("hex"));
  await queueTemplatedEmail("mod_client_confirm", row.email, { hash }, { clientId: row.id });
  return true;
});

// --- guest: signup / login / password reset ------------------------------

const GUEST_CREATE_FIELDS = [
  "email", "first_name", "last_name", "password", "phone", "phone_cc", "gender", "birthday",
  "company", "company_vat", "company_number", "type", "address_1", "address_2", "city", "state",
  "postcode", "country", "lang", "timezone",
  ...Array.from({ length: 20 }, (_, i) => `custom_${i + 1}`),
];

register("guest", "client", "create", async (ctx) => {
  const email = required(ctx, "email", "Email required");
  required(ctx, "first_name", "First name required");
  const password = required(ctx, "password", "Password required");
  const confirm = required(ctx, "password_confirm", "Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertPasswordStrong(password);
  const clean = validateEmail(email).toLowerCase();
  const existing = await findClientByEmail(clean);
  if (existing) {
    // Enumeration-safe: same true as a genuine signup, plus a login
    // attempt with the supplied password (auto-login default on).
    // PHP discards login()'s return value — the API result is true,
    // with the session established server-side.
    if (existing.status === "active") {
      try {
        if (bcrypt.compareSync(password, await clientPass(existing.id))) await loginClientSession(ctx, existing);
      } catch {
        // fall through to plain true
      }
    }
    return true;
  }
  const fields: Record<string, string | undefined> = {};
  for (const f of GUEST_CREATE_FIELDS) fields[f] = ctx.params[f];
  fields["status"] = "active";
  const id = await createClientRow(fields, ctx.ip);
  const row = await clientOrThrow(id);
  await loginClientSession(ctx, row);
  return true;
});

register("guest", "client", "login", async (ctx) => {
  const email = required(ctx, "email", "Email required");
  const password = required(ctx, "password", "Password required");
  const clean = validateEmail(email).toLowerCase();
  const row = await findClientByEmail(clean);
  if (!row || row.status !== "active" || !bcrypt.compareSync(password, await clientPass(row.id))) {
    throw new FbError("Please check your login details.", 401);
  }
  return await loginClientSession(ctx, row);
});

register("guest", "client", "reset_password", async (ctx) => {
  const email = required(ctx, "email", "Email required");
  const row = await findClientByEmail(validateEmail(email).toLowerCase());
  // Enumeration-safe: unknown or ineligible accounts still return true.
  if (row && row.status === "active") {
    const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
    const w = getDbWrite();
    await w.prepare("DELETE FROM client_password_reset WHERE client_id = ?").run(row.id);
    await w.prepare("INSERT INTO client_password_reset (hash, ip, created_at, updated_at, client_id) VALUES (?, ?, ?, ?, ?)")
      .run(hash, ctx.ip, nowTimestamp(), nowTimestamp(), row.id);
    await queueTemplatedEmail("mod_client_password_reset_request", row.email, { hash }, { clientId: row.id });
  }
  return true;
});

register("guest", "client", "update_password", async (ctx) => {
  const hash = required(ctx, "hash", "No Hash provided");
  const password = required(ctx, "password", "Password required");
  const confirm = required(ctx, "password_confirm", "Password confirmation required");
  if (password !== confirm) throw new FbError("Passwords do not match.");
  assertPasswordStrong(password);
  const reset = await getDb().prepare("SELECT * FROM client_password_reset WHERE hash = ?").get(hash) as
    | { id: number; created_at: string; client_id: number }
    | undefined;
  const expired = "The link has expired or you have already reset your password.";
  if (!reset) throw new FbError(expired);
  if (Date.parse(reset.created_at.replace(" ", "T")) + 900 * 1000 < Date.now()) throw new FbError(expired);
  const row = await findClientById(reset.client_id);
  if (!row || row.status !== "active") throw new FbError(expired);
  const w = getDbWrite();
  await w.prepare("UPDATE client SET pass = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), row.id);
  await w.prepare("DELETE FROM client_password_reset WHERE id = ?").run(reset.id);
  await invalidateSessions("client", row.id);
  await queueTemplatedEmail("mod_client_password_reset_information", row.email, {}, { clientId: row.id });
  return true;
});

register("guest", "client", "required", () => []);
register("guest", "client", "custom_fields", () => []);
register("guest", "client", "is_email_validation_required", () => false);

// --- Phase 5 R1 decisions batch (D3): admin export_csv. ---
const CLIENT_EXPORTABLE = [
  "id", "aid", "role", "auth_type", "email", "status",
  "email_approved", "tax_exempt", "merge_renewals", "type", "first_name", "last_name",
  "gender", "birthday", "phone_cc", "phone", "company", "company_vat",
  "company_number", "address_1", "address_2", "city", "state", "postcode",
  "country", "notes", "currency", "lang", "timezone", "ip", "referred_by",
  "billing_email",
  "custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6",
  "custom_7", "custom_8", "custom_9", "custom_10", "custom_11", "custom_12",
  "custom_13", "custom_14", "custom_15", "custom_16", "custom_17", "custom_18",
  "custom_19", "custom_20",
  "created_at", "updated_at",
];

const CLIENT_DEFAULT_EXPORT = [
  "id", "email", "status", "first_name", "last_name", "phone_cc", "phone",
  "company", "company_vat", "company_number", "address_1", "address_2",
  "city", "state", "postcode", "country", "currency",
];

register("admin", "client", "export_csv", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await exportCsvResponse(
    "client",
    "clients.csv",
    CLIENT_EXPORTABLE,
    CLIENT_DEFAULT_EXPORT,
    requestedCsvHeaders(ctx.rawParams, ctx.params),
  );
});
