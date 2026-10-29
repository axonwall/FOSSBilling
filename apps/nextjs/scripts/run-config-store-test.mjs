// FOSSBilling Phase 5 R5a — config-store test launcher (rekey-test
// precedent). Compiles scripts/config-store-test.ts (+ its repo
// imports config-store.ts, dispatch.ts) with the repo tsc into a
// scratch dir inside apps/nextjs (so node: builtins resolve), then
// runs main(). The scratch dir is removed in `finally`.
// Usage: node scripts/run-config-store-test.mjs
// Env: PHP_BIN (default: the sandbox static-php-cli bulk build).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-configstore");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let code = 1;
try {
  execSync(
    `npx tsc scripts/config-store-test.ts src/server/config-store.ts src/server/dispatch.ts ` +
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
  const mod = await import(path.join(TMP, "scripts", "config-store-test.js"));
  code = mod.main();
} catch (e) {
  console.error(`config-store-test runner FAILED: ${e.message}`);
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  code = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(code);
