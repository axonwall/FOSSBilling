// Stats module (Phase 5 R1 batch 2) — pure SQL aggregation,
// pinned by capture18.py / captures18/.
//
// Fidelity notes (R5d: day math is zone math now, not
// process-local math — see tz.ts):
// - Day boundaries are midnights in the RESOLVED zone (env TZ >
//   config i18n.timezone > UTC), matching PHP's
//   `new DateTimeImmutable('today')` under load.php's
//   date_default_timezone_set. The old process-local midnights
//   only matched while the process ran TZ=UTC.
// - Flot series step from (from + 1 day) while < to: PHP's
//   do/while pushes then pops the final (== to) entry, so the
//   series covers from+1 .. to-1. Default windows use
//   strtotime('-1 month') / strtotime('+1 day') — i.e. NOW
//   minus a month / tomorrow, preserving time-of-day — so
//   default-window series timestamps vary by run time; the
//   SQL bounds are calendar dates and stable. parity15
//   compares default series by calendar day + value. Day steps
//   are zone-CALENDAR steps (tz.ts addZoneDays), not +24h, so
//   DST-transition days keep their calendar date.
// - get_product_summary's RIGHT JOIN + WHERE o.status =
//   'active' is the classic outer-join-killing WHERE: rows
//   for products without active orders are filtered out by
//   the WHERE clause itself, so the result equals an inner
//   join grouped by product. Implemented as the inner join.
// - get_product_sales / country maps are PHP
//   fetchAllKeyValue maps: later duplicate keys overwrite
//   earlier ones (all three active products share the title
//   "Phase0 Widget Hosting", so sales collapses to 1).
// - NULL country groups surface under the "" key.

import { FbError, register, requireAdmin } from "../dispatch";
import { getDb, orderStatusCounts } from "../db";
import {
  addZoneDays,
  addZoneMonths,
  formatZoneDate,
  formatZoneDateTime,
  parseZoneDateTime,
  resolveZone,
  zoneMidnightMs,
  zoneMonthStartMs,
} from "../tz";

const TABLES = ["client", "client_order", "invoice", "support_ticket"] as const;

type Boundaries = Record<string, string>;

function dayBoundaries(zone: string): Boundaries {
  const now = Date.now();
  const today = zoneMidnightMs(zone, now);
  const monthStart = zoneMonthStartMs(zone, now);
  return {
    yesterday_start: formatZoneDateTime(zone, addZoneDays(zone, today, -1)),
    today_start: formatZoneDateTime(zone, today),
    tomorrow_start: formatZoneDateTime(zone, addZoneDays(zone, today, 1)),
    last_month_start: formatZoneDateTime(zone, addZoneMonths(zone, monthStart, -1)),
    month_start: formatZoneDateTime(zone, monthStart),
    next_month_start: formatZoneDateTime(zone, addZoneMonths(zone, monthStart, 1)),
  };
}

/** node:sqlite rejects named parameters the statement does not use, so
 * filter a boundary bag down to exactly the names the WHERE clause
 * references (a full dayBoundaries() bag passed to a two-bound query
 * otherwise dies with "Unknown named parameter"). */
function namedParams(sql: string, params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m[1] in params) out[m[1]] = params[m[1]];
  }
  return out;
}

async function countWhere(table: string, where: string, params: Record<string, string>): Promise<number> {
  const row = await getDb().prepare(`SELECT COUNT(1) AS c FROM ${table} WHERE ${where}`).get(namedParams(where, params)) as { c: number };
  return row.c;
}

/** PHP strtotime for the inputs stats accepts, in the resolved zone:
 * Y-m-d (zone midnight) or Y-m-d H:i:s (that wall time in the zone)
 * or anything Date parses (absolute); garbage -> 0 (PHP's
 * strtotime(false) -> date('Y-m-d', 0) = 1970-01-01, and the flot
 * loop steps from epoch 0 the same way). */
function parseTime(value: string | undefined, fallbackMs: number, zone: string): number {
  if (!value) return fallbackMs;
  const zoned = parseZoneDateTime(zone, value);
  if (zoned !== null) return zoned;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function dateInterval(ctx: { params: Record<string, string> }, zone: string): [number, number] {
  const now = Date.now();
  const from = parseTime(ctx.params["date_from"], addZoneMonths(zone, now, -1), zone);
  const to = parseTime(ctx.params["date_to"], addZoneDays(zone, now, 1), zone);
  return [from, to];
}

function flotInt(rows: Record<string, number>, from: number, to: number, zone: string): [number, number][] {
  const out: [number, number][] = [];
  for (let d = addZoneDays(zone, from, 1); d < to; d = addZoneDays(zone, d, 1)) {
    out.push([d, Math.trunc(rows[formatZoneDate(zone, d)] ?? 0)]);
  }
  return out;
}

function flotFloat(rows: Record<string, number>, from: number, to: number, zone: string): [number, number][] {
  const out: [number, number][] = [];
  for (let d = addZoneDays(zone, from, 1); d < to; d = addZoneDays(zone, d, 1)) {
    out.push([d, Math.round((rows[formatZoneDate(zone, d)] ?? 0) * 100) / 100]);
  }
  return out;
}

function keyValue(rows: { [k: string]: unknown }[], keyCol: string, valCol: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row[keyCol] === null || row[keyCol] === undefined ? "" : String(row[keyCol]);
    out[key] = row[valCol];
  }
  return out;
}

register("admin", "stats", "get_summary", async (ctx) => {
  requireAdmin(ctx);
  const zone = resolveZone();
  const b = dayBoundaries(zone);
  const stats: Record<string, number> = {};
  for (const [table, prefix] of [["client", "clients"], ["client_order", "orders"], ["invoice", "invoices"], ["support_ticket", "tickets"]] as const) {
    const total = await getDb().prepare(`SELECT COUNT(1) AS c FROM ${table}`).get() as { c: number };
    stats[`${prefix}_total`] = total.c;
    stats[`${prefix}_today`] = await countWhere(table, "created_at >= :today_start AND created_at < :tomorrow_start", b);
    stats[`${prefix}_yesterday`] = await countWhere(table, "created_at >= :yesterday_start AND created_at < :today_start", b);
    stats[`${prefix}_this_month`] = await countWhere(table, "created_at >= :month_start AND created_at < :next_month_start", b);
    stats[`${prefix}_last_month`] = await countWhere(table, "created_at >= :last_month_start AND created_at < :month_start", b);
  }
  return stats;
});

register("admin", "stats", "get_summary_income", async (ctx) => {
  requireAdmin(ctx);
  const zone = resolveZone();
  const b = dayBoundaries(zone);
  const base = "SELECT (COALESCE(SUM(base_income), 0) - COALESCE(SUM(base_refund), 0)) AS income FROM invoice WHERE issued = 1 AND (status = 'paid' OR status = 'refunded')";
  const sum = async (where: string, params: Record<string, string>): Promise<number> => {
    const row = await getDb().prepare(`${base} ${where}`).get(namedParams(where, params)) as { income: number };
    return row.income;
  };
  return {
    total: await sum("", {}),
    today: await sum("AND paid_at >= :today_start AND paid_at < :tomorrow_start", b),
    yesterday: await sum("AND paid_at >= :yesterday_start AND paid_at < :today_start", b),
    this_month: await sum("AND paid_at >= :month_start AND paid_at < :next_month_start", b),
    last_month: await sum("AND paid_at >= :last_month_start AND paid_at < :month_start", b),
  };
});

register("admin", "stats", "get_orders_statuses", async (ctx) => {
  requireAdmin(ctx);
  const c = await orderStatusCounts();
  const { total: _total, ...rest } = c;
  void _total;
  return {
    pending_setup: rest["pending_setup"] ?? 0,
    failed_setup: rest["failed_setup"] ?? 0,
    failed_renew: rest["failed_renew"] ?? 0,
    active: rest["active"] ?? 0,
    suspended: rest["suspended"] ?? 0,
    canceled: rest["canceled"] ?? 0,
  };
});

register("admin", "stats", "get_product_summary", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare(
    "SELECT p.id AS id, p.title AS title, COUNT(o.id) AS orders FROM product p JOIN client_order o ON o.product_id = p.id WHERE o.status = 'active' GROUP BY o.product_id ORDER BY orders DESC",
  ).all() as { id: number; title: string; orders: number }[];
  return rows.map((r) => ({ id: r.id, title: r.title, orders: r.orders }));
});

register("admin", "stats", "get_product_sales", async (ctx) => {
  requireAdmin(ctx);
  const zone = resolveZone();
  const [from, to] = dateInterval(ctx, zone);
  const rows = await getDb().prepare(
    "SELECT title, COUNT(product_id) AS sales FROM client_order WHERE status = 'active' AND created_at BETWEEN :date_from AND :date_to GROUP BY product_id",
  ).all({ date_from: formatZoneDate(zone, from), date_to: formatZoneDate(zone, to) }) as { title: string; sales: number }[];
  return keyValue(rows, "title", "sales");
});

register("admin", "stats", "get_income_vs_refunds", async (ctx) => {
  requireAdmin(ctx);
  const row = await getDb().prepare(
    "SELECT COALESCE(SUM(base_refund), 0) AS refund, COALESCE(SUM(base_income), 0) AS income FROM invoice WHERE issued = 1 AND (status = 'paid' OR status = 'refunded')",
  ).get() as { refund: number; income: number };
  return { refund: row.refund, income: row.income };
});

register("admin", "stats", "get_refunds", async (ctx) => {
  requireAdmin(ctx);
  const zone = resolveZone();
  const [from, to] = dateInterval(ctx, zone);
  const rows = await getDb().prepare(
    "SELECT substr(created_at, 1, 10) AS date, COALESCE(SUM(base_refund), 0) AS refund FROM invoice WHERE created_at BETWEEN :date_from AND :date_to AND issued = 1 AND (status = 'refunded' OR (status = 'paid' AND base_refund > 0)) GROUP BY date",
  ).all({ date_from: formatZoneDate(zone, from), date_to: formatZoneDate(zone, to) }) as { date: string; refund: number }[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.date] = r.refund;
  return flotFloat(map, from, to, zone);
});

register("admin", "stats", "get_income", async (ctx) => {
  requireAdmin(ctx);
  const zone = resolveZone();
  const [from, to] = dateInterval(ctx, zone);
  const rows = await getDb().prepare(
    "SELECT substr(paid_at, 1, 10) AS date, (COALESCE(SUM(base_income), 0) - COALESCE(SUM(base_refund), 0)) AS income FROM invoice WHERE paid_at BETWEEN :date_from AND :date_to AND issued = 1 AND (status = 'paid' OR status = 'refunded') GROUP BY date",
  ).all({ date_from: formatZoneDate(zone, from), date_to: formatZoneDate(zone, to) }) as { date: string; income: number }[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.date] = r.income;
  return flotFloat(map, from, to, zone);
});

async function tableStats(table: string, ctx: { params: Record<string, string> }): Promise<[number, number][]> {
  if (!(TABLES as readonly string[]).includes(table)) throw new FbError(`Invalid table name: ${table}`);
  const zone = resolveZone();
  const [from, to] = dateInterval(ctx, zone);
  const rows = await getDb().prepare(
    `SELECT substr(created_at, 1, 10) AS date, COUNT(1) AS count FROM ${table} WHERE created_at BETWEEN :date_from AND :date_to GROUP BY date`,
  ).all({ date_from: formatZoneDate(zone, from), date_to: formatZoneDate(zone, to) }) as { date: string; count: number }[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.date] = r.count;
  return flotInt(map, from, to, zone);
}

register("admin", "stats", "get_orders", async (ctx) => {
  requireAdmin(ctx);
  return await tableStats("client_order", ctx);
});

register("admin", "stats", "get_clients", async (ctx) => {
  requireAdmin(ctx);
  return await tableStats("client", ctx);
});

register("admin", "stats", "get_invoices", async (ctx) => {
  requireAdmin(ctx);
  return await tableStats("invoice", ctx);
});

register("admin", "stats", "get_tickets", async (ctx) => {
  requireAdmin(ctx);
  return await tableStats("support_ticket", ctx);
});

register("admin", "stats", "client_countries", async (ctx) => {
  requireAdmin(ctx);
  const limit = parseInt(ctx.params["limit"] ?? "10", 10) || 0;
  const rows = await getDb().prepare(
    `SELECT country, COUNT(id) AS clients FROM client GROUP BY country ORDER BY clients DESC LIMIT ${limit}`,
  ).all() as { country: string | null; clients: number }[];
  return keyValue(rows, "country", "clients");
});

register("admin", "stats", "sales_countries", async (ctx) => {
  requireAdmin(ctx);
  const limit = parseInt(ctx.params["limit"] ?? "10", 10) || 0;
  const rows = await getDb().prepare(
    `SELECT buyer_country, COUNT(id) AS sales FROM invoice WHERE status = 'paid' GROUP BY buyer_country ORDER BY sales DESC LIMIT ${limit}`,
  ).all() as { buyer_country: string | null; sales: number }[];
  return keyValue(rows, "buyer_country", "sales");
});

void FbError;
