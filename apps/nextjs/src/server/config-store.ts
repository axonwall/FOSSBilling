/**
 * Config store — TS port of FOSSBilling's Config::getProperty /
 * setProperty / setConfig (src/library/FOSSBilling/Config.php).
 *
 * The single source of truth is the install's config.php file. Reads
 * are fresh on every call (the file is re-parsed; nothing is cached),
 * so a write by PHP (or by another process) is visible to the next
 * TS read, and vice versa modulo PHP's opcache revalidation window.
 *
 * Path resolution (first hit wins):
 *   1. FB_CONFIG_PATH — explicit override. Tests and disposable
 *      copies use this; parity34's store tests point it at a scratch
 *      config so the reference config.php is never mutated by them.
 *   2. dirname(dirname(FB_DATABASE_PATH)) + "/config.php" — the
 *      standard layout, where the data dir sits directly under the
 *      install root (runtime/src/data/*.sqlite -> runtime/src/config.php).
 *   3. FOSSBILLING_PHP_SRC + "/config.php" — the install root in a
 *      deployment where the seam runs against the PHP tree.
 *   Otherwise the store throws instead of silently reading a wrong file.
 *
 * Precedence contract (decision R5-2): env > config.php for
 * DEPLOYMENT values (salt, DB credentials — the crypt.ts precedent
 * of FB_INFO_SALT / FB_CALLBACK_SALT); config.php is authoritative
 * for TOGGLED values (locale, report_errors, instance_id, ...).
 * This module is the config.php side of that contract only: it does
 * not invent env names for toggled values. Callers that own a
 * deployment value check env first, then fall back here.
 *
 * Parser subset (deliberate): the file must be `<?php return [...]`
 * with array literals only — string/int/float/bool/null scalars,
 * nested arrays (short `[...]` or `array(...)` form), `=>` pairs,
 * trailing commas, and comments. Anything else (constants, function
 * calls, concatenation, interpolation, arithmetic) is REFUSED with
 * an FbError, never silently misread. PHP's own setConfig drops
 * comments on write (it regenerates from the parsed array); this
 * writer does the same.
 *
 * Writer format mirrors Config::prettyPrintArrayToPHP byte-for-byte
 * for the shapes it supports (verified against the real PHP
 * pretty-printer in the config-store test): `<?php\nreturn [` +
 * 4-space-indented `var_export` keys/values, nested empty arrays on
 * one line, top-level empty arrays multi-line, no trailing newline.
 * Floats follow PHP's precision-14 %G rendering (1.0 -> "1.0",
 * 1e20 -> "1.0E+20").
 *
 * Write semantics mirror setConfig: the current file is copied to
 * config.old.php FIRST (same directory, `.php` -> `.old.php`), then
 * the new content is written via a temp file + rename (atomic for
 * readers; PHP's dumpFile writes in place — the rename is a
 * deliberate, behavior-preserving hardening, readers see old or new,
 * never partial). Unlike PHP's setConfig, this store does NOT wipe
 * PHP's Twig/Doctrine cache: config.php values are not held in
 * those pools (the 1h app-pool cache covers DB-backed extension
 * config, not config.php), and the seam reads config.php fresh.
 *
 * Later batches import: getConfigProperty / setConfigProperty
 * (R5d TZ reads i18n.timezone; R5i security reads/writes its
 * config keys; R5j installer writes the fresh config).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FbError } from "./dispatch";

/** Any value a PHP config array can hold (after parsing). */
export type PhpConfigValue =
  | string
  | number
  | boolean
  | null
  | PhpConfigValue[]
  | { [key: string]: PhpConfigValue };

export type PhpConfig = { [key: string]: PhpConfigValue };

/** Mirror of Config::MAX_RECURSION_LEVEL. */
const MAX_DEPTH = 25;

export function resolveConfigPath(): string {
  const explicit = process.env.FB_CONFIG_PATH;
  if (explicit) return explicit;
  const dbPath = process.env.FB_DATABASE_PATH;
  if (dbPath) return path.join(path.dirname(path.dirname(dbPath)), "config.php");
  const phpSrc = process.env.FOSSBILLING_PHP_SRC;
  if (phpSrc) return path.join(phpSrc, "config.php");
  throw new FbError("FOSSBilling configuration file path could not be resolved.");
}

function backupPath(configPath: string): string {
  return configPath.endsWith(".php")
    ? configPath.slice(0, -".php".length) + ".old.php"
    : configPath + ".old.php";
}

// ---------------------------------------------------------------------------
// Parser: `<?php return [...]` subset
// ---------------------------------------------------------------------------

type Token =
  | { kind: "open" }
  | { kind: "return" }
  | { kind: "lbracket" }
  | { kind: "rbracket" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" }
  | { kind: "arrow" }
  | { kind: "semi" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new FbError(`Unsupported syntax in FOSSBilling configuration file: ${msg}`);
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (src.startsWith("<?php", i)) {
      tokens.push({ kind: "open" });
      i += 5;
      continue;
    }
    if (src.startsWith("//", i) || src.startsWith("#", i)) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) fail("unterminated comment");
      i = end + 2;
      continue;
    }
    if (ch === "[") {
      tokens.push({ kind: "lbracket" });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ kind: "rbracket" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i++;
      continue;
    }
    if (src.startsWith("=>", i)) {
      tokens.push({ kind: "arrow" });
      i += 2;
      continue;
    }
    if (ch === ";") {
      tokens.push({ kind: "semi" });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let out = "";
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === "\\" && i + 1 < src.length) {
          const n = src[i + 1];
          if (quote === "'") {
            // PHP single-quoted strings interpret only \\ and \'.
            if (n === "\\" || n === "'") {
              out += n;
              i += 2;
              continue;
            }
            out += c;
            i++;
            continue;
          }
          // Double-quoted: interpret common escapes; refuse interpolation.
          if (n === "n") {
            out += "\n";
            i += 2;
            continue;
          }
          if (n === "r") {
            out += "\r";
            i += 2;
            continue;
          }
          if (n === "t") {
            out += "\t";
            i += 2;
            continue;
          }
          if (n === "v") {
            out += "\v";
            i += 2;
            continue;
          }
          if (n === "e") {
            out += "\x1b";
            i += 2;
            continue;
          }
          if (n === "f") {
            out += "\f";
            i += 2;
            continue;
          }
          if (n === "\\" || n === '"' || n === "$") {
            out += n;
            i += 2;
            continue;
          }
          fail("unsupported escape in double-quoted string");
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (quote === '"' && c === "$") fail("variable interpolation in string");
        out += c;
        i++;
      }
      if (!closed) fail("unterminated string");
      tokens.push({ kind: "string", value: out });
      continue;
    }
    if (/[0-9]/.test(ch) || ((ch === "-" || ch === "+") && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F_]+|[+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?))/.exec(
        src.slice(i),
      );
      if (!m) fail(`bad number at offset ${i}`);
      const raw = m![0].replace(/_/g, "");
      i += m![0].length;
      let num: number;
      if (/^0[xX]/.test(raw)) {
        num = parseInt(raw, 16);
      } else if (/[.eE]/.test(raw)) {
        num = Number(raw);
      } else {
        const big = BigInt(raw);
        if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
          fail(`integer literal ${raw} exceeds the safe-integer range`);
        }
        num = Number(big);
      }
      tokens.push({ kind: "number", value: num });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const word = m![0];
      i += word.length;
      tokens.push({ kind: "ident", value: word });
      continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new FbError("Unsupported syntax in FOSSBilling configuration file: unexpected end of file");
    this.pos++;
    return t;
  }

  private expect(kind: Token["kind"]): Token {
    const t = this.next();
    if (t.kind !== kind) {
      throw new FbError(
        `Unsupported syntax in FOSSBilling configuration file: expected ${kind}, got ${t.kind}`,
      );
    }
    return t;
  }

  parseFile(): PhpConfig {
    this.expect("open");
    const ret = this.next();
    if (ret.kind !== "ident" || ret.value.toLowerCase() !== "return") {
      throw new FbError("Unsupported syntax in FOSSBilling configuration file: expected return");
    }
    const value = this.parseValue(0);
    if (Array.isArray(value)) {
      // Top-level config is an associative array; represent as object.
      if (value.length !== 0) {
        throw new FbError("Unsupported syntax in FOSSBilling configuration file: top-level must be an associative array");
      }
      // Empty top-level: `return [];` — represent as {}.
      this.expect("semi");
      this.expectEnd();
      return {};
    }
    if (typeof value !== "object" || value === null) {
      throw new FbError("Unsupported syntax in FOSSBilling configuration file: top-level must be an array");
    }
    this.expect("semi");
    this.expectEnd();
    return value as PhpConfig;
  }

  private expectEnd(): void {
    if (this.pos !== this.tokens.length) {
      throw new FbError("Unsupported syntax in FOSSBilling configuration file: trailing content after return");
    }
  }

  /** Parses one value; arrays come back as object-or-array (see normalize). */
  private parseValue(depth: number): PhpConfigValue {
    if (depth > MAX_DEPTH) {
      throw new FbError("Unsupported syntax in FOSSBilling configuration file: nesting exceeds 25 levels");
    }
    const t = this.next();
    switch (t.kind) {
      case "string":
        return t.value;
      case "number":
        return t.value;
      case "ident": {
        const low = t.value.toLowerCase();
        if (low === "true") return true;
        if (low === "false") return false;
        if (low === "null") return null;
        if (low === "array") {
          this.expect("lparen");
          return this.parseArrayBody("rparen", depth);
        }
        throw new FbError(
          `Unsupported syntax in FOSSBilling configuration file: bare identifier ${t.value}`,
        );
      }
      case "lbracket":
        return this.parseArrayBody("rbracket", depth);
      default:
        throw new FbError(
          `Unsupported syntax in FOSSBilling configuration file: unexpected ${t.kind}`,
        );
    }
  }

  /**
   * Parses the inside of [...] / array(...). Returns a JS array when
   * every key is a sequential int from 0, else a plain object with
   * string keys (int keys stringified, as JS object keys always are).
   */
  private parseArrayBody(close: "rbracket" | "rparen", depth: number): PhpConfigValue {
    const entries: [string, PhpConfigValue][] = [];
    let nextIndex = 0;
    let sequential = true;
    let first = true;
    for (;;) {
      const peek = this.peek();
      if (!peek) {
        throw new FbError("Unsupported syntax in FOSSBilling configuration file: unterminated array");
      }
      if (peek.kind === close) {
        this.next();
        break;
      }
      if (!first) this.expect("comma");
      first = false;
      const afterComma = this.peek();
      if (afterComma && afterComma.kind === close) {
        // Trailing comma: the loop head consumes the closer next round.
        continue;
      }
      // key => value, or a bare value (implicit int key).
      const maybeKey = this.next();
      let key: string;
      let value: PhpConfigValue;
      const arrow = this.peek();
      if (arrow && arrow.kind === "arrow") {
        this.next();
        if (maybeKey.kind === "string") key = maybeKey.value;
        else if (maybeKey.kind === "number" && Number.isInteger(maybeKey.value)) {
          key = String(maybeKey.value);
        } else {
          throw new FbError("Unsupported syntax in FOSSBilling configuration file: array key must be a string or int");
        }
        value = this.parseValue(depth + 1);
      } else {
        // Bare value: rewind by re-parsing from the consumed token.
        key = String(nextIndex);
        value = this.valueFromToken(maybeKey, depth + 1);
      }
      if (key !== String(nextIndex)) sequential = false;
      nextIndex++;
      entries.push([key, value]);
    }
    if (entries.length === 0) return [];
    if (sequential) return entries.map(([, v]) => v);
    const obj: { [key: string]: PhpConfigValue } = {};
    for (const [k, v] of entries) obj[k] = v;
    return obj;
  }

  /** Re-interprets an already-consumed first token as a value start. */
  private valueFromToken(t: Token, depth: number): PhpConfigValue {
    if (t.kind === "string" || t.kind === "number") return t.value;
    if (t.kind === "ident") {
      const low = t.value.toLowerCase();
      if (low === "true") return true;
      if (low === "false") return false;
      if (low === "null") return null;
      if (low === "array") {
        this.expect("lparen");
        return this.parseArrayBody("rparen", depth);
      }
      throw new FbError(
        `Unsupported syntax in FOSSBilling configuration file: bare identifier ${t.value}`,
      );
    }
    if (t.kind === "lbracket") return this.parseArrayBody("rbracket", depth);
    throw new FbError(`Unsupported syntax in FOSSBilling configuration file: unexpected ${t.kind}`);
  }
}

/** Parses config.php source text (throws FbError on unsupported syntax). */
export function parseConfigSource(src: string): PhpConfig {
  return new Parser(tokenize(src)).parseFile();
}

/** Reads + parses the config file at the resolved path. */
export function readConfigFile(configPath: string = resolveConfigPath()): PhpConfig {
  let src: string;
  try {
    src = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new FbError("The FOSSBilling configuration file is empty or invalid.");
  }
  if (!src.trim()) {
    throw new FbError("The FOSSBilling configuration file is empty or invalid.");
  }
  return parseConfigSource(src);
}

// ---------------------------------------------------------------------------
// Writer: mirror of Config::prettyPrintArrayToPHP
// ---------------------------------------------------------------------------

function varExportString(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function phpFloat(n: number): string {
  if (Object.is(n, -0)) return "-0.0";
  if (n === 0) return "0.0";
  const s = n.toPrecision(14);
  const [m, e] = s.split("e");
  let mant = m.replace(/(\.\d*?)0+$/, "$1");
  if (mant.endsWith(".")) mant = mant.slice(0, -1);
  if (!mant.includes(".")) mant += ".0";
  if (e !== undefined) {
    const exp = parseInt(e, 10);
    return `${mant}E${exp >= 0 ? "+" : "-"}${Math.abs(exp)}`;
  }
  return mant;
}

function varExportValue(v: PhpConfigValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    // JS has no int/float distinction, so integral values below PHP's
    // %G exponent threshold (1e14) serialize as ints (matching PHP
    // int rendering, and PHP float rendering up to the ".0" suffix,
    // which JS cannot express); at/above it they serialize as PHP
    // floats do (1e20 -> "1.0E+20"). Either way the VALUE survives;
    // only the int-vs-float type tag is ambiguous, and no config
    // value in the corpus sits near the threshold.
    return Number.isInteger(v) && Math.abs(v) < 1e14 ? String(v) : phpFloat(v);
  }
  if (typeof v === "string") return varExportString(v);
  throw new FbError("Config writer: arrays need key context (internal error)");
}

function varExportKey(k: string): string {
  return /^(0|[1-9]\d*)$/.test(k) ? k : varExportString(k);
}

function formatValue(v: PhpConfigValue, level: number, topLevel: boolean): string {
  if (v === null || (!Array.isArray(v) && typeof v !== "object")) {
    return " => " + varExportValue(v) + ",\n";
  }
  const entries: [string, PhpConfigValue][] = Array.isArray(v)
    ? v.map((item, i) => [String(i), item] as [string, PhpConfigValue])
    : Object.entries(v);
  if (entries.length === 0 && !topLevel) return " => [],\n";
  const indent = " ".repeat(level * 4);
  const childIndent = " ".repeat((level + 1) * 4);
  let out = " => [\n";
  for (const [k, child] of entries) {
    if (Array.isArray(child) || (typeof child === "object" && child !== null)) {
      const childEntries = Array.isArray(child) ? child.length : Object.keys(child).length;
      if (childEntries === 0) {
        out += childIndent + varExportKey(k) + " => [],\n";
        continue;
      }
    }
    out += childIndent + varExportKey(k) + formatValue(child, level + 1, false);
  }
  return out + indent + "],\n";
}

/** Serializes a parsed config exactly the way PHP's pretty-printer does. */
export function serializeConfig(config: PhpConfig): string {
  let out = "<?php\nreturn [";
  for (const [k, v] of Object.entries(config)) {
    out += "\n    " + varExportKey(k) + formatValue(v, 1, true);
  }
  return out + "];";
}

/**
 * Writes a full config (backup first, then temp + rename). Mirrors
 * setConfig's backup semantics; the rename (vs PHP's in-place
 * dumpFile) is the only deliberate difference, and only hardens
 * readers against partial writes.
 */
export function writeConfigFile(next: PhpConfig, configPath: string = resolveConfigPath()): void {
  const backup = backupPath(configPath);
  try {
    fs.copyFileSync(configPath, backup);
  } catch {
    throw new FbError("An error occurred when creating a backup of the configuration file.");
  }
  const tmp = configPath + ".tmp-r5a";
  try {
    fs.writeFileSync(tmp, serializeConfig(next), "utf8");
    fs.renameSync(tmp, configPath);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort only; the throw below is what the caller sees.
    }
    throw new FbError("An error occurred when writing the updated configuration file.");
  }
}

// ---------------------------------------------------------------------------
// Dot-notation access (mirror of Config::getProperty / setProperty)
// ---------------------------------------------------------------------------

/** Reads one dotted property, returning `def` when any segment is absent. */
export function getConfigProperty<T>(property: string, def: T, configPath?: string): T {
  let cur: unknown = readConfigFile(configPath ?? resolveConfigPath());
  for (const segment of property.split(".")) {
    if (typeof cur !== "object" || cur === null || !(segment in cur)) return def;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur as T;
}

/**
 * Writes one dotted property, creating intermediate arrays as needed
 * (a scalar intermediate is replaced with [], mirroring setProperty).
 * Writes the whole file (backup + rewrite) on every call, exactly as
 * PHP's setProperty does — so two consecutive calls produce two
 * backups, the second holding the first call's result.
 */
export function setConfigProperty(property: string, value: PhpConfigValue, configPath?: string): void {
  const resolved = configPath ?? resolveConfigPath();
  const config = readConfigFile(resolved);
  const segments = property.split(".");
  let cur: Record<string, unknown> = config as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      // PHP replaces a missing OR non-array intermediate with [].
      // A JS array intermediate becomes an object when a string key
      // follows (writer keys make the conversion value-preserving).
      if (Array.isArray(next) && !/^(0|[1-9]\d*)$/.test(segments[i + 1])) {
        const obj: Record<string, unknown> = {};
        next.forEach((item, idx) => {
          obj[String(idx)] = item;
        });
        cur[seg] = obj;
      } else if (Array.isArray(next)) {
        // Numeric next segment: keep the array, extend by index below.
      } else {
        cur[seg] = {};
      }
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
  writeConfigFile(config, resolved);
}

// ---------------------------------------------------------------------------
// PHP scalar semantics helpers (Tools::normalizeBoolean, (bool)/(string))
// ---------------------------------------------------------------------------

/**
 * Mirror of Tools::normalizeBoolean($value, $default): bool passes
 * through; numbers cast (0/0.0 false, everything else incl. NaN true);
 * strings use FILTER_VALIDATE_BOOLEAN (1/true/on/yes -> true,
 * 0/false/off/no/'' -> false, anything else -> default, case-insens);
 * anything else -> default.
 */
export function phpNormalizeBoolean(value: unknown, def: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const low = value.toLowerCase();
    if (low === "1" || low === "true" || low === "on" || low === "yes") return true;
    if (low === "0" || low === "false" || low === "off" || low === "no" || low === "") return false;
    return def;
  }
  return def;
}

/**
 * Mirror of PHP's (bool) cast: false, 0, 0.0, '', '0', null, [] are
 * false; everything else — including the string 'false' — is true.
 */
export function phpBoolCast(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return true;
  return Boolean(value);
}

/**
 * Mirror of PHP's (string) cast for config scalars: null -> '',
 * true -> '1', false -> '', numbers -> String(n), strings pass
 * through, arrays -> 'Array' (PHP warns and yields 'Array').
 */
export function phpStringCast(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "1" : "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return "Array";
  return String(value);
}
