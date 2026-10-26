import { randomBytes, randomInt } from "node:crypto";
import { findOrderById, getDb, getDbWrite, isModuleActive } from "../db";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { phpInt } from "./formbuilder";

/**
 * Serviceapikey module — TS port of Serviceapikey/Api/Admin.php,
 * Client.php, Guest.php + Service.php, behind the module-active
 * gate: on the reference install serviceapikey is NOT installed
 * (and its table does not exist), so PHP answers 715 and so does
 * this handler. The real logic behind the gate is implemented but
 * unverified-live until the module is installed.
 */

function requireApikeyActive(): void {
  if (!isModuleActive("serviceapikey")) {
    throw new FbError("FOSSBilling module serviceapikey is not installed/activated", 715);
  }
}

interface ApiKeyRow {
  id: number;
  client_id: number | null;
  api_key: string | null;
  config: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function findKeyByApiKey(key: string): ApiKeyRow | undefined {
  return getDb().prepare("SELECT * FROM service_apikey WHERE api_key = ?").get(key) as unknown as
    | ApiKeyRow
    | undefined;
}

function findKeyById(id: number): ApiKeyRow | undefined {
  return getDb().prepare("SELECT * FROM service_apikey WHERE id = ?").get(id) as unknown as
    | ApiKeyRow
    | undefined;
}

/** Order Service::getOrderService for the apikey service type. */
function modelForOrder(orderId: number): ApiKeyRow | undefined {
  const order = findOrderById(orderId);
  if (!order) throw new FbError("Order not found");
  if (order.service_type !== "apikey" || order.service_id === null) return undefined;
  return findKeyById(order.service_id);
}

function isActive(model: ApiKeyRow): boolean {
  const order = getDb()
    .prepare("SELECT * FROM client_order WHERE service_id = ? AND service_type = 'apikey'")
    .get(model.id) as unknown as { status: string; expires_at: string | null } | undefined;
  if (!order) throw new FbError("API key does not exist");
  if (order.status !== "active") return false;
  if (order.expires_at !== null && Date.parse(order.expires_at) <= Date.now()) return false;
  return true;
}

function generateKey(config: Record<string, unknown>): string {
  const length = (config["length"] as number | undefined) ?? 32;
  const split = (config["split"] as boolean | undefined) ?? true;
  const splitLength = (config["split_interval"] as number | undefined) ?? 8;
  const kase = (config["case"] as string | undefined) ?? "upper";
  for (let i = 0; i < 10; i++) {
    const bytes = randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
    let key = bytes;
    if (split) {
      const chunks: string[] = [];
      for (let j = 0; j < key.length; j += splitLength) chunks.push(key.slice(j, j + splitLength));
      key = chunks.join("-");
    }
    switch (kase) {
      case "lower":
        break;
      case "upper":
        key = key.toUpperCase();
        break;
      case "mixed":
        key = key
          .split("")
          .map((c) => (randomInt(0, 2) <= 0.5 ? c.toUpperCase() : c))
          .join("");
        break;
      default:
        throw new FbError(
          `Unknown uppercase option '${kase}'. API generator only accepts 'lower', 'upper', or 'mixed'.`,
        );
    }
    if (!findKeyByApiKey(key)) return key;
  }
  throw new FbError("Maximum number of iterations reached while generating API key");
}

function parseConfig(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Shared reset logic (admin + client); the client-ownership check
 * applies only when a client session is present. */
function resetApiKey(ctx: CallContext): boolean {
  const key = ctx.params["key"];
  const orderIdRaw = ctx.params["order_id"];
  // PHP empty(): '', '0', missing all count as empty; order_id wins
  // when both are non-empty.
  const keyEmpty = !key || key === "" || key === "0";
  const orderEmpty = !orderIdRaw || orderIdRaw === "" || orderIdRaw === "0";
  if (keyEmpty && orderEmpty) {
    throw new FbError("You must provide either the API key or API key order ID in order to reset it.");
  }
  let model: ApiKeyRow | undefined;
  if (!orderEmpty) {
    model = modelForOrder(phpInt(orderIdRaw));
  } else {
    model = findKeyByApiKey(key!);
  }
  if (!model) throw new FbError("API key does not exist");
  const client = ctx.session?.client;
  if (client && client.id !== model.client_id) throw new FbError("API key does not exist");
  if (!isActive(model)) throw new FbError("Order is not active");
  const config = parseConfig(model.config);
  getDbWrite()
    .prepare("UPDATE service_apikey SET api_key = ? WHERE id = ?")
    .run(generateKey(config), model.id);
  return true;
}

register("guest", "serviceapikey", "check", (ctx) => {
  requireApikeyActive();
  const key = ctx.params["key"];
  if (!key || key === "" || key === "0") {
    throw new FbError("You must provide an API key to check it's validity.");
  }
  const model = findKeyByApiKey(key);
  if (!model) throw new FbError("API key does not exist");
  return isActive(model);
});

register("admin", "serviceapikey", "update", (ctx) => {
  requireAdmin(ctx);
  requireApikeyActive();
  const orderIdRaw = ctx.params["order_id"];
  if (!orderIdRaw || orderIdRaw === "" || orderIdRaw === "0") {
    throw new FbError("You must provide the API key order ID in order to update it.");
  }
  const model = modelForOrder(phpInt(orderIdRaw));
  if (!model) throw new FbError("API key does not exist");
  const apiKey = ctx.params["api_key"];
  if (apiKey !== undefined && model.api_key !== apiKey) {
    throw new FbError("To change the API key, please use the reset function rather than updating it.");
  }
  const rawConfig = ctx.rawParams?.["config"];
  const hasConfig =
    rawConfig !== undefined &&
    rawConfig !== null &&
    rawConfig !== "" &&
    !(Array.isArray(rawConfig) && rawConfig.length === 0) &&
    !(typeof rawConfig === "object" && Object.keys(rawConfig as object).length === 0);
  const config = hasConfig ? JSON.stringify(rawConfig) : model.config;
  getDbWrite()
    .prepare("UPDATE service_apikey SET config = ? WHERE id = ?")
    .run(config, model.id);
  return true;
});

register("admin", "serviceapikey", "reset", (ctx) => {
  requireAdmin(ctx);
  requireApikeyActive();
  return resetApiKey(ctx);
});

register("client", "serviceapikey", "reset", (ctx) => {
  requireClient(ctx);
  requireApikeyActive();
  return resetApiKey(ctx);
});
