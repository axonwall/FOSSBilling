// Notification module — admin notification center. Rows live in
// extension_meta (extension 'mod_notification', meta_key 'message',
// rel_type 'staff', rel_id '1'); the API shape is ExtensionMeta's.

import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp } from "../db";
import { paginate } from "../util";

interface MetaRow {
  id: number; client_id: number | null; extension: string; rel_type: string;
  rel_id: string; meta_key: string; meta_value: string | null;
  created_at: string; updated_at: string;
}

function metaToApi(r: MetaRow) {
  return {
    id: r.id,
    client_id: r.client_id,
    extension: r.extension,
    rel_type: r.rel_type,
    rel_id: r.rel_id,
    meta_key: r.meta_key,
    meta_value: r.meta_value,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function baseRows(): Promise<MetaRow[]> {
  return await getDb().prepare(
    "SELECT * FROM extension_meta WHERE extension = 'mod_notification' AND meta_key = 'message'"
  ).all() as unknown as MetaRow[];
}

async function getOrThrow(id: number): Promise<MetaRow> {
  const row = await getDb().prepare(
    "SELECT * FROM extension_meta WHERE extension = 'mod_notification' AND meta_key = 'message' AND id = ?"
  ).get(id) as unknown as MetaRow | undefined;
  if (!row) throw new FbError("Notification message was not found");
  return row;
}

register("admin", "notification", "get_list", async (ctx) => {
  requireAdmin(ctx);
  let rows = await baseRows();
  const p = ctx.params;
  if (p.id) rows = rows.filter((r) => r.id === parseInt(p.id, 10));
  if (p.search) rows = rows.filter((r) => String(r.meta_value ?? "").toLowerCase().includes(p.search.toLowerCase()));
  if (p.date_from) rows = rows.filter((r) => r.created_at >= `${p.date_from} 00:00:00`);
  if (p.date_to) rows = rows.filter((r) => r.created_at <= `${p.date_to} 23:59:59`);
  const allowed: Record<string, string> = { id: "id", created_at: "created_at", updated_at: "updated_at" };
  const dir = (p.direction ?? "").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const cmp = (a: unknown, b: unknown): number => {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  rows = [...rows].sort((a, b) => {
    if (p.sort && allowed[p.sort]) {
      const key = allowed[p.sort];
      const c = cmp((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key]);
      if (c !== 0) return dir === "ASC" ? c : -c;
      return dir === "ASC" ? cmp(a.id, b.id) : -cmp(a.id, b.id);
    }
    return -cmp(a.id, b.id);
  });
  const pagerOut = paginate(rows.map(metaToApi), ctx.params);
  if (pagerOut.total === 0) pagerOut.pages = 0;
  return pagerOut;
});

register("admin", "notification", "get", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Notification ID was not passed");
  return metaToApi(await getOrThrow(parseInt(ctx.params.id, 10)));
});

register("admin", "notification", "add", async (ctx) => {
  requireAdmin(ctx);
  // PHP returns false (not an error) when no message was passed.
  if (ctx.params.message === undefined || ctx.params.message === null) return false;
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO extension_meta (client_id, extension, rel_type, rel_id, meta_key, meta_value, created_at, updated_at)
     VALUES (NULL, 'mod_notification', 'staff', '1', 'message', ?, ?, ?)`, ctx.params.message, now, now);
  return Number(info);
});

register("admin", "notification", "delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Notification ID was not passed");
  const row = await getOrThrow(parseInt(ctx.params.id, 10));
  await getDbWrite().prepare("DELETE FROM extension_meta WHERE id = ?").run(row.id);
  return true;
});

register("admin", "notification", "delete_all", async (ctx) => {
  requireAdmin(ctx);
  await getDbWrite().prepare("DELETE FROM extension_meta WHERE extension = 'mod_notification' AND meta_key = 'message'").run();
  return true;
});
