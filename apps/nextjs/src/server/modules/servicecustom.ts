// Servicecustom — custom service management.
//
// Only `update` is TS-served. `call` (client) and the admin `__call`
// fallback execute third-party plugin methods, which are PHP code the
// TS seam cannot run, so those two stay PHP-proxied: the dispatcher
// falls through to PHP for any method with no registered handler.
// Plugin-less services (the only shape on the reference install) would
// answer null from callOnAdapter, which the proxy returns identically.

import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp } from "../db";

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
}

function findOrder(id: number): OrderRow | undefined {
  return getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as OrderRow | undefined;
}

function findCustomService(order: OrderRow): CustomRow | undefined {
  if (order.service_id === null || order.service_type !== "custom") return undefined;
  return getDb().prepare("SELECT * FROM service_custom WHERE id = ?").get(order.service_id) as unknown as
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

register("admin", "servicecustom", "update", (ctx: CallContext) => {
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
  const order = findOrder(Number(ctx.params["order_id"]));
  if (!order) throw new FbError("Order not found");
  const svc = findCustomService(order);
  if (!svc) throw new FbError("Order is not activated");
  getDbWrite()
    .prepare("UPDATE service_custom SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(config), nowTimestamp(), svc.id);
  return true;
});
