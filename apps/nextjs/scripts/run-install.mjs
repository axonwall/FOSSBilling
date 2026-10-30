// FOSSBilling Phase 5 R5j — installer launcher (R3b convention).
// Compiles scripts/install.ts (+ its src/server imports) with the repo
// tsc into a scratch dir inside apps/nextjs (so `pg`/`bcryptjs` resolve
// from node_modules), then runs main() with the process argv. The scratch
// dir is removed in `finally`; pools are closed by main()'s own finally.
// Usage: node scripts/run-install.mjs [installer flags]
// See scripts/install.ts for the flag list and exit codes.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-install");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let code = 1;
try {
  execSync(
    `npx tsc scripts/install.ts --outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
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
  const mod = await import(path.join(TMP, "scripts", "install.js"));
  code = await mod.main(process.argv.slice(2));
} catch (e) {
  console.error(`install runner FAILED: ${e.message}`);
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  code = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exitCode = code;
