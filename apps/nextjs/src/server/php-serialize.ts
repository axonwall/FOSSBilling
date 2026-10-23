/**
 * Minimal parser for PHP's serialize() format — the subset FOSSBilling
 * session rows use (arrays with string/int keys; string, int, float,
 * bool, null values). Session `content` is Symfony's format: a sequence
 * of `key|<serialized value>` segments (e.g. `_sf2_attributes|a:2:{...}`).
 */

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
