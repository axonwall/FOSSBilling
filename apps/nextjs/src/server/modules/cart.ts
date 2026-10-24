import { randomBytes } from "node:crypto";
import {
  clearCartProducts,
  clientBalanceSum,
  countPromoRedemptionsForClient,
  deleteCartProductRow,
  deleteCartRow,
  findCartBySession,
  findClientById,
  findCurrencyByCode,
  findDefaultCurrency,
  findProductById,
  findProductPayment,
  findPromoByCode,
  findPromoById,
  incrementPromoUsed,
  insertCart,
  insertCartProduct,
  insertOrder,
  insertOrderStatus,
  insertPromoRedemption,
  listCartProducts,
  listCurrencies,
  listProductPeriods,
  setClientCurrency,
  updateCartRow,
  updateOrderUnpaidInvoice,
  type CartProductRow,
  type CartRow,
  type CurrencyRow,
  type ProductRow,
  type PromoRow,
} from "../db";
import { FbError, register, requireClient, type CallContext } from "../dispatch";
import { ensureSession } from "../session";
import { isClientTaxable, issueInvoice, prepareInvoice, round2, type InvoiceItemInput } from "../money";
import { currencyToApi } from "./currency";
import { productUnit } from "./product";

/**
 * Cart module (guest cart + client checkout) — TS port of
 * src/modules/Cart/{Api,Service}.php for the catalog paths: simple
 * products (once/recurrent pricing), manual promo codes, and checkout
 * into orders + one invoice. Deferred (documented): addons, domain /
 * hosting product configs, automatic promos, staff baskets, related-
 * item discounts, stock control. Parity oracle: capture9.py +
 * the Phase 3 fixture corpus replayed through the Next origin.
 */

export const CART_FAMILY_KEY = "__cart_family";

function phpTruthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0";
}

export function currencyArray(row: CurrencyRow): Record<string, unknown> {
  return currencyToApi(row);
}

function cartCurrency(cart: CartRow): CurrencyRow {
  const all = listCurrencies();
  return (
    all.find((c) => c.id === cart.currency_id) ?? findDefaultCurrency() ?? all[0]
  );
}

function getSessionCart(ctx: CallContext): CartRow {
  const session = ensureSession(ctx);
  let cart = findCartBySession(session.id);
  if (cart) return cart;
  let currency: CurrencyRow | undefined;
  if (session.client) {
    const client = findClientById(session.client.id);
    if (client?.currency) currency = findCurrencyByCode(client.currency);
  }
  currency ??= findDefaultCurrency();
  if (!currency) throw new FbError("Default currency not found");
  const id = insertCart(session.id, currency.id);
  cart = findCartBySession(session.id);
  if (!cart) throw new FbError("Cart could not be created");
  void id;
  return cart;
}

export function productPrice(product: ProductRow, config: Record<string, unknown>): number {
  const payment = product.product_payment_id ? findProductPayment(product.product_payment_id) : undefined;
  if (!payment || payment.type === "free") return 0;
  if (payment.type === "once") return payment.once_price ?? 0;
  if (payment.type === "recurrent") {
    const period = listProductPeriods(payment.id).find((p) => p.code === config["period"]);
    return period?.price ?? 0;
  }
  return 0;
}

export function productSetupPrice(product: ProductRow, config: Record<string, unknown>): number {
  const payment = product.product_payment_id ? findProductPayment(product.product_payment_id) : undefined;
  if (!payment || payment.type === "free") return 0;
  if (payment.type === "once") return payment.once_setup_price ?? 0;
  if (payment.type === "recurrent") {
    const period = listProductPeriods(payment.id).find((p) => p.code === config["period"]);
    return period?.setup_price ?? 0;
  }
  return 0;
}

function isRecurrent(product: ProductRow): boolean {
  const payment = product.product_payment_id ? findProductPayment(product.product_payment_id) : undefined;
  return payment?.type === "recurrent";
}

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function jsonList(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Product\Service::isPromoApplicableToProduct (products/periods scope). */
export function promoAppliesTo(promo: PromoRow, productId: number, config: Record<string, unknown>): boolean {
  const products = jsonList(promo.products).map(Number);
  if (products.length > 0 && !products.includes(productId)) return false;
  const periods = jsonList(promo.periods).map(String);
  if (periods.length > 0) {
    const period = config["period"];
    if (typeof period !== "string" || !periods.includes(period)) return false;
  }
  return true;
}

/** Product\Service::getProductDiscount for one item. */
export function itemPromoDiscount(promo: PromoRow, product: ProductRow, config: Record<string, unknown>): number {
  if (!promoAppliesTo(promo, product.id, config)) return 0;
  const qty = Math.max(1, parseInt(String(config["quantity"] ?? "1"), 10) || 1);
  const price = productPrice(product, config) * qty;
  if (price === 0) return 0;
  if (promo.type === "absolute") return promo.value;
  if (promo.type === "percentage") return round2((price * promo.value) / 100);
  return 0;
}

interface CartItemView extends Record<string, unknown> {
  id: number;
  product_id: number;
  price: number;
  setup_price: number;
  quantity: number;
  discount: number;
  discount_price: number;
  discount_setup: number;
  total: number;
}

function cartItemArray(cp: CartProductRow, promo: PromoRow | null): CartItemView {
  const product = findProductById(cp.product_id);
  const config = parseConfig(cp.config);
  const qty = Math.max(1, parseInt(String(config["quantity"] ?? "1"), 10) || 1);
  const price = product ? productPrice(product, config) : 0;
  const setup = product ? productSetupPrice(product, config) : 0;
  let discountPrice = 0;
  let discountSetup = 0;
  if (promo && product) {
    const raw = itemPromoDiscount(promo, product, config);
    const subtotal = price * qty;
    discountPrice = Math.min(raw, subtotal);
    if (promo.freesetup && promoAppliesTo(promo, product.id, config)) {
      discountSetup = setup;
    }
  }
  let discountTotal = discountPrice + discountSetup;
  const subtotal = price * qty;
  if (Math.abs(discountTotal) > subtotal + setup) {
    discountTotal = subtotal;
    discountPrice = subtotal;
  }
  return {
    ...config,
    id: cp.id,
    product_id: cp.product_id,
    form_id: product?.form_id ?? null,
    title: product?.title ?? "",
    type: product?.type ?? null,
    quantity: qty,
    unit: product ? productUnit(product) : null,
    price,
    setup_price: setup,
    discount: discountTotal,
    discount_price: discountPrice,
    discount_setup: discountSetup,
    total: subtotal,
  };
}

export function cartArray(cart: CartRow): Record<string, unknown> {
  const promo = cart.promo_id ? (findPromoById(cart.promo_id) ?? null) : null;
  const items = listCartProducts(cart.id).map((cp) => cartItemArray(cp, promo));
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    subtotal += item.total + item.setup_price;
    discount += item.discount;
  }
  return {
    promocode: promo?.code ?? null,
    promo_source: cart.promo_id ? "manual" : null,
    auto_promos: [],
    discount,
    subtotal,
    total: subtotal - discount,
    items,
    currency: currencyArray(cartCurrency(cart)),
    subscribable: isSubscribable(items),
  };
}

function isSubscribable(items: CartItemView[]): boolean {
  let period: unknown = null;
  for (const item of items) {
    const netSetup = (item.setup_price ?? 0) - (item.discount_setup ?? 0);
    if (netSetup > 0) return false;
    if ((item.total ?? 0) <= 0) continue;
    const p = item["period"];
    if (!p) return false;
    if (period === null) period = p;
    else if (period !== p) return false;
  }
  return period !== null;
}

function resetCart(cart: CartRow): void {
  clearCartProducts(cart.id);
  updateCartRow(cart.id, { promo_id: null });
}

// --- Guest cart handlers -------------------------------------------------

register("guest", "cart", "get", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  return cartArray(cart);
});

register("guest", "cart", "reset", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  resetCart(cart);
  return true;
});

register("guest", "cart", "add_item", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Product ID was not passed");
  const product = findProductById(Number(idRaw));
  if (!product || product.active !== 1) throw new FbError("Product not found");
  if (product.is_addon) {
    throw new FbError("Addon products cannot be added separately.");
  }
  // PHP resets the cart by default: one add = one fresh cart, unless
  // the caller passes `multiple`.
  if (!phpTruthy(ctx.params["multiple"])) resetCart(cart);
  if (isRecurrent(product)) {
    const period = ctx.params["period"];
    if (!period) throw new FbError("Period parameter not passed");
    const payment = findProductPayment(product.product_payment_id!)!;
    const enabled = listProductPeriods(payment.id).some((p) => p.code === period && p.enabled);
    if (!enabled) throw new FbError("Selected billing period is invalid");
  }
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.params)) {
    // PHP stores the whole request (minus id/addons) as the item config
    // — including `multiple`, which then leaks into the item array.
    if (["id", "addons", "CSRFToken"].includes(k)) continue;
    config[k] = v;
  }
  config[CART_FAMILY_KEY] = randomBytes(16).toString("hex");
  insertCartProduct(cart.id, product.id, JSON.stringify(config));
  return true;
});

register("guest", "cart", "remove_item", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  const id = Number(ctx.params["id"] ?? 0);
  const item = listCartProducts(cart.id).find((cp) => cp.id === id);
  if (item) deleteCartProductRow(item.id);
  return true;
});

register("guest", "cart", "get_currency", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  return currencyArray(cartCurrency(cart));
});

register("guest", "cart", "set_currency", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  const code = ctx.params["currency"];
  const currency = code ? findCurrencyByCode(code) : undefined;
  if (!currency) throw new FbError("Currency not found");
  updateCartRow(cart.id, { currency_id: currency.id });
  return true;
});

function promoCanBeApplied(promo: PromoRow): boolean {
  if (!promo.active) return false;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (promo.start_at && promo.start_at > now) return false;
  if (promo.end_at && promo.end_at < now) return false;
  if (promo.maxuses && (promo.used ?? 0) >= promo.maxuses) return false;
  return true;
}

function promoGroupAvailable(promo: PromoRow, clientId: number | null): boolean {
  const groups = jsonList(promo.client_groups).map(Number);
  if (groups.length === 0) return true;
  if (clientId === null) return false;
  // Client group membership is checked against client_group_members.
  return clientGroupIds(clientId).some((g) => groups.includes(g));
}

import { getDb } from "../db";
function clientGroupIds(clientId: number): number[] {
  const rows = getDb()
    .prepare("SELECT client_group_id FROM client_group_members WHERE client_id = ?")
    .all(clientId) as unknown as { client_group_id: number }[];
  return rows.map((r) => r.client_group_id);
}

function assertPromoCondition(cart: CartRow, promo: PromoRow): void {
  const required = jsonList(promo.requires_products).map(Number);
  if (required.length === 0) return;
  const inCart = new Set(listCartProducts(cart.id).map((cp) => cp.product_id));
  const missing = required.filter((id) => !inCart.has(id));
  if (missing.length > 0) {
    const titles = missing.map((id) => findProductById(id)?.title ?? `#${id}`);
    throw new FbError(
      `This promo code requires the following products in the cart: ${titles.join(", ")}`,
    );
  }
}

register("guest", "cart", "apply_promo", (ctx: CallContext) => {
  const code = ctx.params["promocode"];
  const promo = code ? findPromoByCode(code) : undefined;
  if (!promo || !promo.active) {
    throw new FbError("The promo code has expired or does not exist");
  }
  const clientId = ctx.session?.client?.id ?? null;
  if (!promoGroupAvailable(promo, clientId)) {
    throw new FbError("Promo code cannot be applied to your account");
  }
  if (!promoCanBeApplied(promo)) {
    throw new FbError("The promo code has expired or does not exist");
  }
  const cart = getSessionCart(ctx);
  if (cart.promo_id === promo.id) return true;
  if (listCartProducts(cart.id).length === 0) {
    throw new FbError("Add products to your cart before applying promo code");
  }
  assertPromoCondition(cart, promo);
  updateCartRow(cart.id, { promo_id: promo.id });
  return true;
});

register("guest", "cart", "remove_promo", (ctx: CallContext) => {
  const cart = getSessionCart(ctx);
  updateCartRow(cart.id, { promo_id: null });
  return true;
});

// --- Client checkout -----------------------------------------------------

register("client", "cart", "checkout", (ctx: CallContext) => {
  requireClient(ctx);
  const client = findClientById(ctx.session!.client!.id);
  if (!client) throw new FbError("Client not found");
  const cart = getSessionCart(ctx);
  const promo = cart.promo_id ? (findPromoById(cart.promo_id) ?? null) : null;

  if (promo) {
    if (
      promo.once_per_client &&
      countPromoRedemptionsForClient(promo.id, client.id) > 0
    ) {
      throw new FbError(
        "You have already used this promo code. Please remove the promo code and checkout again.",
        9874,
      );
    }
    if (!promoGroupAvailable(promo, client.id)) {
      throw new FbError("Promo code cannot be applied to your account");
    }
    assertPromoCondition(cart, promo);
  }

  const view = cartArray(cart);
  const items = view["items"] as CartItemView[];
  if (items.length === 0) throw new FbError("Cannot checkout an empty cart");

  const currency = cartCurrency(cart);
  if (!client.currency) {
    setClientCurrency(client.id, currency.code);
    client.currency = currency.code;
  }
  if (client.currency !== currency.code) {
    throw new FbError(
      `Selected currency ${currency.code} does not match your profile currency ${client.currency}. Please change cart currency to continue.`,
    );
  }

  const rate = currency.conversion_rate;
  const taxed = isClientTaxable(client);
  const familyGroups = new Map<string, string>();
  const lastGroupByProduct = new Map<number, string>();
  let familyIndex = 0;
  const nextGroup = () => `${cart.id}_${++familyIndex}`;

  const orderIds: number[] = [];
  const invoiceItems: InvoiceItemInput[] = [];
  const discountsByOrder = new Map<number, number>();

  for (const cp of listCartProducts(cart.id)) {
    const item = cartItemArray(cp, promo);
    const product = findProductById(cp.product_id);
    if (!product) continue;
    if (product.status !== "enabled") {
      throw new FbError("Unable to complete order. One or more of the selected products are invalid.");
    }
    const token = item[CART_FAMILY_KEY];
    let groupId: string;
    if (typeof token === "string" && token !== "") {
      groupId = familyGroups.get(token) ?? nextGroup();
      familyGroups.set(token, groupId);
    } else if (product.is_addon && lastGroupByProduct.has(product.id)) {
      groupId = lastGroupByProduct.get(product.id)!;
    } else {
      groupId = nextGroup();
    }
    lastGroupByProduct.set(product.id, groupId);

    const configForOrder = { ...item };
    delete configForOrder[CART_FAMILY_KEY];
    const orderPrice = round2(item.price * rate);
    const orderDiscount = round2(item.discount_price * rate);
    const orderId = insertOrder({
      client_id: client.id,
      product_id: product.id,
      form_id: product.form_id,
      promo_id: promo?.id ?? null,
      promo_recurring: promo ? promo.recurring : null,
      promo_used: promo ? 1 : null,
      group_id: groupId,
      group_master: product.is_addon ? 0 : 1,
      invoice_option: "issue-invoice",
      title: String(item.title),
      currency: currency.code,
      unpaid_invoice_id: null,
      service_type: product.type,
      period: typeof item["period"] === "string" ? (item["period"] as string) : null,
      quantity: item.quantity,
      unit: productUnit(product),
      price: orderPrice,
      discount: orderDiscount,
      status: "pending_setup",
      notes: typeof item["notes"] === "string" ? (item["notes"] as string) : null,
      config: JSON.stringify(configForOrder),
      suspension_grace_days: null,
    });
    orderIds.push(orderId);
    insertOrderStatus(orderId, "pending_setup", "Order Created");
    if (promo) {
      incrementPromoUsed(promo.id);
      discountsByOrder.set(orderId, round2(item.discount_price * rate));
    }

    invoiceItems.push({
      title: String(item.title),
      price: orderPrice,
      quantity: item.quantity,
      unit: productUnit(product),
      period: typeof item["period"] === "string" ? (item["period"] as string) : null,
      taxed,
      type: "order",
      rel_id: orderId,
      task: "activate",
    });
    if (orderDiscount > 0) {
      invoiceItems.push({
        title: `Discount: ${String(item.title)}`,
        price: -orderDiscount,
        quantity: 1,
        unit: "discount",
        rel_id: orderId,
        taxed,
        type: "custom",
        task: "void",
      });
    }
    if (item.setup_price > 0) {
      const setupNet = round2(item.setup_price * rate) - round2(item.discount_setup * rate);
      invoiceItems.push({
        title: `${String(item.title)} setup`,
        price: setupNet,
        quantity: 1,
        unit: "service",
        taxed,
        type: "custom",
        task: "void",
      });
    }
  }

  const total = view["total"] as number;
  let invoiceHash: string | null = null;
  let invoiceId: number | null = null;
  if (total > 0) {
    const gatewayId = ctx.params["gateway_id"] ? Number(ctx.params["gateway_id"]) : null;
    invoiceId = prepareInvoice(client, invoiceItems, gatewayId);
    const balance = clientBalanceSum(client.id);
    const useCredits = round2(balance) >= round2(total);
    issueInvoice(invoiceId, client, { useCredits });
    // The invoice stays unpaid unless credits covered it in full.
    if (readInvoiceStatus(invoiceId) !== "paid") {
      for (const oid of orderIds) updateOrderUnpaidInvoice(oid, invoiceId);
      invoiceHash = readInvoiceHash(invoiceId);
    }
  }

  if (promo) {
    const status = invoiceId !== null && invoiceHash !== null ? "reserved" : "committed";
    for (const oid of orderIds) {
      insertPromoRedemption({
        promo_id: promo.id,
        client_id: client.id,
        client_order_id: oid,
        invoice_id: invoiceId,
        phase: "checkout",
        status,
        discount_amount: discountsByOrder.get(oid) ?? 0,
        currency: currency.code,
      });
    }
  }

  deleteCartRow(cart.id);
  return {
    gateway_id: ctx.params["gateway_id"] ?? null,
    invoice_hash: invoiceHash,
    order_id: orderIds[0],
    orders: orderIds,
  };
});

function readInvoiceStatus(invoiceId: number): string | null {
  const row = getDb()
    .prepare("SELECT status FROM invoice WHERE id = ?")
    .get(invoiceId) as { status: string } | undefined;
  return row?.status ?? null;
}

function readInvoiceHash(invoiceId: number): string | null {
  const row = getDb()
    .prepare("SELECT hash FROM invoice WHERE id = ?")
    .get(invoiceId) as { hash: string } | undefined;
  return row?.hash ?? null;
}
