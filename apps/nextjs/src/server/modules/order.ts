import { randomBytes } from "node:crypto";
import {
  countActiveTicketsForOrder,
  deleteOrderStatusRow,
  findClientById,
  findCurrencyByCode,
  findDefaultCurrency,
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
  nowTimestamp,
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
import { readExtensionConfig } from "../crypt";
import { companyContext, findEmailTemplate, queueEmail } from "../emailer";
import { renderTemplateStrict } from "../twig";
import { zoneTodayString } from "../tz";

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

export async function orderArray(
  order: OrderRowFull,
  admin: boolean,
  detail = false,
  listMode = false,
): Promise<Record<string, unknown>> {
  const client = await findClientById(order.client_id);
  const product = order.product_id ? await findProductById(order.product_id) : undefined;
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
    active_tickets: await countActiveTicketsForOrder(order.id),
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

async function getOrderOrThrow(ctx: CallContext, message = "Order Not Found"): Promise<OrderRowFull> {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order ID was not passed");
  const order = await findOrderById(Number(id));
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

register("admin", "order", "get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await orderArray(await getOrderOrThrow(ctx), true, true);
});

register("admin", "order", "get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const filters: { client_id?: number; status?: string; product_id?: number } = {};
  if (ctx.params["client_id"]) filters.client_id = Number(ctx.params["client_id"]);
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  if (ctx.params["product_id"]) filters.product_id = Number(ctx.params["product_id"]);
  return paginateLocal(await Promise.all((await listOrders(filters)).map(async (o) => await orderArray(o, true, false, true))), ctx.params);
});

register("admin", "order", "get_statuses", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const counts = await orderStatusCounts();
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

register("admin", "order", "status_history_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  return paginateLocal(await listOrderStatusHistory(order.id), ctx.params);
});

register("admin", "order", "status_history_add", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  const status = ctx.params["status"];
  if (!status) throw new FbError("Order status was not passed");
  return await insertOrderStatusReturningId(order.id, status, ctx.params["notes"] ?? "");
});

register("admin", "order", "status_history_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order history line ID was not passed");
  await deleteOrderStatusRow(Number(id));
  return true;
});

// --- Admin create / update ----------------------------------------------------

register("admin", "order", "create", async (ctx: CallContext) => {
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
    await requirePermission(ctx, "product", "manage_promos");
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
  if (markPaid) await requirePermission(ctx, "invoice");
  const client = await findClientById(Number(clientId));
  if (!client) throw new FbError("Client not found");
  const product = await findProductById(Number(productId));
  if (!product) throw new FbError("Product not found");
  const period = ctx.params["period"] || null;
  const payment = product.product_payment_id
    ? await findProductPayment(product.product_payment_id)
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
    const pp = (await listProductPeriods(payment.id)).find((x) => x.code === period && x.enabled);
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
      const found = await findCurrencyByCode(wanted);
      if (!found) throw new FbError("Currency could not be determined for order");
      currency = found.code;
    } else {
      const def = await getDb().prepare("SELECT code FROM currency WHERE is_default = 1").get() as { code: string } | undefined;
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
    const parent = (await listOrders({})).find(
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
  const orderId = await insertOrder({
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
  await insertOrderStatus(orderId, "pending_setup", "Order Created");

  if (invoiceOption === "issue-invoice") {
    const total = round2(price * quantity);
    const invoiceId = await prepareInvoice(
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
    await issueInvoice(invoiceId, client, {});
    await updateOrderRow(orderId, { unpaid_invoice_id: invoiceId });
  }
  return orderId;
});

register("admin", "order", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  const fields: Parameters<typeof updateOrderRow>[1] = {};
  if (ctx.params["notes"] !== undefined) fields.notes = ctx.params["notes"];
  if (ctx.params["reason"] !== undefined) fields.reason = ctx.params["reason"];
  if (ctx.params["expires_at"] !== undefined) fields.expires_at = ctx.params["expires_at"];
  await updateOrderRow(order.id, fields);
  return true;
});

// --- State machine --------------------------------------------------------------

/** Shared activation path (single activate + invoice batch job). */
export async function activateOrderRow(order: OrderRowFull): Promise<void> {
  const now = new Date();
  const config = parseConfig(order.config) as Record<string, unknown>;
  const period = order.period ?? (typeof config["period"] === "string" ? config["period"] : null);
  let serviceId = order.service_id;
  if (serviceId === null && order.service_type === "custom") {
    serviceId = await insertCustomService(order.client_id, order.config);
  }
  // PHP createFromOrder extends from the order's EXISTING expiry (or
  // now when unset), not unconditionally from now.
  const from = order.expires_at ? new Date(order.expires_at.replace(" ", "T") + "Z") : now;
  await updateOrderRow(order.id, {
    status: "active",
    activated_at: fmtTs(now),
    expires_at: period ? fmtTs(addPeriod(from, period)) : order.expires_at,
    service_id: serviceId,
  });
  await insertOrderStatus(order.id, "active", "Order activated");
}

register("admin", "order", "activate", async (ctx: CallContext) => {
  requireAdmin(ctx);
  await activateOrderRow(await getOrderOrThrow(ctx));
  return true;
});

// --- Batch jobs (cron, R5f) ---------------------------------------------------

/** PHP truthiness for extension-config flags: false, 0, "0", "", null
 * are falsy; everything else (including "false") is truthy. */
function phpTruthy(value: unknown): boolean {
  return !(value === false || value === null || value === undefined || value === 0 || value === "0" || value === "");
}

/** Order\Service::resolveBatchAfterDays: null/'' → default 7;
 * negative → default 7; PHP (int) cast otherwise (non-numeric → 0). */
function resolveBatchAfterDays(value: unknown, def = 7): number {
  if (value === null || value === undefined || value === "") return def;
  const days = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  const n = Number.isFinite(days) ? days : 0;
  return n < 0 ? def : n;
}

/**
 * Order\Service::batchSendSuspensionWarnings. Before/After batch
 * events have NO listeners outside Order\Service + tests → no-ops.
 * Candidates: active + expires_at NOT NULL, grace =
 * MAX(COALESCE(order grace, product grace, 0), 0) > 0, suspension_at
 * (expires + grace, same time-of-day) in (now, now+1 day]. Per
 * candidate: reload; claim via client_order_meta
 * (suspension_warning_for) — an existing row with the SAME value
 * means already claimed → skip; otherwise update-or-insert the row;
 * then sendTemplate mod_order_suspension_warning with the order api
 * array + suspension_at. A send throw RELEASES the claim (delete
 * the meta row) and the loop continues; the task still returns true.
 * Template missing/disabled → no queue, claim kept (PHP's
 * sendTemplate returns false there; TS does not auto-create the
 * disabled template row PHP's getOrCreateTemplateByCode would —
 * documented minor divergence, unasserted: parity crafts an enabled
 * template). The template does NOT exist on the reference, so
 * parity39 crafts an enabled row first (snapshot-restored).
 */
export async function runBatchSendSuspensionWarnings(): Promise<boolean> {
  const nowStr = nowTimestamp();
  const tomorrowStr = new Date(Date.now() + 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const candidates = (await getDb()
    .prepare(
      `SELECT due.id, due.suspension_at FROM (
         SELECT o.id,
           MAX(COALESCE(o.suspension_grace_days, p.suspension_grace_days, 0), 0) AS grace_days,
           datetime(o.expires_at, '+' || MAX(COALESCE(o.suspension_grace_days, p.suspension_grace_days, 0), 0) || ' days') AS suspension_at
         FROM client_order o LEFT JOIN product p ON p.id = o.product_id
         WHERE o.status = 'active' AND o.expires_at IS NOT NULL
       ) due
       WHERE due.grace_days > 0 AND due.suspension_at > ? AND due.suspension_at <= ?
       ORDER BY due.id`,
    )
    .all(nowStr, tomorrowStr)) as unknown as { id: number; suspension_at: string }[];
  for (const cand of candidates) {
    const order = await findOrderById(cand.id);
    if (!order) continue;
    const existing = (await getDb()
      .prepare("SELECT id, value FROM client_order_meta WHERE client_order_id = ? AND name = 'suspension_warning_for' ORDER BY id LIMIT 1")
      .get(order.id)) as unknown as { id: number; value: string | null } | undefined;
    if (existing && existing.value === cand.suspension_at) continue;
    const now = nowTimestamp();
    if (existing) {
      await getDbWrite().prepare("UPDATE client_order_meta SET value = ?, updated_at = ? WHERE id = ?").run(cand.suspension_at, now, existing.id);
    } else {
      await getDbWrite()
        .prepare("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at) VALUES (?, 'suspension_warning_for', ?, ?, ?)")
        .run(order.id, cand.suspension_at, now, now);
    }
    try {
      const orderData = await orderArray(order, false);
      orderData["suspension_at"] = cand.suspension_at;
      const t = await findEmailTemplate("mod_order_suspension_warning");
      if (!t || !t.enabled) continue;
      const client = await findClientById(order.client_id);
      if (!client) throw new FbError("Client not found");
      const company = await companyContext();
      const full: Record<string, unknown> = {
        order: orderData,
        c: clientBlock(client),
        guest: { system_company: company, system_email: { signature: company.signature } },
        default_currency: (await findDefaultCurrency())?.code ?? "USD",
        __baseUrl: (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080") + "/",
        __currencyFormats: {},
      };
      // PHP's sendTemplate renders STRICT (SandboxedStringRenderer):
      // an unclosed {{ }} throws and the claim is released. The
      // forgiving renderTemplate would queue a literal render instead,
      // so the suspension path must use the strict renderer here.
      const subject = renderTemplateStrict(t.subject, full);
      const content = renderTemplateStrict(t.content ?? "", full);
      await queueEmail({
        recipient: client.email,
        sender: String(company.email ?? ""),
        fromName: String(company.name ?? ""),
        subject,
        content,
        clientId: client.id,
      });
    } catch (e) {
      await getDbWrite()
        .prepare("DELETE FROM client_order_meta WHERE client_order_id = ? AND name = 'suspension_warning_for' AND value = ?")
        .run(order.id, cand.suspension_at);
      console.error(`[cron] Failed to send order suspension warning email for order #${order.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return true;
}

/**
 * Order\Service::batchSuspendExpired, fixed: grace-aware expiry
 * (expires + MAX(COALESCE(order grace, product grace, 0), 0) <= now,
 * not a bare expires_at < now), reason from the mod_order config
 * (batch_suspend_reason trimmed, else 'Non-payment'), PHP note
 * format 'Order suspended for ' + reason. Per-order try/catch.
 * Service-call side effect: for custom services PHP's
 * _callOnService suspend is a no-op in practice (Servicecustom
 * action_suspend on a plugin-less service); the hosting-manager
 * call is a PINNED GAP (parity39 uses custom-type orders).
 */
export async function runBatchSuspendExpired(): Promise<void> {
  const config = await readExtensionConfig("mod_order");
  const configuredReason = String(config["batch_suspend_reason"] ?? "").trim();
  const reason = configuredReason !== "" ? configuredReason : "Non-payment";
  const now = nowTimestamp();
  const rows = (await getDb()
    .prepare(
      `SELECT o.id FROM client_order o LEFT JOIN product p ON p.id = o.product_id
       WHERE o.status = 'active' AND o.expires_at IS NOT NULL
         AND datetime(o.expires_at, '+' || MAX(COALESCE(o.suspension_grace_days, p.suspension_grace_days, 0), 0) || ' days') <= ?
       ORDER BY o.id`,
    )
    .all(now)) as unknown as { id: number }[];
  for (const r of rows) {
    try {
      const order = await findOrderById(r.id);
      if (!order || order.status !== "active") throw new FbError("Only active orders can be suspended");
      await updateOrderRow(order.id, { status: "suspended", reason, suspended_at: now });
      await insertOrderStatus(order.id, "suspended", `Order suspended for ${reason}`);
    } catch (e) {
      console.error(`[cron] batchSuspendExpired order #${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Order\Service::batchCancelSuspended, fixed: the mod_order config
 * GATE (batch_cancel_suspended falsy/missing → return false, NO
 * cancels — on the reference, with no mod_order config, PHP is a
 * no-op while the old TS job cancelled); calendar-day cutoff via
 * zone-aware today minus config days (default 7, negative → 7);
 * suspended_at < cutoff, ORDER BY id DESC; reason from config
 * (null → 'Order canceled', else 'Canceled order for ' + reason).
 * cancelFromOrder also nulls expires_at/suspended_at and deletes
 * the cancel_at_period_end meta — mirrored here. Subscription-cancel
 * + promo/stock-release internals are no-ops on reference-like
 * orders (no subscriptions/redemptions on crafted orders).
 */
export async function runBatchCancelSuspended(): Promise<boolean> {
  const config = await readExtensionConfig("mod_order");
  if (!phpTruthy(config["batch_cancel_suspended"])) return false;
  const reasonRaw = config["batch_cancel_suspended_reason"];
  const reason = reasonRaw === null || reasonRaw === undefined ? null : String(reasonRaw);
  const days = resolveBatchAfterDays(config["batch_cancel_suspended_after_days"]);
  const cutoff = zoneTodayString(-days);
  const rows = (await getDb()
    .prepare("SELECT id, suspended_at FROM client_order WHERE status = 'suspended' AND suspended_at < ? ORDER BY id DESC")
    .all(cutoff)) as unknown as { id: number }[];
  for (const r of rows) {
    try {
      const order = await findOrderById(r.id);
      if (!order) throw new FbError("Order not found");
      await updateOrderRow(order.id, {
        status: "canceled",
        reason,
        canceled_at: nowTimestamp(),
        expires_at: null,
        suspended_at: null,
      });
      await getDbWrite()
        .prepare("DELETE FROM client_order_meta WHERE client_order_id = ? AND name = 'cancel_at_period_end'")
        .run(order.id);
      await insertOrderStatus(order.id, "canceled", reason === null ? "Order canceled" : `Canceled order for ${reason}`);
    } catch (e) {
      console.error(`[cron] batchCancelSuspended order #${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return true;
}

/**
 * Order\Service::batchCancelUnpaid — GATE ONLY in R5f. The config
 * gate (batch_cancel_unpaid falsy/missing → false) is added because
 * it fixes the live reference divergence (PHP no-ops with no
 * mod_order config; old TS cancelled). The enabled path stays
 * PINNED DIVERGENT: PHP DELETES stale pending_setup orders (after
 * removing their linked unpaid invoice), TS marks them canceled —
 * a full cascade rewrite is out of R5f scope, so parity39 asserts
 * the gate only, never the enabled path.
 */
export async function runBatchCancelUnpaid(): Promise<boolean> {
  const config = await readExtensionConfig("mod_order");
  if (!phpTruthy(config["batch_cancel_unpaid"])) return false;
  const cutoff = fmtTs(new Date(Date.now() - 7 * 24 * 3600 * 1000));
  for (const order of await listOrders({ status: "pending_setup" })) {
    if (!order.created_at || order.created_at >= cutoff) continue;
    await updateOrderRow(order.id, { status: "canceled", canceled_at: fmtTs(new Date()) });
    await insertOrderStatus(order.id, "canceled", "Order canceled (unpaid)");
  }
  return true;
}

register("admin", "order", "batch_suspend_expired", async (ctx: CallContext) => {
  requireAdmin(ctx);
  await runBatchSuspendExpired();
  return true;
});

register("admin", "order", "batch_cancel_suspended", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await runBatchCancelSuspended();
});

register("admin", "order", "batch_cancel_unpaid", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await runBatchCancelUnpaid();
});

register("admin", "order", "batch_send_suspension_warnings", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await runBatchSendSuspensionWarnings();
});

register("admin", "order", "suspend", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  if (order.status !== "active") {
    throw new FbError("Only active orders can be suspended");
  }
  await updateOrderRow(order.id, {
    status: "suspended",
    suspended_at: fmtTs(new Date()),
    reason: ctx.params["reason"] ?? order.reason,
  });
  await insertOrderStatus(order.id, "suspended", ctx.params["reason"] ?? "Order suspended");
  return true;
});

register("admin", "order", "unsuspend", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  if (order.status !== "suspended") {
    throw new FbError("Only suspended orders can be unsuspended");
  }
  await updateOrderRow(order.id, { status: "active", unsuspended_at: fmtTs(new Date()) });
  await insertOrderStatus(order.id, "active", "Order unsuspended");
  return true;
});

register("admin", "order", "cancel", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  if (order.status === "pending_setup") {
    throw new FbError("Cannot cancel pending_setup order");
  }
  if (order.status === "canceled") {
    throw new FbError("Order is already canceled");
  }
  await updateOrderRow(order.id, { status: "canceled", canceled_at: fmtTs(new Date()) });
  await insertOrderStatus(order.id, "canceled", ctx.params["reason"] ?? "Order canceled");
  return true;
});

register("admin", "order", "uncancel", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  if (order.status !== "canceled") {
    throw new FbError("Only canceled orders can be uncanceled");
  }
  await updateOrderRow(order.id, { status: "active", canceled_at: null });
  await insertOrderStatus(order.id, "active", "Order uncanceled");
  return true;
});

/** Order\\Service::deleteFromOrder, TS-visible subset: pending_setup
 * invoice items, reserved promo + stock releases, status + meta rows,
 * the service_custom row for custom orders, then the order row.
 * Service-module deletes for non-custom types are PHP-side work the
 * TS seam cannot run (documented gap); on this install every order
 * is custom, and null-plugin custom deletes are no-ops in PHP too. */
export async function deleteOrderFull(order: OrderRowFull, forceDelete = false): Promise<void> {
  const w = getDbWrite();
  void forceDelete; // only changes adapter-error handling, which TS skips
  if (order.status === "pending_setup") {
    await w.prepare("DELETE FROM invoice_item WHERE rel_id = ? AND status = 'pending_payment'").run(String(order.id));
  }
  // Release reserved promo redemptions (any phase) + decrement usage
  // for checkout-phase ones, mirroring releasePromoRedemptions.
  const reserved = await getDb()
    .prepare("SELECT id, promo_id, phase FROM promo_redemption WHERE client_order_id = ? AND status = 'reserved'")
    .all(order.id) as { id: number; promo_id: number; phase: string }[];
  if (reserved.length) {
    const now = fmtTs(new Date());
    const checkoutCounts = new Map<number, number>();
    for (const r of reserved) {
      await w.prepare("UPDATE promo_redemption SET status = 'released', released_at = ?, release_reason = 'order_deleted', updated_at = ? WHERE id = ?").run(now, now, r.id);
      if (r.phase === "checkout") checkoutCounts.set(r.promo_id, (checkoutCounts.get(r.promo_id) ?? 0) + 1);
    }
    for (const [promoId, count] of checkoutCounts) {
      await w.prepare("UPDATE promo SET used = MAX(COALESCE(used, 0) - ?, 0), updated_at = ? WHERE id = ?").run(count, now, promoId);
    }
  }
  // Release a stock reservation, if one was recorded in order meta.
  const meta = await getDb().prepare("SELECT id, value FROM client_order_meta WHERE client_order_id = ? AND name = 'stock_reserved_qty'").get(order.id) as
    | { id: number; value: string }
    | undefined;
  if (meta) {
    const qty = parseInt(meta.value, 10) || 0;
    await w.prepare("DELETE FROM client_order_meta WHERE id = ?").run(meta.id);
    if (qty > 0 && order.product_id) {
      await w.prepare("UPDATE product SET quantity_in_stock = COALESCE(quantity_in_stock, 0) + ? WHERE id = ?").run(qty, order.product_id);
    }
  }
  await w.prepare("DELETE FROM client_order_status WHERE client_order_id = ?").run(order.id);
  await w.prepare("DELETE FROM client_order_meta WHERE client_order_id = ?").run(order.id);
  if (order.service_type === "custom" && order.service_id !== null) {
    await w.prepare("DELETE FROM service_custom WHERE id = ?").run(order.service_id);
  }
  await w.prepare("DELETE FROM client_order WHERE id = ?").run(order.id);
}

register("admin", "order", "delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrow(ctx);
  const deleteAddons = normalizeBool(ctx.params["delete_addons"]);
  const forceDelete = normalizeBool(ctx.params["force_delete"]);
  if (deleteAddons) {
    for (const addon of await getOrderAddonsList(order)) {
      await deleteOrderFull(addon, forceDelete);
    }
  }
  await deleteOrderFull(order, forceDelete);
  return true;
});

// --- Client -------------------------------------------------------------------

register("client", "order", "get", async (ctx: CallContext) => {
  requireClient(ctx);
  const order = await getOrderOrThrow(ctx, "Order not found");
  if (order.client_id !== ctx.session!.client!.id) {
    throw new FbError("Order not found");
  }
  return await orderArray(order, false);
});

register("client", "order", "get_list", async (ctx: CallContext) => {
  requireClient(ctx);
  const filters: { client_id?: number; status?: string } = {
    client_id: ctx.session!.client!.id,
  };
  if (ctx.params["status"]) filters.status = ctx.params["status"];
  return paginateLocal(await Promise.all((await listOrders(filters)).map(async (o) => await orderArray(o, false, false, true))), ctx.params);
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

async function getOrderOrThrowAdmin(ctx: CallContext): Promise<OrderRowFull> {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order ID was not passed");
  const order = await findOrderById(Number(id));
  if (!order) throw new FbError("Order Not Found");
  return order;
}

async function getOrderOrThrowClient(ctx: CallContext): Promise<OrderRowFull> {
  const id = ctx.params["id"];
  if (!id) throw new FbError("Order id required");
  const order = await findOrderById(Number(id));
  if (!order || order.client_id !== ctx.session!.client!.id) throw new FbError("Order not found");
  return order;
}

/** Same group + client, not a master, excluding the order itself. */
async function getOrderAddonsList(order: OrderRowFull): Promise<OrderRowFull[]> {
  if (!order.group_id) return [];
  // PHP's repository query has no ORDER BY: rowid (id ASC) order.
  return (await listOrders({}))
    .filter(
      (o) => o.group_id === order.group_id && o.client_id === order.client_id && o.id !== order.id && !o.group_master,
    )
    .sort((a, b) => a.id - b.id);
}

async function customServiceArray(serviceId: number): Promise<Record<string, unknown> | null> {
  const row = await getDb().prepare("SELECT id, client_id, plugin, config, created_at, updated_at FROM service_custom WHERE id = ?").get(serviceId) as
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

/* ------------------------------------------------------------------ */
/* Phase 5 R2c: service toApiArray ports (admin/order/service).        */
/* PHP renders service detail only via Order::getOrderServiceData,    */
/* which calls each service module's toApiArray with the identity;    */
/* admin-only fields are included only for staff identity. The TS    */
/* seam previously returned null for every non-custom type.           */
/* ------------------------------------------------------------------ */

/** PHP Tools::normalizePort: int/string in 1..65535, else the default. */
function normalizePort(v: unknown, dflt: number | null): number | null {
  if (typeof v !== "number" && typeof v !== "string") return dflt;
  const s = typeof v === "string" ? v.trim() : String(v);
  if (!/^-?\d+$/.test(s)) return dflt;
  const n = parseInt(s, 10);
  return n >= 1 && n <= 65535 ? n : dflt;
}

function jsonList(v: unknown): unknown[] {
  if (typeof v !== "string" || v === "") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonObjectOr(v: unknown, fallback: unknown): unknown {
  if (typeof v !== "string" || v === "") return fallback;
  try {
    const parsed: unknown = JSON.parse(v);
    // PHP json_decode('{}', true) is an empty PHP array, which encodes
    // as [] — not {} — so empty objects collapse to [] here.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
      return [];
    }
    return parsed;
  } catch {
    return fallback;
  }
}

/** PHP Servicehosting::getManagerUrls, for the ported managers. */
function hostingManagerUrls(server: {
  manager: string | null;
  hostname: string | null;
  port: unknown;
}): [unknown, unknown] {
  if (server.manager === "Custom") return ["http://www.google.com?q=cpanel", "http://www.google.com?q=whm"];
  if (server.manager === "Hestia") {
    if (!server.hostname) return [false, false];
    const url = `https://${server.hostname}:${normalizePort(server.port, 8083)}/`;
    return [url, url];
  }
  // Other managers' adapters are not ported; PHP would call the adapter
  // (or return [false, false] if it throws). Documented divergence.
  return [false, false];
}

/** PHP Servicehosting::getServerManagerSecretFields, ported managers. */
function hostingSecretFields(manager: string | null): string[] {
  // Custom declares no extras; Hestia's form marks username + accesshash
  // secret (base already has password + accesshash).
  if (manager === "Hestia") return ["password", "accesshash", "username"];
  return ["password", "accesshash"];
}

interface HostingServerRow {
  id: number;
  name: string | null;
  hostname: string | null;
  ip: string | null;
  ns1: string | null;
  ns2: string | null;
  ns3: string | null;
  ns4: string | null;
  assigned_ips: string | null;
  status_url: string | null;
  active: number;
  max_accounts: number | null;
  manager: string | null;
  username: string | null;
  password: string | null;
  accesshash: string | null;
  password_length: number | null;
  port: unknown;
  config: string | null;
  secure: number;
  created_at: string | null;
  updated_at: string | null;
}

function hostingServerArray(server: HostingServerRow, isAdmin: boolean): Record<string, unknown> {
  const [cpanelUrl, whmUrl] = hostingManagerUrls(server);
  const out: Record<string, unknown> = {
    name: server.name,
    hostname: server.hostname,
    ip: server.ip,
    ns1: server.ns1,
    ns2: server.ns2,
    ns3: server.ns3,
    ns4: server.ns4,
    cpanel_url: cpanelUrl,
    reseller_cpanel_url: whmUrl,
  };
  if (isAdmin) {
    out["id"] = server.id;
    out["active"] = !!server.active;
    out["secure"] = !!server.secure;
    out["assigned_ips"] = jsonList(server.assigned_ips);
    out["status_url"] = server.status_url;
    out["max_accounts"] = server.max_accounts;
    out["manager"] = server.manager;
    out["config"] = jsonObjectOr(server.config, []);
    out["port"] = normalizePort(server.port, null);
    out["passwordLength"] = server.password_length;
    out["created_at"] = server.created_at;
    out["updated_at"] = server.updated_at;
    const secrets = hostingSecretFields(server.manager);
    const values: Record<string, string | null> = {
      password: server.password,
      accesshash: server.accesshash,
      username: server.username,
    };
    for (const field of secrets) {
      const raw = values[field] ?? null;
      out[field] = null;
      out[`${field}_set`] = raw !== null && raw !== "";
    }
    out["secret_fields"] = secrets;
  }
  return out;
}

interface HostingHpRow {
  id: number;
  name: string | null;
  bandwidth: string | null;
  quota: string | null;
  max_ftp: number | null;
  max_sql: number | null;
  max_pop: number | null;
  max_sub: number | null;
  max_park: number | null;
  max_addon: number | null;
  config: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function hostingHpArray(hp: HostingHpRow): Record<string, unknown> {
  return {
    id: hp.id,
    name: hp.name,
    bandwidth: hp.bandwidth,
    quota: hp.quota,
    max_ftp: hp.max_ftp,
    max_sql: hp.max_sql,
    max_pop: hp.max_pop,
    max_sub: hp.max_sub,
    max_park: hp.max_park,
    max_addon: hp.max_addon,
    // PHP: json_decode(config ?? '', true) with NO [] fallback — null when empty.
    config: hp.config ? jsonObjectOr(hp.config, null) : null,
    created_at: hp.created_at,
    updated_at: hp.updated_at,
  };
}

async function hostingServiceArray(order: OrderRowFull, isAdmin: boolean): Promise<Record<string, unknown> | null> {
  const row = await getDb()
    .prepare("SELECT * FROM service_hosting WHERE id = ?")
    .get(String(order.service_id)) as unknown as
    | {
        id: number;
        ip: string | null;
        sld: string | null;
        tld: string | null;
        username: string | null;
        reseller: number;
        service_hosting_server_id: number | null;
        service_hosting_hp_id: number | null;
      }
    | undefined;
  if (!row) return null;
  const server = await getDb()
    .prepare("SELECT * FROM service_hosting_server WHERE id = ?")
    .get(String(row.service_hosting_server_id)) as unknown as HostingServerRow | undefined;
  if (!server) throw new FbError("Server not found");
  const hp = await getDb()
    .prepare("SELECT * FROM service_hosting_hp WHERE id = ?")
    .get(String(row.service_hosting_hp_id)) as unknown as HostingHpRow | undefined;
  if (!hp) throw new FbError("Hosting plan not found");
  // PHP _getDomainOrderId: only when this order's config has a domain
  // action of register/transfer; the related order shares group_id and
  // has service_type 'domain'.
  let domainOrderId: number | null = null;
  try {
    const cfg = order.config ? (JSON.parse(order.config) as Record<string, unknown>) : {};
    const domain = cfg["domain"] as Record<string, unknown> | undefined;
    const action = domain?.["action"];
    if ((action === "register" || action === "transfer") && order.group_id !== null && order.group_id !== undefined) {
      const rel = await getDb()
        .prepare("SELECT id FROM client_order WHERE group_id = ? AND service_type = 'domain' ORDER BY id ASC LIMIT 1")
        .get(String(order.group_id)) as unknown as { id: number } | undefined;
      domainOrderId = rel ? rel.id : null;
    }
  } catch {
    domainOrderId = null;
  }
  return {
    ip: row.ip,
    sld: row.sld,
    tld: row.tld,
    domain: `${row.sld ?? ""}${row.tld ?? ""}`,
    username: row.username,
    reseller: !!row.reseller,
    server: hostingServerArray(server, isAdmin),
    hosting_plan: hostingHpArray(hp),
    domain_order_id: domainOrderId,
  };
}

/** PHP (int) cast for Doctrine integer columns: leading digits, else 0. */
function phpIntCast(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Math.trunc(v);
  const m = /^\s*[+-]?\d+/.exec(String(v));
  return m ? parseInt(m[0], 10) : 0;
}

async function domainServiceArray(order: OrderRowFull, isAdmin: boolean): Promise<Record<string, unknown> | null> {
  const row = await getDb()
    .prepare("SELECT * FROM service_domain WHERE id = ?")
    .get(String(order.service_id)) as unknown as
    | {
        sld: string | null;
        tld: string | null;
        ns1: string | null;
        ns2: string | null;
        ns3: string | null;
        ns4: string | null;
        period: string | number | null;
        privacy: number;
        locked: number;
        registered_at: string | null;
        expires_at: string | null;
        synced_at: string | null;
        contact_first_name: string | null;
        contact_last_name: string | null;
        contact_email: string | null;
        contact_company: string | null;
        contact_address1: string | null;
        contact_address2: string | null;
        contact_country: string | null;
        contact_city: string | null;
        contact_state: string | null;
        contact_postcode: string | null;
        contact_phone_cc: string | null;
        contact_phone: string | null;
        transfer_code: string | null;
        tld_registrar_id: number | null;
      }
    | undefined;
  if (!row) return null;
  const out: Record<string, unknown> = {
    domain: `${row.sld ?? ""}${row.tld ?? ""}`,
    sld: row.sld,
    tld: row.tld,
    ns1: row.ns1,
    ns2: row.ns2,
    ns3: row.ns3,
    ns4: row.ns4,
    // PHP ServiceDomain::$period is ?int (Doctrine integer type casts
    // the stored value, so '1Y' reads back as 1).
    period: phpIntCast(row.period),
    privacy: !!row.privacy,
    locked: !!row.locked,
    registered_at: row.registered_at,
    expires_at: row.expires_at,
    synced_at: row.synced_at,
    contact: {
      first_name: row.contact_first_name,
      last_name: row.contact_last_name,
      email: row.contact_email,
      company: row.contact_company,
      address1: row.contact_address1,
      address2: row.contact_address2,
      country: row.contact_country,
      city: row.contact_city,
      state: row.contact_state,
      postcode: row.contact_postcode,
      phone_cc: row.contact_phone_cc,
      phone: row.contact_phone,
    },
  };
  if (isAdmin) {
    out["transfer_code"] = row.transfer_code;
    const reg = row.tld_registrar_id
      ? (await getDb().prepare("SELECT name FROM tld_registrar WHERE id = ?").get(String(row.tld_registrar_id)) as unknown as
          | { name: string | null }
          | undefined)
      : undefined;
    out["registrar"] = reg ? reg.name : null;
  }
  return out;
}

async function licenseServiceArray(order: OrderRowFull, isAdmin: boolean): Promise<Record<string, unknown> | null> {
  const row = await getDb()
    .prepare("SELECT * FROM service_license WHERE id = ?")
    .get(String(order.service_id)) as unknown as
    | {
        license_key: string | null;
        validate_ip: number;
        validate_host: number;
        validate_version: number;
        validate_path: number;
        ips: string | null;
        hosts: string | null;
        paths: string | null;
        versions: string | null;
        pinged_at: string | null;
        plugin: string | null;
      }
    | undefined;
  if (!row) return null;
  const out: Record<string, unknown> = {
    license_key: row.license_key,
    validate_ip: !!row.validate_ip,
    validate_host: !!row.validate_host,
    validate_version: !!row.validate_version,
    validate_path: !!row.validate_path,
    ips: jsonList(row.ips),
    hosts: jsonList(row.hosts),
    paths: jsonList(row.paths),
    versions: jsonList(row.versions),
    pinged_at: row.pinged_at,
  };
  if (isAdmin) out["plugin"] = row.plugin;
  return out;
}

async function downloadableServiceArray(order: OrderRowFull, isAdmin: boolean): Promise<Record<string, unknown> | null> {
  const row = await getDb()
    .prepare("SELECT id FROM service_downloadable WHERE id = ?")
    .get(String(order.service_id)) as unknown as { id: number } | undefined;
  if (!row) return null;
  const files = await getDb()
    .prepare(
      "SELECT * FROM service_downloadable_file WHERE service_downloadable_id = ? ORDER BY sort_order ASC, id ASC",
    )
    .all(String(order.service_id)) as unknown as {
    id: number;
    filename: string | null;
    label: string | null;
    description: string | null;
    stored_filename: string | null;
    downloads: number | null;
  }[];
  // PHP PATH_UPLOADS is the uploads dir next to the database file.
  const dbPath = process.env.FB_DATABASE_PATH ?? "";
  const uploadsDir = dbPath.includes("/") ? dbPath.slice(0, dbPath.lastIndexOf("/")) + "/uploads" : "uploads";
  return {
    files: files.map((f) => {
      const item: Record<string, unknown> = {
        id: f.id,
        filename: f.filename,
        label: f.label,
        description: f.description,
      };
      if (isAdmin) {
        item["path"] = `${uploadsDir}/${f.stored_filename ?? ""}`;
        item["downloads"] = f.downloads;
      }
      return item;
    }),
  };
}

async function orderServiceData(order: OrderRowFull, isAdmin: boolean): Promise<Record<string, unknown> | null> {
  if (order.service_id === null) return null;
  switch (order.service_type) {
    case "custom":
      return await customServiceArray(order.service_id);
    case "hosting":
      return await hostingServiceArray(order, isAdmin);
    case "domain":
      return await domainServiceArray(order, isAdmin);
    case "license":
      return await licenseServiceArray(order, isAdmin);
    case "downloadable":
      return await downloadableServiceArray(order, isAdmin);
    default:
      return null;
  }
}

register("admin", "order", "get_invoice_options", (ctx: CallContext) => {
  requireAdmin(ctx);
  return {
    "issue-invoice": "Automatically Issue Renewal Invoices",
    "no-invoice": "Issue Invoices Manually",
  };
});

register("admin", "order", "service", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await orderServiceData(await getOrderOrThrowAdmin(ctx), true);
});

register("admin", "order", "addons", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await Promise.all((await getOrderAddonsList(await getOrderOrThrowAdmin(ctx))).map(async (o) => await orderArray(o, false)));
});

register("admin", "order", "can_cancel_at_period_end", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrowAdmin(ctx);
  // Active subscriptions (via invoice items on the order's invoices)
  // with a non-empty sid, whose gateway adapter implements
  // cancelSubscriptionAtPeriodEnd. Only Stripe implements it among
  // the bundled adapters.
  const subs = await getDb().prepare(
    `SELECT DISTINCT s.sid, s.pay_gateway_id, s.status FROM subscription s
     JOIN invoice_item ii ON ii.invoice_id = s.rel_id
     WHERE s.rel_type = 'invoice' AND ii.type = 'order' AND ii.rel_id = ? AND s.status = 'active'`,
  ).all(String(order.id)) as { sid: string | null; pay_gateway_id: number | null; status: string }[];
  if (subs.length === 0) return false;
  for (const sub of subs) {
    if ((sub.sid ?? "").trim() === "") return false;
    const gw = sub.pay_gateway_id ? await getDb().prepare("SELECT gateway FROM pay_gateway WHERE id = ?").get(sub.pay_gateway_id) as { gateway: string } | undefined : undefined;
    if (!gw || gw.gateway !== "Stripe") return false;
  }
  return true;
});

register("admin", "order", "update_config", async (ctx: CallContext) => {
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
  const order = await getOrderOrThrowAdmin(ctx);
  // Form-linked orders merge form answers in PHP (formbuilder is
  // unported); on this install no order has a form_id, so the plain
  // wholesale replacement below is exact. Form orders are a
  // documented gap.
  await getDbWrite().prepare("UPDATE client_order SET config = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(config), fmtTs(new Date()), order.id,
  );
  return true;
});

/** Renew: pending/failed_setup orders activate; anything else extends
 * the expiry by the order's period (from the current expiry, per the
 * default renewal logic) and re-activates. Service-module renew calls
 * are no-ops for null-plugin custom orders. */
async function renewOrderRow(order: OrderRowFull): Promise<void> {
  if (order.status === "pending_setup" || order.status === "failed_setup") {
    await activateOrderRow(order);
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
  await updateOrderRow(order.id, updates);
  await insertOrderStatus(order.id, "active", "Order renewed");
}

register("admin", "order", "renew", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const order = await getOrderOrThrowAdmin(ctx);
  await renewOrderRow(order);
  return true;
});

register("admin", "order", "batch_delete", async (ctx: CallContext) => {
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
    const order = await findOrderById(Number(id));
    if (!order) throw new FbError("Order Not Found");
    if (deleteAddons) {
      for (const addon of await getOrderAddonsList(order)) {
        await deleteOrderFull(addon, forceDelete);
      }
    }
    await deleteOrderFull(order, forceDelete);
  }
  return true;
});

// NOTE (deliberate, documented): admin order export_csv is a CSV
// download, like client/invoice export_csv; it stays PHP-served
// through the proxy (binary-safe since the arrayBuffer fix).

register("client", "order", "addons", async (ctx: CallContext) => {
  requireClient(ctx);
  return await Promise.all((await getOrderAddonsList(await getOrderOrThrowClient(ctx))).map(async (o) => await orderArray(o, false)));
});

register("client", "order", "service", async (ctx: CallContext) => {
  requireClient(ctx);
  const order = await getOrderOrThrowClient(ctx);
  if (order.status !== "active") throw new FbError("Order is not active");
  return await orderServiceData(order, false);
});

register("client", "order", "upgradables", async (ctx: CallContext) => {
  requireClient(ctx);
  const order = await getOrderOrThrowClient(ctx);
  const product = order.product_id ? await findProductById(order.product_id) : undefined;
  if (!product) return [];
  let upgradeIds: unknown[] = [];
  try {
    const parsed = product.upgrades ? (JSON.parse(product.upgrades) as unknown) : [];
    upgradeIds = Array.isArray(parsed) ? parsed : [];
  } catch { /* keep [] */ }
  const out: Record<string, string> = {};
  for (const p of await listAllProducts()) {
    if (upgradeIds.map(Number).includes(p.id) && p.id !== product.id) out[String(p.id)] = p.title;
  }
  // PHP's empty array encodes as [], not {}.
  return Object.keys(out).length ? out : [];
});

register("client", "order", "delete", async (ctx: CallContext) => {
  requireClient(ctx);
  const order = await getOrderOrThrowClient(ctx);
  if (order.status !== "pending_setup" && order.status !== "failed_setup") {
    throw new FbError("Only pending and failed setup orders can be deleted.");
  }
  await deleteOrderFull(order);
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

register("admin", "order", "export_csv", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return await exportCsvResponse(
    "client_order",
    "orders.csv",
    ORDER_EXPORTABLE,
    ORDER_DEFAULT_EXPORT,
    requestedCsvHeaders(ctx.rawParams, ctx.params),
  );
});
