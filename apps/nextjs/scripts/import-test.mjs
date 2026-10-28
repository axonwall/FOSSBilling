// FOSSBilling Phase 5 R3b importer tests.
// Compiles scripts/import-mysql.ts (+ pg.ts, db.ts, crypt.ts) with the repo
// tsc into a scratch dir inside apps/nextjs (so `pg`/`pg-mem` resolve),
// then runs: (A) exact-decimal helpers, (B) static spec checks
// (TABLE_ORDER coverage, mysql2 config flags), (C) full pipeline
// fake-source -> DbPg(pg-mem) incl. money totals + session skip +
// encrypted-verbatim, (D) refuse-on-mismatch (money + count), (E) fresh
// rule (seed allowance pass / over-allowance + business-row refusal),
// (F) decryptability sample both directions + vacuous + non-v2, (G)
// dry-run writes nothing, (H) unknown source / missing target table
// refusals, (I) sequence-resync warning path, (J) CLI wiring (--help,
// missing env), (K) mock-mysql2 reader SQL, (L) mapValueForInsert rules.
// Exit non-zero on any FAIL. pg-mem limits are documented, not hidden:
// it does not roll back (R3a §D), so refusal tests assert the throw +
// message, never a rollback; bytea round-trip through pg-mem is attempted
// and, if pg-mem rejects it, covered at unit level instead (see L).
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-import-test");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
async function throws(name, fn, needle = "") {
  try { await fn(); ok(name, false, "(did not throw)"); }
  catch (e) { ok(name, !needle || String(e.message).includes(needle), `threw: ${e.message}`); }
}
function skipIt(name, reason) { skip += 1; console.log(`SKIP ${name} (${reason})`); }

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
try {
  execSync(
    `npx tsc scripts/import-mysql.ts src/server/pg.ts src/server/db.ts src/server/crypt.ts ` +
      `--outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
    { cwd: APP, stdio: "pipe" },
  );
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        let t = fs.readFileSync(p, "utf8");
        t = t.replace(/from "(\.[^"]*)"/g, (m, spec) =>
          /\.(js|mjs|json)$/.test(spec) ? m : `from "${spec}.js"`);
        fs.writeFileSync(p, t);
      }
    }
  };
  walk(TMP);
  const imp = await import(path.join(TMP, "scripts", "import-mysql.js"));
  const { DbPg } = await import(path.join(TMP, "src", "server", "pg.js"));
  const { encryptV2 } = await import(path.join(TMP, "src", "server", "crypt.js"));
  const { newDb } = await import("pg-mem");

  const {
    normalizeDecimal, addDecimal, mulDecimal, sumDecimals,
    mysqlConnectionConfig, TABLE_ORDER, SEED_ALLOWANCE, MONEY_TOTALS,
    ImportRefusal, MysqlSource, mapValueForInsert,
    resolveCopyOrder, checkFresh, checkEncryptedSample, sumMoneySpec,
    copyTable, verifyTable, assertVerified, runPipeline, formatReport,
  } = imp;

  // ---------- A. exact decimals ----------
  eq("A1 normalize 10.50", normalizeDecimal("10.50"), "10.5");
  eq("A2 normalize -0.00", normalizeDecimal("-0.00"), "0");
  eq("A3 normalize null", normalizeDecimal(null), "0");
  eq("A4 normalize 0.000", normalizeDecimal("0.000"), "0");
  eq("A5 add 0.1+0.2 exact", addDecimal("0.1", "0.2"), "0.3");
  eq("A6 add negatives", addDecimal("-5.50", "5.50"), "0");
  eq("A7 mul price*qty", mulDecimal("50.00", 2), "100");
  eq("A8 mul decimals", mulDecimal("19.99", "3"), "59.97");
  eq("A9 sum skips null", sumDecimals(["10.00", null, "2.50", undefined, ""]), "12.5");
  eq("A10 sum empty", sumDecimals([]), "0");

  // ---------- B. static spec ----------
  const colTypes = JSON.parse(fs.readFileSync(
    path.join(APP, "..", "..", "docs", "nextjs-strangler", "phase5", "postgres-column-types.json"), "utf8"));
  const entityTables = Object.keys(colTypes).sort();
  eq("B1 TABLE_ORDER covers all 66 entity tables exactly",
    [...TABLE_ORDER].sort(), entityTables);
  const cfg = mysqlConnectionConfig("mysql://u:p@h/db");
  ok("B2 mysql flags lossless+TZ-safe",
    cfg.supportBigNumbers === true && cfg.bigNumberStrings === true &&
    cfg.dateStrings === true && cfg.multipleStatements === false,
    JSON.stringify(cfg));
  ok("B3 seed allowance: setting 35 (34 content + 1 nudge)", SEED_ALLOWANCE.setting === 35);
  ok("B4 seed allowance: admin 1, member 1", SEED_ALLOWANCE.admin === 1 && SEED_ALLOWANCE.admin_group_member === 1);
  ok("B5 money tables present", ["invoice", "invoice_item", "client_balance", "transaction", "client_order"].every((t) => t in MONEY_TOTALS));
  ok("B6 money excludes rates/ids",
    !("currency" in MONEY_TOTALS) && !("tax" in MONEY_TOTALS) &&
    !Object.values(MONEY_TOTALS).flat().some((s) => s.label === "currency_rate" || s.label === "external_price_id"));

  // ---------- Fake source + pg-mem target helpers ----------
  const SALT_A = "test-salt-A";
  const SALT_B = "test-salt-B";
  process.env.FB_INFO_SALT = SALT_A;

  class FakeSource {
    constructor(tables) { this.tables = tables; } // {name, columns, rows}
    byName(name) { return this.tables.find((t) => t.name === name) ?? { name, columns: [], rows: [] }; }
    async listTables() {
      return this.tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => ({ name: c, dataType: "varchar", columnType: "varchar(255)" })),
      }));
    }
    async count(table) { return this.byName(table).rows.length; }
    async readPage(table, columns, afterId, limit) {
      return this.byName(table).rows
        .filter((r) => Number(r.id) > afterId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map((r) => { const o = {}; for (const c of columns) o[c] = r[c] ?? null; return o; });
    }
    async countEncrypted(table, column) {
      return this.byName(table).rows.filter((r) => typeof r[column] === "string" && r[column].startsWith("v2:")).length;
    }
    async sampleEncrypted(table, column, limit) {
      return this.byName(table).rows
        .filter((r) => typeof r[column] === "string" && r[column].startsWith("v2:"))
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map((r) => r[column]);
    }
    async countNonEncrypted(table, column) {
      return this.byName(table).rows.filter((r) => r[column] != null && !(typeof r[column] === "string" && r[column].startsWith("v2:"))).length;
    }
    async close() {}
  }

  function makeMem(tables) {
    // tables: [{name, ddl}] — minimal pg columns for the fake rows.
    const mem = newDb();
    const { Pool: MemPool } = mem.adapters.createPg();
    const pool = new MemPool();
    return { mem, pool };
  }
  async function createTables(pool, ddls) {
    for (const ddl of ddls) await pool.query(ddl);
  }
  function targetOf(pool) {
    return {
      db: new DbPg(pool),
      query: async (text, values) => (await pool.query(text, values)).rows,
      close: async () => { await pool.end(); },
    };
  }

  const encMeta = encryptV2(JSON.stringify({ key: "secret" }));
  const encVars = encryptV2(JSON.stringify({ a: 1 }));
  if (!encMeta || !encVars) throw new Error("test setup: encryptV2 returned null (salt missing?)");

  function baseTables() {
    return [
      { name: "currency", columns: ["id", "code", "rate", "is_default", "is_rate_manual", "created_at", "updated_at"],
        rows: [
          { id: 1, code: "USD", rate: "1", is_default: 1, is_rate_manual: 0, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: 2, code: "EUR", rate: "0.9", is_default: 0, is_rate_manual: 1, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
        ] },
      { name: "client", columns: ["id", "email", "first_name", "last_name", "created_at", "updated_at"],
        rows: [
          { id: 1, email: "a@example.com", first_name: "A", last_name: "One", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: 2, email: "b@example.com", first_name: "B", last_name: "Two", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
        ] },
      { name: "client_order", columns: ["id", "client_id", "price", "discount", "created_at", "updated_at"],
        rows: [{ id: 1, client_id: 1, price: "100.00", discount: "10.00", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" }] },
      { name: "invoice", columns: ["id", "client_id", "base_income", "base_refund", "credit", "refund", "created_at", "updated_at"],
        rows: [{ id: 1, client_id: 1, base_income: "90.00", base_refund: "0.00", credit: "5.00", refund: "0.00", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" }] },
      { name: "invoice_item", columns: ["id", "invoice_id", "price", "quantity", "created_at", "updated_at"],
        rows: [
          { id: 1, invoice_id: 1, price: "50.00", quantity: 2, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: 2, invoice_id: 1, price: "10.00", quantity: 1, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
        ] },
      { name: "transaction", columns: ["id", "invoice_id", "amount", "created_at", "updated_at"],
        rows: [{ id: 1, invoice_id: 1, amount: "90.00", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" }] },
      { name: "client_balance", columns: ["id", "client_id", "amount", "created_at", "updated_at"],
        rows: [{ id: 1, client_id: 1, amount: "5.00", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" }] },
      { name: "extension_meta", columns: ["id", "extension", "meta_key", "meta_value", "created_at", "updated_at"],
        rows: [
          { id: 1, extension: "mod_test", meta_key: "config", meta_value: encMeta, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: 2, extension: "mod_test", meta_key: "plain", meta_value: "plain-config", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
        ] },
      { name: "email_template", columns: ["id", "action_code", "vars", "created_at", "updated_at"],
        rows: [
          { id: 1, action_code: "mod_invoice_created", vars: encVars, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: 2, action_code: "mod_invoice_paid", vars: null, created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: 3, action_code: "mod_client_created", vars: '{"b":2}', created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
        ] },
      { name: "session", columns: ["id", "content", "created_at", "updated_at"],
        rows: [
          { id: "sess1", content: "blob1", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
          { id: "sess2", content: "blob2", created_at: "2026-10-28 12:00:00", updated_at: "2026-10-28 12:00:00" },
        ] },
    ];
  }
  const DDLS = [
    `CREATE TABLE "currency" (id BIGINT PRIMARY KEY, code TEXT, rate NUMERIC, is_default BOOLEAN, is_rate_manual BOOLEAN, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "client" (id BIGINT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "client_order" (id BIGINT PRIMARY KEY, client_id BIGINT, price NUMERIC, discount NUMERIC, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "invoice" (id BIGINT PRIMARY KEY, client_id BIGINT, base_income NUMERIC, base_refund NUMERIC, credit NUMERIC, refund NUMERIC, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "invoice_item" (id BIGINT PRIMARY KEY, invoice_id BIGINT, price NUMERIC, quantity BIGINT, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "transaction" (id BIGINT PRIMARY KEY, invoice_id BIGINT, amount NUMERIC, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "client_balance" (id BIGINT PRIMARY KEY, client_id BIGINT, amount NUMERIC, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "extension_meta" (id BIGINT PRIMARY KEY, extension TEXT, meta_key TEXT, meta_value TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "email_template" (id BIGINT PRIMARY KEY, action_code TEXT, vars TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)`,
    `CREATE TABLE "session" (id TEXT PRIMARY KEY, content TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)`,
  ];

  // ---------- C. full pipeline ----------
  {
    const { pool } = makeMem();
    await createTables(pool, DDLS);
    const target = targetOf(pool);
    const report = await runPipeline({
      source: new FakeSource(baseTables()),
      target,
      options: { dryRun: false, saltPresent: true, skipSequenceResync: false },
    });
    ok("C1 pipeline verified", report.verified === true);
    const byTable = new Map(report.tables.map((t) => [t.table, t]));
    eq("C2 invoice_item price sum", byTable.get("invoice_item").money.find((m) => m.label === "price"), { label: "price", source: "60", target: "60", match: true });
    eq("C3 invoice_item price_x_quantity", byTable.get("invoice_item").money.find((m) => m.label === "price_x_quantity"), { label: "price_x_quantity", source: "110", target: "110", match: true });
    eq("C4 invoice base_income", byTable.get("invoice").money.find((m) => m.label === "base_income"), { label: "base_income", source: "90", target: "90", match: true });
    const skip = report.skipped.find((s) => s.table === "session");
    ok("C5 session skipped by policy with source count", !!skip && skip.sourceRows === 2, JSON.stringify(skip));
    const sessRows = await pool.query(`SELECT COUNT(*) AS n FROM "session"`);
    eq("C6 session target stays empty", Number(sessRows.rows[0].n), 0);
    const metaRows = await pool.query(`SELECT meta_value FROM "extension_meta" ORDER BY id`);
    eq("C7 encrypted meta copied verbatim", metaRows.rows.map((r) => r.meta_value), [encMeta, "plain-config"]);
    const encRep = report.encrypted.find((e) => e.table === "extension_meta");
    ok("C8 extension_meta sample PASS", encRep.status === "PASS" && encRep.v2Rows === 1 && encRep.sampled === 1 && encRep.nonV2Rows === 1, JSON.stringify(encRep));
    const tplRep = report.encrypted.find((e) => e.table === "email_template");
    ok("C9 email_template sample PASS + nonV2 counted", tplRep.status === "PASS" && tplRep.v2Rows === 1 && tplRep.nonV2Rows === 1, JSON.stringify(tplRep));
    ok("C10 sequence resync warned (pg-mem limit, import still verified)",
      report.warnings.some((w) => w.includes("sequence resync")), JSON.stringify(report.warnings));
    await target.close();
  }

  // ---------- D. refuse-on-mismatch ----------
  {
    const { pool } = makeMem();
    await createTables(pool, DDLS);
    const target = targetOf(pool);
    const source = new FakeSource(baseTables());
    await runPipeline({ source, target, options: { dryRun: false, saltPresent: true, skipSequenceResync: true } });
    // Corrupt a money value, then verify -> must refuse naming table+figure.
    await pool.query(`UPDATE "invoice_item" SET price = 999.99 WHERE id = 1`);
    const tableDef = { name: "invoice_item", columns: ["id", "invoice_id", "price", "quantity", "created_at", "updated_at"].map((c) => ({ name: c, dataType: "varchar", columnType: "varchar(255)" })) };
    const rep = await verifyTable(source, target, tableDef);
    await throws("D1 money mismatch refuses naming table+figure",
      async () => assertVerified(rep), "invoice_item");
    ok("D1b money figure named", rep.money.some((m) => !m.match && m.label === "price"), JSON.stringify(rep.money));
    // Count mismatch: delete a row, verify -> refuse.
    await pool.query(`DELETE FROM "invoice_item" WHERE id = 2`);
    const rep2 = await verifyTable(source, target, tableDef);
    await throws("D2 count mismatch refuses", async () => assertVerified(rep2), "row count differs");
    await target.close();
  }

  // ---------- E. fresh rule ----------
  {
    const { pool } = makeMem();
    await createTables(pool, DDLS);
    const target = targetOf(pool);
    // Empty target passes (only tables that exist in this pg-mem target).
    const fresh0 = await checkFresh(target, [{ name: "currency", columns: [] }, { name: "invoice", columns: [] }]);
    ok("E1 empty target is fresh", fresh0.every((f) => f.targetRows === 0));
    // Seed-exact target passes: admin_group at allowance 3.
    await pool.query(`CREATE TABLE "admin_group" (id BIGINT PRIMARY KEY)`);
    await pool.query(`INSERT INTO "admin_group" (id) VALUES (1), (2), (3)`);
    const fresh1 = await checkFresh(target, [{ name: "admin_group", columns: [] }]);
    eq("E2 seed-exact admin_group passes", fresh1[0].targetRows, 3);
    // Over allowance refuses.
    await pool.query(`INSERT INTO "admin_group" (id) VALUES (4)`);
    await throws("E3 over-allowance refuses", async () => checkFresh(target, [{ name: "admin_group", columns: [] }]), "not fresh");
    // Business row in a zero-allowance table refuses.
    await pool.query(`INSERT INTO "invoice" (id, client_id, base_income, base_refund, credit, refund, created_at, updated_at) VALUES (9, 1, 1, 0, 0, 0, '2026-10-28 12:00:00', '2026-10-28 12:00:00')`);
    await throws("E4 business row refuses", async () => checkFresh(target, [{ name: "invoice", columns: [] }]), "not fresh");
    await target.close();
  }

  // ---------- F. decrypt sample directions ----------
  {
    const source = new FakeSource(baseTables());
    const passRep = await checkEncryptedSample(source, true);
    ok("F1 right salt passes", passRep.every((e) => e.status === "PASS"));
    process.env.FB_INFO_SALT = SALT_B;
    await throws("F2 wrong salt refuses", async () => checkEncryptedSample(source, true), "does not decrypt");
    process.env.FB_INFO_SALT = SALT_A;
    // No encrypted rows -> VACUOUS, explicitly not a pass.
    const noEnc = new FakeSource(baseTables().map((t) =>
      t.name === "extension_meta" || t.name === "email_template"
        ? { ...t, rows: t.rows.map((r) => ({ ...r, meta_value: r.meta_value?.startsWith?.("v2:") ? "plain" : r.meta_value, vars: r.vars?.startsWith?.("v2:") ? "plain" : r.vars })) }
        : t));
    const vacRep = await checkEncryptedSample(noEnc, true);
    ok("F3 zero v2 rows is VACUOUS not PASS", vacRep.every((e) => e.status === "VACUOUS"), JSON.stringify(vacRep));
    // No salt + v2 rows -> refuse.
    await throws("F4 missing salt with v2 rows refuses", async () => checkEncryptedSample(source, false), "no salt");
  }

  // ---------- G. dry-run writes nothing ----------
  {
    const { pool } = makeMem();
    await createTables(pool, DDLS);
    const target = targetOf(pool);
    const before = {};
    for (const t of ["currency", "invoice", "invoice_item"]) {
      before[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
    }
    const report = await runPipeline({
      source: new FakeSource(baseTables()),
      target,
      options: { dryRun: true, saltPresent: true },
    });
    const after = {};
    for (const t of ["currency", "invoice", "invoice_item"]) {
      after[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
    }
    eq("G1 dry-run target counts unchanged", after, before);
    ok("G2 dry-run mode + unverified flag", report.mode === "dry-run" && report.verified === false);
    const rendered = formatReport(report);
    ok("G3 dry-run money rendered as planned", rendered.includes("(planned)"), rendered.split("\n").find((l) => l.includes("invoice_item")) ?? "");
    await target.close();
  }

  // ---------- H. unknown / missing tables ----------
  {
    const { pool } = makeMem();
    await createTables(pool, DDLS);
    const target = targetOf(pool);
    const withUnknown = new FakeSource([...baseTables(), { name: "custom_thing", columns: ["id"], rows: [{ id: 1 }] }]);
    await throws("H1 unknown source table refuses", async () => runPipeline({
      source: withUnknown, target, options: { dryRun: true, saltPresent: true },
    }), "unknown to this importer");
    // Missing target table: source has currency but target lacks invoice.
    const { pool: pool2 } = makeMem();
    await createTables(pool2, DDLS.filter((d) => !d.includes('"invoice"')));
    const target2 = targetOf(pool2);
    await throws("H2 missing target table refuses naming it", async () => runPipeline({
      source: new FakeSource(baseTables()), target: target2, options: { dryRun: true, saltPresent: true },
    }), "missing table");
    await target.close();
    await target2.close();
  }

  // ---------- I. sequence resync warning path is covered by C10 ----------

  // ---------- K. mock-mysql2 reader SQL ----------
  {
    const seen = [];
    const fakeConn = {
      query: async (sql, params) => {
        seen.push({ sql, params });
        if (sql.includes("information_schema")) {
          return [[
            { t: "invoice", c: "id", d: "bigint", ct: "bigint(20)" },
            { t: "invoice", c: "base_income", d: "decimal", ct: "decimal(10,2)" },
          ]];
        }
        if (sql.includes("COUNT(*)")) return [[{ n: 3 }]];
        if (sql.includes("LIMIT")) return [[{ id: 1 }, { id: 2 }]];
        return [[]];
      },
      end: async () => {},
    };
    const src = new MysqlSource("mysql://u:p@h/db");
    src.conn = fakeConn;
    const tables = await src.listTables();
    eq("K1 listTables parses information_schema", tables, [{ name: "invoice", columns: [
      { name: "id", dataType: "bigint", columnType: "bigint(20)" },
      { name: "base_income", dataType: "decimal", columnType: "decimal(10,2)" },
    ] }]);
    ok("K2 listTables SQL hits information_schema", seen[0].sql.includes("information_schema.COLUMNS"));
    eq("K3 count", await src.count("invoice"), 3);
    const page = await src.readPage("invoice", ["id", "base_income"], 0, 1000);
    eq("K4 readPage rows", page, [{ id: 1 }, { id: 2 }]);
    ok("K5 readPage SQL pages by id", seen[seen.length - 1].sql.includes("WHERE id > ?") && seen[seen.length - 1].sql.includes("ORDER BY id LIMIT ?"));
  }

  // ---------- L. mapValueForInsert ----------
  {
    eq("L1 null passes", mapValueForInsert("invoice", "credit", null), null);
    eq("L2 string passes", mapValueForInsert("invoice", "status", "paid"), "paid");
    eq("L3 object stringified (MySQL JSON col)", mapValueForInsert("admin_group", "permissions", { a: 1 }), '{"a":1}');
    const buf = Buffer.from("x");
    eq("L4 Buffer passes for bytea col", mapValueForInsert("email_queue", "attachment_content", buf), buf);
    try {
      mapValueForInsert("invoice", "notes", buf);
      ok("L5 Buffer for non-bytea refuses", false, "(did not throw)");
    } catch (e) {
      ok("L5 Buffer for non-bytea refuses", String(e.message).includes("not a bytea column"), e.message);
    }
    // Bytea round-trip through pg-mem, attempted; pg-mem may reject bytea.
    try {
      const { pool } = makeMem();
      await pool.query(`CREATE TABLE "email_queue" (id BIGINT PRIMARY KEY, attachment_content BYTEA)`);
      const db = new DbPg(pool);
      await db.prepare(`INSERT INTO "email_queue" (id, attachment_content) VALUES (?, ?)`).run(1, Buffer.from("hello", "utf8"));
      const rows = await pool.query(`SELECT attachment_content FROM "email_queue"`);
      ok("L6 bytea round-trip via DbPg/pg-mem", Buffer.isBuffer(rows.rows[0].attachment_content), JSON.stringify(rows.rows[0]));
      await pool.end();
    } catch (e) {
      skipIt("L6 bytea round-trip via DbPg/pg-mem", `pg-mem: ${e.message}`);
    }
  }

  // ---------- J. CLI wiring (spawns the real runner) ----------
  {
    const help = spawnSync("node", ["scripts/run-import-mysql.mjs", "--help"], { cwd: APP, encoding: "utf8", timeout: 120000 });
    ok("J1 --help exits 0 with usage", help.status === 0 && help.stdout.includes("FB_MYSQL_URL"), `status=${help.status} out=${help.stdout.slice(0, 200)} err=${help.stderr.slice(0, 200)}`);
    const missing = spawnSync("node", ["scripts/run-import-mysql.mjs"], {
      cwd: APP, encoding: "utf8", timeout: 120000,
      env: { ...process.env, FB_MYSQL_URL: "", FB_DATABASE_URL: "" },
    });
    ok("J2 missing env exits non-zero naming the var",
      missing.status !== 0 && (missing.stderr.includes("FB_MYSQL_URL") || missing.stdout.includes("FB_MYSQL_URL")),
      `status=${missing.status} err=${missing.stderr.slice(0, 200)}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fail > 0) { console.log(`FAILURES: ${failures.join(", ")}`); process.exitCode = 1; }
} catch (e) {
  console.error(`import-test harness FAILED: ${e.stack ?? e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
