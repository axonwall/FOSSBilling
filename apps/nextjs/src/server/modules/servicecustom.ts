// Servicecustom — custom service management.
//
// `update` (ported earlier) plus, since Phase 5 R4d, the plugin
// runtime: admin `__call` (magic fallback for any unregistered
// admin/servicecustom/<method>) and client `call`, both served by the
// in-tree plugin registry (../servicecustom-plugin), which ships
// EMPTY — no shipped servicecustom plugin adapters exist, so with no
// operator-registered adapter every plugin call resolves exactly as
// PHP resolves a missing plugin file: logged + null.

import {
  FbError,
  register,
  registerMagic,
  requireAdmin,
  requireClient,
  requireParam,
  type CallContext,
} from "../dispatch";
import { getDb, getDbWrite, nowTimestamp, type OrderRowFull } from "../db";
import {
  customServiceApiArray,
  dispatchCustomCall,
  stripAdapterParams,
} from "../servicecustom-plugin";
import { orderArray } from "./order";

interface OrderRow {
  id: number;
  client_id: number;
  service_id: number | null;
  service_type: string | null;
  status: string;
  expires_at: string | null;
}

interface CustomRow {
  id: number;
  client_id: number;
  plugin: string | null;
  plugin_config: string | null;
  config: string | null;
  created_at: string | null;
  updated_at: string | null;
}

async function findOrder(id: number): Promise<OrderRow | undefined> {
  return await getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as OrderRow | undefined;
}

async function findCustomService(order: OrderRow): Promise<CustomRow | undefined> {
  if (order.service_id === null || order.service_type !== "custom") return undefined;
  return await getDb().prepare("SELECT * FROM service_custom WHERE id = ?").get(order.service_id) as unknown as
    | CustomRow
    | undefined;
}

/** Rebuild a one-level `config[key]=value` object from form params. */
function bracketConfig(params: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let found = false;
  for (const [k, v] of Object.entries(params)) {
    const m = /^config\[([^\]]+)\]$/.exec(k);
    if (m) {
      out[m[1]] = v;
      found = true;
    }
  }
  return found ? out : undefined;
}

register("admin", "servicecustom", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  if (!ctx.params["order_id"]) throw new FbError("Order ID is required");
  // PHP Admin::update only calls updateConfig when config is an array,
  // and it checks that before looking up the order — so a missing order
  // with no array config returns true, and a non-array config is
  // silently ignored (both pinned by capture24).
  const raw = (ctx.rawParams as Record<string, unknown>)["config"];
  const config =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : bracketConfig(ctx.params);
  if (config === undefined) return true;
  const order = await findOrder(Number(ctx.params["order_id"]));
  if (!order) throw new FbError("Order not found");
  const svc = await findCustomService(order);
  if (!svc) throw new FbError("Order is not activated");
  await getDbWrite()
    .prepare("UPDATE service_custom SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(config), nowTimestamp(), svc.id);
  return true;
});

// --- Phase 5 R4d: plugin runtime (admin __call + client call). ---

/**
 * The call's data as the adapter sees it: the JSON body when the call
 * was JSON-encoded (real types, via rawParams), else the string params
 * — mirroring PHP's $data — with CSRFToken stripped, as PHP's
 * ApiController unsets it before dispatch.
 */
function adapterData(ctx: CallContext): Record<string, unknown> {
  const raw = ctx.rawParams as Record<string, unknown>;
  const src =
    raw && Object.keys(raw).length > 0
      ? raw
      : (ctx.params as unknown as Record<string, unknown>);
  return stripAdapterParams(src);
}

/** Mirror of Service::getServiceCustomByOrderId(orderId) — admin path:
 * order must exist; its service must be a custom service. NO status
 * or expiry check on this path (PHP checks those only for clients). */
async function loadAdminService(orderIdRaw: unknown): Promise<{ order: OrderRow; svc: CustomRow }> {
  const n = Number(orderIdRaw);
  if (!Number.isFinite(n)) throw new FbError("Order not found");
  const order = await findOrder(n);
  if (!order) throw new FbError("Order not found");
  const svc = await findCustomService(order);
  if (!svc) throw new FbError("Order is not activated");
  return { order, svc };
}

/** Mirror of Service::getServiceCustomByOrderId(orderId, clientId) —
 * client path: order must exist AND belong to the caller, must not be
 * expired (assertOrderUsable), must be active, and its service must
 * be a custom service. Errors in PHP's order. */
async function loadClientService(
  orderIdRaw: unknown,
  clientId: number,
): Promise<{ order: OrderRow; svc: CustomRow }> {
  const n = Number(orderIdRaw);
  if (!Number.isFinite(n)) throw new FbError("Order not found");
  const order = await findOrder(n);
  if (!order || order.client_id !== clientId) throw new FbError("Order not found");
  if (
    order.expires_at !== null &&
    order.expires_at !== undefined &&
    Date.parse(order.expires_at) <= Date.now()
  ) {
    throw new FbError("Subscription expired");
  }
  if (order.status !== "active") throw new FbError("Order is not activated");
  const svc = await findCustomService(order);
  if (!svc) throw new FbError("Order is not activated");
  return { order, svc };
}

/**
 * Admin __call (Servicecustom Api\Admin::__call): checkPermissions
 * servicecustom/manage (enforced by the ADMIN_GUARDS entry for the
 * magic method — see guards.ts), then order_id, then customCall.
 *
 * The arguments check (7103) deserves a note: PHP's __call throws
 * 7103 only when arguments[0] is unset, but the dispatcher always
 * wraps [$data], so over HTTP arguments[0] is always set — even for
 * empty params. Probed live: empty params yield 'Order ID is
 * required', never 7103. The TS handler therefore mirrors PHP
 * exactly (no 7103 branch here); the 7103 branch lives in
 * dispatchCustomCall for callers that pass no arguments object at
 * all, and is proven at unit level (plugin-dispatch-test).
 *
 * Note the isset asymmetry vs client `call`: __call has NO
 * RequiredParams attribute, so its order_id check is isset-only —
 * a blank order_id passes the check and fails lookup ('Order
 * not found'), exactly as PHP does. Client `call` HAS the
 * attribute, so blank order_id/method fail with the required
 * messages (via requireParam, which mirrors RequiredParams).
 */
registerMagic("admin", "servicecustom", async (ctx, method) => {
  requireAdmin(ctx);
  const data = adapterData(ctx);
  const orderId = data["order_id"];
  if (orderId === undefined || orderId === null) throw new FbError("Order ID is required");
  const { order, svc } = await loadAdminService(orderId);
  const orderData = await orderArray(order as unknown as OrderRowFull, true);
  return await dispatchCustomCall({
    plugin: svc.plugin,
    pluginConfig: svc.plugin_config,
    serviceData: customServiceApiArray(svc),
    orderData,
    method,
    params: data,
  });
});

/**
 * Client call (Servicecustom Api\Client::call): RequiredParams
 * order_id + method (attribute order: order_id first), then
 * ownership + usability via loadClientService, then customCall —
 * so the forbidden-7 check applies on the client path too, exactly
 * as PHP shares customCall between both callers.
 */
register("client", "servicecustom", "call", async (ctx) => {
  requireClient(ctx);
  const orderId = requireParam(ctx.params, "order_id", "Order ID is required");
  const method = requireParam(ctx.params, "method", "Method is required");
  const clientId = ctx.session!.client!.id;
  const { order, svc } = await loadClientService(orderId, clientId);
  const orderData = await orderArray(order as unknown as OrderRowFull, true);
  return await dispatchCustomCall({
    plugin: svc.plugin,
    pluginConfig: svc.plugin_config,
    serviceData: customServiceApiArray(svc),
    orderData,
    method,
    params: adapterData(ctx),
  });
});
