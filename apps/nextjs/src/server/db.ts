import { DatabaseSync } from "node:sqlite";

/**
 * Data layer for the TS-ported modules. Phase 2 shares the existing
 * FOSSBilling database — the strangler contract is that TS and PHP read
 * the same tables while both runtimes are live.
 *
 * The reference/dev driver is SQLite via node:sqlite, pointed at the
 * install's database file by FB_DATABASE_PATH. MySQL/PostgreSQL drivers
 * slot in behind this module's query helpers in later phases (D3).
 */

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const path = process.env.FB_DATABASE_PATH;
  if (!path) {
    throw new Error(
      "FB_DATABASE_PATH is not set: TS-ported modules need the FOSSBilling database file (SQLite in the reference setup).",
    );
  }
  // timeout = SQLite busy timeout: PHP writes session rows concurrently,
  // so a TS read must wait out brief locks instead of failing the call.
  db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  return db;
}

export interface SettingRow {
  param: string;
  value: string | null;
}

export function getSettings(params: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (params.length === 0) return out;
  const marks = params.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT param, value FROM setting WHERE param IN (${marks})`)
    .all(...params) as unknown as SettingRow[];
  for (const r of rows) out.set(r.param, r.value);
  return out;
}

export function getSetting(param: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM setting WHERE param = ?")
    .get(param) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export interface CurrencyRow {
  id: number;
  code: string;
  is_default: number;
  conversion_rate: number;
  is_rate_manual: number;
  format_pattern: string | null;
  fraction_digits: number | null;
}

export function listCurrencies(): CurrencyRow[] {
  return getDb()
    .prepare(
      "SELECT id, code, is_default, conversion_rate, is_rate_manual, format_pattern, fraction_digits FROM currency ORDER BY id",
    )
    .all() as unknown as CurrencyRow[];
}

export function findCurrencyByCode(code: string): CurrencyRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, code, is_default, conversion_rate, is_rate_manual, format_pattern, fraction_digits FROM currency WHERE code = ?",
    )
    .get(code) as unknown as CurrencyRow | undefined;
}

export function findDefaultCurrency(): CurrencyRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, code, is_default, conversion_rate, is_rate_manual, format_pattern, fraction_digits FROM currency WHERE is_default = 1",
    )
    .get() as unknown as CurrencyRow | undefined;
}

let dbWrite: DatabaseSync | null = null;

/** Write connection (mutations). Opened lazily — reads never touch it. */
export function getDbWrite(): DatabaseSync {
  if (dbWrite) return dbWrite;
  const path = process.env.FB_DATABASE_PATH;
  if (!path) {
    throw new Error(
      "FB_DATABASE_PATH is not set: TS-ported modules need the FOSSBilling database file (SQLite in the reference setup).",
    );
  }
  dbWrite = new DatabaseSync(path, { timeout: 5000 });
  return dbWrite;
}

/** Doctrine timestamp format used across the schema (Y-m-d H:i:s, UTC here). */
export function nowTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function insertCurrency(row: {
  code: string;
  conversion_rate: number;
  is_rate_manual: number;
}): void {
  const ts = nowTimestamp();
  getDbWrite()
    .prepare(
      "INSERT INTO currency (code, conversion_rate, is_rate_manual, is_default, format_pattern, fraction_digits, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)",
    )
    .run(row.code, row.conversion_rate, row.is_rate_manual, ts, ts);
}

export function updateCurrencyRow(
  code: string,
  fields: Partial<{
    conversion_rate: number;
    is_rate_manual: number;
    format_pattern: string | null;
    fraction_digits: number | null;
  }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), code);
  getDbWrite()
    .prepare(`UPDATE currency SET ${sets.join(", ")} WHERE code = ?`)
    .run(...(values as (string | number)[]));
}

export function deleteCurrencyRow(code: string): void {
  getDbWrite().prepare("DELETE FROM currency WHERE code = ?").run(code);
}

export function setDefaultCurrencyRow(code: string): void {
  const w = getDbWrite();
  w.exec("BEGIN");
  try {
    w.prepare("UPDATE currency SET is_default = 0 WHERE is_default = 1").run();
    w.prepare("UPDATE currency SET is_default = 1, updated_at = ? WHERE code = ?").run(
      nowTimestamp(),
      code,
    );
    w.exec("COMMIT");
  } catch (e) {
    w.exec("ROLLBACK");
    throw e;
  }
}

export interface ClientRow {
  id: number;
  aid: number | null;
  role: string | null;
  auth_type: string | null;
  email: string;
  status: string | null;
  email_approved: string | null;
  tax_exempt: number | null;
  merge_renewals: number | null;
  type: string | null;
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  birthday: string | null;
  phone_cc: string | null;
  phone: string | null;
  company: string | null;
  company_vat: string | null;
  company_number: string | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  notes: string | null;
  currency: string | null;
  lang: string | null;
  timezone: string | null;
  ip: string | null;
  api_token: string | null;
  referred_by: string | null;
  billing_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  [custom: string]: unknown;
}

const CLIENT_COLUMNS =
  "id, aid, role, auth_type, email, status, email_approved, tax_exempt, merge_renewals, type, first_name, last_name, gender, birthday, phone_cc, phone, company, company_vat, company_number, address_1, address_2, city, state, postcode, country, notes, currency, lang, timezone, ip, api_token, referred_by, billing_email, created_at, updated_at, custom_1, custom_2, custom_3, custom_4, custom_5, custom_6, custom_7, custom_8, custom_9, custom_10, custom_11, custom_12, custom_13, custom_14, custom_15, custom_16, custom_17, custom_18, custom_19, custom_20";

export function findClientById(id: number): ClientRow | undefined {
  return getDb()
    .prepare(`SELECT ${CLIENT_COLUMNS} FROM client WHERE id = ?`)
    .get(id) as unknown as ClientRow | undefined;
}

export function findClientByEmail(email: string): ClientRow | undefined {
  return getDb()
    .prepare(`SELECT ${CLIENT_COLUMNS} FROM client WHERE email = ?`)
    .get(email) as unknown as ClientRow | undefined;
}

export interface ClientFilters {
  id?: string;
  name?: string;
  email?: string;
  company?: string;
  status?: string;
  search?: string;
}

export function listClients(filters: ClientFilters): ClientRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.id) {
    where.push("(id = ? OR aid = ?)");
    args.push(Number(filters.id), Number(filters.id));
  }
  if (filters.name) {
    where.push("(first_name LIKE ? OR last_name LIKE ?)");
    args.push(`%${filters.name}%`, `%${filters.name}%`);
  }
  if (filters.email) {
    where.push("email LIKE ?");
    args.push(`%${filters.email}%`);
  }
  if (filters.company) {
    where.push("company LIKE ?");
    args.push(`%${filters.company}%`);
  }
  if (filters.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  if (filters.search) {
    where.push("(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company LIKE ?)");
    const s = `%${filters.search}%`;
    args.push(s, s, s, s);
  }
  // PHP's pager orders lists newest-first (id DESC) — see captures6.
  const sql = `SELECT ${CLIENT_COLUMNS} FROM client ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return getDb().prepare(sql).all(...args) as unknown as ClientRow[];
}

export function clientBalanceSum(clientId: number): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM client_balance WHERE client_id = ?")
    .get(clientId) as { total: number | string } | undefined;
  return Number(row?.total ?? 0);
}

export function clientGroups(clientId: number): { id: number; title: string }[] {
  const rows = getDb()
    .prepare(
      "SELECT g.id AS id, g.title AS title FROM client_group g JOIN client_group_members m ON m.client_group_id = g.id WHERE m.client_id = ? ORDER BY g.id",
    )
    .all(clientId) as unknown as { id: number; title: string }[];
  return rows;
}

export function listClientPairs(limit: number): { id: number; name: string }[] {
  const rows = getDb()
    .prepare("SELECT id, first_name, last_name FROM client ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as { id: number; first_name: string | null; last_name: string | null }[];
  return rows.map((r) => ({ id: r.id, name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() }));
}

export interface AdminRow {
  id: number;
  email: string;
  name: string | null;
  signature: string | null;
  status: string | null;
  api_token: string | null;
  timezone: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function findAdminById(id: number): AdminRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at FROM admin WHERE id = ?",
    )
    .get(id) as unknown as AdminRow | undefined;
}

export interface AdminFullRow extends AdminRow {
  system_name: string | null;
}

export function listAdmins(): AdminFullRow[] {
  return getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at, system_name FROM admin WHERE system_name IS NULL ORDER BY id",
    )
    .all() as unknown as AdminFullRow[];
}

export function findAdminFullById(id: number): AdminFullRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at, system_name FROM admin WHERE id = ?",
    )
    .get(id) as unknown as AdminFullRow | undefined;
}

export function listAdminPairs(): { id: number; name: string | null }[] {
  return getDb()
    .prepare("SELECT id, name FROM admin ORDER BY id")
    .all() as unknown as { id: number; name: string | null }[];
}

export interface AdminGroupRow {
  id: number;
  name: string;
  system_name: string | null;
  permissions: string | null;
  protected: number;
  parent_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export function listAdminGroups(): AdminGroupRow[] {
  return getDb()
    .prepare(
      "SELECT id, name, system_name, permissions, protected, parent_id, created_at, updated_at FROM admin_group ORDER BY id",
    )
    .all() as unknown as AdminGroupRow[];
}

export function adminGroupIdsFor(adminId: number): number[] {
  const rows = getDb()
    .prepare("SELECT admin_group_id FROM admin_group_member WHERE admin_id = ?")
    .all(adminId) as unknown as { admin_group_id: number }[];
  return rows.map((r) => r.admin_group_id);
}

export interface ActivityRow {
  id: number;
  priority: number;
  admin_id: number | null;
  client_id: number | null;
  message: string | null;
  ip: string | null;
  created_at: string | null;
  staff_id: number | null;
  staff_email: string | null;
  staff_name: string | null;
  client_name: string | null;
  client_email: string | null;
}

export function listActivity(filters: {
  priority?: string;
  minPriority?: string;
  userFilter?: string;
  adminId?: string;
  clientId?: string;
  ip?: string;
  search?: string;
}): ActivityRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters.priority) {
    where.push("m.priority = ?");
    args.push(Number(filters.priority));
  } else if (filters.minPriority) {
    where.push("m.priority <= ?");
    args.push(Number(filters.minPriority));
  }
  if (filters.userFilter === "only_staff") where.push("m.admin_id IS NOT NULL");
  if (filters.userFilter === "only_clients") where.push("m.client_id IS NOT NULL");
  if (filters.adminId) {
    where.push("m.admin_id = ?");
    args.push(Number(filters.adminId));
  }
  if (filters.clientId) {
    where.push("m.client_id = ?");
    args.push(Number(filters.clientId));
  }
  if (filters.ip) {
    where.push("m.ip = ?");
    args.push(filters.ip);
  }
  if (filters.search) {
    where.push("m.message LIKE ?");
    args.push(`%${filters.search}%`);
  }
  const sql = `SELECT m.*, a.id as staff_id, a.email as staff_email, a.name as staff_name,
      TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) as client_name,
      c.email as client_email
    FROM activity_system m
    LEFT JOIN admin a ON a.id = m.admin_id
    LEFT JOIN client c ON c.id = m.client_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY m.id DESC`;
  return getDb().prepare(sql).all(...args) as unknown as ActivityRow[];
}

export interface PostRow {
  id: number;
  admin_id: number | null;
  title: string;
  description: string | null;
  content: string | null;
  status: string;
  slug: string;
  image: string | null;
  section: string | null;
  publish_at: string | null;
  published_at: string | null;
  expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const POST_COLUMNS =
  "id, admin_id, title, description, content, status, slug, image, section, publish_at, published_at, expires_at, created_at, updated_at";

export function listPosts(activeOnly: boolean): PostRow[] {
  const sql = `SELECT ${POST_COLUMNS} FROM post ${activeOnly ? "WHERE status = 'active'" : ""} ORDER BY created_at DESC, id`;
  return getDb().prepare(sql).all() as unknown as PostRow[];
}

export function findPostById(id: number): PostRow | undefined {
  return getDb().prepare(`SELECT ${POST_COLUMNS} FROM post WHERE id = ?`).get(id) as unknown as
    | PostRow
    | undefined;
}

export function findPostBySlug(slug: string): PostRow | undefined {
  return getDb().prepare(`SELECT ${POST_COLUMNS} FROM post WHERE slug = ?`).get(slug) as unknown as
    | PostRow
    | undefined;
}

export function insertPost(row: {
  admin_id: number;
  title: string;
  slug: string;
  content: string | null;
  status: string;
  description: string | null;
}): number {
  const ts = nowTimestamp();
  const info = getDbWrite()
    .prepare(
      "INSERT INTO post (admin_id, title, slug, content, status, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(row.admin_id, row.title, row.slug, row.content, row.status, row.description, ts, ts);
  return Number(info.lastInsertRowid);
}

export function updatePostRow(
  id: number,
  fields: Partial<{ title: string; description: string | null; content: string | null; status: string }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  getDbWrite()
    .prepare(`UPDATE post SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export function deletePostRow(id: number): void {
  getDbWrite().prepare("DELETE FROM post WHERE id = ?").run(id);
}

export interface PageRow {
  id: number;
  title: string;
  description: string | null;
  keywords: string | null;
  content: string | null;
  slug: string;
  created_at: string | null;
  updated_at: string | null;
}

const PAGE_COLUMNS = "id, title, description, keywords, content, slug, created_at, updated_at";

export function listPages(): PageRow[] {
  return getDb()
    .prepare(`SELECT ${PAGE_COLUMNS} FROM custom_pages ORDER BY created_at DESC, id`)
    .all() as unknown as PageRow[];
}

export function findPageById(id: number): PageRow | undefined {
  return getDb().prepare(`SELECT ${PAGE_COLUMNS} FROM custom_pages WHERE id = ?`).get(id) as unknown as
    | PageRow
    | undefined;
}

export function findPageBySlug(slug: string): PageRow | undefined {
  return getDb()
    .prepare(`SELECT ${PAGE_COLUMNS} FROM custom_pages WHERE slug = ?`)
    .get(slug) as unknown as PageRow | undefined;
}

export function insertPage(row: {
  title: string;
  slug: string;
  content: string | null;
  description: string | null;
  keywords: string | null;
}): number {
  const ts = nowTimestamp();
  const info = getDbWrite()
    .prepare(
      "INSERT INTO custom_pages (title, slug, content, description, keywords, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(row.title, row.slug, row.content, row.description, row.keywords, ts, ts);
  return Number(info.lastInsertRowid);
}

export function updatePageRow(
  id: number,
  fields: Partial<{
    title: string;
    description: string | null;
    keywords: string | null;
    content: string | null;
    slug: string;
  }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  getDbWrite()
    .prepare(`UPDATE custom_pages SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export function deletePageRow(id: number): void {
  getDbWrite().prepare("DELETE FROM custom_pages WHERE id = ?").run(id);
}

export function getAllSettings(): { param: string; value: string | null }[] {
  return getDb()
    .prepare("SELECT param, value FROM setting ORDER BY param")
    .all() as unknown as { param: string; value: string | null }[];
}

export function findPublicSetting(param: string): string | null | undefined {
  const row = getDb()
    .prepare("SELECT value FROM setting WHERE param = ? AND public = 1")
    .get(param) as { value: string | null } | undefined;
  return row ? row.value : undefined;
}

export function findSettingValue(param: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM setting WHERE param = ?")
    .get(param) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function upsertSetting(param: string, value: string): void {
  const ts = nowTimestamp();
  const w = getDbWrite();
  const res = w
    .prepare("UPDATE setting SET value = ?, updated_at = ? WHERE param = ?")
    .run(value, ts, param);
  if (res.changes === 0) {
    w.prepare(
      "INSERT INTO setting (param, value, public, category, hash, created_at, updated_at) VALUES (?, ?, 0, NULL, NULL, ?, ?)",
    ).run(param, value, ts, ts);
  }
}

export function findAdminByEmail(email: string): AdminFullRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at, system_name FROM admin WHERE email = ?",
    )
    .get(email) as unknown as AdminFullRow | undefined;
}

export function insertAdmin(row: {
  email: string;
  pass: string;
  name: string;
  status: string;
  signature: string | null;
  timezone: string | null;
}): number {
  const ts = nowTimestamp();
  const info = getDbWrite()
    .prepare(
      "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(row.email, row.pass, row.name, row.status, row.signature, row.timezone, ts, ts);
  return Number(info.lastInsertRowid);
}

export function updateAdminRow(
  id: number,
  fields: Partial<{
    email: string;
    name: string;
    status: string;
    signature: string | null;
    timezone: string | null;
    pass: string;
  }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  getDbWrite()
    .prepare(`UPDATE admin SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export function deleteAdminRow(id: number): void {
  const w = getDbWrite();
  w.exec("BEGIN");
  try {
    w.prepare("DELETE FROM admin_group_member WHERE admin_id = ?").run(id);
    w.prepare("DELETE FROM admin WHERE id = ?").run(id);
    w.exec("COMMIT");
  } catch (e) {
    w.exec("ROLLBACK");
    throw e;
  }
}

export function addAdminToGroup(adminId: number, groupId: number): void {
  getDbWrite()
    .prepare("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, ?, ?)")
    .run(adminId, groupId, nowTimestamp());
}

export function removeAdminFromGroup(adminId: number, groupId: number): void {
  getDbWrite()
    .prepare("DELETE FROM admin_group_member WHERE admin_id = ? AND admin_group_id = ?")
    .run(adminId, groupId);
}

export function insertAdminGroup(name: string, parentId: number): number {
  const ts = nowTimestamp();
  const info = getDbWrite()
    .prepare(
      "INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at) VALUES (?, NULL, NULL, 0, ?, ?, ?)",
    )
    .run(name, parentId, ts, ts);
  return Number(info.lastInsertRowid);
}

export function updateAdminGroupRow(
  id: number,
  fields: Partial<{ name: string; permissions: string | null; parent_id: number | null }>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  getDbWrite()
    .prepare(`UPDATE admin_group SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export function deleteAdminGroupRow(id: number): void {
  const w = getDbWrite();
  w.exec("BEGIN");
  try {
    w.prepare("DELETE FROM admin_group_member WHERE admin_group_id = ?").run(id);
    w.prepare("DELETE FROM admin_group WHERE id = ?").run(id);
    w.exec("COMMIT");
  } catch (e) {
    w.exec("ROLLBACK");
    throw e;
  }
}

export function findAdminGroupById(id: number): AdminGroupRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, name, system_name, permissions, protected, parent_id, created_at, updated_at FROM admin_group WHERE id = ?",
    )
    .get(id) as unknown as AdminGroupRow | undefined;
}

export function countAdminGroupMembers(groupId: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM admin_group_member WHERE admin_group_id = ?")
    .get(groupId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function listAdminLoginHistory(): {
  id: number;
  ip: string | null;
  created_at: string | null;
  staff_id: number | null;
  staff_name: string | null;
  staff_email: string | null;
}[] {
  return getDb()
    .prepare(
      `SELECT h.id AS id, h.ip AS ip, h.created_at AS created_at, a.id AS staff_id, a.name AS staff_name, a.email AS staff_email
       FROM activity_admin_history h LEFT JOIN admin a ON a.id = h.admin_id ORDER BY h.id DESC`,
    )
    .all() as unknown as {
    id: number;
    ip: string | null;
    created_at: string | null;
    staff_id: number | null;
    staff_name: string | null;
    staff_email: string | null;
  }[];
}

export function insertActivity(row: {
  admin_id: number | null;
  client_id: number | null;
  priority: number;
  message: string;
  ip: string | null;
}): void {
  getDbWrite()
    .prepare(
      "INSERT INTO activity_system (admin_id, client_id, priority, message, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(row.admin_id, row.client_id, row.priority, row.message, row.ip, nowTimestamp());
}

export function updateSessionContent(id: string, content: string): void {
  getDbWrite().prepare("UPDATE session SET content = ? WHERE id = ?").run(content, id);
}

export interface SessionRow {
  id: string;
  content: string;
  lifetime: number;
}

export function findSession(id: string): SessionRow | undefined {
  const row = getDb()
    .prepare("SELECT id, content, lifetime FROM session WHERE id = ?")
    .get(id) as unknown as
    | { id: string; content: string | Uint8Array; lifetime: number }
    | undefined;
  if (!row) return undefined;
  // Doctrine stores session content as a blob: node:sqlite returns bytes.
  const content =
    typeof row.content === "string" ? row.content : new TextDecoder().decode(row.content);
  return { id: row.id, content, lifetime: row.lifetime };
}
