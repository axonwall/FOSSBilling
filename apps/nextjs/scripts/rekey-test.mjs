// FOSSBilling Phase 5 R4d — salt re-key tool tests (import-test
// precedent). Compiles scripts/rekey-salt.ts (+ pg.ts, db.ts,
// crypt.ts) with the repo tsc into a scratch dir, then runs main()
// against DISPOSABLE SQLite files only — NEVER the reference DB
// (the reference DB's encrypted rows must remain untouched).
// Cases: round-trip both columns, wrong-old refusal + byte-identical
// DB, missing env var, old == new, zero-v2 VACUOUS, non-v2 untouched,
// dry-run writes nothing, --help, mid-write failure rollback (via a
// trigger that aborts the 2nd update), no-target refusal, and an
// output-hygiene check (no salts, no plaintext markers in stdout).
// Exit non-zero on any FAIL.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-rekey-test");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const OLD = "rekey-test-old-salt-001";
const NEW = "rekey-test-new-salt-002";
const MARKER = "rekey-test-plaintext-marker";

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
try {
  execSync(
    `npx tsc scripts/rekey-salt.ts src/server/pg.ts src/server/db.ts src/server/crypt.ts ` +
      `--outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
    { cwd: APP, stdio: "pipe" },
  );
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        let t = fs.readFileSync(p, "utf8");
        t = t.replace(/from "(\.[^\"]*)"/g, (m, spec) =>
          /\.(js|mjs|json)$/.test(spec) ? m : `from "${spec}.js"`);
        fs.writeFileSync(p, t);
      }
    }
  };
  walk(TMP);
  const rekey = await import(path.join(TMP, "scripts", "rekey-salt.js"));
  const { encryptV2, decryptV2 } = await import(path.join(TMP, "src", "server", "crypt.js"));
  const { DatabaseSync } = await import("node:sqlite");

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "rekey-test-"));
  const mkdb = (name) => {
    const file = path.join(tmpdir, name);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE extension_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT, extension VARCHAR(255),
      meta_key VARCHAR(255), meta_value CLOB,
      created_at DATETIME, updated_at DATETIME)`);
    db.exec(`CREATE TABLE email_template (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_code VARCHAR(255),
      vars CLOB)`);
    db.close();
    return file;
  };
  const dump = (file) => {
    const db = new DatabaseSync(file);
    const meta = db.prepare("SELECT id, extension, meta_key, meta_value FROM extension_meta ORDER BY id").all();
    const tpl = db.prepare("SELECT id, action_code, vars FROM email_template ORDER BY id").all();
    db.close();
    return { meta, tpl };
  };
  const seed = (file, metaRows, tplRows) => {
    // Craft encrypted rows with OLD salt (crypt reads FB_INFO_SALT).
    process.env.FB_INFO_SALT = OLD;
    const db = new DatabaseSync(file);
    for (const [ext, key, plain] of metaRows) {
      const val = plain === null ? null : encryptV2(JSON.stringify(plain));
      db.prepare("INSERT INTO extension_meta (extension, meta_key, meta_value) VALUES (?, ?, ?)")
        .run(ext, key, val);
    }
    for (const [code, plain] of tplRows) {
      const val = plain === null ? null : encryptV2(JSON.stringify(plain));
      db.prepare("INSERT INTO email_template (action_code, vars) VALUES (?, ?)").run(code, val);
    }
    db.close();
    delete process.env.FB_INFO_SALT;
  };
  const decryptAll = (file, salt) => {
    process.env.FB_INFO_SALT = salt;
    const d = dump(file);
    const out = {
      meta: d.meta.map((r) => (r.meta_value ? decryptV2(r.meta_value) : null)),
      tpl: d.tpl.map((r) => (r.vars ? decryptV2(r.vars) : null)),
    };
    delete process.env.FB_INFO_SALT;
    return out;
  };
  // Capture main()'s console output (counts + statuses only).
  const capture = async (fn) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { const code = await fn(); return { code, out: lines.join("\n") }; }
    finally { console.log = orig; }
  };
  const runTool = async (file, extraArgv = []) => {
    process.env.FB_REKEY_OLD_SALT = OLD;
    process.env.FB_REKEY_NEW_SALT = NEW;
    if (file) process.env.FB_DATABASE_PATH = file;
    else delete process.env.FB_DATABASE_PATH;
    delete process.env.FB_DATABASE_URL;
    return capture(() => rekey.main(extraArgv));
  };
  const clearEnv = () => {
    for (const k of ["FB_REKEY_OLD_SALT", "FB_REKEY_NEW_SALT", "FB_DATABASE_PATH", "FB_DATABASE_URL", "FB_INFO_SALT", "FB_CALLBACK_SALT"]) delete process.env[k];
  };

  // R1: round-trip both columns, multiple rows, nested JSON.
  const f1 = mkdb("r1.sqlite");
  seed(f1,
    [["mod_support", "config", { ext: "mod_support", nested: { n: 3, ok: true }, tags: ["a", "b"], [MARKER]: 1 }],
     ["mod_x", "config", { ext: "mod_x", num: 2.5 }]],
    [["welcome", { name: "World", list: [1, 2] }]]);
  // A non-v2 row in each column must survive untouched.
  {
    const db = new DatabaseSync(f1);
    db.prepare("INSERT INTO extension_meta (extension, meta_key, meta_value) VALUES ('mod_plain', 'config', '{\"plain\":true}')").run();
    db.prepare("INSERT INTO email_template (action_code, vars) VALUES ('plain', '{\"plain\":true}')").run();
    db.close();
  }
  const before1 = dump(f1);
  const r1 = await runTool(f1);
  eq("R1 exit 0", r1.code, 0);
  ok("R1 status VERIFIED", r1.out.includes("status=VERIFIED"), r1.out);
  ok("R1 output has no salts", !r1.out.includes(OLD) && !r1.out.includes(NEW));
  ok("R1 output has no plaintext marker", !r1.out.includes(MARKER));
  const after1 = decryptAll(f1, NEW);
  eq("R1 meta round-trips under NEW", after1.meta.slice(0, 2).map((s) => JSON.parse(s)),
    [{ ext: "mod_support", nested: { n: 3, ok: true }, tags: ["a", "b"], [MARKER]: 1 },
     { ext: "mod_x", num: 2.5 }]);
  eq("R1 template round-trips under NEW", after1.tpl.slice(0, 1).map((s) => JSON.parse(s)),
    [{ name: "World", list: [1, 2] }]);
  const dump1 = dump(f1);
  eq("R1 non-v2 meta untouched", dump1.meta[2].meta_value, '{"plain":true}');
  eq("R1 non-v2 template untouched", dump1.tpl[1].vars, '{"plain":true}');
  ok("R1 all values now v2:", dump1.meta.slice(0, 2).every((r) => r.meta_value.startsWith("v2:")));
  // Old salt must no longer recover the original plaintexts (wrong-key
  // CBC output is garbage; assert non-recovery, not null, since a
  // garbage block could theoretically pass the plausibility check).
  const oldDec = decryptAll(f1, OLD);
  ok("R1 old salt does not recover originals",
    oldDec.meta[0] !== JSON.stringify({ ext: "mod_support", nested: { n: 3, ok: true }, tags: ["a", "b"], [MARKER]: 1 }) &&
    oldDec.meta[1] !== JSON.stringify({ ext: "mod_x", num: 2.5 }));
  clearEnv();

  // R2: wrong old salt -> refusal + byte-identical DB.
  const f2 = mkdb("r2.sqlite");
  seed(f2, [["mod_support", "config", { ext: "mod_support", v: 1 }]], []);
  const before2 = dump(f2);
  process.env.FB_REKEY_OLD_SALT = "definitely-wrong-salt";
  process.env.FB_REKEY_NEW_SALT = NEW;
  process.env.FB_DATABASE_PATH = f2;
  delete process.env.FB_DATABASE_URL;
  const r2 = await capture(() => rekey.main([]));
  eq("R2 exit 1", r2.code, 1);
  ok("R2 status REFUSED", r2.out.includes("status=REFUSED"), r2.out);
  eq("R2 DB byte-identical", dump(f2), before2);
  clearEnv();

  // R3: missing env var -> refusal naming the var.
  const f3 = mkdb("r3.sqlite");
  seed(f3, [["mod_support", "config", { ext: "mod_support" }]], []);
  process.env.FB_REKEY_OLD_SALT = OLD;
  delete process.env.FB_REKEY_NEW_SALT;
  process.env.FB_DATABASE_PATH = f3;
  const r3 = await capture(() => rekey.main([]));
  eq("R3 exit 1", r3.code, 1);
  ok("R3 names the var", r3.out.includes("FB_REKEY_NEW_SALT"), r3.out);
  clearEnv();

  // R4: old == new -> refusal.
  process.env.FB_REKEY_OLD_SALT = OLD;
  process.env.FB_REKEY_NEW_SALT = OLD;
  process.env.FB_DATABASE_PATH = f3;
  const r4b = await capture(() => rekey.main([]));
  eq("R4 exit 1", r4b.code, 1);
  ok("R4 identical refusal", r4b.out.includes("identical"), r4b.out);
  clearEnv();

  // R5: zero v2 -> VACUOUS + unchanged.
  const f5 = mkdb("r5.sqlite");
  {
    const db = new DatabaseSync(f5);
    db.prepare("INSERT INTO extension_meta (extension, meta_key, meta_value) VALUES ('m', 'config', '{\"a\":1}')").run();
    db.close();
  }
  const before5 = dump(f5);
  const r5 = await runTool(f5);
  eq("R5 exit 2", r5.code, 2);
  ok("R5 status VACUOUS", r5.out.includes("status=VACUOUS"), r5.out);
  eq("R5 DB unchanged", dump(f5), before5);
  clearEnv();

  // R6: dry-run writes nothing.
  const f6 = mkdb("r6.sqlite");
  seed(f6, [["mod_support", "config", { ext: "mod_support", v: 9 }]], []);
  const before6 = dump(f6);
  const r6 = await runTool(f6, ["--dry-run"]);
  eq("R6 exit 0", r6.code, 0);
  ok("R6 status DRY_RUN", r6.out.includes("status=DRY_RUN"), r6.out);
  eq("R6 DB unchanged", dump(f6), before6);
  clearEnv();

  // R7: --help exit 0.
  const r7 = await capture(() => rekey.main(["--help"]));
  eq("R7 exit 0", r7.code, 0);
  ok("R7 usage printed", r7.out.includes("Usage:"), r7.out);

  // R8: mid-write failure -> throw + full rollback (trigger aborts
  // the 2nd update; the 1st update must roll back with it).
  const f8 = mkdb("r8.sqlite");
  seed(f8,
    [["mod_a", "config", { ext: "mod_a" }], ["mod_b", "config", { ext: "mod_b" }]],
    []);
  const ids8 = dump(f8).meta.map((r) => r.id);
  {
    const db = new DatabaseSync(f8);
    db.exec(`CREATE TRIGGER fail2 BEFORE UPDATE ON extension_meta WHEN NEW.id = ${ids8[1]} ` +
      `BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    db.close();
  }
  const before8 = dump(f8);
  process.env.FB_REKEY_OLD_SALT = OLD;
  process.env.FB_REKEY_NEW_SALT = NEW;
  process.env.FB_DATABASE_PATH = f8;
  let threw8 = false;
  try { await rekey.main([]); } catch { threw8 = true; }
  ok("R8 mid-write failure propagates", threw8);
  eq("R8 DB fully rolled back", dump(f8), before8);
  clearEnv();

  // R9: no target env -> refusal.
  delete process.env.FB_DATABASE_PATH;
  delete process.env.FB_DATABASE_URL;
  process.env.FB_REKEY_OLD_SALT = OLD;
  process.env.FB_REKEY_NEW_SALT = NEW;
  const r9 = await capture(() => rekey.main([]));
  eq("R9 exit 1", r9.code, 1);
  ok("R9 no-target message", r9.out.includes("no target database"), r9.out);
  clearEnv();

  fs.rmSync(tmpdir, { recursive: true, force: true });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nrekey-test: ${pass} passed, ${fail} failed`);
if (fail) { console.log("failures:", failures.join(", ")); process.exitCode = 1; }
