// FOSSBilling Phase 5 R5j: standalone installer script (NOT a web
// wizard — R5-6 at recommended defaults). Installs a fresh FOSSBilling
// database + config.php + update-finalization state, for Postgres or
// SQLite targets, following the R3b standalone-script precedent.
//
// Step order (install.php's installPortable + install, minus the two
// scope-dropped steps):
//   1. Validate inputs (driver, admin, URL, port) — BEFORE any write.
//   2. Refuse on an existing config file ('FOSSBilling is already
//      installed.', PHP's isAlreadyInstalled message) AND on a non-empty
//      target database. No --force flag exists, by design (R3b precedent).
//      PHP's own guard is config-file existence only — it would crash
//      mid-schema-creation on a non-empty DB; the DB guard is the
//      documented match-or-improve.
//      EXCEPTION (E-2, Tier 1 fix): a re-run RESUMES a provably
//      interrupted fresh install instead of refusing it — see
//      "Resume / repair" below. A genuinely-existing install (config +
//      complete finalization + GeoIP all present, or a DB that is not
//      exactly the fresh-seeded state) still refuses exactly as before,
//      and --repair never re-seeds, never regenerates a salt, and never
//      touches a non-fresh database.
//   3. Create the database when missing (Postgres: admin connection to
//      dbname 'postgres', CREATE DATABASE "quoted" silently-if-exists;
//      SQLite: mkdir -p the parent dir). The DB user needs CREATEDB,
//      exactly as PHP requires.
//   4. Create the schema from the TS entity definitions (install-schema
//      + emitters: byte-equal to Doctrine's SchemaInstaller output).
//      Postgres uses emitFullSchemaPostgres() — every CREATE + index
//      BEFORE any FK ALTER — because the per-table order fails on
//      forward FK references (E-1: invoice→pay_gateway sorts later;
//      the per-table order died at statement 92/211 in pg-mem).
//   5. Replay content.sql + seedAdmin (bcrypt cost 12) +
//      setDefaultCurrency + seedInstallNudge, in one transaction.
//      Fresh-state criterion: 83 + 2 + 1 = 86 rows, everything else empty.
//   6. Write config.php via R5a's proven serializeConfig output
//      (temp + rename with a UNIQUE temp name, no backup — there is no
//      prior file to back up). The old writeInitialConfig fixed temp
//      name (<config>.tmp-r5j) is NOT used here: a stale temp directory
//      of that name made the config write fail EISDIR after the DB had
//      committed (E-2 probe A), and a fixed name collides between
//      concurrent installs.
//   7. Write the update-finalization complete state (PHP's
//      writeCompleteState shape), so the R5f cron gate opens immediately.
//   8. Copy the GeoIP .mmdb files into <installRoot>/data/geoip (unless
//      --no-geoip) and report the FB_GEOIP_DB_DIR value to set. A missing
//      GeoIP source WARNS, never fails the install (a non-core asset
//      must not fail an install — the .htaccess-fetch lesson, inverted:
//      PHP failed installs on a fetch failure; the TS installer does not).
//      A mid-copy failure DOES fail the install (a silently-missing
//      GeoIP DB would break ip_lookup with no signal) — but the state
//      it leaves is resumable (see below), and each file is copied via
//      temp + rename so a failed copy never leaves a torn .mmdb.
//
// Resume / repair (E-2 design — chosen shape and trade-offs):
//   The schema+seed transaction is atomic, so after ANY failure the DB
//   is either empty or exactly the fresh-seeded state (64 tables,
//   86 rows). Post-commit steps are each idempotent, so a re-run can
//   safely redo just the missing ones — IF it can tell an interrupted
//   fresh install from a live one. It can, by fingerprint (see
//   inspectFreshSeed): exact 64-table set, exactly 86 rows, the single
//   admin row's email + bcrypt password matching the re-run's supplied
//   admin credentials, the install-nudge row, and NO salt-encrypted
//   (`v2:`) values anywhere (a fresh seed contains none; a live install
//   that accumulated encrypted extension configs fails this check and
//   is never resumed). Two cases resume AUTOMATICALLY, no flag:
//     (A) no config.php + fresh-seeded DB (config write failed after
//         the commit — E-2 probe A): skip schema+seed, write a fresh
//         config (fresh salt is safe: the seed is salt-independent and
//         no encrypted values exist yet), finalization, GeoIP.
//     (B) config.php exists + fresh-seeded DB + finalization or GeoIP
//         detectably incomplete (GeoIP copy failed after everything
//         else — E-2 probe B): keep the existing config byte-identical
//         (NEVER regenerate its salt: stored encrypted values depend
//         on it), rewrite only the missing post-commit steps.
//   What does NOT auto-resume: a complete install (config + complete
//   finalization + GeoIP all present) is indistinguishable from a
//   working install, so a plain re-run still refuses with exit 2.
//   --repair covers exactly that no-residue case: it re-runs the
//   post-commit steps idempotently against a fingerprint-verified
//   fresh-seeded DB (config kept, never rewritten) and exits 0. It is
//   an explicit operator opt-in, never an overwrite tool: with a
//   non-fresh DB it refuses exactly like a plain re-run.
//   Trade-offs: (1) a plain re-run of a no-residue interrupted install
//   still refuses — the installer cannot read the operator's mind, and
//   silently "repairing" a working install would hide real state;
//   --repair is the documented escape hatch. (2) Resume (A) trusts
//   the supplied admin password as proof the re-run is the same
//   operator/installation; a wrong password refuses rather than
//   overwriting the seeded admin. (3) A re-run with a different
//   --currency keeps the seeded currency (reported, not silently
//   re-applied). (4) Live-Postgres resume is unproven (no PG server
//   in the sandbox) — the fingerprint queries are driver-agnostic
//   SELECTs, but only SQLite resume is end-to-end proven here.
//
// Dropped with reasons (scope): .htaccess fetch (Next routing does not
// use .htaccess), client theme config template copy (no theme files in
// Next), generateEmailTemplates (post-install sync; the TS email service
// falls back to emailDefaults when no DB row exists, and activation
// syncs rows in both stacks), install.php deletion (a standalone script
// has nothing to delete).
//
// Secrets: the admin password and the salt are NEVER printed, logged, or
// included in the report (only presence booleans). Prefer the env var
// FB_INSTALL_ADMIN_PASSWORD over the --admin-password flag (argv is
// visible in local process listings).
//
// Usage: node scripts/run-install.mjs --install-root DIR --url URL
//   --admin-name NAME --admin-email EMAIL [--admin-password PASS]
//   [--db-driver pdo_sqlite|pdo_pgsql] [--db-path FILE]
//   [--db-host H] [--db-port P] [--db-name N] [--db-user U]
//   [--db-password P] [--currency USD] [--locale en_US]
//   [--no-auto-detect-locale] [--report-errors]
//   [--trusted-proxies a,b] [--trusted-proxy-headers x_forwarded]
//   [--content-sql FILE] [--geoip-source DIR | --no-geoip]
//   [--salt HEX] [--json] [--help]
// Exit codes: 0 installed, 1 usage/validation/operational error,
//   2 refusal (existing config or non-empty target).
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { hashSync, compareSync } from "bcryptjs";
import { DbSqlite, type Db } from "../src/server/db";
import { DbPg } from "../src/server/pg";
import {
  buildInstallConfig,
  INSTALL_VERSION,
  normalizePort,
  normalizeSystemUrl,
} from "../src/server/install-config";
import { serializeConfig, type PhpConfig } from "../src/server/config-store";
import {
  emitCreateTableSqlite,
  emitFullSchemaPostgres,
} from "../src/server/install-schema-ddl";
import { INSTALL_SCHEMA } from "../src/server/install-schema";
import {
  formatSeedTimestamp,
  seedAdmin,
  seedContent,
  seedInstallNudge,
  setDefaultCurrency,
} from "../src/server/install-seed";
import {
  isCompleteForCurrentVersion,
  readState,
  stateFilePath,
  writeCompleteState,
} from "../src/server/update-finalization";

const GEOIP_FILES = ["CC0-Country.mmdb", "PDDL-ASN.mmdb"];

export interface InstallOptions {
  installRoot: string;
  systemUrl: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  adminApiToken: string | null;
  dbDriver: "pdo_sqlite" | "pdo_pgsql";
  dbPath: string | null;
  dbHost: string;
  dbPort: string | null;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  currency: string;
  locale: string;
  autoDetectLocale: boolean;
  reportErrors: boolean;
  trustedProxies: string[];
  trustedProxyHeaders: string;
  contentSql: string | null;
  geoipSource: string | null;
  noGeoip: boolean;
  salt: string | null;
  json: boolean;
  /** --repair: re-run the post-commit steps idempotently against a
   * fingerprint-verified interrupted fresh install that leaves no
   * detectable residue (config + complete finalization + GeoIP all
   * present, yet the first run reported failure). Never re-seeds,
   * never regenerates a salt, never touches a non-fresh database. */
  repair: boolean;
}

function fail(message: string, code = 1): never {
  throw new InstallError(message, code);
}

class InstallError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

/**
 * PHP install.php validateAdmin, exact rules/messages/order. The email
 * check is a conservative approximation of FILTER_VALIDATE_EMAIL (a
 * full filter_var port is out of scope; clearly-valid and clearly-invalid
 * addresses behave identically, which is what the installer-test asserts).
 */
export function validateAdmin(name: string, email: string, password: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("The admin email is not a valid address.");
  }
  if (password.length < 8) {
    fail("Minimum admin password length is 8 characters.");
  }
  if (!/[0-9]/.test(password)) {
    fail("Admin password must include at least one number.");
  }
  if (!/[a-z]/.test(password)) {
    fail("Admin password must include at least one lowercase letter.");
  }
  if (!/[A-Z]/.test(password)) {
    fail("Admin password must include at least one uppercase letter.");
  }
  if (name === "") {
    fail("You must enter an Admin Name.");
  }
}

function parseArgs(argv: string[]): InstallOptions {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help") {
      console.log(
        "Usage: node scripts/run-install.mjs --install-root DIR --url URL --admin-name NAME --admin-email EMAIL\n" +
          "  [--admin-password PASS | FB_INSTALL_ADMIN_PASSWORD] [--db-driver pdo_sqlite|pdo_pgsql]\n" +
          "  [--db-path FILE] [--db-host H] [--db-port P] [--db-name N] [--db-user U] [--db-password P]\n" +
          "  [--currency USD] [--locale en_US] [--no-auto-detect-locale] [--report-errors]\n" +
          "  [--trusted-proxies a,b] [--trusted-proxy-headers x_forwarded] [--content-sql FILE]\n" +
          "  [--geoip-source DIR | --no-geoip] [--salt HEX] [--json] [--repair]",
      );
      process.exit(0);
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (["no-auto-detect-locale", "report-errors", "no-geoip", "json", "repair"].includes(key)) {
        bools.add(key);
      } else if (i + 1 < argv.length) {
        flags.set(key, argv[++i]!);
      } else {
        fail(`Missing value for ${arg}.`);
      }
    } else {
      fail(`Unexpected argument: ${arg}.`);
    }
  }
  const installRoot = flags.get("install-root");
  if (!installRoot) fail("--install-root is required.");
  const systemUrl = flags.get("url");
  if (!systemUrl) fail("--url is required.");
  const adminName = flags.get("admin-name") ?? "";
  const adminEmail = flags.get("admin-email") ?? "";
  const adminPassword = flags.get("admin-password") ?? process.env["FB_INSTALL_ADMIN_PASSWORD"] ?? "";
  if (adminPassword === "") fail("Admin password is required (--admin-password or FB_INSTALL_ADMIN_PASSWORD).");
  const driver = flags.get("db-driver") ?? "pdo_sqlite";
  if (driver !== "pdo_sqlite" && driver !== "pdo_pgsql") {
    fail("Unsupported database driver.");
  }
  return {
    installRoot,
    systemUrl,
    adminName,
    adminEmail,
    adminPassword,
    adminApiToken: flags.get("admin-api-token") ?? null,
    dbDriver: driver,
    dbPath: flags.get("db-path") ?? null,
    dbHost: flags.get("db-host") ?? "127.0.0.1",
    dbPort: flags.get("db-port") ?? null,
    dbName: flags.get("db-name") ?? "fossbilling",
    dbUser: flags.get("db-user") ?? "fossbilling",
    dbPassword: flags.get("db-password") ?? "",
    currency: flags.get("currency") ?? "USD",
    locale: flags.get("locale") ?? "en_US",
    autoDetectLocale: !bools.has("no-auto-detect-locale"),
    reportErrors: bools.has("report-errors"),
    trustedProxies: (flags.get("trusted-proxies") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
    trustedProxyHeaders: flags.get("trusted-proxy-headers") ?? "x_forwarded",
    contentSql: flags.get("content-sql") ?? process.env["FB_INSTALL_CONTENT_SQL"] ?? null,
    geoipSource: flags.get("geoip-source") ?? null,
    noGeoip: bools.has("no-geoip"),
    salt: flags.get("salt") ?? null,
    json: bools.has("json"),
    repair: bools.has("repair"),
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function listTables(db: Db, platform: "sqlite" | "postgres"): Promise<string[]> {
  if (platform === "sqlite") {
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    return rows.map((r) => String(r["name"]));
  }
  const rows = await db
    .prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
    .all();
  return rows.map((r) => String(r["table_name"]));
}

// ---------------------------------------------------------------------------
// E-2 resume machinery
// ---------------------------------------------------------------------------

/** Fresh-install criterion (R5j): 63 schema tables + rate_limit_counter, 86 rows. */
const FRESH_SEEDED_TABLE_COUNT = INSTALL_SCHEMA.length + 1;
const FRESH_SEEDED_ROW_COUNT = 86;
const FRESH_SEEDED_TABLES = [...INSTALL_SCHEMA.map((t) => t.name), "rate_limit_counter"].sort();

async function countRows(db: Db, table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`)
    .get<{ n: unknown }>();
  return Number(row?.n ?? 0);
}

export interface FreshSeedInspection {
  /** True only when the DB is exactly the state the seed transaction commits. */
  fresh: boolean;
  /** Why not fresh (for the refusal message). Null when fresh. */
  reason: string | null;
  adminId: number;
  seededCurrency: string | null;
}

/**
 * Fingerprint a non-empty DB as "exactly the fresh-seeded state the
 * installer transaction commits" — the ONLY non-empty DB a re-run may
 * resume. Checks, in order: exact 64-table set; exactly 86 rows in
 * total; exactly one admin row whose email matches the re-run's admin
 * email and whose bcrypt hash verifies the re-run's admin password
 * (proof the re-run is the same operator/installation — a wrong
 * password refuses rather than overwriting the seeded admin); the
 * install-nudge setting row; the admin_group_member seed row; and NO
 * salt-encrypted (`v2:`) values in extension_meta/setting (a fresh
 * seed contains none — crypt.ts encrypts extension configs to `v2:`
 * under the install salt — so any such value proves post-install
 * activity and blocks resume, since a resumed config write would
 * mint a fresh salt and orphan those values).
 * Driver-agnostic SELECTs only; no writes.
 */
export async function inspectFreshSeed(
  db: Db,
  platform: "sqlite" | "postgres",
  opts: Pick<InstallOptions, "adminEmail" | "adminPassword">,
): Promise<FreshSeedInspection> {
  const notFresh = (reason: string): FreshSeedInspection =>
    ({ fresh: false, reason, adminId: 0, seededCurrency: null });
  const tables = (await listTables(db, platform)).sort();
  if (JSON.stringify(tables) !== JSON.stringify(FRESH_SEEDED_TABLES)) {
    return notFresh(
      `table set is not the fresh-seeded set (${tables.length} tables, expected ${FRESH_SEEDED_TABLE_COUNT})`,
    );
  }
  let total = 0;
  for (const t of tables) total += await countRows(db, t);
  if (total !== FRESH_SEEDED_ROW_COUNT) {
    return notFresh(`row count is ${total}, expected fresh-seeded ${FRESH_SEEDED_ROW_COUNT}`);
  }
  const admins = await db
    .prepare("SELECT id, email, pass FROM admin")
    .all<{ id: unknown; email: unknown; pass: unknown }>();
  if (admins.length !== 1) return notFresh(`admin table has ${admins.length} rows, expected 1`);
  const admin = admins[0]!;
  if (String(admin["email"]) !== opts.adminEmail) {
    return notFresh("seeded admin email does not match the supplied admin email");
  }
  if (typeof admin["pass"] !== "string" || !compareSync(opts.adminPassword, admin["pass"])) {
    return notFresh("supplied admin password does not verify against the seeded admin");
  }
  const nudge = await db
    .prepare("SELECT value FROM setting WHERE param = 'last_error_reporting_nudge'")
    .get<{ value: unknown }>();
  if (!nudge || String(nudge["value"]) !== INSTALL_VERSION) {
    return notFresh("install-nudge setting row is missing or unexpected");
  }
  const members = await db.prepare("SELECT admin_id, admin_group_id FROM admin_group_member").all();
  if (
    members.length !== 1 ||
    Number(members[0]!["admin_id"]) !== Number(admin["id"]) ||
    Number(members[0]!["admin_group_id"]) !== 1
  ) {
    return notFresh("admin_group_member seed row is missing or unexpected");
  }
  const encrypted = await db
    .prepare("SELECT COUNT(*) AS n FROM extension_meta WHERE meta_value LIKE 'v2:%'")
    .get<{ n: unknown }>();
  if (Number(encrypted?.n ?? 0) > 0) {
    return notFresh("database holds salt-encrypted values from post-install activity");
  }
  const encryptedSetting = await db
    .prepare("SELECT COUNT(*) AS n FROM setting WHERE value LIKE 'v2:%'")
    .get<{ n: unknown }>();
  if (Number(encryptedSetting?.n ?? 0) > 0) {
    return notFresh("database holds salt-encrypted values from post-install activity");
  }
  const currency = await db
    .prepare("SELECT code FROM currency WHERE id = 1")
    .get<{ code: unknown }>();
  return {
    fresh: true,
    reason: null,
    adminId: Number(admin["id"]),
    seededCurrency: typeof currency?.code === "string" ? currency.code : null,
  };
}

/**
 * Is the GeoIP step already complete for this install root? True when
 * GeoIP is disabled (--no-geoip), when there is no source to copy from
 * (missing source only WARNS on a fresh install, so it is not an
 * incomplete step), when source and destination are the same directory,
 * or when both .mmdb files are present in the destination. Anything
 * else — destination missing, a stray file in its place, files missing —
 * means the step never completed and a re-run must redo it.
 */
function geoipComplete(opts: InstallOptions, dataDir: string): boolean {
  if (opts.noGeoip) return true;
  const source = opts.geoipSource ?? defaultGeoipSource();
  if (source === null) return true;
  const destDir = path.join(dataDir, "geoip");
  if (path.resolve(source) === path.resolve(destDir)) return true;
  try {
    if (!fs.statSync(destDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return GEOIP_FILES.every((f) => {
    try {
      return fs.statSync(path.join(destDir, f)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Write the initial config file: R5a's serializeConfig output, temp +
 * rename, with a UNIQUE temp name (pid + random). The old fixed temp
 * name (<config>.tmp-r5j) is not used: a stale temp DIRECTORY of that
 * name failed the write with EISDIR after the DB had committed (E-2
 * probe A), and a fixed name collides between concurrent installs. A
 * failed write removes its own temp file (best effort) so no residue
 * can brick a later re-run; rename(2) makes the publish atomic.
 */
function writeConfigAtomic(config: PhpConfig, configPath: string): void {
  const tmp = `${configPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, serializeConfig(config), "utf8");
    fs.renameSync(tmp, configPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort only; the rename either happened or it did not.
    }
    throw e;
  }
}

/**
 * Copy the GeoIP .mmdb files idempotently: each file goes via temp +
 * rename inside the destination dir, so a failed copy never leaves a
 * torn .mmdb, and re-running re-copies only what is missing or torn.
 * If the destination path exists as a non-directory (a stray file or
 * symlink — E-2 probe B's trigger), it is removed first: data/geoip
 * is installer-owned and a file there can never be a valid GeoIP
 * install, so keeping it would brick every re-run. A missing source
 * is the caller's problem (warn path), not this function's.
 */
function copyGeoipFiles(source: string, destDir: string): void {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(destDir);
  } catch {
    // Missing: mkdir below creates it.
  }
  if (st !== null && !st.isDirectory()) fs.rmSync(destDir, { force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of GEOIP_FILES) {
    const dest = path.join(destDir, f);
    const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      fs.copyFileSync(path.join(source, f), tmp);
      fs.renameSync(tmp, dest);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Best effort only.
      }
      throw e;
    }
  }
}

/**
 * Throw a phase-context failure for a post-commit step: names the step
 * that failed, what had already committed, and that a re-run resumes
 * (no manual cleanup needed). Exit code stays 1 (operational error).
 */
function failPostCommit(phase: string, completed: string[], e: unknown): never {
  const detail = e instanceof Error ? e.message : String(e);
  fail(
    `Post-commit step '${phase}' failed after ${completed.length > 0 ? completed.join(", ") : "nothing"} committed (${detail}). ` +
      "Re-run the installer to resume — no manual cleanup is needed.",
  );
}

// R6c: vendored defaults (apps/nextjs/vendor/) — the fork src/ tree is
// gone. --content-sql / FB_INSTALL_CONTENT_SQL and --geoip-source
// overrides still win; FOSSBILLING_PHP_SRC is no longer consulted.
function defaultContentSqlPath(): string {
  return path.join(process.cwd(), "vendor", "content.sql");
}

function defaultGeoipSource(): string | null {
  const vendored = path.join(process.cwd(), "vendor", "geoip");
  return fs.existsSync(vendored) ? vendored : null;
}

export async function main(argv: string[]): Promise<number> {
  let opts: InstallOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof InstallError) {
      console.error(`install FAILED: ${e.message}`);
      return e.code;
    }
    throw e;
  }
  try {
    return await runInstall(opts);
  } catch (e) {
    if (e instanceof InstallError) {
      console.error(`install FAILED: ${e.message}`);
      return e.code;
    }
    console.error(`install FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function runInstall(opts: InstallOptions): Promise<number> {
  const configPath = path.join(opts.installRoot, "config.php");
  const dataDir = path.join(opts.installRoot, "data");
  const sqlitePath =
    opts.dbDriver === "pdo_sqlite"
      ? (opts.dbPath ?? path.join(dataDir, "fossbilling.sqlite"))
      : null;
  const platform = opts.dbDriver === "pdo_sqlite" ? "sqlite" : "postgres";
  const configExists = fs.existsSync(configPath);

  // 1. Fast-path refusal, unchanged behavior, no DB touched (PHP's
  //    isAlreadyInstalled runs before validation): a config exists AND
  //    finalization is complete AND GeoIP is complete. That is a
  //    working install — or an interrupted install with no detectable
  //    residue, which a plain re-run cannot tell apart, so it refuses
  //    exactly as before. Only --repair falls through to the
  //    fingerprint-verified repair path below.
  if (
    configExists &&
    isCompleteForCurrentVersion(readState(opts.installRoot)) &&
    geoipComplete(opts, dataDir)
  ) {
    if (!opts.repair) {
      fail("FOSSBilling is already installed.", 2);
    }
  }
  // 2. Validate everything before any other write (PHP validates before install()).
  validateAdmin(opts.adminName, opts.adminEmail, opts.adminPassword);
  const normalizedUrl = normalizeSystemUrl(opts.systemUrl);
  if (opts.dbDriver === "pdo_pgsql" && opts.dbPort !== null && normalizePort(opts.dbPort, null) === null) {
    fail("Database port is invalid.");
  }

  let db: Db;
  let closeDb: () => Promise<void>;
  let pool: Pool | null = null;
  if (opts.dbDriver === "pdo_sqlite") {
    fs.mkdirSync(path.dirname(sqlitePath!), { recursive: true });
    const conn = new DatabaseSync(sqlitePath!);
    db = new DbSqlite(conn);
    closeDb = async () => { conn.close(); };
  } else {
    const port = normalizePort(opts.dbPort, 5432)!;
    // Admin connection to dbname 'postgres': CREATE DATABASE silently-if-exists.
    const adminPool = new Pool({
      host: opts.dbHost, port, user: opts.dbUser, password: opts.dbPassword, database: "postgres",
    });
    try {
      await adminPool.query(`CREATE DATABASE ${quoteIdent(opts.dbName)}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "42P04") throw e; // duplicate_database is the silent-if-exists path
    } finally {
      await adminPool.end();
    }
    pool = new Pool({
      host: opts.dbHost, port, user: opts.dbUser, password: opts.dbPassword, database: opts.dbName,
    });
    db = new DbPg(pool);
    closeDb = async () => { await pool!.end(); };
  }

  try {
    // Classification (E-2): the seed transaction is atomic, so a
    // non-empty DB is either a live install or exactly the fresh-seeded
    // state. Only the latter may resume, and only with matching admin
    // credentials (see inspectFreshSeed).
    const existingTables = await listTables(db, platform);
    let resumed: string | null = null;
    let repaired = false;
    let configKept = false;
    let adminId = 0;
    let totalSeeded = 0;
    let seededCurrency: string | null = null;
    const completedPhases: string[] = [];
    if (existingTables.length > 0) {
      const inspection = await inspectFreshSeed(db, platform, opts);
      if (!inspection.fresh) {
        // Genuinely non-empty / live DB: refuse exactly as before.
        // (--repair on a non-fresh DB refuses too — repair never
        // overwrites, re-seeds, or regenerates a salt.)
        if (configExists) {
          fail("FOSSBilling is already installed.", 2);
        }
        fail(
          `Refusing to install into a non-empty database (${existingTables.length} tables already exist).`,
          2,
        );
      }
      adminId = inspection.adminId;
      totalSeeded = FRESH_SEEDED_ROW_COUNT;
      seededCurrency = inspection.seededCurrency;
      completedPhases.push("database (already seeded)");
      if (!configExists) {
        // Probe A: config write failed after the commit. Skip the seed
        // transaction; write a fresh config below (safe: the seed is
        // salt-independent and holds no encrypted values).
        resumed = "seeded-db-no-config";
      } else if (
        !isCompleteForCurrentVersion(readState(opts.installRoot)) ||
        !geoipComplete(opts, dataDir)
      ) {
        // Probe B: config exists but finalization or GeoIP never
        // completed. Keep the existing config byte-identical below.
        resumed = "post-commit-incomplete";
        configKept = true;
        completedPhases.push("config (kept existing)");
      } else {
        // Complete install, no residue: only --repair reaches here
        // (the fast-path refusal above caught plain re-runs).
        repaired = true;
        resumed = "repair-complete-install";
        configKept = true;
        completedPhases.push("config (kept existing)");
      }
    }

    // Schema + seeds + admin + currency + nudge, in one transaction.
    // Fresh installs only — a resumed install skips this entirely.
    if (existingTables.length === 0) {
    const contentSqlPath = opts.contentSql ?? defaultContentSqlPath();
    let contentSql: string;
    try {
      contentSql = fs.readFileSync(contentSqlPath, "utf8");
    } catch {
      fail("Could not read content.sql file");
    }
    const nowIso = formatSeedTimestamp(new Date());
    const passwordHash = hashSync(opts.adminPassword, 12);
    let seededCounts: Record<string, number> = {};
    await db.withTransaction(async (tx) => {
      // E-1: Postgres uses the deferred order — every CREATE + index
      // BEFORE any FK ALTER — because the per-table order fails on
      // forward FK references (invoice→pay_gateway et al.).
      const stmts = opts.dbDriver === "pdo_sqlite"
        ? INSTALL_SCHEMA.flatMap(emitCreateTableSqlite)
        : emitFullSchemaPostgres();
      for (const stmt of stmts) await tx.exec(stmt);
      // rate_limit_counter: TS-only installer delta (R5g shape, same DDL
      // on both targets — TEXT/REAL/INTEGER are valid on both).
      await tx.exec(
        "CREATE TABLE IF NOT EXISTS rate_limit_counter (" +
          "policy TEXT NOT NULL, subject_hash TEXT NOT NULL, subject_display TEXT, " +
          "window_start_ms REAL NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, " +
          "tokens REAL NOT NULL DEFAULT 0, updated_ms REAL NOT NULL DEFAULT 0, " +
          "PRIMARY KEY (policy, subject_hash))",
      );
      // Content statements run through the tx handle's rawExec on
      // Postgres (see install-seed.ts: DbPg's translateSql cannot parse
      // multi-row literal INSERTs); still inside this transaction.
      const seeded = await seedContent(tx, contentSql!, nowIso, opts.dbDriver === "pdo_pgsql");
      seededCounts = seeded.counts;
      adminId = await seedAdmin(tx, opts.adminName, opts.adminEmail, passwordHash, opts.adminApiToken, nowIso);
      await setDefaultCurrency(tx, opts.currency);
      await seedInstallNudge(tx, INSTALL_VERSION, nowIso);
    });
    totalSeeded = Object.values(seededCounts).reduce((a, b) => a + b, 0) + 2 + 1;
    seededCurrency = opts.currency;
    completedPhases.push("database");
    }

    // Config. Fresh installs and resume (A) write a fresh config
    // (fresh salt + fresh UUID instance_id, unless --salt given for an
    // import target that must preserve the source salt). Resume (B)
    // and --repair keep the existing config byte-identical — its salt
    // may already protect stored encrypted values.
    if (configKept) {
      // Nothing to write; completedPhases already notes it.
    } else {
      try {
        const salt = opts.salt ?? randomBytes(16).toString("hex");
        const instanceId = randomUUID();
        const { config } = buildInstallConfig({
          systemUrl: opts.systemUrl,
          dbDriver: opts.dbDriver,
          dbPath: sqlitePath ?? undefined,
          dbHost: opts.dbHost,
          dbPort: opts.dbPort ?? undefined,
          dbName: opts.dbName,
          dbUser: opts.dbUser,
          dbPassword: opts.dbPassword,
          reportErrors: opts.reportErrors,
          locale: opts.locale,
          autoDetectLocale: opts.autoDetectLocale,
          trustedProxies: opts.trustedProxies,
          trustedProxyHeaders: opts.trustedProxyHeaders,
          installRoot: opts.installRoot,
          salt,
          instanceId,
        });
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        writeConfigAtomic(config, configPath);
      } catch (e) {
        failPostCommit("config write", completedPhases, e);
      }
      completedPhases.push("config");
    }

    // Finalization complete state (the R5f cron gate opens immediately).
    // Idempotent: an already-complete state is left untouched (its
    // timestamps stand); anything else is (re)written from the
    // existing state so carried fields survive a resume.
    if (isCompleteForCurrentVersion(readState(opts.installRoot))) {
      completedPhases.push("finalization (already complete)");
    } else {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        writeCompleteState(opts.installRoot, readState(opts.installRoot));
      } catch (e) {
        failPostCommit("finalization write", completedPhases, e);
      }
      completedPhases.push("finalization");
    }

    // GeoIP relocation (R5i's note, answered): copy the .mmdb files
    // into the install root so they survive PHP deletion. Warn, never fail.
    // A missing source still only warns — but a mid-copy failure DOES
    // fail the install (E-2): a silently-missing GeoIP DB would break
    // ip_lookup with no signal. The copy itself is idempotent
    // (temp + rename per file; a stray file at the destination path
    // is removed, see copyGeoipFiles), so a re-run resumes it.
    let geoip: { copied: boolean; dir: string | null; reason: string | null } = {
      copied: false, dir: null, reason: null,
    };
    if (!opts.noGeoip) {
      const source = opts.geoipSource ?? defaultGeoipSource();
      const destDir = path.join(dataDir, "geoip");
      if (source === null) {
        geoip = { copied: false, dir: null, reason: "no GeoIP source (vendored vendor/geoip missing; pass --geoip-source)" };
      } else {
        const missing = GEOIP_FILES.filter((f) => {
          try { return !fs.statSync(path.join(source, f)).isFile(); } catch { return true; }
        });
        if (missing.length > 0) {
          geoip = { copied: false, dir: null, reason: `GeoIP files missing in source: ${missing.join(", ")}` };
        } else if (path.resolve(source) === path.resolve(destDir)) {
          geoip = { copied: true, dir: destDir, reason: "source already at destination" };
        } else if (geoipComplete(opts, dataDir)) {
          geoip = { copied: true, dir: destDir, reason: "already copied" };
        } else {
          try {
            copyGeoipFiles(source, destDir);
          } catch (e) {
            failPostCommit("GeoIP copy", completedPhases, e);
          }
          geoip = { copied: true, dir: destDir, reason: null };
        }
      }
    }
    completedPhases.push("GeoIP");

    const report = {
      ok: true,
      driver: opts.dbDriver,
      tables: INSTALL_SCHEMA.length + 1,
      seededRows: totalSeeded,
      adminId,
      configPath,
      dataDir,
      finalizationStatePath: stateFilePath(opts.installRoot),
      normalizedUrl,
      saltPresent: true,
      instanceIdPresent: true,
      rateLimitCounter: true,
      geoip,
      resumed,
      repaired,
      configKept,
      seededCurrency,
    };
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Installed FOSSBilling ${INSTALL_VERSION} (${opts.dbDriver}).`);
      if (resumed) console.log(`  resumed: ${resumed}${repaired ? " (--repair)" : ""}`);
      console.log(`  tables: ${report.tables} (63 installer + rate_limit_counter)`);
      console.log(`  seeded rows: ${report.seededRows} (83 content + 2 admin + 1 nudge)`);
      console.log(`  admin id: ${adminId}`);
      if (seededCurrency !== null && seededCurrency !== opts.currency) {
        console.log(`  currency: kept seeded ${seededCurrency} (re-run requested ${opts.currency})`);
      }
      console.log(`  config: ${configPath}${configKept ? " (kept existing)" : ""}`);
      console.log(`  finalization: complete (${report.finalizationStatePath})`);
      if (geoip.dir) console.log(`  GeoIP: copied to ${geoip.dir} — set FB_GEOIP_DB_DIR=${geoip.dir}`);
      else if (!opts.noGeoip) console.log(`  GeoIP: NOT copied (${geoip.reason}) — ip_lookup needs FB_GEOIP_DB_DIR`);
    }
    return 0;
  } finally {
    await closeDb();
  }
}
