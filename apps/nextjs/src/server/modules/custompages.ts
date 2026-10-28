import {
  deletePageRow,
  findPageById,
  findPageBySlug,
  insertPage,
  listPages,
  updatePageRow,
  type PageRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { paginate, slugify } from "../util";

/**
 * Custompages module — TS port of Custompages/Api/{Guest,Admin}.php.
 *
 * Module-activation note: FOSSBilling refuses these calls with error
 * 715 ("module custompages is not installed/activated") when the module
 * is not activated in System → Extensions. The reference install now
 * has it activated; the TS port serves the module proper — activation
 * state itself lives in the extension table and remains PHP-managed
 * during the strangler phase.
 */

function pageArray(row: PageRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    keywords: row.keywords,
    content: row.content,
    slug: row.slug,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolvePage(ctx: CallContext): Promise<PageRow> {
  const id = ctx.params["id"];
  const slug = ctx.params["slug"];
  if (!id && !slug) throw new FbError("Custom page ID or slug is missing");
  const row = slug ? await findPageBySlug(slug) : await findPageById(Number(id));
  if (!row) throw new FbError("Custom page not found");
  return row;
}

register("guest", "custompages", "get_list", async (ctx: CallContext) => {
  // This endpoint's PHP pager reports pages: 0 for an empty result
  // (paginateDoctrineQuery), unlike the clamped pagers elsewhere.
  const items = (await listPages()).map(pageArray);
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const total = items.length;
  return {
    pages: Math.ceil(total / perPage),
    page,
    per_page: perPage,
    total,
    list: items.slice((page - 1) * perPage, page * perPage),
  };
});

register("guest", "custompages", "get", async (ctx: CallContext) => {
  return pageArray(await resolvePage(ctx));
});

register("admin", "custompages", "get_list", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginate((await listPages()).map(pageArray), ctx.params);
});

register("admin", "custompages", "get_page", async (ctx: CallContext) => {
  requireAdmin(ctx);
  // PHP reads $data['page_id'] here (not id/slug) and returns null when
  // the page does not exist — no error envelope.
  const pageId = ctx.params["page_id"];
  const row = pageId ? await findPageById(Number(pageId)) : undefined;
  return row ? pageArray(row) : null;
});

register("admin", "custompages", "create", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const title = ctx.params["title"];
  if (!title) throw new FbError("Title was not passed");
  const content = ctx.params["content"];
  if (!content) throw new FbError("Content was not passed");
  // PHP generateUniqueSlug(): base slug, then base-1, base-2, ...
  const base = slugify(title);
  let slug = base;
  for (let i = 1; await findPageBySlug(slug); i++) slug = `${base}-${i}`;
  return await insertPage({
    title,
    slug,
    content,
    // PHP stores empty strings (not null) for omitted description/keywords.
    description: ctx.params["description"] ?? "",
    keywords: ctx.params["keywords"] ?? "",
  });
});

register("admin", "custompages", "update", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = Number(ctx.params["id"] ?? 0);
  const row = await findPageById(id);
  if (!row) throw new FbError("Custom page not found");
  await updatePageRow(id, {
    title: ctx.params["title"] ?? row.title,
    description: ctx.params["description"] ?? null,
    keywords: ctx.params["keywords"] ?? null,
    content: ctx.params["content"] ?? row.content,
    slug: ctx.params["slug"] ?? row.slug,
  });
  return true;
});

register("admin", "custompages", "batch_delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const ids = ctx.params["ids"];
  if (!ids) throw new FbError("Custom page IDs were not passed");
  for (const part of ids.split(",")) {
    const id = Number(part.trim());
    if (id) await deletePageRow(id);
  }
  return true;
});

register("admin", "custompages", "delete", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = Number(ctx.params["id"] ?? 0);
  const row = await findPageById(id);
  if (!row) throw new FbError("Custom page not found");
  await deletePageRow(id);
  return true;
});
