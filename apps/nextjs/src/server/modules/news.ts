import {
  deletePostRow,
  findAdminById,
  findPostById,
  findPostBySlug,
  insertPost,
  listPosts,
  updatePostRow,
  type PostRow,
} from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { paginate, slugify } from "../util";

/**
 * News module — TS port of News/Api/{Guest,Admin}.php.
 * Post::toApiArray semantics: content has <!--more--> stripped and
 * excerpt is the part before <!--more--> (null when absent); author is
 * the author's {name} summary or [] when the post has no admin author.
 * Guest reads only see active posts. Update auto-generates an empty
 * description from content the way the PHP service does (tag-stripped
 * truncation) — the parity corpus covers the title-only path.
 */

function postArray(row: PostRow, withAuthor = false) {
  const raw = row.content ?? "";
  const moreAt = raw.indexOf("<!--more-->");
  const excerpt = moreAt >= 0 ? raw.slice(0, moreAt) : null;
  // PHP populates the author summary only on single-get paths; list
  // responses always carry author: [] (the pager never sets adminData).
  const author =
    withAuthor && row.admin_id ? { name: findAdminById(row.admin_id)?.name ?? null } : [];
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    content: raw.replaceAll("<!--more-->", ""),
    status: row.status,
    slug: row.slug,
    image: row.image,
    section: row.section,
    publish_at: row.publish_at,
    published_at: row.published_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author,
    excerpt,
  };
}

function generateDescription(content: string | null): string | null {
  if (!content) return null;
  const text = content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 160)}...` : text || null;
}

register("guest", "news", "get_list", (ctx: CallContext) => {
  return paginate(listPosts(true).map((r) => postArray(r)), ctx.params);
});

register("guest", "news", "get", (ctx: CallContext) => {
  const id = ctx.params["id"];
  const slug = ctx.params["slug"];
  if (!id && !slug) throw new FbError("ID or slug is required.");
  const row = id ? findPostById(Number(id)) : findPostBySlug(slug!);
  if (!row || row.status !== "active") throw new FbError("News item not found.");
  return postArray(row, true);
});

register("admin", "news", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  return paginate(listPosts(false).map((r) => postArray(r)), ctx.params);
});

register("admin", "news", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  const slug = ctx.params["slug"];
  if (!id && !slug) throw new FbError("ID or slug is required.");
  const row = id ? findPostById(Number(id)) : findPostBySlug(slug!);
  if (!row) throw new FbError("News item not found.");
  return postArray(row, true);
});

register("admin", "news", "create", (ctx: CallContext) => {
  requireAdmin(ctx);
  const title = ctx.params["title"];
  if (!title) throw new FbError("Post title was not passed");
  return insertPost({
    admin_id: ctx.session!.admin!.id,
    title,
    slug: slugify(title),
    content: ctx.params["content"] ?? null,
    status: ctx.params["status"] ?? "active",
    description: ctx.params["description"] ?? null,
  });
});

register("admin", "news", "update", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = Number(ctx.params["id"] ?? 0);
  const row = findPostById(id);
  if (!row) throw new FbError("News item not found");
  let description: string | null = ctx.params["description"] ?? row.description;
  if (!description) {
    description = generateDescription(ctx.params["content"] ?? row.content);
  }
  updatePostRow(id, {
    title: ctx.params["title"] ?? row.title,
    description,
    content: ctx.params["content"] ?? row.content,
    status: ctx.params["status"] ?? row.status,
  });
  return true;
});

register("admin", "news", "batch_delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const ids = ctx.params["ids"];
  if (!ids) throw new FbError("IDs were not passed");
  for (const part of ids.split(",")) {
    const id = Number(part.trim());
    if (id) deletePostRow(id);
  }
  return true;
});

register("admin", "news", "delete", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = Number(ctx.params["id"] ?? 0);
  const row = findPostById(id);
  if (!row) throw new FbError("News item not found");
  deletePostRow(id);
  return true;
});
