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
