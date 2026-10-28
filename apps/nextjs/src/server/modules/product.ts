import {
  findProductById,
  findProductPayment,
  getDb,
  getDbWrite,
  listAllProducts,
  listCategories,
  listProductPairs,
  listProductPeriods,
  listTlds,
  findTldRegistrar,
  type ProductRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { paginate, slugify } from "../util";
import { PERIODS } from "./system";

/**
 * Product module (guest reads + admin reads) — TS port of
 * src/modules/Product/Api/{Guest,Admin}.php read paths.
 * Parity oracle: docs/nextjs-strangler/phase3/captures9 (capture9.py).
 *
 * Pricing shape mirrors Product\Service::toProductPaymentApiArray:
 * {type, free{price,setup}, once{price,setup}, recurrent: [] | {CODE:
 * {price, setup, enabled, title}}}. Domain products instead expose the
 * TLD price map. `config` is the public-filtered product config
 * (empty object/array when unset, as PHP emits).
 */

export function periodPricingTitle(code: string): string {
  const m = /^(\d+)([DWMY])$/.exec(code);
  if (!m) return PERIODS[code] ?? code;
  const qty = parseInt(m[1], 10);
  const unit = { D: "day", W: "week", M: "month", Y: "year" }[m[2]]!;
  return `Every ${qty} ${qty === 1 ? unit : `${unit}s`}`;
}

export interface PricingView {
  type: string;
  free: { price: number; setup: number };
  once: { price: number; setup: number };
  recurrent: Record<string, { price: number; setup: number; enabled: boolean; title: string }> | never[];
}

export async function pricingView(product: ProductRow, admin = false): Promise<PricingView | Record<string, unknown>> {
  if (product.type === "domain") return await domainPricing(admin);
  const payment = product.product_payment_id ? await findProductPayment(product.product_payment_id) : undefined;
  const type = payment?.type ?? "once";
  const recurrent: PricingView["recurrent"] = {};
  if (payment && type === "recurrent") {
    for (const p of await listProductPeriods(payment.id)) {
      (recurrent as Record<string, unknown>)[p.code] = {
        price: p.price,
        setup: p.setup_price,
        enabled: !!p.enabled,
        title: periodPricingTitle(p.code),
      };
    }
  }
  return {
    type,
    free: { price: 0, setup: 0 },
    once: {
      price: payment?.once_price ?? 0,
      setup: payment?.once_setup_price ?? 0,
    },
    recurrent: type === "recurrent" ? recurrent : [],
  };
}

async function domainPricing(admin: boolean): Promise<Record<string, unknown>> {
  const rows = await listTlds();
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const entry: Record<string, unknown> = {
      tld: r.tld,
      price_registration: r.price_registration,
      price_renew: r.price_renew,
      price_transfer: r.price_transfer,
      allow_register: r.allow_register,
      allow_transfer: r.allow_transfer,
      min_years: r.min_years,
      periods: r.periods,
      active: true,
    };
    if (admin && r.tld_registrar_id) {
      const reg = await findTldRegistrar(r.tld_registrar_id);
      if (reg) entry["registrar"] = { id: reg.id, title: reg.title };
    }
    out[r.tld] = entry;
  }
  return out;
}

export async function priceStartingFrom(product: ProductRow): Promise<number> {
  if (product.type === "domain") {
    const prices = (await listTlds()).map((r) => parseFloat(r.price_registration));
    return prices.length ? Math.min(...prices) : 0;
  }
  const payment = product.product_payment_id ? await findProductPayment(product.product_payment_id) : undefined;
  if (!payment) return 0;
  if (payment.type === "recurrent") {
    const prices = (await listProductPeriods(payment.id))
      .filter((p) => p.enabled)
      .map((p) => p.price);
    return prices.length ? Math.min(...prices) : 0;
  }
  return payment.once_price ?? 0;
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Product\Service::getProductUnit — domain products bill per year. */
export function productUnit(product: ProductRow): string | null {
  if (product.type === "domain") return "year";
  return product.unit;
}

/** Addon-embedded shape (Product\\Service::toAddonArray). */
async function addonArray(product: ProductRow, admin: boolean): Promise<Record<string, unknown>> {
  const config = parseJsonObject(product.config);
  const out: Record<string, unknown> = {
    id: product.id,
    type: product.type,
    title: product.title,
    slug: product.slug,
    description: product.description,
    unit: productUnit(product),
    plugin: product.plugin,
    allow_quantity_select: !!product.allow_quantity_select,
    created_at: product.created_at,
    updated_at: product.updated_at,
    icon_url: product.icon_url,
    pricing: await pricingView(product, admin),
    config: Object.keys(config).length ? config : [],
  };
  if (!admin) {
    delete out["plugin"];
    delete out["created_at"];
    delete out["updated_at"];
  }
  return out;
}

export async function productArray(product: ProductRow, admin: boolean): Promise<Record<string, unknown>> {
  const config = parseJsonObject(product.config);
  const addonIds = parseJsonArray(product.addons)
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  const addons = await Promise.all((await listAllProducts())
    .filter((p) => p.is_addon && addonIds.includes(p.id) && (admin || p.status === "enabled"))
    .map(async (p) => await addonArray(p, admin)));
  const out: Record<string, unknown> = {
    id: product.id,
    product_category_id: product.product_category_id,
    type: product.type,
    title: product.title,
    slug: product.slug,
    description: product.description,
    unit: productUnit(product),
    priority: product.priority,
    pricing: await pricingView(product, admin),
    config: Object.keys(config).length ? config : [],
    addons,
    price_starting_from: await priceStartingFrom(product),
    icon_url: product.icon_url,
    allow_quantity_select: !!product.allow_quantity_select,
    form_id: product.form_id,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
  if (admin) {
    out["suspension_grace_days"] = product.suspension_grace_days;
    out["quantity_in_stock"] = product.quantity_in_stock;
    out["stock_control"] = !!product.stock_control;
    // Upgrades are an id -> title map (getUpgradablePairs), minus self;
    // empty stays an empty ARRAY, as PHP's empty array encodes.
    const upgradeIds = parseJsonArray(product.upgrades)
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== product.id);
    const upgrades: Record<string, string> = {};
    for (const p of await listAllProducts()) {
      if (upgradeIds.includes(p.id)) upgrades[String(p.id)] = p.title;
    }
    out["upgrades"] = Object.keys(upgrades).length ? upgrades : [];
    out["status"] = product.status;
    out["hidden"] = !!product.hidden;
    out["setup"] = product.setup;
    // The category key appears ONLY when the product has a category
    // (capture20's category-less product omits it; capture9's product
    // with a category includes it).
    const cat = (await listCategories()).find((c) => c.id === product.product_category_id);
    if (cat) out["category"] = { id: cat.id, title: cat.title };
  }
  return out;
}

async function visibleProducts(): Promise<ProductRow[]> {
  return (await listAllProducts()).filter((p) => p.active === 1 && p.status === "enabled" && !p.is_addon);
}

register("guest", "product", "get_list", async (ctx: CallContext) => {
  let items = (await visibleProducts()).filter((p) => !p.hidden);
  const categoryId = ctx.params["category_id"] ?? ctx.params["product_category_id"];
  if (categoryId) items = items.filter((p) => p.product_category_id === Number(categoryId));
  if (ctx.params["type"]) items = items.filter((p) => p.type === ctx.params["type"]);
  return paginate(await Promise.all(items.map(async (p) => await productArray(p, false))), ctx.params);
});

register("guest", "product", "get_pairs", async () => {
  const out: Record<string, string> = {};
  for (const p of await visibleProducts()) out[String(p.id)] = p.title;
  return out;
});

register("guest", "product", "get", async (ctx: CallContext) => {
  const idRaw = ctx.params["id"];
  const slug = ctx.params["slug"];
  let product: ProductRow | undefined;
  if (idRaw) product = await findProductById(Number(idRaw));
  if (!product && slug) product = (await listAllProducts()).find((p) => p.slug === slug);
  if (!product || product.active !== 1) throw new FbError("Product not found");
  return await productArray(product, false);
});

register("guest", "product", "category_get_list", async (ctx: CallContext) => {
  const cats = await Promise.all((await listCategories()).map(async (c) => {
    const inCat = (await visibleProducts()).filter((p) => p.product_category_id === c.id && !p.hidden);
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      icon_url: c.icon_url,
      priority: c.priority,
      created_at: c.created_at,
      updated_at: c.updated_at,
      price_starting_from: inCat.length ? Math.min(...await Promise.all(inCat.map(priceStartingFrom))) : 0,
      type: inCat[0]?.type ?? null,
      products: await Promise.all(inCat.map(async (p) => await productArray(p, false))),
    };
  }));
  return paginate(cats, ctx.params);
});

register("guest", "product", "category_get_pairs", async () => {
  const out: Record<string, string> = {};
  for (const c of await listCategories()) out[String(c.id)] = c.title;
  return out;
});

register("admin", "product", "get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  let items = await listAllProducts();
  if (ctx.params["type"]) items = items.filter((p) => p.type === ctx.params["type"]);
  if (ctx.params["status"]) items = items.filter((p) => p.status === ctx.params["status"]);
  return paginate(await Promise.all(items.map(async (p) => await productArray(p, true))), ctx.params);
});

/** admin/product/get_pairs: Repository::getPairs — products_only and
 * active_only default true; a present '0'/'' disables the filter
 * (PHP falsy), while any other non-empty value keeps it. Empty
 * results encode as [] (not {}), matching PHP's empty array. Unlike
 * the guest pairs, hidden products are NOT filtered here. */
register("admin", "product", "get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const rawVal = (k: string): unknown =>
    ctx.rawParams && k in ctx.rawParams ? ctx.rawParams[k] : ctx.params[k];
  const phpTruthy = (v: unknown, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return v !== "" && v !== "0";
  };
  const pairs = await listProductPairs({
    productsOnly: phpTruthy(rawVal("products_only"), true),
    activeOnly: phpTruthy(rawVal("active_only"), true),
    type: ctx.params["type"] ?? null,
  });
  if (pairs.length === 0) return [];
  const out: Record<string, string> = {};
  for (const p of pairs) out[String(p.id)] = p.title ?? "";
  return out;
});

register("admin", "product", "get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Product ID was not passed");
  const product = await findProductById(Number(idRaw));
  if (!product) throw new FbError("Product not found");
  return await productArray(product, true);
});

/* ------------------------------------------------------------------ */
/* Phase 5 R1 admin writes (parity oracle: captures20 / capture20.py) */
/* ------------------------------------------------------------------ */

function nowStr(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function toBool(v: unknown): boolean {
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  if (v === false || v === 0 || v === "0" || v === "" || v === null || v === undefined) return false;
  return true;
}

function isNumeric(v: unknown): boolean {
  return v !== "" && v !== null && v !== undefined && !Number.isNaN(Number(v));
}

/** Form bracket scan, arbitrary depth: `pricing[recurrent][1M][price]`,
 * `priority[3]`, `config[foo]` -> nested objects. */
function bracketMap(params: Record<string, string | undefined>, root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prefix = `${root}[`;
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith(prefix) || v === undefined) continue;
    const rest = k.slice(prefix.length);
    if (!rest.endsWith("]")) continue;
    const segments = rest.slice(0, -1).split("][");
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cur[seg];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) cur[seg] = {};
      cur = cur[seg] as Record<string, unknown>;
    }
    cur[segments[segments.length - 1]] = v;
  }
  return out;
}

/** Prefer a JSON body object, else the form bracket scan, for a root key. */
function nestedParam(ctx: CallContext, root: string): Record<string, unknown> | undefined {
  const raw = ctx.rawParams?.[root];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const scanned = bracketMap(ctx.params, root);
  return Object.keys(scanned).length ? scanned : undefined;
}

function validateIconUrl(iconUrl: string | undefined): void {
  if (iconUrl !== undefined && iconUrl.length > 255) {
    throw new FbError("Icon URL must not exceed 255 characters.");
  }
}

async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title);
  let slug = base;
  const taken = new Set((await listAllProducts()).map((p) => p.slug));
  while (taken.has(slug)) {
    slug = `${base}-${Math.floor(Math.random() * 9999) + 1}`;
  }
  return slug;
}

async function findCategory(id: number) {
  const cat = await getDb().prepare("SELECT id, title, description, icon_url, priority, created_at, updated_at FROM product_category WHERE id = ?").get(id) as
    | { id: number; title: string; description: string | null; icon_url: string | null; priority: number | null; created_at: string | null; updated_at: string | null }
    | undefined;
  return cat;
}

async function insertPayment(type: string): Promise<number> {
  const info = await getDbWrite().insertAndGetId("INSERT INTO product_payment (type, once_price, once_setup_price) VALUES (?, 0, 0)", type);
  return Number(info);
}

async function createProductRow(opts: {
  title: string;
  type: string;
  isAddon: boolean;
  categoryId: number | null;
  description?: string | null;
  iconUrl?: string | null;
  status: string;
  priority: number | null;
}): Promise<number> {
  const paymentId = await insertPayment("free");
  const now = nowStr();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO product (form_id, title, slug, description, unit, active, status, hidden, is_addon, setup, addons, icon_url, allow_quantity_select, stock_control, quantity_in_stock, suspension_grace_days, plugin, plugin_config, upgrades, priority, config, type, created_at, updated_at, product_category_id, product_payment_id)
       VALUES (NULL, ?, ?, ?, 'product', 1, ?, 0, ?, 'after_payment', NULL, ?, 0, 0, 0, 0, NULL, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)`, opts.title, await uniqueSlug(opts.title), opts.description ?? null, opts.status, opts.isAddon ? 1 : 0, opts.iconUrl ?? null, opts.priority, opts.type, now, now, opts.categoryId, paymentId);
  return Number(info);
}

const PERIOD_RANGES: Record<string, [number, number]> = { D: [1, 90], W: [1, 52], M: [1, 24], Y: [1, 5] };

function validatePeriod(code: string): void {
  const m = /^(\d+)([A-Za-z])$/.exec(code);
  if (!m) throw new FbError(`Invalid billing period ${code}`);
  const unit = m[2].toUpperCase();
  const range = PERIOD_RANGES[unit];
  const qty = parseInt(m[1], 10);
  if (!range || qty < range[0] || qty > range[1]) throw new FbError(`Invalid billing period ${code}`);
}

async function applyPricing(product: ProductRow, pricing: Record<string, unknown>): Promise<void> {
  const type = pricing["type"];
  if (typeof type !== "string" || !["free", "once", "recurrent"].includes(type)) {
    throw new FbError("Pricing type is required");
  }
  const db = getDbWrite();
  const payment = product.product_payment_id ? await findProductPayment(product.product_payment_id) : undefined;
  if (!payment) throw new FbError("Product not found");
  if (type === "once") {
    const once = (pricing["once"] ?? {}) as Record<string, unknown>;
    await db.prepare("UPDATE product_payment SET type = 'once', once_price = ?, once_setup_price = ? WHERE id = ?").run(
      Number(once["price"] ?? 0) || 0,
      Number(once["setup"] ?? 0) || 0,
      payment.id
    );
    return;
  }
  if (type === "free") {
    await db.prepare("UPDATE product_payment SET type = 'free' WHERE id = ?").run(payment.id);
    return;
  }
  // Recurrent: submitted periods REPLACE the set.
  const submitted = (pricing["recurrent"] ?? {}) as Record<string, unknown>;
  const codes = Object.keys(submitted);
  for (const code of codes) validatePeriod(code);
  if (codes.length === 0) {
    throw new FbError("At least one billing period must be configured for a recurring product");
  }
  const existing = await listProductPeriods(payment.id);
  const byCode = new Map(existing.map((p) => [p.code, p]));
  let maxSort = existing.reduce((m, p) => Math.max(m, p.sort_order ?? 0), 0);
  for (const code of codes) {
    const row = (submitted[code] ?? {}) as Record<string, unknown>;
    const price = Number(row["price"] ?? 0) || 0;
    const setup = Number(row["setup"] ?? 0) || 0;
    const enabled = row["enabled"] !== undefined ? (toBool(row["enabled"]) ? 1 : 0) : 0;
    const prev = byCode.get(code);
    if (prev) {
      await db.prepare("UPDATE product_payment_period SET price = ?, setup_price = ?, enabled = ? WHERE id = ?").run(price, setup, enabled, prev.id);
    } else {
      maxSort += 1;
      await db.prepare("INSERT INTO product_payment_period (code, price, setup_price, enabled, sort_order, product_payment_id) VALUES (?, ?, ?, ?, ?, ?)").run(
        code, price, setup, enabled, maxSort, payment.id
      );
    }
  }
  for (const row of existing) {
    if (!codes.includes(row.code)) {
      await db.prepare("DELETE FROM product_payment_period WHERE id = ?").run(row.id);
    }
  }
  await db.prepare("UPDATE product_payment SET type = 'recurrent' WHERE id = ?").run(payment.id);
}

async function getProductOrThrow(idRaw: string | undefined, missingMsg: string): Promise<ProductRow> {
  if (!idRaw) throw new FbError(missingMsg);
  const product = await findProductById(Number(idRaw));
  if (!product) throw new FbError("Product not found");
  return product;
}

register("admin", "product", "get_types", (ctx: CallContext) => {
  requireAdmin(ctx);
  // Base map only: no service* extension mods are installed on the
  // reference install, so nothing augments it (captures20 pin).
  return { custom: "Custom", license: "License", downloadable: "Downloadable", hosting: "Hosting", domain: "Domain" };
});

register("admin", "product", "prepare", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const title = ctx.params["title"];
  if (!title) throw new FbError("You must specify a title");
  const type = ctx.params["type"];
  if (!type) throw new FbError("Type was not passed");
  const known = ["custom", "license", "downloadable", "hosting", "domain"];
  // PHP: 'Product type :type is not registered.' (space, not colon).
  if (!known.includes(type)) throw new FbError(`Product type ${type} is not registered.`, 413);
  if (type === "domain" && (await listAllProducts()).some((p) => p.type === "domain")) {
    throw new FbError("You have already created domain product.", 413);
  }
  let categoryId: number | null = null;
  if (ctx.params["product_category_id"]) {
    const cat = await findCategory(Number(ctx.params["product_category_id"]));
    if (!cat) throw new FbError("Category not found");
    categoryId = cat.id;
  }
  return await createProductRow({ title, type, isAddon: false, categoryId, status: "disabled", priority: ((await listAllProducts()).reduce((m, p) => Math.max(m, p.priority ?? 0), 0)) + 10 });
});

register("admin", "product", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const product = await getProductOrThrow(ctx.params["id"], "Product ID was not passed");
  validateIconUrl(ctx.params["icon_url"]);
  const db = getDbWrite();
  const now = nowStr();
  if (ctx.params["suspension_grace_days"] !== undefined) {
    const rawGrace = ctx.params["suspension_grace_days"];
    const graceOk = typeof rawGrace === "number"
      ? Number.isInteger(rawGrace) && rawGrace >= 0
      : /^[+-]?\d+$/.test(String(rawGrace).trim()) && parseInt(String(rawGrace), 10) >= 0;
    if (!graceOk) {
      throw new FbError("Suspension grace days must be a non-negative integer.");
    }
    await db.prepare("UPDATE product SET suspension_grace_days = ? WHERE id = ?").run(parseInt(String(rawGrace), 10), product.id);
  }
  const pricing = nestedParam(ctx, "pricing");
  if (pricing) await applyPricing(product, pricing);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v as string | number | null);
  };
  const p = ctx.params;
  if (p["icon_url"] !== undefined) set("icon_url", p["icon_url"]);
  if (p["status"] !== undefined) set("status", p["status"]);
  if (p["hidden"] !== undefined) set("hidden", toBool(p["hidden"]) ? 1 : 0);
  if (p["slug"] !== undefined) set("slug", p["slug"]);
  if (p["setup"] !== undefined) set("setup", p["setup"]);
  if (p["title"] !== undefined) set("title", p["title"]);
  if (p["stock_control"] !== undefined) set("stock_control", toBool(p["stock_control"]) ? 1 : 0);
  if (p["allow_quantity_select"] !== undefined) set("allow_quantity_select", toBool(p["allow_quantity_select"]) ? 1 : 0);
  if (p["quantity_in_stock"] !== undefined) set("quantity_in_stock", parseInt(p["quantity_in_stock"], 10) || 0);
  if (p["description"] !== undefined) set("description", p["description"]);
  if (p["plugin"] !== undefined) set("plugin", p["plugin"]);
  if (p["product_category_id"] !== undefined) {
    // PHP empty(): "" and "0" both clear the category.
    if (p["product_category_id"] === "" || p["product_category_id"] === "0") {
      set("product_category_id", null);
    } else {
      const cat = await findCategory(Number(p["product_category_id"]));
      if (!cat) throw new FbError("Category not found");
      set("product_category_id", cat.id);
    }
  }
  if (p["form_id"] !== undefined) set("form_id", p["form_id"] === "" || p["form_id"] === "0" ? null : Number(p["form_id"]));
  const configObj = nestedParam(ctx, "config");
  if (configObj) {
    const current = parseJsonObject(product.config);
    set("config", JSON.stringify({ ...current, ...configObj }));
  }
  const listParam = (key: string): unknown[] | undefined => {
    const raw = ctx.rawParams?.[key];
    if (Array.isArray(raw)) return raw;
    if (raw !== undefined) return [raw];
    // Form bracket fallback: upgrades[0], upgrades[1], ... in index order.
    const scanned = bracketMap(ctx.params, key);
    const idx = Object.keys(scanned).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (idx.length) return idx.map((k) => scanned[k]);
    return undefined;
  };
  for (const key of ["upgrades", "addons"]) {
    const arr = listParam(key);
    if (arr !== undefined) {
      // PHP array_filter: "0" is falsy too.
      const filtered = arr.filter((v) => v !== "" && v !== "0" && v !== null && v !== undefined && v !== 0 && v !== false);
      set(key, filtered.length ? JSON.stringify(filtered) : null);
    }
  }
  if (sets.length) {
    await db.prepare(`UPDATE product SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now, product.id);
  } else {
    await db.prepare("UPDATE product SET updated_at = ? WHERE id = ?").run(now, product.id);
  }
  return true;
});

register("admin", "product", "update_priority", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const map = nestedParam(ctx, "priority");
  if (!map) throw new FbError("priority params is missing");
  const db = getDbWrite();
  const now = nowStr();
  for (const [id, value] of Object.entries(map)) {
    if (!await findProductById(Number(id))) continue;
    await db.prepare("UPDATE product SET priority = ?, updated_at = ? WHERE id = ?").run(parseInt(String(value), 10) || 0, now, Number(id));
  }
  return true;
});

register("admin", "product", "update_config", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const product = await getProductOrThrow(ctx.params["id"], "Product ID was not passed");
  const current = parseJsonObject(product.config);
  const submitted = nestedParam(ctx, "config");
  let next: Record<string, unknown> = { ...current };
  if (submitted) {
    next = {};
    for (const k of Object.keys(current)) {
      if (k in submitted) next[k] = current[k];
    }
    for (const [k, v] of Object.entries(submitted)) {
      // A submitted empty non-numeric value DELETES the key ("0" is
      // numeric, so it is kept).
      if ((v === "" || v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0)) && !isNumeric(v)) {
        delete next[k];
      } else {
        next[k] = v;
      }
    }
  }
  const name = ctx.params["new_config_name"];
  const value = ctx.params["new_config_value"];
  if (name && value) next[name] = value;
  await getDbWrite().prepare("UPDATE product SET config = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), nowStr(), product.id);
  return true;
});

register("admin", "product", "delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const product = await getProductOrThrow(ctx.params["id"], "Product ID was not passed");
  const orders = await getDb().prepare("SELECT COUNT(1) AS c FROM client_order WHERE product_id = ?").get(product.id) as { c: number };
  if (orders.c > 0) throw new FbError("Cannot remove product which has active orders.");
  // Only the product row is deleted; its product_payment row is orphaned.
  await getDbWrite().prepare("DELETE FROM product WHERE id = ?").run(product.id);
  return true;
});

register("admin", "product", "addon_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const title = ctx.params["title"];
  if (!title) throw new FbError("You must specify a title");
  validateIconUrl(ctx.params["icon_url"]);
  // createAddon does not set status/priority: entity defaults apply
  // (status 'enabled', priority NULL) — captures20 pin.
  return await createProductRow({
    title,
    type: "custom",
    isAddon: true,
    categoryId: null,
    description: ctx.params["description"] ?? null,
    iconUrl: ctx.params["icon_url"] ?? null,
    status: "enabled",
    priority: null,
  });
});

register("admin", "product", "addon_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const product = await getProductOrThrow(ctx.params["id"], "Addon ID was not passed");
  if (!product.is_addon) throw new FbError("Addon not found");
  return await productArray(product, true);
});

register("admin", "product", "addon_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const product = await getProductOrThrow(ctx.params["id"], "Addon ID was not passed");
  if (!product.is_addon) throw new FbError("Addon not found");
  validateIconUrl(ctx.params["icon_url"]);
  const db = getDbWrite();
  const p = ctx.params;
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (p["title"] !== undefined) {
    sets.push("title = ?");
    vals.push(p["title"]);
  }
  if (p["icon_url"] !== undefined) {
    sets.push("icon_url = ?");
    vals.push(p["icon_url"]);
  }
  if (p["description"] !== undefined) {
    sets.push("description = ?");
    vals.push(p["description"]);
  }
  const pricing = nestedParam(ctx, "pricing");
  if (pricing) await applyPricing(product, pricing);
  if (sets.length) {
    await db.prepare(`UPDATE product SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, nowStr(), product.id);
  }
  return true;
});

register("admin", "product", "addon_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const product = await getProductOrThrow(ctx.params["id"], "Addon ID was not passed");
  if (!product.is_addon) throw new FbError("Addon not found");
  await getDbWrite().prepare("DELETE FROM product WHERE id = ?").run(product.id);
  return true;
});

register("admin", "product", "addon_get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const p of (await listAllProducts()).filter((x) => x.is_addon)) out[String(p.id)] = p.title;
  return out;
});

/* ------------------------------ Categories ------------------------------ */

async function categoryArray(cat: { id: number; title: string; description: string | null; icon_url: string | null; priority: number | null; created_at: string | null; updated_at: string | null }): Promise<Record<string, unknown>> {
  const inCat = (await listAllProducts()).filter((p) => p.product_category_id === cat.id);
  return {
    id: cat.id,
    title: cat.title,
    description: cat.description,
    icon_url: cat.icon_url,
    priority: cat.priority,
    created_at: cat.created_at,
    updated_at: cat.updated_at,
    price_starting_from: inCat.length ? Math.min(...await Promise.all(inCat.map(priceStartingFrom))) : 0,
    type: inCat[0]?.type ?? null,
    products: await Promise.all(inCat.map(async (p) => await productArray(p, false))),
  };
}

register("admin", "product", "category_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const title = ctx.params["title"];
  if (!title) throw new FbError("Category title is required");
  validateIconUrl(ctx.params["icon_url"]);
  const priorityRaw = ctx.params["priority"];
  let priority: number;
  if (priorityRaw === undefined || priorityRaw === "" || priorityRaw === null) {
    priority = (await listCategories()).reduce((m, c) => Math.max(m, c.priority ?? 0), 0) + 10;
  } else {
    priority = parseInt(priorityRaw, 10) || 0;
  }
  const now = nowStr();
  const info = await getDbWrite().insertAndGetId("INSERT INTO product_category (title, description, icon_url, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", title, ctx.params["description"] ?? null, ctx.params["icon_url"] ?? null, priority, now, now);
  return Number(info);
});

register("admin", "product", "category_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Category ID was not passed");
  const cat = await findCategory(Number(idRaw));
  if (!cat) throw new FbError("Category not found");
  return await categoryArray(cat);
});

register("admin", "product", "category_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Category ID was not passed");
  const cat = await findCategory(Number(idRaw));
  if (!cat) throw new FbError("Category not found");
  validateIconUrl(ctx.params["icon_url"]);
  const db = getDbWrite();
  const p = ctx.params;
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (p["title"] !== null && p["title"] !== undefined) {
    sets.push("title = ?");
    vals.push(p["title"]);
  }
  if (p["icon_url"] !== null && p["icon_url"] !== undefined) {
    sets.push("icon_url = ?");
    vals.push(p["icon_url"]);
  }
  if (p["description"] !== null && p["description"] !== undefined) {
    sets.push("description = ?");
    vals.push(p["description"]);
  }
  if (p["priority"] !== null && p["priority"] !== undefined && p["priority"] !== "") {
    sets.push("priority = ?");
    vals.push(parseInt(p["priority"], 10) || 0);
  }
  await db.prepare(`UPDATE product_category SET ${sets.join(", ")}${sets.length ? ", " : ""}updated_at = ? WHERE id = ?`).run(...vals, nowStr(), cat.id);
  return true;
});

register("admin", "product", "category_update_priority", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const map = nestedParam(ctx, "priority");
  if (!map) throw new FbError("priority params is missing");
  // Validate EVERY value first (FILTER_VALIDATE_INT semantics: int or
  // int-string; booleans/floats rejected) before applying any.
  for (const v of Object.values(map)) {
    const ok = typeof v === "number"
      ? Number.isInteger(v)
      : typeof v === "string" && /^[+-]?\d+$/.test(v.trim());
    if (!ok) throw new FbError("Priority must be an integer.");
  }
  const db = getDbWrite();
  const now = nowStr();
  for (const [id, value] of Object.entries(map)) {
    if (!await findCategory(Number(id))) continue;
    await db.prepare("UPDATE product_category SET priority = ?, updated_at = ? WHERE id = ?").run(parseInt(String(value), 10), now, Number(id));
  }
  return true;
});

register("admin", "product", "category_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  let cats = await listCategories();
  if (ctx.params["search"]) {
    const q = ctx.params["search"].toLowerCase();
    cats = cats.filter((c) => c.title.toLowerCase().includes(q));
  }
  const sortKey = ctx.params["sort"] ?? "priority";
  const dir = (ctx.params["dir"] ?? "asc").toLowerCase() === "desc" ? -1 : 1;
  const keyOf = (c: { id: number; title: string; priority: number | null; created_at: string | null; updated_at: string | null }): string | number =>
    sortKey === "title" ? c.title : sortKey === "created_at" ? (c.created_at ?? "") : sortKey === "updated_at" ? (c.updated_at ?? "") : sortKey === "id" ? c.id : (c.priority ?? 0);
  cats = [...cats].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    // Explicit-sort tiebreak is id in the SAME direction (repository).
    return (a.id - b.id) * dir;
  });
  // NOT paginated: lean rows only.
  return cats.map((c) => ({ id: c.id, title: c.title, priority: c.priority }));
});

register("admin", "product", "category_get_pairs", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const c of await listCategories()) out[String(c.id)] = c.title;
  return out;
});

register("admin", "product", "category_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Category ID was not passed");
  const cat = await findCategory(Number(idRaw));
  if (!cat) throw new FbError("Category not found");
  const count = await getDb().prepare("SELECT COUNT(1) AS c FROM product WHERE product_category_id = ?").get(cat.id) as { c: number };
  if (count.c > 0) throw new FbError("Cannot remove product category with products");
  await getDbWrite().prepare("DELETE FROM product_category WHERE id = ?").run(cat.id);
  return true;
});

/* --------------------------------- Promos --------------------------------- */

interface PromoRow {
  id: number;
  code: string | null;
  description: string | null;
  type: string | null;
  value: number | null;
  maxuses: number | null;
  used: number | null;
  freesetup: number;
  once_per_client: number;
  recurring: number;
  active: number;
  products: string | null;
  periods: string | null;
  client_groups: string | null;
  requires_products: string | null;
  start_at: string | null;
  end_at: string | null;
  auto_apply: number;
  priority: number | null;
  stackable: number;
  created_at: string | null;
  updated_at: string | null;
}

const PROMO_COLS = "id, code, description, type, value, maxuses, used, freesetup, once_per_client, recurring, active, products, periods, client_groups, requires_products, start_at, end_at, auto_apply, priority, stackable, created_at, updated_at";

async function findPromo(id: number): Promise<PromoRow | undefined> {
  return await getDb().prepare(`SELECT ${PROMO_COLS} FROM promo WHERE id = ?`).get(id) as PromoRow | undefined;
}

function decodePromoSelection(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function encodePromoSelection(arr: unknown[] | undefined): string | null {
  if (arr === undefined) return null;
  const filtered = arr.filter((v) => v !== "" && v !== null && v !== undefined && v !== 0 && v !== false);
  return filtered.length ? JSON.stringify(filtered) : null;
}

async function promoRedemptionCount(promoId: number): Promise<number> {
  return ((await getDb().prepare("SELECT COUNT(1) AS c FROM promo_redemption WHERE promo_id = ?").get(promoId)) as { c: number }).c;
}

async function promoLinkedOrderCount(promoId: number): Promise<number> {
  return ((await getDb().prepare("SELECT COUNT(1) AS c FROM client_order WHERE promo_id = ?").get(promoId)) as { c: number }).c;
}

async function promoHasHistory(promoId: number): Promise<boolean> {
  return await promoRedemptionCount(promoId) > 0 || await promoLinkedOrderCount(promoId) > 0;
}

async function promoUsageStats(promo: PromoRow): Promise<Record<string, unknown>> {
  const rows = await getDb().prepare("SELECT phase, status, client_id, client_order_id FROM promo_redemption WHERE promo_id = ?").all(promo.id) as { phase: string; status: string; client_id: number | null; client_order_id: number | null }[];
  const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  const maxUses = promo.maxuses ?? null;
  return {
    operational_use_count: promo.used ?? 0,
    max_uses: maxUses,
    remaining_operational_uses: maxUses !== null ? Math.max(maxUses - (promo.used ?? 0), 0) : null,
    recorded_applications: rows.length,
    checkout_applications: count((r) => r.phase === "checkout"),
    renewal_applications: count((r) => r.phase === "renewal"),
    active_checkout_applications: count((r) => r.phase === "checkout" && (r.status === "reserved" || r.status === "committed")),
    reserved_applications: count((r) => r.status === "reserved"),
    committed_applications: count((r) => r.status === "committed"),
    released_applications: count((r) => r.status === "released"),
    distinct_clients: new Set(rows.map((r) => r.client_id).filter((v) => v !== null)).size,
    orders_using_promo: new Set(rows.map((r) => r.client_order_id).filter((v) => v !== null)).size,
  };
}

async function promoArray(promo: PromoRow, deep: boolean): Promise<Record<string, unknown>> {
  const products = decodePromoSelection(promo.products);
  const requires = decodePromoSelection(promo.requires_products);
  const cgroupsRaw = decodePromoSelection(promo.client_groups);
  // The id -> title maps are null when the selection is empty (the
  // decoded list fields below are [] in that case) — captures20 pin.
  const appliesTo: Record<string, string> | null = products && products.length
    ? Object.fromEntries(
        (await Promise.all(products
          .map(async (id) => await findProductById(Number(id)))))
          .filter((p): p is ProductRow => !!p)
          .map((p) => [String(p.id), p.title])
      )
    : null;
  const requiresMap: Record<string, string> | null = requires && requires.length
    ? Object.fromEntries(
        (await Promise.all(requires
          .map(async (id) => await findProductById(Number(id)))))
          .filter((p): p is ProductRow => !!p)
          .map((p) => [String(p.id), p.title])
      )
    : null;
  const cgroupsMap: Record<string, string> | null = cgroupsRaw && cgroupsRaw.length
    ? Object.fromEntries(
        (await Promise.all(cgroupsRaw
          .map(async (id) => await getDb().prepare("SELECT id, title FROM client_group WHERE id = ?").get(Number(id)) as { id: number; title: string } | undefined)))
          .filter((g): g is { id: number; title: string } => !!g)
          .map((g) => [String(g.id), g.title])
      )
    : null;
  const out: Record<string, unknown> = {
    id: promo.id,
    code: promo.code,
    description: promo.description,
    type: promo.type,
    value: promo.value !== null ? Number(promo.value) : null,
    maxuses: promo.maxuses ?? 0,
    used: promo.used ?? 0,
    freesetup: !!promo.freesetup,
    once_per_client: !!promo.once_per_client,
    recurring: !!promo.recurring,
    active: !!promo.active,
    products: products ?? [],
    periods: decodePromoSelection(promo.periods) ?? [],
    client_groups: cgroupsRaw ?? [],
    requires_products: requires ?? [],
    start_at: promo.start_at,
    end_at: promo.end_at,
    auto_apply: !!promo.auto_apply,
    priority: promo.priority ?? 0,
    stackable: !!promo.stackable,
    created_at: promo.created_at,
    updated_at: promo.updated_at,
    applies_to: appliesTo,
    requires: requiresMap,
    cgroups: cgroupsMap,
    redemption_count: await promoRedemptionCount(promo.id),
    can_be_deleted: !await promoHasHistory(promo.id),
  };
  if (deep) out["usage_stats"] = await promoUsageStats(promo);
  return out;
}

function normalizePromoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace("T", " ").slice(0, 19);
}

async function applyPromoData(promo: PromoRow, ctx: CallContext, isCreate: boolean): Promise<void> {
  const p = ctx.params;
  const raw = ctx.rawParams ?? {};
  const db = getDbWrite();
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v as string | number | null);
  };
  if (p["code"] !== undefined) set("code", p["code"]);
  if (p["description"] !== undefined) set("description", p["description"]);
  if (p["type"] !== undefined) set("type", p["type"]);
  if (p["value"] !== undefined) set("value", p["value"] === "" ? null : Number(p["value"]));
  for (const key of ["active", "freesetup", "once_per_client", "recurring", "auto_apply", "stackable"]) {
    if (p[key] !== undefined) set(key, toBool(p[key]) ? 1 : 0);
  }
  for (const key of ["used", "maxuses", "priority"]) {
    if (p[key] !== undefined) set(key, parseInt(p[key], 10) || 0);
  }
  const sel = (key: string): unknown[] | undefined => {
    const v = raw[key];
    if (Array.isArray(v)) return v;
    if (v !== undefined) return [v];
    // Form bracket fallback: products[0], products[1], ... in index order.
    const scanned = bracketMap(ctx.params, key);
    const idx = Object.keys(scanned).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (idx.length) return idx.map((k) => scanned[k]);
    return undefined;
  };
  for (const key of ["products", "periods", "client_groups"]) {
    const arr = sel(key);
    if (arr !== undefined) set(key, encodePromoSelection(arr));
  }
  const req = sel("requires_products");
  if (req !== undefined) {
    const ids = [...new Set(req.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
    set("requires_products", ids.length ? JSON.stringify(ids) : null);
  }
  if (p["start_at"] !== undefined) set("start_at", normalizePromoDate(p["start_at"]));
  if (p["end_at"] !== undefined) set("end_at", normalizePromoDate(p["end_at"]));
  if (!isCreate && sets.length === 0) {
    await db.prepare("UPDATE promo SET updated_at = ? WHERE id = ?").run(nowStr(), promo.id);
    return;
  }
  await db.prepare(`UPDATE promo SET ${sets.join(", ")}${sets.length ? ", " : ""}updated_at = ? WHERE id = ?`).run(...vals, nowStr(), promo.id);
}

register("admin", "product", "promo_create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const code = ctx.params["code"];
  if (!code) throw new FbError("Promo code is missing");
  if (!ctx.params["type"]) throw new FbError("Promo type is missing");
  if (ctx.params["value"] === undefined || ctx.params["value"] === "") throw new FbError("Promo value is missing");
  const dup = await getDb().prepare("SELECT id FROM promo WHERE code = ?").get(code) as { id: number } | undefined;
  if (dup) throw new FbError("This promotion code already exists.");
  const now = nowStr();
  const info = await getDbWrite().insertAndGetId("INSERT INTO promo (code, description, type, value, maxuses, used, freesetup, once_per_client, recurring, active, products, periods, client_groups, requires_products, start_at, end_at, auto_apply, priority, stackable, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, ?, ?)", code, ctx.params["description"] ?? null, ctx.params["type"], Number(ctx.params["value"]), now, now);
  const promo = (await findPromo(Number(info)))!;
  await applyPromoData(promo, ctx, true);
  return promo.id;
});

register("admin", "product", "promo_get", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Promo ID was not passed");
  const promo = await findPromo(Number(idRaw));
  if (!promo) throw new FbError("Promo not found");
  return await promoArray(promo, true);
});

register("admin", "product", "promo_update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Promo ID was not passed");
  const promo = await findPromo(Number(idRaw));
  if (!promo) throw new FbError("Promo not found");
  const newCode = ctx.params["code"];
  if (newCode && newCode !== promo.code) {
    const dup = await getDb().prepare("SELECT id FROM promo WHERE code = ? AND id != ?").get(newCode, promo.id) as { id: number } | undefined;
    if (dup) throw new FbError("This promotion code already exists.");
  }
  await applyPromoData(promo, ctx, false);
  return true;
});

register("admin", "product", "promo_duplicate", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Promo ID was not passed");
  const promo = await findPromo(Number(idRaw));
  if (!promo) throw new FbError("Promo not found");
  const base = promo.code && promo.code !== "" ? promo.code : "PROMO";
  const codes = new Set(((await getDb().prepare("SELECT code FROM promo").all()) as { code: string }[]).map((r) => r.code));
  let candidate = `${base}-COPY`;
  if (codes.has(candidate)) {
    let n = 2;
    while (codes.has(`${base}-COPY-${n}`)) n += 1;
    candidate = `${base}-COPY-${n}`;
  }
  if (candidate.length > 100) {
    candidate = `${base.slice(0, 100 - (candidate.length - base.length))}${candidate.slice(base.length)}`;
  }
  const now = nowStr();
  const info = await getDbWrite().insertAndGetId("INSERT INTO promo (code, description, type, value, maxuses, used, freesetup, once_per_client, recurring, active, products, periods, client_groups, requires_products, start_at, end_at, auto_apply, priority, stackable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", candidate, promo.description, promo.type, promo.value, promo.maxuses ?? 0, promo.freesetup, promo.once_per_client, promo.recurring, promo.products, promo.periods, promo.client_groups, promo.requires_products, promo.start_at, promo.end_at, promo.auto_apply, promo.priority ?? 0, promo.stackable, now, now);
  return Number(info);
});

register("admin", "product", "promo_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Promo ID was not passed");
  const promo = await findPromo(Number(idRaw));
  if (!promo) throw new FbError("Promo not found");
  if (await promoHasHistory(promo.id)) {
    throw new FbError("Promotions with redemption history cannot be deleted. Disable the promotion instead.");
  }
  await getDbWrite().prepare("DELETE FROM promo WHERE id = ?").run(promo.id);
  return true;
});

register("admin", "product", "promo_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  let promos = await getDb().prepare(`SELECT ${PROMO_COLS} FROM promo`).all() as unknown as PromoRow[];
  const p = ctx.params;
  if (p["id"]) promos = promos.filter((x) => x.id === Number(p["id"]));
  if (p["search"]) {
    const q = p["search"].toLowerCase();
    promos = promos.filter((x) => (x.code ?? "").toLowerCase().includes(q));
  }
  if (p["auto_apply"] !== undefined && p["auto_apply"] !== "" && p["auto_apply"] !== null) {
    const want = toBool(p["auto_apply"]) ? 1 : 0;
    promos = promos.filter((x) => x.active !== undefined && (x.auto_apply ? 1 : 0) === want);
  }
  const now = nowStr();
  if (p["status"] === "active") {
    promos = promos.filter((x) => x.active && (!x.start_at || x.start_at <= now) && (!x.end_at || x.end_at >= now));
  } else if (p["status"] === "not-started") {
    promos = promos.filter((x) => x.start_at && x.start_at > now);
  } else if (p["status"] === "expired") {
    promos = promos.filter((x) => x.end_at && x.end_at < now);
  }
  const sortKey = p["sort"] ?? "id";
  const dir = (p["dir"] ?? "asc").toLowerCase() === "desc" ? -1 : 1;
  const keyOf = (x: PromoRow): string | number => {
    switch (sortKey) {
      case "code": return x.code ?? "";
      case "type": return x.type ?? "";
      case "value": return x.value ?? 0;
      case "active": return x.active;
      case "priority": return x.priority ?? 0;
      case "start_at": return x.start_at ?? "";
      case "end_at": return x.end_at ?? "";
      case "created_at": return x.created_at ?? "";
      case "updated_at": return x.updated_at ?? "";
      default: return x.id;
    }
  };
  promos = [...promos].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return a.id - b.id;
  });
  return paginate(await Promise.all(promos.map(async (x) => await promoArray(x, false))), p);
});

register("admin", "product", "promo_redemption_get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const promoIdRaw = ctx.params["promo_id"];
  if (!promoIdRaw) throw new FbError("Promo ID is missing");
  const promoId = Number(promoIdRaw);
  let rows = await getDb().prepare("SELECT id, promo_id, client_id, client_order_id, invoice_id, phase, status, discount_amount, currency, committed_at, released_at, release_reason, created_at, updated_at FROM promo_redemption WHERE promo_id = ?").all(promoId) as Record<string, unknown>[];
  const p = ctx.params;
  if (p["client_id"]) rows = rows.filter((r) => r["client_id"] === Number(p["client_id"]));
  if (p["client_order_id"]) rows = rows.filter((r) => r["client_order_id"] === Number(p["client_order_id"]));
  if (p["invoice_id"]) rows = rows.filter((r) => r["invoice_id"] === Number(p["invoice_id"]));
  if (p["phase"]) rows = rows.filter((r) => r["phase"] === p["phase"]);
  if (p["status"]) rows = rows.filter((r) => r["status"] === p["status"]);
  const sortKey = p["sort"] ?? "id";
  const dir = (p["dir"] ?? "asc").toLowerCase() === "desc" ? -1 : 1;
  const keyOf = (r: Record<string, unknown>): string | number => {
    const v = r[sortKey];
    return typeof v === "number" ? v : typeof v === "string" ? v : 0;
  };
  rows = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return Number(a["id"]) - Number(b["id"]);
  });
  const db = getDb();
  const enriched = await Promise.all(rows.map(async (row) => {
    const out: Record<string, unknown> = { ...row, client: null, order: null, invoice: null };
    if (row["client_id"]) {
      const c = await db.prepare("SELECT first_name, last_name, email FROM client WHERE id = ?").get(Number(row["client_id"])) as { first_name: string; last_name: string; email: string } | undefined;
      out["client"] = { id: Number(row["client_id"]), first_name: c?.first_name ?? null, last_name: c?.last_name ?? null, email: c?.email ?? null };
    }
    if (row["client_order_id"]) {
      const o = await db.prepare("SELECT title, created_at FROM client_order WHERE id = ?").get(Number(row["client_order_id"])) as { title: string; created_at: string } | undefined;
      out["order"] = { id: Number(row["client_order_id"]), title: o?.title ?? null, created_at: o?.created_at ?? null };
    }
    if (row["invoice_id"]) {
      const inv = await db.prepare("SELECT serie, nr, status, created_at FROM invoice WHERE id = ?").get(Number(row["invoice_id"])) as { serie: string; nr: number; status: string; created_at: string } | undefined;
      let serieNr: string | null = null;
      if (inv) {
        const padRow = await db.prepare("SELECT meta_value FROM setting WHERE param = 'invoice_number_padding'").get() as { meta_value: string } | undefined;
        const padding = padRow?.meta_value ? parseInt(padRow.meta_value, 10) : 5;
        serieNr = inv.serie + String(inv.nr).padStart(padding, "0");
      }
      out["invoice"] = { id: Number(row["invoice_id"]), serie_nr: serieNr, status: inv?.status ?? null, created_at: inv?.created_at ?? null };
    }
    return out;
  }));
  return paginate(enriched, p);
});
