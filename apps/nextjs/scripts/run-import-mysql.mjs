// FOSSBilling Phase 5 R3b — importer launcher.
// Compiles scripts/import-mysql.ts (+ its repo imports pg.ts, db.ts,
// crypt.ts) with the repo tsc into a scratch dir inside apps/nextjs (so
// `pg`/`mysql2` resolve from node_modules), then runs main() with the
// process argv. The scratch dir is removed in `finally`; pools and the
// MySQL connection are closed by main()'s own finally.
// Usage: node scripts/run-import-mysql.mjs [--dry-run] [--help]
// Env: FB_MYSQL_URL, FB_DATABASE_URL, FB_INFO_SALT (see import-mysql.ts).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-import");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let code = 1;
try {
  execSync(
    `npx tsc scripts/import-mysql.ts src/server/pg.ts src/server/db.ts src/server/crypt.ts ` +
      `--outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
    { cwd: APP, stdio: "pipe" },
  );
  // Node ESM needs explicit extensions on relative imports. tsc mirrors
  // the source tree under TMP (scripts/import-mysql.js,
  // src/server/{pg,db,crypt}.js), so append .js to extensionless relative
  // imports in place (bare imports like "pg"/"mysql2" resolve from
  // apps/nextjs/node_modules by walking up from TMP).
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
  const mod = await import(path.join(TMP, "scripts", "import-mysql.js"));
  code = await mod.main(process.argv.slice(2));
} catch (e) {
  console.error(`import runner FAILED: ${e.message}`);
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  code = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code;
