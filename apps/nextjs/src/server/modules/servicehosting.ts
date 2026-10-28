// Servicehosting — hosting service management.
//
// D7 manager cut: Hestia + Custom only. Server rows naming a deleted
// manager (WHM/Plesk/DirectAdmin/CWP) behave as PHP would with the
// adapter file gone: creation/update reject the manager, URL lookups
// fall back to false, and test_connection fails. Hestia network calls
// (change plan/password, test connection) are real HTTPS POSTs to the
// panel's /api/ endpoint; their failure messages come from the local
// TLS/HTTP stack, so parity compares those cases by error presence and
// code, not by exact message (documented in findings-r1e).

import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp } from "../db";
import { paginate } from "../util";
import { clientBlock } from "./invoice";
import { tldToApiArray } from "./servicedomain";

const KEPT_MANAGERS = ["Hestia", "Custom"];
const PASSWORD_PLACEHOLDER = "********";
const BAD_STATUSES = ["failed_setup", "pending_setup", "suspended", "canceled"];

interface OrderRow {
  id: number;
  client_id: number;
  product_id: number;
  price: string | number | null;
  quantity: number;
  service_id: number | null;
  service_type: string | null;
  status: string;
  expires_at: string | null;
  config: string | null;
}

interface ServerRow {
  id: number;
  name: string | null;
  ip: string | null;
  hostname: string | null;
  assigned_ips: string | null;
  status_url: string | null;
  active: number | null;
  max_accounts: number | null;
  ns1: string | null;
  ns2: string | null;
  ns3: string | null;
  ns4: string | null;
  manager: string | null;
  username: string | null;
  password: string | null;
  accesshash: string | null;
  password_length: number | null;
  port: string | null;
  config: string | null;
  secure: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface HpRow {
  id: number;
  name: string | null;
  quota: string | null;
  bandwidth: string | null;
  max_ftp: string | null;
  max_sql: string | null;
  max_pop: string | null;
  max_sub: string | null;
  max_park: string | null;
  max_addon: string | null;
  config: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface HostingRow {
  id: number;
  client_id: number;
  sld: string | null;
  tld: string | null;
  ip: string | null;
  username: string | null;
  pass: string | null;
  reseller: number;
  service_hosting_server_id: number | null;
  service_hosting_hp_id: number | null;
  created_at: string | null;
  updated_at: string | null;
}

/** PHP Tools::normalizeBoolean. */
function normalizeBoolean(v: unknown, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (["1", "true", "on", "yes"].includes(s)) return true;
    if (["0", "false", "off", "no", ""].includes(s)) return false;
    return def;
  }
  return def;
}

/** PHP Tools::normalizePort: int 1..65535, else the default. */
function normalizePort(v: unknown, def: number | null = null): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^-?\d+$/.test(t)) {
      const n = parseInt(t, 10);
      if (n >= 1 && n <= 65535) return n;
    }
  }
  return def;
}

function parseJson<T>(json: string | null, fallback: T): T {
  try {
    const v = json ? JSON.parse(json) : undefined;
    return v === undefined || v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

function processAssignedIPs(input: string): string {
  const out: string[] = [];
  for (const line of input.split(/\r\n|\r|\n/)) {
    const ip = line.trim();
    if (ip === "") continue;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every((p) => Number(p) <= 255)) out.push(ip);
    else if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) out.push(ip);
  }
  return JSON.stringify(out);
}

async function findOrder(id: number): Promise<OrderRow | undefined> {
  return await getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as OrderRow | undefined;
}

async function findOrderForClient(id: number, clientId: number): Promise<OrderRow | undefined> {
  return await getDb()
    .prepare("SELECT * FROM client_order WHERE id = ? AND client_id = ?")
    .get(id, clientId) as unknown as OrderRow | undefined;
}

async function hostingByOrder(order: OrderRow): Promise<HostingRow | undefined> {
  if (order.service_id === null || order.service_type !== "hosting") return undefined;
  return await getDb().prepare("SELECT * FROM service_hosting WHERE id = ?").get(order.service_id) as unknown as
    | HostingRow
    | undefined;
}

function assertUsable(order: OrderRow): void {
  if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) {
    throw new FbError("Subscription expired");
  }
}

function performOnService(order: OrderRow): boolean {
  if (BAD_STATUSES.includes(order.status)) return false;
  if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) return false;
  return true;
}

async function getServiceAdmin(ctx: CallContext): Promise<[OrderRow, HostingRow]> {
  if (!ctx.params["order_id"]) throw new FbError("Order ID name is missing");
  const order = await findOrder(Number(ctx.params["order_id"]));
  if (!order) throw new FbError("Order not found");
  const svc = await hostingByOrder(order);
  if (!svc) throw new FbError("Order is not activated");
  return [order, svc];
}

async function getServiceClient(ctx: CallContext): Promise<[OrderRow, HostingRow]> {
  if (!ctx.params["order_id"]) throw new FbError("Order ID is required");
  const order = await findOrderForClient(Number(ctx.params["order_id"]), ctx.session!.client!.id);
  if (!order) throw new FbError("Order not found");
  assertUsable(order);
  const svc = await hostingByOrder(order);
  if (!svc || order.status !== "active") throw new FbError("Order is not activated");
  return [order, svc];
}

async function getServer(id: number): Promise<ServerRow> {
  const row = await getDb().prepare("SELECT * FROM service_hosting_server WHERE id = ?").get(id) as unknown as
    | ServerRow
    | undefined;
  if (!row) throw new FbError("Server not found");
  return row;
}

async function getHp(id: number): Promise<HpRow> {
  const row = await getDb().prepare("SELECT * FROM service_hosting_hp WHERE id = ?").get(id) as unknown as
    | HpRow
    | undefined;
  if (!row) throw new FbError("Hosting plan not found");
  return row;
}

// --- Manager dispatch (Hestia + Custom only) ---

const HESTIA_FORM = {
  label: "Hestia Control Panel",
  form: {
    credentials: {
      fields: [
        {
          name: "username",
          type: "text",
          label: "Access Key ID",
          placeholder: "ID for the access key you've generated in Hestia.",
          required: true,
          secret: true,
        },
        {
          name: "accesshash",
          type: "text",
          label: "Secret Key",
          placeholder: "Secret key for the access key you've generated in Hestia",
          required: true,
          secret: true,
        },
      ],
    },
  },
};

const CUSTOM_FORM = { label: "Custom Server Manager" };

function managerForm(manager: string): Record<string, unknown> | null {
  if (manager === "Hestia") return HESTIA_FORM;
  if (manager === "Custom") return CUSTOM_FORM;
  return null;
}

function managerSecretFields(manager: string): string[] {
  const base = ["password", "accesshash"];
  const form = managerForm(manager);
  const fields = (form?.["form"] as Record<string, unknown> | undefined)?.["credentials"] as
    | Record<string, unknown>
    | undefined;
  const list = fields?.["fields"] as { name?: string; secret?: boolean }[] | undefined;
  if (list) {
    for (const f of list) {
      if (f.secret && f.name) base.push(f.name);
    }
  }
  return [...new Set(base)];
}

function hestiaPort(server: ServerRow): number {
  return normalizePort(server.port, 8083) ?? 8083;
}

/** Hestia /api/ POST. Throws FbError on transport failure. */
async function hestiaRequest(server: ServerRow, params: Record<string, string>): Promise<string> {
  const cfg = parseJson<Record<string, unknown>>(server.config, {});
  const verifyTls = normalizeBoolean(cfg["tls_verify"] ?? true, true);
  const url = `https://${server.hostname}:${hestiaPort(server)}/api/`;
  const body = new URLSearchParams({ ...params, returncode: "yes" });
  if (server.accesshash && server.username) body.set("hash", `${server.username}:${server.accesshash}`);
  else if (server.accesshash) body.set("hash", server.accesshash);
  else {
    body.set("user", server.username ?? "");
    body.set("password", server.password ?? "");
  }
  // Node fetch ignores the sandbox proxy env, so an unreachable panel
  // fails here with a transport error while PHP's client reports a TLS
  // error — parity compares these by error presence + code, not text.
  void verifyTls;
  const ctrl = new AbortController();
  // 10s, not 30s: a panel that cannot be reached must fail before any
  // caller's own 30s deadline, or the abort races the client timeout.
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { method: "POST", body, signal: ctrl.signal });
    const text = await res.text();
    if (text.includes("Error")) {
      throw new FbError("Failed to connect to the HestiaCP server. Please verify your credentials and configuration");
    }
    return text;
  } catch (e) {
    if (e instanceof FbError) throw e;
    throw new FbError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

function managerLoginUrls(server: ServerRow): [string | false, string | false] {
  if (server.manager === "Hestia") {
    if (!server.hostname || server.hostname.trim() === "") return [false, false];
    const url = `https://${server.hostname}:${hestiaPort(server)}/`;
    return [url, url];
  }
  if (server.manager === "Custom") return ["http://www.google.com?q=cpanel", "http://www.google.com?q=whm"];
  return [false, false];
}

function serverToApi(row: ServerRow, isAdmin: boolean): Record<string, unknown> {
  const [cpanelUrl, whmUrl] = managerLoginUrls(row);
  const out: Record<string, unknown> = {
    name: row.name,
    hostname: row.hostname,
    ip: row.ip,
    ns1: row.ns1,
    ns2: row.ns2,
    ns3: row.ns3,
    ns4: row.ns4,
    cpanel_url: cpanelUrl,
    reseller_cpanel_url: whmUrl,
  };
  if (isAdmin) {
    out["id"] = row.id;
    // Doctrine boolean columns preserve NULL (a server created without
    // a secure value reports secure: null, not false).
    out["active"] = row.active === null ? null : !!row.active;
    out["secure"] = row.secure === null ? null : !!row.secure;
    out["assigned_ips"] = parseJson<unknown[]>(row.assigned_ips, []);
    out["status_url"] = row.status_url;
    out["max_accounts"] = row.max_accounts;
    out["manager"] = row.manager;
    out["config"] = parseJson<unknown>(row.config, []);
    out["port"] = normalizePort(row.port, null);
    out["passwordLength"] = row.password_length;
    out["created_at"] = row.created_at;
    out["updated_at"] = row.updated_at;
    const secrets = managerSecretFields(row.manager ?? "");
    for (const field of secrets) {
      const raw = field === "password" ? row.password : field === "accesshash" ? row.accesshash : field === "username" ? row.username : null;
      out[field] = null;
      out[`${field}_set`] = raw !== null && raw !== "";
    }
    out["secret_fields"] = secrets;
  }
  return out;
}

function hpToApi(row: HpRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    bandwidth: row.bandwidth,
    quota: row.quota,
    max_ftp: row.max_ftp,
    max_sql: row.max_sql,
    max_pop: row.max_pop,
    max_sub: row.max_sub,
    max_park: row.max_park,
    max_addon: row.max_addon,
    config: row.config === null ? null : parseJson<unknown>(row.config, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function usageStats(column: string, id: number): Promise<{ total: number; active: number; orphaned: number; orphanedIds: number[] }> {
  const rows = await getDb().prepare(`SELECT id FROM service_hosting WHERE ${column} = ?`).all(id) as unknown as { id: number }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { total: 0, active: 0, orphaned: 0, orphanedIds: [] };
  const ph = ids.map(() => "?").join(",");
  const activeRows = await getDb()
    .prepare(`SELECT DISTINCT service_id FROM client_order WHERE service_type = 'hosting' AND service_id IN (${ph})`)
    .all(...ids) as unknown as { service_id: number }[];
  const activeSet = new Set(activeRows.map((r) => r.service_id));
  const orphanedIds = ids.filter((i) => !activeSet.has(i));
  return { total: ids.length, active: activeSet.size, orphaned: orphanedIds.length, orphanedIds };
}

function sortClause(params: Record<string, string>, allowed: Record<string, string>): string {
  const col = params["sort"] && allowed[params["sort"]] ? allowed[params["sort"]] : "id";
  const dir = (params["direction"] ?? "").toUpperCase() === "DESC" ? "DESC" : "ASC";
  return `${col} ${dir}`;
}

// --- Registrations ---

register("admin", "servicehosting", "manager_get_pairs", (ctx) => {
  requireAdmin(ctx);
  // D7 cut: only the kept managers, in PHP's Finder sort order.
  return { Custom: CUSTOM_FORM, Hestia: HESTIA_FORM };
});

register("admin", "servicehosting", "server_get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT id, name FROM service_hosting_server ORDER BY id ASC").all() as unknown as {
    id: number;
    name: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.id)] = r.name;
  // PHP json-encodes an empty pairs array as [], not {}.
  return Object.keys(out).length > 0 ? out : [];
});

register("admin", "servicehosting", "server_get_list", async (ctx) => {
  requireAdmin(ctx);
  const order = sortClause(ctx.params, { id: "id", name: "name", ip: "ip", hostname: "hostname" });
  const rows = await getDb().prepare(`SELECT * FROM service_hosting_server ORDER BY ${order}`).all() as unknown as ServerRow[];
  return paginate(rows.map((r) => serverToApi(r, true)), ctx.params);
});

register("admin", "servicehosting", "server_get", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Server ID was not passed");
  return serverToApi(await getServer(Number(ctx.params["id"])), true);
});

function serverConfigFrom(ctx: CallContext, existing: Record<string, unknown> | null): Record<string, unknown> {
  const cfg: Record<string, unknown> = { ...(existing ?? {}) };
  const raw = (ctx.rawParams as Record<string, unknown>)["config"];
  if (raw !== null && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) cfg[k] = v;
  }
  // Api always sends userprefix/tls_verify as top-level params.
  if (ctx.params["userprefix"] !== undefined) cfg["userprefix"] = ctx.params["userprefix"] || null;
  const tls = (ctx.rawParams as Record<string, unknown>)["tls_verify"] ?? ctx.params["tls_verify"];
  if (tls !== undefined) cfg["tls_verify"] = normalizeBoolean(tls, true);
  return cfg;
}

register("admin", "servicehosting", "server_create", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["name"]) throw new FbError("Server name was not passed");
  if (!ctx.params["ip"]) throw new FbError("Server IP was not passed");
  if (!ctx.params["manager"]) throw new FbError("Server manager was not specified");
  const manager = ctx.params["manager"];
  if (!KEPT_MANAGERS.includes(manager)) {
    throw new FbError(`Server manager ${manager} is not a valid server manager`);
  }
  const assigned = typeof ctx.params["assigned_ips"] === "string" ? ctx.params["assigned_ips"] : "";
  const cfg = serverConfigFrom(ctx, null);
  if (cfg["tls_verify"] === undefined) cfg["tls_verify"] = true;
  if (cfg["userprefix"] === undefined) cfg["userprefix"] = null;
  const port = normalizePort(ctx.params["port"] ?? (ctx.rawParams as Record<string, unknown>)["port"], null);
  const pwLenRaw = ctx.params["passwordLength"] ?? (ctx.rawParams as Record<string, unknown>)["passwordLength"];
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO service_hosting_server (name, ip, hostname, assigned_ips, status_url, active, max_accounts,
       ns1, ns2, ns3, ns4, manager, username, password, accesshash, password_length, port, config, secure,
       created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.params["name"], ctx.params["ip"], ctx.params["hostname"] ?? null, assigned !== "" ? processAssignedIPs(assigned) : null, ctx.params["status_url"] ?? null, normalizeBoolean(ctx.params["active"] ?? (ctx.rawParams as Record<string, unknown>)["active"] ?? true) ? 1 : 0, ctx.params["max_accounts"] !== undefined ? Number(ctx.params["max_accounts"]) : null, ctx.params["ns1"] ?? null, ctx.params["ns2"] ?? null, ctx.params["ns3"] ?? null, ctx.params["ns4"] ?? null, manager, ctx.params["username"] ?? null, ctx.params["password"] ?? null, ctx.params["accesshash"] ?? null, pwLenRaw !== undefined && !Number.isNaN(Number(pwLenRaw)) && String(pwLenRaw).trim() !== "" ? parseInt(String(pwLenRaw), 10) : null, port !== null ? String(port) : null, JSON.stringify(cfg), normalizeBoolean(ctx.params["secure"] ?? (ctx.rawParams as Record<string, unknown>)["secure"] ?? true) ? 1 : 0, ts, ts);
  return Number(info);
});

register("admin", "servicehosting", "server_update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Server ID was not passed");
  const row = await getServer(Number(ctx.params["id"]));
  const raw = ctx.rawParams as Record<string, unknown>;
  const next: ServerRow = { ...row };
  next.name = ctx.params["name"] ?? row.name;
  next.ip = ctx.params["ip"] ?? row.ip;
  next.hostname = ctx.params["hostname"] ?? row.hostname;
  const assigned = ctx.params["assigned_ips"];
  if (assigned !== undefined && assigned !== "") next.assigned_ips = processAssignedIPs(assigned);
  if (ctx.params["active"] !== undefined || raw["active"] !== undefined) {
    next.active = normalizeBoolean(raw["active"] ?? ctx.params["active"]) ? 1 : 0;
  }
  next.status_url = ctx.params["status_url"] ?? row.status_url;
  if (ctx.params["max_accounts"] !== undefined || raw["max_accounts"] !== undefined) {
    const mv = raw["max_accounts"] ?? ctx.params["max_accounts"];
    next.max_accounts = mv === null || mv === "" ? null : Number(mv);
  }
  next.ns1 = ctx.params["ns1"] ?? row.ns1;
  next.ns2 = ctx.params["ns2"] ?? row.ns2;
  next.ns3 = ctx.params["ns3"] ?? row.ns3;
  next.ns4 = ctx.params["ns4"] ?? row.ns4;
  if (ctx.params["manager"] !== undefined) {
    if (!KEPT_MANAGERS.includes(ctx.params["manager"])) {
      throw new FbError(`Server manager ${ctx.params["manager"]} is not a valid server manager`);
    }
    next.manager = ctx.params["manager"];
  }
  const port = normalizePort(ctx.params["port"] ?? raw["port"], null);
  if (port !== null) next.port = String(port);
  const existingCfg = parseJson<Record<string, unknown>>(row.config, {});
  const newCfg = serverConfigFrom(ctx, existingCfg);
  next.config = JSON.stringify(newCfg);
  if (ctx.params["secure"] !== undefined || raw["secure"] !== undefined) {
    next.secure = normalizeBoolean(raw["secure"] ?? ctx.params["secure"]) ? 1 : 0;
  }
  const keep = (field: "username" | "password" | "accesshash", incoming: unknown): string | null => {
    if (incoming === null || incoming === undefined || typeof incoming !== "string") return row[field];
    if (incoming.trim() === "" || incoming === "__KEEP__") return row[field];
    return incoming;
  };
  next.username = keep("username", ctx.params["username"] ?? raw["username"]);
  next.password = keep("password", ctx.params["password"] ?? raw["password"]);
  next.accesshash = keep("accesshash", ctx.params["accesshash"] ?? raw["accesshash"]);
  const pwLenRaw = ctx.params["passwordLength"] ?? raw["passwordLength"];
  if (pwLenRaw !== undefined && pwLenRaw !== "" && !Number.isNaN(Number(pwLenRaw))) {
    next.password_length = parseInt(String(pwLenRaw), 10);
  }
  // PHP persists first, then validates the manager config (719 on
  // failure) — a failed validation still leaves the update in place.
  await getDbWrite()
    .prepare(
      `UPDATE service_hosting_server SET name = ?, ip = ?, hostname = ?, assigned_ips = ?, status_url = ?,
       active = ?, max_accounts = ?, ns1 = ?, ns2 = ?, ns3 = ?, ns4 = ?, manager = ?, username = ?, password = ?,
       accesshash = ?, password_length = ?, port = ?, config = ?, secure = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.name, next.ip, next.hostname, next.assigned_ips, next.status_url, next.active, next.max_accounts,
      next.ns1, next.ns2, next.ns3, next.ns4, next.manager, next.username, next.password, next.accesshash,
      next.password_length, next.port, next.config, next.secure, nowTimestamp(), row.id,
    );
  if (next.manager === "Hestia" && (!next.hostname || next.hostname.trim() === "")) {
    throw new FbError(
      "The HestiaCP server hostname is missing. Please configure it in the server settings.",
      719,
    );
  }
  if (next.manager !== null && !KEPT_MANAGERS.includes(next.manager)) {
    throw new FbError(`Server manager ${next.manager} is invalid.`, 719);
  }
  return true;
});

register("admin", "servicehosting", "server_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Server ID was not passed");
  const row = await getServer(Number(ctx.params["id"]));
  const usages = await getDb()
    .prepare("SELECT COUNT(*) AS c FROM service_hosting WHERE service_hosting_server_id = ?")
    .get(row.id) as unknown as { c: number };
  if (usages.c > 0) {
    const stats = await usageStats("service_hosting_server_id", row.id);
    if (stats.active > 0) {
      throw new FbError(`Hosting server is used by ${stats.active} service hostings`, 704);
    }
    const force = normalizeBoolean(ctx.params["force"] ?? (ctx.rawParams as Record<string, unknown>)["force"], false);
    if (!force) {
      throw new FbError(
        `Hosting server is used by ${stats.orphaned} orphaned service hostings with no linked order. Re-run with force=true to detach them and delete the server.`,
        704,
      );
    }
    for (const oid of stats.orphanedIds) {
      await getDbWrite().prepare("UPDATE service_hosting SET service_hosting_server_id = NULL WHERE id = ?").run(oid);
    }
  }
  await getDbWrite().prepare("DELETE FROM service_hosting_server WHERE id = ?").run(row.id);
  return true;
});

register("admin", "servicehosting", "server_test_connection", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Server ID was not passed");
  const row = await getServer(Number(ctx.params["id"]));
  if (row.manager === "Custom") return true;
  if (row.manager !== "Hestia") throw new FbError(`Server manager ${row.manager} is invalid.`);
  if (!row.hostname || row.hostname.trim() === "") {
    throw new FbError("The HestiaCP server hostname is missing. Please configure it in the server settings.");
  }
  const result = await hestiaRequest(row, {
    cmd: "v-list-users",
    arg1: row.username ?? "",
    arg2: row.password ?? "",
  });
  if (parseInt(result, 10) !== 0) {
    throw new FbError("Failed to connect to the HestiaCP server. Please verify your credentials and configuration");
  }
  return true;
});

register("admin", "servicehosting", "hp_get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT id, name FROM service_hosting_hp ORDER BY id ASC").all() as unknown as {
    id: number;
    name: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.id)] = r.name;
  // PHP json-encodes an empty pairs array as [], not {}.
  return Object.keys(out).length > 0 ? out : [];
});

register("admin", "servicehosting", "hp_get_list", async (ctx) => {
  requireAdmin(ctx);
  const order = sortClause(ctx.params, { id: "id", name: "name" });
  const rows = await getDb().prepare(`SELECT * FROM service_hosting_hp ORDER BY ${order}`).all() as unknown as HpRow[];
  return paginate(rows.map(hpToApi), ctx.params);
});

register("admin", "servicehosting", "hp_get", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Hosting plan ID was not passed");
  return hpToApi(await getHp(Number(ctx.params["id"])));
});

register("admin", "servicehosting", "hp_create", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["name"]) throw new FbError("Hosting plan name was not passed");
  const ts = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO service_hosting_hp (name, bandwidth, quota, max_addon, max_park, max_sub, max_pop, max_sql,
       max_ftp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.params["name"], String(ctx.params["bandwidth"] ?? 1024 * 1024), String(ctx.params["quota"] ?? 1024 * 1024), String(ctx.params["max_addon"] ?? 1), String(ctx.params["max_park"] ?? 1), String(ctx.params["max_sub"] ?? 1), String(ctx.params["max_pop"] ?? 1), String(ctx.params["max_sql"] ?? 1), String(ctx.params["max_ftp"] ?? 1), ts, ts);
  return Number(info);
});

register("admin", "servicehosting", "hp_update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Hosting plan ID was not passed");
  const row = await getHp(Number(ctx.params["id"]));
  const raw = ctx.rawParams as Record<string, unknown>;
  const next: HpRow = { ...row };
  next.name = ctx.params["name"] ?? row.name;
  next.bandwidth = ctx.params["bandwidth"] ?? row.bandwidth;
  next.quota = ctx.params["quota"] ?? row.quota;
  next.max_addon = ctx.params["max_addon"] ?? row.max_addon;
  next.max_ftp = ctx.params["max_ftp"] ?? row.max_ftp;
  next.max_sql = ctx.params["max_sql"] ?? row.max_sql;
  next.max_pop = ctx.params["max_pop"] ?? row.max_pop;
  next.max_sub = ctx.params["max_sub"] ?? row.max_sub;
  next.max_park = ctx.params["max_park"] ?? row.max_park;
  const config = parseJson<Record<string, unknown>>(row.config, {});
  const inConfig =
    raw["config"] !== null && typeof raw["config"] === "object"
      ? (raw["config"] as Record<string, unknown>)
      : (() => {
          // Form posts do not expand brackets: config[k]=v arrives as
          // literal keys, but PHP sees a config array.
          const out: Record<string, unknown> = {};
          let found = false;
          for (const [k, v] of Object.entries(ctx.params)) {
            const m = /^config\[([^\]]+)\]$/.exec(k);
            if (m) {
              out[m[1]] = v;
              found = true;
            }
          }
          return found ? out : undefined;
        })();
  if (inConfig) {
    for (const [k, v] of Object.entries(inConfig)) {
      const empty = v === "" || v === 0 || v === "0" || v === null || v === false;
      if (empty) delete config[k];
      else config[k] = v;
    }
  }
  const newName = ctx.params["new_config_name"] ?? raw["new_config_name"];
  const newValue = ctx.params["new_config_value"] ?? raw["new_config_value"];
  if (newName && newValue) config[String(newName)] = newValue;
  next.config = JSON.stringify(config);
  await getDbWrite()
    .prepare(
      `UPDATE service_hosting_hp SET name = ?, bandwidth = ?, quota = ?, max_addon = ?, max_ftp = ?, max_sql = ?,
       max_pop = ?, max_sub = ?, max_park = ?, config = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.name, next.bandwidth, next.quota, next.max_addon, next.max_ftp, next.max_sql, next.max_pop,
      next.max_sub, next.max_park, next.config, nowTimestamp(), row.id,
    );
  return true;
});

register("admin", "servicehosting", "hp_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Hosting plan ID was not passed");
  const row = await getHp(Number(ctx.params["id"]));
  const usages = await getDb()
    .prepare("SELECT COUNT(*) AS c FROM service_hosting WHERE service_hosting_hp_id = ?")
    .get(row.id) as unknown as { c: number };
  if (usages.c > 0) {
    const stats = await usageStats("service_hosting_hp_id", row.id);
    if (stats.active > 0) {
      throw new FbError(`Hosting plan is used by ${stats.active} service hostings`, 704);
    }
    const force = normalizeBoolean(ctx.params["force"] ?? (ctx.rawParams as Record<string, unknown>)["force"], false);
    if (!force) {
      throw new FbError(
        `Hosting plan is used by ${stats.orphaned} orphaned service hostings with no linked order. Re-run with force=true to detach them and delete the plan.`,
        704,
      );
    }
    for (const oid of stats.orphanedIds) {
      await getDbWrite().prepare("UPDATE service_hosting SET service_hosting_hp_id = NULL WHERE id = ?").run(oid);
    }
  }
  await getDbWrite().prepare("DELETE FROM service_hosting_hp WHERE id = ?").run(row.id);
  return true;
});

register("admin", "servicehosting", "account_get_list", async (ctx) => {
  requireAdmin(ctx);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (ctx.params["server_id"] && ctx.params["server_id"] !== "0") {
    where.push("service_hosting_server_id = ?");
    args.push(ctx.params["server_id"]);
  }
  const order = sortClause(ctx.params, {
    id: "id",
    username: "username",
    sld: "sld",
    tld: "tld",
    ip: "ip",
    created_at: "created_at",
  });
  const rows = await getDb()
    .prepare(`SELECT * FROM service_hosting ${where.length ? `WHERE ${where.join(" AND ")} ` : ""}ORDER BY ${order}`)
    .all(...args) as unknown as HostingRow[];
  const serviceIds = rows.map((r) => r.id);
  const orderByService = new Map<number, OrderRow>();
  if (serviceIds.length > 0) {
    const ph = serviceIds.map(() => "?").join(",");
    const orders = await getDb()
      .prepare(`SELECT * FROM client_order WHERE service_type = 'hosting' AND service_id IN (${ph}) ORDER BY id ASC`)
      .all(...serviceIds) as unknown as OrderRow[];
    for (const o of orders) {
      if (o.service_id !== null && !orderByService.has(o.service_id)) orderByService.set(o.service_id, o);
    }
  }
  const orderIds = [...orderByService.values()].map((o) => o.id);
  const metaByOrder = new Map<number, Record<string, unknown>>();
  const ticketsByOrder = new Map<number, number>();
  if (orderIds.length > 0) {
    const ph = orderIds.map(() => "?").join(",");
    const metas = await getDb()
      .prepare(`SELECT client_order_id, name, value FROM client_order_meta WHERE client_order_id IN (${ph})`)
      .all(...orderIds) as unknown as { client_order_id: number; name: string; value: string }[];
    for (const m of metas) {
      if (!metaByOrder.has(m.client_order_id)) metaByOrder.set(m.client_order_id, {});
      metaByOrder.get(m.client_order_id)![m.name] = m.value;
    }
    const tickets = await getDb()
      .prepare(
        `SELECT rel_id, COUNT(id) AS c FROM support_ticket WHERE rel_type = 'order' AND rel_id IN (${ph}) AND (status = 'open' OR status = 'on_hold') GROUP BY rel_id`,
      )
      .all(...orderIds) as unknown as { rel_id: number; c: number }[];
    for (const t of tickets) ticketsByOrder.set(t.rel_id, t.c);
  }
  const mapped = await Promise.all(rows.map(async (r) => {
    const item: Record<string, unknown> = {
      id: r.id,
      sld: r.sld,
      tld: r.tld,
      client_id: r.client_id,
      server_id: r.service_hosting_server_id,
      plan_id: r.service_hosting_hp_id,
      reseller: r.reseller,
      ip: r.ip,
      username: r.username,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
    const order = orderByService.get(r.id);
    if (!order) {
      item["order"] = null;
      return item;
    }
    const client = await getDb().prepare("SELECT * FROM client WHERE id = ?").get(order.client_id) as unknown as
      | Parameters<typeof clientBlock>[0]
      | undefined;
    const product = await getDb().prepare("SELECT plugin FROM product WHERE id = ?").get(order.product_id) as unknown as
      | { plugin: string | null }
      | undefined;
    const orderOut: Record<string, unknown> = {
      ...order,
      config: parseJson<unknown>(order.config, []),
      total: Number(order.price ?? 0) * Number(order.quantity ?? 0),
      meta: metaByOrder.get(order.id) ?? [],
      active_tickets: ticketsByOrder.get(order.id) ?? 0,
      plugin: product?.plugin ?? null,
    };
    item["client"] = client ? clientBlock(client) : null;
    item["order"] = orderOut;
    return item;
  }));
  return paginate(mapped, ctx.params);
});

register("admin", "servicehosting", "_getService", async (ctx) => {
  requireAdmin(ctx);
  await getServiceAdmin(ctx);
  return [{}, {}];
});

register("client", "servicehosting", "_getService", async (ctx) => {
  requireClient(ctx);
  await getServiceClient(ctx);
  return [{}, {}];
});

register("admin", "servicehosting", "update", async (ctx) => {
  requireAdmin(ctx);
  const [, svc] = await getServiceAdmin(ctx);
  const patch: Partial<HostingRow> = {};
  if (ctx.params["username"]) patch.username = ctx.params["username"];
  if (ctx.params["ip"]) patch.ip = ctx.params["ip"];
  if (Object.keys(patch).length > 0) {
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
    await getDbWrite()
      .prepare(`UPDATE service_hosting SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...(Object.values(patch) as (string | number | null)[]), nowTimestamp(), svc.id);
  }
  return true;
});

async function changeAccount(
  ctx: CallContext,
  kind: "plan" | "username" | "ip" | "domain" | "password",
  getService: (ctx: CallContext) => [OrderRow, HostingRow] | Promise<[OrderRow, HostingRow]>,
): Promise<boolean> {
  const [order, svc] = await getService(ctx);
  const perform = performOnService(order);
  // _getAM runs only under perform: it throws when the linked server,
  // plan, or client row is missing.
  let server: ServerRow | null = null;
  if (perform) {
    if (svc.service_hosting_server_id === null) throw new FbError("Server not found");
    server = await getServer(svc.service_hosting_server_id);
    if (svc.service_hosting_hp_id === null) throw new FbError("Hosting plan not found");
    await getHp(svc.service_hosting_hp_id);
    const client = await getDb().prepare("SELECT id FROM client WHERE id = ?").get(svc.client_id);
    if (!client) throw new FbError("Client not found");
  } else if (svc.service_hosting_server_id !== null) {
    // Non-perform path never touches the manager: a dangling server id
    // must not throw here.
    server = await getDb().prepare("SELECT * FROM service_hosting_server WHERE id = ?").get(svc.service_hosting_server_id) as unknown as ServerRow | undefined ?? null;
  }
  const manager = server?.manager ?? null;
  if (kind === "plan") {
    if (!ctx.params["plan_id"]) throw new FbError("plan_id is missing");
    const hp = await getHp(Number(ctx.params["plan_id"]));
    if (perform && manager === "Hestia" && server) {
      await hestiaRequest(server, {
        cmd: "v-change-user-package",
        arg1: svc.username ?? "",
        arg2: hp.name ?? "",
        arg3: "no",
      }).then((result) => {
        if (parseInt(result, 10) !== 0) {
          throw new FbError("Failed to change account package on the HestiaCP server, check the error logs for further details");
        }
      });
    }
    await getDbWrite()
      .prepare("UPDATE service_hosting SET service_hosting_hp_id = ?, updated_at = ? WHERE id = ?")
      .run(hp.id, nowTimestamp(), svc.id);
    return true;
  }
  if (kind === "username") {
    const u = ctx.params["username"];
    if (!u) throw new FbError("Account username is missing or is invalid");
    const lower = u.toLowerCase();
    if (perform) {
      if (manager === "Hestia") throw new FbError("HestiaCP does not support username changes");
      if (manager !== "Custom" && manager !== null) throw new FbError(`Server manager ${manager} is invalid.`);
    }
    await getDbWrite()
      .prepare("UPDATE service_hosting SET username = ?, updated_at = ? WHERE id = ?")
      .run(lower, nowTimestamp(), svc.id);
    return true;
  }
  if (kind === "ip") {
    const ip = ctx.params["ip"];
    if (!ip) throw new FbError("Account IP address is missing or is invalid");
    if (perform) {
      if (manager === "Hestia") throw new FbError("HestiaCP does not support changing the account IP");
      if (manager !== "Custom" && manager !== null) throw new FbError(`Server manager ${manager} is invalid.`);
    }
    await getDbWrite()
      .prepare("UPDATE service_hosting SET ip = ?, updated_at = ? WHERE id = ?")
      .run(ip, nowTimestamp(), svc.id);
    return true;
  }
  if (kind === "domain") {
    const sld = ctx.params["sld"];
    const tld = ctx.params["tld"];
    if (!sld || !tld) throw new FbError("Domain SLD or TLD is missing");
    if (perform) {
      if (manager === "Hestia") throw new FbError("HestiaCP does not support changing the account domain");
      if (manager !== "Custom" && manager !== null) throw new FbError(`Server manager ${manager} is invalid.`);
    }
    await getDbWrite()
      .prepare("UPDATE service_hosting SET sld = ?, tld = ?, updated_at = ? WHERE id = ?")
      .run(sld, tld, nowTimestamp(), svc.id);
    return true;
  }
  // password
  const pw = ctx.params["password"];
  const pwc = ctx.params["password_confirm"];
  if (pw === undefined || pwc === undefined || pw !== pwc) {
    throw new FbError("Account password is missing or is invalid");
  }
  if (perform && manager === "Hestia" && server) {
    await hestiaRequest(server, { cmd: "v-change-user-password", arg1: svc.username ?? "", arg2: pw }).then(
      (result) => {
        if (parseInt(result, 10) !== 0) {
          throw new FbError("Failed to change account password on the HestiaCP server, check the error logs for further details");
        }
      },
    );
  }
  if (perform && manager !== "Hestia" && manager !== "Custom" && manager !== null) {
    throw new FbError(`Server manager ${manager} is invalid.`);
  }
  await getDbWrite()
    .prepare("UPDATE service_hosting SET pass = ?, updated_at = ? WHERE id = ?")
    .run(PASSWORD_PLACEHOLDER, nowTimestamp(), svc.id);
  return true;
}

register("admin", "servicehosting", "change_plan", (ctx) => {
  requireAdmin(ctx);
  return changeAccount(ctx, "plan", getServiceAdmin);
});
register("admin", "servicehosting", "change_username", (ctx) => {
  requireAdmin(ctx);
  return changeAccount(ctx, "username", getServiceAdmin);
});
register("admin", "servicehosting", "change_ip", (ctx) => {
  requireAdmin(ctx);
  return changeAccount(ctx, "ip", getServiceAdmin);
});
register("admin", "servicehosting", "change_domain", (ctx) => {
  requireAdmin(ctx);
  return changeAccount(ctx, "domain", getServiceAdmin);
});
register("admin", "servicehosting", "change_password", (ctx) => {
  requireAdmin(ctx);
  return changeAccount(ctx, "password", getServiceAdmin);
});
register("client", "servicehosting", "change_username", (ctx) => {
  requireClient(ctx);
  return changeAccount(ctx, "username", getServiceClient);
});
register("client", "servicehosting", "change_domain", (ctx) => {
  requireClient(ctx);
  return changeAccount(ctx, "domain", getServiceClient);
});
register("client", "servicehosting", "change_password", (ctx) => {
  requireClient(ctx);
  return changeAccount(ctx, "password", getServiceClient);
});

register("admin", "servicehosting", "sync", async (ctx) => {
  requireAdmin(ctx);
  const [, svc] = await getServiceAdmin(ctx);
  if (svc.service_hosting_hp_id !== null) await getHp(svc.service_hosting_hp_id);
  if (svc.service_hosting_server_id !== null) await getServer(svc.service_hosting_server_id);
  const client = await getDb().prepare("SELECT id FROM client WHERE id = ?").get(svc.client_id);
  if (!client) throw new FbError("Client not found");
  // Both kept managers synchronize as a no-op clone: username/ip
  // never change, so there is nothing to persist.
  return true;
});

register("client", "servicehosting", "get_login_url", async (ctx) => {
  requireClient(ctx);
  const [, svc] = await getServiceClient(ctx);
  const server = svc.service_hosting_server_id !== null ? await getServer(svc.service_hosting_server_id) : null;
  if (!server) throw new FbError("Server not found");
  if (svc.service_hosting_hp_id === null) throw new FbError("Hosting plan not found");
  await getHp(svc.service_hosting_hp_id);
  const client = await getDb().prepare("SELECT id FROM client WHERE id = ?").get(svc.client_id);
  if (!client) throw new FbError("Client not found");
  const [url, resellerUrl] = managerLoginUrls(server);
  return svc.reseller ? resellerUrl : url;
});

register("client", "servicehosting", "hp_get_pairs", async (ctx) => {
  requireClient(ctx);
  const products = await getDb()
    .prepare("SELECT config FROM product WHERE type = 'hosting' AND active = 1 AND status = 'enabled' AND is_addon = 0")
    .all() as unknown as { config: string | null }[];
  const planIds = new Set<number>();
  for (const p of products) {
    const cfg = parseJson<Record<string, unknown>>(p.config, {});
    if (typeof cfg["hosting_plan_id"] === "number") planIds.add(cfg["hosting_plan_id"]);
    else if (typeof cfg["hosting_plan_id"] === "string" && /^\d+$/.test(cfg["hosting_plan_id"])) {
      planIds.add(Number(cfg["hosting_plan_id"]));
    }
  }
  const out: Record<string, string> = {};
  if (planIds.size > 0) {
    const ph = [...planIds].map(() => "?").join(",");
    const plans = await getDb().prepare(`SELECT id, name FROM service_hosting_hp WHERE id IN (${ph})`).all(...planIds) as unknown as {
      id: number;
      name: string;
    }[];
    for (const pl of plans) out[String(pl.id)] = pl.name;
  }
  return Object.keys(out).length > 0 ? out : [];
});

register("guest", "servicehosting", "free_tlds", async (ctx) => {
  if (!ctx.params["product_id"]) throw new FbError("Product ID is missing");
  const product = await getDb().prepare("SELECT * FROM product WHERE id = ?").get(Number(ctx.params["product_id"])) as unknown as
    | { type: string | null; config: string | null }
    | undefined;
  if (!product) throw new FbError("Product not found");
  if (product.type !== "hosting") throw new FbError("Product type is invalid");
  const cfg = parseJson<Record<string, unknown>>(product.config, {});
  const free = cfg["free_tlds"];
  if (Array.isArray(free) && free.length > 0) {
    return free.map((tld) => ({ tld }));
  }
  const rows = await getDb()
    .prepare("SELECT * FROM tld WHERE active = 1 AND allow_register = 1 ORDER BY id ASC")
    .all() as unknown as Parameters<typeof tldToApiArray>[0][];
  return await Promise.all(rows.map(async (r) => await tldToApiArray(r)));
});
