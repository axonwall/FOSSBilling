/**
 * Minimal parser for PHP's serialize() format — the subset FOSSBilling
 * session rows use (arrays with string/int keys; string, int, float,
 * bool, null values). Session `content` is Symfony's format: a sequence
 * of `key|<serialized value>` segments (e.g. `_sf2_attributes|a:2:{...}`).
 */

export type PhpValue = Value;
type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  get offset(): number {
    return this.i;
  }

  parse(): Value {
    const t = this.s[this.i];
    switch (t) {
      case "N":
        this.i += 2;
        return null;
      case "b": {
        const v = this.s[this.i + 2] === "1";
        this.i += 4;
        return v;
      }
      case "i": {
        const end = this.s.indexOf(";", this.i);
        const v = parseInt(this.s.slice(this.i + 2, end), 10);
        this.i = end + 1;
        return v;
      }
      case "d": {
        const end = this.s.indexOf(";", this.i);
        const v = parseFloat(this.s.slice(this.i + 2, end));
        this.i = end + 1;
        return v;
      }
      case "s": {
        const colon = this.s.indexOf(":", this.i + 2);
        const len = parseInt(this.s.slice(this.i + 2, colon), 10);
        // Length is in bytes; session data here is ASCII/UTF-8 — slice by
        // code units after decoding byte length conservatively: PHP strings
        // in these rows are plain text, so index by characters is safe for
        // the attribute keys/values we read (ids, emails, tokens).
        const start = colon + 2;
        const v = this.s.slice(start, start + len);
        this.i = start + len + 2;
        return v;
      }
      case "a": {
        const colon = this.s.indexOf(":", this.i + 2);
        const count = parseInt(this.s.slice(this.i + 2, colon), 10);
        this.i = colon + 2; // at '{'
        const obj: { [k: string]: Value } = {};
        const arr: Value[] = [];
        let sequential = true;
        for (let n = 0; n < count; n++) {
          const k = this.parse();
          const v = this.parse();
          if (k !== n) sequential = false;
          obj[String(k)] = v;
          arr.push(v);
        }
        this.i += 1; // '}'
        return sequential && count > 0 ? arr : obj;
      }
      default:
        throw new Error(`Unsupported PHP serialize type '${t}' at offset ${this.i}`);
    }
  }
}

export function phpUnserialize(serialized: string): Value {
  return new Parser(serialized).parse();
}

const encoder = new TextEncoder();

/** Serialize a value in PHP serialize() format (same subset as the parser). */
export function phpSerialize(v: Value): string {
  if (v === null) return "N;";
  if (typeof v === "boolean") return `b:${v ? 1 : 0};`;
  if (typeof v === "number") {
    return Number.isInteger(v) ? `i:${v};` : `d:${v};`;
  }
  if (typeof v === "string") {
    return `s:${encoder.encode(v).length}:"${v}";`;
  }
  if (Array.isArray(v)) {
    const body = v.map((item, idx) => phpSerialize(idx) + phpSerialize(item)).join("");
    return `a:${v.length}:{${body}}`;
  }
  const entries = Object.entries(v);
  const body = entries.map(([k, item]) => phpSerialize(k) + phpSerialize(item)).join("");
  return `a:${entries.length}:{${body}}`;
}

/**
 * Replace (or remove, with value === undefined) one segment of Symfony
 * session content, preserving every other segment byte-for-byte. Used
 * for the one place TS mutates a PHP session: clearing pending messages
 * after guest/system/get_pending_messages, exactly as PHP does.
 */
export function replaceSessionSegment(
  content: string,
  key: string,
  value: Value | undefined,
): string {
  let rest = content;
  let out = "";
  let done = false;
  while (rest.length > 0) {
    const pipe = rest.indexOf("|");
    if (pipe < 0) {
      out += rest;
      break;
    }
    const segKey = rest.slice(0, pipe);
    const tail = rest.slice(pipe + 1);
    const parser = new Parser(tail);
    parser.parse();
    const rawSegment = rest.slice(0, pipe + 1 + parser.offset);
    rest = tail.slice(parser.offset);
    if (segKey === key && !done) {
      done = true;
      if (value !== undefined) out += `${key}|${phpSerialize(value)}`;
      // undefined => segment dropped
    } else {
      out += rawSegment;
    }
  }
  if (!done && value !== undefined) out += `${key}|${phpSerialize(value)}`;
  return out;
}

/** Parse Symfony session content (`key|serialized` segments) into a map. */
export function parseSessionContent(content: string): Record<string, Value> {
  const out: Record<string, Value> = {};
  let rest = content;
  while (rest.length > 0) {
    const pipe = rest.indexOf("|");
    if (pipe < 0) break;
    const key = rest.slice(0, pipe);
    const tail = rest.slice(pipe + 1);
    const parser = new Parser(tail);
    out[key] = parser.parse();
    // Advance past the consumed serialized value.
    rest = tail.slice(parser.offset);
    if (rest === tail) break; // safety: no progress
  }
  return out;
}
