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
//   3. Create the database when missing (Postgres: admin connection to
//      dbname 'postgres', CREATE DATABASE "quoted" silently-if-exists;
//      SQLite: mkdir -p the parent dir). The DB user needs CREATEDB,
//      exactly as PHP requires.
//   4. Create the schema from the TS entity definitions (install-schema
//      + emitters: byte-equal to Doctrine's SchemaInstaller output).
//   5. Replay content.sql + seedAdmin (bcrypt cost 12) +
//      setDefaultCurrency + seedInstallNudge, in one transaction.
//      Fresh-state criterion: 83 + 2 + 1 = 86 rows, everything else empty.
//   6. Write config.php via R5a's proven serializeConfig output
//      (writeInitialConfig: temp + rename, no backup — there is no prior
//      file to back up) with a fresh random salt + fresh UUID instance_id.
//   7. Write the update-finalization complete state (PHP's
//      writeCompleteState shape), so the R5f cron gate opens immediately.
//   8. Copy the GeoIP .mmdb files into <installRoot>/data/geoip (unless
//      --no-geoip) and report the FB_GEOIP_DB_DIR value to set. A missing
//      GeoIP source WARNS, never fails the install (a non-core asset
//      must not fail an install — the .htaccess-fetch lesson, inverted:
//      PHP failed installs on a fetch failure; the TS installer does not).
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
import { hashSync } from "bcryptjs";
import { DbSqlite, type Db } from "../src/server/db";
import { DbPg } from "../src/server/pg";
import {
  buildInstallConfig,
  INSTALL_VERSION,
  normalizePort,
  normalizeSystemUrl,
  writeInitialConfig,
} from "../src/server/install-config";
import {
  emitCreateTablePostgres,
  emitCreateTableSqlite,
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
          "  [--geoip-source DIR | --no-geoip] [--salt HEX] [--json]",
      );
      process.exit(0);
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (["no-auto-detect-locale", "report-errors", "no-geoip", "json"].includes(key)) {
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

function defaultContentSqlPath(): string {
  const phpSrc = process.env["FOSSBILLING_PHP_SRC"];
  if (!phpSrc) {
    fail("content.sql not found: pass --content-sql or set FOSSBILLING_PHP_SRC.");
  }
  return path.join(phpSrc, "install", "sql", "content.sql");
}

function defaultGeoipSource(): string | null {
  const phpSrc = process.env["FOSSBILLING_PHP_SRC"];
  return phpSrc ? path.join(phpSrc, "library", "FOSSBilling", "GeoIP", "Databases") : null;
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

  // 1. Refusal first (PHP's isAlreadyInstalled runs before validation).
  if (fs.existsSync(configPath)) {
    fail("FOSSBilling is already installed.", 2);
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
    const existingTables = await listTables(db, opts.dbDriver === "pdo_sqlite" ? "sqlite" : "postgres");
    if (existingTables.length > 0) {
      fail(
        `Refusing to install into a non-empty database (${existingTables.length} tables already exist).`,
        2,
      );
    }

    // Schema + seeds + admin + currency + nudge, in one transaction.
    const contentSqlPath = opts.contentSql ?? defaultContentSqlPath();
    let contentSql: string;
    try {
      contentSql = fs.readFileSync(contentSqlPath, "utf8");
    } catch {
      fail("Could not read content.sql file");
    }
    const nowIso = formatSeedTimestamp(new Date());
    const passwordHash = hashSync(opts.adminPassword, 12);
    let adminId = 0;
    let seededCounts: Record<string, number> = {};
    await db.withTransaction(async (tx) => {
      const stmts = opts.dbDriver === "pdo_sqlite"
        ? INSTALL_SCHEMA.flatMap(emitCreateTableSqlite)
        : INSTALL_SCHEMA.flatMap(emitCreateTablePostgres);
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
    const totalSeeded = Object.values(seededCounts).reduce((a, b) => a + b, 0) + 2 + 1;

    // Config (fresh salt + fresh UUID instance_id, unless --salt given
    // for an import target that must preserve the source salt).
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
    writeInitialConfig(config, configPath);

    // Finalization complete state (the R5f cron gate opens immediately).
    fs.mkdirSync(dataDir, { recursive: true });
    writeCompleteState(opts.installRoot, null);

    // GeoIP relocation (R5i's note, answered): copy the .mmdb files
    // into the install root so they survive PHP deletion. Warn, never fail.
    let geoip: { copied: boolean; dir: string | null; reason: string | null } = {
      copied: false, dir: null, reason: null,
    };
    if (!opts.noGeoip) {
      const source = opts.geoipSource ?? defaultGeoipSource();
      const destDir = path.join(dataDir, "geoip");
      if (source === null) {
        geoip = { copied: false, dir: null, reason: "no GeoIP source (set FOSSBILLING_PHP_SRC or --geoip-source)" };
      } else {
        const missing = GEOIP_FILES.filter((f) => {
          try { return !fs.statSync(path.join(source, f)).isFile(); } catch { return true; }
        });
        if (missing.length > 0) {
          geoip = { copied: false, dir: null, reason: `GeoIP files missing in source: ${missing.join(", ")}` };
        } else if (path.resolve(source) === path.resolve(destDir)) {
          geoip = { copied: true, dir: destDir, reason: "source already at destination" };
        } else {
          fs.mkdirSync(destDir, { recursive: true });
          for (const f of GEOIP_FILES) fs.copyFileSync(path.join(source, f), path.join(destDir, f));
          geoip = { copied: true, dir: destDir, reason: null };
        }
      }
    }

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
    };
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Installed FOSSBilling ${INSTALL_VERSION} (${opts.dbDriver}).`);
      console.log(`  tables: ${report.tables} (63 installer + rate_limit_counter)`);
      console.log(`  seeded rows: ${report.seededRows} (83 content + 2 admin + 1 nudge)`);
      console.log(`  admin id: ${adminId}`);
      console.log(`  config: ${configPath}`);
      console.log(`  finalization: complete (${report.finalizationStatePath})`);
      if (geoip.dir) console.log(`  GeoIP: copied to ${geoip.dir} — set FB_GEOIP_DB_DIR=${geoip.dir}`);
      else if (!opts.noGeoip) console.log(`  GeoIP: NOT copied (${geoip.reason}) — ip_lookup needs FB_GEOIP_DB_DIR`);
    }
    return 0;
  } finally {
    await closeDb();
  }
}
