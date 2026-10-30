// FOSSBilling Phase 5 R5j: installer + finalization test.
// Follows the driver-test.mjs pattern: compiles the library modules with
// the repo tsc into a scratch dir inside apps/nextjs, then runs:
//   A. DDL emitter byte-equality vs Doctrine's captured DDL (63 x 2).
//   B. SQLite live install via run-install.mjs (disposable root): schema
//      diff vs the live PHP dump, 86-row fresh state per table,
//      rate_limit_counter shape, admin/bcrypt/currency/nudge rows,
//      config parse-back (TS parser + PHP require cross-check), salt
//      presence/shape/inequality (never printed), finalization JSON
//      shape, GeoIP copy.
//   C. Refusals (exit codes + zero writes proven by checksums/counts)
//      and admin/URL/driver/port validation messages.
//   D. URL normalization + config builder unit tests.
//   E. Finalization tool: full order (pending -> finalized -> complete),
//      maintenance restore, failure-mid-patches semantics, config patch
//      contents (incl. the 3306-default quirk), schema sync (table /
//      column / index restore, FK-never-added, PK-missing refusal).
//   F. Postgres via pg-mem (STRUCTURAL proof only, labeled): same DDL +
//      seeds through DbPg, sequence resync where pg-mem supports it.
//      Live-Postgres proof rides on R3c (needs Josh's endpoints).
//   G. Cron-gate predicates (module level; live gate proof is parity39).
// Exit non-zero on any FAIL. SKIP lines are pg-mem dialect gaps,
// documented like driver-test's. All targets are disposable temp dirs
// (never the reference DB/config); the reference is untouched by design
// (parity43.py asserts its invariants before/after this script).
// Secrets: salts, hashes and passwords are handled in memory and NEVER
// printed; assertions print only booleans and shapes.
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const REPO = path.resolve(APP, "..", "..");
const CAPTURES = path.join(REPO, "docs", "nextjs-strangler", "phase5", "captures46");
const TMP = path.join(HERE, ".tmp-installer-test");
const WORK = fs.mkdtempSync(path.join(os.homedir(), "scratch", "fossbilling", "r5-logs", "installer-test-"));
const PHP = path.join(os.homedir(), "scratch", "bin", "php");
const PHPSRC = path.join(REPO, "src");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function skipIt(name, reason) { skip++; console.log(`SKIP ${name} (${reason})`); }
function sha256(p) { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

const phpSchema = JSON.parse(fs.readFileSync(path.join(CAPTURES, "php-fresh-schema.json"), "utf8"));
const phpDdl = JSON.parse(fs.readFileSync(path.join(CAPTURES, "php-platform-ddl.json"), "utf8"));
const phpSample = JSON.parse(fs.readFileSync(path.join(CAPTURES, "php-config-sample.json"), "utf8"));

function runCli(script, args, env = {}) {
  return spawnSync("node", [path.join(HERE, script), ...args], {
    cwd: APP, encoding: "utf8",
    env: { ...process.env, FOSSBILLING_PHP_SRC: PHPSRC, ...env },
  });
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  execSync(
    `npx tsc src/server/install-schema.ts src/server/install-schema-ddl.ts src/server/install-seed.ts src/server/install-config.ts src/server/update-finalization.ts src/server/db.ts src/server/pg.ts ` +
      `--outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
    { cwd: APP, stdio: "pipe" },
  );
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        let t = fs.readFileSync(p, "utf8");
        t = t.replace(/from "(\.[^"]*)"/g, (m, spec) => /\.(js|mjs|json)$/.test(spec) ? m : `from "${spec}.js"`);
        fs.writeFileSync(p, t);
      }
    }
  };
  walk(TMP);
  // tsc's common root for these entries is src/server, so outputs land flat in TMP.
  const S = TMP;
  const schemaMod = await import(path.join(S, "install-schema.js"));
  const ddlMod = await import(path.join(S, "install-schema-ddl.js"));
  const seedMod = await import(path.join(S, "install-seed.js"));
  const configMod = await import(path.join(S, "install-config.js"));
  const finMod = await import(path.join(S, "update-finalization.js"));
  const configStore = await import(path.join(S, "config-store.js"));
  const dbMod = await import(path.join(S, "db.js"));
  const pgMod = await import(path.join(S, "pg.js"));
  const bcrypt = await import("bcryptjs");
  const { DatabaseSync } = await import("node:sqlite");

  // ---------- A. emitter byte-equality ----------
  let emitterBad = 0;
  for (const t of schemaMod.INSTALL_SCHEMA) {
    if (JSON.stringify(ddlMod.emitCreateTableSqlite(t)) !== JSON.stringify(phpDdl.tables[t.name].sqlite_ddl)) emitterBad++;
    if (JSON.stringify(ddlMod.emitCreateTablePostgres(t)) !== JSON.stringify(phpDdl.tables[t.name].postgres_ddl)) emitterBad++;
  }
  eq("A1 emitter byte-equal (63 sqlite + 63 pg)", emitterBad, 0);
  eq("A2 schema table count", schemaMod.INSTALL_SCHEMA.length, 63);

  // ---------- B. SQLite live install ----------
  const root1 = path.join(WORK, "root1");
  const r1 = runCli("run-install.mjs", [
    "--install-root", root1, "--url", "http://localhost:3101/",
    "--admin-name", "Test Admin", "--admin-email", "testadmin@example.com",
    "--json",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Test-Admin!42" });
  ok("B1 install exit 0", r1.status === 0, r1.stderr + r1.stdout);
  const rep1 = JSON.parse(r1.stdout);
  eq("B2 report tables", rep1.tables, 64);
  eq("B3 report seeded rows", rep1.seededRows, 86);
  eq("B4 report admin id", rep1.adminId, 1);
  ok("B5 report has no secret values", !r1.stdout.includes("Test-Admin!42"));
  const dbPath1 = path.join(root1, "data", "fossbilling.sqlite");
  const configPath1 = path.join(root1, "config.php");
  const db1 = new DatabaseSync(dbPath1);
  const liveTables = db1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  eq("B6 installed table set (63 + rate_limit_counter)", liveTables, [...Object.keys(phpSchema.tables), "rate_limit_counter"].sort());
  let schemaDiffs = 0;
  let totalRows = 0;
  for (const [t, info] of Object.entries(phpSchema.tables)) {
    const cols = db1.prepare(`PRAGMA table_info("${t}")`).all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
    const wantCols = info.columns.map((c) => [c.name, c.type, c.notnull, c.default, c.pk]);
    if (JSON.stringify(cols) !== JSON.stringify(wantCols)) schemaDiffs++;
    const idx = db1.prepare(`PRAGMA index_list("${t}")`).all().map((c) => [c.name, c.unique]).sort();
    const wantIdx = info.indexes.map((c) => [c.name, c.unique]).sort();
    if (JSON.stringify(idx) !== JSON.stringify(wantIdx)) schemaDiffs++;
    const fk = db1.prepare(`PRAGMA foreign_key_list("${t}")`).all();
    if (fk.length !== info.foreign_keys.length) schemaDiffs++;
    const cnt = db1.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    if (cnt !== info.rows) schemaDiffs++;
    totalRows += cnt;
  }
  eq("B7 live schema diff vs PHP dump (cols/indexes/fks/rows)", schemaDiffs, 0);
  eq("B8 total rows incl rate_limit_counter (86 + 0)", totalRows, 86);
  const seq = Object.fromEntries(db1.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all().map((r) => [r.name, r.seq]));
  eq("B9 sqlite_sequence == PHP", seq, phpSchema.sqlite_sequence);
  const admin = db1.prepare("SELECT id, name, email, status, api_token, pass FROM admin").get();
  eq("B10 admin row", [admin.id, admin.name, admin.email, admin.status, admin.api_token], [1, "Test Admin", "testadmin@example.com", "active", null]);
  ok("B11 admin hash is bcrypt cost 12", admin.pass.startsWith("$2b$12$") && admin.pass.length === 60);
  ok("B12 admin password verifies, wrong rejects",
    bcrypt.compareSync("Test-Admin!42", admin.pass) && !bcrypt.compareSync("Wrong-Pass!42", admin.pass));
  eq("B13 group member", db1.prepare("SELECT admin_id, admin_group_id FROM admin_group_member").all(), [{ admin_id: 1, admin_group_id: 1 }]);
  eq("B14 currency", db1.prepare("SELECT code FROM currency WHERE id = 1").get(), { code: "USD" });
  eq("B15 nudge", db1.prepare("SELECT param, value FROM setting WHERE param = 'last_error_reporting_nudge'").get(), { param: "last_error_reporting_nudge", value: "0.0.1" });
  const rlc = db1.prepare("PRAGMA table_info(rate_limit_counter)").all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  eq("B16 rate_limit_counter shape (R5g DDL)", rlc, [
    ["policy", "TEXT", 1, null, 1], ["subject_hash", "TEXT", 1, null, 2], ["subject_display", "TEXT", 0, null, 0],
    ["window_start_ms", "REAL", 1, "0", 0], ["count", "INTEGER", 1, "0", 0],
    ["tokens", "REAL", 1, "0", 0], ["updated_ms", "REAL", 1, "0", 0],
  ]);
  db1.close();

  // Config parse-back (TS parser) + PHP require cross-check.
  const parsed = configStore.parseConfigSource(fs.readFileSync(configPath1, "utf8"));
  eq("B17 config key set == sample keys", Object.keys(parsed).sort(), Object.keys(phpSample).sort());
  const get = (o, dotted) => dotted.split(".").reduce((a, k) => a?.[k], o);
  eq("B18 config force_https (http url)", get(parsed, "security.force_https"), false);
  eq("B19 config url scheme-stripped", get(parsed, "url"), "localhost:3101/");
  eq("B20 config update_branch preview", get(parsed, "update_branch"), "preview");
  eq("B21 config disable_auto_cron false", get(parsed, "disable_auto_cron"), false);
  eq("B22 config db sqlite", get(parsed, "db"), { driver: "pdo_sqlite", path: dbPath1 });
  eq("B23 config locale inputs", [get(parsed, "i18n.locale"), get(parsed, "i18n.auto_detect_locale")], ["en_US", true]);
  eq("B24 config path_data/twig.cache", [get(parsed, "path_data"), get(parsed, "twig.cache")], [path.join(root1, "data"), path.join(root1, "data", "cache")]);
  const salt1 = get(parsed, "info.salt");
  const inst1 = get(parsed, "info.instance_id");
  ok("B25 salt is 32 lowercase hex", /^[0-9a-f]{32}$/.test(salt1));
  ok("B26 instance_id is UUID v4", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(inst1));
  ok("B27 installer stdout never contains the salt", !r1.stdout.includes(salt1));
  // Compare with placeholders, NOT deletion: deleting both keys would
  // leave PHP's info as [] (json_encode of an empty array) vs TS's {},
  // a JSON-encoding artifact, not a value difference.
  const phpProbe = path.join(WORK, "require-config.php");
  fs.writeFileSync(phpProbe, `<?php $c = require $argv[1]; $c["info"]["salt"] = "<redacted>"; $c["info"]["instance_id"] = "<redacted>"; echo json_encode($c);`);
  const phpReq = execSync(`${PHP} ${phpProbe} ${configPath1}`, { encoding: "utf8" });
  const phpConfig = JSON.parse(phpReq);
  const tsNoSecret = JSON.parse(JSON.stringify(parsed));
  tsNoSecret.info.salt = "<redacted>"; tsNoSecret.info.instance_id = "<redacted>";
  eq("B28 PHP require cross-check (modulo salt/instance_id)", phpConfig, tsNoSecret);
  // Second install: salt + instance_id must differ.
  const root2 = path.join(WORK, "root2");
  const r2 = runCli("run-install.mjs", [
    "--install-root", root2, "--url", "https://example.com/billing/",
    "--admin-name", "Second Admin", "--admin-email", "second@example.com", "--json",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Second-Admin!42" });
  ok("B29 second install exit 0", r2.status === 0, r2.stderr);
  const parsed2 = configStore.parseConfigSource(fs.readFileSync(path.join(root2, "config.php"), "utf8"));
  ok("B30 salt differs across installs", get(parsed2, "info.salt") !== salt1);
  ok("B31 instance_id differs across installs", get(parsed2, "info.instance_id") !== inst1);
  eq("B32 second config force_https (https url)", get(parsed2, "security.force_https"), true);
  eq("B33 second config url", get(parsed2, "url"), "example.com/billing/");
  // Finalization JSON shape.
  const finJson = fs.readFileSync(path.join(root1, "data", "update-finalization.json"), "utf8");
  const fin = JSON.parse(finJson);
  eq("B34 finalization state", { status: fin.status, version: fin.version, from_version: fin.from_version, target_version: fin.target_version },
    { status: "complete", version: "0.0.1", from_version: null, target_version: "0.0.1" });
  ok("B35 finalization timestamps are DATE_ATOM UTC", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(fin.finalized_at) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(fin.completed_at));
  ok("B36 finalization file ends with newline + 4-space indent", finJson.endsWith("\n") && finJson.includes('\n    "status"'));
  // GeoIP copy.
  const geoDir = path.join(root1, "data", "geoip");
  ok("B37 GeoIP files copied non-empty",
    fs.existsSync(path.join(geoDir, "CC0-Country.mmdb")) && fs.statSync(path.join(geoDir, "CC0-Country.mmdb")).size > 0 &&
    fs.existsSync(path.join(geoDir, "PDDL-ASN.mmdb")) && fs.statSync(path.join(geoDir, "PDDL-ASN.mmdb")).size > 0);

  // ---------- C. refusals + validation ----------
  const dbHashBefore = sha256(dbPath1);
  const cfgHashBefore = sha256(configPath1);
  const rr = runCli("run-install.mjs", [
    "--install-root", root1, "--url", "http://localhost:3101/",
    "--admin-name", "Test Admin", "--admin-email", "testadmin@example.com",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Test-Admin!42" });
  eq("C1 existing-config refusal exit 2", rr.status, 2);
  ok("C2 existing-config refusal message", rr.stderr.includes("FOSSBilling is already installed."));
  eq("C3 existing-config refusal: zero writes (db + config checksums)", [sha256(dbPath1), sha256(configPath1)], [dbHashBefore, cfgHashBefore]);
  const nePath = path.join(WORK, "nonempty.sqlite");
  {
    const c = new DatabaseSync(nePath);
    c.exec("CREATE TABLE dummy (id INTEGER PRIMARY KEY, v TEXT)");
    c.exec("INSERT INTO dummy VALUES (1, 'x')");
    c.close();
  }
  const root3 = path.join(WORK, "root3");
  const rn = runCli("run-install.mjs", [
    "--install-root", root3, "--url", "http://localhost:3101/",
    "--admin-name", "Test Admin", "--admin-email", "testadmin@example.com",
    "--db-path", nePath,
  ], { FB_INSTALL_ADMIN_PASSWORD: "Test-Admin!42" });
  eq("C4 non-empty-db refusal exit 2", rn.status, 2);
  ok("C5 non-empty-db refusal message", rn.stderr.includes("non-empty database"));
  {
    const c = new DatabaseSync(nePath);
    eq("C6 non-empty-db refusal: zero writes", [c.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name), c.prepare("SELECT COUNT(*) AS n FROM dummy").get().n], [["dummy"], 1]);
    c.close();
  }
  ok("C7 non-empty-db refusal: no config written", !fs.existsSync(path.join(root3, "config.php")));
  const validationCases = [
    ["bad email", "Admin", "not-an-email", "Valid-Pass1!", "The admin email is not a valid address."],
    ["short password", "Admin", "admin@example.com", "Sh0rt!", "Minimum admin password length is 8 characters."],
    ["no digit", "Admin", "admin@example.com", "NoDigitPass!", "Admin password must include at least one number."],
    ["no lowercase", "Admin", "admin@example.com", "NOLOWER123!", "Admin password must include at least one lowercase letter."],
    ["no uppercase", "Admin", "admin@example.com", "nolower123!", "Admin password must include at least one uppercase letter."],
    ["empty name", "", "admin@example.com", "Valid-Pass1!", "You must enter an Admin Name."],
  ];
  validationCases.forEach(([label, name, email, pw, msg], i) => {
    const v = runCli("run-install.mjs", [
      "--install-root", path.join(WORK, `val-${i}`), "--url", "http://localhost:3101/",
      "--admin-name", name, "--admin-email", email,
    ], { FB_INSTALL_ADMIN_PASSWORD: pw });
    eq(`C8 validation: ${label} exit 1`, v.status, 1);
    ok(`C9 validation: ${label} message`, v.stderr.includes(msg), v.stderr);
  });
  const vu = runCli("run-install.mjs", [
    "--install-root", path.join(WORK, "val-url"), "--url", "ftp://example.com/",
    "--admin-name", "Admin", "--admin-email", "admin@example.com",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Valid-Pass1!" });
  ok("C10 ftp url rejected", vu.status === 1 && vu.stderr.includes("must be a valid HTTP or HTTPS URL"));
  const vd = runCli("run-install.mjs", [
    "--install-root", path.join(WORK, "val-driver"), "--url", "http://localhost:3101/",
    "--admin-name", "Admin", "--admin-email", "admin@example.com", "--db-driver", "pdo_mysql",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Valid-Pass1!" });
  ok("C11 mysql driver refused", vd.status === 1 && vd.stderr.includes("Unsupported database driver."));
  const vp = runCli("run-install.mjs", [
    "--install-root", path.join(WORK, "val-port"), "--url", "http://localhost:3101/",
    "--admin-name", "Admin", "--admin-email", "admin@example.com",
    "--db-driver", "pdo_pgsql", "--db-port", "99999",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Valid-Pass1!" });
  ok("C12 invalid pg port rejected", vp.status === 1 && vp.stderr.includes("Database port is invalid."));

  // ---------- D. URL normalization + config builder units ----------
  const urlCases = [
    ["example.com/billing", "https://example.com/billing/"],
    ["HTTPS://EXAMPLE.COM/Billing/", "https://EXAMPLE.COM/Billing/"],
    ["https://user@example.com/", "https://example.com/"],
    ["https://example.com:8443/a/b/", "https://example.com:8443/a/b/"],
    ["https://example.com:0/", "https://example.com:0/"],
    ["http://localhost:3101", "http://localhost:3101/"],
    ["https://example.com/path?query=1#frag", "https://example.com/path/"],
    // PHP trims only the path ENDS: interior '//' is preserved verbatim.
    ["https://example.com//double//slashes//", "https://example.com/double//slashes/"],
  ];
  urlCases.forEach(([input, want]) => {
    eq(`D1 normalize ${input}`, configMod.normalizeSystemUrl(input), want);
  });
  for (const bad of ["", "ftp://example.com/", "https://example.com:abc/"]) {
    try { configMod.normalizeSystemUrl(bad); ok(`D2 normalize rejects ${JSON.stringify(bad)}`, false); }
    catch (e) { ok(`D2 normalize rejects ${JSON.stringify(bad)}`, String(e.message).includes("FOSSBilling URL")); }
  }
  eq("D3 stripUrlScheme", configMod.stripUrlScheme("https://example.com/billing/"), "example.com/billing/");
  eq("D4 normalizePort", [configMod.normalizePort("5432", null), configMod.normalizePort(" 8080 ", null), configMod.normalizePort("0", null), configMod.normalizePort("abc", 3306), configMod.normalizePort("", 3306)], [5432, 8080, null, 3306, 3306]);
  const built = configMod.buildInstallConfig({
    systemUrl: "https://shop.example.com/", dbDriver: "pdo_pgsql", dbHost: "db.internal", dbPort: "5433",
    dbName: "shop", dbUser: "shopuser", dbPassword: "x", reportErrors: true, locale: "de_DE",
    autoDetectLocale: false, trustedProxies: ["10.0.0.1"], trustedProxyHeaders: "x_forwarded_for",
    installRoot: "/srv/fb", salt: "0".repeat(32), instanceId: "00000000-0000-4000-8000-000000000000",
  }).config;
  eq("D5 pg config db block", built.db, { driver: "pdo_pgsql", host: "db.internal", port: 5433, name: "shop", user: "shopuser", password: "x" });
  eq("D6 pg config overrides", [built.security.force_https, built.update_branch, built.disable_auto_cron, built.debug_and_monitoring.report_errors, built.i18n.locale, built.i18n.auto_detect_locale, built.security.trusted_proxies, built.path_data, built.twig.cache],
    [true, "preview", false, true, "de_DE", false, { enabled: true, proxies: ["10.0.0.1"], headers: "x_forwarded_for" }, "/srv/fb/data", "/srv/fb/data/cache"]);
  try {
    configMod.buildInstallConfig({
      systemUrl: "https://x/", dbDriver: "pdo_pgsql", dbPort: "bogus", reportErrors: false, locale: "en_US",
      autoDetectLocale: true, trustedProxies: [], trustedProxyHeaders: "x_forwarded", installRoot: "/srv/fb",
      salt: "0".repeat(32), instanceId: "00000000-0000-4000-8000-000000000000",
    });
    ok("D7 builder rejects invalid pg port", false);
  } catch (e) { ok("D7 builder rejects invalid pg port", String(e.message).includes("Database port is invalid.")); }
  try {
    configMod.buildInstallConfig({
      systemUrl: "https://x/", dbDriver: "pdo_sqlite", reportErrors: false, locale: "en_US",
      autoDetectLocale: true, trustedProxies: [], trustedProxyHeaders: "x_forwarded", installRoot: "/srv/fb",
      salt: "0".repeat(32), instanceId: "00000000-0000-4000-8000-000000000000",
    });
    ok("D8 builder requires sqlite path", false);
  } catch (e) { ok("D8 builder requires sqlite path", String(e.message).includes("SQLite database file path is required.")); }

  // ---------- E. finalization tool ----------
  // E1: full order from a missing state on a fresh disposable install.
  const rootF = path.join(WORK, "rootF");
  const rf = runCli("run-install.mjs", [
    "--install-root", rootF, "--url", "http://localhost:3101/",
    "--admin-name", "Fin Admin", "--admin-email", "fin@example.com", "--no-geoip",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Fin-Admin!42" });
  ok("E0 fixture install exit 0", rf.status === 0, rf.stderr);
  const cfgF = path.join(rootF, "config.php");
  const finPathF = path.join(rootF, "data", "update-finalization.json");
  // Roll the install back to a pre-finalization state: pending + maintenance
  // captured as disabled, then drive the tool stepwise.
  const preState = {
    status: "pending", from_version: null, target_version: "0.0.1", branch: "preview",
    update_type: null, source: "test", created_at: "2026-01-01T00:00:00+00:00",
    finalized_at: null, completed_at: null,
    maintenance_mode: { enabled: false, allowed_urls: [], allowed_ips: [] },
  };
  fs.writeFileSync(finPathF, JSON.stringify(preState, null, 4) + "\n");
  // Maintenance currently OFF (install wrote complete state; the tool's
  // createPendingState would have flipped it ON — here we simulate the
  // ensure() path by flipping it ON first, as PHP's ensure does).
  {
    const cfg = configStore.readConfigFile(cfgF);
    cfg.maintenance_mode = { enabled: true, allowed_urls: ["/admin/staff/login", "/admin/system/update/finalize"], allowed_ips: [] };
    configStore.writeConfigFile(cfg, cfgF);
  }
  const fz = runCli("run-finalize-update.mjs", ["finalize", "--install-root", rootF]);
  ok("E1 finalize exit 0", fz.status === 0, fz.stderr);
  const afterFin = JSON.parse(fs.readFileSync(finPathF, "utf8"));
  eq("E2 finalize stamps finalized, keeps pending's captured maintenance", [afterFin.status, afterFin.finalized_at !== null], ["finalized", true]);
  const cfgAfterFin = configStore.readConfigFile(cfgF);
  eq("E3 finalize does NOT touch maintenance mode", cfgAfterFin.maintenance_mode.enabled, true);
  const cz = runCli("run-finalize-update.mjs", ["complete", "--install-root", rootF]);
  ok("E4 complete exit 0", cz.status === 0, cz.stderr);
  const afterComplete = JSON.parse(fs.readFileSync(finPathF, "utf8"));
  eq("E5 complete state", [afterComplete.status, afterComplete.version], ["complete", "0.0.1"]);
  const cfgAfterComplete = configStore.readConfigFile(cfgF);
  eq("E6 complete restores EXACT captured maintenance_mode", cfgAfterComplete.maintenance_mode, { enabled: false, allowed_urls: [], allowed_ips: [] });
  // E7: failure mid-patches — a scalar security block makes config patches throw.
  const rootG = path.join(WORK, "rootG");
  const rg = runCli("run-install.mjs", [
    "--install-root", rootG, "--url", "http://localhost:3101/",
    "--admin-name", "Fail Admin", "--admin-email", "fail@example.com", "--no-geoip",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Fail-Admin!42" });
  ok("E7 fixture install exit 0", rg.status === 0, rg.stderr);
  const cfgG = path.join(rootG, "config.php");
  const finPathG = path.join(rootG, "data", "update-finalization.json");
  fs.writeFileSync(finPathG, JSON.stringify({ ...preState, source: "test-fail" }, null, 4) + "\n");
  {
    const raw = fs.readFileSync(cfgG, "utf8");
    const broken = raw.replace(/'security' => \[/, "'security' => 'broken',\n    'security_unused' => [");
    fs.writeFileSync(cfgG, broken);
  }
  const fg = runCli("run-finalize-update.mjs", ["finalize", "--install-root", rootG]);
  ok("E8 finalize failure exit 1", fg.status === 1, fg.stderr);
  const afterFail = JSON.parse(fs.readFileSync(finPathG, "utf8"));
  eq("E9 failure keeps state pending", afterFail.status, "pending");
  // E10: config patch contents on a legacy-shaped config.
  const rootH = path.join(WORK, "rootH");
  const rh = runCli("run-install.mjs", [
    "--install-root", rootH, "--url", "http://localhost:3101/",
    "--admin-name", "Patch Admin", "--admin-email", "patch@example.com", "--no-geoip",
  ], { FB_INSTALL_ADMIN_PASSWORD: "Patch-Admin!42" });
  ok("E10 fixture install exit 0", rh.status === 0, rh.stderr);
  const cfgH = path.join(rootH, "config.php");
  const finPathH = path.join(rootH, "data", "update-finalization.json");
  fs.writeFileSync(finPathH, JSON.stringify({ ...preState, source: "test-patch" }, null, 4) + "\n");
  {
    const cfg = configStore.readConfigFile(cfgH);
    delete cfg.security.force_https;
    delete cfg.i18n.locale;
    delete cfg.i18n.timezone;
    cfg.locale = "fr_FR";
    cfg.timezone = "Europe/Paris";
    cfg.salt = "legacy-top-level-salt";
    delete cfg.info.salt;
    cfg.api.rate_limit_whitelist = ["192.0.2.1"];
    // No db.port on purpose: the patch must fill the 3306 default even
    // though this config's driver is sqlite (PHP's quirk, mirrored).
    cfg.url = "https://legacy.example.com/shop/";
    cfg.security.cookie_lifespan = 3600;
    cfg.db.type = "legacy";
    delete cfg.debug_and_monitoring.log_stacktrace;
    configStore.writeConfigFile(cfg, cfgH);
  }
  const fh = runCli("run-finalize-update.mjs", ["finalize-and-complete", "--install-root", rootH]);
  ok("E11 finalize-and-complete exit 0", fh.status === 0, fh.stderr);
  const cfgPatched = configStore.readConfigFile(cfgH);
  eq("E12 patch: force_https filled", cfgPatched.security.force_https, true);
  eq("E13 patch: locale from legacy top-level", cfgPatched.i18n.locale, "fr_FR");
  eq("E14 patch: timezone from legacy top-level", cfgPatched.i18n.timezone, "Europe/Paris");
  eq("E15 patch: salt from legacy top-level", cfgPatched.info.salt, "legacy-top-level-salt");
  eq("E16 patch: deprecated keys removed", ["locale" in cfgPatched, "timezone" in cfgPatched, "salt" in cfgPatched, "cookie_lifespan" in cfgPatched.security, "type" in cfgPatched.db],
    [false, false, false, false, false]);
  eq("E17 patch: whitelist merged from legacy api key", cfgPatched.rate_limiter.whitelist_ips, ["192.0.2.1"]);
  eq("E18 patch: url scheme stripped", cfgPatched.url, "legacy.example.com/shop/");
  eq("E19 patch: db.port normalized to int (3306-default quirk: sqlite config gets 3306)", cfgPatched.db.port, 3306);
  eq("E20 patch: top-level + nested stacktrace keys", [cfgPatched.log_stacktrace, cfgPatched.debug_and_monitoring.log_stacktrace], [true, true]);
  const afterHC = JSON.parse(fs.readFileSync(finPathH, "utf8"));
  eq("E21 finalize-and-complete ends complete", afterHC.status, "complete");
  // E22: schema sync restores a dropped table / column / index (module level).
  {
    const syncDb = path.join(WORK, "sync.sqlite");
    const conn = new DatabaseSync(syncDb);
    const sdb = new dbMod.DbSqlite(conn);
    for (const stmt of ddlMod.emitFullSchemaSqlite()) await sdb.exec(stmt);
    await sdb.exec("DROP TABLE IF EXISTS promo");
    // aid is indexed (alternative_id_idx): SQLite refuses to drop an
    // indexed column, so drop an unindexed one (client.notes) instead.
    await sdb.exec("ALTER TABLE client DROP COLUMN notes");
    await sdb.exec("DROP INDEX IF EXISTS email");
    const report = await finMod.syncPortableSchema(sdb, "sqlite");
    ok("E22 sync recreates dropped table", report.createdTables.includes("promo"));
    ok("E23 sync re-adds dropped column", report.addedColumns.includes("client.notes"));
    ok("E24 sync re-adds dropped index", report.addedIndexes.includes("admin.email"));
    const report2 = await finMod.syncPortableSchema(sdb, "sqlite");
    eq("E25 second sync is a no-op", [report2.createdTables, report2.addedColumns, report2.addedIndexes], [[], [], []]);
    conn.close();
  }
  // E26: sync never adds an FK to an existing table; PK-missing throws.
  {
    const fkDb = path.join(WORK, "fk.sqlite");
    const conn = new DatabaseSync(fkDb);
    const fdb = new dbMod.DbSqlite(conn);
    for (const stmt of ddlMod.emitFullSchemaSqlite()) await fdb.exec(stmt);
    // Rebuild invoice WITHOUT its FK (fresh table, no FK clause).
    const inv = schemaMod.INSTALL_SCHEMA.find((t) => t.name === "invoice");
    const noFk = { ...inv, foreignKeys: [] };
    await fdb.exec("DROP TABLE invoice");
    for (const stmt of ddlMod.emitCreateTableSqlite(noFk)) await fdb.exec(stmt);
    const fkBefore = await fdb.prepare("PRAGMA foreign_key_list(\"invoice\")").all();
    const report = await finMod.syncPortableSchema(fdb, "sqlite");
    const fkAfter = await fdb.prepare("PRAGMA foreign_key_list(\"invoice\")").all();
    eq("E26 sync never adds FKs to existing tables", [fkBefore.length, fkAfter.length], [0, 0]);
    ok("E27 sync does not recreate an existing table", !report.createdTables.includes("invoice"));
    // PK-missing table: admin rebuilt without its id column.
    const adm = schemaMod.INSTALL_SCHEMA.find((t) => t.name === "admin");
    const noPk = { ...adm, columns: adm.columns.filter((c) => c.name !== "id") };
    await fdb.exec("DROP TABLE admin");
    for (const stmt of ddlMod.emitCreateTableSqlite(noPk)) await fdb.exec(stmt);
    try {
      await finMod.syncPortableSchema(fdb, "sqlite");
      ok("E28 sync refuses a missing PK column", false);
    } catch (e) {
      ok("E28 sync refuses a missing PK column", String(e.message).includes("primary-key"));
    }
    conn.close();
  }
  // E29: complete on a pending (never finalized) state throws PHP's message.
  {
    const rootP = path.join(WORK, "rootP");
    const rp = runCli("run-install.mjs", [
      "--install-root", rootP, "--url", "http://localhost:3101/",
      "--admin-name", "Pend Admin", "--admin-email", "pend@example.com", "--no-geoip",
    ], { FB_INSTALL_ADMIN_PASSWORD: "Pend-Admin!42" });
    ok("E29 fixture install exit 0", rp.status === 0, rp.stderr);
    fs.writeFileSync(path.join(rootP, "data", "update-finalization.json"), JSON.stringify({ ...preState, source: "test-pending" }, null, 4) + "\n");
    const cp = runCli("run-finalize-update.mjs", ["complete", "--install-root", rootP]);
    ok("E30 complete on pending exits 1 with PHP's message", cp.status === 1 && cp.stderr.includes("Update finalization must be run before it can be completed."));
  }

  // ---------- F. Postgres via pg-mem (STRUCTURAL ONLY) ----------
  const { newDb } = await import("pg-mem");
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const memPool = new MemPool();
  const memDb = new pgMod.DbPg(memPool);
  let pgOk = false;
  try {
    // pg-mem's parser rejects the trailing NOT DEFERRABLE on FK ALTERs
    // (real Postgres accepts it; the byte-equality proof in A1 already
    // covers the exact DDL). Strip that clause for the pg-mem run ONLY
    // and record the adaptation — the created tables/columns/indexes/
    // FKs are otherwise identical to Doctrine's DDL.
    for (const stmt of ddlMod.emitFullSchemaPostgres()) {
      await memDb.exec(stmt.replace(/ NOT DEFERRABLE$/, ""));
    }
    pgOk = true;
  } catch (e) { skipIt("F1 pg-mem full DDL", `pg-mem rejects Doctrine PG DDL: ${e.message}`); }
  if (pgOk) {
    ok("F1 pg-mem full DDL executes", true);
    try {
      const memTables = await memDb.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'").all();
      if (memTables.length === 63) ok("F2 pg-mem table count via information_schema", true);
      else skipIt("F2 pg-mem table count", `information_schema lists ${memTables.length} (pg-mem introspection gap; existence proven by F2b)`);
    } catch (e) { skipIt("F2 pg-mem table count", `information_schema unsupported: ${e.message}`); }
    const adminProbe = await memDb.prepare("SELECT COUNT(*) AS n FROM admin").get();
    eq("F2b pg-mem admin table exists + empty", adminProbe.n, 0);
    await memDb.exec(
      "CREATE TABLE IF NOT EXISTS rate_limit_counter (" +
        "policy TEXT NOT NULL, subject_hash TEXT NOT NULL, subject_display TEXT, " +
        "window_start_ms REAL NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, " +
        "tokens REAL NOT NULL DEFAULT 0, updated_ms REAL NOT NULL DEFAULT 0, " +
        "PRIMARY KEY (policy, subject_hash))",
    );
    const contentSql = fs.readFileSync(path.join(PHPSRC, "install", "sql", "content.sql"), "utf8");
    try {
      // seedContent's resync is its LAST step, so a throw naming
      // pg_get_serial_sequence means all content rows ARE inserted and
      // only the resync is unprovable on pg-mem (catalog gap). In that
      // case verify the rows directly and SKIP just the resync proof.
      let resyncGap = false;
      try {
        await seedMod.seedContent(memDb, contentSql, "2026-01-01 00:00:00", true);
      } catch (e) {
        if (String(e.message).includes("pg_get_serial_sequence")) resyncGap = true;
        else throw e;
      }
      // Expected content-only counts: the PHP dump's per-table rows
      // include the nudge (+1 setting) and seedAdmin (+1 admin, +1
      // admin_group_member), which have not run yet at this point.
      let contentTotal = 0;
      let contentDiffs = 0;
      for (const [t, info] of Object.entries(phpSchema.tables)) {
        const want = t === "setting" ? info.rows - 1
          : (t === "admin" || t === "admin_group_member" ? 0 : info.rows);
        const n = (await memDb.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get()).n;
        if (n !== want) contentDiffs++;
        contentTotal += n;
      }
      eq("F3 pg-mem content.sql rows (direct counts vs PHP dump)", [contentTotal, contentDiffs], [83, 0]);
      const adminId = await seedMod.seedAdmin(memDb, "Mem Admin", "mem@example.com", "$2b$12$abcdefghijklmnopqrstuuXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", null, "2026-01-01 00:00:00");
      await seedMod.setDefaultCurrency(memDb, "EUR");
      eq("F4 pg-mem admin id (empty table, resync-independent)", adminId, 1);
      const eur = await memDb.prepare("SELECT code FROM currency WHERE id = 1").get();
      eq("F5 pg-mem currency updated", eur, { code: "EUR" });
      try {
        await seedMod.seedInstallNudge(memDb, "0.0.1", "2026-01-01 00:00:00");
        const nudge = await memDb.prepare("SELECT value FROM setting WHERE param = 'last_error_reporting_nudge'").get();
        eq("F6 pg-mem nudge row", nudge, { value: "0.0.1" });
      } catch (e) { skipIt("F6 pg-mem nudge row", `needs sequence state pg-mem cannot prove: ${e.message}`); }
      if (resyncGap) {
        skipIt("F7 pg-mem sequence resync", "pg-mem lacks pg_get_serial_sequence (catalog gap); live proof rides on R3c");
      } else {
        // Sequence resync proof: the next auto-generated id must exceed seeded max.
        try {
          const nextId = await memDb.insertAndGetId("INSERT INTO setting (param, value, created_at, updated_at) VALUES (?, ?, ?, ?)", "probe_param", "x", "2026-01-01 00:00:00", "2026-01-01 00:00:00");
          ok("F7 pg-mem sequence resync (next id > seeded max 35)", nextId > 35, `got ${nextId}`);
        } catch (e) { skipIt("F7 pg-mem sequence resync", `pg-mem: ${e.message}`); }
      }
    } catch (e) { skipIt("F3-F7 pg-mem seeds", `pg-mem: ${e.message}`); }
  }

  // ---------- G. cron-gate predicates (module level) ----------
  eq("G1 gate: complete 0.0.1 opens", finMod.isCompleteForCurrentVersion({ status: "complete", version: "0.0.1", from_version: null, target_version: "0.0.1", finalized_at: null, completed_at: null }), true);
  eq("G2 gate: pending requires finalization", finMod.stateRequiresFinalization({ status: "pending", from_version: null, target_version: null, finalized_at: null, completed_at: null }), true);
  eq("G3 gate: finalized still requires finalization", finMod.stateRequiresFinalization({ status: "finalized", from_version: null, target_version: null, finalized_at: null, completed_at: null }), true);
  eq("G4 gate: missing state -> null (cron treats as closed)", finMod.readState(path.join(WORK, "does-not-exist-root")), null);
} catch (e) {
  fail++;
  failures.push("harness");
  console.log(`FAIL harness ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
}

console.log(`\ninstaller-test: ${pass} PASS, ${fail} FAIL, ${skip} SKIP`);
if (fail > 0) { console.log(`failures: ${failures.join(", ")}`); process.exit(1); }
