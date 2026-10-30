import { Pool, type PoolClient } from "pg";
import type { Db, DbStatement } from "./db";

/**
 * Postgres implementation of the Db interface (R3a, D3-1/D3-2).
 *
 * Contract: a Postgres-backed Db behaves like the SQLite one the seam was
 * written against. Rows come back shaped like SQLite rows (ints as numbers,
 * booleans as 0/1, timestamps as "YYYY-MM-DD HH:MM:SS" strings, JSON
 * columns as strings), so call sites need no per-driver branches. Three
 * translations make that true, all inside this file, never at call sites:
 *
 *  1. Placeholders: `?` -> $1..$n (scanner skips string literals, quoted
 *     identifiers, comments, and dollar-quoted strings).
 *  2. Dialect: LIKE -> ILIKE (SQLite LIKE is case-insensitive, Postgres
 *     LIKE is not), plus the seam's single SQLite-only function: the
 *     datetime() shapes in support batch_ticket_auto_close. Any other
 *     datetime( shape throws instead of silently passing broken SQL.
 *  3. Column-typed literals and params: Postgres boolean/bytea columns
 *     reject the seam's SQLite idioms (`WHERE is_default = 1`,
 *     `SET is_default = 0`, a hex string bound to session.id). The
 *     translator rewrites boolean literals to TRUE/FALSE and coerces
 *     bound params in boolean/bytea column context. Column types come
 *     from Doctrine entity metadata (docs/nextjs-strangler/phase5/
 *     postgres-column-types.json, dumped from the ORM without a live
 *     server); boolean column names are provably unique across the
 *     entity schema (no boolean name is ever a non-boolean column),
 *     which is what makes the name-based fallback below sound.
 *
 * What this file does NOT do: it never invents a column type. If a
 * comparison or bound param cannot be resolved to a known table, it is
 * passed through unchanged and Postgres errors loudly (fail-fast) rather
 * than being silently mistranslated. RedBean tables (no Doctrine
 * metadata: admin, session rows aside, activity, cart, ...) store
 * booleans as integers, so an unresolvable column is left alone.
 */

export const BOOLEAN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  admin_group: ["protected"],
  client: ["email_approved", "merge_renewals", "tax_exempt"],
  client_order: ["group_master", "promo_recurring"],
  currency: ["is_default", "is_rate_manual"],
  email_template: ["enabled", "is_custom", "is_overridden"],
  form_field: ["hidden", "hide_label", "is_unique", "readonly", "required"],
  invoice: ["issued"],
  invoice_item: ["charged", "taxed"],
  pay_gateway: ["allow_recurrent", "allow_single", "enabled", "test_mode"],
  product: ["active", "allow_quantity_select", "hidden", "is_addon", "stock_control"],
  product_payment_period: ["enabled"],
  promo: ["active", "auto_apply", "freesetup", "once_per_client", "recurring", "stackable"],
  service_domain: ["locked", "privacy"],
  service_hosting: ["reseller"],
  service_hosting_server: ["active", "secure"],
  service_license: ["validate_host", "validate_ip", "validate_path", "validate_version"],
  setting: ["public"],
  support_helpdesk: ["can_reopen"],
  tld: ["active", "allow_register", "allow_transfer", "require_transfer_code"],
  tld_registrar: ["test_mode"],
};

/** Columns Postgres types as bytea (Doctrine binary/blob). Stored form is
 *  the string's bytes (PHP writes the hex/text string into VARBINARY/
 *  BLOB), so a string param is bound as Buffer.from(str, "utf8") — NOT
 *  hex-decoded. Reads come back as Buffer, which the seam already
 *  handles (findSession TextDecoder-decodes non-string content). */
export const BYTEA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  activity_client_email: ["attachment_content"],
  email_queue: ["attachment_content"],
  session: ["content", "id"],
};

const ENTITY_TABLES: ReadonlySet<string> = new Set([
  ...Object.keys(BOOLEAN_COLUMNS),
  ...Object.keys(BYTEA_COLUMNS),
  "activity_client_email",
  "activity_system",
  "admin",
  "admin_group_member",
  "admin_password_reset",
  "cart",
  "client_balance",
  "client_group",
  "client_order",
  "client_order_meta",
  "client_order_service",
  "coupon",
  "currency",
  "email_queue",
  "email_template",
  "extension",
  "extension_meta",
  "form",
  "form_field",
  "invoice_event",
  "invoice_item",
  "invoice_payment",
  "invoice_setting",
  "kb_article",
  "kb_article_category",
  "massmailer",
  "model",
  "news",
  "notification",
  "order_status_history",
  "page",
  "product_category",
  "product_payment",
  "product_type",
  "promo_code",
  "promo_redemption",
  "redirect",
  "service_custom",
  "service_domain_tld",
  "service_downloadable",
  "service_downloadable_file",
  "service_hosting_hp",
  "service_hosting_ip",
  "service_hosting_plan",
  "service_license_plugin",
  "setting",
  "subscription",
  "support_helpdesk",
  "support_kb_article",
  "support_message",
  "support_pr",
  "support_pr_category",
  "support_ticket",
  "support_ticket_note",
  "support_ticket_task",
  "system",
  "transaction",
  "upgrade",
  "user",
  "widget",
]);

const BOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(BOOLEAN_COLUMNS).flat(),
);
const BYTEA_NAMES: ReadonlySet<string> = new Set(
  Object.values(BYTEA_COLUMNS).flat(),
);

type ColKind = "boolean" | "bytea" | null;

function kindOf(table: string | null, col: string): ColKind {
  if (table && BOOLEAN_COLUMNS[table]?.includes(col)) return "boolean";
  if (table && BYTEA_COLUMNS[table]?.includes(col)) return "bytea";
  return null;
}

/* ------------------------------------------------------------------ */
/* Scanner: split SQL into code / non-code segments.                   */
/* ------------------------------------------------------------------ */

type Seg = { kind: "code" | "other"; text: string; start: number; end: number };

function scan(sql: string): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  let codeStart = 0;
  const pushCode = (end: number) => {
    if (end > codeStart) segs.push({ kind: "code", text: sql.slice(codeStart, end), start: codeStart, end });
  };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";
    if (ch === "'") {
      pushCode(i);
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j += 1; break;
        }
        j += 1;
      }
      segs.push({ kind: "other", text: sql.slice(i, j), start: i, end: j });
      i = j; codeStart = j;
    } else if (ch === '"' || ch === "`") {
      pushCode(i);
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          j += 1; break;
        }
        j += 1;
      }
      segs.push({ kind: "other", text: sql.slice(i, j), start: i, end: j });
      i = j; codeStart = j;
    } else if (ch === "-" && next === "-") {
      pushCode(i);
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j += 1;
      segs.push({ kind: "other", text: sql.slice(i, j), start: i, end: j });
      i = j; codeStart = j;
    } else if (ch === "/" && next === "*") {
      pushCode(i);
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      segs.push({ kind: "other", text: sql.slice(i, j), start: i, end: j });
      i = j; codeStart = j;
    } else if (ch === "$") {
      // Dollar-quoted string: $tag$ ... $tag$ (tag may be empty).
      const m = /^\$[A-Za-z_][\w]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close !== -1) {
          pushCode(i);
          const j = close + tag.length;
          segs.push({ kind: "other", text: sql.slice(i, j), start: i, end: j });
          i = j; codeStart = j;
          continue;
        }
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  pushCode(sql.length);
  return segs;
}

/* ------------------------------------------------------------------ */
/* Analysis on code text (strings/comments stripped, positions kept).  */
/* ------------------------------------------------------------------ */

function codeTextAndMap(sql: string, segs: Seg[]): { code: string; pos: number[] } {
  let code = "";
  const pos: number[] = [];
  for (const s of segs) {
    if (s.kind !== "code") continue;
    for (let k = s.start; k < s.end; k++) { code += sql[k]; pos.push(k); }
    code += " ";
    pos.push(-1);
  }
  return { code, pos };
}

function stripQuotes(name: string): string {
  return name.replace(/^["`]|["`]$/g, "");
}

function aliasMap(code: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:FROM|JOIN)\s+("?[A-Za-z_][\w]*"?)(?:\s+(?:AS\s+)?("?[A-Za-z_][\w]*"?))?/gi;
  for (const m of code.matchAll(re)) {
    const table = stripQuotes(m[1]).toLowerCase();
    const alias = m[2] ? stripQuotes(m[2]).toLowerCase() : table;
    map.set(alias, table);
  }
  return map;
}

/** Resolve a possibly-qualified column to a table, or null if unknown.
 *  Rules: qualified -> alias map; unqualified + exactly one table in the
 *  query -> that table; unqualified + name globally unique-boolean/bytea
 *  and every table in the query is an entity table -> name-based (sound:
 *  the name is never a different type in the entity schema, and RedBean
 *  tables are excluded by the entity-tables check). */
function resolveTable(
  qualifier: string | undefined,
  col: string,
  aliases: Map<string, string>,
): string | null {
  if (qualifier) return aliases.get(qualifier.toLowerCase()) ?? null;
  if (aliases.size === 1) return [...aliases.values()][0];
  const lower = col.toLowerCase();
  const tables = [...aliases.values()];
  if (tables.length > 0 && tables.every((t) => ENTITY_TABLES.has(t))) {
    if (BOOL_NAMES.has(lower) || BYTEA_NAMES.has(lower)) {
      for (const t of tables) {
        if (kindOf(t, lower)) return t;
      }
      // Name is a known boolean/bytea name but no table in this query
      // actually has it as such: fall through to null (pass-through).
    }
  }
  return null;
}

type Rewrite = { start: number; end: number; text: string };

export interface Translated {
  text: string;
  values: unknown[];
}

/**
 * Translate one seam SQL statement for Postgres. Throws on a placeholder
 * count mismatch (fail-fast: old SQLite code would have errored too)
 * and on any datetime( shape other than the two known ones.
 */
export function translateSql(sql: string, params: readonly unknown[]): Translated {
  const segs = scan(sql);
  const { code, pos: posMap } = codeTextAndMap(sql, segs);

  // --- datetime() pre-pass (spans original coordinates) ---
  const dtRewrites: Rewrite[] = [];
  {
    // Walk code segments for the word datetime, then parse its args
    // across segments (strings are segments too, so 'now' is visible).
    const codeSegs = segs.filter((s) => s.kind === "code");
    for (const seg of codeSegs) {
      const re = /\bdatetime\s*\(/g;
      for (const m of seg.text.matchAll(re)) {
        const absStart = seg.start + m.index;
        // Find matching close paren, counting only code-segment parens.
        let depth = 0;
        let j = absStart;
        let close = -1;
        while (j < sql.length) {
          const s = segs.find((x) => x.start <= j && j < x.end);
          if (!s) break;
          if (s.kind === "code") {
            for (let k = j; k < s.end; k++) {
              if (sql[k] === "(") depth += 1;
              else if (sql[k] === ")") {
                depth -= 1;
                if (depth === 0) { close = k; break; }
              }
            }
            if (close !== -1) break;
            j = s.end;
          } else {
            j = s.end;
          }
        }
        if (close === -1) throw new Error(`translateSql: unterminated datetime( in: ${sql}`);
        const inner = sql.slice(absStart + m[0].length, close);
        // Shape 1: datetime('now') -> now()
        if (/^\s*'now'\s*$/.test(inner)) {
          dtRewrites.push({ start: absStart, end: close + 1, text: "now()" });
          continue;
        }
        // Shape 2: datetime(X, '+' || Y || ' hours') -> (X + (Y || ' hours')::interval)
        const shape2 = /^\s*([A-Za-z_][\w.]*)\s*,\s*'\s*\+\s*'\s*\|\|\s*([A-Za-z_][\w.]*)\s*\|\|\s*' hours'\s*$/.exec(inner);
        if (shape2) {
          dtRewrites.push({
            start: absStart,
            end: close + 1,
            text: `(${shape2[1]} + (${shape2[2]} || ' hours')::interval)`,
          });
          continue;
        }
        throw new Error(`translateSql: unsupported datetime( shape in: ${sql}`);
      }
    }
  }

  // --- structural analysis on code text ---
  const aliases = aliasMap(code);
  // ? positions in code text, in order == param ordinals.
  const qPos: number[] = [];
  for (let k = 0; k < code.length; k++) if (code[k] === "?") qPos.push(k);
  if (qPos.length !== params.length) {
    throw new Error(
      `translateSql: placeholder count ${qPos.length} != param count ${params.length} in: ${sql}`,
    );
  }
  const ordinalAt = (codeIdx: number): number => {
    // Ordinal of the ? at exactly codeIdx (binary search, small arrays).
    let lo = 0;
    let hi = qPos.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (qPos[mid] === codeIdx) return mid;
      if (qPos[mid] < codeIdx) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };
  const paramKind = new Map<number, ColKind>();
  const litRewrites: Rewrite[] = [];
  const markParam = (codeIdx: number, table: string | null, col: string) => {
    const ord = ordinalAt(codeIdx);
    if (ord === -1) return;
    const kind = kindOf(table, col.toLowerCase());
    if (kind) paramKind.set(ord, kind);
  };
  const markLiteral = (matchStart: number, matchEnd: number, lit: string, table: string | null, col: string) => {
    if (kindOf(table, col.toLowerCase()) !== "boolean") return;
    const origStart = posMap[matchStart];
    const origEnd = posMap[matchEnd - 1] + 1;
    if (origStart === -1 || origEnd === 0) return;
    litRewrites.push({ start: origStart, end: origEnd, text: lit === "1" ? "TRUE" : "FALSE" });
  };

  // INSERT: column list maps VALUES items to columns.
  {
    const m = /\bINSERT\s+INTO\s+("?[A-Za-z_][\w]*"?)\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*;?\s*$/isd.exec(code);
    if (m) {
      const table = stripQuotes(m[1]).toLowerCase();
      const cols = m[2].split(",").map((c) => stripQuotes(c.trim()).toLowerCase());
      // Split VALUES body on top-level commas (code text has no strings),
      // recording each item's code-text offset.
      const body = m[3];
      const bodyStart = m.indices?.[3]?.[0] ?? code.indexOf(body);
      let depth = 0;
      let curStart = 0;
      const items: { text: string; start: number }[] = [];
      for (let k = 0; k <= body.length; k++) {
        const ch = body[k];
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if ((ch === "," && depth === 0) || k === body.length) {
          items.push({ text: body.slice(curStart, k), start: bodyStart + curStart });
          curStart = k + 1;
        }
      }
      if (items.length !== cols.length) {
        throw new Error(`translateSql: INSERT column/item count mismatch in: ${sql}`);
      }
      const bodyQs = qPos.filter((p) => p >= bodyStart && p < bodyStart + body.length);
      let qi = 0;
      items.forEach((item, idx) => {
        const col = cols[idx];
        if (!col) return;
        const t = item.text.trim();
        if (t === "?") {
          const ord = bodyQs[qi++];
          if (ord !== undefined) {
            const kind = kindOf(table, col);
            if (kind) paramKind.set(qPos.indexOf(ord), kind);
          }
        } else if ((t === "1" || t === "0") && kindOf(table, col) === "boolean") {
          const itemStart = item.start + item.text.indexOf(t);
          litRewrites.push({ start: posMap[itemStart], end: posMap[itemStart] + 1, text: t === "1" ? "TRUE" : "FALSE" });
        }
      });
    }
  }

  // UPDATE ... SET col = ? / col = literal
  {
    const m = /\bUPDATE\s+("?[A-Za-z_][\w]*"?)\s+SET\s+(.*?)(?:\s+WHERE\s+|\s*;?\s*$)/isd.exec(code);
    if (m) {
      const table = stripQuotes(m[1]).toLowerCase();
      const setBody = m[2];
      const setStart = m.indices?.[2]?.[0] ?? code.indexOf(setBody);
      const pairRe = /("?[A-Za-z_][\w]*"?)\s*=\s*(\?|[0-9]+)/g;
      for (const p of setBody.matchAll(pairRe)) {
        const col = stripQuotes(p[1]).toLowerCase();
        const absIdx = setStart + (p.index ?? 0) + p[0].indexOf(p[2]);
        if (p[2] === "?") markParam(absIdx, table, col);
        else if (p[2] === "1" || p[2] === "0") markLiteral(absIdx, absIdx + 1, p[2], table, col);
      }
    }
  }

  // Comparisons: [alias.]col = ? / literal, anywhere (WHERE, JOIN ON, ...).
  {
    const qualRe = /("?[A-Za-z_][\w]*"?)\s*\.\s*("?[A-Za-z_][\w]*"?)\s*=\s*(\?|[0-9]+)/g;
    const qualRanges: [number, number][] = [];
    for (const p of code.matchAll(qualRe)) {
      const table = resolveTable(stripQuotes(p[1]), stripQuotes(p[2]), aliases);
      const valIdx = (p.index ?? 0) + p[0].lastIndexOf(p[3]);
      if (p[3] === "?") markParam(valIdx, table, stripQuotes(p[2]));
      else if (p[3] === "1" || p[3] === "0") markLiteral(valIdx, valIdx + 1, p[3], table, stripQuotes(p[2]));
      qualRanges.push([p.index ?? 0, (p.index ?? 0) + p[0].length]);
    }
    const unqRe = /(?<![\w.])("?[A-Za-z_][\w]*"?)\s*=\s*(\?|[0-9]+)/g;
    for (const p of code.matchAll(unqRe)) {
      const start = p.index ?? 0;
      if (qualRanges.some(([a, b]) => start >= a && start < b)) continue;
      // Skip the left side of SET pairs already handled (UPDATE table
      // resolved above); unqualified SET matches would double-mark with
      // the same table, which is harmless, so no special-casing needed
      // beyond the qualified-range skip.
      const table = resolveTable(undefined, stripQuotes(p[1]), aliases);
      const valIdx = start + p[0].lastIndexOf(p[2]);
      if (p[2] === "?") markParam(valIdx, table, stripQuotes(p[1]));
      else if (p[2] === "1" || p[2] === "0") markLiteral(valIdx, valIdx + 1, p[2], table, stripQuotes(p[1]));
    }
  }

  // --- coerce values ---
  const values = [...params];
  for (const [ord, kind] of paramKind) {
    const v = values[ord];
    if (v === null || v === undefined) continue;
    if (kind === "boolean") {
      if (v === 1 || v === "1" || v === true || v === "true") values[ord] = true;
      else if (v === 0 || v === "0" || v === false || v === "false") values[ord] = false;
    } else if (kind === "bytea") {
      if (typeof v === "string") values[ord] = Buffer.from(v, "utf8");
      else if (v instanceof Uint8Array) values[ord] = Buffer.from(v);
    }
  }

  // --- rebuild: apply rewrites + placeholder conversion + LIKE ---
  // Single left-to-right walk. Segments tile the string contiguously;
  // code is processed one char per step so rewrite starts (which are
  // always code positions) are hit exactly, and a rewrite may jump over
  // string segments it spans (datetime('now')).
  const allRewrites = [...dtRewrites, ...litRewrites].sort((a, b) => a.start - b.start);
  for (let k = 1; k < allRewrites.length; k++) {
    if (allRewrites[k].start < allRewrites[k - 1].end) {
      throw new Error(`translateSql: overlapping rewrites in: ${sql}`);
    }
  }
  let out = "";
  let n = 0;
  let rw = 0;
  let pos = 0;
  let segIdx = 0;
  while (pos < sql.length) {
    if (rw < allRewrites.length && allRewrites[rw].start === pos) {
      out += allRewrites[rw].text;
      pos = allRewrites[rw].end;
      rw += 1;
      continue;
    }
    if (rw < allRewrites.length && allRewrites[rw].start < pos) {
      throw new Error(`translateSql: missed rewrite in: ${sql}`);
    }
    while (segIdx < segs.length && segs[segIdx].end <= pos) segIdx += 1;
    const seg = segs[segIdx];
    if (!seg || seg.start > pos) { out += sql[pos]; pos += 1; continue; }
    if (seg.kind !== "code") {
      out += seg.text;
      pos = seg.end;
      continue;
    }
    const rest = sql.slice(pos, seg.end);
    const like = /^(NOT\s+LIKE|LIKE)\b/i.exec(rest);
    if (like) {
      out += like[1].toUpperCase().startsWith("NOT") ? "NOT ILIKE" : "ILIKE";
      pos += like[1].length;
      continue;
    }
    if (sql[pos] === "?") { n += 1; out += `$${n}`; pos += 1; continue; }
    out += sql[pos];
    pos += 1;
  }
  return { text: out, values };
}

/* ------------------------------------------------------------------ */
/* Row normalization: Postgres values -> SQLite-shaped values.         */
/* ------------------------------------------------------------------ */

const OID_BOOL = 16;
const OID_BYTEA = 17;
const OID_INT2 = 21;
const OID_INT4 = 23;
const OID_INT8 = 20;
const OID_FLOAT4 = 700;
const OID_FLOAT8 = 701;
const OID_NUMERIC = 1700;
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;
const OID_JSON = 114;
const OID_JSONB = 3802;

function fmtTimestamp(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return v;
    const p = (x: number) => String(x).padStart(2, "0");
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())} ${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}`;
  }
  if (typeof v === "string") {
    // "2026-10-27 12:00:00.000", "...T...Z", "...+00" -> UTC seconds.
    const d = new Date(v.replace(" ", "T"));
    if (!Number.isNaN(d.getTime()) && /[T ]/.test(v)) return fmtTimestamp(d);
    return v.length > 19 ? v.slice(0, 19) : v;
  }
  return v;
}

function fmtDate(v: unknown): unknown {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (x: number) => String(x).padStart(2, "0");
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
  }
  if (typeof v === "string") return v.slice(0, 10);
  return v;
}

/** Normalize one result row using the query's field OIDs. Unknown OIDs
 *  pass through untouched. Idempotent for values already in SQLite shape
 *  (pg-mem returns some types pre-normalized; real pg does not). */
export function normalizePgRow(
  fields: readonly { name: string; dataTypeID: number }[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const byName = new Map(fields.map((f) => [f.name, f.dataTypeID]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) { out[k] = v; continue; }
    switch (byName.get(k)) {
      case OID_BOOL:
        out[k] = v === true || v === 1 || v === "t" || v === "true" || v === "1" ? 1 : 0;
        break;
      case OID_INT8:
      case OID_INT2:
      case OID_INT4:
      case OID_FLOAT4:
      case OID_FLOAT8:
      case OID_NUMERIC:
        out[k] = typeof v === "number" ? v : Number(v);
        break;
      case OID_TIMESTAMP:
      case OID_TIMESTAMPTZ:
        out[k] = fmtTimestamp(v);
        break;
      case OID_DATE:
        out[k] = fmtDate(v);
        break;
      case OID_JSON:
      case OID_JSONB:
        out[k] = typeof v === "string" ? v : JSON.stringify(v);
        break;
      default:
        out[k] = v;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Db implementation over a pg Pool or a checked-out client.           */
/* ------------------------------------------------------------------ */

type Runner = Pool | PoolClient;

class PgStatement implements DbStatement {
  constructor(
    private db: DbPg,
    private sql: string,
  ) {}
  async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
    const rows = await this.db.queryRows(this.sql, params);
    return rows[0] as T | undefined;
  }
  async all<T = unknown>(...params: unknown[]): Promise<T[]> {
    return (await this.db.queryRows(this.sql, params)) as T[];
  }
  async run(...params: unknown[]): Promise<{ changes: number }> {
    return this.db.queryRun(this.sql, params);
  }
}

export class DbPg implements Db {
  constructor(private runner: Runner) {}
  prepare(sql: string): DbStatement {
    return new PgStatement(this, sql);
  }
  async exec(sql: string): Promise<void> {
    await this.queryRows(sql, []);
  }
  /** Direct runner.query, bypassing translateSql (R5j installer replay). */
  async rawExec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }
  async insertAndGetId(sql: string, ...params: unknown[]): Promise<number> {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    if (!/^\s*INSERT\s+INTO\s+/i.test(trimmed)) {
      throw new Error(`insertAndGetId called with non-INSERT SQL: ${sql}`);
    }
    if (/\bRETURNING\b/i.test(trimmed)) {
      throw new Error(`insertAndGetId called with SQL that already has RETURNING: ${sql}`);
    }
    const rows = await this.queryRows(`${trimmed} RETURNING id`, params);
    const id = rows[0]?.["id"];
    if (id === null || id === undefined) throw new Error(`insertAndGetId got no id for: ${sql}`);
    return Number(id);
  }
  async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if ("connect" in this.runner && typeof (this.runner as Pool).connect === "function") {
      const client = await (this.runner as Pool).connect();
      try {
        await client.query("BEGIN");
        const out = await fn(new DbPg(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* already failed */ }
        throw e;
      } finally {
        client.release();
      }
    }
    // Already inside a transaction (a tx Db): nesting is not supported;
    // run inline so the outer transaction still governs. The seam has
    // no nested-transaction sites, so this is a guard, not a feature.
    return fn(this);
  }
  async queryRows(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
    const { text, values } = translateSql(sql, params);
    const res = await this.runner.query(text, values as unknown[]);
    return res.rows.map((r) => normalizePgRow(res.fields, r as Record<string, unknown>));
  }
  async queryRun(sql: string, params: readonly unknown[]): Promise<{ changes: number }> {
    const { text, values } = translateSql(sql, params);
    const res = await this.runner.query(text, values as unknown[]);
    return { changes: res.rowCount ?? 0 };
  }
}

let pool: Pool | null = null;

export function createPgDb(): Db {
  if (!pool) {
    const url = process.env.FB_DATABASE_URL;
    if (!url) throw new Error("FB_DATABASE_URL is not set: Postgres driver selected but no URL configured.");
    pool = new Pool({ connectionString: url });
  }
  return new DbPg(pool);
}
