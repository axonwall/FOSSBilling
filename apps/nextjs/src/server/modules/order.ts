import { randomBytes } from "node:crypto";
import {
  countActiveTicketsForOrder,
  deleteOrderCascade,
  deleteOrderStatusRow,
  findClientById,
  findOrderById,
  findProductById,
  insertCustomService,
  findProductPayment,
  listProductPeriods,
  insertOrder,
  insertOrderStatus,
  insertOrderStatusReturningId,
  listOrderStatusHistory,
  listOrders,
  orderStatusCounts,
  updateOrderRow,
  type OrderRowFull,
} from "../db";
import {
  FbError,
  register,
  requireAdmin,
  requireClient,
  type CallContext,
} from "../dispatch";
import { clientBlock } from "./invoice";
import { issueInvoice, prepareInvoice, round2 } from "../money";

/**
 * Order module (Phase 3 batch 3) — TS port of
 * src/modules/Order/Api/{Admin,Client}.php core paths: reads, admin
 * create, the status state machine (activate/suspend/unsuspend/
 * cancel/uncancel/delete), status history, and status counts.
 * Provisioning actions for real service types (hosting, domains,
 * licenses) stay with PHP — `custom` products activate in place, as
 * in PHP. Deferred: renewals, batch jobs, CSV export, addons
 * management, service data handlers.
 * Parity oracle: capture11.py corpus.
 */

/** DECIMAL columns surface as strings in PHP's entity arrays. */
function decimalString(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function parseConfig(raw: string | null): unknown {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function orderArray(
  order: OrderRowFull,
  admin: boolean,
  detail = false,
  listMode = false,
): Record<string, unknown> {
  const client = findClientById(order.client_id);
  const product = order.product_id ? findProductById(order.product_id) : undefined;
  const out: Record<string, unknown> = {
    id: order.id,
    client_id: order.client_id,
    product_id: order.product_id,
    form_id: order.form_id,
    promo_id: order.promo_id,
    promo_recurring: order.promo_recurring,
    promo_used: order.promo_used,
    group_id: order.group_id,
    group_master: listMode ? order.group_master : !!order.group_master,
    invoice_option: order.invoice_option,
    title: order.title,
    currency: order.currency,
    unpaid_invoice_id: order.unpaid_invoice_id,
    service_id: order.service_id,
    service_type: order.service_type,
    period: order.period,
    quantity: order.quantity,
    unit: order.unit,
    // Entity reads type price as a DECIMAL string; the pager's raw
    // rows (list endpoints) pass the stored value through.
    price: listMode ? order.price : decimalString(order.price),
    discount: listMode ? order.discount : (order.discount ?? 0),
    status: order.status,
    reason: order.reason,
    notes: order.notes,
    suspension_grace_days: order.suspension_grace_days,
    referred_by: order.referred_by,
    expires_at: order.expires_at,
    activated_at: order.activated_at,
    suspended_at: order.suspended_at,
    unsuspended_at: order.unsuspended_at,
    canceled_at: order.canceled_at,
    created_at: order.created_at,
    updated_at: order.updated_at,
    config: parseConfig(order.config),
    total: round2(order.price * order.quantity - (order.discount ?? 0)),
    meta: [],
    active_tickets: countActiveTicketsForOrder(order.id),
    client: client ? clientBlock(client) : null,
  };
  if (admin) {
    out["plugin"] = order.service_type === "custom" ? null : order.service_type;
    if (detail) {
      out["product_suspension_grace_days"] = product?.suspension_grace_days ?? null;
    }
  }
  return out;
}

function getOrderOrThrow(ctx: CallContext, message = "Order Not Found"): OrderRowFull {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order ID was not passed");
  const order = findOrderById(Number(id));
  if (!order) throw new FbError(message);
  return order;
}

function paginateLocal<T>(items: T[], params: Record<string, string>) {
  const page = Math.max(1, parseInt(params["page"] ?? "1", 10) || 1);
  const perPage = Math.max(1, parseInt(params["per_page"] ?? "100", 10) || 100);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { pages, page, per_page: perPage, total, list: items.slice(start, start + perPage) };
}

/** Adds a period code (1M, 1Y, 3M…) to a timestamp, PHP DateTime-style. */
export function addPeriod(from: Date, period: string): Date {
  const m = /^(\d+)([MYDW])$/.exec(period);
  const out = new Date(from);
  if (!m) return out;
  const n = Number(m[1]);
  if (m[2] === "M") out.setUTCMonth(out.getUTCMonth() + n);
  else if (m[2] === "Y") out.setUTCFullYear(out.getUTCFullYear() + n);
  else if (m[2] === "D") out.setUTCDate(out.getUTCDate() + n);
  else if (m[2] === "W") out.setUTCDate(out.getUTCDate() + n * 7);
  return out;
}

export function fmtTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// --- Admin reads ------------------------------------------------------------

register("admin", "order", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  return orderArray(getOrderOrThrow(ctx), true, true);
});

register("admin", "order", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const filters: { client_id?: number; status?: string; product_id?: number } = {};
  if (ctx.params["client_id"]) filters.client_id = Number(ctx.params["client_id"]);
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  if (ctx.params["product_id"]) filters.product_id = Number(ctx.params["product_id"]);
  return paginateLocal(listOrders(filters).map((o) => orderArray(o, true, false, true)), ctx.params);
});

register("admin", "order", "get_statuses", (ctx: CallContext) => {
  requireAdmin(ctx);
  const counts = orderStatusCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    total,
    pending_setup: counts["pending_setup"] ?? 0,
    failed_setup: counts["failed_setup"] ?? 0,
    failed_renew: counts["failed_renew"] ?? 0,
    active: counts["active"] ?? 0,
    suspended: counts["suspended"] ?? 0,
    canceled: counts["canceled"] ?? 0,
  };
});

register("admin", "order", "get_status_pairs", (ctx: CallContext) => {
  requireAdmin(ctx);
  return {
    pending_setup: "Pending Setup",
    failed_setup: "Setup Failed",
    active: "Active",
    suspended: "Suspended",
    canceled: "Canceled",
  };
});

register("admin", "order", "status_history_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  return paginateLocal(listOrderStatusHistory(order.id), ctx.params);
});

register("admin", "order", "status_history_add", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  const status = ctx.params["status"];
  if (!status) throw new FbError("Order status was not passed");
  return insertOrderStatusReturningId(order.id, status, ctx.params["notes"] ?? "");
});

register("admin", "order", "status_history_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order history line ID was not passed");
  deleteOrderStatusRow(Number(id));
  return true;
});

// --- Admin create / update ----------------------------------------------------

register("admin", "order", "create", (ctx: CallContext) => {
  requireAdmin(ctx);
  const clientId = ctx.params["client_id"];
  const productId = ctx.params["product_id"];
  if (!clientId) throw new FbError("Client ID was not passed");
  if (!productId) throw new FbError("Product ID was not passed");
  const client = findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const product = findProductById(Number(productId));
  if (!product) throw new FbError("Product not found");
  const period = ctx.params["period"] || null;
  const payment = product.product_payment_id
    ? findProductPayment(product.product_payment_id)
    : undefined;
  let price = 0;
  if (period && payment) {
    const pp = listProductPeriods(payment.id).find((x) => x.code === period && x.enabled);
    price = pp?.price ?? 0;
  } else {
    price = payment?.once_price ?? 0;
  }
  const quantity = Math.max(1, parseInt(ctx.params["quantity"] ?? "1", 10) || 1);
  const currency = client.currency ?? "USD";
  const invoiceOption = ctx.params["invoice_option"] ?? "no-invoice";
  const groupId = randomBytes(7).toString("hex").slice(0, 13);
  const configJson = period ? JSON.stringify({ period }) : "[]";
  const orderId = insertOrder({
    client_id: client.id,
    product_id: product.id,
    form_id: product.form_id,
    promo_id: null,
    promo_recurring: null,
    promo_used: null,
    group_id: groupId,
    group_master: 1,
    invoice_option: invoiceOption,
    title: product.title,
    currency,
    unpaid_invoice_id: null,
    service_type: product.type,
    period,
    quantity,
    unit: product.unit,
    price,
    discount: 0,
    status: "pending_setup",
    notes: ctx.params["notes"] ?? null,
    config: configJson,
    suspension_grace_days: null,
  });
  insertOrderStatus(orderId, "pending_setup", "Order Created");

  if (invoiceOption === "issue-invoice") {
    const total = round2(price * quantity);
    const invoiceId = prepareInvoice(
      client,
      [
        {
          title: product.title,
          price,
          quantity,
          unit: product.unit,
          period,
          taxed: true,
          type: "order",
          rel_id: orderId,
          task: "activate",
        },
      ],
      ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : null,
    );
    void total;
    issueInvoice(invoiceId, client, {});
    updateOrderRow(orderId, { unpaid_invoice_id: invoiceId });
  }
  return orderId;
});

register("admin", "order", "update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  const fields: Parameters<typeof updateOrderRow>[1] = {};
  if (ctx.params["notes"] !== undefined) fields.notes = ctx.params["notes"];
  if (ctx.params["reason"] !== undefined) fields.reason = ctx.params["reason"];
  if (ctx.params["expires_at"] !== undefined) fields.expires_at = ctx.params["expires_at"];
  updateOrderRow(order.id, fields);
  return true;
});

// --- State machine --------------------------------------------------------------

register("admin", "order", "activate", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  const now = new Date();
  const config = parseConfig(order.config) as Record<string, unknown>;
  const period = order.period ?? (typeof config["period"] === "string" ? config["period"] : null);
  let serviceId = order.service_id;
  if (serviceId === null && order.service_type === "custom") {
    serviceId = insertCustomService(order.client_id, order.config);
  }
  updateOrderRow(order.id, {
    status: "active",
    activated_at: fmtTs(now),
    expires_at: period ? fmtTs(addPeriod(now, period)) : order.expires_at,
    service_id: serviceId,
  });
  insertOrderStatus(order.id, "active", "Order activated");
  return true;
});

register("admin", "order", "suspend", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  if (order.status !== "active") {
    throw new FbError("Only active orders can be suspended");
  }
  updateOrderRow(order.id, {
    status: "suspended",
    suspended_at: fmtTs(new Date()),
    reason: ctx.params["reason"] ?? order.reason,
  });
  insertOrderStatus(order.id, "suspended", ctx.params["reason"] ?? "Order suspended");
  return true;
});

register("admin", "order", "unsuspend", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  if (order.status !== "suspended") {
    throw new FbError("Only suspended orders can be unsuspended");
  }
  updateOrderRow(order.id, { status: "active", unsuspended_at: fmtTs(new Date()) });
  insertOrderStatus(order.id, "active", "Order unsuspended");
  return true;
});

register("admin", "order", "cancel", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  if (order.status === "pending_setup") {
    throw new FbError("Cannot cancel pending_setup order");
  }
  if (order.status === "canceled") {
    throw new FbError("Order is already canceled");
  }
  updateOrderRow(order.id, { status: "canceled", canceled_at: fmtTs(new Date()) });
  insertOrderStatus(order.id, "canceled", ctx.params["reason"] ?? "Order canceled");
  return true;
});

register("admin", "order", "uncancel", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  if (order.status !== "canceled") {
    throw new FbError("Only canceled orders can be uncanceled");
  }
  updateOrderRow(order.id, { status: "active", canceled_at: null });
  insertOrderStatus(order.id, "active", "Order uncanceled");
  return true;
});

register("admin", "order", "delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  deleteOrderCascade(order.id);
  return true;
});

// --- Client -------------------------------------------------------------------

register("client", "order", "get", (ctx: CallContext) => {
  requireClient(ctx);
  const order = getOrderOrThrow(ctx, "Order not found");
  if (order.client_id !== ctx.session!.client!.id) {
    throw new FbError("Order not found");
  }
  return orderArray(order, false);
});

register("client", "order", "get_list", (ctx: CallContext) => {
  requireClient(ctx);
  const filters: { client_id?: number; status?: string } = {
    client_id: ctx.session!.client!.id,
  };
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  return paginateLocal(listOrders(filters).map((o) => orderArray(o, false, false, true)), ctx.params);
});
