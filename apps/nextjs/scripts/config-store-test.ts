/**
 * FOSSBilling Phase 5 R5a — config-store test (script-test precedent:
 * driver-test / import-test / rekey-test). Run via
 * scripts/run-config-store-test.mjs. Operates ONLY on disposable
 * copies + temp files; the reference config.php is read (never
 * written) for the parse test, and every write test points
 * FB_CONFIG_PATH at a scratch copy.
 *
 * Exit 0 only when every check passes.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getConfigProperty,
  parseConfigSource,
  phpBoolCast,
  phpNormalizeBoolean,
  phpStringCast,
  readConfigFile,
  resolveConfigPath,
  serializeConfig,
  setConfigProperty,
  type PhpConfig,
} from "../src/server/config-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name} ${detail}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
// The compiled test runs from scripts/.tmp-configstore/scripts/, so
// the source scripts dir (holding the PHP pretty-printer helper) is
// two levels up from HERE.
const HELPER = path.resolve(HERE, "..", "..", "config-store-php-pretty.php");
const RUNTIME_CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php";

export function main(): number {
  // T1: parse the real runtime config (read-only).
  const runtime = readConfigFile(RUNTIME_CFG);
  check("T1 top-level keys present", "i18n" in runtime && "info" in runtime && "debug_and_monitoring" in runtime);
  check("T1 locale is a string", typeof (runtime["i18n"] as Record<string, unknown>)["locale"] === "string");
  check(
    "T1 report_errors is boolean",
    typeof (runtime["debug_and_monitoring"] as Record<string, unknown>)["report_errors"] === "boolean",
  );
  check("T1 instance_id is a non-empty string", typeof (runtime["info"] as Record<string, unknown>)["instance_id"] === "string");

  // T2: writer byte-equality vs PHP's own pretty-printer.
  const sample: PhpConfig = {
    app: {
      name: "Test's \\ App\nSecond line",
      version: 3,
      ratio: 1.5,
      whole: 1.0,
      big: 1e20,
      enabled: true,
      nothing: null,
      empty_nested: [],
      list: ["a", "b"],
      nested: { deep: { leaf: "x" }, empty_too: [] },
    },
    top_empty: [],
  };
  const tsOut = serializeConfig(sample);
  const phpOut = execSync(
    `${process.env.PHP_BIN ?? "/home/hatch/scratch/bin/php"} ${HELPER}`,
    { input: JSON.stringify(sample), encoding: "utf8" },
  );
  check("T2 writer byte-identical to PHP pretty-printer", tsOut === phpOut, `\nTS:\n${tsOut}\nPHP:\n${phpOut}`);

  // T3: PHP can include the TS-written file and read the same values.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5a-store-"));
  try {
    const sampleFile = path.join(tmpDir, "sample.php");
    fs.writeFileSync(sampleFile, tsOut, "utf8");
    const back = execSync(
      `${process.env.PHP_BIN ?? "/home/hatch/scratch/bin/php"} -r 'echo json_encode(include $argv[1]);' ${sampleFile}`,
      { encoding: "utf8" },
    );
    check("T3 PHP include round-trips values", eq(JSON.parse(back), JSON.parse(JSON.stringify(sample))));

    // T4: backup semantics on a disposable copy.
    const copy = path.join(tmpDir, "config.php");
    fs.copyFileSync(RUNTIME_CFG, copy);
    const origBytes = fs.readFileSync(copy);
    process.env.FB_CONFIG_PATH = copy;
    setConfigProperty("i18n.locale", "fr_FR");
    const backup = path.join(tmpDir, "config.old.php");
    check("T4 backup exists after first write", fs.existsSync(backup));
    check("T4 backup holds original bytes", fs.existsSync(backup) && fs.readFileSync(backup).equals(origBytes));
    check("T4 locale updated", getConfigProperty<string>("i18n.locale", "xx") === "fr_FR");
    check(
      "T4 other keys intact",
      typeof getConfigProperty("info.instance_id", "") === "string" &&
        (getConfigProperty("info.instance_id", "") as string).length > 0,
    );
    const firstWrite = fs.readFileSync(copy);
    setConfigProperty("i18n.auto_detect_locale", false);
    check("T4 second backup holds first write", fs.readFileSync(backup).equals(firstWrite));
    check("T4 auto_detect updated", getConfigProperty<boolean>("i18n.auto_detect_locale", true) === false);
    check("T4 no temp litter", !fs.existsSync(copy + ".tmp-r5a"));

    // T5: FB_DATABASE_PATH derivation (double dirname).
    const layout = path.join(tmpDir, "layout");
    fs.mkdirSync(path.join(layout, "data"), { recursive: true });
    fs.copyFileSync(RUNTIME_CFG, path.join(layout, "config.php"));
    delete process.env.FB_CONFIG_PATH;
    process.env.FB_DATABASE_PATH = path.join(layout, "data", "fossbilling.sqlite");
    check(
      "T5 db-path derivation resolves install config",
      resolveConfigPath() === path.join(layout, "config.php"),
    );
    check("T5 derived path reads", typeof getConfigProperty("i18n.locale", "") === "string");
    delete process.env.FB_DATABASE_PATH;

    // T6: refusal + comment + double-quote handling.
    let refused = 0;
    for (const bad of [
      "<?php return ['x' => SOME_CONST];",
      "<?php return ['x' => 'a' . 'b'];",
      '<?php return ["x" => "hi $name"];',
      "<?php return ['x' => foo()];",
    ]) {
      try {
        parseConfigSource(bad);
      } catch {
        refused++;
      }
    }
    check("T6 unsupported syntax refused (4/4)", refused === 4, `refused=${refused}`);
    const commented = parseConfigSource(
      "<?php\n// a comment\nreturn [\n  # another\n  'a' => 1, /* inline */ 'b' => \"x\\ny\",\n];",
    );
    check("T6 comments skipped + double-quote escape", commented["a"] === 1 && commented["b"] === "x\ny");

    // T7: scalar helpers.
    check(
      "T7 normalizeBoolean",
      phpNormalizeBoolean(true, false) === true &&
        phpNormalizeBoolean("YES", false) === true &&
        phpNormalizeBoolean("off", true) === false &&
        phpNormalizeBoolean("", true) === false &&
        phpNormalizeBoolean("banana", true) === true &&
        phpNormalizeBoolean("banana", false) === false &&
        phpNormalizeBoolean(null, true) === true &&
        phpNormalizeBoolean(2, false) === true &&
        phpNormalizeBoolean(0, true) === false,
    );
    check(
      "T7 boolCast",
      phpBoolCast("false") === true &&
        phpBoolCast("0") === false &&
        phpBoolCast("") === false &&
        phpBoolCast([]) === false &&
        phpBoolCast(["x"]) === true &&
        phpBoolCast(null) === false,
    );
    check(
      "T7 stringCast",
      phpStringCast(true) === "1" &&
        phpStringCast(false) === "" &&
        phpStringCast(null) === "" &&
        phpStringCast(5) === "5" &&
        phpStringCast(["a"]) === "Array",
    );

    // T8: getProperty defaults.
    process.env.FB_CONFIG_PATH = copy;
    check("T8 missing key -> default", getConfigProperty("no.such.key", "DEF") === "DEF");
    check("T8 scalar intermediate -> default", getConfigProperty("i18n.locale.sub", "DEF") === "DEF");
    check("T8 present nested value", getConfigProperty<string>("i18n.locale", "DEF") === "fr_FR");

    // T9: setProperty creates intermediates; replaces scalar intermediates.
    setConfigProperty("r5a.new.deep", "v");
    check("T9 intermediate creation", getConfigProperty<string>("r5a.new.deep", "") === "v");
    setConfigProperty("i18n.locale.sub", "s");
    check(
      "T9 scalar intermediate replaced",
      eq(getConfigProperty("i18n.locale", null), { sub: "s" }),
    );
  } finally {
    delete process.env.FB_CONFIG_PATH;
    delete process.env.FB_DATABASE_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nconfig-store-test: ${passed} passed, ${failed} failed`);
  if (failed > 0) console.log(`failures: ${failures.join(", ")}`);
  return failed === 0 ? 0 : 1;
}
