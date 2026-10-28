import {
  deleteExtensionMetaRow,
  findExtensionMetaById,
  insertExtensionMeta,
  listExtensionMetaByExtension,
  updateExtensionMetaRow,
} from "../db";
import { FbError, register, requireAdmin, requireParam, type CallContext } from "../dispatch";
import { phpInt } from "./formbuilder";

/**
 * Redirect module — TS port of Redirect/Api/Admin.php + Service.php.
 * Redirects live in extension_meta (extension 'mod_redirect',
 * meta_key = path, meta_value = target). Pinned by capture26.py.
 */

function toApiArray(row: { id: number; meta_key: string | null; meta_value: string | null }) {
  return { id: row.id, path: row.meta_key, target: row.meta_value };
}

function validatePath(path: string): string {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (p === "" || /[\r\n]/.test(p)) throw new FbError("Invalid redirect path.");
  if (p.includes("..")) throw new FbError("Redirect path must not contain path traversal sequences.");
  return p;
}

function validateTarget(target: string): string {
  const t = target.trim();
  if (t === "" || /[\r\n]/.test(t)) throw new FbError("Invalid redirect target.");
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(t);
  if (m && !["http", "https"].includes(t.slice(0, m[0].length - 1).toLowerCase())) {
    throw new FbError("Only HTTP and HTTPS redirect targets are allowed.");
  }
  return t;
}

async function getRedirect(id: number) {
  const row = await findExtensionMetaById("mod_redirect", id);
  if (!row) throw new FbError("Redirect not found");
  return row;
}

register("admin", "redirect", "get_list", async (ctx) => {
  requireAdmin(ctx);
  return (await listExtensionMetaByExtension("mod_redirect")).map(toApiArray);
});

register("admin", "redirect", "get", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Redirect ID was not passed");
  return toApiArray(await getRedirect(phpInt(id)));
});

register("admin", "redirect", "create", async (ctx) => {
  requireAdmin(ctx);
  const path = requireParam(ctx.params, "path", "Redirect path was not passed");
  const target = requireParam(ctx.params, "target", "Redirect target was not passed");
  return await insertExtensionMeta("mod_redirect", validatePath(path), validateTarget(target));
});

register("admin", "redirect", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Redirect ID was not passed");
  const row = await getRedirect(phpInt(id));
  // Only provided fields change; no change means no UPDATE (so
  // updated_at is untouched, mirroring Doctrine's no-op flush).
  const path = ctx.params["path"];
  const target = ctx.params["target"];
  if (path === undefined && target === undefined) return true;
  const newKey = path !== undefined ? validatePath(path) : (row.meta_key ?? "");
  const newVal = target !== undefined ? validateTarget(target) : (row.meta_value ?? "");
  // Doctrine skips the UPDATE when nothing changed, leaving
  // updated_at untouched; mirror that instead of bumping it.
  if (newKey === row.meta_key && newVal === row.meta_value) return true;
  await updateExtensionMetaRow(row.id, newKey, newVal);
  return true;
});

register("admin", "redirect", "delete", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Redirect ID was not passed");
  const row = await getRedirect(phpInt(id));
  await deleteExtensionMetaRow(row.id);
  return true;
});
