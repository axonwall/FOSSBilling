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
        let path = String(value ?? "").replace(/^\//, "");
        let qs = "";
        if (named.query) {
          const q = evalTerm(named.query, ctx) as Record<string, unknown>;
          const pairs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ""))}`);
          if (pairs.length) qs = "?" + pairs.join("&");
        }
        // PHP FOSSBillingExtension::url: area 'admin' routes through
        // adminLink(), which prefixes the admin area prefix; any other
        // area (or none) uses the bare link. The reference install's
        // prefix is '/admin'.
        if (named.area && String(evalTerm(named.area, ctx) ?? "") === "admin") {
          path = `admin/${path}`;
        }
        value = base + path + qs;
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
  const tokens = template.split(/(\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\})/s).filter((t) => t !== "");
  let pos = 0;
  // Twig strips exactly one newline following a {% %} tag (and, as
  // observed, a {# #} comment); print tags {{ }} do not strip. Without
  // this, every if/for body renders with a phantom blank line per tag
  // line — visible in invoice emails as blank lines inside the <ul>.
  function consumeTag(): void {
    pos++;
    if (pos < tokens.length) {
      const next = tokens[pos];
      if (!next.startsWith("{{") && !next.startsWith("{%") && !next.startsWith("{#")) {
        tokens[pos] = next.replace(/^\r\n?|^\n/, "");
      }
    }
  }
  function parseUntil(stops: string[]): Node[] {
    const nodes: Node[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.startsWith("{#")) {
        consumeTag(); // comment: dropped, newline after it stripped
        continue;
      }
      if (tok.startsWith("{%")) {
        const inner = tok.slice(2, -2).trim();
        const head = inner.split(/\s+/)[0];
        if (stops.includes(head)) return nodes;
        if (head === "if") {
          consumeTag();
          const body = parseUntil(["endif"]);
          consumeTag(); // consume endif
          nodes.push({ kind: "if", cond: inner.slice(2).trim(), body });
          continue;
        }
        if (head === "for") {
          const m = inner.match(/^for\s+(\w+)\s+in\s+(.+)$/s);
          consumeTag();
          const body = parseUntil(["endfor"]);
          consumeTag();
          if (m) nodes.push({ kind: "for", varName: m[1], expr: m[2].trim(), body });
          continue;
        }
        consumeTag(); // unknown tag: skip
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

/**
 * The email environment's strict pass (PHP: SandboxedStringRenderer +
 * strict_variables). Missing variables are errors, not empty strings;
 * unbalanced delimiters and unclosed if/for blocks are syntax errors.
 * Error text follows PHP's shape, minus the per-template hash Twig
 * appends to the template name (parity scrubs that segment).
 * Used by template_send/_parse and template_validate_all only — the
 * money-flow templated emails keep the forgiving renderer.
 */
export function renderTemplateStrict(template: string, ctx: Ctx): string {
  const lineOf = (idx: number) => template.slice(0, idx).split("\n").length;
  // Delimiter balance.
  const varRe = /\{\{|\}\}|\{%|%\}/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(template)) !== null) {
    const tok = m[0];
    if (tok === "{{" || tok === "{%") stack.push(tok);
    else if (tok === "}}" || tok === "%}") {
      const open = tok === "}}" ? "{{" : "{%";
      if (stack.length === 0 || stack[stack.length - 1] !== open) {
        throw new Error(`Email template syntax error: Unexpected "${tok}" in "__string_template__" at line ${lineOf(m.index)}.`);
      }
      stack.pop();
    }
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw new Error(`Email template syntax error: Unclosed "${open === "{{" ? "variable" : "block"}" in "__string_template__" at line ${lineOf(template.length)}.`);
  }
  // Block balance for the tags the subset parser consumes.
  const tagRe = /\{%\s*(if|for|endif|endfor|apply|endapply|block|endblock)\b/g;
  const blocks: string[] = [];
  while ((m = tagRe.exec(template)) !== null) {
    const tag = m[1];
    if (tag === "if" || tag === "for" || tag === "apply" || tag === "block") blocks.push(tag);
    else {
      const open = tag === "endif" ? "if" : tag === "endfor" ? "for" : tag === "endapply" ? "apply" : "block";
      if (blocks.length === 0 || blocks[blocks.length - 1] !== open) {
        throw new Error(`Email template syntax error: Unexpected "${tag}" in "__string_template__" at line ${lineOf(m.index)}.`);
      }
      blocks.pop();
    }
  }
  if (blocks.length > 0) {
    throw new Error(`Email template syntax error: Unexpected end of template in "__string_template__" at line 1.`);
  }
  // Strict variable check over every echo and condition expression.
  // Loop variables and {% set %} names count as defined (the subset
  // renderer does not evaluate set, so their shapes are not checked).
  const defined = new Set(Object.keys(ctx));
  for (const re of [/\{%\s*for\s+(\w+)\s+in/g, /\{%\s*set\s+(\w+)/g]) {
    let sm: RegExpExecArray | null;
    while ((sm = re.exec(template)) !== null) defined.add(sm[1]);
  }
  const KEYWORDS = new Set(["true", "false", "null", "not", "and", "or", "in", "is",
    "defined", "empty", "odd", "even", "divisible", "iterable", "mapping", "sequence",
    "same", "starts", "ends", "matches"]);
  const exprRe = /\{\{(.*?)\}\}|\{%\s*if\s+(.*?)\s*%\}|\{%\s*for\s+\w+\s+in\s+(.*?)\s*%\}/gs;
  while ((m = exprRe.exec(template)) !== null) {
    const expr = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!expr) continue;
    if (/\|\s*default\b/.test(expr)) continue; // default() guards undefined
    const base = expr.split("|")[0].replace(/'[^']*'|"[^"]*"/g, "");
    const idRe = /[A-Za-z_][\w]*/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(base)) !== null) {
      const root = im[0];
      if (KEYWORDS.has(root)) continue;
      if (base.slice(0, im.index).trimEnd().endsWith(".")) continue; // attribute, not a root
      if (base.slice(im.index + root.length).trimStart().startsWith("(")) continue; // function call
      if (!defined.has(root)) {
        throw new Error(`Email template rendering error: Variable "${root}" does not exist in "__string_template__" at line ${lineOf(m.index)}.`);
      }
      // Nested path on a context root: a missing key is a strict error too.
      const rest = base.slice(im.index + root.length);
      const pathMatch = /^((?:\.[A-Za-z_][\w]*)+)/.exec(rest);
      if (pathMatch && root in ctx) {
        let cur: unknown = ctx[root];
        for (const part of pathMatch[1].slice(1).split(".")) {
          if (cur === null || cur === undefined || typeof cur !== "object"
            || !((cur as Record<string, unknown>)[part] !== undefined)) {
            throw new Error(`Email template rendering error: Key "${part}" for array does not exist in "__string_template__" at line ${lineOf(m.index)}.`);
          }
          cur = (cur as Record<string, unknown>)[part];
        }
      }
    }
  }
  return renderTemplate(template, ctx);
}
