// Minimal Twig-subset renderer — just enough for FOSSBilling's
// email templates: {{ expr }} with dotted paths, string literals
// with #{...} interpolation, filter chains (default, format_date,
// format_currency, daysleft, length, url, upper, lower, trim), and
// {% if %}/{% for %} blocks. Anything outside the subset renders
// as an empty string rather than throwing, mirroring how a missing
// variable behaves in the templates' default-guarded style.

type Ctx = Record<string, unknown>;

function lookup(ctx: Ctx, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function phpDateFormat(format: string, d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsFull = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return format.replace(/Y|m|d|j|M|F|H|i|s/g, (t) => {
    switch (t) {
      case "Y": return String(d.getFullYear());
      case "m": return pad(d.getMonth() + 1);
      case "d": return pad(d.getDate());
      case "j": return String(d.getDate());
      case "M": return months[d.getMonth()];
      case "F": return monthsFull[d.getMonth()];
      case "H": return pad(d.getHours());
      case "i": return pad(d.getMinutes());
      case "s": return pad(d.getSeconds());
      default: return t;
    }
  });
}

export function formatDateValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const d = new Date(String(v).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return String(v);
  return phpDateFormat("M d, Y", d);
}

export function formatCurrencyValue(v: unknown, code: string, formats: Record<string, string>): string {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0;
  const num = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pattern = formats[code];
  if (pattern) return pattern.replace("{amount}", num);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code || "USD" }).format(n);
  } catch {
    return `${code} ${num}`;
  }
}

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", AUD: "$", CAD: "$" };
export function currencySymbol(code: string): string {
  return SYMBOLS[code] ?? code + " ";
}

function daysLeft(v: unknown): string {
  if (!v) return "";
  const d = new Date(String(v).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.ceil((d.getTime() - Date.now()) / 86400000);
  return String(diff);
}

interface FilterCall { name: string; args: string[] }

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote: string | null = null;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function evalTerm(term: string, ctx: Ctx): unknown {
  term = term.trim();
  if ((term.startsWith('"') && term.endsWith('"')) || (term.startsWith("'") && term.endsWith("'"))) {
    const inner = term.slice(1, -1);
    return inner.replace(/#\{([^}]*)\}/g, (_m, expr) => String(evalExpr(expr, ctx) ?? ""));
  }
  if (/^-?\d+(\.\d+)?$/.test(term)) return parseFloat(term);
  if (term === "true") return true;
  if (term === "false") return false;
  if (term.startsWith("{") && term.endsWith("}")) {
    // object literal { 'k': expr, ... } — only values are used by url()
    const obj: Record<string, unknown> = {};
    for (const pair of splitTopLevel(term.slice(1, -1), ",")) {
      const idx = pair.indexOf(":");
      if (idx < 0) continue;
      const key = pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, "");
      obj[key] = evalExpr(pair.slice(idx + 1), ctx);
    }
    return obj;
  }
  if (term.startsWith("[") && term.endsWith("]")) return [];
  return lookup(ctx, term);
}

function parseFilter(s: string): FilterCall {
  const m = s.trim().match(/^(\w+)\s*(?:\((.*)\))?$/s);
  if (!m) return { name: s.trim(), args: [] };
  return { name: m[1], args: m[2] ? splitTopLevel(m[2], ",").map((a) => a.trim()) : [] };
}

// Named-argument lists like url(area: 'client', query: {...})
function parseNamedArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const idx = a.indexOf(":");
    if (idx > 0) out[a.slice(0, idx).trim()] = a.slice(idx + 1).trim();
  }
  return out;
}

export function evalExpr(expr: string, ctx: Ctx & { __baseUrl?: string; __currencyFormats?: Record<string, string> }): unknown {
  const parts = splitTopLevel(expr, "|");
  let value = evalTerm(parts[0], ctx);
  for (const rawFilter of parts.slice(1)) {
    const f = parseFilter(rawFilter);
    switch (f.name) {
      case "default":
        value = value === undefined || value === null || value === "" ? evalTerm(f.args[0] ?? "''", ctx) : value;
        break;
      case "format_date":
        value = formatDateValue(value);
        break;
      case "daysleft":
        value = daysLeft(value);
        break;
      case "format_currency": {
        const code = String(evalTerm(f.args[0] ?? "''", ctx) ?? "");
        value = formatCurrencyValue(value, code, ctx.__currencyFormats ?? {});
        break;
      }
      case "length":
        value = Array.isArray(value) ? value.length : value == null ? 0 : String(value).length;
        break;
      case "upper": value = String(value ?? "").toUpperCase(); break;
      case "lower": value = String(value ?? "").toLowerCase(); break;
      case "capitalize": { const s = String(value ?? ""); value = s.charAt(0).toUpperCase() + s.slice(1); break; }
      case "trim": value = String(value ?? "").trim(); break;
      case "url": {
        const named = parseNamedArgs(f.args);
        const base = (ctx.__baseUrl ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/");
        let path = String(value ?? "");
        let qs = "";
        if (named.query) {
          const q = evalTerm(named.query, ctx) as Record<string, unknown>;
          const pairs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ""))}`);
          if (pairs.length) qs = "?" + pairs.join("&");
        }
        value = base + path.replace(/^\//, "") + qs;
        break;
      }
      default:
        break; // unknown filters pass the value through
    }
  }
  return value;
}

function truthy(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === "" || v === 0 || (Array.isArray(v) && v.length === 0));
}

function evalCondition(cond: string, ctx: Ctx): boolean {
  const cmp = cond.match(/^(.*?)\s*(>=|<=|==|!=|>|<)\s*(.+)$/s);
  if (cmp) {
    const l = evalExpr(cmp[1], ctx);
    const r = evalExpr(cmp[3], ctx);
    const ln = typeof l === "number" ? l : parseFloat(String(l));
    const rn = typeof r === "number" ? r : parseFloat(String(r));
    switch (cmp[2]) {
      case ">": return ln > rn;
      case "<": return ln < rn;
      case ">=": return ln >= rn;
      case "<=": return ln <= rn;
      case "==": return String(l ?? "") === String(r ?? "");
      case "!=": return String(l ?? "") !== String(r ?? "");
    }
  }
  return truthy(evalExpr(cond, ctx));
}

type Node =
  | { kind: "text"; text: string }
  | { kind: "echo"; expr: string }
  | { kind: "if"; cond: string; body: Node[] }
  | { kind: "for"; varName: string; expr: string; body: Node[] };

function parse(template: string): Node[] {
  const tokens = template.split(/(\{\{.*?\}\}|\{%.*?%\})/s).filter((t) => t !== "");
  let pos = 0;
  function parseUntil(stops: string[]): Node[] {
    const nodes: Node[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.startsWith("{%")) {
        const inner = tok.slice(2, -2).trim();
        const head = inner.split(/\s+/)[0];
        if (stops.includes(head)) return nodes;
        if (head === "if") {
          pos++;
          const body = parseUntil(["endif"]);
          pos++; // consume endif
          nodes.push({ kind: "if", cond: inner.slice(2).trim(), body });
          continue;
        }
        if (head === "for") {
          const m = inner.match(/^for\s+(\w+)\s+in\s+(.+)$/s);
          pos++;
          const body = parseUntil(["endfor"]);
          pos++;
          if (m) nodes.push({ kind: "for", varName: m[1], expr: m[2].trim(), body });
          continue;
        }
        pos++; // unknown tag: skip
        continue;
      }
      if (tok.startsWith("{{")) {
        nodes.push({ kind: "echo", expr: tok.slice(2, -2).trim() });
        pos++;
        continue;
      }
      nodes.push({ kind: "text", text: tok });
      pos++;
    }
    return nodes;
  }
  return parseUntil([]);
}

function renderNodes(nodes: Node[], ctx: Ctx): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.kind === "echo") {
      const v = evalExpr(n.expr, ctx as never);
      out += v === undefined || v === null ? "" : String(v);
    } else if (n.kind === "if") {
      if (evalCondition(n.cond, ctx as never)) out += renderNodes(n.body, ctx);
    } else if (n.kind === "for") {
      const items = evalExpr(n.expr, ctx as never);
      if (Array.isArray(items)) {
        for (const item of items) out += renderNodes(n.body, { ...ctx, [n.varName]: item });
      }
    }
  }
  return out;
}

export function renderTemplate(template: string, ctx: Ctx): string {
  return renderNodes(parse(template), ctx);
}
