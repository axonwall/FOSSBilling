// FOSSBilling Phase 5 R5j: seed replay for the TS installer. A faithful
// port of PHP's FOSSBilling\Doctrine\InstallSeeder (315 lines), reusing
// the SAME install/sql/content.sql text rather than duplicating its data
// — the seed data itself never has to be kept in sync between two places.
//
// Mirrored exactly, with file:line-level notes where the port must match:
//   * stripBookkeeping: drop empty lines + lines starting (after ltrim)
//     with '#', '/*!', 'LOCK TABLES', 'UNLOCK TABLES'.
//   * Backtick strip; NOW() -> the seed-time timestamp literal.
//   * splitStatements on ';' + optional CR + newline (InstallSeeder's
//     splitter, matching install.php's own splitter for this file).
//   * Per-statement unescape AFTER splitting (\n -> newline, \" -> "),
//     so an escaped ';\n' inside data is never a statement boundary.
//   * Boolean rewrite ONLY in genuinely boolean-mapped column positions,
//     from the same definitions the schema came from (INSTALL_SCHEMA),
//     so it cannot drift from a column's real type.
//   * Postgres sequence resync via pg_get_serial_sequence + setval to
//     MAX(id) (SQLite/MySQL need nothing: explicit inserts auto-advance).
//   * seedAdmin: admin row + admin_group_member (group 1), returns id.
//   * seedInstallNudge: setting last_error_reporting_nudge = version.
//   * setDefaultCurrency: currency id 1 -> chosen code.
//
// Timestamps use UTC ('YYYY-MM-DD HH:MM:SS'), matching the sandbox PHP
// default; they are install-time stamps, never compared across stacks.
// Password hashing (bcrypt cost 12, PHP PASSWORD_DEFAULT + cost 12) lives
// in the installer script, which passes the hash in — this module never
// sees a plaintext password.
import { INSTALL_SCHEMA } from "./install-schema";
import type { Db } from "./db";

export function formatSeedTimestamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function booleanColumnsByTable(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const table of INSTALL_SCHEMA) {
    for (const col of table.columns) {
      if (col.doctrine !== "boolean") continue;
      let set = out.get(table.name);
      if (!set) { set = new Set(); out.set(table.name, set); }
      set.add(col.name);
    }
  }
  return out;
}

function stripBookkeeping(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("/*!") &&
        !trimmed.startsWith("LOCK TABLES") &&
        !trimmed.startsWith("UNLOCK TABLES")
      );
    })
    .join("\n");
}

function splitStatements(sql: string): string[] {
  return sql
    .split(/;[\r]*\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// Split a VALUES clause's row tuples into field literals, respecting
// mysqldump's single-quoted strings and its '' escaped-quote convention.
function splitValueTuples(valuesList: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < valuesList.length; i++) {
    const ch = valuesList[i]!;
    if (inString) {
      field += ch;
      if (ch === "'") {
        if (valuesList[i + 1] === "'") { field += "'"; i++; }
        else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; field += ch; }
    else if (ch === "(") {
      depth++;
      if (depth > 1) field += ch;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) { fields.push(field); rows.push(fields); fields = []; field = ""; }
      else field += ch;
    } else if (ch === "," && depth === 1) { fields.push(field); field = ""; }
    else if (depth >= 1) field += ch;
    // Characters between tuples (commas, whitespace, newlines) at depth 0 are skipped.
  }
  return rows;
}

function portableizeBooleans(statement: string, booleanColumns: Map<string, Set<string>>): string {
  const m = /^INSERT INTO (\w+) \(([^)]+)\)\s*VALUES\s*(.*?);?$/is.exec(statement);
  if (!m) return statement;
  const [, table, columnList, valuesList] = m as unknown as [string, string, string, string];
  const boolCols = booleanColumns.get(table);
  if (!boolCols || boolCols.size === 0) return statement;
  const columns = columnList.split(",").map((c) => c.trim());
  const boolIndexes = columns
    .map((c, i) => (boolCols.has(c) ? i : -1))
    .filter((i) => i >= 0);
  if (boolIndexes.length === 0) return statement;
  const rows = splitValueTuples(valuesList).map((fields) => {
    for (const index of boolIndexes) {
      const value = fields[index]!.trim();
      if (value === "0") fields[index] = "false";
      else if (value === "1") fields[index] = "true";
    }
    return "(" + fields.join(",") + ")";
  });
  return `INSERT INTO ${table} (${columnList}) VALUES\n` + rows.join(",\n");
}

/**
 * Replay content.sql against `db`. Returns the seeded table names (for
 * the Postgres sequence resync) and the per-table row counts inserted.
 * When `isPostgres` is true, sequences are resynced exactly as PHP does;
 * on SQLite the resync is a no-op by design (rowid auto-advances).
 *
 * Content statements run through db.rawExec when the handle provides it
 * (DbPg, DbSqlite), falling back to db.exec. This is REQUIRED on
 * Postgres: DbPg's translateSql rewrites INSERT statements by parsing
 * their VALUES tuples WITHOUT string awareness ("code text has no
 * strings" — true for the app's own parameterized SQL, false for
 * content.sql's multi-row literal INSERTs, whose JSON strings contain
 * commas that break its item count). The content statements are fully
 * literal and already portableized (the boolean rewrite above turns 0/1
 * into false/true, which Postgres accepts as boolean literals), so
 * translation is both redundant and broken for them; rawExec executes
 * them verbatim on the SAME connection (still inside the transaction
 * when called on a tx handle). Everything else (sequence resync,
 * seedAdmin, currency, nudge) still goes through db, which needs
 * translation for its ? placeholders.
 */
export async function seedContent(
  db: Db,
  contentSql: string,
  nowIso: string,
  isPostgres: boolean,
): Promise<{ tables: string[]; counts: Record<string, number> }> {
  const booleanColumns = booleanColumnsByTable();
  let sql = stripBookkeeping(contentSql);
  sql = sql.replace(/`/g, "");
  sql = sql.replace(/NOW\(\)/g, `'${nowIso}'`);
  const seededTables: string[] = [];
  const counts: Record<string, number> = {};
  const exec = db.rawExec ? (s: string) => db.rawExec!(s) : (s: string) => db.exec(s);
  for (let statement of splitStatements(sql)) {
    statement = statement.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    statement = portableizeBooleans(statement, booleanColumns);
    await exec(statement);
    const im = /^INSERT INTO (\w+)/i.exec(statement);
    if (im) {
      const table = im[1]!;
      if (!seededTables.includes(table)) seededTables.push(table);
      const rows = splitValueTuples(
        statement.replace(/^INSERT INTO \w+ \([^)]+\)\s*VALUES\s*/is, ""),
      ).length;
      counts[table] = (counts[table] ?? 0) + rows;
    }
  }
  if (isPostgres) {
    for (const table of seededTables) {
      const row = await db
        .prepare("SELECT pg_get_serial_sequence(?, ?) AS seq")
        .get(table, "id");
      const seq = row?.["seq"];
      if (seq === null || seq === undefined) continue;
      await db
        .prepare(
          `SELECT setval(?, COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) FROM ${table}) IS NOT NULL)`,
        )
        .run(seq);
    }
  }
  return { tables: seededTables, counts };
}

export async function seedAdmin(
  db: Db,
  name: string,
  email: string,
  passwordHash: string,
  apiToken: string | null,
  nowIso: string,
): Promise<number> {
  const adminId = await db.insertAndGetId(
    "INSERT INTO admin (name, email, pass, api_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    name, email, passwordHash, apiToken, nowIso, nowIso,
  );
  await db
    .prepare("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, ?, ?)")
    .run(adminId, 1, nowIso);
  return adminId;
}

export async function setDefaultCurrency(db: Db, currencyCode: string): Promise<void> {
  await db.prepare("UPDATE currency SET code = ? WHERE id = ?").run(currencyCode, 1);
}

export async function seedInstallNudge(db: Db, version: string, nowIso: string): Promise<void> {
  await db
    .prepare("INSERT INTO setting (param, value, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("last_error_reporting_nudge", version, nowIso, nowIso);
}
