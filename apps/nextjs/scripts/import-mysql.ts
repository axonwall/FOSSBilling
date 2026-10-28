/**
 * FOSSBilling Phase 5 R3b — one-way MySQL → Postgres importer.
 *
 * Standalone operator script (NOT a server route, NOT imported by app code).
 * Run via scripts/run-import-mysql.mjs, which compiles this file + its repo
 * imports with the repo tsc into a scratch dir and executes it.
 *
 * Reads a live 0.8.9 MySQL install via mysql2 with a READ-ONLY user and
 * writes to a target Postgres whose schema was created by PHP's own
 * SchemaInstaller (D3-5 — no hand-written DDL here). Writes go through the
 * R3a Db interface (DbPg over one pg Pool); verification reads go through
 * the same Pool directly, because DbPg normalizes numerics to Number and
 * money verification must compare exact decimal strings, never floats.
 *
 * Refusal semantics (non-negotiable, plan.md): any verification mismatch,
 * any non-fresh target, any unknown source table, any missing target table,
 * or any undecryptable sampled encrypted value aborts the run with a
 * non-zero exit and a report naming the table and the figure. There is no
 * --force and no partial-import mode. A failed verification AFTER the copy
 * commits leaves the target copied-but-UNVERIFIED (verification reads must
 * see committed data, so they run post-commit on a separate connection);
 * the report says so explicitly, and the target must be restored to fresh
 * before any re-run or cutover. Pre-copy refusals (fresh check, unknown /
 * missing tables, encrypted sample) leave the target untouched.
 *
 * Env (no credentials anywhere else, never in committed files):
 *   FB_MYSQL_URL     mysql://user:pass@host:port/database (read-only user)
 *   FB_DATABASE_URL  postgres://... (target; same var the seam uses)
 *   FB_INFO_SALT     install salt (FB_CALLBACK_SALT is the crypt.ts fallback)
 * Flags: --dry-run (print the plan + comparison preview, write nothing),
 *        --help.
 */

import mysql from "mysql2/promise";
import { Pool } from "pg";
import { DbPg } from "../src/server/pg";
import type { Db } from "../src/server/db";
import { decryptV2 } from "../src/server/crypt";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** A deliberate refusal: the run must stop, the report names the cause. */
export class ImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefusal";
  }
}

/* ------------------------------------------------------------------ */
/* Exact decimal arithmetic (money is never compared as float)         */
/* ------------------------------------------------------------------ */

interface DecimalParts {
  neg: boolean;
  int: string;
  frac: string;
}

function parseDecimal(raw: unknown): DecimalParts | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === "") return null;
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal: ${JSON.stringify(raw)}`);
  const [intRaw, fracRaw = ""] = s.split(".");
  return { neg, int: intRaw.replace(/^0+(?=\d)/, ""), frac: fracRaw };
}

/** Canonical form: "10.50" -> "10.5", "-0.00" -> "0", null -> "0". */
export function normalizeDecimal(raw: unknown): string {
  const p = parseDecimal(raw);
  if (!p) return "0";
  const frac = p.frac.replace(/0+$/, "");
  const body = frac ? `${p.int}.${frac}` : p.int;
  if (body === "0") return "0";
  return p.neg ? `-${body}` : body;
}

function toScaled(p: DecimalParts, scale: number): bigint {
  const frac = p.frac.padEnd(scale, "0");
  const v = BigInt(p.int + frac);
  return p.neg ? -v : v;
}

function fromScaled(v: bigint, scale: number): string {
  if (v === 0n) return "0";
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = frac ? `${int}.${frac}` : int;
  return neg ? `-${body}` : body;
}

export function addDecimal(a: string, b: string): string {
  const pa = parseDecimal(a) ?? { neg: false, int: "0", frac: "" };
  const pb = parseDecimal(b) ?? { neg: false, int: "0", frac: "" };
  const scale = Math.max(pa.frac.length, pb.frac.length);
  return fromScaled(toScaled(pa, scale) + toScaled(pb, scale), scale);
}

export function mulDecimal(a: unknown, b: unknown): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  if (!pa || !pb) return "0";
  // Raw integers (no padding): (A / 10^fa) * (B / 10^fb) = (A*B) / 10^(fa+fb).
  const intA = BigInt(pa.int + pa.frac);
  const intB = BigInt(pb.int + pb.frac);
  const sign = pa.neg !== pb.neg ? -1n : 1n;
  return fromScaled(sign * intA * intB, pa.frac.length + pb.frac.length);
}

export function sumDecimals(values: Iterable<unknown>): string {
  let total = "0";
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    total = addDecimal(total, normalizeDecimal(v));
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Static import spec: tables, order, money, seeds, encrypted columns  */
/* ------------------------------------------------------------------ */

/** Tables whose rows are never copied (D3-6: forced logout on migration). */
export const SKIPPED_TABLES: readonly string[] = ["session"];

/**
 * Copy order, parents before children. FOSSBilling has no real FK
 * constraints (AGENTS.md), so this order is advisory — it keeps reports
 * readable and stays valid if constraints ever appear. Every entity table
 * must appear exactly once; unknown source tables are refused, never
 * silently appended.
 */
export const TABLE_ORDER: readonly string[] = [
  "currency", "setting", "tld_registrar", "tld", "tax",
  "product_category", "product", "product_payment", "product_payment_period",
  "pay_gateway", "pay_gateway_customer", "pay_gateway_product",
  "client_group", "client", "client_balance", "client_group_members",
  "client_password_reset",
  "admin_group", "admin", "admin_group_member", "admin_password_reset",
  "activity_admin_history", "activity_client_history", "activity_client_email",
  "activity_system",
  "cart", "cart_product", "promo", "promo_redemption",
  "client_order", "client_order_meta", "client_order_status",
  "service_custom", "service_domain", "service_downloadable",
  "service_downloadable_file", "service_hosting", "service_hosting_hp",
  "service_hosting_server", "service_license", "subscription",
  "invoice", "invoice_item", "invoice_event", "transaction",
  "extension", "extension_meta", "form", "form_field",
  "email_template_group", "email_template", "email_queue",
  "support_helpdesk", "support_ticket", "support_ticket_message",
  "support_ticket_message_history", "support_ticket_note",
  "support_kb_article_category", "support_kb_article",
  "support_pr_category", "support_pr",
  "post", "custom_pages", "mod_massmailer", "service_apikey", "session",
];

/**
 * Installer-produced row allowances for the fresh-target check.
 * Derived from src/install/sql/content.sql row counts plus the installer's
 * own additions: seedAdmin writes 1 admin + 1 admin_group_member row,
 * seedInstallNudge writes 1 setting row (34 content + 1 = 35), and
 * setDefaultCurrency only UPDATES currency id 1 (no count change).
 * Any table not listed here must be EMPTY. The importer truncates every
 * copied table before copying, so allowed seed rows are replaced by source
 * rows; the check exists to refuse targets that look live, not to bless
 * partial seeds.
 */
export const SEED_ALLOWANCE: Readonly<Record<string, number>> = {
  admin_group: 3, client_group: 1, currency: 1, extension: 3, pay_gateway: 2,
  post: 3, product: 1, product_category: 1, setting: 35, support_helpdesk: 1,
  support_kb_article: 3, support_kb_article_category: 2, support_pr: 17,
  support_pr_category: 7, tld: 1, tld_registrar: 3,
  admin: 1, admin_group_member: 1,
};

export interface MoneySpec {
  /** Report label, e.g. "price" or "price_x_quantity". */
  label: string;
  /** Columns read (in id order, paged) for this total. */
  columns: string[];
  /** Per-row decimal string from the read columns. */
  compute: (row: Record<string, unknown>) => string;
}

const col = (name: string): MoneySpec => ({
  label: name,
  columns: [name],
  compute: (row) => normalizeDecimal(row[name]),
});

/**
 * Money totals, per table. Justifications (see findings-r3b.md):
 * - Stored monetary accumulators and ledgers: invoice (base_income,
 *   base_refund, credit, refund), client_balance, transaction, subscription.
 * - Order value: client_order price + discount; promo value redeemed.
 * - Line amounts: invoice_item price AND price*quantity (invoice totals
 *   are computed from items at read time — there is no stored total).
 * - Catalog prices (static but monetary; catch decimal mapping errors):
 *   product_payment, product_payment_period, tld.
 * Excluded, deliberately: currency_rate (a rate), taxrate (a rate, and
 * string-typed), pay_gateway_product.external_price_id (an external string
 * id, not an amount), invoice totals (computed, not stored — covered via
 * invoice_item). Rates and ids are still covered by row counts + the type
 * mapping; they are not money.
 */
export const MONEY_TOTALS: Readonly<Record<string, readonly MoneySpec[]>> = {
  invoice: [col("base_income"), col("base_refund"), col("credit"), col("refund")],
  invoice_item: [
    col("price"),
    {
      label: "price_x_quantity",
      columns: ["price", "quantity"],
      compute: (row) => mulDecimal(row.price, row.quantity),
    },
  ],
  client_balance: [col("amount")],
  transaction: [col("amount")],
  client_order: [col("price"), col("discount")],
  subscription: [col("amount")],
  promo_redemption: [col("discount_amount")],
  product_payment: [col("once_price"), col("once_setup_price")],
  product_payment_period: [col("price"), col("setup_price")],
  tld: [col("price_registration"), col("price_renew"), col("price_transfer")],
};

/**
 * Columns holding at-rest encrypted values (verified, not guessed:
 * extension.ts decrypts extension_meta.meta_value; emailDefaults.ts
 * decrypts email_template.vars; PHP Extension/Service.php encrypts the
 * former). No other column is decrypted anywhere in the TS seam, and
 * pay_gateway config is stored as plaintext JSON.
 */
export const ENCRYPTED_COLUMNS: readonly { table: string; column: string }[] = [
  { table: "extension_meta", column: "meta_value" },
  { table: "email_template", column: "vars" },
];

/** Rows sampled per encrypted column for the decryptability check. */
export const ENCRYPTED_SAMPLE_SIZE = 25;

/** Copy page size (rows per SELECT/INSERT round trip). */
export const PAGE_SIZE = 1000;

/* ------------------------------------------------------------------ */
/* Source interface (MySQL live, or a fake in tests)                   */
/* ------------------------------------------------------------------ */

export interface SourceColumn {
  name: string;
  /** information_schema DATA_TYPE, e.g. "bigint", "tinyint", "varchar". */
  dataType: string;
  /** information_schema COLUMN_TYPE, e.g. "bigint(20)", "tinyint(1)". */
  columnType: string;
}

export interface SourceTable {
  name: string;
  columns: SourceColumn[];
}

export type Row = Record<string, unknown>;

export interface Source {
  listTables(): Promise<SourceTable[]>;
  count(table: string): Promise<number>;
  /** Page of rows ordered by id, with id > afterId (all tables have id). */
  readPage(table: string, columns: string[], afterId: number, limit: number): Promise<Row[]>;
  /** Count of rows whose column value starts with "v2:". */
  countEncrypted(table: string, column: string): Promise<number>;
  /** Sample of v2:-prefixed values, ordered by id. */
  sampleEncrypted(table: string, column: string, limit: number): Promise<unknown[]>;
  /** Non-v2: value count for an encrypted column (reported, not checked). */
  countNonEncrypted(table: string, column: string): Promise<number>;
  close(): Promise<void>;
}

/** mysql2 connection flags that make values lossless and TZ-safe. */
export function mysqlConnectionConfig(url: string): Record<string, unknown> {
  return {
    uri: url,
    // BIGINT/DECIMAL arrive as strings (no 2^53 loss, no float money).
    supportBigNumbers: true,
    bigNumberStrings: true,
    // DATETIME/DATE/TIMESTAMP arrive as "YYYY-MM-DD HH:MM:SS" strings:
    // MySQL DATETIME is timezone-naive, so any Date conversion would
    // silently shift values with the importer's local TZ.
    dateStrings: true,
    // Read-only by policy; the SQL below never writes (see grants in the
    // operator docs). Multiple statements stay off.
    multipleStatements: false,
  };
}

const qIdentMy = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** Live MySQL source via mysql2. */
export class MysqlSource implements Source {
  private conn: Awaited<ReturnType<typeof mysql.createConnection>> | null = null;

  constructor(private url: string) {}

  private async getConn() {
    if (!this.conn) this.conn = await mysql.createConnection(mysqlConnectionConfig(this.url) as never);
    return this.conn;
  }

  async listTables(): Promise<SourceTable[]> {
    const conn = await this.getConn();
    const [rows] = await conn.query(
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d, COLUMN_TYPE AS ct " +
        "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
        "ORDER BY TABLE_NAME, ORDINAL_POSITION",
    );
    const byTable = new Map<string, SourceColumn[]>();
    for (const r of rows as Row[]) {
      const t = String(r.t);
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t)!.push({ name: String(r.c), dataType: String(r.d), columnType: String(r.ct) });
    }
    return [...byTable.entries()].map(([name, columns]) => ({ name, columns }));
  }

  async count(table: string): Promise<number> {
    const conn = await this.getConn();
    const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM ${qIdentMy(table)}`);
    return Number((rows as Row[])[0]?.n ?? 0);
  }

  async readPage(table: string, columns: string[], afterId: number, limit: number): Promise<Row[]> {
    const conn = await this.getConn();
    const cols = columns.map(qIdentMy).join(", ");
    const [rows] = await conn.query(
      `SELECT ${cols} FROM ${qIdentMy(table)} WHERE id > ? ORDER BY id LIMIT ?`,
      [afterId, limit],
    );
    return rows as Row[];
  }

  async countEncrypted(table: string, column: string): Promise<number> {
    const conn = await this.getConn();
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM ${qIdentMy(table)} WHERE ${qIdentMy(column)} LIKE 'v2:%'`,
    );
    return Number((rows as Row[])[0]?.n ?? 0);
  }

  async sampleEncrypted(table: string, column: string, limit: number): Promise<unknown[]> {
    const conn = await this.getConn();
    const [rows] = await conn.query(
      `SELECT ${qIdentMy(column)} AS v FROM ${qIdentMy(table)} WHERE ${qIdentMy(column)} LIKE 'v2:%' ORDER BY id LIMIT ?`,
      [limit],
    );
    return (rows as Row[]).map((r) => r.v);
  }

  async countNonEncrypted(table: string, column: string): Promise<number> {
    const conn = await this.getConn();
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM ${qIdentMy(table)} WHERE ${qIdentMy(column)} IS NOT NULL AND ${qIdentMy(column)} NOT LIKE 'v2:%'`,
    );
    return Number((rows as Row[])[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.end();
      this.conn = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Target interface (Postgres: DbPg writes, raw Pool verification reads)*/
/* ------------------------------------------------------------------ */

export interface TargetQuery {
  (text: string, values?: unknown[]): Promise<Row[]>;
}

export interface Target {
  /** Writer (DbPg over the same Pool the verifier reads through). */
  db: Db;
  /** Raw-pool query for verification reads (exact types, no normalization). */
  query: TargetQuery;
  close(): Promise<void>;
}

const qIdentPg = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Map a Postgres "relation does not exist" error to a refusal. */
function isMissingTableError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /relation .* does not exist/i.test(msg) || /no such table/i.test(msg);
}

/** Normalize one row value for INSERT through DbPg. */
export function mapValueForInsert(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    if (Buffer.isBuffer(value)) {
      // Buffers are only legal for bytea columns (attachment_content and
      // the skipped session table). Anything else is unexpected data that
      // must fail loudly, never silently coerce.
      const bytea = (table === "activity_client_email" && column === "attachment_content") ||
        (table === "email_queue" && column === "attachment_content");
      if (!bytea) throw new ImportRefusal(`unexpected Buffer value for ${table}.${column} (not a bytea column)`);
      return value;
    }
    if (Array.isArray(value)) return JSON.stringify(value);
    if (value instanceof Date) {
      // Defensive: dateStrings should already have made these strings.
      return value.toISOString().slice(0, 19).replace("T", " ");
    }
    // MySQL JSON columns arrive parsed; the seam stores JSON as strings.
    return JSON.stringify(value);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Report types                                                        */
/* ------------------------------------------------------------------ */

export interface TableReport {
  table: string;
  sourceRows: number;
  targetRows: number;
  copied?: number;
  money?: { label: string; source: string; target: string; match: boolean }[];
}

export interface ImportReport {
  mode: "dry-run" | "import";
  tablesCopied: string[];
  skipped: { table: string; sourceRows: number; reason: string }[];
  tables: TableReport[];
  encrypted: {
    table: string;
    column: string;
    v2Rows: number;
    sampled: number;
    nonV2Rows: number;
    status: "PASS" | "VACUOUS" | "FAIL";
  }[];
  fresh: { table: string; targetRows: number; allowance: number }[];
  warnings: string[];
  verified: boolean;
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

/** Resolve the ordered copy list; refuse unknown tables and bad order data. */
export function resolveCopyOrder(sourceTables: SourceTable[]): SourceTable[] {
  const known = new Set(TABLE_ORDER);
  const unknown = sourceTables.filter((t) => !known.has(t.name)).map((t) => t.name);
  if (unknown.length > 0) {
    throw new ImportRefusal(
      `source has tables unknown to this importer (refusing rather than silently dropping data): ${unknown.join(", ")}`,
    );
  }
  const byName = new Map(sourceTables.map((t) => [t.name, t]));
  const ordered = TABLE_ORDER.filter((name) => byName.has(name)).map((name) => byName.get(name)!);
  return ordered;
}

/**
 * Fresh-target check. Reads target counts (missing table -> refusal naming
 * it, with the module-activation hint for extension tables). A table is
 * fresh iff its count is within its installer allowance (seed rows only);
 * anything above that looks live and refuses.
 */
export async function checkFresh(
  target: Target,
  tables: SourceTable[],
): Promise<{ table: string; targetRows: number; allowance: number }[]> {
  const out: { table: string; targetRows: number; allowance: number }[] = [];
  for (const t of tables) {
    let rows: Row[];
    try {
      rows = await target.query(`SELECT COUNT(*) AS n FROM ${qIdentPg(t.name)}`);
    } catch (e) {
      if (isMissingTableError(e)) {
        throw new ImportRefusal(
          `target is missing table "${t.name}" — create the target schema with PHP's SchemaInstaller first` +
            (t.name === "service_apikey" || t.name === "mod_massmailer" || t.name === "custom_pages"
              ? ` (for extension tables: activate the module on the target first, which creates its table)`
              : ""),
        );
      }
      throw e;
    }
    const count = Number(rows[0]?.n ?? 0);
    const allowance = SEED_ALLOWANCE[t.name] ?? 0;
    if (count > allowance) {
      throw new ImportRefusal(
        `target is not fresh: table "${t.name}" has ${count} rows, allowance is ${allowance} (installer seed rows only) — ` +
          `refusing to run against what looks like a live database; restore a fresh installer-created target and re-run`,
      );
    }
    out.push({ table: t.name, targetRows: count, allowance });
  }
  return out;
}

/** Sum one money spec on one side, reading column values paged by id. */
export async function sumMoneySpec(
  readPage: (columns: string[], afterId: number, limit: number) => Promise<Row[]>,
  spec: MoneySpec,
): Promise<string> {
  // Paging needs the id, which is never itself a money column: request it
  // alongside the money columns (compute() only reads spec.columns).
  const cols = spec.columns.includes("id") ? spec.columns : [...spec.columns, "id"];
  let total = "0";
  let afterId = 0;
  for (;;) {
    const rows = await readPage(cols, afterId, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) total = addDecimal(total, spec.compute(row));
    afterId = Number(rows[rows.length - 1]!.id ?? 0);
    if (rows.length < PAGE_SIZE) break;
    if (afterId === 0) break;
  }
  return normalizeDecimal(total);
}

/** Decryptability sample check (pre-copy, on SOURCE rows). */
export async function checkEncryptedSample(
  source: Source,
  saltPresent: boolean,
): Promise<ImportReport["encrypted"]> {
  const out: ImportReport["encrypted"] = [];
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const v2Rows = await source.countEncrypted(table, column);
    const nonV2Rows = await source.countNonEncrypted(table, column);
    if (v2Rows === 0) {
      // VACUOUS, stated as such: zero encrypted rows prove nothing about
      // the salt (the R2e refresh lesson). Not a pass.
      out.push({ table, column, v2Rows, sampled: 0, nonV2Rows, status: "VACUOUS" });
      continue;
    }
    if (!saltPresent) {
      throw new ImportRefusal(
        `encrypted values exist in ${table}.${column} (${v2Rows} v2: rows) but no salt is configured ` +
          `(FB_INFO_SALT / FB_CALLBACK_SALT) — refusing rather than copying undecryptable blobs`,
      );
    }
    const sample = await source.sampleEncrypted(table, column, ENCRYPTED_SAMPLE_SIZE);
    for (const value of sample) {
      if (typeof value !== "string" || decryptV2(value) === null) {
        throw new ImportRefusal(
          `decryptability sample FAILED for ${table}.${column}: a sampled v2: value does not decrypt with the configured salt — ` +
            `refusing rather than copying undecryptable blobs (wrong salt? re-keying is an R4/R5 item, not R3b)`,
        );
      }
    }
    out.push({ table, column, v2Rows, sampled: sample.length, nonV2Rows, status: "PASS" });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Copy + verify                                                       */
/* ------------------------------------------------------------------ */

export interface ImportOptions {
  dryRun: boolean;
  /** Salt presence (FB_INFO_SALT ?? FB_CALLBACK_SALT), for the sample check. */
  saltPresent: boolean;
  /** Test seam: skip the sequence-resync step's live queries. */
  skipSequenceResync?: boolean;
}

/**
 * Copy one table: DELETE existing (seed) rows, then paged source reads +
 * single-row INSERTs through the Db interface. Single-row INSERTs are
 * deliberate: the R3a translator rejects multi-row VALUES (column/item
 * count assertion), and one transaction keeps the copy atomic.
 */
export async function copyTable(
  source: Source,
  target: Target,
  table: SourceTable,
): Promise<number> {
  const cols = table.columns.map((c) => c.name);
  const placeholders = cols.map(() => "?").join(", ");
  const insertSql = `INSERT INTO ${qIdentPg(table.name)} (${cols.map(qIdentPg).join(", ")}) VALUES (${placeholders})`;
  const stmt = target.db.prepare(insertSql);
  await target.db.prepare(`DELETE FROM ${qIdentPg(table.name)}`).run();
  let copied = 0;
  let afterId = 0;
  for (;;) {
    const rows = await source.readPage(table.name, cols, afterId, PAGE_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      const values = cols.map((c) => mapValueForInsert(table.name, c, row[c]));
      await stmt.run(...values);
      copied += 1;
    }
    afterId = Number(rows[rows.length - 1]!.id ?? 0);
    if (rows.length < PAGE_SIZE) break;
    if (afterId === 0) break;
  }
  return copied;
}

/**
 * Best-effort sequence resync (inside the copy transaction): after explicit
 * ids are copied, point each table's id sequence past max(id) so future
 * inserts do not collide. Guarded: pg_get_serial_sequence returning null
 * (no serial id) skips the table; an unsupported environment (pg-mem in
 * tests) records a warning instead of failing the import. Live-server
 * behavior of this step is an R3c verification item.
 */
export async function resyncSequences(target: Target, tables: SourceTable[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const t of tables) {
    try {
      const seqRows = await target.db
        .prepare(`SELECT pg_get_serial_sequence('${t.name}', 'id') AS seq`)
        .get() as Row | undefined;
      const seq = seqRows?.seq as string | null | undefined;
      if (!seq) continue;
      const maxRows = await target.db
        .prepare(`SELECT MAX(id) AS m FROM ${qIdentPg(t.name)}`)
        .get() as Row | undefined;
      const maxId = maxRows?.m as number | string | null | undefined;
      if (maxId === null || maxId === undefined) continue;
      await target.db.prepare(`SELECT setval('${seq}', ${Number(maxId)})`).get();
    } catch (e) {
      warnings.push(`sequence resync skipped for "${t.name}": ${String((e as Error)?.message ?? e)}`);
    }
  }
  return warnings;
}

/** Verify one table: row counts + every money total, exact decimals. */
export async function verifyTable(
  source: Source,
  target: Target,
  table: SourceTable,
): Promise<TableReport> {
  const sourceRows = await source.count(table.name);
  let targetRows: number;
  try {
    const rows = await target.query(`SELECT COUNT(*) AS n FROM ${qIdentPg(table.name)}`);
    targetRows = Number(rows[0]?.n ?? 0);
  } catch (e) {
    if (isMissingTableError(e)) throw new ImportRefusal(`verification: target is missing table "${table.name}"`);
    throw e;
  }
  const money: TableReport["money"] = [];
  const specs = MONEY_TOTALS[table.name] ?? [];
  for (const spec of specs) {
    const sourceTotal = await sumMoneySpec(
      (columns, afterId, limit) => source.readPage(table.name, columns, afterId, limit),
      spec,
    );
    const targetTotal = await sumMoneySpec(
      async (columns, afterId, limit) => {
        const cols = columns.map(qIdentPg).join(", ");
        const rows = await target.query(
          `SELECT ${cols} FROM ${qIdentPg(table.name)} WHERE id > $1 ORDER BY id LIMIT $2`,
          [afterId, limit],
        );
        return rows;
      },
      spec,
    );
    money.push({ label: spec.label, source: sourceTotal, target: targetTotal, match: sourceTotal === targetTotal });
  }
  return { table: table.name, sourceRows, targetRows, money };
}

/** Throw unless every count and money total matches. */
export function assertVerified(report: TableReport): void {
  if (report.sourceRows !== report.targetRows) {
    throw new ImportRefusal(
      `verification FAILED for table "${report.table}": row count differs (source ${report.sourceRows}, target ${report.targetRows})`,
    );
  }
  for (const m of report.money ?? []) {
    if (!m.match) {
      throw new ImportRefusal(
        `verification FAILED for table "${report.table}": money total "${m.label}" differs (source ${m.source}, target ${m.target})`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export interface PipelineDeps {
  source: Source;
  target: Target;
  options: ImportOptions;
}

/**
 * Full pipeline: pre-checks (fresh, unknown/missing tables, encrypted
 * sample) -> dry-run report OR copy (one transaction) -> post-commit
 * verification. Returns the report; throws ImportRefusal on any refusal.
 * The copy runs in one transaction; verification runs after commit (it
 * must see committed data on a separate connection), so a verification
 * refusal leaves the target copied-but-UNVERIFIED — the caller must say
 * so and the operator must restore a fresh target before re-running.
 */
export async function runPipeline({ source, target, options }: PipelineDeps): Promise<ImportReport> {
  const warnings: string[] = [];
  const allSource = await source.listTables();
  const ordered = resolveCopyOrder(allSource);
  const copyTables = ordered.filter((t) => !SKIPPED_TABLES.includes(t.name));
  const skipped = ordered
    .filter((t) => SKIPPED_TABLES.includes(t.name))
    .map((t) => ({ table: t.name, sourceRows: -1, reason: "skipped by policy (D3-6: forced logout on migration)" }));
  for (const s of skipped) s.sourceRows = await source.count(s.table);

  // Pre-copy checks (target untouched if any throws).
  const fresh = await checkFresh(target, ordered);
  const encrypted = await checkEncryptedSample(source, options.saltPresent);

  if (options.dryRun) {
    const freshByTable = new Map(fresh.map((f) => [f.table, f.targetRows]));
    const tables: TableReport[] = [];
    for (const t of copyTables) {
      const sourceRows = await source.count(t.name);
      const money: TableReport["money"] = [];
      for (const spec of MONEY_TOTALS[t.name] ?? []) {
        const sourceTotal = await sumMoneySpec(
          (columns, afterId, limit) => source.readPage(t.name, columns, afterId, limit),
          spec,
        );
        // Dry-run money rows compare the source total against the CURRENT
        // (seed-only) target total: a mismatch here is EXPECTED (it is why
        // the import exists), not a failure — formatReport renders dry-run
        // money rows as "planned", never OK/MISMATCH.
        const targetTotal = await sumMoneySpec(
          async (columns, afterId, limit) => {
            const cols = columns.map(qIdentPg).join(", ");
            const rows = await target.query(
              `SELECT ${cols} FROM ${qIdentPg(t.name)} WHERE id > $1 ORDER BY id LIMIT $2`,
              [afterId, limit],
            );
            return rows;
          },
          spec,
        );
        money.push({ label: spec.label, source: sourceTotal, target: targetTotal, match: sourceTotal === targetTotal });
      }
      tables.push({ table: t.name, sourceRows, targetRows: freshByTable.get(t.name) ?? 0, money });
    }
    return {
      mode: "dry-run", tablesCopied: [], skipped, tables, encrypted, fresh, warnings,
      verified: false,
    };
  }

  // Copy (one transaction: DELETE seeds + INSERTs + sequence resync).
  const copiedCounts = new Map<string, number>();
  await target.db.withTransaction(async (tx) => {
    const txTarget: Target = { db: tx, query: target.query, close: async () => {} };
    for (const t of copyTables) {
      copiedCounts.set(t.name, await copyTable(source, txTarget, t));
    }
    if (!options.skipSequenceResync) {
      warnings.push(...(await resyncSequences(txTarget, copyTables)));
    }
  });

  // Post-commit verification (separate connection sees committed data).
  const tables: TableReport[] = [];
  for (const t of copyTables) {
    const rep = await verifyTable(source, target, t);
    rep.copied = copiedCounts.get(t.name) ?? 0;
    tables.push(rep);
  }
  for (const rep of tables) assertVerified(rep);

  return {
    mode: "import", tablesCopied: copyTables.map((t) => t.name), skipped, tables,
    encrypted, fresh, warnings, verified: true,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting + CLI                                                     */
/* ------------------------------------------------------------------ */

export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  lines.push(`mode: ${report.mode}`);
  lines.push(`tables copied: ${report.tablesCopied.length}`);
  for (const s of report.skipped) {
    lines.push(`skipped: ${s.table} (${s.sourceRows} source rows) — ${s.reason}`);
  }
  for (const t of report.tables) {
    const money = (t.money ?? []).map((m) =>
      report.mode === "dry-run"
        ? `${m.label}: source=${m.source} target-now=${m.target} (planned)`
        : `${m.label}: source=${m.source} target=${m.target} ${m.match ? "OK" : "MISMATCH"}`,
    ).join("; ");
    lines.push(
      `${t.table}: source=${t.sourceRows} target=${t.targetRows}` +
        (t.copied !== undefined ? ` copied=${t.copied}` : "") +
        (money ? ` | ${money}` : ""),
    );
  }
  for (const e of report.encrypted) {
    lines.push(`encrypted ${e.table}.${e.column}: v2Rows=${e.v2Rows} sampled=${e.sampled} nonV2Rows=${e.nonV2Rows} status=${e.status}`);
  }
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  lines.push(`verified: ${report.verified ? "YES" : report.mode === "dry-run" ? "n/a (dry run)" : "NO"}`);
  return lines.join("\n");
}

const USAGE = `usage: run-import-mysql.mjs [--dry-run] [--help]
env: FB_MYSQL_URL (mysql://read-only-user:pass@host:port/database)
     FB_DATABASE_URL (postgres://... target; same var the seam uses)
     FB_INFO_SALT (install salt; FB_CALLBACK_SALT is the crypt.ts fallback)
The MySQL user needs only SELECT on the source database. The target must be
a fresh installer-created Postgres schema (see findings-r3b.md §operator
steps); the importer refuses any target that looks live.`;

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const dryRun = argv.includes("--dry-run");
  for (const arg of argv) {
    if (arg !== "--dry-run") {
      console.error(`unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const mysqlUrl = process.env.FB_MYSQL_URL;
  const pgUrl = process.env.FB_DATABASE_URL;
  if (!mysqlUrl) {
    console.error("missing env: FB_MYSQL_URL is required (mysql://read-only-user:pass@host:port/database)");
    return 1;
  }
  if (!pgUrl) {
    console.error("missing env: FB_DATABASE_URL is required (postgres://... target)");
    return 1;
  }
  const saltPresent = Boolean(process.env.FB_INFO_SALT ?? process.env.FB_CALLBACK_SALT);
  const pool = new Pool({ connectionString: pgUrl });
  const target: Target = {
    db: new DbPg(pool),
    query: async (text, values) => (await pool.query(text, values as never[])).rows as Row[],
    close: async () => {
      await pool.end();
    },
  };
  const source = new MysqlSource(mysqlUrl);
  try {
    const report = await runPipeline({ source, target, options: { dryRun, saltPresent } });
    console.log(formatReport(report));
    console.log("--- report (json) ---");
    console.log(JSON.stringify(report, null, 2));
    if (dryRun) console.log("dry run: nothing was written to the target.");
    return 0;
  } catch (e) {
    if (e instanceof ImportRefusal) {
      console.error(`REFUSED: ${e.message}`);
      console.error("No cutover may proceed from this target. If a copy already committed, restore a fresh target before re-running.");
    } else {
      console.error(`FAILED: ${String((e as Error)?.message ?? e)}`);
    }
    return 1;
  } finally {
    await source.close().catch(() => {});
    await target.close().catch(() => {});
  }
}
