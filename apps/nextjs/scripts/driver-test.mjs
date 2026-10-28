// FOSSBilling Phase 5 R3a driver test (draft location; final: apps/nextjs/scripts/driver-test.mjs).
// Compiles pg.ts (+db.ts for the SQLite adapter) with the repo tsc into a
// scratch dir inside apps/nextjs (so `pg`/`pg-mem` resolve from node_modules),
// then runs: (A) translateSql unit tests, (B) normalizePgRow synthetic-field
// tests, (C) DbPg integration against pg-mem's pg-compatible Pool,
// (D) withTransaction control-flow via a recording pool wrapper,
// (E) SQLite-adapter transactions (real node:sqlite semantics).
// If PG_TEST_URL is set, section C also runs against a real pg Pool (R3c reuse).
// Exit non-zero on any FAIL. SKIP lines are pg-mem dialect gaps, documented.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(APP, "scripts", ".tmp-driver-test");

let pass = 0, fail = 0, skip = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function throws(name, fn, needle = "") {
  try { fn(); ok(name, false, "(did not throw)"); }
  catch (e) { ok(name, !needle || String(e.message).includes(needle), `threw: ${e.message}`); }
}
function skipIt(name, reason) { skip += 1; console.log(`SKIP ${name} (${reason})`); }

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
try {
  execSync(`npx tsc src/server/pg.ts src/server/db.ts --outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`, { cwd: APP, stdio: "pipe" });
  // Node ESM needs explicit extensions on relative imports.
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    let t = fs.readFileSync(p, "utf8");
    t = t.replace(/from "\.\/([^"]+)"/g, 'from "./$1.js"');
    fs.writeFileSync(p, t);
  }
  const pg = await import(path.join(TMP, "pg.js"));
  const { translateSql, normalizePgRow, DbPg } = pg;

  // ---------- A. translateSql ----------
  eq("A1 placeholders", translateSql("SELECT * FROM client WHERE id = ? AND name = ?", [3, "x"]).text,
    "SELECT * FROM client WHERE id = $1 AND name = $2");
  eq("A2 ? in string literal untouched",
    translateSql("SELECT * FROM t WHERE a = '?' AND b = ?", [1]).text,
    "SELECT * FROM t WHERE a = '?' AND b = $1");
  throws("A3a count mismatch (too few)", () => translateSql("SELECT ? , ?", [1]), "placeholder");
  throws("A3b count mismatch (too many)", () => translateSql("SELECT ?", [1, 2]), "placeholder");
  eq("A4 LIKE->ILIKE", translateSql("SELECT * FROM client WHERE first_name LIKE ?", ["a%"]).text,
    "SELECT * FROM client WHERE first_name ILIKE $1");
  eq("A4b NOT LIKE->NOT ILIKE", translateSql("SELECT * FROM cart WHERE session_id NOT LIKE ?", ["staff:%"]).text,
    "SELECT * FROM cart WHERE session_id NOT ILIKE $1");
  eq("A5a datetime now", translateSql("SELECT * FROM t WHERE x < datetime('now')", []).text,
    "SELECT * FROM t WHERE x < now()");
  eq("A5b datetime interval",
    translateSql("SELECT * FROM support_ticket st JOIN support_helpdesk sh ON 1=1 WHERE datetime(st.updated_at, '+' || sh.close_after || ' hours') < datetime('now')", []).text,
    "SELECT * FROM support_ticket st JOIN support_helpdesk sh ON 1=1 WHERE (st.updated_at + (sh.close_after || ' hours')::interval) < now()");
  throws("A5c unknown datetime shape", () => translateSql("SELECT datetime(x, 'start of month') FROM t", []), "datetime");
  eq("A6a bool literal single table",
    translateSql("SELECT * FROM currency WHERE is_default = 1", []).text,
    "SELECT * FROM currency WHERE is_default = TRUE");
  eq("A6b bool literal 0",
    translateSql("SELECT * FROM currency WHERE is_default = 0", []).text,
    "SELECT * FROM currency WHERE is_default = FALSE");
  eq("A6c bool literal qualified",
    translateSql("SELECT * FROM currency c WHERE c.is_default = 1", []).text,
    "SELECT * FROM currency c WHERE c.is_default = TRUE");
  eq("A6d bool literal UPDATE SET",
    translateSql("UPDATE currency SET is_default = 1 WHERE id = 2", []).text,
    "UPDATE currency SET is_default = TRUE WHERE id = 2");
  eq("A6e bool literal INSERT VALUES",
    translateSql("INSERT INTO currency (code, is_default) VALUES (?, 1)", ["EUR"]).text,
    "INSERT INTO currency (code, is_default) VALUES ($1, TRUE)");
  eq("A6f non-bool literal untouched",
    translateSql("SELECT * FROM client WHERE id = 1", []).text,
    "SELECT * FROM client WHERE id = 1");
  eq("A7a bool param coercion '1'->true",
    translateSql("SELECT * FROM currency WHERE is_default = ?", ["1"]).values, [true]);
  eq("A7b bool param coercion 0->false",
    translateSql("SELECT * FROM currency WHERE is_default = ?", [0]).values, [false]);
  const by = translateSql("INSERT INTO session (id, content) VALUES (?, ?)", ["abc", "payload"]);
  ok("A8 bytea params are Buffers",
    Buffer.isBuffer(by.values[0]) && Buffer.isBuffer(by.values[1]) &&
    by.values[0].toString("utf8") === "abc" && by.values[1].toString("utf8") === "payload");
  eq("A9 unknown table passes through",
    translateSql("SELECT * FROM mystery WHERE flag = 1 AND x = ?", [5]).text,
    "SELECT * FROM mystery WHERE flag = 1 AND x = $1");

  // ---------- B. normalizePgRow (synthetic pg fields) ----------
  const F = (name, oid) => ({ name, dataTypeID: oid });
  eq("B1 bool true->1", normalizePgRow([F("b", 16)], { b: true }), { b: 1 });
  eq("B2 bool false->0", normalizePgRow([F("b", 16)], { b: false }), { b: 0 });
  eq("B3 int8 string->Number", normalizePgRow([F("n", 20)], { n: "1234567890123" }), { n: 1234567890123 });
  eq("B4 numeric string->Number", normalizePgRow([F("n", 1700)], { n: "12.34" }), { n: 12.34 });
  eq("B5 timestamp Date->string",
    normalizePgRow([F("ts", 1114)], { ts: new Date(Date.UTC(2026, 9, 28, 12, 34, 56)) }),
    { ts: "2026-10-28 12:34:56" });
  eq("B6 date string->YYYY-MM-DD",
    normalizePgRow([F("d", 1082)], { d: "2026-10-28T00:00:00.000Z" }), { d: "2026-10-28" });
  eq("B7 json object->string", normalizePgRow([F("j", 114)], { j: { a: 1 } }), { j: '{"a":1}' });
  eq("B8 jsonb object->string", normalizePgRow([F("j", 3802)], { j: [1, 2] }), { j: "[1,2]" });
  const buf = Buffer.from("abc", "utf8");
  ok("B9 bytea passthrough", normalizePgRow([F("by", 17)], { by: buf }).by === buf);
  eq("B10 null passthrough", normalizePgRow([F("b", 16), F("t", 25)], { b: null, t: null }), { b: null, t: null });
  eq("B11 unknown OID passthrough", normalizePgRow([F("x", 9999)], { x: "v" }), { x: "v" });

  // ---------- C. DbPg via pg-mem ----------
  const { newDb } = await import("pg-mem");
  const mem = newDb();
  const { Pool: MemPool } = mem.adapters.createPg();
  const memPool = new MemPool();
  const db = new DbPg(memPool);
  await db.exec("CREATE TABLE client (id SERIAL PRIMARY KEY, first_name TEXT, email_approved BOOLEAN)");
  const id1 = await db.insertAndGetId("INSERT INTO client (first_name, email_approved) VALUES (?, ?)", "Ada", 1);
  ok("C1 insertAndGetId returns id", id1 === 1, `got ${id1}`);
  const row = await db.prepare("SELECT * FROM client WHERE id = ?").get(id1);
  ok("C2 get by ? placeholder", row && row.first_name === "Ada" && row.id === 1, JSON.stringify(row));
  const upd = await db.prepare("UPDATE client SET first_name = ? WHERE id = ?").run("Grace", id1);
  ok("C3 run changes", upd.changes === 1, JSON.stringify(upd));
  await db.insertAndGetId("INSERT INTO client (first_name, email_approved) VALUES (?, ?)", "ada lovelace", 0);
  await db.insertAndGetId("INSERT INTO client (first_name, email_approved) VALUES (?, ?)", "ADAM", 0);
  try {
    // Case-sensitive LIKE 'ada%' would match only 'ada lovelace' (1);
    // ILIKE must also match 'ADAM' (2). (id1 was renamed to 'Grace' by C3.)
    const hits = await db.prepare("SELECT * FROM client WHERE first_name LIKE ?").all("ada%");
    ok("C4 ILIKE via DbPg (case-insensitive)", hits.length === 2, `got ${hits.length}`);
  } catch (e) { skipIt("C4 ILIKE via DbPg", `pg-mem rejects ILIKE: ${e.message}`); }
  try {
    const lit = await db.prepare("SELECT * FROM client WHERE email_approved = ?").all(1);
    ok("C5 bool param via DbPg", lit.length >= 1, `got ${lit.length}`);
  } catch (e) { skipIt("C5 bool param via DbPg", `pg-mem: ${e.message}`); }
  if (process.env.PG_TEST_URL) {
    const { Pool } = await import("pg");
    const realPool = new Pool({ connectionString: process.env.PG_TEST_URL });
    const rdb = new DbPg(realPool);
    try {
      await rdb.exec("CREATE TEMP TABLE r3a_smoke (id SERIAL PRIMARY KEY, v TEXT)");
      const rid = await rdb.insertAndGetId("INSERT INTO r3a_smoke (v) VALUES (?)", "live");
      ok("C6 live pg insertAndGetId", rid === 1, `got ${rid}`);
    } finally { await realPool.end(); }
  } else {
    skipIt("C6 live pg", "PG_TEST_URL unset (R3c)");
  }

  // ---------- D. withTransaction control flow (recording wrapper) ----------
  const seen = [];
  const recPool = {
    query: (text, values) => { seen.push(typeof text === "string" ? text : text.text); return memPool.query(text, values); },
    connect: async () => {
      const c = await memPool.connect();
      const origQuery = c.query.bind(c);
      return {
        query: (text, values) => { seen.push(typeof text === "string" ? text : text.text); return origQuery(text, values); },
        release: () => { seen.push("RELEASE"); c.release(); },
      };
    },
    end: () => memPool.end(),
  };
  const tdb = new DbPg(recPool);
  seen.length = 0;
  const out = await tdb.withTransaction(async () => "ok");
  ok("D1 commit path returns", out === "ok");
  ok("D2 commit sequence BEGIN..COMMIT..RELEASE",
    seen.join("|") === "BEGIN|COMMIT|RELEASE", seen.join("|"));
  seen.length = 0;
  let threw = false;
  try { await tdb.withTransaction(async () => { throw new Error("boom"); }); }
  catch (e) { threw = e.message === "boom"; }
  ok("D3 rollback path rethrows", threw);
  ok("D4 rollback sequence BEGIN..ROLLBACK..RELEASE",
    seen.join("|") === "BEGIN|ROLLBACK|RELEASE", seen.join("|"));
  await memPool.end();

  // ---------- E. SQLite adapter transactions (real) ----------
  const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "r3a-sqlite-")), "t.sqlite");
  fs.writeFileSync(sqlitePath, ""); // node:sqlite readOnly open cannot create the file
  process.env.FB_DATABASE_PATH = sqlitePath;
  delete process.env.FB_DATABASE_URL;
  const dbMod = await import(path.join(TMP, "db.js"));
  const w = dbMod.getDbWrite();
  await w.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  await w.withTransaction(async (tx) => {
    await tx.prepare("INSERT INTO t (v) VALUES (?)").run("committed");
  });
  const afterCommit = await w.prepare("SELECT COUNT(*) AS c FROM t").get();
  ok("E1 sqlite commit persists", Number(afterCommit.c) === 1, JSON.stringify(afterCommit));
  try {
    await w.withTransaction(async (tx) => {
      await tx.prepare("INSERT INTO t (v) VALUES (?)").run("rolled");
      throw new Error("nope");
    });
  } catch { /* expected */ }
  const afterRollback = await w.prepare("SELECT COUNT(*) AS c FROM t").get();
  ok("E2 sqlite rollback discards", Number(afterRollback.c) === 1, JSON.stringify(afterRollback));
  fs.rmSync(path.dirname(sqlitePath), { recursive: true, force: true });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
if (failures.length) console.log("FAILURES:", failures.join(", "));
process.exit(fail ? 1 : 0);
