import { getDb } from "./db";

/**
 * CSV exports — TS port of FOSSBilling\Http\CsvResponseFactory plus the
 * per-module exportCSV() header logic (Client/Invoice/Order Service).
 *
 * Service rule: requested headers are intersected with the module's
 * EXPORTABLE_COLUMNS in EXPORTABLE order; an empty result falls back
 * to DEFAULT_EXPORT_COLUMNS. Factory rule: sensitive columns
 * (pass, salt, api_token, hash, config) are stripped, and a request
 * whose every column was sensitive yields an empty body without
 * querying (unreachable after the service fallback for these modules,
 * but kept for fidelity).
 *
 * Cell rules verified live against League Csv Writer + EscapeFormula:
 * a leading =, -, +, @, tab, or CR gains a ' prefix (non-strings pass
 * through); the escaped value is then quoted (inner quotes doubled)
 * when it contains the delimiter, enclosure, escape char, newline,
 * carriage return, tab, or space. NULL renders empty; numbers render
 * in their stored form.
 */

const SENSITIVE_COLUMNS = new Set(["pass", "salt", "api_token", "hash", "config"]);

function escapeFormulaCell(v: unknown): unknown {
  if (typeof v !== "string" || v === "") return v;
  const c = v.charAt(0);
  if (c === "=" || c === "-" || c === "+" || c === "@" || c === "\t" || c === "\r") {
    return "'" + v;
  }
  return v;
}

function csvCell(v: unknown): string {
  const esc = escapeFormulaCell(v);
  if (esc === null || esc === undefined) return "";
  const s = typeof esc === "string" ? esc : String(esc);
  if (/[",\\\n\r\t ]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Requested headers from a JSON array body or bracket form params. */
export function requestedCsvHeaders(
  rawParams: Record<string, unknown>,
  params: Record<string, string>,
): string[] {
  const raw = rawParams["headers"];
  if (Array.isArray(raw)) return raw.filter((h): h is string => typeof h === "string");
  const bracketed: [number, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    const m = /^headers\[(\d+)\]$/.exec(k);
    if (m) bracketed.push([parseInt(m[1], 10), v]);
  }
  if (bracketed.length > 0) {
    bracketed.sort(([a], [b]) => a - b);
    return bracketed.map(([, v]) => v);
  }
  return [];
}

export async function exportCsvResponse(
  table: string,
  filename: string,
  exportable: string[],
  defaults: string[],
  requested: string[],
): Promise<Response> {
  const headersRequested = requested.length > 0;
  let headers = headersRequested ? exportable.filter((h) => requested.includes(h)) : [...defaults];
  if (headers.length === 0) headers = [...defaults];
  headers = headers.filter((h) => !SENSITIVE_COLUMNS.has(h));

  const headersOut = new Headers({
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename=${filename}`,
    "cache-control": "no-cache, must-revalidate",
    expires: "Mon, 26 Jul 1997 05:00:00 GMT",
  });

  // Factory rule: every requested column sensitive -> empty body, no query.
  if (headersRequested && headers.length === 0) {
    return new Response("", { headers: headersOut });
  }

  const rows = await getDb().prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  // Factory fallback (unreachable after the service default, kept for
  // fidelity): no headers -> derive them from the first row's keys
  // minus sensitive columns; no rows at all -> an empty body.
  if (headers.length === 0) {
    if (rows.length === 0) return new Response("", { headers: headersOut });
    headers = Object.keys(rows[0]).filter((h) => !SENSITIVE_COLUMNS.has(h));
  }
  const lines: string[] = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h] ?? null)).join(","));
  }
  return new Response(lines.join("\n") + "\n", { headers: headersOut });
}
