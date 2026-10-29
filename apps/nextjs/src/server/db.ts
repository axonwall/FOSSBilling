import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createPgDb } from "./pg";

/**
 * Data layer for the TS-ported modules. Phase 2 shares the existing
 * FOSSBilling database — the strangler contract is that TS and PHP read
 * the same tables while both runtimes are live.
 *
 * R3a: the seam is async. getDb()/getDbWrite() return a Db synchronously
 * (a thin handle), but every query method is async. Two drivers sit
 * behind the interface: SQLite via node:sqlite (dev/test, FB_DATABASE_PATH)
 * and Postgres via pg (production, FB_DATABASE_URL). Row shapes are
 * identical on both drivers (see pg.ts for the Postgres normalization
 * contract); call sites never branch on the driver.
 */

/** One prepared statement. prepare() itself is sync; execution is async. */
export interface DbStatement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE. changes is the affected-row count (pg rowCount). */
  run(...params: unknown[]): Promise<{ changes: number }>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /** Misc execution (no result needed). Transactions use withTransaction. */
  exec(sql: string): Promise<void>;
  /**
   * Single-row INSERT returning the new id. Postgres appends
   * RETURNING id; SQLite reads lastInsertRowid. The SQL must be a plain
   * single-row INSERT with a column list and no RETURNING clause.
   */
  insertAndGetId(sql: string, ...params: unknown[]): Promise<number>;
  /**
   * Run fn inside a transaction on one connection (a checked-out pg
   * client, or the SQLite write connection). Inside fn, ONLY the tx
   * handle may be used — getDb()/getDbWrite() would escape the
   * transaction on pg. Nesting is not supported (the seam has no
   * nested-transaction sites).
   */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

class SqliteStatement implements DbStatement {
  constructor(private stmt: ReturnType<DatabaseSync["prepare"]>) {}
  async get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined> {
    return this.stmt.get(...(params as SQLInputValue[])) as T | undefined;
  }
  async all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]> {
    return this.stmt.all(...(params as SQLInputValue[])) as T[];
  }
  async run(...params: unknown[]): Promise<{ changes: number }> {
    const r = this.stmt.run(...(params as SQLInputValue[]));
    return { changes: Number(r.changes) };
  }
}

/** Exported for operator scripts (e.g. the R4d salt re-key tool) that
 * construct a driver directly instead of using the getDb singletons. */
export class DbSqlite implements Db {
  constructor(private conn: DatabaseSync) {}
  prepare(sql: string): DbStatement {
    return new SqliteStatement(this.conn.prepare(sql));
  }
  async exec(sql: string): Promise<void> {
    this.conn.exec(sql);
  }
  async insertAndGetId(sql: string, ...params: unknown[]): Promise<number> {
    const r = this.conn.prepare(sql).run(...(params as SQLInputValue[]));
    return Number(r.lastInsertRowid);
  }
  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.conn.exec("BEGIN");
    try {
      const out = await fn(this);
      this.conn.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.conn.exec("ROLLBACK"); } catch { /* already failed */ }
      throw e;
    }
  }
}

function dbPath(): string {
  const path = process.env.FB_DATABASE_PATH;
  if (!path) {
    throw new Error(
      "FB_DATABASE_PATH is not set: TS-ported modules need the FOSSBilling database file (SQLite in the reference setup).",
    );
  }
  return path;
}

/** The fixture harness restores the DB by copying over the file in
 * place (same inode), and fixture setup SQL writes to it between API
 * calls. A cached SQLite connection serves stale pages in both cases,
 * so the connection is keyed to the file's identity stamp
 * (inode + mtime + size) and reopened whenever it changes. */
function fileStamp(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

let sqliteRead: DatabaseSync | null = null;
let sqliteReadStamp: string | null = null;

function sqliteReadConn(): DatabaseSync {
  const path = dbPath();
  const stamp = fileStamp(path);
  if (sqliteRead && stamp !== null && sqliteReadStamp !== null && stamp !== sqliteReadStamp) {
    try { sqliteRead.close(); } catch { /* already closed */ }
    sqliteRead = null;
    // NOTE: the write connection is NOT closed here. A read that
    // follows a write in the same request changes the stamp (the
    // handler's own write), and closing the write connection there
    // invalidated handles already handed out ("database is not open"
    // on the next write of a read-write-read loop, e.g.
    // update_priority). The write connection validates its own stamp
    // in sqliteWriteConn().
  }
  if (sqliteRead) return sqliteRead;
  // timeout = SQLite busy timeout: PHP writes session rows concurrently,
  // so a TS read must wait out brief locks instead of failing the call.
  sqliteRead = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  sqliteReadStamp = stamp;
  return sqliteRead;
}

let sqliteWrite: DatabaseSync | null = null;
let sqliteWriteStamp: string | null = null;

/** Write connection (mutations). Opened lazily — reads never touch it.
 * Stamp-checked on every acquisition so an externally replaced DB
 * (fixture snapshot restore) never receives writes on a stale inode,
 * without invalidating handles a handler already holds: only a fresh
 * getDbWrite() call after a stamp change reopens. */
function sqliteWriteConn(): DatabaseSync {
  sqliteReadConn(); // keeps both connections on the same file generation
  const stamp = fileStamp(dbPath());
  if (sqliteWrite && stamp !== null && sqliteWriteStamp !== null && stamp !== sqliteWriteStamp) {
    try { sqliteWrite.close(); } catch { /* already closed */ }
    sqliteWrite = null;
  }
  if (sqliteWrite) return sqliteWrite;
  sqliteWrite = new DatabaseSync(dbPath(), { timeout: 5000 });
  sqliteWriteStamp = stamp;
  return sqliteWrite;
}

/** Read handle. Sync accessor; query methods are async. */
export function getDb(): Db {
  if (process.env.FB_DATABASE_URL) return createPgDb();
  return new DbSqlite(sqliteReadConn());
}

/** Write handle. Sync accessor; query methods are async. */
export function getDbWrite(): Db {
  if (process.env.FB_DATABASE_URL) return createPgDb();
  return new DbSqlite(sqliteWriteConn());
}

export interface SettingRow {
  param: string;
  value: string | null;
}

export async function getSettings(params: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (params.length === 0) return out;
  const marks = params.map(() => "?").join(",");
  const rows = (await getDb()
    .prepare(`SELECT param, value FROM setting WHERE param IN (${marks})`)
    .all(...params)) as unknown as SettingRow[];
  for (const r of rows) out.set(r.param, r.value);
  return out;
}

export async function getSetting(param: string): Promise<string | null> {
  const row = (await getDb()
    .prepare("SELECT value FROM setting WHERE param = ?")
    .get(param)) as { value: string | null } | undefined;
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

export async function listCurrencies(): Promise<CurrencyRow[]> {
  return (await getDb()
    .prepare(
      "SELECT id, code, is_default, conversion_rate, is_rate_manual, format_pattern, fraction_digits FROM currency ORDER BY id",
    )
    .all()) as unknown as CurrencyRow[];
}

export async function findCurrencyByCode(code: string): Promise<CurrencyRow | undefined> {
  return (await getDb()
    .prepare(
      "SELECT id, code, is_default, conversion_rate, is_rate_manual, format_pattern, fraction_digits FROM currency WHERE code = ?",
    )
    .get(code)) as unknown as CurrencyRow | undefined;
}

export async function findDefaultCurrency(): Promise<CurrencyRow | undefined> {
  return (await getDb()
    .prepare(
      "SELECT id, code, is_default, conversion_rate, is_rate_manual, format_pattern, fraction_digits FROM currency WHERE is_default = 1",
    )
    .get()) as unknown as CurrencyRow | undefined;
}

/** Doctrine timestamp format used across the schema (Y-m-d H:i:s, UTC here). */
export function nowTimestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export async function insertCurrency(row: {
  code: string;
  conversion_rate: number;
  is_rate_manual: number;
}): Promise<void> {
  const ts = nowTimestamp();
  await getDbWrite()
    .prepare(
      "INSERT INTO currency (code, conversion_rate, is_rate_manual, is_default, format_pattern, fraction_digits, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)",
    )
    .run(row.code, row.conversion_rate, row.is_rate_manual, ts, ts);
}

export async function updateCurrencyRow(
  code: string,
  fields: Partial<{
    conversion_rate: number;
    is_rate_manual: number;
    format_pattern: string | null;
    fraction_digits: number | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), code);
  await getDbWrite()
    .prepare(`UPDATE currency SET ${sets.join(", ")} WHERE code = ?`)
    .run(...(values as (string | number)[]));
}

export async function deleteCurrencyRow(code: string): Promise<void> {
  await getDbWrite().prepare("DELETE FROM currency WHERE code = ?").run(code);
}

export async function setDefaultCurrencyRow(code: string): Promise<void> {
  const w = getDbWrite();
  await w.withTransaction(async (tx) => {
    await tx.prepare("UPDATE currency SET is_default = 0 WHERE is_default = 1").run();
    await tx.prepare("UPDATE currency SET is_default = 1, updated_at = ? WHERE code = ?").run(
      nowTimestamp(),
      code,
    );
  });
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

export async function findClientById(id: number): Promise<ClientRow | undefined> {
  return await getDb()
    .prepare(`SELECT ${CLIENT_COLUMNS} FROM client WHERE id = ?`)
    .get(id) as unknown as ClientRow | undefined;
}

export async function findClientByEmail(email: string): Promise<ClientRow | undefined> {
  return await getDb()
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

export async function listClients(filters: ClientFilters): Promise<ClientRow[]> {
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
  return await getDb().prepare(sql).all(...args) as unknown as ClientRow[];
}

export async function clientBalanceSum(clientId: number): Promise<number> {
  const row = await getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM client_balance WHERE client_id = ?")
    .get(clientId) as { total: number | string } | undefined;
  return Number(row?.total ?? 0);
}

export async function clientGroups(clientId: number): Promise<{ id: number; title: string }[]> {
  const rows = await getDb()
    .prepare(
      "SELECT g.id AS id, g.title AS title FROM client_group g JOIN client_group_members m ON m.client_group_id = g.id WHERE m.client_id = ? ORDER BY g.id",
    )
    .all(clientId) as unknown as { id: number; title: string }[];
  return rows;
}

export async function listClientPairs(limit: number): Promise<{ id: number; name: string }[]> {
  const rows = await getDb()
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

export async function findAdminById(id: number): Promise<AdminRow | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at FROM admin WHERE id = ?",
    )
    .get(id) as unknown as AdminRow | undefined;
}

export interface AdminFullRow extends AdminRow {
  system_name: string | null;
}

export async function listAdmins(): Promise<AdminFullRow[]> {
  return await getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at, system_name FROM admin WHERE system_name IS NULL ORDER BY id",
    )
    .all() as unknown as AdminFullRow[];
}

export async function findAdminFullById(id: number): Promise<AdminFullRow | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at, system_name FROM admin WHERE id = ?",
    )
    .get(id) as unknown as AdminFullRow | undefined;
}

export async function listAdminPairs(): Promise<{ id: number; name: string | null }[]> {
  return await getDb()
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

export async function listAdminGroups(): Promise<AdminGroupRow[]> {
  return await getDb()
    .prepare(
      "SELECT id, name, system_name, permissions, protected, parent_id, created_at, updated_at FROM admin_group ORDER BY id",
    )
    .all() as unknown as AdminGroupRow[];
}

export async function adminGroupIdsFor(adminId: number): Promise<number[]> {
  const rows = await getDb()
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

export async function listActivity(filters: {
  priority?: string;
  minPriority?: string;
  userFilter?: string;
  adminId?: string;
  clientId?: string;
  ip?: string;
  search?: string;
}): Promise<ActivityRow[]> {
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
  return await getDb().prepare(sql).all(...args) as unknown as ActivityRow[];
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

export async function listPosts(activeOnly: boolean): Promise<PostRow[]> {
  const sql = `SELECT ${POST_COLUMNS} FROM post ${activeOnly ? "WHERE status = 'active'" : ""} ORDER BY created_at DESC, id`;
  return await getDb().prepare(sql).all() as unknown as PostRow[];
}

export async function findPostById(id: number): Promise<PostRow | undefined> {
  return await getDb().prepare(`SELECT ${POST_COLUMNS} FROM post WHERE id = ?`).get(id) as unknown as
    | PostRow
    | undefined;
}

export async function findPostBySlug(slug: string): Promise<PostRow | undefined> {
  return await getDb().prepare(`SELECT ${POST_COLUMNS} FROM post WHERE slug = ?`).get(slug) as unknown as
    | PostRow
    | undefined;
}

export async function insertPost(row: {
  admin_id: number;
  title: string;
  slug: string;
  content: string | null;
  status: string;
  description: string | null;
}): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO post (admin_id, title, slug, content, status, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row.admin_id, row.title, row.slug, row.content, row.status, row.description, ts, ts);
  return Number(info);
}

export async function updatePostRow(
  id: number,
  fields: Partial<{ title: string; description: string | null; content: string | null; status: string }>,
): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  await getDbWrite()
    .prepare(`UPDATE post SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export async function deletePostRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM post WHERE id = ?").run(id);
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

export async function listPages(): Promise<PageRow[]> {
  return await getDb()
    .prepare(`SELECT ${PAGE_COLUMNS} FROM custom_pages ORDER BY created_at DESC, id`)
    .all() as unknown as PageRow[];
}

export async function findPageById(id: number): Promise<PageRow | undefined> {
  return await getDb().prepare(`SELECT ${PAGE_COLUMNS} FROM custom_pages WHERE id = ?`).get(id) as unknown as
    | PageRow
    | undefined;
}

export async function findPageBySlug(slug: string): Promise<PageRow | undefined> {
  return await getDb()
    .prepare(`SELECT ${PAGE_COLUMNS} FROM custom_pages WHERE slug = ?`)
    .get(slug) as unknown as PageRow | undefined;
}

export async function insertPage(row: {
  title: string;
  slug: string;
  content: string | null;
  description: string | null;
  keywords: string | null;
}): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO custom_pages (title, slug, content, description, keywords, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", row.title, row.slug, row.content, row.description, row.keywords, ts, ts);
  return Number(info);
}

export async function updatePageRow(
  id: number,
  fields: Partial<{
    title: string;
    description: string | null;
    keywords: string | null;
    content: string | null;
    slug: string;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  await getDbWrite()
    .prepare(`UPDATE custom_pages SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export async function deletePageRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM custom_pages WHERE id = ?").run(id);
}

export async function getAllSettings(): Promise<{ param: string; value: string | null }[]> {
  return await getDb()
    .prepare("SELECT param, value FROM setting ORDER BY param")
    .all() as unknown as { param: string; value: string | null }[];
}

export async function findPublicSetting(param: string): Promise<string | null | undefined> {
  const row = await getDb()
    .prepare("SELECT value FROM setting WHERE param = ? AND public = 1")
    .get(param) as { value: string | null } | undefined;
  return row ? row.value : undefined;
}

export async function findSettingValue(param: string): Promise<string | null> {
  const row = await getDb()
    .prepare("SELECT value FROM setting WHERE param = ?")
    .get(param) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export async function upsertSetting(param: string, value: string): Promise<void> {
  const ts = nowTimestamp();
  const w = getDbWrite();
  const res = await w
    .prepare("UPDATE setting SET value = ?, updated_at = ? WHERE param = ?")
    .run(value, ts, param);
  if (res.changes === 0) {
    await w.prepare(
      "INSERT INTO setting (param, value, public, category, hash, created_at, updated_at) VALUES (?, ?, 0, NULL, NULL, ?, ?)",
    ).run(param, value, ts, ts);
  }
}

export async function findAdminByEmail(email: string): Promise<AdminFullRow | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, email, name, signature, status, api_token, timezone, created_at, updated_at, system_name FROM admin WHERE email = ?",
    )
    .get(email) as unknown as AdminFullRow | undefined;
}

/**
 * Staff\Service::authorizeAdmin needs the password hash, status, and
 * system_name — none of which findAdminByEmail selects. The active +
 * non-cron filter mirrors findOneByEmailAndActive + the cron exclusion.
 */
export interface AdminAuthRow {
  id: number;
  email: string;
  name: string;
  pass: string | null;
  status: string | null;
  system_name: string | null;
}

export async function findAdminAuthByEmail(email: string): Promise<AdminAuthRow | undefined> {
  return await getDb()
    .prepare("SELECT id, email, name, pass, status, system_name FROM admin WHERE email = ?")
    .get(email) as AdminAuthRow | undefined;
}

export interface AdminPasswordResetRow {
  id: number;
  hash: string;
  ip: string | null;
  admin_id: number | null;
  created_at: string | null;
}

export async function findAdminPasswordResetByHash(hash: string): Promise<AdminPasswordResetRow | undefined> {
  return await getDb()
    .prepare("SELECT id, hash, ip, admin_id, created_at FROM admin_password_reset WHERE hash = ?")
    .get(hash) as AdminPasswordResetRow | undefined;
}

/** Staff\Repository\AdminPasswordResetRepository::replaceReset. */
export async function replaceAdminPasswordReset(adminId: number, hash: string, ip: string | null): Promise<void> {
  const w = getDbWrite();
  const now = nowTimestamp();
  await w.prepare("DELETE FROM admin_password_reset WHERE admin_id = ?").run(adminId);
  await w.prepare("INSERT INTO admin_password_reset (hash, ip, admin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(hash, ip, adminId, now, now);
}

export async function deleteAdminPasswordResets(adminId: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM admin_password_reset WHERE admin_id = ?").run(adminId);
}

/** Activity\Service::recordAdminLogin: one row per staff login. */
export async function insertAdminLoginHistory(adminId: number, ip: string | null): Promise<void> {
  await getDbWrite()
    .prepare("INSERT INTO activity_admin_history (admin_id, ip, created_at) VALUES (?, ?, ?)")
    .run(adminId, ip, nowTimestamp());
}

/** Activity\Repository\ActivityAdminHistoryRepository::findOneByIdOrFail. */
export async function findAdminLoginHistoryById(id: number): Promise<{
  id: number;
  ip: string | null;
  created_at: string | null;
  staff_id: number | null;
  staff_name: string | null;
  staff_email: string | null;
} | undefined> {
  return await getDb()
    .prepare(
      `SELECT h.id AS id, h.ip AS ip, h.created_at AS created_at, a.id AS staff_id, a.name AS staff_name, a.email AS staff_email
       FROM activity_admin_history h LEFT JOIN admin a ON a.id = h.admin_id WHERE h.id = ?`,
    )
    .get(id) as unknown as {
    id: number;
    ip: string | null;
    created_at: string | null;
    staff_id: number | null;
    staff_name: string | null;
    staff_email: string | null;
  } | undefined;
}

export async function insertAdmin(row: {
  email: string;
  pass: string;
  name: string;
  status: string;
  signature: string | null;
  timezone: string | null;
}): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row.email, row.pass, row.name, row.status, row.signature, row.timezone, ts, ts);
  return Number(info);
}

export async function updateAdminRow(
  id: number,
  fields: Partial<{
    email: string;
    name: string;
    status: string;
    signature: string | null;
    timezone: string | null;
    pass: string;
    api_token: string | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  await getDbWrite()
    .prepare(`UPDATE admin SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export async function deleteAdminRow(id: number): Promise<void> {
  const w = getDbWrite();
  await w.withTransaction(async (tx) => {
    await tx.prepare("DELETE FROM admin_group_member WHERE admin_id = ?").run(id);
    await tx.prepare("DELETE FROM admin WHERE id = ?").run(id);
  });
}

export async function addAdminToGroup(adminId: number, groupId: number): Promise<void> {
  await getDbWrite()
    .prepare("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, ?, ?)")
    .run(adminId, groupId, nowTimestamp());
}

export async function removeAdminFromGroup(adminId: number, groupId: number): Promise<void> {
  await getDbWrite()
    .prepare("DELETE FROM admin_group_member WHERE admin_id = ? AND admin_group_id = ?")
    .run(adminId, groupId);
}

export async function insertAdminGroup(name: string, parentId: number): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at) VALUES (?, NULL, NULL, 0, ?, ?, ?)", name, parentId, ts, ts);
  return Number(info);
}

export async function updateAdminGroupRow(
  id: number,
  fields: Partial<{ name: string; permissions: string | null; parent_id: number | null }>,
): Promise<void> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(nowTimestamp(), id);
  await getDbWrite()
    .prepare(`UPDATE admin_group SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number)[]));
}

export async function deleteAdminGroupRow(id: number): Promise<void> {
  const w = getDbWrite();
  await w.withTransaction(async (tx) => {
    await tx.prepare("DELETE FROM admin_group_member WHERE admin_group_id = ?").run(id);
    await tx.prepare("DELETE FROM admin_group WHERE id = ?").run(id);
  });
}

export async function findAdminGroupById(id: number): Promise<AdminGroupRow | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, name, system_name, permissions, protected, parent_id, created_at, updated_at FROM admin_group WHERE id = ?",
    )
    .get(id) as unknown as AdminGroupRow | undefined;
}

export async function countAdminGroupMembers(groupId: number): Promise<number> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM admin_group_member WHERE admin_group_id = ?")
    .get(groupId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export async function listAdminLoginHistory(): Promise<{
  id: number;
  ip: string | null;
  created_at: string | null;
  staff_id: number | null;
  staff_name: string | null;
  staff_email: string | null;
}[]> {
  return await getDb()
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

export async function insertActivity(row: {
  admin_id: number | null;
  client_id: number | null;
  priority: number;
  message: string;
  ip: string | null;
}): Promise<void> {
  await getDbWrite()
    .prepare(
      "INSERT INTO activity_system (admin_id, client_id, priority, message, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(row.admin_id, row.client_id, row.priority, row.message, row.ip, nowTimestamp());
}

export async function updateSessionContent(id: string, content: string): Promise<void> {
  await getDbWrite().prepare("UPDATE session SET content = ? WHERE id = ?").run(content, id);
}

export interface SessionRow {
  id: string;
  content: string;
  lifetime: number;
}

export async function insertSession(id: string, content: string, lifetime: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDbWrite()
    .prepare(
      "INSERT INTO session (id, modified_at, created_at, content, lifetime, fingerprint) VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .run(id, now, now, content, lifetime);
}

export async function findSession(id: string): Promise<SessionRow | undefined> {
  const row = await getDb()
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

/**
 * Profile\Service::invalidateSessions scans every session row and drops
 * the ones whose _sf2_attributes bag carries the matching identity.
 */
export async function listSessionRows(): Promise<SessionRow[]> {
  const rows = await getDb()
    .prepare("SELECT id, content, lifetime FROM session WHERE content IS NOT NULL AND LENGTH(content) > 0")
    .all() as unknown as { id: string; content: string | Uint8Array; lifetime: number }[];
  return rows.map((r) => ({
    id: r.id,
    content: typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content),
    lifetime: r.lifetime,
  }));
}

export async function deleteSessionRow(id: string): Promise<void> {
  await getDbWrite().prepare("DELETE FROM session WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Money path (Phase 3): products, carts, promos, orders, invoices.
// ---------------------------------------------------------------------------

export interface ProductRow {
  id: number;
  form_id: number | null;
  title: string;
  slug: string | null;
  description: string | null;
  unit: string | null;
  active: number;
  status: string | null;
  hidden: number;
  is_addon: number;
  setup: string | null;
  addons: string | null;
  icon_url: string | null;
  allow_quantity_select: number;
  stock_control: number;
  quantity_in_stock: number;
  suspension_grace_days: number | null;
  plugin: string | null;
  plugin_config: string | null;
  upgrades: string | null;
  priority: number | null;
  config: string | null;
  type: string | null;
  created_at: string | null;
  updated_at: string | null;
  product_category_id: number | null;
  product_payment_id: number | null;
}

const PRODUCT_COLS =
  "id, form_id, title, slug, description, unit, active, status, hidden, is_addon, setup, addons, icon_url, allow_quantity_select, stock_control, quantity_in_stock, suspension_grace_days, plugin, plugin_config, upgrades, priority, config, type, created_at, updated_at, product_category_id, product_payment_id";

export async function findProductById(id: number): Promise<ProductRow | undefined> {
  return await getDb().prepare(`SELECT ${PRODUCT_COLS} FROM product WHERE id = ?`).get(id) as
    | ProductRow
    | undefined;
}

export async function listAllProducts(): Promise<ProductRow[]> {
  return await getDb().prepare(`SELECT ${PRODUCT_COLS} FROM product ORDER BY priority ASC, id ASC`).all() as unknown as ProductRow[];
}

export interface ProductPaymentRow {
  id: number;
  type: string;
  once_price: number | null;
  once_setup_price: number | null;
}

export async function findProductPayment(id: number): Promise<ProductPaymentRow | undefined> {
  return await getDb()
    .prepare("SELECT id, type, once_price, once_setup_price FROM product_payment WHERE id = ?")
    .get(id) as ProductPaymentRow | undefined;
}

export interface ProductPeriodRow {
  id: number;
  code: string;
  price: number;
  setup_price: number;
  enabled: number;
  sort_order: number | null;
  product_payment_id: number;
}

export async function listProductPeriods(paymentId: number): Promise<ProductPeriodRow[]> {
  return await getDb()
    .prepare(
      "SELECT id, code, price, setup_price, enabled, sort_order, product_payment_id FROM product_payment_period WHERE product_payment_id = ? ORDER BY sort_order ASC, id ASC",
    )
    .all(paymentId) as unknown as ProductPeriodRow[];
}

export interface CategoryRow {
  id: number;
  title: string;
  description: string | null;
  icon_url: string | null;
  priority: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function listCategories(): Promise<CategoryRow[]> {
  return await getDb()
    .prepare("SELECT id, title, description, icon_url, priority, created_at, updated_at FROM product_category ORDER BY id ASC")
    .all() as unknown as CategoryRow[];
}

export async function findTldRegistrar(id: number): Promise<{ id: number; title: string } | undefined> {
  return await getDb()
    .prepare("SELECT id, name AS title FROM tld_registrar WHERE id = ?")
    .get(id) as { id: number; title: string } | undefined;
}

export async function listTlds(): Promise<{
  tld: string;
  price_registration: string;
  price_renew: string;
  price_transfer: string;
  allow_register: number;
  allow_transfer: number;
  min_years: number;
  periods: string | null;
  tld_registrar_id: number | null;
}[]> {
  // Prices are DECIMAL in PHP (returned as strings); SQLite stores them
  // as REAL, so format back to the scale-2 string form.
  return await getDb()
    .prepare(
      `SELECT tld, printf('%.2f', price_registration) AS price_registration,
              printf('%.2f', price_renew) AS price_renew,
              printf('%.2f', price_transfer) AS price_transfer,
              allow_register, allow_transfer, min_years, periods, tld_registrar_id
       FROM tld WHERE active = 1 ORDER BY tld ASC`,
    )
    .all() as never[];
}

export interface CartRow {
  id: number;
  session_id: string;
  currency_id: number | null;
  promo_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function findCartBySession(sessionId: string): Promise<CartRow | undefined> {
  return await getDb()
    .prepare("SELECT id, session_id, currency_id, promo_id, created_at, updated_at FROM cart WHERE session_id = ?")
    .get(sessionId) as CartRow | undefined;
}

/** Cart/Api/Admin.php get_list: no search filter, every cart listed. */
export async function listCarts(): Promise<CartRow[]> {
  return await getDb()
    .prepare("SELECT id, session_id, currency_id, promo_id, created_at, updated_at FROM cart ORDER BY id ASC")
    .all() as unknown as CartRow[];
}

export async function findCartById(id: number): Promise<CartRow | undefined> {
  return await getDb()
    .prepare("SELECT id, session_id, currency_id, promo_id, created_at, updated_at FROM cart WHERE id = ?")
    .get(id) as CartRow | undefined;
}

export async function insertCart(sessionId: string, currencyId: number): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)", sessionId, currencyId, now, now);
  return Number(info);
}

export async function updateCartRow(id: number, fields: { currency_id?: number; promo_id?: number | null }): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.currency_id !== undefined) { sets.push("currency_id = ?"); vals.push(fields.currency_id); }
  if (fields.promo_id !== undefined) { sets.push("promo_id = ?"); vals.push(fields.promo_id); }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(nowTimestamp(), id);
  await getDbWrite().prepare(`UPDATE cart SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
}

export async function deleteCartRow(id: number): Promise<void> {
  const w = getDbWrite();
  await w.prepare("DELETE FROM cart_product WHERE cart_id = ?").run(id);
  await w.prepare("DELETE FROM cart WHERE id = ?").run(id);
}

export interface CartProductRow {
  id: number;
  product_id: number;
  config: string | null;
  cart_id: number;
}

export async function listCartProducts(cartId: number): Promise<CartProductRow[]> {
  return await getDb()
    .prepare("SELECT id, product_id, config, cart_id FROM cart_product WHERE cart_id = ? ORDER BY id ASC")
    .all(cartId) as unknown as CartProductRow[];
}

export async function insertCartProduct(cartId: number, productId: number, config: string): Promise<number> {
  const info = await getDbWrite().insertAndGetId("INSERT INTO cart_product (product_id, config, cart_id) VALUES (?, ?, ?)", productId, config, cartId);
  return Number(info);
}

export async function deleteCartProductRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM cart_product WHERE id = ?").run(id);
}

export async function clearCartProducts(cartId: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM cart_product WHERE cart_id = ?").run(cartId);
}

export interface PromoRow {
  id: number;
  code: string;
  description: string | null;
  type: string;
  value: number;
  maxuses: number | null;
  used: number | null;
  freesetup: number;
  once_per_client: number;
  recurring: number;
  active: number;
  products: string | null;
  periods: string | null;
  client_groups: string | null;
  requires_products: string | null;
  start_at: string | null;
  end_at: string | null;
  auto_apply: number;
  priority: number | null;
  stackable: number;
}

const PROMO_COLS =
  "id, code, description, type, value, maxuses, used, freesetup, once_per_client, recurring, active, products, periods, client_groups, requires_products, start_at, end_at, auto_apply, priority, stackable";

export async function findPromoByCode(code: string): Promise<PromoRow | undefined> {
  return await getDb().prepare(`SELECT ${PROMO_COLS} FROM promo WHERE code = ?`).get(code) as
    | PromoRow
    | undefined;
}

export async function findPromoById(id: number): Promise<PromoRow | undefined> {
  return await getDb().prepare(`SELECT ${PROMO_COLS} FROM promo WHERE id = ?`).get(id) as
    | PromoRow
    | undefined;
}

/**
 * Product\Repository\PromoRepository::findAutoApplyPromos: active,
 * auto-apply, inside the start/end window (NULL bounds are open),
 * priority DESC, id ASC. Window compares against "now" in the
 * server timezone (UTC on the TS seam, matching the PHP runtime).
 */
export async function listAutoApplyPromos(): Promise<PromoRow[]> {
  const now = nowTimestamp();
  return await getDb()
    .prepare(
      `SELECT ${PROMO_COLS} FROM promo WHERE active = 1 AND auto_apply = 1
       AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at >= ?)
       ORDER BY priority DESC, id ASC`,
    )
    .all(now, now) as unknown as PromoRow[];
}

/**
 * Product\Repository\PromoRedemptionRepository::clientHasActiveCheckoutApplication:
 * a checkout-phase redemption in reserved or committed status. This is
 * the exact once-per-client predicate — NOT countPromoRedemptionsForClient,
 * which counts every phase and every non-released status.
 */
export async function hasActiveCheckoutRedemption(promoId: number, clientId: number): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM promo_redemption
       WHERE promo_id = ? AND client_id = ? AND phase = 'checkout' AND status IN ('reserved', 'committed')`,
    )
    .get(promoId, clientId) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * Product\Service::usePromo: increment only when capacity remains
 * (maxuses 0/NULL = unlimited). Returns false — and the caller throws
 * 'This promo code has reached its maximum number of uses.' — when the
 * promo is maxed out. Staff checkout only; the client-checkout call
 * site keeps the unconditional incrementPromoUsed.
 */
export async function incrementPromoUsedIfAvailable(id: number): Promise<boolean> {
  const info = await getDbWrite()
    .prepare("UPDATE promo SET used = COALESCE(used, 0) + 1 WHERE id = ? AND (maxuses IS NULL OR maxuses = 0 OR used < maxuses)")
    .run(id);
  return info.changes > 0;
}

export async function incrementPromoUsed(id: number): Promise<void> {
  await getDbWrite().prepare("UPDATE promo SET used = COALESCE(used, 0) + 1 WHERE id = ?").run(id);
}

export async function insertPromoRedemption(row: {
  promo_id: number;
  client_id: number;
  client_order_id: number | null;
  invoice_id: number | null;
  phase: string | null;
  status: string;
  discount_amount: number;
  currency: string;
}): Promise<void> {
  const now = nowTimestamp();
  await getDbWrite()
    .prepare(
      "INSERT INTO promo_redemption (promo_id, client_id, client_order_id, invoice_id, phase, status, discount_amount, currency, committed_at, released_at, release_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
    )
    .run(row.promo_id, row.client_id, row.client_order_id, row.invoice_id, row.phase, row.status, row.discount_amount, row.currency, now, now);
}

export async function countPromoRedemptionsForClient(promoId: number, clientId: number): Promise<number> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM promo_redemption WHERE promo_id = ? AND client_id = ? AND status != 'released'")
    .get(promoId, clientId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface TaxRuleRow {
  id: number;
  name: string | null;
  country: string | null;
  state: string | null;
  taxrate: string;
}

export async function findTaxRule(state: string | null, country: string | null): Promise<TaxRuleRow | undefined> {
  return await getDb()
    .prepare("SELECT id, name, country, state, taxrate FROM tax WHERE state IS ? AND country IS ?")
    .get(state, country) as TaxRuleRow | undefined;
}

export async function findTaxRuleByCountry(country: string): Promise<TaxRuleRow | undefined> {
  // Mirrors TaxRepository::findOneByCountry: ANY rule with this country
  // (a state-specific rule can be the first match — PHP parity quirk).
  return await getDb()
    .prepare("SELECT id, name, country, state, taxrate FROM tax WHERE country = ? ORDER BY id ASC")
    .get(country) as TaxRuleRow | undefined;
}

export async function findGlobalTaxRule(): Promise<TaxRuleRow | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, name, country, state, taxrate FROM tax WHERE (country IS NULL OR country = '') AND (state IS NULL OR state = '') ORDER BY id ASC",
    )
    .get() as TaxRuleRow | undefined;
}

export async function insertOrder(row: {
  client_id: number;
  product_id: number;
  form_id: number | null;
  promo_id: number | null;
  promo_recurring?: number | null;
  promo_used?: number | null;
  group_id: string | null;
  group_master: number;
  invoice_option: string;
  title: string;
  currency: string;
  unpaid_invoice_id: number | null;
  service_type: string | null;
  period: string | null;
  quantity: number | null;
  unit: string | null;
  price: number;
  discount: number | null;
  status: string;
  notes: string | null;
  config: string;
  suspension_grace_days: number | null;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`, row.client_id, row.product_id, row.form_id, row.promo_id, row.promo_recurring ?? null, row.promo_used ?? null, row.group_id, row.group_master, row.invoice_option, row.title, row.currency, row.unpaid_invoice_id, row.service_type, row.period, row.quantity, row.unit, String(row.price), row.discount === null || row.discount === undefined ? null : String(row.discount), row.status, row.notes, row.config, row.suspension_grace_days, now, now);
  return Number(info);
}

export async function updateOrderUnpaidInvoice(id: number, invoiceId: number): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE client_order SET unpaid_invoice_id = ?, updated_at = ? WHERE id = ?")
    .run(invoiceId, nowTimestamp(), id);
}

export async function insertOrderStatus(orderId: number, status: string, notes: string | null): Promise<void> {
  const now = nowTimestamp();
  await getDbWrite()
    .prepare("INSERT INTO client_order_status (status, notes, created_at, updated_at, client_order_id) VALUES (?, ?, ?, ?, ?)")
    .run(status, notes, now, now, orderId);
}

export async function insertInvoice(row: {
  client_id: number;
  serie: string | null;
  nr: string | null;
  hash: string;
  hash_expires_at: string | null;
  currency: string;
  currency_rate: number | null;
  credit: number;
  status: string;
  taxname: string;
  taxrate: string;
  gateway_id: number | null;
  due_at: string;
  notes: string | null;
}): Promise<number> {
  const now = nowTimestamp();
  // R5b: PHP leaves currency_rate, base_income and base_refund NULL at
  // creation; they are first written by payment (rate + countIncome).
  // The old literals (0, 0) encoded the R1 divergence.
  const info = await getDbWrite().insertAndGetId(`INSERT INTO invoice (client_id, serie, nr, hash, currency, currency_rate, credit, base_income, base_refund, refund, notes, text_1, text_2, status, credit_note_for_invoice_id, debit_note_for_invoice_id, replaces_invoice_id, replaced_by_invoice_id, seller_company, seller_company_vat, seller_company_number, seller_address, seller_phone, seller_email, buyer_first_name, buyer_last_name, buyer_company, buyer_company_vat, buyer_company_number, buyer_address, buyer_city, buyer_state, buyer_country, buyer_zip, buyer_phone, buyer_email, issued, taxname, taxrate, due_at, reminded_at, paid_at, hash_expires_at, created_at, updated_at, gateway_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`, row.client_id, row.serie, row.nr, row.hash, row.currency, row.currency_rate, row.notes, row.status, row.taxname, row.taxrate, row.due_at, row.hash_expires_at, now, now, row.gateway_id);
  return Number(info);
}

export async function insertInvoiceItem(row: {
  invoice_id: number;
  type: string;
  rel_id: number | null;
  task: string;
  status: string;
  title: string;
  period: string | null;
  quantity: number;
  unit: string | null;
  price: number;
  taxed: number;
  refunded_item_id?: number | null;
  charged?: number;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO invoice_item (type, rel_id, refunded_item_id, task, status, title, period, quantity, unit, price, charged, taxed, attempts, created_at, updated_at, invoice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`, row.type, row.rel_id === null || row.rel_id === undefined ? null : String(row.rel_id), row.refunded_item_id ?? null, row.task, row.status, row.title, row.period, row.quantity, row.unit, String(row.price), row.charged ?? 0, row.taxed, now, now, row.invoice_id);
  return Number(info);
}

export async function updateInvoiceRow(
  id: number,
  fields: Partial<{
    status: string;
    issued: number;
    paid_at: string | null;
    buyer_first_name: string | null;
    buyer_last_name: string | null;
    buyer_company: string | null;
    buyer_company_vat: string | null;
    buyer_company_number: string | null;
    buyer_address: string | null;
    buyer_city: string | null;
    buyer_state: string | null;
    buyer_country: string | null;
    buyer_zip: string | null;
    buyer_phone: string | null;
    buyer_email: string | null;
    seller_company: string | null;
    seller_company_vat: string | null;
    seller_company_number: string | null;
    seller_address: string | null;
    seller_phone: string | null;
    seller_email: string | null;
  }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE invoice SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function maxInvoiceNr(serie: string | null): Promise<number> {
  const row = await getDb()
    .prepare("SELECT MAX(CAST(nr AS INTEGER)) AS m FROM invoice WHERE serie IS ?")
    .get(serie) as { m: number | null } | undefined;
  return row?.m ?? 0;
}

export async function invoiceNrExists(serie: string | null, nr: string): Promise<boolean> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM invoice WHERE serie IS ? AND nr = ?")
    .get(serie, nr) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

export async function insertInvoiceEvent(
  invoiceId: number,
  type: string,
  snapshot: unknown,
  opts: { clientId?: number | null; createdAt?: string | null } = {},
): Promise<void> {
  // R5f: the new cron events (generate CREATED/ISSUED, reminder,
  // expired-unpaid canceled, journal backfill) carry PHP's real
  // client_id and, for the backfill, the invoice's own created_at.
  // Pre-existing callers pass no opts and keep the old shape
  // (client_id NULL, created_at now) — their snapshot shapes and
  // the NULL-client_id gap are deliberately NOT rewritten here.
  await getDbWrite()
    .prepare(
      "INSERT INTO invoice_event (invoice_id, type, admin_id, client_id, snapshot, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
    )
    .run(invoiceId, type, opts.clientId ?? null, JSON.stringify(snapshot), opts.createdAt ?? nowTimestamp());
}

export async function listInvoiceItems(invoiceId: number): Promise<{
  id: number; type: string | null; rel_id: number | null; task: string | null;
  status: string | null; title: string | null; period: string | null;
  quantity: number; unit: string | null; price: number; charged: number; taxed: number;
  refunded_item_id: number | null;
}[]> {
  return await getDb()
    .prepare(
      "SELECT id, type, rel_id, refunded_item_id, task, status, title, period, quantity, unit, price, charged, taxed FROM invoice_item WHERE invoice_id = ? ORDER BY id ASC",
    )
    .all(invoiceId) as never[];
}

export async function findInvoiceRow(id: number): Promise<Record<string, unknown> | undefined> {
  return await getDb().prepare("SELECT * FROM invoice WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

export async function markInvoiceItemsCharged(invoiceId: number): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE invoice_item SET charged = price * quantity, updated_at = ? WHERE invoice_id = ?")
    .run(nowTimestamp(), invoiceId);
}

export async function setSettingValue(param: string, value: string): Promise<void> {
  await upsertSetting(param, value);
}

export async function setClientCurrency(clientId: number, currency: string): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE client SET currency = ?, updated_at = ? WHERE id = ?")
    .run(currency, nowTimestamp(), clientId);
}

export async function insertBalanceRow(row: {
  client_id: number;
  type: string;
  // VARCHAR(20) in the schema — PHP stores PayPal txn ids here.
  rel_id: number | string | null;
  amount: number;
  description: string;
}): Promise<void> {
  const now = nowTimestamp();
  await getDbWrite()
    .prepare(
      "INSERT INTO client_balance (type, rel_id, invoice_item_id, amount, description, created_at, updated_at, client_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    )
    // rel_id is VARCHAR: bind as text, or node:sqlite stores a float
    // ('263.0') where PHP stores '263'.
    .run(row.type, row.rel_id === null ? null : String(row.rel_id), row.amount, row.description, now, now, row.client_id);
}

// ---------------------------------------------------------------------------
// Invoice module helpers (Phase 3 batch 2).
// ---------------------------------------------------------------------------

export interface InvoiceRowFull {
  id: number;
  client_id: number;
  serie: string | null;
  nr: string | null;
  hash: string;
  currency: string;
  currency_rate: number | null;
  credit: number | null;
  base_income: number | null;
  base_refund: number | null;
  refund: number | null;
  notes: string | null;
  text_1: string | null;
  text_2: string | null;
  status: string;
  credit_note_for_invoice_id: number | null;
  debit_note_for_invoice_id: number | null;
  replaces_invoice_id: number | null;
  replaced_by_invoice_id: number | null;
  seller_company: string | null;
  seller_company_vat: string | null;
  seller_company_number: string | null;
  seller_address: string | null;
  seller_phone: string | null;
  seller_email: string | null;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_company: string | null;
  buyer_company_vat: string | null;
  buyer_company_number: string | null;
  buyer_address: string | null;
  buyer_city: string | null;
  buyer_state: string | null;
  buyer_country: string | null;
  buyer_zip: string | null;
  buyer_phone: string | null;
  buyer_email: string | null;
  issued: number;
  taxname: string | null;
  taxrate: string | null;
  due_at: string | null;
  reminded_at: string | null;
  paid_at: string | null;
  hash_expires_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  gateway_id: number | null;
}

export async function findInvoiceById(id: number): Promise<InvoiceRowFull | undefined> {
  return await getDb().prepare("SELECT * FROM invoice WHERE id = ?").get(id) as
    | InvoiceRowFull
    | undefined;
}

export async function findInvoiceByHash(hash: string): Promise<InvoiceRowFull | undefined> {
  return await getDb().prepare("SELECT * FROM invoice WHERE hash = ?").get(hash) as
    | InvoiceRowFull
    | undefined;
}

export async function listInvoices(filters: {
  client_id?: number;
  status?: string;
  currency?: string;
}): Promise<InvoiceRowFull[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters.client_id !== undefined) { where.push("client_id = ?"); vals.push(filters.client_id); }
  if (filters.status) { where.push("status = ?"); vals.push(filters.status); }
  if (filters.currency) { where.push("currency = ?"); vals.push(filters.currency); }
  const sql = `SELECT * FROM invoice ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return await getDb().prepare(sql).all(...(vals as never[])) as unknown as InvoiceRowFull[];
}

export async function updateInvoiceFields(
  id: number,
  fields: Partial<{
    status: string; notes: string | null; text_1: string | null; text_2: string | null;
    due_at: string | null; gateway_id: number | null; taxname: string | null;
    taxrate: string | null; paid_at: string | null;
    serie: string; nr: string; issued: number; refund: number; credit: number;
    base_refund: number; replaced_by_invoice_id: number | null; reminded_at: string | null;
  }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE invoice SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function deleteInvoiceCascade(id: number): Promise<void> {
  const w = getDbWrite();
  await w.prepare("DELETE FROM invoice_item WHERE invoice_id = ?").run(id);
  await w.prepare("DELETE FROM invoice_event WHERE invoice_id = ?").run(id);
  await w.prepare("DELETE FROM invoice WHERE id = ?").run(id);
}

export async function deleteInvoiceItemRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM invoice_item WHERE id = ?").run(id);
}

export async function updateInvoiceItemRow(
  id: number,
  fields: Partial<{ title: string; price: number; quantity: number; taxed: number; period: string | null; unit: string | null }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE invoice_item SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function findInvoiceItemRow(id: number): Promise<{ id: number; invoice_id: number } | undefined> {
  return await getDb().prepare("SELECT id, invoice_id FROM invoice_item WHERE id = ?").get(id) as
    | { id: number; invoice_id: number }
    | undefined;
}

export async function insertTransaction(row: {
  txn_id: string | null;
  amount: number;
  currency: string;
  status: string;
  ip: string | null;
  ipn: string;
  ipn_hash: string;
  note: string | null;
  invoice_id: number;
  gateway_id: number;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO "transaction" (txn_id, txn_status, s_id, s_period, amount, currency, type, status, ip, error, error_code, ipn, ipn_hash, output, note, created_at, updated_at, invoice_id, gateway_id)
       VALUES (?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`, row.txn_id, row.amount, row.currency, row.status, row.ip, row.ipn, row.ipn_hash, row.note, now, now, row.invoice_id, row.gateway_id);
  return Number(info);
}

export async function findTransactionByTxnId(txnId: string): Promise<{ id: number; invoice_id: number | null } | undefined> {
  return await getDb().prepare('SELECT id, invoice_id FROM "transaction" WHERE txn_id = ?').get(txnId) as
    | { id: number; invoice_id: number | null }
    | undefined;
}

/**
 * Invoice\ServiceTransaction::create dedupe, first leg: an existing
 * PROCESSED row for the same gateway + external id is returned as-is.
 */
export async function findProcessedTransaction(gatewayId: number, txnId: string): Promise<{ id: number; invoice_id: number | null } | undefined> {
  return await getDb()
    .prepare('SELECT id, invoice_id FROM "transaction" WHERE gateway_id = ? AND txn_id = ? AND status = \'processed\'')
    .get(gatewayId, txnId) as { id: number; invoice_id: number | null } | undefined;
}

/** Second dedupe leg: same gateway + canonical IPN hash. */
export async function findTransactionByGatewayHash(gatewayId: number, ipnHash: string): Promise<{ id: number; invoice_id: number | null } | undefined> {
  return await getDb()
    .prepare('SELECT id, invoice_id FROM "transaction" WHERE gateway_id = ? AND ipn_hash = ?')
    .get(gatewayId, ipnHash) as { id: number; invoice_id: number | null } | undefined;
}

/** The mark-as-paid settlement update: amount/currency/status/note. */
export async function settleTransaction(id: number, amount: number, currency: string, note: string): Promise<void> {
  await getDbWrite()
    .prepare('UPDATE "transaction" SET amount = ?, currency = ?, status = \'processed\', note = ?, updated_at = ? WHERE id = ?')
    .run(amount, currency, note, nowTimestamp(), id);
}

export async function findGateway(id: number): Promise<{ id: number; gateway: string; enabled: number } | undefined> {
  return await getDb().prepare("SELECT id, gateway, enabled FROM pay_gateway WHERE id = ?").get(id) as
    | { id: number; gateway: string; enabled: number }
    | undefined;
}

export async function listGateways(): Promise<{ id: number; gateway: string; enabled: number; name: string | null }[]> {
  return await getDb()
    .prepare("SELECT id, gateway, enabled, name FROM pay_gateway ORDER BY id ASC")
    .all() as never[];
}

export interface TaxRow {
  id: number;
  level: string | null;
  name: string | null;
  country: string | null;
  state: string | null;
  taxrate: string;
  created_at: string | null;
  updated_at: string | null;
}

const TAX_COLS = "id, level, name, country, state, taxrate, created_at, updated_at";

export async function listTaxRules(): Promise<TaxRow[]> {
  return await getDb().prepare(`SELECT ${TAX_COLS} FROM tax ORDER BY id ASC`).all() as unknown as TaxRow[];
}

export async function findTaxById(id: number): Promise<TaxRow | undefined> {
  return await getDb().prepare(`SELECT ${TAX_COLS} FROM tax WHERE id = ?`).get(id) as TaxRow | undefined;
}

export async function insertTax(row: {
  name: string;
  taxrate: string;
  country: string | null;
  state: string | null;
  level: string | null;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO tax (level, name, country, state, taxrate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", row.level, row.name, row.country, row.state, row.taxrate, now, now);
  return Number(info);
}

export async function updateTaxRow(
  id: number,
  fields: Partial<{ name: string; taxrate: string; country: string | null; state: string | null; level: string | null }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE tax SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function deleteTaxRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM tax WHERE id = ?").run(id);
}

export async function ordersForInvoice(invoiceId: number): Promise<{
  id: number;
  title: string;
  expires_at: string | null;
  product_name: string | null;
  product_type: string | null;
}[]> {
  return await getDb()
    .prepare(
      `SELECT o.id AS id, o.title AS title, o.expires_at AS expires_at,
              p.title AS product_name, p.type AS product_type
       FROM invoice_item ii
       JOIN client_order o ON o.id = ii.rel_id
       LEFT JOIN product p ON p.id = o.product_id
       WHERE ii.invoice_id = ? AND ii.type = 'order' AND ii.rel_id IS NOT NULL
       ORDER BY o.id ASC`,
    )
    .all(invoiceId) as never[];
}

/** Invoice\\Service::getInvoicePromoApplications: checkout-phase
 * redemptions grouped by promo:order, with the discount title. */
export async function promoApplicationsForInvoice(invoiceId: number): Promise<Record<string, unknown>[]> {
  const inv = await getDb().prepare("SELECT status FROM invoice WHERE id = ?").get(invoiceId) as { status: string } | undefined;
  const rows = await getDb()
    .prepare(
      `SELECT pr.promo_id, pr.client_order_id, pr.status, pr.discount_amount,
              p.code AS promo_code, p.type AS promo_type, p.value AS promo_value
       FROM promo_redemption pr
       LEFT JOIN promo p ON p.id = pr.promo_id
       WHERE pr.invoice_id = ? AND pr.phase = 'checkout' ORDER BY pr.id ASC`,
    )
    .all(invoiceId) as unknown as {
      promo_id: number; client_order_id: number | null; status: string; discount_amount: number;
      promo_code: string | null; promo_type: string | null; promo_value: number | null;
    }[];
  const grouped = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.promo_code === null) continue; // promo row deleted: skipped
    const key = `${r.promo_id}:${r.client_order_id ?? 0}`;
    const existing = grouped.get(key);
    if (existing) {
      existing["discount_amount"] = Math.round(((existing["discount_amount"] as number) + (Number(r.discount_amount) || 0)) * 100) / 100;
      if (r.status === "reserved") existing["removable"] = true;
    } else {
      const title =
        r.promo_type === "percentage"
          ? `Promotional Code: ${r.promo_code} - ${r.promo_value ?? 0}%`
          : r.promo_type === "absolute"
            ? `Promotional Code: ${r.promo_code} - ${r.promo_value ?? 0} Discount`
            : `Promotional Code: ${r.promo_code}`;
      grouped.set(key, {
        promo_id: r.promo_id,
        code: r.promo_code,
        title,
        order_id: r.client_order_id,
        discount_amount: Math.round((Number(r.discount_amount) || 0) * 100) / 100,
        status: r.status,
        removable: r.status === "reserved",
      });
    }
  }
  const unpaid = inv?.status === "unpaid";
  for (const entry of grouped.values()) {
    entry["removable"] = (entry["removable"] as boolean) && unpaid;
  }
  return [...grouped.values()];
}

// ---------------------------------------------------------------------------
// Order / transaction / subscription helpers (Phase 3 batch 3).
// ---------------------------------------------------------------------------

export interface OrderRowFull {
  id: number;
  client_id: number;
  product_id: number | null;
  form_id: number | null;
  promo_id: number | null;
  promo_recurring: number | null;
  promo_used: number | null;
  group_id: string | null;
  group_master: number;
  invoice_option: string | null;
  title: string | null;
  currency: string | null;
  unpaid_invoice_id: number | null;
  service_id: number | null;
  service_type: string | null;
  period: string | null;
  quantity: number;
  unit: string | null;
  price: number;
  discount: number | null;
  status: string;
  reason: string | null;
  notes: string | null;
  config: string | null;
  suspension_grace_days: number | null;
  referred_by: string | null;
  expires_at: string | null;
  activated_at: string | null;
  suspended_at: string | null;
  unsuspended_at: string | null;
  canceled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const ORDER_COLS = `id, client_id, product_id, form_id, promo_id, promo_recurring, promo_used,
  group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id,
  service_type, period, quantity, unit, price, discount, status, reason, notes, config,
  suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at,
  canceled_at, created_at, updated_at`;

export async function findOrderById(id: number): Promise<OrderRowFull | undefined> {
  return await getDb().prepare(`SELECT ${ORDER_COLS} FROM client_order WHERE id = ?`).get(id) as
    | OrderRowFull
    | undefined;
}

export async function listOrders(filters: {
  client_id?: number;
  status?: string;
  product_id?: number;
}): Promise<OrderRowFull[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters.client_id !== undefined) { where.push("client_id = ?"); vals.push(filters.client_id); }
  if (filters.status) { where.push("status = ?"); vals.push(filters.status); }
  if (filters.product_id !== undefined) { where.push("product_id = ?"); vals.push(filters.product_id); }
  const sql = `SELECT ${ORDER_COLS} FROM client_order ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return await getDb().prepare(sql).all(...(vals as never[])) as unknown as OrderRowFull[];
}

export async function updateOrderRow(
  id: number,
  fields: Partial<{
    status: string; notes: string | null; reason: string | null; expires_at: string | null;
    activated_at: string | null; suspended_at: string | null; unsuspended_at: string | null;
    canceled_at: string | null; unpaid_invoice_id: number | null; config: string | null;
    service_id: number | null;
  }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE client_order SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function deleteOrderCascade(id: number): Promise<void> {
  const w = getDbWrite();
  await w.prepare("DELETE FROM client_order_status WHERE client_order_id = ?").run(id);
  await w.prepare("DELETE FROM client_order WHERE id = ?").run(id);
}

export async function listOrderStatusHistory(orderId: number): Promise<{
  id: number; status: string; notes: string | null; created_at: string | null;
  updated_at: string | null; client_order_id: number;
}[]> {
  return await getDb()
    .prepare(
      "SELECT id, status, notes, created_at, updated_at, client_order_id FROM client_order_status WHERE client_order_id = ? ORDER BY id DESC",
    )
    .all(orderId) as never[];
}

export async function deleteOrderStatusRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM client_order_status WHERE id = ?").run(id);
}

export async function orderStatusCounts(): Promise<Record<string, number>> {
  // PHP's Order counter() counts group masters only; on the
  // reference DB every order is a master, so this never changed
  // a parity result — but the filter is the faithful query.
  const rows = await getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM client_order WHERE group_master = 1 GROUP BY status")
    .all() as unknown as { status: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function countActiveTicketsForOrder(orderId: number): Promise<number> {
  try {
    const row = await getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM support_ticket WHERE rel_id = ? AND rel_type = 'order' AND status NOT IN ('closed')",
      )
      .get(orderId) as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

export interface TransactionRowFull {
  id: number;
  txn_id: string | null;
  txn_status: string | null;
  s_id: string | null;
  s_period: string | null;
  amount: string | null;
  currency: string | null;
  type: string | null;
  status: string | null;
  ip: string | null;
  error: string | null;
  error_code: number | null;
  ipn: string | null;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
  invoice_id: number | null;
  gateway_id: number | null;
}

const TX_COLS = `id, txn_id, txn_status, s_id, s_period, amount, currency, type, status, ip,
  error, error_code, ipn, note, created_at, updated_at, invoice_id, gateway_id`;

export async function findTransactionById(id: number): Promise<TransactionRowFull | undefined> {
  return await getDb().prepare(`SELECT ${TX_COLS} FROM "transaction" WHERE id = ?`).get(id) as
    | TransactionRowFull
    | undefined;
}

export async function listTransactions(filters: { invoice_id?: number; status?: string }): Promise<TransactionRowFull[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters.invoice_id !== undefined) { where.push("invoice_id = ?"); vals.push(filters.invoice_id); }
  if (filters.status) { where.push("status = ?"); vals.push(filters.status); }
  const sql = `SELECT ${TX_COLS} FROM "transaction" ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return await getDb().prepare(sql).all(...(vals as never[])) as unknown as TransactionRowFull[];
}

export async function insertTransactionFull(row: {
  txn_id: string | null; txn_status: string | null; amount: string | null;
  currency: string | null; type: string | null; status: string | null; ip: string | null;
  ipn: string; note: string | null; invoice_id: number | null; gateway_id: number | null;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO "transaction" (txn_id, txn_status, s_id, s_period, amount, currency, type, status, ip, error, error_code, ipn, ipn_hash, output, note, created_at, updated_at, invoice_id, gateway_id)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`, row.txn_id, row.txn_status, row.amount, row.currency, row.type, row.status, row.ip, row.ipn, sha256Hex(row.ipn), row.note, now, now, row.invoice_id, row.gateway_id);
  return Number(info);
}

export async function updateTransactionRow(
  id: number,
  fields: Partial<{
    txn_id: string | null; txn_status: string | null; amount: string | null;
    currency: string | null; type: string | null; status: string | null;
    s_id: string | null; s_period: string | null; note: string | null;
    error: string | null; error_code: number | null; invoice_id: number;
    gateway_id: number;
  }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE "transaction" SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function deleteTransactionRow(id: number): Promise<void> {
  await getDbWrite().prepare('DELETE FROM "transaction" WHERE id = ?').run(id);
}

export async function transactionStatusCounts(): Promise<Record<string, number>> {
  const rows = await getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM "transaction" GROUP BY status')
    .all() as unknown as { status: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export interface SubscriptionRowFull {
  id: number;
  sid: string | null;
  period: string | null;
  amount: string | null;
  currency: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  client_id: number | null;
  pay_gateway_id: number | null;
  rel_id: number | null;
  rel_type: string | null;
}

export async function findSubscriptionById(id: number): Promise<SubscriptionRowFull | undefined> {
  return await getDb().prepare("SELECT * FROM subscription WHERE id = ?").get(id) as
    | SubscriptionRowFull
    | undefined;
}

export async function findSubscriptionBySid(sid: string): Promise<SubscriptionRowFull | undefined> {
  return await getDb().prepare("SELECT * FROM subscription WHERE sid = ?").get(sid) as
    | SubscriptionRowFull
    | undefined;
}

export async function listSubscriptions(): Promise<SubscriptionRowFull[]> {
  return await getDb().prepare("SELECT * FROM subscription ORDER BY id DESC").all() as unknown as SubscriptionRowFull[];
}

export async function insertSubscription(row: {
  sid: string | null; period: string | null; amount: string | null; currency: string | null;
  status: string | null; client_id: number | null; pay_gateway_id: number | null;
  rel_id: number | null; rel_type: string | null;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO subscription (sid, period, amount, currency, status, created_at, updated_at, client_id, pay_gateway_id, rel_id, rel_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", row.sid, row.period, row.amount, row.currency, row.status, now, now, row.client_id, row.pay_gateway_id, row.rel_id, row.rel_type);
  return Number(info);
}

export async function updateSubscriptionRow(
  id: number,
  fields: Partial<{
    sid: string | null; period: string | null; amount: string | null;
    currency: string | null; status: string | null; rel_id: number | null; rel_type: string | null;
  }>,
): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const vals = entries.map(([, v]) => v);
  await getDbWrite()
    .prepare(`UPDATE subscription SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(vals as never[]), nowTimestamp(), id);
}

export async function deleteSubscriptionRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM subscription WHERE id = ?").run(id);
}

export async function findGatewayFull(id: number): Promise<{
  id: number; gateway: string; enabled: number; name: string | null;
} | undefined> {
  return await getDb()
    .prepare("SELECT id, gateway, enabled, name FROM pay_gateway WHERE id = ?")
    .get(id) as
    | { id: number; gateway: string; enabled: number; name: string | null }
    | undefined;
}

/** Full pay_gateway row for payment-adapter config merging. */
export async function findPayGatewayRow(id: number): Promise<{
  id: number; gateway: string; name: string | null; enabled: number;
  test_mode: number; allow_single: number; allow_recurrent: number; config: string | null;
} | undefined> {
  return await getDb()
    .prepare(
      "SELECT id, gateway, name, enabled, test_mode, allow_single, allow_recurrent, config FROM pay_gateway WHERE id = ?",
    )
    .get(id) as
    | {
        id: number; gateway: string; name: string | null; enabled: number;
        test_mode: number; allow_single: number; allow_recurrent: number; config: string | null;
      }
    | undefined;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function insertOrderStatusReturningId(orderId: number, status: string, notes: string | null): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO client_order_status (status, notes, created_at, updated_at, client_order_id) VALUES (?, ?, ?, ?, ?)", status, notes, now, now, orderId);
  return Number(info);
}

export async function insertCustomService(clientId: number, config: string | null): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO service_custom (client_id, plugin, plugin_config, config, created_at, updated_at) VALUES (?, NULL, NULL, ?, ?, ?)", clientId, config, now, now);
  return Number(info);
}

export async function creditNoteIdsFor(invoiceId: number): Promise<number[]> {
  const rows = await getDb()
    .prepare("SELECT id FROM invoice WHERE credit_note_for_invoice_id = ? ORDER BY id ASC")
    .all(invoiceId) as unknown as { id: number }[];
  return rows.map((r) => r.id);
}

export async function nextNrForSerie(serie: string): Promise<number> {
  const row = await getDb()
    .prepare("SELECT MAX(CAST(nr AS INTEGER)) AS m FROM invoice WHERE serie = ?")
    .get(serie) as { m: number | null };
  return (row.m ?? 0) + 1;
}

export interface InvoiceEventRow {
  id: number;
  type: string;
  admin_id: number | null;
  client_id: number | null;
  snapshot: string | null;
  created_at: string | null;
}

export async function listInvoiceEvents(invoiceId: number): Promise<InvoiceEventRow[]> {
  return await getDb()
    .prepare(
      "SELECT id, type, admin_id, client_id, snapshot, created_at FROM invoice_event WHERE invoice_id = ? ORDER BY id ASC",
    )
    .all(invoiceId) as unknown as InvoiceEventRow[];
}


/** Full-control invoice insert for credit/debit notes (batch 4):
 * snapshots and link fields are copied from the original invoice.
 * R5b: notes carry no rate and no refund on PHP; a debit note's
 * base_income is written by countIncome AFTER its items exist. */
export async function insertInvoiceNote(row: {
  client_id: number;
  serie: string;
  nr: string | null;
  hash: string;
  currency: string;
  currency_rate: number | null;
  status: string;
  credit_note_for_invoice_id: number | null;
  debit_note_for_invoice_id: number | null;
  replaces_invoice_id: number | null;
  seller_company: string | null;
  seller_company_vat: string | null;
  seller_company_number: string | null;
  seller_address: string | null;
  seller_phone: string | null;
  seller_email: string | null;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_company: string | null;
  buyer_company_vat: string | null;
  buyer_company_number: string | null;
  buyer_address: string | null;
  buyer_city: string | null;
  buyer_state: string | null;
  buyer_country: string | null;
  buyer_zip: string | null;
  buyer_phone: string | null;
  buyer_email: string | null;
  issued: number;
  taxname: string;
  taxrate: string;
  due_at: string | null;
  paid_at: string | null;
  notes: string | null;
  gateway_id: number | null;
  hash_expires_at?: string | null;
  base_income?: number | string | null;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO invoice (client_id, serie, nr, hash, currency, currency_rate, credit, base_income, base_refund, refund, notes, text_1, text_2, status, credit_note_for_invoice_id, debit_note_for_invoice_id, replaces_invoice_id, replaced_by_invoice_id, seller_company, seller_company_vat, seller_company_number, seller_address, seller_phone, seller_email, buyer_first_name, buyer_last_name, buyer_company, buyer_company_vat, buyer_company_number, buyer_address, buyer_city, buyer_state, buyer_country, buyer_zip, buyer_phone, buyer_email, issued, taxname, taxrate, due_at, reminded_at, paid_at, hash_expires_at, created_at, updated_at, gateway_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`, row.client_id, row.serie, row.nr, row.hash, row.currency, row.currency_rate, row.base_income ?? null, row.notes, row.status, row.credit_note_for_invoice_id, row.debit_note_for_invoice_id, row.replaces_invoice_id, row.seller_company, row.seller_company_vat, row.seller_company_number, row.seller_address, row.seller_phone, row.seller_email, row.buyer_first_name, row.buyer_last_name, row.buyer_company, row.buyer_company_vat, row.buyer_company_number, row.buyer_address, row.buyer_city, row.buyer_state, row.buyer_country, row.buyer_zip, row.buyer_phone, row.buyer_email, row.issued, row.taxname, row.taxrate, row.due_at, row.paid_at, row.hash_expires_at ?? null, now, now, row.gateway_id);
  return Number(info);
}

/* ------------------------------------------------------------------ */
/* Phase 5 R1 leftovers sub-batch 2: formbuilder, redirect, antispam */
/* (via extension_meta), activity email log, product pairs, dashboard */
/* queries, and the module-active gate for non-core modules.         */
/* ------------------------------------------------------------------ */

/** Core modules are always active (Module::CORE_MODULES); any other
 * module is active iff an extension row type='mod', name=module,
 * status='installed' exists (ExtensionRepository::existsActiveByTypeAndName). */
const CORE_MODULES = new Set([
  "api", "activity", "antispam", "cart", "client", "cron", "currency", "email", "extension",
  "index", "invoice", "order", "page", "product", "profile", "security",
  "servicecustom", "servicedomain", "servicedownloadable", "servicehosting", "servicelicense",
  "staff", "stats", "support", "system", "theme", "orderbutton", "formbuilder", "widgets",
]);

export async function isModuleActive(mod: string): Promise<boolean> {
  if (CORE_MODULES.has(mod)) return true;
  const row = await getDb()
    .prepare("SELECT 1 AS one FROM extension WHERE type = 'mod' AND name = ? AND status = 'installed'")
    .get(mod) as { one: number } | undefined;
  return !!row;
}

export interface FormRow {
  id: number;
  name: string | null;
  style: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface FormFieldRow {
  id: number;
  name: string | null;
  label: string | null;
  hide_label: number | null;
  description: string | null;
  type: string | null;
  default_value: string | null;
  required: number | null;
  hidden: number | null;
  readonly: number | null;
  is_unique: number | null;
  prefix: string | null;
  suffix: string | null;
  options: string | null;
  show_initial: string | null;
  show_middle: string | null;
  show_prefix: string | null;
  show_suffix: string | null;
  text_size: number | null;
  created_at: string | null;
  updated_at: string | null;
  form_id: number | null;
}

export async function insertForm(name: string, style: string): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO form (name, style, created_at, updated_at) VALUES (?, ?, ?, ?)", name, style, ts, ts);
  return Number(info);
}

export async function findForm(id: number): Promise<FormRow | undefined> {
  return await getDb().prepare("SELECT * FROM form WHERE id = ?").get(id) as unknown as FormRow | undefined;
}

export async function listFormsWithCounts(): Promise<{ id: number; name: string | null; product_count: number; order_count: number }[]> {
  return await getDb()
    .prepare(
      `SELECT f.id, f.name, COUNT(p.id) AS product_count, COUNT(co.id) AS order_count
       FROM form f
       LEFT JOIN product p ON f.id = p.form_id
       LEFT JOIN client_order co ON f.id = co.form_id
       GROUP BY f.id`,
    )
    .all() as never[];
}

export async function listFormPairs(): Promise<{ id: number; name: string | null }[]> {
  return await getDb().prepare("SELECT id, name FROM form").all() as never[];
}

export async function updateFormRow(id: number, name: string, style: string): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE form SET name = ?, style = ?, updated_at = ? WHERE id = ?")
    .run(name, style, nowTimestamp(), id);
}

export async function deleteFormCascade(id: number): Promise<void> {
  const w = getDbWrite();
  await w.prepare("DELETE FROM form_field WHERE form_id = ?").run(id);
  await w.prepare("DELETE FROM form WHERE id = ?").run(id);
  await w.prepare("UPDATE product SET form_id = NULL WHERE form_id = ?").run(id);
  await w.prepare("UPDATE client_order SET form_id = NULL WHERE form_id = ?").run(id);
}

export async function countFormFields(formId: number): Promise<number> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM form_field WHERE form_id = ?")
    .get(formId) as { n: number };
  return row.n;
}

export async function listFormFields(formId: number): Promise<FormFieldRow[]> {
  return await getDb()
    .prepare("SELECT * FROM form_field WHERE form_id = ? ORDER BY id ASC")
    .all(formId) as unknown as FormFieldRow[];
}

export async function findFormField(id: number): Promise<FormFieldRow | undefined> {
  return await getDb().prepare("SELECT * FROM form_field WHERE id = ?").get(id) as unknown as
    | FormFieldRow
    | undefined;
}

export async function insertFormField(f: {
  form_id: number | string;
  name: string;
  label: string;
  hide_label: unknown;
  description: unknown;
  type: string;
  default_value: unknown;
  required: unknown;
  hidden: unknown;
  readonly: unknown;
  options: unknown;
  prefix: unknown;
  suffix: unknown;
  show_initial: unknown;
  show_middle: unknown;
  show_prefix: unknown;
  show_suffix: unknown;
  text_size: unknown;
}): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO form_field (form_id, name, label, hide_label, description, type, default_value,
       required, hidden, readonly, options, prefix, suffix, show_initial, show_middle,
       show_prefix, show_suffix, text_size, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.form_id, f.name, f.label, f.hide_label as never, f.description as never, f.type, f.default_value as never, f.required as never, f.hidden as never, f.readonly as never, f.options as never, f.prefix as never, f.suffix as never, f.show_initial as never, f.show_middle as never, f.show_prefix as never, f.show_suffix as never, f.text_size as never, ts, ts);
  return Number(info);
}

export async function updateFormFieldRow(
  id: number,
  f: {
    name: string; label: string; hide_label: unknown; description: unknown; default_value: unknown;
    required: unknown; hidden: unknown; readonly: unknown; options: string; prefix: unknown;
    suffix: unknown; show_initial: unknown; show_middle: unknown; show_prefix: unknown;
    show_suffix: unknown; text_size: unknown;
  },
): Promise<void> {
  await getDbWrite()
    .prepare(
      `UPDATE form_field SET name = ?, label = ?, hide_label = ?, description = ?,
       default_value = ?, required = ?, hidden = ?, readonly = ?, options = ?, prefix = ?,
       suffix = ?, show_initial = ?, show_middle = ?, show_prefix = ?, show_suffix = ?,
       text_size = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      f.name, f.label, f.hide_label as never, f.description as never, f.default_value as never,
      f.required as never, f.hidden as never, f.readonly as never, f.options, f.prefix as never,
      f.suffix as never, f.show_initial as never, f.show_middle as never, f.show_prefix as never,
      f.show_suffix as never, f.text_size as never, nowTimestamp(), id,
    );
}

export async function deleteFormFieldRow(id: number): Promise<number> {
  const info = await getDbWrite().prepare("DELETE FROM form_field WHERE id = ?").run(id);
  return Number(info.changes);
}

export async function countFormFieldsNamed(formId: number | null, name: string, excludeId: number): Promise<number> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM form_field WHERE form_id = ? AND name = ? AND id != ?")
    .get(formId, name, excludeId) as { n: number };
  return row.n;
}

export interface ExtensionMetaRow {
  id: number;
  client_id: number | null;
  extension: string | null;
  rel_type: string | null;
  rel_id: string | null;
  meta_key: string | null;
  meta_value: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function listExtensionMetaByExtension(extension: string): Promise<ExtensionMetaRow[]> {
  return await getDb()
    .prepare("SELECT * FROM extension_meta WHERE extension = ? ORDER BY id ASC")
    .all(extension) as unknown as ExtensionMetaRow[];
}

export async function findExtensionMetaById(extension: string, id: number): Promise<ExtensionMetaRow | undefined> {
  return await getDb()
    .prepare("SELECT * FROM extension_meta WHERE extension = ? AND id = ?")
    .get(extension, id) as unknown as ExtensionMetaRow | undefined;
}

export async function insertExtensionMeta(extension: string, metaKey: string, metaValue: string): Promise<number> {
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO extension_meta (extension, meta_key, meta_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", extension, metaKey, metaValue, ts, ts);
  return Number(info);
}

export async function updateExtensionMetaRow(id: number, metaKey: string, metaValue: string): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE extension_meta SET meta_key = ?, meta_value = ?, updated_at = ? WHERE id = ?")
    .run(metaKey, metaValue, nowTimestamp(), id);
}

export async function deleteExtensionMetaRow(id: number): Promise<void> {
  await getDbWrite().prepare("DELETE FROM extension_meta WHERE id = ?").run(id);
}

export async function insertActivityClientEmail(row: {
  client_id: number | null;
  sender: string | null;
  recipients: string | null;
  subject: string;
  content_html: string | null;
  content_text: string | null;
}): Promise<number> {
  const info = await getDbWrite().insertAndGetId(`INSERT INTO activity_client_email (client_id, sender, recipients, subject, content_html,
       content_text, attachment_name, attachment_content, attachment_mime, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`, row.client_id, row.sender, row.recipients, row.subject, row.content_html, row.content_text, nowTimestamp());
  return Number(info);
}

export async function listProductPairs(filters: {
  productsOnly: boolean;
  activeOnly: boolean;
  type: string | null;
}): Promise<{ id: number; title: string | null }[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters.productsOnly) { where.push("is_addon = 0"); }
  if (filters.activeOnly) { where.push("active = 1"); }
  if (filters.type) { where.push("type = ?"); vals.push(filters.type); }
  const sql = `SELECT id, title FROM product ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC`;
  return await getDb().prepare(sql).all(...(vals as never[])) as never[];
}
