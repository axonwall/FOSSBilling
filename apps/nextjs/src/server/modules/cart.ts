import { createHash, randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import {
  clearCartProducts,
  clientBalanceSum,
  countPromoRedemptionsForClient,
  deleteCartProductRow,
  deleteCartRow,
  findCartById,
  findCartBySession,
  findClientById,
  findCurrencyByCode,
  findDefaultCurrency,
  findOrderById,
  findProcessedTransaction,
  findProductById,
  findProductPayment,
  findPromoByCode,
  findPromoById,
  findTransactionByGatewayHash,
  getDb,
  getDbWrite,
  getSetting,
  hasActiveCheckoutRedemption,
  incrementPromoUsed,
  incrementPromoUsedIfAvailable,
  insertCart,
  insertCartProduct,
  insertOrder,
  insertOrderStatus,
  insertPromoRedemption,
  listAutoApplyPromos,
  listCartProducts,
  listCarts,
  listCurrencies,
  listInvoiceItems,
  listProductPeriods,
  nowTimestamp,
  setClientCurrency,
  settleTransaction,
  updateCartRow,
  updateOrderUnpaidInvoice,
  type CartProductRow,
  type CartRow,
  type CurrencyRow,
  type ProductRow,
  type PromoRow,
} from "../db";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { queueTemplatedEmail } from "../emailer";
import { ensureSession } from "../session";
import {
  invoiceTotals,
  isClientTaxable,
  issueInvoice,
  markInvoicePaid,
  prepareInvoice,
  round2,
  type InvoiceItemInput,
} from "../money";
import { currencyToApi } from "./currency";
import { activateOrderRow } from "./order";
import { productUnit } from "./product";
import { formatCurrencyValue } from "../twig";

/**
 * Cart module (guest cart + client checkout + staff baskets) — TS port of
 * src/modules/Cart/{Api,Service}.php for the catalog paths: simple
 * products (once/recurrent pricing), manual promo codes, automatic promos
 * (staff views and staff checkout), domain product lines (register /
 * transfer / owndomain on Custom-registrar TLDs), and checkout into
 * orders + one invoice. Deferred (documented): addons in the guest cart,
 * hosting product configs, related-item discounts, domain/hosting
 * service activation (order activation stays status-only, as in the
 * admin order activate handler), RDAP-backed availability checks for
 * non-Custom registrars. Parity oracle: capture25.py + parity22.py.
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

// --- Domain product lines (Servicedomain/Service.php validation) -----

interface TldRowLocal {
  id: number;
  tld: string | null;
  price_registration: number | string | null;
  price_renew: number | string | null;
  price_transfer: number | string | null;
  allow_register: number | null;
  allow_transfer: number | null;
  require_transfer_code: number | null;
  active: number | null;
  min_years: number | null;
  periods: string | null;
  tld_registrar_id: number | null;
}

/** Servicedomain\Service::normalizeTld ('.' + lowercase ASCII). */
function normalizeTld(raw: string): string {
  let tld = raw.trim().replace(/^\.+|\.+$/g, "");
  if (tld === "") throw new FbError("TLD is invalid.");
  if (/[^\x00-\x7F]/.test(tld)) {
    try {
      tld = domainToASCII(tld);
    } catch {
      throw new FbError("TLD is invalid.");
    }
    if (!tld) throw new FbError("TLD is invalid.");
  }
  if (tld.length > 253) throw new FbError("TLD is invalid.");
  for (const label of tld.toLowerCase().split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw new FbError("TLD is invalid.");
  }
  return `.${tld.toLowerCase()}`;
}

/** Servicedomain\Service::tldFindOneByTld (normalized, then dotless). */
function findTldRow(raw: string): TldRowLocal | undefined {
  let normalized: string;
  try {
    normalized = normalizeTld(raw);
  } catch {
    return undefined;
  }
  return getDb()
    .prepare("SELECT * FROM tld WHERE tld = ? OR tld = ? ORDER BY id ASC LIMIT 1")
    .get(normalized, normalized.slice(1)) as TldRowLocal | undefined;
}

/** Product\Service::getDomainTldModel. */
function domainTldForConfig(config: Record<string, unknown>): TldRowLocal {
  const action = config["action"];
  if (action === undefined || action === null || action === "") {
    throw new FbError("Could not determine domain price. Domain action is missing", 498);
  }
  const raw = action === "register" ? config["register_tld"] : action === "transfer" ? config["transfer_tld"] : "";
  const row = typeof raw === "string" ? findTldRow(raw) : undefined;
  if (!row) throw new FbError("Unknown TLD. Could not determine registration price");
  return row;
}

function domainRegistrationYears(config: Record<string, unknown>): number {
  const n = parseInt(String(config["register_years"] ?? "1"), 10);
  return Number.isNaN(n) ? 1 : n;
}

/** Servicedomain\Service::getDomainFromConfig (top-level, plus nested owndomain). */
function domainFromConfig(config: Record<string, unknown>): string | null {
  const action = config["action"];
  if (action === "register" && config["register_sld"] !== undefined && config["register_tld"] !== undefined) {
    return String(config["register_sld"]) + String(config["register_tld"]);
  }
  if (action === "transfer" && config["transfer_sld"] !== undefined && config["transfer_tld"] !== undefined) {
    return String(config["transfer_sld"]) + String(config["transfer_tld"]);
  }
  if (action === "owndomain") {
    const nested = config["domain"];
    const sld = config["owndomain_sld"] ?? (nested && typeof nested === "object" ? (nested as Record<string, unknown>)["owndomain_sld"] : undefined);
    const tld = config["owndomain_tld"] ?? (nested && typeof nested === "object" ? (nested as Record<string, unknown>)["owndomain_tld"] : undefined);
    if (sld !== undefined && sld !== null && tld !== undefined && tld !== null) {
      const t = String(tld);
      const domain = String(sld) + (t.includes(".") ? t : `.${t}`);
      if (domain.length > 233) return null;
      return domain;
    }
  }
  return null;
}

/** FOSSBilling\Validate::isSldValid. */
function isSldValid(sld: string): boolean {
  let s = sld.replace(/^\.+/, "");
  if (s === "") return false;
  if (/[^\x00-\x7F]/.test(s)) {
    try {
      s = domainToASCII(s);
    } catch {
      return false;
    }
    if (!s) return false;
  }
  s = s.toLowerCase();
  if (s.startsWith("xn--")) return !s.includes(".") && s.length < 64;
  return /^[a-z0-9]+[a-z0-9-]*[a-z0-9]+$/i.test(s) && s.length < 64 && s.slice(2, 4) !== "--";
}

/**
 * FOSSBilling\Validate::isTldValid under the sandbox fallback: the IANA
 * list fetch fails offline, so a TLD is valid iff punycode or all
 * lowercase ASCII letters.
 */
function isTldValidFallback(tld: string): boolean {
  let t = tld.replace(/^\.+/, "");
  if (t === "") return false;
  if (/[^\x00-\x7F]/.test(t)) {
    try {
      t = domainToASCII(t);
    } catch {
      return false;
    }
    if (!t) return false;
  }
  t = t.toLowerCase();
  return t.startsWith("xn--") || /^[a-z]+$/.test(t);
}

function phpEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || v === "0";
}

function requireField(config: Record<string, unknown>, key: string, message: string): void {
  if (phpEmpty(config[key])) throw new FbError(message);
}

/** Registrar availability for the ported adapters: Custom without RDAP. */
function assertDomainAvailable(tld: TldRowLocal, action: "register" | "transfer"): void {
  const reg =
    tld.tld_registrar_id !== null && tld.tld_registrar_id !== undefined
      ? (getDb().prepare("SELECT * FROM tld_registrar WHERE id = ?").get(tld.tld_registrar_id) as
          | { registrar: string | null; config: string | null }
          | undefined)
      : undefined;
  if (!reg) throw new FbError("Registrar not found");
  let cfg: Record<string, unknown> = {};
  if (reg.config) {
    try {
      const parsed = JSON.parse(reg.config) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  // Only the Custom adapter (RDAP off) is modeled; other registrars and
  // RDAP-backed checks need a live registrar API and are not ported.
  if (reg.registrar !== "Custom" || cfg["use_rdap"]) {
    throw new FbError("Domain availability check requires the registrar adapter");
  }
}

/**
 * Servicedomain\Service::validateOrderData. Mutates the config: the
 * normalized TLD, period ('NY' / '1Y'), and transfer quantity.
 */
function validateDomainConfig(config: Record<string, unknown>): void {
  const action = config["action"];
  if (phpEmpty(action)) {
    throw new FbError("Are you registering new domain or transferring existing? Action parameter missing");
  }
  if (action !== "register" && action !== "transfer" && action !== "owndomain") {
    throw new FbError("Invalid domain action.");
  }
  if (action === "owndomain") {
    requireField(config, "owndomain_tld", "Domain TLD is required.");
    requireField(config, "owndomain_sld", "Domain name is required.");
    if (!isSldValid(String(config["owndomain_sld"]))) {
      throw new FbError(`Domain name ${config["owndomain_sld"]} is invalid`);
    }
    if (!isTldValidFallback(String(config["owndomain_tld"]))) throw new FbError("TLD is invalid");
    config["owndomain_tld"] = normalizeTld(String(config["owndomain_tld"]));
    return;
  }
  if (action === "transfer") {
    requireField(config, "transfer_tld", "Transfer domain type (TLD) is required.");
    requireField(config, "transfer_sld", "Transfer domain name (SLD) is required.");
    if (!isSldValid(String(config["transfer_sld"]))) {
      throw new FbError(`Domain name ${config["transfer_sld"]} is invalid`);
    }
    const row = findTldRow(String(config["transfer_tld"]));
    if (!row) throw new FbError("TLD not found");
    if (!row.active) throw new FbError("TLD is not active");
    config["transfer_tld"] = row.tld;
    if (!row.allow_transfer) throw new FbError("Domain cannot be transferred", 403);
    assertDomainAvailable(row, "transfer");
    if (row.require_transfer_code && String(config["transfer_code"] ?? "").trim() === "") {
      throw new FbError(
        `A transfer code (EPP/auth code) is required to transfer ${config["transfer_sld"]}${row.tld}`,
      );
    }
    config["period"] = "1Y";
    config["quantity"] = 1;
    return;
  }
  // register
  requireField(config, "register_tld", "Domain registration tld parameter missing.");
  requireField(config, "register_sld", "Domain registration sld parameter missing.");
  requireField(config, "register_years", "Domain registration period is missing. Please check domain availability before proceeding.");
  if (!isSldValid(String(config["register_sld"]))) {
    throw new FbError(`Domain name ${config["register_sld"]} is invalid`);
  }
  const row = findTldRow(String(config["register_tld"]));
  if (!row) throw new FbError("TLD not found");
  if (!row.active) throw new FbError("TLD is not active");
  config["register_tld"] = row.tld;
  const yearsRaw = String(config["register_years"]);
  const years = /^[+-]?\d+$/.test(yearsRaw) && yearsRaw.replace(/^[+-]/, "").length <= 15 ? parseInt(yearsRaw, 10) : NaN;
  if (Number.isNaN(years) || years < 1) {
    throw new FbError("Domain registration period must be a positive integer");
  }
  const periods =
    row.periods && row.periods.trim() !== ""
      ? [...new Set(row.periods.split(",").map((p) => parseInt(p.trim(), 10)).filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b)
      : null;
  if (periods !== null) {
    if (!periods.includes(years)) {
      throw new FbError(`${row.tld} can only be registered for ${periods.join(", ")} years`);
    }
  } else if (years < (row.min_years ?? 1)) {
    throw new FbError(`${row.tld} can be registered for at least ${row.min_years} years`);
  }
  if (!row.allow_register) throw new FbError("Domain cannot be registered", 403);
  assertDomainAvailable(row, "register");
  config["period"] = `${years}Y`;
}

// --- Staff basket request plumbing ----------------------------------------

/** Expand form-encoded bracket keys (addons[34][selected]) into objects. */
function expandBrackets(params: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "CSRFToken") continue;
    const m = /^([^\[]+)((?:\[[^\]]*\])*)$/.exec(k);
    if (!m) {
      out[k] = v;
      continue;
    }
    const parts = [m[1]];
    for (const seg of m[2].matchAll(/\[([^\]]*)\]/g)) parts.push(seg[1]);
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i] === "" ? String(Object.keys(cur).length) : parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/**
 * Staff add input: form-encoded params (bracket-expanded) overlaid by
 * the parsed JSON body when one was sent — nested structures survive
 * in rawParams while params only carries their stringified form.
 */
function staffAddParams(ctx: CallContext): Record<string, unknown> {
  const out = expandBrackets(ctx.params);
  for (const [k, v] of Object.entries(ctx.rawParams)) {
    if (k === "CSRFToken") continue;
    out[k] = v;
  }
  return out;
}

function phpSelected(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return !!v;
}

/** Cart\Service::extractDomainFromConfig (top-level + nested domain). */
function extractDomain(config: Record<string, unknown>, parent: Record<string, unknown> = {}): string | null {
  const sld = config["register_sld"] ?? config["transfer_sld"];
  const tld = config["register_tld"] ?? config["transfer_tld"];
  if (sld !== undefined && sld !== null && tld !== undefined && tld !== null) {
    return String(sld).toLowerCase() + String(tld).toLowerCase();
  }
  if (config["action"] === "subdomain" && config["subdomain_sld"] !== undefined) {
    const base = config["subdomain_base_domain"] ?? parent["subdomain_base_domain"];
    if (base !== undefined && base !== null) {
      return String(config["subdomain_sld"]).toLowerCase() + "." + String(base).trim().replace(/^\.+|\.+$/g, "");
    }
  }
  return null;
}

function validateSelectedAddons(product: ProductRow, addons: Record<string, unknown>): void {
  const valid = jsonList(product.addons).map(Number);
  for (const [addonIdRaw, propsRaw] of Object.entries(addons)) {
    const props = propsRaw && typeof propsRaw === "object" ? (propsRaw as Record<string, unknown>) : {};
    if (!phpSelected(props["selected"])) continue;
    const addonId = Number(addonIdRaw);
    const addon = findProductById(addonId);
    const ok =
      addon !== undefined && addon.is_addon === 1 && addon.status === "enabled" && valid.includes(addonId);
    if (!ok) {
      throw new FbError("One or more of your selected add-ons are invalid for the associated product.");
    }
    const qty = Math.max(1, parseInt(String(props["quantity"] ?? "1"), 10) || 1);
    if (qty > 1 && !addon!.allow_quantity_select) {
      throw new FbError("One or more of your selected add-ons are invalid for the associated product.");
    }
  }
}

function selectedAddonsForCart(
  product: ProductRow,
  addons: Record<string, unknown>,
): { product: ProductRow; config: Record<string, unknown> }[] {
  const out: { product: ProductRow; config: Record<string, unknown> }[] = [];
  for (const [addonIdRaw, propsRaw] of Object.entries(addons)) {
    const props = propsRaw && typeof propsRaw === "object" ? (propsRaw as Record<string, unknown>) : {};
    if (!phpSelected(props["selected"])) continue;
    const addon = findProductById(Number(addonIdRaw))!;
    if (isRecurrent(addon)) {
      if (phpEmpty(props["period"])) throw new FbError("Addon period parameter not passed");
      const payment = findProductPayment(addon.product_payment_id!);
      const enabled = payment
        ? listProductPeriods(payment.id).some((p) => p.code === props["period"] && p.enabled)
        : false;
      if (!enabled) throw new FbError("Selected billing period is invalid for the selected add-on");
    }
    const cfg: Record<string, unknown> = { ...props };
    cfg["quantity"] = addon.allow_quantity_select ? Math.max(1, parseInt(String(props["quantity"] ?? "1"), 10) || 1) : 1;
    cfg["parent_id"] = product.id;
    out.push({ product: addon, config: cfg });
  }
  return out;
}


// --- Staff baskets (Cart/Api/Admin.php staff_* + Cart/Service.php) -----

export const STAFF_PRICE_OVERRIDE_KEY = "__price_override";

function staffBasketKey(adminId: number, clientId: number): string {
  return `staff:${adminId}:${clientId}`;
}

function isStaffBasket(cart: CartRow): boolean {
  return cart.session_id.startsWith("staff:");
}

/** Client id encoded in a staff basket key, or null for guest carts. */
function staffBasketClientId(cart: CartRow): number | null {
  const m = /^staff:\d+:(\d+)$/.exec(cart.session_id);
  return m ? Number(m[1]) : null;
}

function resolveStaffBasket(ctx: CallContext): { client: NonNullable<ReturnType<typeof findClientById>>; basket: CartRow } {
  const clientIdRaw = ctx.params["client_id"];
  if (!clientIdRaw) throw new FbError("Client ID was not passed");
  const client = findClientById(Number(clientIdRaw));
  if (!client) throw new FbError("Client not found");
  const adminId = ctx.session!.admin!.id;
  const key = staffBasketKey(adminId, client.id);
  let basket = findCartBySession(key);
  if (!basket) {
    // Currency\Service::getCurrencyByClientId, else the default currency.
    let currency = client.currency ? findCurrencyByCode(client.currency) : undefined;
    currency ??= findDefaultCurrency();
    if (!currency) throw new FbError("Default currency not found");
    insertCart(key, currency.id);
    basket = findCartBySession(key);
    if (!basket) throw new FbError("Cart could not be created");
  }
  return { client, basket };
}

/** Product\Service::getPromoStackingMode (system param, best_single default). */
function promoStackingMode(): string {
  const mode = getSetting("promo_stacking_mode");
  return mode === "stack_all_eligible" || mode === "priority_first" ? mode : "best_single";
}

/** Product\Service::getPromoDiscountTitle. */
function promoTitle(promo: PromoRow, currencyCode: string): string {
  if (promo.type === "absolute") {
    const formats: Record<string, string> = {};
    for (const c of listCurrencies()) {
      if (c.format_pattern) formats[c.code] = c.format_pattern;
    }
    return `Promotional Code: ${promo.code} - ${formatCurrencyValue(promo.value, currencyCode, formats)} Discount`;
  }
  if (promo.type === "percentage") return `Promotional Code: ${promo.code} - ${promo.value}%`;
  return `Promotional Code: ${promo.code}`;
}

/** Cart\Service::getEffectiveCartPromos for a staff view. */
function effectiveStaffPromos(
  cart: CartRow,
  clientId: number | null,
): { source: "manual" | "auto" | null; promos: PromoRow[] } {
  if (cart.promo_id) {
    const promo = findPromoById(cart.promo_id);
    if (!promo) return { source: "manual", promos: [] };
    const inCart = new Set(listCartProducts(cart.id).map((cp) => cp.product_id));
    const missing = jsonList(promo.requires_products).map(Number).filter((id) => !inCart.has(id));
    // A manual code whose bundle condition no longer holds contributes
    // no discount, but promo_source stays manual and promocode is shown.
    return { source: "manual", promos: missing.length === 0 ? [promo] : [] };
  }
  if (clientId === null) return { source: null, promos: [] };
  const lines = listCartProducts(cart.id)
    .map((cp) => {
      const product = findProductById(cp.product_id);
      return product ? { product, config: parseConfig(cp.config) } : null;
    })
    .filter((l): l is { product: ProductRow; config: Record<string, unknown> } => !!l);
  if (lines.length === 0) return { source: null, promos: [] };
  const eligible: { promo: PromoRow; discount: number }[] = [];
  for (const promo of listAutoApplyPromos()) {
    if (!promoCanBeApplied(promo)) continue;
    if (!promoGroupAvailable(promo, clientId)) continue;
    if (promo.once_per_client && hasActiveCheckoutRedemption(promo.id, clientId)) continue;
    const required = jsonList(promo.requires_products).map(Number);
    const inCart = new Set(lines.map((l) => l.product.id));
    if (required.some((id) => !inCart.has(id))) continue;
    let discount = 0;
    for (const line of lines) {
      discount += staffRawPromoDiscount(promo, line.product, line.config);
    }
    if (discount <= 0) continue;
    eligible.push({ promo, discount });
  }
  if (eligible.length === 0) return { source: null, promos: [] };
  eligible.sort((a, b) => (b.promo.priority ?? 0) - (a.promo.priority ?? 0) || b.discount - a.discount);
  const mode = promoStackingMode();
  if (mode === "priority_first") return { source: "auto", promos: [eligible[0].promo] };
  if (mode === "best_single") {
    let best = eligible[0];
    for (const c of eligible) if (c.discount > best.discount) best = c;
    return { source: "auto", promos: [best.promo] };
  }
  // stack_all_eligible: every stackable promo, plus the most valuable
  // non-stackable one; highest-value first (it becomes primary).
  const result: PromoRow[] = [];
  let bestNonStackable: { promo: PromoRow; discount: number } | null = null;
  for (const c of eligible) {
    if (c.promo.stackable) result.push(c.promo);
    else if (!bestNonStackable || c.discount > bestNonStackable.discount) bestNonStackable = c;
  }
  if (bestNonStackable) result.push(bestNonStackable.promo);
  const byId = new Map(eligible.map((c) => [c.promo.id, c.discount]));
  result.sort((a, b) => (byId.get(b.id) ?? 0) - (byId.get(a.id) ?? 0));
  return { source: "auto", promos: result };
}

/** Product\Service::getProductDiscount for one staff line (base currency). */
function staffRawPromoDiscount(promo: PromoRow, product: ProductRow, config: Record<string, unknown>): number {
  if (product.is_addon) return 0;
  if (!promoAppliesTo(promo, product.id, config)) return 0;
  const line = staffLinePricing(product, config);
  const price = line.price * line.qty;
  if (price === 0) return 0;
  if (promo.type === "absolute") return promo.value;
  if (promo.type === "percentage") return round2((price * promo.value) / 100);
  return 0;
}

/**
 * Cart\Service::getItemPromoDiscountShares: raw per-promo discounts,
 * capped at the line subtotal, rounded to 2dp, drift folded into the
 * largest share so the shares always reconcile.
 */
function staffPromoShares(cp: CartProductRow, promos: PromoRow[]): Map<number, number> {
  const product = findProductById(cp.product_id);
  const config = parseConfig(cp.config);
  const raw = new Map<number, number>();
  let rawTotal = 0;
  for (const promo of promos) {
    const d = product ? staffRawPromoDiscount(promo, product, config) : 0;
    raw.set(promo.id, d);
    rawTotal += d;
  }
  const shares = new Map<number, number>();
  if (rawTotal <= 0) {
    for (const id of raw.keys()) shares.set(id, 0);
    return shares;
  }
  const line = product ? staffLinePricing(product, config) : { price: 0, qty: 1 };
  const cappedTotal = Math.min(rawTotal, line.price * line.qty);
  for (const [id, amount] of raw) shares.set(id, round2((amount / rawTotal) * cappedTotal));
  let sum = 0;
  for (const v of shares.values()) sum += v;
  const drift = round2(cappedTotal - sum);
  if (drift !== 0) {
    let largestId: number | null = null;
    let largest = -Infinity;
    for (const [id, v] of shares) {
      if (v > largest) {
        largest = v;
        largestId = id;
      }
    }
    if (largestId !== null) shares.set(largestId, round2((shares.get(largestId) ?? 0) + drift));
  }
  return shares;
}

/** Staff line pricing: catalog price, staff override, or TLD pricing. */
function staffLinePricing(product: ProductRow, config: Record<string, unknown>): {
  price: number;
  setup: number;
  qty: number;
} {
  if (product.type === "domain") {
    const action = config["action"];
    if (action === "owndomain") return { price: 0, setup: 0, qty: 1 };
    const tld = domainTldForConfig(config);
    if (action === "register") {
      const years = domainRegistrationYears(config);
      const total =
        years <= 1
          ? Number(tld.price_registration ?? 0)
          : Number(tld.price_registration ?? 0) + (years - 1) * Number(tld.price_renew ?? 0);
      return { price: total, setup: 0, qty: 1 };
    }
    if (action === "transfer") {
      return { price: Number(tld.price_transfer ?? 0), setup: 0, qty: 1 };
    }
    throw new FbError("Could not determine domain price. Domain action is missing", 498);
  }
  let price = productPrice(product, config);
  const override = config[STAFF_PRICE_OVERRIDE_KEY];
  if (override !== undefined && override !== null && override !== "") {
    const n = Number(override);
    if (!Number.isNaN(n) && n >= 0) price = n;
  }
  const qty = Math.max(1, parseInt(String(config["quantity"] ?? "1"), 10) || 1);
  return { price, setup: productSetupPrice(product, config), qty };
}

function staffItemTitle(product: ProductRow, config: Record<string, unknown>): string {
  if (product.type === "domain") {
    const domain = domainFromConfig(config);
    if (domain !== null) {
      if (config["action"] === "transfer") return `Domain transfer (${domain})`;
      if (config["action"] === "owndomain") return `Domain (${domain})`;
      return `Domain registration (${domain})`;
    }
  }
  return product.title ?? "";
}

/** Staff cart line: cartProductToApiArray with the effective promos. */
function staffCartItemArray(cp: CartProductRow, promos: PromoRow[]): CartItemView {
  const product = findProductById(cp.product_id);
  const config = parseConfig(cp.config);
  const line = product ? staffLinePricing(product, config) : { price: 0, setup: 0, qty: 1 };
  const shares = staffPromoShares(cp, promos);
  let discountPrice = 0;
  for (const v of shares.values()) discountPrice += v;
  let discountSetup = 0;
  for (const promo of promos) {
    if (promo.freesetup && product && !product.is_addon && promoAppliesTo(promo, product.id, config)) {
      discountSetup = line.setup;
      break;
    }
  }
  let discountTotal = discountPrice + discountSetup;
  const subtotal = line.price * line.qty;
  if (Math.abs(discountTotal) > subtotal + line.setup) {
    discountTotal = subtotal;
    discountPrice = subtotal;
  }
  return {
    ...config,
    id: cp.id,
    product_id: cp.product_id,
    form_id: product?.form_id ?? null,
    title: product ? staffItemTitle(product, config) : "",
    type: product?.type ?? null,
    quantity: line.qty,
    unit: product ? productUnit(product) : null,
    price: line.price,
    setup_price: line.setup,
    discount: discountTotal,
    discount_price: discountPrice,
    discount_setup: discountSetup,
    total: subtotal,
  };
}

/** Cart\Service::toApiArray for a staff basket (client known). */
function staffCartArray(cart: CartRow, clientId: number | null): Record<string, unknown> {
  const { source, promos } = effectiveStaffPromos(cart, clientId);
  const currency = cartCurrency(cart);
  const items = listCartProducts(cart.id).map((cp) => staffCartItemArray(cp, promos));
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    subtotal += item.total + item.setup_price;
    discount += item.discount;
  }
  const autoPromos =
    source === "auto"
      ? promos.map((promo) => {
          let total = 0;
          for (const cp of listCartProducts(cart.id)) total += staffPromoShares(cp, promos).get(promo.id) ?? 0;
          return { code: promo.code, title: promoTitle(promo, currency.code), discount: total };
        })
      : [];
  return {
    promocode: cart.promo_id ? (findPromoById(cart.promo_id)?.code ?? null) : null,
    promo_source: source,
    auto_promos: autoPromos,
    discount,
    subtotal,
    total: subtotal - discount,
    items,
    currency: currencyArray(currency),
    subscribable: isSubscribable(items),
  };
}


function staffAddItem(basket: CartRow, product: ProductRow, data: Record<string, unknown>, priceOverride: number | null): boolean {
  if (isRecurrent(product)) {
    if (phpEmpty(data["period"])) throw new FbError("Period parameter not passed");
    const payment = product.product_payment_id ? findProductPayment(product.product_payment_id) : undefined;
    const enabled = payment
      ? listProductPeriods(payment.id).some((p) => p.code === data["period"] && p.enabled)
      : false;
    if (!enabled) throw new FbError("Selected billing period is invalid");
  }
  // PHP stores the whole request (minus id/addons/client_id/price) as
  // the item config.
  const itemConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (["id", "addons", "client_id", "price", "CSRFToken"].includes(k)) continue;
    itemConfig[k] = v;
  }
  const productConfig = parseConfig(product.config);
  const domainsBeingAdded: string[] = [];
  const top = extractDomain(itemConfig, productConfig);
  if (top) domainsBeingAdded.push(top);
  const nested = itemConfig["domain"];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nd = extractDomain(nested as Record<string, unknown>, { ...itemConfig, ...productConfig });
    if (nd) domainsBeingAdded.push(nd);
  }
  if (domainsBeingAdded.length > 0) {
    for (const cp of listCartProducts(basket.id)) {
      const cfg = parseConfig(cp.config);
      const candidates = [extractDomain(cfg)];
      const nestedCfg = cfg["domain"];
      if (nestedCfg && typeof nestedCfg === "object" && !Array.isArray(nestedCfg)) {
        candidates.push(extractDomain(nestedCfg as Record<string, unknown>, cfg));
      }
      for (const existing of candidates) {
        if (!existing) continue;
        for (const incoming of domainsBeingAdded) {
          if (existing.toLowerCase() === incoming.toLowerCase()) {
            throw new FbError("This domain is already in the cart.");
          }
        }
      }
    }
  }
  const lines: { product: ProductRow; config: Record<string, unknown> }[] = [{ product, config: itemConfig }];
  if (product.type === "hosting") {
    const dc = nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
    if (dc && !phpEmpty(dc["action"]) && dc["action"] !== "subdomain" && dc["action"] !== "owndomain") {
      // Servicehosting::getDomainProductFromConfig (minus the hosting
      // attachOrderConfig/validateOrderData, which no reference
      // hosting product exercises): validate the nested domain action,
      // copy the free flags, and add the main domain product's line.
      const dcCopy = { ...dc };
      const hostCfg = parseConfig(product.config);
      if (hostCfg["free_domain"]) dcCopy["free_domain"] = true;
      if (hostCfg["free_transfer"]) dcCopy["free_transfer"] = true;
      if (hostCfg["free_tlds"] !== undefined) dcCopy["free_tlds"] = hostCfg["free_tlds"];
      if (hostCfg["free_domain_periods"] !== undefined) dcCopy["free_domain_periods"] = hostCfg["free_domain_periods"];
      validateDomainConfig(dcCopy);
      const domainProduct = getDb()
        .prepare("SELECT * FROM product WHERE type = 'domain' AND is_addon = 0 ORDER BY id ASC LIMIT 1")
        .get() as ProductRow | undefined;
      if (!domainProduct) throw new FbError("Could not find main domain product");
      lines.push({ product: domainProduct, config: dcCopy });
    }
  }
  const addonsRaw = data["addons"];
  if (addonsRaw && typeof addonsRaw === "object") {
    lines.push(...selectedAddonsForCart(product, addonsRaw as Record<string, unknown>));
  }
  const reserved = new Map<number, number>();
  for (const cp of listCartProducts(basket.id)) {
    const q = Math.max(1, parseInt(String(parseConfig(cp.config)["quantity"] ?? "1"), 10) || 1);
    reserved.set(cp.product_id, (reserved.get(cp.product_id) ?? 0) + q);
  }
  const pending = new Map<number, number>();
  for (const line of lines) {
    const q = Math.max(1, parseInt(String(line.config["quantity"] ?? "1"), 10) || 1);
    pending.set(line.product.id, (pending.get(line.product.id) ?? 0) + q);
    const total = (reserved.get(line.product.id) ?? 0) + (pending.get(line.product.id) ?? 0);
    if (line.product.stock_control && line.product.quantity_in_stock < total) {
      throw new FbError("This item is currently out of stock");
    }
  }
  const familyToken = randomBytes(16).toString("hex");
  let isMain = true;
  for (const line of lines) {
    const cfg: Record<string, unknown> = { ...line.config };
    if (line.product.type === "domain") validateDomainConfig(cfg);
    // Custom-form validation (Servicecustom::validateCustomForm) only
    // applies to products with a form_id; every reference product has
    // form_id NULL, so it is a no-op here (documented gap otherwise).
    cfg[CART_FAMILY_KEY] = familyToken;
    delete cfg[STAFF_PRICE_OVERRIDE_KEY];
    if (isMain && priceOverride !== null) cfg[STAFF_PRICE_OVERRIDE_KEY] = priceOverride;
    isMain = false;
    insertCartProduct(basket.id, line.product.id, JSON.stringify(cfg));
  }
  return true;
}

register("admin", "cart", "staff_basket_add_item", (ctx: CallContext) => {
  requireAdmin(ctx);
  const data = staffAddParams(ctx);
  if (phpEmpty(data["client_id"])) throw new FbError("Client ID was not passed");
  if (phpEmpty(data["id"])) throw new FbError("Product ID was not passed");
  const client = findClientById(Number(data["client_id"]));
  if (!client) throw new FbError("Client not found");
  const adminId = ctx.session!.admin!.id;
  let basket = findCartBySession(staffBasketKey(adminId, client.id));
  if (!basket) {
    let currency = client.currency ? findCurrencyByCode(client.currency) : undefined;
    currency ??= findDefaultCurrency();
    if (!currency) throw new FbError("Default currency not found");
    insertCart(staffBasketKey(adminId, client.id), currency.id);
    basket = findCartBySession(staffBasketKey(adminId, client.id));
    if (!basket) throw new FbError("Cart could not be created");
  }
  const product = findProductById(Number(data["id"]));
  if (!product) throw new FbError("Product not found");
  if (product.is_addon) throw new FbError("Addon products cannot be added separately.");
  const addonsRaw = data["addons"];
  if (addonsRaw && typeof addonsRaw === "object") {
    validateSelectedAddons(product, addonsRaw as Record<string, unknown>);
  }
  let priceOverride: number | null = null;
  if (data["price"] !== undefined && data["price"] !== "") {
    const n = Number(data["price"]);
    if (Number.isNaN(n) || n < 0) throw new FbError("Price override must be a non-negative number");
    const rate = cartCurrency(basket).conversion_rate;
    if (!(rate > 0)) throw new FbError("Basket currency has no valid conversion rate");
    priceOverride = n / rate;
  }
  return staffAddItem(basket, product, data, priceOverride);
});

register("admin", "cart", "staff_basket_get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const { client, basket } = resolveStaffBasket(ctx);
  return staffCartArray(basket, client.id);
});

register("admin", "cart", "staff_basket_remove_item", (ctx: CallContext) => {
  requireAdmin(ctx);
  if (phpEmpty(ctx.params["client_id"])) throw new FbError("Client ID was not passed");
  if (phpEmpty(ctx.params["id"])) throw new FbError("Basket item ID was not passed");
  const { basket } = resolveStaffBasket(ctx);
  const lineId = Number(ctx.params["id"]);
  const line = listCartProducts(basket.id).find((cp) => cp.id === lineId);
  if (!line) throw new FbError("Product not found");
  // Cart\Service::removeProduct: addon lines of the removed line go too
  // (same parent product id, and the same domain_name when the parent
  // carries one — an empty parent domain_name removes all its addons).
  const mainConfig = parseConfig(line.config);
  const domainName = typeof mainConfig["domain_name"] === "string" ? mainConfig["domain_name"] : "";
  const parentProductId = line.product_id;
  for (const cp of listCartProducts(basket.id)) {
    const cfg = parseConfig(cp.config);
    if (cfg["parent_id"] !== undefined && Number(cfg["parent_id"]) === parentProductId) {
      const addonDomain = typeof cfg["domain_name"] === "string" ? cfg["domain_name"] : "";
      if (domainName && domainName !== addonDomain) continue;
      deleteCartProductRow(cp.id);
    }
  }
  deleteCartProductRow(line.id);
  return true;
});

register("admin", "cart", "staff_basket_apply_promo", (ctx: CallContext) => {
  requireAdmin(ctx);
  if (phpEmpty(ctx.params["client_id"])) throw new FbError("Client ID was not passed");
  if (phpEmpty(ctx.params["promocode"])) throw new FbError("Promo code was not passed");
  const { client, basket } = resolveStaffBasket(ctx);
  const promo = findPromoByCode(ctx.params["promocode"]);
  if (!promo || !promo.active) {
    throw new FbError("The promo code has expired or does not exist");
  }
  if (!promoGroupAvailable(promo, client.id)) {
    throw new FbError("Promo code cannot be applied to this client account");
  }
  if (!promoCanBeApplied(promo)) {
    throw new FbError("The promo code has expired or does not exist");
  }
  if (basket.promo_id === promo.id) return true;
  if (listCartProducts(basket.id).length === 0) {
    throw new FbError("Add products to your cart before applying promo code");
  }
  assertPromoCondition(basket, promo);
  updateCartRow(basket.id, { promo_id: promo.id });
  return true;
});

register("admin", "cart", "staff_basket_remove_promo", (ctx: CallContext) => {
  requireAdmin(ctx);
  const { basket } = resolveStaffBasket(ctx);
  updateCartRow(basket.id, { promo_id: null });
  return true;
});

register("admin", "cart", "staff_basket_discard", (ctx: CallContext) => {
  requireAdmin(ctx);
  const { basket } = resolveStaffBasket(ctx);
  deleteCartRow(basket.id);
  return true;
});

// --- Staff checkout -------------------------------------------------------

/** FOSSBilling\Tools::normalizeBoolean for request params. */
function normalizeBooleanParam(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  }
  return false;
}

function staffGatewayRow(id: number): { id: number; gateway: string; name: string | null; enabled: number } | undefined {
  return getDb()
    .prepare("SELECT id, gateway, name, enabled FROM pay_gateway WHERE id = ?")
    .get(id) as { id: number; gateway: string; name: string | null; enabled: number } | undefined;
}

/** Invoice\Service::validateAdminMarkAsPaidRequest without an invoice. */
function validateMarkPaidPreflight(ctx: CallContext): { id: number; gateway: string; name: string | null } {
  const raw = ctx.params["gateway_id"];
  const gatewayId = raw !== undefined && raw !== "" ? Number(raw) : 0;
  if (!(gatewayId > 0)) {
    throw new FbError("Payment gateway is required when marking an invoice as paid.");
  }
  const gw = staffGatewayRow(gatewayId);
  if (!gw) throw new FbError("Payment gateway not found");
  if (!gw.enabled) throw new FbError("Payment gateway is not enabled");
  if (gw.gateway === "Custom" && String(ctx.params["transactionId"] ?? "").trim() === "") {
    throw new FbError("Transaction ID is required when using the Custom payment gateway.");
  }
  return gw;
}

/** Invoice\ServiceTransaction::normalizeIpn: recursive ksort + compact JSON. */
function sortedJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(rec[k])}`).join(",")}}`;
}

function invoiceTaxrate(invoiceId: number): string {
  const row = getDb().prepare("SELECT taxrate FROM invoice WHERE id = ?").get(invoiceId) as
    | { taxrate: string | null }
    | undefined;
  return String(row?.taxrate ?? "0");
}

function invoiceCurrencyCode(invoiceId: number): string {
  const row = getDb().prepare("SELECT currency FROM invoice WHERE id = ?").get(invoiceId) as
    | { currency: string | null }
    | undefined;
  return row?.currency ?? "USD";
}

/**
 * Invoice\Service::markAsPaidByAdmin, staff-checkout shape: the shared
 * markInvoicePaid core plus the pieces it does not cover — the
 * currency_rate frozen at payment (PHP prepare leaves it NULL), the
 * unpaid_invoice_id clearing (ServiceInvoiceItem::markAsPaid), and the
 * reserved-redemption commit (committed_at = the invoice paid_at).
 * The Custom path additionally creates/settles the transaction row.
 */
function staffMarkInvoicePaid(
  invoiceId: number,
  gateway: { id: number; gateway: string; name: string | null },
  transactionId: string | null,
  ctx: CallContext,
  rate: number,
): void {
  let txnId: number | null = null;
  if (gateway.gateway === "Custom" && transactionId !== null) {
    const ipn = {
      source: "admin",
      get: null,
      post: { invoice_id: invoiceId, txn_id: transactionId },
      http_raw_post_data: null,
      server: null,
    };
    const hash = createHash("sha256").update(sortedJson(ipn)).digest("hex");
    let txn = findProcessedTransaction(gateway.id, transactionId);
    if (!txn) txn = findTransactionByGatewayHash(gateway.id, hash);
    if (txn) {
      if (txn.invoice_id !== invoiceId) {
        throw new FbError("Transaction ID is already associated with another invoice.");
      }
      txnId = txn.id;
    } else {
      const now = nowTimestamp();
      const info = getDbWrite()
        .prepare(
          `INSERT INTO "transaction" (txn_id, txn_status, s_id, s_period, amount, currency, type, status, ip, error, error_code, ipn, ipn_hash, output, note, created_at, updated_at, invoice_id, gateway_id)
           VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, 'received', ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, ctx.ip, JSON.stringify(ipn), hash, now, now, invoiceId, gateway.id);
      txnId = Number(info.lastInsertRowid);
    }
  }
  getDbWrite().prepare("UPDATE invoice SET currency_rate = ? WHERE id = ?").run(rate, invoiceId);
  markInvoicePaid(invoiceId);
  getDbWrite()
    .prepare("UPDATE client_order SET unpaid_invoice_id = NULL, updated_at = ? WHERE unpaid_invoice_id = ?")
    .run(nowTimestamp(), invoiceId);
  const paidAtRow = getDb().prepare("SELECT paid_at FROM invoice WHERE id = ?").get(invoiceId) as
    | { paid_at: string | null }
    | undefined;
  const paidAt = paidAtRow?.paid_at ?? nowTimestamp();
  getDbWrite()
    .prepare("UPDATE promo_redemption SET status = 'committed', committed_at = ?, updated_at = ? WHERE invoice_id = ? AND status = 'reserved'")
    .run(paidAt, nowTimestamp(), invoiceId);
  if (txnId !== null && transactionId !== null) {
    const { total } = invoiceTotals(listInvoiceItems(invoiceId), invoiceTaxrate(invoiceId));
    settleTransaction(txnId, total, invoiceCurrencyCode(invoiceId), `${gateway.name ?? gateway.gateway} transaction No: ${transactionId}`);
  }
}

register("admin", "cart", "staff_basket_checkout", (ctx: CallContext) => {
  requireAdmin(ctx);
  if (phpEmpty(ctx.params["client_id"])) throw new FbError("Client ID was not passed");
  // Mark-as-paid validation runs BEFORE basket resolution (Admin API).
  const markPaid = normalizeBooleanParam(
    ctx.rawParams["mark_invoice_paid"] !== undefined ? ctx.rawParams["mark_invoice_paid"] : ctx.params["mark_invoice_paid"],
  );
  let markGateway: { id: number; gateway: string; name: string | null } | null = null;
  if (markPaid) markGateway = validateMarkPaidPreflight(ctx);
  const { client, basket } = resolveStaffBasket(ctx);
  const adminId = ctx.session!.admin!.id;
  if (!isStaffBasket(basket) || basket.session_id !== staffBasketKey(adminId, client.id)) {
    throw new FbError("Staff basket does not belong to this admin and client");
  }
  const gatewayIdParam =
    ctx.params["gateway_id"] !== undefined && ctx.params["gateway_id"] !== "" ? Number(ctx.params["gateway_id"]) : null;
  const activate =
    ctx.rawParams["activate"] !== undefined
      ? normalizeBooleanParam(ctx.rawParams["activate"])
      : ctx.params["activate"] !== undefined
        ? normalizeBooleanParam(ctx.params["activate"])
        : true;

  // checkoutStaffBasket pre-checks (fail fast, before order creation).
  const manualPromo = basket.promo_id ? (findPromoById(basket.promo_id) ?? null) : null;
  if (manualPromo) {
    const usable =
      promoCanBeApplied(manualPromo) &&
      (!manualPromo.once_per_client || !hasActiveCheckoutRedemption(manualPromo.id, client.id));
    if (!usable) {
      throw new FbError(
        "This client has already used this promo code. Please remove the promo code and checkout again.",
        9874,
      );
    }
    if (!promoGroupAvailable(manualPromo, client.id)) {
      throw new FbError("Promo code cannot be applied to this client account");
    }
    assertPromoCondition(basket, manualPromo);
  }
  const view = staffCartArray(basket, client.id);
  const viewItems = view["items"] as CartItemView[];
  if (viewItems.length === 0) throw new FbError("Cannot checkout an empty cart");
  const currency = cartCurrency(basket);
  const rate = currency.conversion_rate;
  if (!client.currency) {
    setClientCurrency(client.id, currency.code);
    client.currency = currency.code;
  }
  if (client.currency !== currency.code) {
    throw new FbError(
      `Selected currency ${currency.code} does not match your profile currency ${client.currency}. Please change cart currency to continue.`,
    );
  }
  const effectivePromos = manualPromo
    ? [manualPromo]
    : effectiveStaffPromos(basket, client.id).promos.filter(
        (p) =>
          promoCanBeApplied(p) &&
          (!p.once_per_client || !hasActiveCheckoutRedemption(p.id, client.id)) &&
          promoGroupAvailable(p, client.id),
      );
  const taxed = isClientTaxable(client);

  const familyGroups = new Map<string, string>();
  const lastGroupByProduct = new Map<number, string>();
  let familyIndex = 0;
  const nextGroup = () => `${basket.id}_${++familyIndex}`;

  const orderIds: number[] = [];
  const orderRows: { id: number; price: number; quantity: number; discount: number | null; serviceType: string | null }[] = [];
  const invoiceItems: InvoiceItemInput[] = [];
  const discountsByOrderAndPromo = new Map<number, Map<number, number>>();
  const requestedQty = new Map<number, number>();
  let masterOrderId: number | null = null;

  for (const cp of listCartProducts(basket.id)) {
    const item = staffCartItemArray(cp, effectivePromos);
    const product = findProductById(cp.product_id);
    if (!product) continue;
    const configForOrder: Record<string, unknown> = { ...item };
    delete configForOrder[CART_FAMILY_KEY];
    delete configForOrder[STAFF_PRICE_OVERRIDE_KEY];
    // Domain/hosting order configs lowercase the SLDs (BoxBilling #1022).
    if (item["type"] === "domain" || item["type"] === "hosting") {
      for (const k of ["register_sld", "transfer_sld", "sld"]) {
        if (typeof configForOrder[k] === "string") configForOrder[k] = (configForOrder[k] as string).toLowerCase();
      }
      const nested = configForOrder["domain"];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        const n = { ...(nested as Record<string, unknown>) };
        for (const k of ["owndomain_sld", "register_sld", "transfer_sld"]) {
          if (typeof n[k] === "string") n[k] = (n[k] as string).toLowerCase();
        }
        if (typeof n["owndomain_tld"] === "string" && !(n["owndomain_tld"] as string).includes(".")) {
          n["owndomain_tld"] = `.${n["owndomain_tld"]}`;
        }
        configForOrder["domain"] = n;
      }
    }
    const token = item[CART_FAMILY_KEY];
    let groupId: string;
    if (typeof token === "string" && token !== "") {
      groupId = familyGroups.get(token) ?? nextGroup();
      familyGroups.set(token, groupId);
    } else if (
      item["parent_id"] !== undefined &&
      item["parent_id"] !== null &&
      lastGroupByProduct.has(Number(item["parent_id"]))
    ) {
      groupId = lastGroupByProduct.get(Number(item["parent_id"]))!;
    } else {
      groupId = nextGroup();
    }
    lastGroupByProduct.set(product.id, groupId);

    const qty = Math.max(1, parseInt(String(item["quantity"] ?? "1"), 10) || 1);
    requestedQty.set(product.id, (requestedQty.get(product.id) ?? 0) + qty);
    if (product.stock_control && product.quantity_in_stock < (requestedQty.get(product.id) ?? 0)) {
      throw new FbError("Unable to complete order. One or more selected products are out of stock.");
    }
    const orderPrice = item.price * rate;
    const orderDiscount = item.discount_price * rate;
    const primary = effectivePromos[0] ?? null;
    const orderId = insertOrder({
      client_id: client.id,
      product_id: product.id,
      form_id: product.form_id,
      promo_id: primary?.id ?? null,
      promo_recurring: primary ? primary.recurring : null,
      promo_used: primary ? 1 : null,
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
    masterOrderId ??= orderId;
    orderRows.push({ id: orderId, price: orderPrice, quantity: item.quantity, discount: orderDiscount, serviceType: product.type });
    insertOrderStatus(orderId, "pending_setup", "Order Created");
    if (product.stock_control && qty > 0) {
      getDbWrite()
        .prepare("UPDATE product SET quantity_in_stock = quantity_in_stock - ? WHERE id = ?")
        .run(qty, product.id);
    }
    if (effectivePromos.length > 0) {
      const shares = staffPromoShares(cp, effectivePromos);
      const perPromo = new Map<number, number>();
      for (const promo of effectivePromos) {
        if (!incrementPromoUsedIfAvailable(promo.id)) {
          throw new FbError("This promo code has reached its maximum number of uses.");
        }
        perPromo.set(promo.id, (shares.get(promo.id) ?? 0) * rate);
      }
      discountsByOrderAndPromo.set(orderId, perPromo);
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
      invoiceItems.push({
        title: `${String(item.title)} setup`,
        price: item.setup_price * rate - item.discount_setup * rate,
        quantity: 1,
        unit: "service",
        taxed,
        type: "custom",
        task: "void",
      });
    }
  }

  const total = view["total"] as number;
  let invoiceId: number | null = null;
  let invoiceHash: string | null = null;
  let invoiceUnpaid = false;
  if (total > 0) {
    invoiceId = prepareInvoice(client, invoiceItems, gatewayIdParam);
    // PHP prepareInvoice leaves currency_rate, base_income and
    // base_refund NULL; the TS helper freezes currency_rate and zeroes
    // the other two at creation. Null them back so unpaid invoices
    // match, and re-freeze base_income/rate at payment time (see
    // staffMarkInvoicePaid). base_refund stays NULL through payment.
    getDbWrite().prepare(
      "UPDATE invoice SET currency_rate = NULL, base_income = NULL, base_refund = NULL WHERE id = ?",
    ).run(invoiceId);
    const balance = clientBalanceSum(client.id);
    const useCredits = round2(balance) >= round2(total);
    issueInvoice(invoiceId, client, { useCredits });
    if (readInvoiceStatus(invoiceId) !== "paid") {
      invoiceUnpaid = true;
      for (const oid of orderIds) updateOrderUnpaidInvoice(oid, invoiceId);
      invoiceHash = readInvoiceHash(invoiceId);
    }
  }
  if (effectivePromos.length > 0) {
    const status = invoiceUnpaid ? "reserved" : "committed";
    for (const oid of orderIds) {
      const createdAt = findOrderById(oid)?.created_at ?? nowTimestamp();
      for (const promo of effectivePromos) {
        insertPromoRedemption({
          promo_id: promo.id,
          client_id: client.id,
          client_order_id: oid,
          invoice_id: invoiceId,
          phase: "checkout",
          status,
          discount_amount: discountsByOrderAndPromo.get(oid)?.get(promo.id) ?? 0,
          currency: currency.code,
        });
        // PHP newPromoRedemption stamps created/updated (and
        // committed_at when committed) from the ORDER's created_at.
        getDbWrite()
          .prepare(
            `UPDATE promo_redemption SET created_at = ?, updated_at = ?, committed_at = ?
             WHERE promo_id = ? AND client_order_id = ? AND phase = 'checkout' AND committed_at IS NULL`,
          )
          .run(createdAt, createdAt, status === "committed" ? createdAt : null, promo.id, oid);
      }
    }
  }
  if (activate) {
    for (const orow of orderRows) {
      const order = findOrderById(orow.id);
      if (!order) continue;
      const product = order.product_id ? findProductById(order.product_id) : undefined;
      if (!product) continue;
      const setup = product.setup;
      const net = orow.price * orow.quantity - (orow.discount ?? 0);
      const isPaid = invoiceId !== null && readInvoiceStatus(invoiceId) === "paid";
      const shouldActivate =
        setup === "after_order" ||
        (total <= 0 && setup === "after_payment" && net <= 0) ||
        (total > 0 && setup === "after_payment" && isPaid);
      if (!shouldActivate) continue;
      try {
        activateOrderRow(order);
        // Order\Service::sendOrderActivationEmail (AfterAdminOrderActivateEvent).
        queueTemplatedEmail(
          `mod_service${orow.serviceType}_activated`,
          client.email,
          {
            c: { first_name: client.first_name, last_name: client.last_name, email: client.email, name: `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() },
            order: { id: order.id, title: order.title },
          },
          { toName: `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || null, clientId: client.id },
        );
      } catch (e) {
        // PHP catches per order: failed_setup history only, the order
        // row itself stays pending_setup, and checkout continues.
        insertOrderStatus(orow.id, "failed_setup", `Order could not be activated after checkout due to error: ${e instanceof Error ? e.message : String(e)}.`);
      }
    }
  }
  deleteCartRow(basket.id);
  const result = {
    gateway_id: gatewayIdParam,
    invoice_id: invoiceId,
    invoice_hash: invoiceHash,
    order_id: masterOrderId,
    orders: orderIds,
  };
  // The hash is captured while the invoice is still unpaid, then the
  // mark happens — so it stays present even on a marked-paid checkout.
  if (markPaid && invoiceId !== null && invoiceUnpaid && markGateway) {
    const txnId = ctx.params["transactionId"] !== undefined ? String(ctx.params["transactionId"]).trim() : null;
    staffMarkInvoicePaid(invoiceId, markGateway, markGateway.gateway === "Custom" ? txnId : null, ctx, rate);
  }
  return result;
});

// --- Admin cart reads + expiry --------------------------------------------

function phpStrictInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(raw)) return fallback;
  const digits = raw.replace(/^[+-]/, "");
  if (digits.length > 15) return fallback;
  return parseInt(raw, 10);
}

/** PaginationOptions::fromArray + SortOptions, cart get_list shape. */
function cartPagination(params: Record<string, string>): { page: number; perPage: number } {
  const page = phpStrictInt(params["page"], 1);
  if (page < 1) throw new FbError("Page number (page) must be a positive integer.");
  const perPage = phpStrictInt(params["per_page"], 100);
  if (perPage < 1) throw new FbError("The number of items per page (per_page) must be a positive integer.");
  if (perPage > 500) {
    throw new FbError("The number of items per page (per_page) is too large. Please specify a smaller number.");
  }
  return { page, perPage };
}

function cartSortDesc(params: Record<string, string>): boolean {
  const sort = params["sort"] !== undefined ? params["sort"].trim().toLowerCase() : "";
  if (sort !== "id") return false; // unknown sort → default cart.id ASC
  return params["direction"] !== undefined && params["direction"].trim().toUpperCase() === "DESC";
}

register("admin", "cart", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const { page, perPage } = cartPagination(ctx.params);
  const desc = cartSortDesc(ctx.params);
  const all = listCarts();
  if (desc) all.reverse();
  const total = all.length;
  // PHP Admin::get_list calls toApiArray($cart) with NO client: a manual
  // promo still prices in, but auto promos never resolve here (unlike
  // staff_basket_get, which passes the basket's client).
  const list = all
    .slice((page - 1) * perPage, page * perPage)
    .map((cart) => staffCartArray(cart, null));
  return { pages: Math.ceil(total / perPage), page, per_page: perPage, total, list };
});

register("admin", "cart", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  if (phpEmpty(ctx.params["id"])) throw new FbError("Shopping cart ID is missing");
  const cart = findCartById(Number(ctx.params["id"]));
  if (!cart) throw new FbError("Shopping cart not found");
  // Same no-client rule as get_list (PHP Admin::get → toApiArray($cart)).
  return staffCartArray(cart, null);
});

register("admin", "cart", "batch_expire", (ctx: CallContext) => {
  requireAdmin(ctx);
  // 'today' in the server timezone (UTC on the seam) minus 7 days.
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const cutoff = new Date(todayUtc.getTime() - 7 * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");
  const expired = getDb()
    .prepare("SELECT id FROM cart WHERE created_at < ? AND session_id NOT LIKE 'staff:%'")
    .all(cutoffStr) as { id: number }[];
  const w = getDbWrite();
  for (const row of expired) {
    w.prepare("DELETE FROM cart_product WHERE cart_id = ?").run(row.id);
    w.prepare("DELETE FROM cart WHERE id = ?").run(row.id);
  }
  return true;
});
