import { randomBytes } from "node:crypto";
import {
  countActiveTicketsForOrder,
  deleteOrderStatusRow,
  findClientById,
  findCurrencyByCode,
  findOrderById,
  findProductById,
  insertCustomService,
  findProductPayment,
  getDb,
  getDbWrite,
  listAllProducts,
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
import { requirePermission } from "../permissions";
import { clientBlock } from "./invoice";
import { issueInvoice, prepareInvoice, round2 } from "../money";
import { exportCsvResponse, requestedCsvHeaders } from "../csv";

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
    // Single-get discount: NULL -> 0 (number), stored -> DECIMAL string
    // ("0", not 0). List rows coalesce NULL to 0 but keep the number.
    discount: listMode
      ? (order.discount ?? 0)
      : order.discount === null || order.discount === undefined
        ? 0
        : String(order.discount),
    // Single-get promo_recurring is a Doctrine boolean (null stays null);
    // list rows pass the stored value through.
    promo_recurring: listMode
      ? order.promo_recurring
      : order.promo_recurring === null || order.promo_recurring === undefined
        ? null
        : !!order.promo_recurring,
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
  // R2a conditional guards (Order Admin::create): product/manage_promos
  // only when a promo is supplied (PHP !empty treats '0' as empty),
  // and the invoice-access guard only when marking the invoice paid.
  const promoCode = (ctx.params["promo_code"] ?? "").trim();
  const promoId = ctx.params["promo_id"];
  if (promoCode !== "" || (promoId !== undefined && promoId !== "" && promoId !== "0")) {
    requirePermission(ctx, "product", "manage_promos");
  }
  const markPaidRaw =
    ctx.rawParams["mark_invoice_paid"] !== undefined ? ctx.rawParams["mark_invoice_paid"] : ctx.params["mark_invoice_paid"];
  const markPaid =
    typeof markPaidRaw === "boolean"
      ? markPaidRaw
      : typeof markPaidRaw === "number"
        ? markPaidRaw !== 0
        : typeof markPaidRaw === "string"
          ? ["1", "true", "yes", "on"].includes(markPaidRaw.toLowerCase())
          : false;
  if (markPaid) requirePermission(ctx, "invoice");
  const client = findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const product = findProductById(Number(productId));
  if (!product) throw new FbError("Product not found");
  const period = ctx.params["period"] || null;
  const payment = product.product_payment_id
    ? findProductPayment(product.product_payment_id)
    : undefined;
  // Pricing mirrors getProductOrderLineConfig: an explicit price wins;
  // otherwise once -> once_price, recurrent -> the enabled period's
  // price (period required), free -> 0. Domain catalog pricing is a
  // documented gap (TS prices domain orders at 0).
  let price: number;
  if (ctx.params["price"] !== undefined) {
    price = Number(ctx.params["price"]);
  } else if (!payment) {
    price = 0;
  } else if (payment.type === "free") {
    price = 0;
  } else if (payment.type === "once") {
    price = payment.once_price ?? 0;
  } else if (payment.type === "recurrent") {
    if (!period) {
      throw new FbError(`Product ${product.id} payment type is recurrent, but period was not selected`);
    }
    const pp = listProductPeriods(payment.id).find((x) => x.code === period && x.enabled);
    if (!pp) throw new FbError("Selected billing period is not available for this product");
    price = pp.price;
  } else {
    price = 0;
  }
  const quantity = Math.max(1, parseInt(ctx.params["quantity"] ?? "1", 10) || 1);
  // Currency: explicit param -> client currency -> default currency;
  // an unresolvable code throws, as PHP's createOrder does.
  let currency: string;
  {
    const wanted = ctx.params["currency"] || client.currency || null;
    if (wanted) {
      const found = findCurrencyByCode(wanted);
      if (!found) throw new FbError("Currency could not be determined for order");
      currency = found.code;
    } else {
      const def = getDb().prepare("SELECT code FROM currency WHERE is_default = 1").get() as { code: string } | undefined;
      if (!def) throw new FbError("Currency could not be determined for order");
      currency = def.code;
    }
  }
  const invoiceOption = ctx.params["invoice_option"] ?? "no-invoice";
  // Addon orders must join an existing master group; anything else
  // gets a fresh group as master.
  let groupId: string;
  let groupMaster = 1;
  if (ctx.params["group_id"]) {
    const parent = listOrders({}).find(
      (o) => o.group_id === ctx.params["group_id"] && o.client_id === client.id,
    );
    if (!parent) throw new FbError(`Parent order ${ctx.params["group_id"]} was not found`);
    groupId = parent.group_id!;
    groupMaster = 0;
  } else {
    if (product.is_addon) {
      throw new FbError("Group ID parameter is missing for addon product order", 832);
    }
    groupId = randomBytes(7).toString("hex").slice(0, 13);
  }
  const configObj: Record<string, unknown> = {};
  {
    const raw = ctx.rawParams?.["config"];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) Object.assign(configObj, raw);
    for (const [k, v] of Object.entries(ctx.params)) {
      const m = /^config\[([^\]]+)\]$/.exec(k);
      if (m && v !== undefined) configObj[m[1]] = v;
    }
  }
  if (period) configObj["period"] = period;
  const configJson = Object.keys(configObj).length ? JSON.stringify(configObj) : "[]";
  const orderId = insertOrder({
    client_id: client.id,
    product_id: product.id,
    form_id: product.form_id,
    promo_id: null,
    promo_recurring: null,
    promo_used: null,
    group_id: groupId,
    group_master: groupMaster,
    invoice_option: invoiceOption,
    title: product.title,
    currency,
    unpaid_invoice_id: null,
    service_type: product.type,
    period,
    quantity,
    unit: product.unit,
    price,
    discount: null,
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

/** Shared activation path (single activate + invoice batch job). */
export function activateOrderRow(order: OrderRowFull): void {
  const now = new Date();
  const config = parseConfig(order.config) as Record<string, unknown>;
  const period = order.period ?? (typeof config["period"] === "string" ? config["period"] : null);
  let serviceId = order.service_id;
  if (serviceId === null && order.service_type === "custom") {
    serviceId = insertCustomService(order.client_id, order.config);
  }
  // PHP createFromOrder extends from the order's EXISTING expiry (or
  // now when unset), not unconditionally from now.
  const from = order.expires_at ? new Date(order.expires_at.replace(" ", "T") + "Z") : now;
  updateOrderRow(order.id, {
    status: "active",
    activated_at: fmtTs(now),
    expires_at: period ? fmtTs(addPeriod(from, period)) : order.expires_at,
    service_id: serviceId,
  });
  insertOrderStatus(order.id, "active", "Order activated");
}

register("admin", "order", "activate", (ctx: CallContext) => {
  requireAdmin(ctx);
  activateOrderRow(getOrderOrThrow(ctx));
  return true;
});

// --- Batch jobs (cron) ---------------------------------------------------------

export function runBatchSuspendExpired(): void {
  const now = fmtTs(new Date());
  for (const order of listOrders({ status: "active" })) {
    if (order.expires_at && order.expires_at < now) {
      updateOrderRow(order.id, {
        status: "suspended",
        suspended_at: now,
        reason: "Expired",
      });
      insertOrderStatus(order.id, "suspended", "Order suspended (expired)");
    }
  }
}

export function runBatchCancelSuspended(): boolean {
  const cutoff = fmtTs(new Date(Date.now() - 30 * 24 * 3600 * 1000));
  let any = false;
  for (const order of listOrders({ status: "suspended" })) {
    if (order.suspended_at && order.suspended_at < cutoff) {
      updateOrderRow(order.id, { status: "canceled", canceled_at: fmtTs(new Date()) });
      insertOrderStatus(order.id, "canceled", "Order canceled (suspended too long)");
      any = true;
    }
  }
  return any;
}

export function runBatchCancelUnpaid(): boolean {
  const cutoff = fmtTs(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  let any = false;
  for (const order of listOrders({ status: "pending_setup" })) {
    if (!order.created_at || order.created_at >= cutoff) continue;
    updateOrderRow(order.id, { status: "canceled", canceled_at: fmtTs(new Date()) });
    insertOrderStatus(order.id, "canceled", "Order canceled (unpaid)");
    any = true;
  }
  return any;
}

register("admin", "order", "batch_suspend_expired", (ctx: CallContext) => {
  requireAdmin(ctx);
  runBatchSuspendExpired();
  return true;
});

register("admin", "order", "batch_cancel_suspended", (ctx: CallContext) => {
  requireAdmin(ctx);
  return runBatchCancelSuspended();
});

register("admin", "order", "batch_cancel_unpaid", (ctx: CallContext) => {
  requireAdmin(ctx);
  return runBatchCancelUnpaid();
});

register("admin", "order", "batch_send_suspension_warnings", (ctx: CallContext) => {
  requireAdmin(ctx);
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

/** Order\\Service::deleteFromOrder, TS-visible subset: pending_setup
 * invoice items, reserved promo + stock releases, status + meta rows,
 * the service_custom row for custom orders, then the order row.
 * Service-module deletes for non-custom types are PHP-side work the
 * TS seam cannot run (documented gap); on this install every order
 * is custom, and null-plugin custom deletes are no-ops in PHP too. */
export function deleteOrderFull(order: OrderRowFull, forceDelete = false): void {
  const w = getDbWrite();
  void forceDelete; // only changes adapter-error handling, which TS skips
  if (order.status === "pending_setup") {
    w.prepare("DELETE FROM invoice_item WHERE rel_id = ? AND status = 'pending_payment'").run(String(order.id));
  }
  // Release reserved promo redemptions (any phase) + decrement usage
  // for checkout-phase ones, mirroring releasePromoRedemptions.
  const reserved = getDb()
    .prepare("SELECT id, promo_id, phase FROM promo_redemption WHERE client_order_id = ? AND status = 'reserved'")
    .all(order.id) as { id: number; promo_id: number; phase: string }[];
  if (reserved.length) {
    const now = fmtTs(new Date());
    const checkoutCounts = new Map<number, number>();
    for (const r of reserved) {
      w.prepare("UPDATE promo_redemption SET status = 'released', released_at = ?, release_reason = 'order_deleted', updated_at = ? WHERE id = ?").run(now, now, r.id);
      if (r.phase === "checkout") checkoutCounts.set(r.promo_id, (checkoutCounts.get(r.promo_id) ?? 0) + 1);
    }
    for (const [promoId, count] of checkoutCounts) {
      w.prepare("UPDATE promo SET used = MAX(COALESCE(used, 0) - ?, 0), updated_at = ? WHERE id = ?").run(count, now, promoId);
    }
  }
  // Release a stock reservation, if one was recorded in order meta.
  const meta = getDb().prepare("SELECT id, value FROM client_order_meta WHERE client_order_id = ? AND name = 'stock_reserved_qty'").get(order.id) as
    | { id: number; value: string }
    | undefined;
  if (meta) {
    const qty = parseInt(meta.value, 10) || 0;
    w.prepare("DELETE FROM client_order_meta WHERE id = ?").run(meta.id);
    if (qty > 0 && order.product_id) {
      w.prepare("UPDATE product SET quantity_in_stock = COALESCE(quantity_in_stock, 0) + ? WHERE id = ?").run(qty, order.product_id);
    }
  }
  w.prepare("DELETE FROM client_order_status WHERE client_order_id = ?").run(order.id);
  w.prepare("DELETE FROM client_order_meta WHERE client_order_id = ?").run(order.id);
  if (order.service_type === "custom" && order.service_id !== null) {
    w.prepare("DELETE FROM service_custom WHERE id = ?").run(order.service_id);
  }
  w.prepare("DELETE FROM client_order WHERE id = ?").run(order.id);
}

register("admin", "order", "delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrow(ctx);
  const deleteAddons = normalizeBool(ctx.params["delete_addons"]);
  const forceDelete = normalizeBool(ctx.params["force_delete"]);
  if (deleteAddons) {
    for (const addon of getOrderAddonsList(order)) {
      deleteOrderFull(addon, forceDelete);
    }
  }
  deleteOrderFull(order, forceDelete);
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

/* ------------------------------------------------------------------ */
/* Phase 5 R1 order leftovers (parity oracle: captures22)              */
/* ------------------------------------------------------------------ */

/** Tools::normalizeBoolean for flag params. */
function normalizeBool(v: string | undefined): boolean {
  if (v === undefined) return false;
  const lower = v.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return false;
}

function getOrderOrThrowAdmin(ctx: CallContext): OrderRowFull {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order ID was not passed");
  const order = findOrderById(Number(id));
  if (!order) throw new FbError("Order Not Found");
  return order;
}

function getOrderOrThrowClient(ctx: CallContext): OrderRowFull {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order id required");
  const order = findOrderById(Number(id));
  if (!order || order.client_id !== ctx.session!.client!.id) throw new FbError("Order not found");
  return order;
}

/** Same group + client, not a master, excluding the order itself. */
function getOrderAddonsList(order: OrderRowFull): OrderRowFull[] {
  if (!order.group_id) return [];
  // PHP's repository query has no ORDER BY: rowid (id ASC) order.
  return listOrders({})
    .filter(
      (o) => o.group_id === order.group_id && o.client_id === order.client_id && o.id !== order.id && !o.group_master,
    )
    .sort((a, b) => a.id - b.id);
}

function customServiceArray(serviceId: number): Record<string, unknown> | null {
  const row = getDb().prepare("SELECT id, client_id, plugin, config, created_at, updated_at FROM service_custom WHERE id = ?").get(serviceId) as
    | { id: number; client_id: number; plugin: string | null; config: string | null; created_at: string | null; updated_at: string | null }
    | undefined;
  if (!row) return null;
  let config: Record<string, unknown> = {};
  try {
    config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
  } catch { /* keep {} */ }
  return {
    ...config,
    id: row.id,
    client_id: row.client_id,
    plugin: row.plugin,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

function orderServiceData(order: OrderRowFull): Record<string, unknown> | null {
  if (order.service_id === null) return null;
  if (order.service_type === "custom") return customServiceArray(order.service_id);
  // Non-custom service modules (hosting, domain, ...) render their own
  // toApiArray in PHP; the TS seam has no equivalent (documented gap).
  return null;
}

register("admin", "order", "get_invoice_options", (ctx: CallContext) => {
  requireAdmin(ctx);
  return {
    "issue-invoice": "Automatically Issue Renewal Invoices",
    "no-invoice": "Issue Invoices Manually",
  };
});

register("admin", "order", "service", (ctx: CallContext) => {
  requireAdmin(ctx);
  return orderServiceData(getOrderOrThrowAdmin(ctx));
});

register("admin", "order", "addons", (ctx: CallContext) => {
  requireAdmin(ctx);
  return getOrderAddonsList(getOrderOrThrowAdmin(ctx)).map((o) => orderArray(o, false));
});

register("admin", "order", "can_cancel_at_period_end", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrowAdmin(ctx);
  // Active subscriptions (via invoice items on the order's invoices)
  // with a non-empty sid, whose gateway adapter implements
  // cancelSubscriptionAtPeriodEnd. Only Stripe implements it among
  // the bundled adapters.
  const subs = getDb().prepare(
    `SELECT DISTINCT s.sid, s.pay_gateway_id, s.status FROM subscription s
     JOIN invoice_item ii ON ii.invoice_id = s.rel_id
     WHERE s.rel_type = 'invoice' AND ii.type = 'order' AND ii.rel_id = ? AND s.status = 'active'`,
  ).all(String(order.id)) as { sid: string | null; pay_gateway_id: number | null; status: string }[];
  if (subs.length === 0) return false;
  for (const sub of subs) {
    if ((sub.sid ?? "").trim() === "") return false;
    const gw = sub.pay_gateway_id ? getDb().prepare("SELECT gateway FROM pay_gateway WHERE id = ?").get(sub.pay_gateway_id) as { gateway: string } | undefined : undefined;
    if (!gw || gw.gateway !== "Stripe") return false;
  }
  return true;
});

register("admin", "order", "update_config", (ctx: CallContext) => {
  requireAdmin(ctx);
  // Dispatcher RequiredParams runs first: missing/empty config beats
  // a missing id, with the same message either way.
  const raw = ctx.rawParams?.["config"];
  let config: Record<string, unknown> | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    config = raw as Record<string, unknown>;
  } else {
    const scanned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.params)) {
      const m = /^config\[([^\]]+)\]$/.exec(k);
      if (m && v !== undefined) scanned[m[1]] = v;
    }
    if (Object.keys(scanned).length) config = scanned;
  }
  if (!config || Object.keys(config).length === 0) throw new FbError("Order config not passed");
  const order = getOrderOrThrowAdmin(ctx);
  // Form-linked orders merge form answers in PHP (formbuilder is
  // unported); on this install no order has a form_id, so the plain
  // wholesale replacement below is exact. Form orders are a
  // documented gap.
  getDbWrite().prepare("UPDATE client_order SET config = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(config), fmtTs(new Date()), order.id,
  );
  return true;
});

/** Renew: pending/failed_setup orders activate; anything else extends
 * the expiry by the order's period (from the current expiry, per the
 * default renewal logic) and re-activates. Service-module renew calls
 * are no-ops for null-plugin custom orders. */
function renewOrderRow(order: OrderRowFull): void {
  if (order.status === "pending_setup" || order.status === "failed_setup") {
    activateOrderRow(order);
    return;
  }
  const from = order.expires_at ? new Date(order.expires_at.replace(" ", "T") + "Z") : new Date();
  const period = order.period;
  const updates: Partial<Parameters<typeof updateOrderRow>[1]> = {
    status: "active",
    suspended_at: null,
    unsuspended_at: null,
    canceled_at: null,
  };
  if (period) {
    (updates as Record<string, unknown>)["expires_at"] = fmtTs(addPeriod(from, period));
  }
  updateOrderRow(order.id, updates);
  insertOrderStatus(order.id, "active", "Order renewed");
}

register("admin", "order", "renew", (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = getOrderOrThrowAdmin(ctx);
  renewOrderRow(order);
  return true;
});

register("admin", "order", "batch_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const raw = ctx.rawParams?.["ids"];
  let ids: unknown[] | undefined;
  if (Array.isArray(raw)) {
    ids = raw;
  } else {
    const byIndex = new Map<number, string>();
    for (const [k, v] of Object.entries(ctx.params)) {
      const m = /^ids\[(\d+)\]$/.exec(k);
      if (m && v !== undefined) byIndex.set(Number(m[1]), v);
    }
    if (byIndex.size) ids = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  }
  if (!ids || ids.length === 0) throw new FbError("Order IDs were not passed");
  const deleteAddons = normalizeBool(ctx.params["delete_addons"]);
  const forceDelete = normalizeBool(ctx.params["force_delete"]);
  for (const id of ids) {
    const order = findOrderById(Number(id));
    if (!order) throw new FbError("Order Not Found");
    if (deleteAddons) {
      for (const addon of getOrderAddonsList(order)) {
        deleteOrderFull(addon, forceDelete);
      }
    }
    deleteOrderFull(order, forceDelete);
  }
  return true;
});

// NOTE (deliberate, documented): admin order export_csv is a CSV
// download, like client/invoice export_csv; it stays PHP-served
// through the proxy (binary-safe since the arrayBuffer fix).

register("client", "order", "addons", (ctx: CallContext) => {
  requireClient(ctx);
  return getOrderAddonsList(getOrderOrThrowClient(ctx)).map((o) => orderArray(o, false));
});

register("client", "order", "service", (ctx: CallContext) => {
  requireClient(ctx);
  const order = getOrderOrThrowClient(ctx);
  if (order.status !== "active") throw new FbError("Order is not active");
  return orderServiceData(order);
});

register("client", "order", "upgradables", (ctx: CallContext) => {
  requireClient(ctx);
  const order = getOrderOrThrowClient(ctx);
  const product = order.product_id ? findProductById(order.product_id) : undefined;
  if (!product) return [];
  let upgradeIds: unknown[] = [];
  try {
    const parsed = product.upgrades ? (JSON.parse(product.upgrades) as unknown) : [];
    upgradeIds = Array.isArray(parsed) ? parsed : [];
  } catch { /* keep [] */ }
  const out: Record<string, string> = {};
  for (const p of listAllProducts()) {
    if (upgradeIds.map(Number).includes(p.id) && p.id !== product.id) out[String(p.id)] = p.title;
  }
  // PHP's empty array encodes as [], not {}.
  return Object.keys(out).length ? out : [];
});

register("client", "order", "delete", (ctx: CallContext) => {
  requireClient(ctx);
  const order = getOrderOrThrowClient(ctx);
  if (order.status !== "pending_setup" && order.status !== "failed_setup") {
    throw new FbError("Only pending and failed setup orders can be deleted.");
  }
  deleteOrderFull(order);
  return true;
});

// --- Phase 5 R1 decisions batch (D3): admin export_csv. ---
const ORDER_EXPORTABLE = [
  "id", "client_id", "product_id", "form_id", "promo_id", "promo_recurring",
  "promo_used", "group_id", "group_master", "invoice_option", "title",
  "currency", "unpaid_invoice_id", "service_id", "service_type", "period",
  "quantity", "unit", "price", "discount", "status", "reason", "notes",
  "suspension_grace_days", "referred_by", "expires_at", "activated_at",
  "suspended_at", "unsuspended_at", "canceled_at", "created_at", "updated_at",
];

const ORDER_DEFAULT_EXPORT = [
  "id", "client_id", "product_id", "title", "currency", "service_type",
  "period", "quantity", "price", "discount", "status", "reason", "notes",
];

register("admin", "order", "export_csv", (ctx: CallContext) => {
  requireAdmin(ctx);
  return exportCsvResponse(
    "client_order",
    "orders.csv",
    ORDER_EXPORTABLE,
    ORDER_DEFAULT_EXPORT,
    requestedCsvHeaders(ctx.rawParams, ctx.params),
  );
});
