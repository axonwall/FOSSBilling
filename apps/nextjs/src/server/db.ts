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
