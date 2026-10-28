// Servicedownloadable — downloadable product file management.
//
// Phase 5 R1 decisions batch (D3): the five binary endpoints are now
// TS-served via the seam's multipart + Response support — `upload`
// and `update` take multipart file_data, the three `send_*` endpoints
// return binary file bytes with PHP's BinaryFileResponse headers.
// The JSON endpoints (file_update, file_delete, order_file_delete,
// config_save) were ported in the D7 batch.

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
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
  status: string | null;
  expires_at: string | null;
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

async function findProduct(id: number): Promise<ProductRow> {
  const row = await getDb().prepare("SELECT id, config FROM product WHERE id = ?").get(id) as unknown as
    | ProductRow
    | undefined;
  if (!row) throw new FbError("Product not found");
  return row;
}

async function findOrder(id: number): Promise<OrderRow> {
  const row = await getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as
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

async function saveProductConfig(product: ProductRow, cfg: Record<string, unknown>): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE product SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cfg), nowTimestamp(), product.id);
}

async function saveOrderConfig(order: OrderRow, cfg: Record<string, unknown>): Promise<void> {
  await getDbWrite()
    .prepare("UPDATE client_order SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cfg), nowTimestamp(), order.id);
}

async function serviceFiles(serviceId: number): Promise<ServiceFileRow[]> {
  return await getDb()
    .prepare("SELECT * FROM service_downloadable_file WHERE service_downloadable_id = ? ORDER BY sort_order ASC")
    .all(serviceId) as unknown as ServiceFileRow[];
}

async function ordersForProduct(productId: number): Promise<OrderRow[]> {
  return await getDb().prepare("SELECT * FROM client_order WHERE product_id = ? ORDER BY id ASC").all(productId) as unknown as OrderRow[];
}

async function downloadableServiceFor(order: OrderRow): Promise<number | null> {
  if (order.service_id === null || order.service_type !== "downloadable") return null;
  const row = await getDb().prepare("SELECT id FROM service_downloadable WHERE id = ?").get(order.service_id) as unknown as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

function uploadsDir(): string | null {
  const dbPath = process.env.FB_DATABASE_PATH;
  if (!dbPath) return null;
  return join(dirname(dbPath), "uploads");
}

async function isStoredFilenameReferenced(stored: string): Promise<boolean> {
  const inFiles = await getDb()
    .prepare("SELECT COUNT(*) AS c FROM service_downloadable_file WHERE stored_filename = ?")
    .get(stored) as unknown as { c: number };
  if (inFiles.c > 0) return true;
  const inProducts = await getDb()
    .prepare("SELECT COUNT(*) AS c FROM product WHERE config LIKE ?")
    .get(`%${stored}%`) as unknown as { c: number };
  return inProducts.c > 0;
}

async function removeStoredFileIfOrphaned(stored: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(stored)) return;
  if (await isStoredFilenameReferenced(stored)) return;
  const dir = uploadsDir();
  if (!dir) return;
  const p = join(dir, stored);
  if (existsSync(p)) unlinkSync(p);
}

// --- Phase 5 R1 decisions batch (D3): binary endpoints. ---

const ALLOWED_EXTENSIONS = [
  "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "txt", "csv", "xml", "json", "yml", "yaml", "sql",
  "png", "jpg", "jpeg", "gif", "svg", "webp",
  "mp3", "wav", "ogg", "mp4", "m4v", "mov", "avi", "mkv", "webm",
  "exe", "msi", "dmg", "pkg", "deb", "rpm", "apk", "ipa",
  "jar", "war", "ear", "iso", "bin", "img",
];

/** PHP pathinfo(..., PATHINFO_EXTENSION): no dot or a leading dot only -> ''. */
function clientExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return "";
  return filename.slice(idx + 1).toLowerCase();
}

function validateUploadExtension(filename: string): void {
  const ext = clientExtension(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new FbError(
      `File extension ${ext} is not allowed. Allowed extensions: ${ALLOWED_EXTENSIONS.join(", ")}`,
    );
  }
}

function validateDisplayFilename(filename: unknown): string {
  if (typeof filename !== "string" || filename === "" || filename.length > 255) {
    throw new FbError("Downloadable filename is invalid");
  }
  return filename;
}

function normalizeLabel(v: unknown): string | null {
  const t = optionalText(v);
  if (t !== null && t.length > 255) throw new FbError("File label cannot exceed 255 characters");
  return t;
}

function normalizeDescription(v: unknown): string | null {
  const t = optionalText(v);
  if (t !== null && t.length > 1000) {
    throw new FbError("File description cannot exceed 1000 characters");
  }
  return t;
}

/** Service::createUploadedFileDefinition + storeUploadedFile: validate
 * everything first (PHP validates before moving the file), then store
 * under a fresh 64-hex name that does not already exist on disk. */
function createUploadedFileDefinition(
  file: { name: string; bytes: Buffer },
  params: Record<string, string>,
): FileDef {
  validateUploadExtension(file.name);
  const filename = validateDisplayFilename(file.name);
  const label = normalizeLabel(params["label"]);
  const description = normalizeDescription(params["description"]);
  const dir = uploadsDir();
  if (!dir) throw new FbError("File cannot be downloaded at the moment. Please contact support.", 404);
  let stored = "";
  do {
    stored = randomBytes(32).toString("hex");
  } while (existsSync(join(dir, stored)));
  writeFileSync(join(dir, stored), file.bytes);
  return {
    id: randomBytes(16).toString("hex"),
    filename,
    stored_filename: stored,
    label,
    description,
  };
}

async function insertServiceFile(svcId: number, def: FileDef, sortOrder: number): Promise<void> {
  await getDbWrite()
    .prepare(
      "INSERT INTO service_downloadable_file (label, description, downloads, sort_order, file_key, filename, stored_filename, created_at, updated_at, service_downloadable_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      def.label, def.description, sortOrder, def.id, def.filename, def.stored_filename,
      nowTimestamp(), nowTimestamp(), svcId,
    );
}

/** Symfony BinaryFileResponse disposition for an attachment: token-safe
 * names stay unquoted; anything else is quoted with a utf-8 fallback
 * (the parity corpus uses plain ASCII names, so the first form is the
 * verified one). */
function attachmentDisposition(displayName: string): string {
  if (/^[A-Za-z0-9!#$&^_.+-]+$/.test(displayName)) {
    return `attachment; filename=${displayName}`;
  }
  const fallback = displayName.replace(/[^A-Za-z0-9!#$&^_.+-]/g, "_") || "file";
  return `attachment; filename="${fallback}"; filename*=utf-8''${encodeURIComponent(displayName).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))}`;
}

/** Service::sendFile / sendProductFile shared response: missing disk
 * file -> the 404 message; countDownload=true (client path) bumps the
 * downloads counter, false (admin order path) leaves it alone. */
async function sendStoredFile(
  storedFilename: string,
  displayName: string,
  countDownload: boolean,
  serviceFileId: number | null,
): Promise<Response> {
  const dir = uploadsDir();
  const p = dir ? join(dir, storedFilename) : "";
  if (!dir || !existsSync(p)) {
    throw new FbError("File cannot be downloaded at the moment. Please contact support.", 404);
  }
  if (countDownload && serviceFileId !== null) {
    await getDbWrite()
      .prepare("UPDATE service_downloadable_file SET downloads = downloads + 1 WHERE id = ?")
      .run(serviceFileId);
  }
  const buf = readFileSync(p);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": attachmentDisposition(displayName),
      "cache-control": "public",
      "last-modified": statSync(p).mtime.toUTCString(),
      "content-length": String(buf.length),
      "accept-ranges": "none",
    },
  });
}

register("admin", "servicedownloadable", "upload", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  const product = await findProduct(Number(ctx.params["id"]));
  // Api::upload checks file presence itself ('File was not uploaded.'),
  // unlike the service-level message used by update().
  const file = ctx.files?.["file_data"];
  if (!file) throw new FbError("File was not uploaded.");
  const definition = createUploadedFileDefinition(file, ctx.params);
  const cfg = parseConfig(product.config);
  const files = productFiles(product);
  files.push(definition);
  cfg["files"] = files;
  await saveProductConfig(product, cfg);
  if (normalizeBoolean(cfg["update_orders"] ?? false)) {
    for (const order of await ordersForProduct(product.id)) {
      const orderCfg = parseConfig(order.config);
      const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
      ofiles.push(definition);
      orderCfg["files"] = ofiles;
      await saveOrderConfig(order, orderCfg);
      const svcId = await downloadableServiceFor(order);
      if (svcId !== null) {
        await insertServiceFile(svcId, definition, (await serviceFiles(svcId)).length);
      }
    }
  }
  return true;
});

register("admin", "servicedownloadable", "update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["order_id"]) throw new FbError("Order ID (order_id) was not passed");
  const order = await findOrder(Number(ctx.params["order_id"]));
  const svcId = await downloadableServiceFor(order);
  if (svcId === null) throw new FbError("Order is not activated");
  const file = ctx.files?.["file_data"];
  if (!file) throw new FbError("File upload failed: no files in request.");
  const definition = createUploadedFileDefinition(file, ctx.params);
  await insertServiceFile(svcId, definition, (await serviceFiles(svcId)).length);
  const orderCfg = parseConfig(order.config);
  const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
  ofiles.push(definition);
  orderCfg["files"] = ofiles;
  await saveOrderConfig(order, orderCfg);
  return true;
});

register("admin", "servicedownloadable", "send_file", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const product = await findProduct(Number(ctx.params["id"]));
  const key = validateFileKey(ctx.params["file_id"]);
  const files = productFiles(product);
  const idx = findDefIndex(files, key);
  return await sendStoredFile(files[idx].stored_filename, files[idx].filename, false, null);
});

register("admin", "servicedownloadable", "send_order_file", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["order_id"]) throw new FbError("Order ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const order = await findOrder(Number(ctx.params["order_id"]));
  const svcId = await downloadableServiceFor(order);
  if (svcId === null) throw new FbError("Order is not activated");
  const fileId = Number(ctx.params["file_id"]);
  const row = (await serviceFiles(svcId)).find((f) => f.id === fileId);
  if (!row) throw new FbError("File not found");
  return await sendStoredFile(row.stored_filename, row.filename, false, null);
});

register("client", "servicedownloadable", "send_file", async (ctx) => {
  requireClient(ctx);
  // Api::send_file: RequiredParams plus the explicit empty() check on
  // order_id (so "0" is also 'required'); file_id "0" passes the
  // RequiredParams numeric check and falls through to the lookup.
  const orderIdRaw = ctx.params["order_id"];
  if (!orderIdRaw || orderIdRaw === "0") throw new FbError("Order ID is required");
  if (!ctx.params["file_id"]) throw new FbError("File ID is required");
  const order = await getDb()
    .prepare("SELECT * FROM client_order WHERE id = ? AND client_id = ?")
    .get(Number(orderIdRaw), ctx.session!.client!.id) as unknown as OrderRow | undefined;
  if (!order) throw new FbError("Order not found");
  if (
    order.expires_at !== null &&
    order.expires_at !== undefined &&
    new Date(String(order.expires_at).replace(" ", "T") + "Z").getTime() <= Date.now()
  ) {
    throw new FbError("Subscription expired");
  }
  const svcId = await downloadableServiceFor(order);
  if (svcId === null || order.status !== "active") throw new FbError("Order is not activated");
  const fileId = Number(ctx.params["file_id"]);
  const row = (await serviceFiles(svcId)).find((f) => f.id === fileId);
  if (!row) throw new FbError("File not found");
  return await sendStoredFile(row.stored_filename, row.filename, true, row.id);
});

register("admin", "servicedownloadable", "file_update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const product = await findProduct(Number(ctx.params["id"]));
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
  await saveProductConfig(product, cfg);
  if (normalizeBoolean(cfg["update_orders"] ?? false)) {
    for (const order of await ordersForProduct(product.id)) {
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
        await saveOrderConfig(order, orderCfg);
      } else {
        // PHP still rewrites the order config even when nothing matched.
        await saveOrderConfig(order, orderCfg);
      }
      const svcId = await downloadableServiceFor(order);
      if (svcId !== null) {
        const row = (await serviceFiles(svcId)).find((f) => f.file_key === key);
        if (row) {
          await getDbWrite()
            .prepare("UPDATE service_downloadable_file SET label = ?, description = ? WHERE id = ?")
            .run(label, description, row.id);
        }
      }
    }
  }
  return true;
});

register("admin", "servicedownloadable", "file_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const product = await findProduct(Number(ctx.params["id"]));
  const key = validateFileKey(ctx.params["file_id"]);
  const cfg = parseConfig(product.config);
  const files = productFiles(product);
  const idx = findDefIndex(files, key);
  const stored = files[idx].stored_filename;
  files.splice(idx, 1);
  cfg["files"] = files;
  await saveProductConfig(product, cfg);
  if (normalizeBoolean(cfg["update_orders"] ?? false)) {
    for (const order of await ordersForProduct(product.id)) {
      const orderCfg = parseConfig(order.config);
      const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
      orderCfg["files"] = ofiles.filter((f) => f.id !== key);
      await saveOrderConfig(order, orderCfg);
      const svcId = await downloadableServiceFor(order);
      if (svcId !== null) {
        const row = (await serviceFiles(svcId)).find((f) => f.file_key === key);
        if (row) {
          await getDbWrite().prepare("DELETE FROM service_downloadable_file WHERE id = ?").run(row.id);
        }
      }
    }
  }
  await removeStoredFileIfOrphaned(stored);
  return true;
});

register("admin", "servicedownloadable", "order_file_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["order_id"]) throw new FbError("Order ID was not passed");
  if (!ctx.params["file_id"]) throw new FbError("File ID was not passed");
  const order = await findOrder(Number(ctx.params["order_id"]));
  const svcId = await downloadableServiceFor(order);
  if (svcId === null) throw new FbError("Order is not activated");
  const fileId = Number(ctx.params["file_id"]);
  const row = (await serviceFiles(svcId)).find((f) => f.id === fileId);
  if (!row) throw new FbError("File not found");
  const stored = row.stored_filename;
  const key = row.file_key;
  await getDbWrite().prepare("DELETE FROM service_downloadable_file WHERE id = ?").run(row.id);
  const orderCfg = parseConfig(order.config);
  const ofiles = Array.isArray(orderCfg["files"]) ? (orderCfg["files"] as FileDef[]) : [];
  orderCfg["files"] = ofiles.filter((f) => f.id !== key);
  await saveOrderConfig(order, orderCfg);
  await removeStoredFileIfOrphaned(stored);
  return true;
});

register("admin", "servicedownloadable", "config_save", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Product ID was not passed");
  const product = await findProduct(Number(ctx.params["id"]));
  const cfg = parseConfig(product.config);
  const raw = (ctx.rawParams as Record<string, unknown>)["update_orders"];
  cfg["update_orders"] = normalizeBoolean(raw !== undefined ? raw : ctx.params["update_orders"], false);
  await saveProductConfig(product, cfg);
  return true;
});
