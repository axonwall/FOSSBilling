// FOSSBilling Phase 5 R5j: update-finalization state machine, ported from
// PHP's FOSSBilling\UpdateFinalization + UpdatePatcher (config patches +
// portable schema sync). This is the work R5f deliberately left unmirrored:
// the R5f cron gate only REFUSES while finalization is pending; this
// module is what actually moves a pending state to complete.
//
// Ported exactly:
//   * State file: <installRoot>/data/update-finalization.json, encoded
//     JSON pretty (4 spaces) + trailing newline, PHP key order.
//   * Statuses pending -> finalized -> complete; stateRequiresFinalization
//     = pending/finalized; isCompleteForCurrentVersion = complete AND
//     version == VERSION (0.0.1, NOT 0.8.9).
//   * createPendingState writes the pending state BEFORE enabling
//     maintenance mode, so a failed config write still leaves recoverable
//     evidence that finalization is pending.
//   * Maintenance toggling: enable sets enabled=true + merges
//     <adminPrefix>/staff/login + <adminPrefix>/system/update/finalize
//     into allowed_urls; complete RESTORES the exact captured
//     pre-update maintenance_mode object (not just enabled=false).
//     finalize does NOT touch maintenance mode.
//   * Failure mid-patches: the exception propagates, the state stays
//     pending, maintenance stays ON (restore happens only in complete).
//   * Config patches: UpdatePatcher::applyConfigPatches(force=true),
//     including the top-level log_stacktrace/stacktrace_length keys, the
//     db.port = normalizePort(port, 3306) quirk (3306 default even for
//     pgsql), the whitelist merge from the ORIGINAL config, and the
//     deprecated-key removals. No write when nothing changed.
//   * Core patches: ONLY the portable schema sync is ported. The legacy
//     MySQL-only raw patches are out by definition (TS has no MySQL
//     target; availablePatches() is 0), and the PHP-era data steps
//     (theme-package layout, branding assets, retired-hook data,
//     invoice-note settings, invoice migrations, invoice journal
//     backfill, invoice-number counter check) are deliberately NOT ported:
//     they repair PHP-era data states a TS-fresh install never has. A
//     DB migrated from PHP keeps its pre-existing data state for those
//     steps — see findings-r5j.md. The schema sync itself is additive
//     only (never drops/alters, never adds an FK to an existing table),
//     mirroring SchemaSynchronizer.
//   * Lock: PHP uses flock on update-finalization.lock; the TS tool uses
//     an exclusive-create lock file removed in `finally` (same mutual
//     exclusion for a single operator process; documented difference).
//   * clearCache / install-dir removal: no-ops in TS (no PHP cache dir,
//     no install/ dir to remove); documented, not silently dropped.
//   * The removed admin API endpoints (update_core, finalize_update,
//     complete_update_finalization, manual_update, and the status
//     endpoint's write paths) are NOT resurrected — settled R1 decision.
//     This module is an operator tool (scripts/finalize-update.ts), and
//     the R5f cron gate keeps working unchanged after it lands.
import * as fs from "node:fs";
import * as path from "node:path";
import { readConfigFile, writeConfigFile, type PhpConfig, type PhpConfigValue } from "./config-store";
import { INSTALL_VERSION, isPreviewVersion, normalizePort } from "./install-config";
import {
  INSTALL_SCHEMA,
  type InstallTable,
} from "./install-schema";
import {
  emitCreateTablePostgres,
  emitCreateTableSqlite,
} from "./install-schema-ddl";
import type { Db } from "./db";

export type FinalizationStatus = "pending" | "finalized" | "complete";

export interface FinalizationState {
  status: FinalizationStatus;
  version?: string;
  from_version: string | null;
  target_version: string | null;
  branch?: string;
  update_type?: number | null;
  source?: string;
  created_at?: string;
  finalized_at: string | null;
  completed_at: string | null;
  maintenance_mode?: unknown;
}

export const FINALIZATION_VERSION = INSTALL_VERSION;

export function stateFilePath(installRoot: string): string {
  return path.join(installRoot, "data", "update-finalization.json");
}

export function lockFilePath(installRoot: string): string {
  return path.join(installRoot, "data", "update-finalization.lock");
}

/** PHP DATE_ATOM in UTC: 2026-10-23T20:32:45+00:00 (no millis). */
export function dateAtom(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** PHP readState: missing/unparseable -> null (never throws). */
export function readState(installRoot: string): FinalizationState | null {
  try {
    const raw = fs.readFileSync(stateFilePath(installRoot), "utf8");
    const parsed = JSON.parse(raw) as FinalizationState;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeState(installRoot: string, state: FinalizationState): void {
  const dir = path.dirname(stateFilePath(installRoot));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    stateFilePath(installRoot),
    JSON.stringify(state, null, 4) + "\n",
    "utf8",
  );
}

export function stateRequiresFinalization(state: FinalizationState | null): boolean {
  return state !== null && (state.status === "pending" || state.status === "finalized");
}

export function isCompleteForCurrentVersion(state: FinalizationState | null): boolean {
  return state !== null && state.status === "complete" && state.version === FINALIZATION_VERSION;
}

export function writeCompleteState(installRoot: string, fromState: FinalizationState | null): FinalizationState {
  const now = dateAtom();
  const state: FinalizationState = {
    status: "complete",
    version: FINALIZATION_VERSION,
    from_version: fromState?.from_version ?? null,
    target_version: fromState?.target_version ?? FINALIZATION_VERSION,
    finalized_at: fromState?.finalized_at ?? now,
    completed_at: fromState?.completed_at ?? now,
  };
  writeState(installRoot, state);
  return state;
}

/** Version::getUpdateType: PATCH=0, MINOR=1, MAJOR=2. */
export function detectUpdateType(fromVersion: string | null, targetVersion: string): number | null {
  if (
    fromVersion === null || fromVersion === "" ||
    isPreviewVersion(fromVersion) || isPreviewVersion(targetVersion)
  ) {
    return null;
  }
  const cur = fromVersion.split(".");
  const next = targetVersion.split(".");
  if (Number(next[0]) === 0) {
    if (next[1] !== cur[1]) return 2;
    return 1;
  }
  if (next[0] !== cur[0]) return 2;
  if (next[1] !== cur[1]) return 1;
  return 0;
}

function adminPrefixOf(config: PhpConfig): string {
  const prefix = config["admin_area_prefix"];
  return typeof prefix === "string" && prefix !== "" ? prefix.replace(/\/+$/, "") : "/admin";
}

function finalizationAllowedUrls(config: PhpConfig): string[] {
  const prefix = adminPrefixOf(config);
  return [`${prefix}/staff/login`, `${prefix}/system/update/finalize`];
}

function normalizeMaintenanceMode(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : [];
}

export function enableMaintenanceMode(configPath: string): void {
  const config = readConfigFile(configPath);
  const mode = normalizeMaintenanceMode(config["maintenance_mode"]) as Record<string, unknown>;
  mode["enabled"] = true;
  const existing = Array.isArray(mode["allowed_urls"]) ? (mode["allowed_urls"] as unknown[]) : [];
  const merged = [...existing];
  for (const url of finalizationAllowedUrls(config)) {
    if (!merged.includes(url)) merged.push(url);
  }
  mode["allowed_urls"] = merged;
  config["maintenance_mode"] = mode as PhpConfigValue;
  writeConfigFile(config, configPath);
}

export function restoreMaintenanceMode(configPath: string, captured: unknown): void {
  const config = readConfigFile(configPath);
  config["maintenance_mode"] = normalizeMaintenanceMode(captured) as PhpConfigValue;
  writeConfigFile(config, configPath);
}

/**
 * createPendingState: returns the existing state when one already
 * requires finalization (never overwrites it); otherwise writes pending
 * FIRST, then enables maintenance mode.
 */
export function createPendingState(
  installRoot: string,
  configPath: string,
  fromVersion: string | null,
  targetVersion: string,
  source: string,
): FinalizationState {
  const existing = readState(installRoot);
  if (stateRequiresFinalization(existing)) return existing!;
  const config = readConfigFile(configPath);
  const updateBranch = config["update_branch"];
  const state: FinalizationState = {
    status: "pending",
    from_version: fromVersion,
    target_version: targetVersion,
    branch: typeof updateBranch === "string" ? updateBranch : "release",
    update_type: detectUpdateType(fromVersion, targetVersion),
    source,
    created_at: dateAtom(),
    finalized_at: null,
    completed_at: null,
    maintenance_mode: normalizeMaintenanceMode(config["maintenance_mode"]),
  };
  writeState(installRoot, state);
  enableMaintenanceMode(configPath);
  return state;
}

/**
 * ensureCurrentVersionFinalization: complete-for-current -> null (nothing
 * to do); requires-finalization -> keep; else create pending (source
 * version-state-mismatch when a state exists, missing-finalization-state
 * when none does). Mirrors UpdateFinalization::ensureCurrentVersionFinalization.
 */
export function ensureCurrentVersionFinalization(
  installRoot: string,
  configPath: string,
): FinalizationState | null {
  const state = readState(installRoot);
  if (isCompleteForCurrentVersion(state)) return null;
  if (stateRequiresFinalization(state)) return state;
  const fromVersion = state?.version ?? null;
  const source = state === null ? "missing-finalization-state" : "version-state-mismatch";
  return createPendingState(installRoot, configPath, fromVersion, FINALIZATION_VERSION, source);
}

// ---------------------------------------------------------------------------
// Config patches (UpdatePatcher::applyConfigPatches, force = true)
// ---------------------------------------------------------------------------

type ConfigObj = Record<string, unknown>;

function isObj(v: unknown): v is ConfigObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ensureObj(parent: ConfigObj, key: string): ConfigObj {
  const cur = parent[key];
  if (cur === undefined || cur === null) {
    const fresh: ConfigObj = {};
    parent[key] = fresh;
    return fresh;
  }
  if (!isObj(cur)) throw new Error(`update-finalization: config block '${key}' is not an object`);
  return cur;
}

/** PHP ??= : assign only when missing or null (false/0/'' are kept). */
function fillMissing(obj: ConfigObj, key: string, value: unknown): void {
  if (obj[key] === undefined || obj[key] === null) obj[key] = value;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Returns true when the config file was rewritten. Throws
 * 'Unable to load existing configuration' when the file is missing or
 * unparseable (PHP throws the same message on an empty config).
 */
export function applyConfigPatches(configPath: string): boolean {
  let current: PhpConfig;
  try {
    current = readConfigFile(configPath);
  } catch {
    throw new Error("Unable to load existing configuration");
  }
  if (Object.keys(current).length === 0) throw new Error("Unable to load existing configuration");
  const original: PhpConfig = JSON.parse(JSON.stringify(current));
  const next: ConfigObj = JSON.parse(JSON.stringify(current));

  const security = ensureObj(next, "security");
  fillMissing(security, "mode", "strict");
  fillMissing(security, "force_https", true);
  const proxies = ensureObj(security, "trusted_proxies");
  fillMissing(proxies, "enabled", false);
  fillMissing(proxies, "proxies", []);
  fillMissing(proxies, "headers", "x_forwarded");
  // Legacy top-level cookie_lifespan fallback for session_lifespan.
  fillMissing(security, "session_lifespan", (security["cookie_lifespan"] ?? 7200) as unknown);
  fillMissing(security, "session_regeneration_grace_period", 300);
  fillMissing(security, "perform_session_fingerprinting", true);
  fillMissing(security, "debug_fingerprint", false);
  fillMissing(next, "update_branch", "release");
  // Top-level keys first: debug_and_monitoring inherits from them below.
  fillMissing(next, "log_stacktrace", true);
  fillMissing(next, "stacktrace_length", 25);
  const maintenance = ensureObj(next, "maintenance_mode");
  fillMissing(maintenance, "enabled", false);
  fillMissing(maintenance, "allowed_urls", []);
  fillMissing(maintenance, "allowed_ips", []);
  // UNCONDITIONAL, with the 3306 default even for pgsql (PHP quirk, kept).
  const isDev = process.env["APP_ENV"] === "dev";
  next["disable_auto_cron"] = !isPreviewVersion(FINALIZATION_VERSION) && !isDev;
  const i18n = ensureObj(next, "i18n");
  fillMissing(i18n, "locale", (original["locale"] ?? "en_US") as unknown);
  fillMissing(i18n, "auto_detect_locale", true);
  fillMissing(i18n, "timezone", (original["timezone"] ?? "UTC") as unknown);
  fillMissing(i18n, "date_format", "medium");
  fillMissing(i18n, "time_format", "short");
  const db = ensureObj(next, "db");
  fillMissing(db, "driver", "pdo_mysql");
  db["port"] = normalizePort(db["port"] ?? null, 3306);
  const api = ensureObj(next, "api");
  for (const k of ["rate_span", "rate_limit", "throttle_delay", "rate_span_login", "rate_limit_login", "rate_limit_whitelist"]) {
    delete api[k];
  }
  fillMissing(api, "CSRFPrevention", true);
  const limiter = ensureObj(next, "rate_limiter");
  fillMissing(limiter, "enabled", true);
  fillMissing(limiter, "whitelist_ips", []);
  fillMissing(limiter, "policies", []);
  // Merge from the ORIGINAL config's legacy whitelist (the unset above
  // touched only the working copy).
  const legacyWhitelist = (original["api"] as ConfigObj | undefined)?.["rate_limit_whitelist"];
  const merged = [...(limiter["whitelist_ips"] as unknown[])];
  if (Array.isArray(legacyWhitelist)) {
    for (const ip of legacyWhitelist) if (!merged.includes(ip)) merged.push(ip);
  }
  limiter["whitelist_ips"] = merged;
  const monitoring = ensureObj(next, "debug_and_monitoring");
  fillMissing(monitoring, "debug", (next["debug"] ?? false) as unknown);
  fillMissing(monitoring, "log_stacktrace", next["log_stacktrace"]);
  fillMissing(monitoring, "stacktrace_length", next["stacktrace_length"]);
  fillMissing(monitoring, "report_errors", false);
  // Instance ID handling (composer-autoloader refresh has no TS equivalent).
  const info = ensureObj(next, "info");
  if (info["instance_id"] === undefined || info["instance_id"] === null) {
    // crypto.randomUUID is UUID v4, matching Uuid::v4().
    info["instance_id"] = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ?? "";
  }
  fillMissing(info, "salt", (original["salt"] ?? null) as unknown);
  // Remove the hardcoded protocol (both schemes, anywhere in the string).
  if (typeof next["url"] === "string") {
    next["url"] = (next["url"] as string).replace(/https:\/\//g, "").replace(/http:\/\//g, "");
  }
  for (const k of ["guzzle", "locale", "locale_date_format", "locale_time_format", "timezone", "sef_urls", "salt", "path_logs", "log_to_db"]) {
    delete next[k];
  }
  delete (ensureObj(next, "security"))["cookie_lifespan"];
  delete (ensureObj(next, "db"))["type"];
  if (deepEqualJson(original, next)) return false;
  writeConfigFile(next as PhpConfig, configPath);
  return true;
}

// ---------------------------------------------------------------------------
// Portable schema sync (UpdatePatcher::syncPortableSchema, additive only)
// ---------------------------------------------------------------------------

export interface LiveSchema {
  tables: Map<string, { columns: Set<string>; indexes: Set<string> }>;
}

export async function inspectLiveSchemaSqlite(db: Db): Promise<LiveSchema> {
  const tables = new Map<string, { columns: Set<string>; indexes: Set<string> }>();
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const row of rows) {
    const name = String(row["name"]);
    const cols = await db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all();
    const idxs = await db.prepare(`PRAGMA index_list("${name.replace(/"/g, '""')}")`).all();
    tables.set(name, {
      columns: new Set(cols.map((c) => String(c["name"]))),
      indexes: new Set(idxs.map((c) => String(c["name"]))),
    });
  }
  return { tables };
}

export async function inspectLiveSchemaPostgres(db: Db): Promise<LiveSchema> {
  const tables = new Map<string, { columns: Set<string>; indexes: Set<string> }>();
  const trows = await db
    .prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
    .all();
  for (const row of trows) tables.set(String(row["table_name"]), { columns: new Set(), indexes: new Set() });
  const crows = await db
    .prepare("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'")
    .all();
  for (const row of crows) {
    const entry = tables.get(String(row["table_name"]));
    if (entry) entry.columns.add(String(row["column_name"]));
  }
  const irows = await db
    .prepare("SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'")
    .all();
  for (const row of irows) {
    const entry = tables.get(String(row["tablename"]));
    if (entry) entry.indexes.add(String(row["indexname"]));
  }
  return { tables };
}

export interface SyncReport {
  createdTables: string[];
  addedColumns: string[];
  addedIndexes: string[];
}

function sqliteAddColumn(t: InstallTable, colName: string): string {
  const col = t.columns.find((c) => c.name === colName)!;
  if (col.pk) {
    throw new Error(
      `update-finalization: cannot add missing primary-key column ${t.name}.${colName} to an existing table (the table is structurally not the defined table; refusing rather than altering a PK)`,
    );
  }
  // Reuse the column renderer via a synthetic single-column table is
  // overkill; render inline (same modifier order as the CREATE path).
  const type =
    col.doctrine === "bigint" ? "BIGINT"
    : col.doctrine === "integer" ? "INTEGER"
    : col.doctrine === "smallint" ? "SMALLINT"
    : col.doctrine === "string" ? `VARCHAR(${col.length})`
    : col.doctrine === "text" || col.doctrine === "json" ? "CLOB"
    : col.doctrine === "blob" ? "BLOB"
    : col.doctrine === "boolean" ? "BOOLEAN"
    : col.doctrine === "datetime" ? "DATETIME"
    : col.doctrine === "date" ? "DATE"
    : `NUMERIC(${col.precision}, ${col.scale})`;
  let s = `${col.quoteSqlite ? `"${col.name}"` : col.name} ${type}`;
  if (col.defaultSqlite !== null) s += ` DEFAULT ${col.defaultSqlite}`;
  if (col.notNull) s += " NOT NULL";
  return `ALTER TABLE ${t.quoteSqlite ? `"${t.name}"` : t.name} ADD COLUMN ${s}`;
}

function pgAddColumn(t: InstallTable, colName: string): string {
  const col = t.columns.find((c) => c.name === colName)!;
  if (col.pk) {
    throw new Error(
      `update-finalization: cannot add missing primary-key column ${t.name}.${colName} to an existing table (the table is structurally not the defined table; refusing rather than altering a PK)`,
    );
  }
  const type =
    col.doctrine === "bigint" ? "BIGINT"
    : col.doctrine === "integer" ? "INT"
    : col.doctrine === "smallint" ? "SMALLINT"
    : col.doctrine === "string" ? `VARCHAR(${col.length})`
    : col.doctrine === "text" ? "TEXT"
    : col.doctrine === "json" ? "JSON"
    : col.doctrine === "blob" ? "BYTEA"
    : col.doctrine === "boolean" ? "BOOLEAN"
    : col.doctrine === "datetime" ? "TIMESTAMP(0) WITHOUT TIME ZONE"
    : col.doctrine === "date" ? "DATE"
    : `NUMERIC(${col.precision}, ${col.scale})`;
  let s = `${col.quotePg ? `"${col.name}"` : col.name} ${type}`;
  if (col.defaultPg !== null) s += ` DEFAULT ${col.defaultPg}`;
  if (col.notNull) s += " NOT NULL";
  return `ALTER TABLE ${t.quotePg ? `"${t.name}"` : t.name} ADD COLUMN ${s}`;
}

/**
 * Additive schema sync. Never drops, never alters an existing column,
 * never adds an FK to an existing table (PHP's SchemaSynchronizer rules).
 * Type/nullability/default mismatches on existing columns are reported
 * in the returned `warnings`, never fixed.
 */
export async function syncPortableSchema(
  db: Db,
  platform: "sqlite" | "postgres",
  live?: LiveSchema,
): Promise<SyncReport & { warnings: string[] }> {
  const schema = live ?? (platform === "sqlite"
    ? await inspectLiveSchemaSqlite(db)
    : await inspectLiveSchemaPostgres(db));
  const report: SyncReport & { warnings: string[] } = { createdTables: [], addedColumns: [], addedIndexes: [], warnings: [] };
  for (const t of INSTALL_SCHEMA) {
    const liveTable = schema.tables.get(t.name);
    if (!liveTable) {
      const stmts = platform === "sqlite" ? emitCreateTableSqlite(t) : emitCreateTablePostgres(t);
      for (const stmt of stmts) await db.exec(stmt);
      report.createdTables.push(t.name);
      continue;
    }
    for (const col of t.columns) {
      if (!liveTable.columns.has(col.name)) {
        const stmt = platform === "sqlite" ? sqliteAddColumn(t, col.name) : pgAddColumn(t, col.name);
        await db.exec(stmt);
        report.addedColumns.push(`${t.name}.${col.name}`);
      }
    }
    for (const ix of t.indexes) {
      if (!liveTable.indexes.has(ix.name)) {
        const cols = ix.columns
          .map((c) => {
            const col = t.columns.find((cc) => cc.name === c)!;
            return platform === "sqlite"
              ? col.quoteSqlite ? `"${c}"` : c
              : col.quotePg ? `"${c}"` : c;
          })
          .join(", ");
        const tableQ = platform === "sqlite"
          ? t.quoteSqlite ? `"${t.name}"` : t.name
          : t.quotePg ? `"${t.name}"` : t.name;
        await db.exec(`CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${ix.name} ON ${tableQ} (${cols})`);
        report.addedIndexes.push(`${t.name}.${ix.name}`);
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Finalize / complete orchestration
// ---------------------------------------------------------------------------

/** Legacy MySQL-only patches: 0 on every TS target by definition. */
export function availablePatchCount(): number {
  return 0;
}

function withLock<T>(installRoot: string, fn: () => T | Promise<T>): T | Promise<T> {
  const lockPath = lockFilePath(installRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch {
    throw new Error("update-finalization: another finalization is already running (lock file exists)");
  }
  const done = (result: T | Promise<T>): T | Promise<T> => {
    if (result instanceof Promise) {
      return result.finally(() => {
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
      }) as Promise<T>;
    }
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
    return result;
  };
  try {
    return done(fn());
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * finalizeUpdateLocked: config patches -> core patches (schema sync) ->
 * state finalized + finalized_at. clearCache and install-dir removal are
 * TS no-ops (documented above). Throws propagate: state stays pending,
 * maintenance stays ON.
 */
export async function finalizeUpdateLocked(
  installRoot: string,
  configPath: string,
  db: Db,
  platform: "sqlite" | "postgres",
  state: FinalizationState | null,
): Promise<FinalizationState | null> {
  applyConfigPatches(configPath);
  await syncPortableSchema(db, platform);
  if (state !== null) {
    const next: FinalizationState = { ...state, status: "finalized", finalized_at: dateAtom() };
    writeState(installRoot, next);
    return next;
  }
  return null;
}

/**
 * finalizePendingUpdate (bootstrap path): pending -> finalize; finalized
 * + pending patches -> heal (re-finalize); else schema-drift heal that
 * never throws. Returns the resulting state (or null when already
 * complete-for-current).
 */
export async function finalizePendingUpdate(
  installRoot: string,
  configPath: string,
  db: Db,
  platform: "sqlite" | "postgres",
): Promise<FinalizationState | null> {
  const state = readState(installRoot);
  if (isCompleteForCurrentVersion(state)) return null;
  return withLock(installRoot, async () => {
    const current = readState(installRoot);
    if (current !== null && current.status === "pending") {
      return finalizeUpdateLocked(installRoot, configPath, db, platform, current);
    }
    if (current !== null && current.status === "finalized" && availablePatchCount() > 0) {
      return finalizeUpdateLocked(installRoot, configPath, db, platform, current);
    }
    // Heal schema drift only; never throws (PHP healSchemaDrift).
    try {
      await syncPortableSchema(db, platform);
    } catch {
      // Deliberately swallowed: drift heal must not fail the bootstrap.
    }
    return current;
  }) as Promise<FinalizationState | null>;
}

/**
 * completeFinalization: null/already-complete -> writeCompleteState;
 * otherwise requires finalized (else the exact PHP message) and zero
 * pending patches, then restores maintenance mode and completes.
 */
export function completeFinalization(
  installRoot: string,
  configPath: string,
): FinalizationState {
  const state = readState(installRoot);
  if (state === null || state.status === "complete") {
    return writeCompleteState(installRoot, state);
  }
  if (state.status !== "finalized") {
    throw new Error("Update finalization must be run before it can be completed.");
  }
  const pending = availablePatchCount();
  if (pending > 0) {
    throw new Error(
      `Update finalization cannot be completed with ${pending} pending patches.`,
    );
  }
  const completed: FinalizationState = {
    ...state,
    status: "complete",
    completed_at: dateAtom(),
  };
  restoreMaintenanceMode(configPath, state.maintenance_mode ?? []);
  writeCompleteState(installRoot, completed);
  return readState(installRoot)!;
}

/** CLI path (PHP: "CLI patching has no review screen, so it performs both web steps"). */
export async function finalizeAndComplete(
  installRoot: string,
  configPath: string,
  db: Db,
  platform: "sqlite" | "postgres",
): Promise<FinalizationState> {
  const state = readState(installRoot);
  if (isCompleteForCurrentVersion(state)) return state!;
  await withLock(installRoot, async () => {
    const current = readState(installRoot);
    if (current !== null && (current.status === "pending" || current.status === "finalized")) {
      await finalizeUpdateLocked(installRoot, configPath, db, platform, current);
    } else if (current === null) {
      // No state at all: ensure() creates pending + maintenance ON first.
      ensureCurrentVersionFinalization(installRoot, configPath);
      const pending = readState(installRoot)!;
      await finalizeUpdateLocked(installRoot, configPath, db, platform, pending);
    }
  });
  return completeFinalization(installRoot, configPath);
}
