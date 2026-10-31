// Servicelicense — license service management and the guest license
// check callback (Server::process).
//
// Error-envelope rule pinned by capture24: the non-format-2 path lets
// LogicException failures propagate, and the dispatcher renders those
// as the generic "An unexpected error occurred. Please try again later."
// (9999) — never the LogicException message. format=2 instead returns
// the message/code inside the result. PHP TypeErrors (license update
// with a non-string list) surface verbatim with code 9998.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp } from "../db";

interface OrderRow {
  id: number;
  client_id: number;
  service_id: number | null;
  service_type: string | null;
  status: string;
  expires_at: string | null;
}

interface LicenseRow {
  id: number;
  client_id: number;
  license_key: string | null;
  validate_ip: number;
  validate_host: number;
  validate_path: number;
  validate_version: number;
  ips: string | null;
  hosts: string | null;
  paths: string | null;
  versions: string | null;
  config: string | null;
  plugin: string | null;
  checked_at: string | null;
  pinged_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const GENERIC_ERROR = "An unexpected error occurred. Please try again later.";

async function findOrder(id: number): Promise<OrderRow | undefined> {
  return await getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as OrderRow | undefined;
}

async function findOrderForClient(id: number, clientId: number): Promise<OrderRow | undefined> {
  return await getDb()
    .prepare("SELECT * FROM client_order WHERE id = ? AND client_id = ?")
    .get(id, clientId) as unknown as OrderRow | undefined;
}

async function licenseByOrder(order: OrderRow): Promise<LicenseRow | undefined> {
  if (order.service_id === null || order.service_type !== "license") return undefined;
  return await getDb().prepare("SELECT * FROM service_license WHERE id = ?").get(order.service_id) as unknown as
    | LicenseRow
    | undefined;
}

function assertUsable(order: OrderRow): void {
  if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) {
    throw new FbError("Subscription expired");
  }
}

async function getServiceAdmin(ctx: CallContext): Promise<LicenseRow> {
  if (!ctx.params["order_id"]) throw new FbError("Order ID is required");
  const order = await findOrder(Number(ctx.params["order_id"]));
  if (!order) throw new FbError("Order not found");
  const svc = await licenseByOrder(order);
  if (!svc) throw new FbError("Order is not activated");
  return svc;
}

async function getServiceClient(ctx: CallContext): Promise<LicenseRow> {
  if (!ctx.params["order_id"]) throw new FbError("Order ID is required");
  const order = await findOrderForClient(Number(ctx.params["order_id"]), ctx.session!.client!.id);
  if (!order) throw new FbError("Order not found");
  assertUsable(order);
  if (order.status !== "active") throw new FbError("Order is not activated");
  const svc = await licenseByOrder(order);
  if (!svc) throw new FbError("Order is not activated");
  return svc;
}

/** PHP (bool) cast, for both JSON natives (rawParams) and form strings. */
function phpBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0";
  return !!v;
}

/** Value for a key, preferring the JSON body over the stringified param. */
function pick(ctx: CallContext, key: string): unknown {
  const raw = (ctx.rawParams as Record<string, unknown>)[key];
  return raw !== undefined ? raw : ctx.params[key];
}

function typeName(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return "array"; // JSON objects decode to PHP assoc arrays
}

function parseList(json: string | null): string[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

async function storeLicense(svc: LicenseRow, patch: Partial<LicenseRow>): Promise<void> {
  const next = { ...svc, ...patch };
  await getDbWrite()
    .prepare(
      `UPDATE service_license SET plugin = ?, validate_ip = ?, validate_host = ?, validate_path = ?,
       validate_version = ?, license_key = ?, ips = ?, hosts = ?, paths = ?, versions = ?,
       pinged_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      next.plugin,
      next.validate_ip,
      next.validate_host,
      next.validate_path,
      next.validate_version,
      next.license_key,
      next.ips,
      next.hosts,
      next.paths,
      next.versions,
      next.pinged_at,
      nowTimestamp(),
      svc.id,
    );
}

register("admin", "servicelicense", "plugin_get_pairs", (ctx) => {
  requireAdmin(ctx);
  // R6c: vendored Plugin dir (apps/nextjs/vendor/php-modules/...);
  // an explicit FOSSBILLING_PHP_SRC override wins when it exists.
  const override = process.env.FOSSBILLING_PHP_SRC ?? "";
  const overrideDir = override ? join(override, "modules", "Servicelicense", "Plugin") : "";
  const dir =
    overrideDir && existsSync(overrideDir)
      ? overrideDir
      : join(process.cwd(), "vendor", "php-modules", "Servicelicense", "Plugin");
  const out: Record<string, string> = {};
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".php")) {
        const name = f.slice(0, -4);
        out[name] = name;
      }
    }
  } catch {
    // PHP's Finder on a missing dir throws; the reference tree always
    // has Plugin/Simple.php, so an empty map is only a fallback.
  }
  return Object.keys(out).length > 0 ? out : [];
});

register("admin", "servicelicense", "update", async (ctx) => {
  requireAdmin(ctx);
  const svc = await getServiceAdmin(ctx);
  const patch: Partial<LicenseRow> = {
    plugin: (pick(ctx, "plugin") as string | undefined) ?? svc.plugin,
    validate_ip: pick(ctx, "validate_ip") !== undefined ? (phpBool(pick(ctx, "validate_ip")) ? 1 : 0) : svc.validate_ip,
    validate_host:
      pick(ctx, "validate_host") !== undefined ? (phpBool(pick(ctx, "validate_host")) ? 1 : 0) : svc.validate_host,
    validate_path:
      pick(ctx, "validate_path") !== undefined ? (phpBool(pick(ctx, "validate_path")) ? 1 : 0) : svc.validate_path,
    validate_version:
      pick(ctx, "validate_version") !== undefined
        ? (phpBool(pick(ctx, "validate_version")) ? 1 : 0)
        : svc.validate_version,
  };
  const lk = pick(ctx, "license_key");
  if (typeof lk === "string" && lk !== "") patch.license_key = lk;
  for (const key of ["ips", "hosts", "paths", "versions"] as const) {
    // Form posts do not expand brackets: ips[0]=x arrives as a literal
    // key, but PHP sees ips as an array — and explode() on an array is
    // a TypeError. Mirror that instead of silently ignoring the field.
    const hasBracket = Object.keys(ctx.params).some((k) => k.startsWith(`${key}[`));
    const v = hasBracket ? [] : pick(ctx, key);
    if (v !== undefined) {
      if (typeof v !== "string") {
        throw new FbError(
          `explode(): Argument #2 ($string) must be of type string, ${typeName(v)} given`,
          9998,
        );
      }
      patch[key] = JSON.stringify(v.split("\n").map((s) => s.trim()).filter((s) => s !== ""));
    }
  }
  await storeLicense(svc, patch);
  return true;
});

register("admin", "servicelicense", "reset", async (ctx) => {
  requireAdmin(ctx);
  const svc = await getServiceAdmin(ctx);
  await storeLicense(svc, { ips: "[]", hosts: "[]", paths: "[]", versions: "[]" });
  return true;
});

register("client", "servicelicense", "reset", async (ctx) => {
  requireClient(ctx);
  const svc = await getServiceClient(ctx);
  await storeLicense(svc, { ips: "[]", hosts: "[]", paths: "[]", versions: "[]" });
  return true;
});

register("admin", "servicelicense", "_getService", async (ctx) => {
  requireAdmin(ctx);
  await getServiceAdmin(ctx);
  return {}; // PHP returns the bare entity, which serializes as {}
});

register("client", "servicelicense", "_getService", async (ctx) => {
  requireClient(ctx);
  await getServiceClient(ctx);
  return {};
});

// --- Guest license check (Server::process) ---

class LogicFailure extends Error {
  constructor(
    message: string,
    readonly logicCode: number,
  ) {
    super(message);
  }
}

async function findLicenseByKey(key: string): Promise<LicenseRow | undefined> {
  return await getDb().prepare("SELECT * FROM service_license WHERE license_key = ?").get(key) as unknown as
    | LicenseRow
    | undefined;
}

async function findOrderForLicense(lic: LicenseRow): Promise<OrderRow | undefined> {
  return await getDb()
    .prepare("SELECT * FROM client_order WHERE service_type = 'license' AND service_id = ? ORDER BY id ASC LIMIT 1")
    .get(lic.id) as unknown as OrderRow | undefined;
}

async function isLicenseActive(lic: LicenseRow): Promise<boolean> {
  const order = await findOrderForLicense(lic);
  if (!order) return false;
  if (order.status !== "active") return false;
  if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) return false;
  return true;
}

/** isValid*: append-and-true when the list is empty or validation is off. */
async function isValid(lic: LicenseRow, listKey: "ips" | "hosts" | "paths" | "versions", flag: number, value: string): Promise<boolean> {
  const list = parseList(lic[listKey]);
  if (list.length === 0 || !flag) {
    const next = [...new Set([...list, value])];
    await getDbWrite().prepare(`UPDATE service_license SET ${listKey} = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(next),
      nowTimestamp(),
      lic.id,
    );
    return true;
  }
  return list.includes(value);
}

register("guest", "servicelicense", "check", async (ctx) => {
  const format2 = ctx.params["format"] === "2" || (ctx.rawParams as Record<string, unknown>)["format"] === 2;
  const fail = (e: LogicFailure) => {
    if (format2) {
      return {
        licensed_to: null,
        created_at: null,
        expires_at: null,
        valid: false,
        error: e.message,
        error_code: e.logicCode,
      };
    }
    throw new FbError(GENERIC_ERROR);
  };
  try {
    const p = ctx.params;
    const licenseKey = p["license"];
    if (!licenseKey) throw new LogicFailure("License key is not present in call", 1001);
    const lic = await findLicenseByKey(licenseKey);
    if (!lic) throw new LogicFailure("Your license key is invalid.", 1005);
    // pinged_at is stamped before the remaining validations (PHP order).
    await storeLicense(lic, { pinged_at: nowTimestamp() });
    const host = p["host"];
    if (!host) throw new LogicFailure("Host key is not present in call", 1002);
    const version = p["version"];
    if (!version) throw new LogicFailure("Version key is not present in call", 1003);
    const path = p["path"];
    if (!path) throw new LogicFailure("Path key is not present in call", 1004);
    if (!await isLicenseActive(lic)) throw new LogicFailure("License is not active", 1006);
    if (!await isValid(lic, "ips", lic.validate_ip, ctx.ip)) {
      throw new LogicFailure(`Ip "${ctx.ip}" is not allowed for this license`, 1007);
    }
    if (!await isValid(lic, "hosts", lic.validate_host, host)) {
      throw new LogicFailure(`Host "${host}" is not allowed for this license`, 1008);
    }
    if (!await isValid(lic, "versions", lic.validate_version, version)) {
      throw new LogicFailure(`Version "${version}" is invalid for this license`, 1009);
    }
    if (!await isValid(lic, "paths", lic.validate_path, path)) {
      throw new LogicFailure(`Software install path "${path}" is invalid for this license`, 1010);
    }
    const client = await getDb().prepare("SELECT first_name, last_name FROM client WHERE id = ?").get(lic.client_id) as
      | { first_name: string | null; last_name: string | null }
      | undefined;
    const licensedTo = client ? `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() : "";
    const order = await findOrderForLicense(lic);
    const result: Record<string, unknown> = {
      licensed_to: licensedTo,
      created_at: lic.created_at,
      expires_at: order ? (order.expires_at ?? null) : nowTimestamp(),
      valid: true,
    };
    if (format2) {
      result["error"] = null;
      result["error_code"] = null;
    }
    return result;
  } catch (e) {
    if (e instanceof LogicFailure) return fail(e);
    throw e;
  }
});
