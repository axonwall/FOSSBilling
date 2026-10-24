import {
  findProductById,
  findProductPayment,
  listAllProducts,
  listCategories,
  listProductPeriods,
  listTlds,
  findTldRegistrar,
  type ProductRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { paginate } from "../util";
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

export function pricingView(product: ProductRow, admin = false): PricingView | Record<string, unknown> {
  if (product.type === "domain") return domainPricing(admin);
  const payment = product.product_payment_id ? findProductPayment(product.product_payment_id) : undefined;
  const type = payment?.type ?? "once";
  const recurrent: PricingView["recurrent"] = {};
  if (payment && type === "recurrent") {
    for (const p of listProductPeriods(payment.id)) {
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

function domainPricing(admin: boolean): Record<string, unknown> {
  const rows = listTlds();
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
      const reg = findTldRegistrar(r.tld_registrar_id);
      if (reg) entry["registrar"] = { id: reg.id, title: reg.title };
    }
    out[r.tld] = entry;
  }
  return out;
}

export function priceStartingFrom(product: ProductRow): number {
  if (product.type === "domain") {
    const prices = listTlds().map((r) => parseFloat(r.price_registration));
    return prices.length ? Math.min(...prices) : 0;
  }
  const payment = product.product_payment_id ? findProductPayment(product.product_payment_id) : undefined;
  if (!payment) return 0;
  if (payment.type === "recurrent") {
    const prices = listProductPeriods(payment.id)
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

export function productArray(product: ProductRow, admin: boolean): Record<string, unknown> {
  const config = parseJsonObject(product.config);
  const out: Record<string, unknown> = {
    id: product.id,
    product_category_id: product.product_category_id,
    type: product.type,
    title: product.title,
    slug: product.slug,
    description: product.description,
    unit: productUnit(product),
    priority: product.priority,
    pricing: pricingView(product, admin),
    config: Object.keys(config).length ? config : [],
    addons: [],
    price_starting_from: priceStartingFrom(product),
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
    out["upgrades"] = parseJsonArray(product.upgrades);
    out["status"] = product.status;
    out["hidden"] = !!product.hidden;
    out["setup"] = product.setup;
    const cat = listCategories().find((c) => c.id === product.product_category_id);
    out["category"] = cat ? { id: cat.id, title: cat.title } : null;
  }
  return out;
}

function visibleProducts(): ProductRow[] {
  return listAllProducts().filter((p) => p.active === 1 && p.status === "enabled" && !p.is_addon);
}

register("guest", "product", "get_list", (ctx: CallContext) => {
  let items = visibleProducts().filter((p) => !p.hidden);
  const categoryId = ctx.params["category_id"] ?? ctx.params["product_category_id"];
  if (categoryId) items = items.filter((p) => p.product_category_id === Number(categoryId));
  if (ctx.params["type"]) items = items.filter((p) => p.type === ctx.params["type"]);
  return paginate(items.map((p) => productArray(p, false)), ctx.params);
});

register("guest", "product", "get_pairs", () => {
  const out: Record<string, string> = {};
  for (const p of visibleProducts()) out[String(p.id)] = p.title;
  return out;
});

register("guest", "product", "get", (ctx: CallContext) => {
  const idRaw = ctx.params["id"];
  const slug = ctx.params["slug"];
  let product: ProductRow | undefined;
  if (idRaw) product = findProductById(Number(idRaw));
  if (!product && slug) product = listAllProducts().find((p) => p.slug === slug);
  if (!product || product.active !== 1) throw new FbError("Product not found");
  return productArray(product, false);
});

register("guest", "product", "category_get_list", (ctx: CallContext) => {
  const cats = listCategories().map((c) => {
    const inCat = visibleProducts().filter((p) => p.product_category_id === c.id && !p.hidden);
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      icon_url: c.icon_url,
      priority: c.priority,
      created_at: c.created_at,
      updated_at: c.updated_at,
      price_starting_from: inCat.length ? Math.min(...inCat.map(priceStartingFrom)) : 0,
      type: inCat[0]?.type ?? null,
      products: inCat.map((p) => productArray(p, false)),
    };
  });
  return paginate(cats, ctx.params);
});

register("guest", "product", "category_get_pairs", () => {
  const out: Record<string, string> = {};
  for (const c of listCategories()) out[String(c.id)] = c.title;
  return out;
});

register("admin", "product", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  let items = listAllProducts();
  if (ctx.params["type"]) items = items.filter((p) => p.type === ctx.params["type"]);
  if (ctx.params["status"]) items = items.filter((p) => p.status === ctx.params["status"]);
  return paginate(items.map((p) => productArray(p, true)), ctx.params);
});

register("admin", "product", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const idRaw = ctx.params["id"];
  if (!idRaw) throw new FbError("Product ID was not passed");
  const product = findProductById(Number(idRaw));
  if (!product) throw new FbError("Product not found");
  return productArray(product, true);
});
