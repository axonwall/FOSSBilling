// FOSSBilling Phase 5 R4d — salt re-key launcher (importer precedent).
// Compiles scripts/rekey-salt.ts (+ its repo imports pg.ts, db.ts,
// crypt.ts) with the repo tsc into a scratch dir inside apps/nextjs (so
// `pg` resolves from node_modules), then runs main() with the process
// argv. The scratch dir is removed in `finally`; the pool/connection
// are closed by main()'s own finally.
// Usage: node scripts/run-rekey-salt.mjs [--dry-run] [--help]
// Env: FB_REKEY_OLD_SALT, FB_REKEY_NEW_SALT, FB_DATABASE_URL or
//   FB_DATABASE_PATH (see rekey-salt.ts + findings-r4d.md).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-rekey");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let code = 1;
try {
  execSync(
    `npx tsc scripts/rekey-salt.ts src/server/pg.ts src/server/db.ts src/server/crypt.ts ` +
      `--outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
    { cwd: APP, stdio: "pipe" },
  );
  // Node ESM needs explicit extensions on relative imports. tsc mirrors
  // the source tree under TMP (scripts/rekey-salt.js,
  // src/server/{pg,db,crypt}.js), so append .js to extensionless relative
  // imports in place (bare imports like "pg" resolve from
  // apps/nextjs/node_modules by walking up from TMP).
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
  const mod = await import(path.join(TMP, "scripts", "rekey-salt.js"));
  code = await mod.main(process.argv.slice(2));
} catch (e) {
  console.error(`rekey runner FAILED: ${e.message}`);
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  code = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code;
