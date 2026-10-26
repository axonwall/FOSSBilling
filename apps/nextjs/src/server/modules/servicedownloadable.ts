// Servicedownloadable — downloadable product file management.
//
// Only the JSON endpoints are TS-served. `upload` and `update` need
// multipart file_data, which the JSON dispatch cannot carry, and the
// three `send_*` endpoints return binary file bytes, which the JSON
// envelope cannot carry — all five stay PHP-proxied (same treatment as
// the invoice PDF / CSV downloads deferred in earlier batches).

import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp } from "../db";

interface ProductRow {
  id: number;
  config: string | null;
}

interface OrderRow {
  id: number;
  client_id: number;
  product_id: number;
  service_id: number | null;
  service_type: string | null;
  config: string | null;
}

interface ServiceFileRow {
  id: number;
  label: string | null;
  description: string | null;
  downloads: number;
  sort_order: number;
  file_key: string;
  filename: string;
  stored_filename: string;
  service_downloadable_id: number;
}

interface FileDef {
  id: string;
  filename: string;
  stored_filename: string;
  label: string | null;
  description: string | null;
}

function findProduct(id: number): ProductRow {
  const row = getDb().prepare("SELECT id, config FROM product WHERE id = ?").get(id) as unknown as
    | ProductRow
    | undefined;
  if (!row) throw new FbError("Product not found");
  return row;
}

function findOrder(id: number): OrderRow {
  const row = getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as
    | OrderRow
    | undefined;
  if (!row) throw new FbError("Order not found");
  return row;
}

function validateFileKey(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{32}$/.test(v)) throw new FbError("File not found");
  return v;
}

function parseConfig(json: string | null): Record<string, unknown> {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function productFiles(product: ProductRow): FileDef[] {
  const cfg = parseConfig(product.config);
  const files = cfg["files"];
  return Array.isArray(files) ? (files as FileDef[]) : [];
}

function findDefIndex(files: FileDef[], key: string): number {
  const idx = files.findIndex((f) => f.id === key);
  if (idx === -1) throw new FbError("File not found");
  return idx;
}

/** PHP Tools::normalizeBoolean. */
function normalizeBoolean(v: unknown, def = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (["1", "true", "on", "yes"].includes(s)) return true;
    if (["0", "false", "off", "no", ""].includes(s)) return false;
    return def;
  }
  return def;
}

function optionalText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function saveProductConfig(product: ProductRow, cfg: Record<string, unknown>): void {
  getDbWrite()
    .prepare("UPDATE product SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cfg), nowTimestamp(), product.id);
}

function saveOrderConfig(order: OrderRow, cfg: Record<string, unknown>): void {
  getDbWrite()
    .prepare("UPDATE client_order SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cfg), nowTimestamp(), order.id);
}

function serviceFiles(serviceId: number): ServiceFileRow[] {
  return getDb()
    .prepare("SELECT * FROM service_downloadable_file WHERE service_downloadable_id = ? ORDER BY sort_order ASC")
    .all(serviceId) as unknown as ServiceFileRow[];
}

function ordersForProduct(productId: number): OrderRow[] {
  return getDb().prepare("SELECT * FROM client_order WHERE product_id = ? ORDER BY id ASC").all(productId) as unknown as OrderRow[];
}

function downloadableServiceFor(order: OrderRow): number | null {
  if (order.service_id === null || order.service_type !== "downloadable") return null;
  const row = getDb().prepare("SELECT id FROM service_downloadable WHERE id = ?").get(order.service_id) as unknown as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

function uploadsDir(): string | null {
  const dbPath = process.env.FB_DATABASE_PATH;
  if (!dbPath) return null;
  return join(dirname(dbPath), "uploads");
}

function isStoredFilenameReferenced(stored: string): boolean {
  const inFiles = getDb()
    .prepare("SELECT COUNT(*) AS c FROM service_downloadable_file WHERE stored_filename = ?")
    .get(stored) as unknown as { c: number };
  if (inFiles.c > 0) return true;
  const inProducts = getDb()
    .prepare("SELECT COUNT(*) AS c FROM product WHERE config LIKE ?")
    .get(`%${stored}%`) as unknown as { c: number };
  return inProducts.c > 0;
}

function removeStoredFileIfOrphaned(stored: string): void {
  if (!/^[a-f0-9]{64}$/.test(stored)) return;
  if (isStoredFilenameReferenced(stored)) return;
  const dir = uploadsDir();
  if (!dir) return;
  const p = join(dir, stored);
  if (existsSync(p)) unlinkSync(p);
}

register("admin", "servicedownloadable", "file_update", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const product = findProduct(Number(ctx.params["id"]));
  const key = validateFileKey(ctx.params["file_id"]);
  const cfg = parseConfig(product.config);
  const files = productFiles(product);
  const idx = findDefIndex(files, key);
  const label = optionalText(ctx.params["label"] ?? (ctx.rawParams as Record<string, unknown>)["label"]);
  if (label !== null && label.length > 255) throw new FbError("File label cannot exceed 255 characters");
  const description = optionalText(
    ctx.params["description"] ?? (ctx.rawParams as Record<string, unknown>)["description"],
  );
  if (description !== null && description.length > 1000) {
    throw new FbError("File description cannot exceed 1000 characters");
  }
  files[idx] = { ...files[idx], label, description };
  cfg["files"] = files;
  saveProductConfig(product, cfg);
  if (normalizeBoolean(cfg["update_orders"] ?? false)) {
    for (const order of ordersForProduct(product.id)) {
      const orderCfg = parseConfig(order.config);
      const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
      let changed = false;
      for (let i = 0; i < ofiles.length; i++) {
        if (ofiles[i].id === key) {
          ofiles[i] = files[idx];
          changed = true;
        }
      }
      if (changed) {
        orderCfg["files"] = ofiles;
        saveOrderConfig(order, orderCfg);
      } else {
        // PHP still rewrites the order config even when nothing matched.
        saveOrderConfig(order, orderCfg);
      }
      const svcId = downloadableServiceFor(order);
      if (svcId !== null) {
        const row = serviceFiles(svcId).find((f) => f.file_key === key);
        if (row) {
          getDbWrite()
            .prepare("UPDATE service_downloadable_file SET label = ?, description = ? WHERE id = ?")
            .run(label, description, row.id);
        }
      }
    }
  }
  return true;
});

register("admin", "servicedownloadable", "file_delete", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const product = findProduct(Number(ctx.params["id"]));
  const key = validateFileKey(ctx.params["file_id"]);
  const cfg = parseConfig(product.config);
  const files = productFiles(product);
  const idx = findDefIndex(files, key);
  const stored = files[idx].stored_filename;
  files.splice(idx, 1);
  cfg["files"] = files;
  saveProductConfig(product, cfg);
  if (normalizeBoolean(cfg["update_orders"] ?? false)) {
    for (const order of ordersForProduct(product.id)) {
      const orderCfg = parseConfig(order.config);
      const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
      orderCfg["files"] = ofiles.filter((f) => f.id !== key);
      saveOrderConfig(order, orderCfg);
      const svcId = downloadableServiceFor(order);
      if (svcId !== null) {
        const row = serviceFiles(svcId).find((f) => f.file_key === key);
        if (row) {
          getDbWrite().prepare("DELETE FROM service_downloadable_file WHERE id = ?").run(row.id);
        }
      }
    }
  }
  removeStoredFileIfOrphaned(stored);
  return true;
});

register("admin", "servicedownloadable", "order_file_delete", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["order_id"]) throw new FbError("Order ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const order = findOrder(Number(ctx.params["order_id"]));
  const svcId = downloadableServiceFor(order);
  if (svcId === null) throw new FbError("Order is not activated");
  const fileId = Number(ctx.params["file_id"]);
  const row = serviceFiles(svcId).find((f) => f.id === fileId);
  if (!row) throw new FbError("File not found");
  const stored = row.stored_filename;
  const key = row.file_key;
  getDbWrite().prepare("DELETE FROM service_downloadable_file WHERE id = ?").run(row.id);
  const orderCfg = parseConfig(order.config);
  const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
  orderCfg["files"] = ofiles.filter((f) => f.id !== key);
  saveOrderConfig(order, orderCfg);
  removeStoredFileIfOrphaned(stored);
  return true;
});

register("admin", "servicedownloadable", "config_save", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  const product = findProduct(Number(ctx.params["id"]));
  const cfg = parseConfig(product.config);
  const raw = (ctx.rawParams as Record<string, unknown>)["update_orders"];
  cfg["update_orders"] = normalizeBoolean(raw !== undefined ? raw : ctx.params["update_orders"], false);
  saveProductConfig(product, cfg);
  return true;
});
