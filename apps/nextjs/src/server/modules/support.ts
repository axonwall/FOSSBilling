// Support module — tickets, helpdesks, canned replies, notes and
// knowledge base (Phase 4 batch 4). Parity oracle: capture16.py.
// The Extension admin API is NOT ported here except config_get
// (see extension.ts): list/navigation/languages need module
// manifests and translation catalogs, and activate/install/
// uninstall/config_save execute PHP module code — those stay on
// the PHP proxy by design.

import { randomBytes } from "node:crypto";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp, findClientById } from "../db";
import { checkGuestTicketAntispam } from "./antispam";
import { clientAdminArray } from "./client";

export interface TicketRow {
  id: number; client_id: number | null; access_hash: string | null;
  author_name: string | null; author_email: string | null;
  priority: number | null; subject: string; status: string;
  rel_type: string | null; rel_id: number | null; rel_task: string | null;
  rel_new_value: string | null; rel_status: string | null;
  created_at: string; updated_at: string; support_helpdesk_id: number | null;
}

interface MessageRow {
  id: number; client_id: number | null; admin_id: number | null;
  content: string; attachment: string | null; ip: string | null;
  created_at: string; updated_at: string; support_ticket_id: number;
}

interface HelpdeskRow {
  id: number; name: string; email: string; can_reopen: number;
  close_after: number; signature: string | null;
  created_at: string; updated_at: string;
}

function paginateLocal<T>(items: T[], params: Record<string, string>) {
  const page = Math.max(1, parseInt(params["page"] ?? "1", 10) || 1);
  const perPage = Math.max(1, parseInt(params["per_page"] ?? "100", 10) || 100);
  const total = items.length;
  const pages = total === 0 ? 0 : Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { pages, page, per_page: perPage, total, list: items.slice(start, start + perPage) };
}

async function findTicket(id: number): Promise<TicketRow | undefined> {
  return await getDb().prepare("SELECT * FROM support_ticket WHERE id = ?").get(id) as TicketRow | undefined;
}

async function findTicketByHash(hash: string): Promise<TicketRow | undefined> {
  return await getDb().prepare("SELECT * FROM support_ticket WHERE access_hash = ?").get(hash) as TicketRow | undefined;
}

async function ticketOrThrow(id: number): Promise<TicketRow> {
  const t = await findTicket(id);
  if (!t) throw new FbError("Ticket not found");
  return t;
}

async function findHelpdesk(id: number): Promise<HelpdeskRow | undefined> {
  return await getDb().prepare("SELECT * FROM support_helpdesk WHERE id = ?").get(id) as HelpdeskRow | undefined;
}

function helpdeskArray(h: HelpdeskRow) {
  return {
    id: h.id, name: h.name, email: h.email,
    can_reopen: h.can_reopen === 1, close_after: h.close_after,
    signature: h.signature, created_at: h.created_at, updated_at: h.updated_at,
  };
}

async function messagesOf(ticketId: number): Promise<MessageRow[]> {
  return await getDb().prepare("SELECT * FROM support_ticket_message WHERE support_ticket_id = ? ORDER BY id ASC").all(ticketId) as unknown as MessageRow[];
}

async function authorForMessage(m: MessageRow, admin: boolean): Promise<Record<string, unknown>> {
  if (m.admin_id) {
    const a = await getDb().prepare("SELECT id, name, email FROM admin WHERE id = ?").get(m.admin_id) as { id: number; name: string; email: string } | undefined;
    const out: Record<string, unknown> = { name: a?.name ?? null, role: "admin" };
    if (admin) out.email = a?.email ?? null;
    return out;
  }
  if (m.client_id) {
    const c = await findClientById(m.client_id);
    const out: Record<string, unknown> = { name: c ? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() : null, role: "client" };
    if (admin) out.email = c?.email ?? null;
    return out;
  }
  const t = await findTicket(m.support_ticket_id);
  if (t && !t.client_id) {
    const out: Record<string, unknown> = { name: t.author_name, email: t.author_email, role: "guest" };
    if (!admin) delete out.email;
    return out;
  }
  return {};
}

async function messageArray(m: MessageRow, admin: boolean): Promise<Record<string, unknown>> {
  const author = await authorForMessage(m, admin);
  if (admin) {
    return {
      id: m.id, support_ticket_id: m.support_ticket_id, client_id: m.client_id, admin_id: m.admin_id,
      content: m.content, attachment: m.attachment, ip: m.ip,
      created_at: m.created_at, updated_at: m.updated_at, author,
    };
  }
  return {
    id: m.id, content: m.content, attachment: m.attachment,
    created_at: m.created_at, updated_at: m.updated_at, author,
  };
}

async function ticketAuthor(t: TicketRow, admin: boolean): Promise<Record<string, unknown>> {
  if (!t.client_id) {
    const out: Record<string, unknown> = { name: t.author_name, role: "guest" };
    if (admin) out.email = t.author_email;
    return out;
  }
  const c = await findClientById(t.client_id);
  if (!c) return {};
  return {
    id: c.id, name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
    first_name: c.first_name, last_name: c.last_name, email: c.email, role: "client",
  };
}

async function ticketClient(t: TicketRow, admin: boolean): Promise<Record<string, unknown>> {
  if (!t.client_id) return {};
  const c = await findClientById(t.client_id);
  if (!c) return {};
  if (admin) return await clientAdminArray(c);
  return { id: c.id, first_name: c.first_name, last_name: c.last_name };
}

export async function ticketArray(t: TicketRow, admin: boolean, deep: boolean): Promise<Record<string, unknown>> {
  const msgs = await messagesOf(t.id);
  const helpdesk = t.support_helpdesk_id ? await findHelpdesk(t.support_helpdesk_id) : undefined;
  const out: Record<string, unknown> = admin
    ? {
        id: t.id, support_helpdesk_id: t.support_helpdesk_id, client_id: t.client_id,
        access_hash: t.access_hash, author_name: t.author_name, author_email: t.author_email,
        priority: t.priority, subject: t.subject, status: t.status,
        rel_type: t.rel_type, rel_id: t.rel_id, rel_task: t.rel_task,
        rel_new_value: t.rel_new_value, rel_status: t.rel_status,
        created_at: t.created_at, updated_at: t.updated_at,
      }
    : {
        id: t.id, author_name: t.author_name, author_email: t.author_email,
        subject: t.subject, status: t.status,
        created_at: t.created_at, updated_at: t.updated_at,
      };
  out.replies = msgs.length;
  out.first = msgs.length ? await messageArray(msgs[0], admin) : null;
  out.helpdesk = helpdesk ? { id: helpdesk.id, name: helpdesk.name, can_reopen: helpdesk.can_reopen === 1 } : null;
  out.author = await ticketAuthor(t, admin);
  out.client = await ticketClient(t, admin);
  if (deep) out.messages = await Promise.all(msgs.map(async (m) => await messageArray(m, admin)));
  if (admin) {
    out.rel = {
      id: t.rel_id ?? null, type: t.rel_type ?? null, task: t.rel_task ?? null,
      new_value: t.rel_new_value ?? null, status: t.rel_status ?? null,
    };
    out.priority = t.priority;
    out.notes = await Promise.all((await getDb().prepare("SELECT * FROM support_ticket_note WHERE support_ticket_id = ? ORDER BY id ASC").all(t.id)).map(async (n) => {
      const note = n as { id: number; support_ticket_id: number; admin_id: number | null; note: string; created_at: string; updated_at: string };
      const a = note.admin_id ? await getDb().prepare("SELECT name, email FROM admin WHERE id = ?").get(note.admin_id) as { name: string; email: string } | undefined : undefined;
      return {
        id: note.id, support_ticket_id: note.support_ticket_id, admin_id: note.admin_id,
        note: note.note, created_at: note.created_at, updated_at: note.updated_at,
        author: a ? { name: a.name, email: a.email, role: "admin" } : {},
      };
    }));
  }
  if (!admin && t.access_hash) out.hash = t.access_hash;
  return out;
}

async function insertMessage(ticketId: number, content: string, clientId: number | null, adminId: number | null, ip: string | null): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_ticket_message (client_id, admin_id, content, attachment, ip, created_at, updated_at, support_ticket_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)", clientId, adminId, content, ip, now, now, ticketId);
  return Number(info);
}

async function touchTicket(id: number, status: string): Promise<void> {
  await getDbWrite().prepare("UPDATE support_ticket SET status = ?, updated_at = ? WHERE id = ?").run(status, nowTimestamp(), id);
}

async function createTicketRow(fields: {
  clientId: number | null; helpdeskId: number; subject: string;
  authorName: string | null; authorEmail: string | null; accessHash: string | null;
  relType: string | null; relId: number | null; relTask: string | null; relNewValue: string | null;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO support_ticket (client_id, access_hash, author_name, author_email, priority, subject, status, rel_type, rel_id, rel_task, rel_new_value, rel_status, created_at, updated_at, support_helpdesk_id)
     VALUES (?, ?, ?, ?, 100, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`, fields.clientId, fields.accessHash, fields.authorName, fields.authorEmail, fields.subject, fields.relType, fields.relId, fields.relTask, fields.relNewValue, fields.relTask ? "pending" : "complete", now, now, fields.helpdeskId);
  return Number(info);
}

function validateTicketCreate(data: Record<string, string | undefined>, guest: boolean): void {
  if (guest && !data["name"]) throw new FbError("Please enter your name");
  if (!data["subject"]) throw new FbError("Ticket subject required");
  const content = data["content"] ?? "";
  if (guest && content.length < 4) throw new FbError("Please enter your message");
  if (!content) throw new FbError("Ticket content required");
}

function relFields(data: Record<string, string | undefined>): {
  relType: string | null; relId: number | null; relTask: string | null; relNewValue: string | null;
} {
  let relId: number | null = null;
  if (data["rel_id"] !== undefined) {
    if (!/^-?\d+$/.test(data["rel_id"])) throw new FbError(`rel_id must be a valid integer, received: ${data["rel_id"]}`);
    relId = parseInt(data["rel_id"], 10);
  }
  return {
    relType: data["rel_type"] ?? null, relId,
    relTask: data["rel_task"] ?? null, relNewValue: data["rel_new_value"] ?? null,
  };
}

async function listTicketsFiltered(params: Record<string, string>, clientId: number | null): Promise<TicketRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (clientId !== null) { where.push("client_id = ?"); args.push(clientId); }
  if (params["status"]) { where.push("status = ?"); args.push(params["status"]); }
  if (params["client_id"]) { where.push("client_id = ?"); args.push(parseInt(params["client_id"], 10)); }
  if (params["subject"]) { where.push("subject LIKE ?"); args.push(`%${params["subject"]}%`); }
  const sql = `SELECT * FROM support_ticket ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
  return await getDb().prepare(sql).all(...args) as unknown as TicketRow[];
}

// ---------------------------------------------------------------- tickets

register("admin", "support", "ticket_get_list", async (ctx) => {
  requireAdmin(ctx);
  return paginateLocal(await Promise.all((await listTicketsFiltered(ctx.params, null)).map(async (t) => await ticketArray(t, true, false))), ctx.params);
});

register("admin", "support", "ticket_get", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID is missing");
  return await ticketArray(await ticketOrThrow(parseInt(ctx.params["id"], 10)), true, true);
});

register("admin", "support", "ticket_update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID is missing");
  const t = await ticketOrThrow(parseInt(ctx.params["id"], 10));
  const db = getDbWrite();
  if (ctx.params["support_helpdesk_id"] !== undefined) {
    const hd = await findHelpdesk(parseInt(ctx.params["support_helpdesk_id"], 10));
    if (hd) await db.prepare("UPDATE support_ticket SET support_helpdesk_id = ? WHERE id = ?").run(hd.id, t.id);
  }
  if (ctx.params["status"] !== undefined) await db.prepare("UPDATE support_ticket SET status = ? WHERE id = ?").run(ctx.params["status"], t.id);
  if (ctx.params["subject"] !== undefined) await db.prepare("UPDATE support_ticket SET subject = ? WHERE id = ?").run(ctx.params["subject"], t.id);
  if (ctx.params["priority"] !== undefined) await db.prepare("UPDATE support_ticket SET priority = ? WHERE id = ?").run(parseInt(ctx.params["priority"], 10), t.id);
  await db.prepare("UPDATE support_ticket SET updated_at = ? WHERE id = ?").run(nowTimestamp(), t.id);
  return true;
});

register("admin", "support", "ticket_message_update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket message ID is missing");
  if (!ctx.params["content"]) throw new FbError("Ticket message content is missing");
  const m = await getDb().prepare("SELECT * FROM support_ticket_message WHERE id = ?").get(parseInt(ctx.params["id"], 10)) as MessageRow | undefined;
  if (!m) throw new FbError("Ticket message not found");
  if (m.admin_id === null) throw new FbError("Only admin replies can be edited");
  if (m.content === ctx.params["content"]) return true;
  const now = nowTimestamp();
  await getDbWrite().prepare("INSERT INTO support_ticket_message_history (admin_id, content, created_at, updated_at, support_ticket_message_id) VALUES (?, ?, ?, ?, ?)").run(ctx.session!.admin!.id, m.content, now, now, m.id);
  await getDbWrite().prepare("UPDATE support_ticket_message SET content = ?, updated_at = ? WHERE id = ?").run(ctx.params["content"], now, m.id);
  return true;
});

register("admin", "support", "ticket_message_history_get_list", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket message ID is missing");
  const m = await getDb().prepare("SELECT * FROM support_ticket_message WHERE id = ?").get(parseInt(ctx.params["id"], 10)) as MessageRow | undefined;
  if (!m) throw new FbError("Ticket message not found");
  // PHP returns a bare list here (no pager), each row with a
  // Markdown-rendered content_html. The TS side has no Markdown
  // renderer, so content_html is omitted (documented gap) rather
  // than fabricated.
  const rows = await getDb().prepare("SELECT * FROM support_ticket_message_history WHERE support_ticket_message_id = ? ORDER BY id DESC").all(m.id) as unknown as { id: number; admin_id: number; content: string; created_at: string; updated_at: string; support_ticket_message_id: number }[];
  return rows.map((h) => ({
    id: h.id, admin_id: h.admin_id, content: h.content,
    created_at: h.created_at, updated_at: h.updated_at, support_ticket_message_id: h.support_ticket_message_id,
  }));
});

register("admin", "support", "ticket_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID is missing");
  const t = await ticketOrThrow(parseInt(ctx.params["id"], 10));
  const db = getDbWrite();
  await db.prepare("DELETE FROM support_ticket_message WHERE support_ticket_id = ?").run(t.id);
  await db.prepare("DELETE FROM support_ticket_note WHERE support_ticket_id = ?").run(t.id);
  await db.prepare("DELETE FROM support_ticket WHERE id = ?").run(t.id);
  return true;
});

register("admin", "support", "batch_delete", async (ctx) => {
  requireAdmin(ctx);
  const ids = ctx.rawParams["ids"];
  if (!Array.isArray(ids)) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const t = await findTicket(Number(id));
    if (!t) continue;
    const db = getDbWrite();
    await db.prepare("DELETE FROM support_ticket_message WHERE support_ticket_id = ?").run(t.id);
    await db.prepare("DELETE FROM support_ticket_note WHERE support_ticket_id = ?").run(t.id);
    await db.prepare("DELETE FROM support_ticket WHERE id = ?").run(t.id);
  }
  return true;
});

register("admin", "support", "ticket_reply", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID is missing");
  if (!ctx.params["content"]) throw new FbError("Ticket message content is missing");
  const t = await ticketOrThrow(parseInt(ctx.params["id"], 10));
  const msgId = await insertMessage(t.id, ctx.params["content"], null, ctx.session!.admin!.id, ctx.ip);
  await touchTicket(t.id, "on_hold");
  return msgId;
});

register("admin", "support", "ticket_close", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID is missing");
  const t = await ticketOrThrow(parseInt(ctx.params["id"], 10));
  if (t.status === "closed") return true;
  await touchTicket(t.id, "closed");
  return true;
});

register("admin", "support", "ticket_create", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["client_id"]) throw new FbError("Client ID is missing");
  if (!ctx.params["content"]) throw new FbError("Ticket content required");
  if (!ctx.params["subject"]) throw new FbError("Ticket subject required");
  if (!ctx.params["support_helpdesk_id"]) throw new FbError("Ticket support_helpdesk_id is required");
  const hd = await findHelpdesk(parseInt(ctx.params["support_helpdesk_id"], 10));
  if (!hd) throw new FbError("Helpdesk invalid");
  const client = await findClientById(parseInt(ctx.params["client_id"], 10));
  if (!client) throw new FbError("Client not found");
  const rel = relFields(ctx.params);
  const tid = await createTicketRow({
    clientId: client.id, helpdeskId: hd.id, subject: ctx.params["subject"],
    authorName: null, authorEmail: null, accessHash: null,
    relType: rel.relType, relId: rel.relId, relTask: rel.relTask, relNewValue: rel.relNewValue,
  });
  await insertMessage(tid, ctx.params["content"], null, ctx.session!.admin!.id, ctx.ip);
  return tid;
});

/**
 * Support\Api\Admin::batch_ticket_auto_close (unchanged in R5f):
 * on_hold tickets with updated_at + close_after hours < now close.
 * PINNED now-TZ note: TS compares against SQLite datetime('now')
 * (UTC) while PHP compares against process-TZ wall now; with config
 * UTC they agree (standing write-side TZ gap, not R5f scope).
 */
export async function runBatchTicketAutoClose(): Promise<boolean> {
  const expired = await getDb().prepare(
    `SELECT st.* FROM support_ticket st LEFT JOIN support_helpdesk sh ON sh.id = st.support_helpdesk_id
     WHERE st.status = 'on_hold' AND datetime(st.updated_at, '+' || sh.close_after || ' hours') < datetime('now') ORDER BY st.id ASC`
  ).all() as unknown as TicketRow[];
  for (const t of expired) await touchTicket(t.id, "closed");
  return true;
}

register("admin", "support", "batch_ticket_auto_close", async (ctx) => {
  requireAdmin(ctx);
  return await runBatchTicketAutoClose();
});

register("admin", "support", "ticket_get_statuses", async (ctx) => {
  requireAdmin(ctx);
  if (ctx.params["titles"] !== undefined) {
    return { open: "Open", on_hold: "On Hold", closed: "Closed" };
  }
  const rows = await getDb().prepare("SELECT status, COUNT(*) c FROM support_ticket GROUP BY status").all() as unknown as { status: string; c: number }[];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = r.c;
  return {
    total: (by["open"] ?? 0) + (by["closed"] ?? 0) + (by["on_hold"] ?? 0),
    open: by["open"] ?? 0, closed: by["closed"] ?? 0, on_hold: by["on_hold"] ?? 0,
  };
});

register("admin", "support", "task_complete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID is missing");
  const t = await ticketOrThrow(parseInt(ctx.params["id"], 10));
  await getDbWrite().prepare("UPDATE support_ticket SET rel_status = 'complete', updated_at = ? WHERE id = ?").run(nowTimestamp(), t.id);
  return true;
});

register("admin", "support", "note_create", async (ctx) => {
  requireAdmin(ctx);
  const t = await ticketOrThrow(parseInt(ctx.params["ticket_id"] ?? "", 10));
  const note = (ctx.params["note"] ?? "").trim();
  if (!note) throw new FbError("Note is empty");
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_ticket_note (support_ticket_id, admin_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", t.id, ctx.session!.admin!.id, note, now, now);
  return Number(info);
});

register("admin", "support", "note_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Note ID is missing");
  const n = await getDb().prepare("SELECT * FROM support_ticket_note WHERE id = ?").get(parseInt(ctx.params["id"], 10));
  if (!n) throw new FbError("Note not found");
  await getDbWrite().prepare("DELETE FROM support_ticket_note WHERE id = ?").run(parseInt(ctx.params["id"], 10));
  return true;
});

// ---------------------------------------------------------------- helpdesk

register("admin", "support", "helpdesk_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM support_helpdesk ORDER BY id ASC").all() as unknown as HelpdeskRow[];
  return paginateLocal(rows.map(helpdeskArray), ctx.params);
});

register("admin", "support", "helpdesk_get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const h of await getDb().prepare("SELECT * FROM support_helpdesk ORDER BY id ASC").all() as unknown as HelpdeskRow[]) out[String(h.id)] = h.name;
  return out;
});

register("admin", "support", "helpdesk_get", async (ctx) => {
  requireAdmin(ctx);
  const h = await findHelpdesk(parseInt(ctx.params["id"] ?? "", 10));
  if (!h) throw new FbError("Helpdesk not found");
  return helpdeskArray(h);
});

register("admin", "support", "helpdesk_create", async (ctx) => {
  requireAdmin(ctx);
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_helpdesk (name, email, can_reopen, close_after, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", ctx.params["name"] ?? "", ctx.params["email"] ?? "", ctx.params["can_reopen"] ? 1 : 0, parseInt(ctx.params["close_after"] ?? "24", 10), ctx.params["signature"] ?? null, now, now);
  return Number(info);
});

register("admin", "support", "helpdesk_update", async (ctx) => {
  requireAdmin(ctx);
  const h = await findHelpdesk(parseInt(ctx.params["id"] ?? "", 10));
  if (!h) throw new FbError("Helpdesk not found");
  const db = getDbWrite();
  if (ctx.params["name"] !== undefined) await db.prepare("UPDATE support_helpdesk SET name = ? WHERE id = ?").run(ctx.params["name"], h.id);
  if (ctx.params["email"] !== undefined) await db.prepare("UPDATE support_helpdesk SET email = ? WHERE id = ?").run(ctx.params["email"], h.id);
  if (ctx.params["can_reopen"] !== undefined) await db.prepare("UPDATE support_helpdesk SET can_reopen = ? WHERE id = ?").run(ctx.params["can_reopen"] ? 1 : 0, h.id);
  if (ctx.params["close_after"] !== undefined) await db.prepare("UPDATE support_helpdesk SET close_after = ? WHERE id = ?").run(parseInt(ctx.params["close_after"], 10), h.id);
  if (ctx.params["signature"] !== undefined) await db.prepare("UPDATE support_helpdesk SET signature = ? WHERE id = ?").run(ctx.params["signature"], h.id);
  await db.prepare("UPDATE support_helpdesk SET updated_at = ? WHERE id = ?").run(nowTimestamp(), h.id);
  return true;
});

register("admin", "support", "helpdesk_delete", async (ctx) => {
  requireAdmin(ctx);
  const h = await findHelpdesk(parseInt(ctx.params["id"] ?? "", 10));
  if (!h) throw new FbError("Helpdesk not found");
  await getDbWrite().prepare("DELETE FROM support_helpdesk WHERE id = ?").run(h.id);
  return true;
});

// ---------------------------------------------------------------- canned

interface CannedRow { id: number; support_pr_category_id: number | null; title: string; content: string; created_at: string; updated_at: string }

async function cannedArray(c: CannedRow) {
  const cat = c.support_pr_category_id
    ? await getDb().prepare("SELECT id, title FROM support_pr_category WHERE id = ?").get(c.support_pr_category_id) as { id: number; title: string } | undefined
    : undefined;
  return {
    id: c.id, support_pr_category_id: c.support_pr_category_id, title: c.title, content: c.content,
    created_at: c.created_at, updated_at: c.updated_at,
    category: cat ? { id: cat.id, title: cat.title } : null,
  };
}

register("admin", "support", "canned_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM support_pr ORDER BY id DESC").all() as unknown as CannedRow[];
  return paginateLocal(await Promise.all(rows.map(cannedArray)), ctx.params);
});

register("admin", "support", "canned_pairs", async (ctx) => {
  requireAdmin(ctx);
  // PHP groups by category title (category id ASC, then title ASC),
  // not a flat id->title map.
  const rows = await getDb().prepare(
    `SELECT pr.id, pr.title, cat.title AS categoryTitle, cat.id AS categoryId
     FROM support_pr pr LEFT JOIN support_pr_category cat ON cat.id = pr.support_pr_category_id
     ORDER BY cat.id ASC, pr.title ASC`
  ).all() as unknown as { id: number; title: string; categoryTitle: string | null }[];
  const out: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const key = r.categoryTitle ?? "";
    if (!out[key]) out[key] = {};
    out[key][String(r.id)] = r.title;
  }
  return out;
});

register("admin", "support", "canned_get", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_pr WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10)) as CannedRow | undefined;
  if (!c) throw new FbError("Canned response not found");
  return await cannedArray(c);
});

register("admin", "support", "canned_create", async (ctx) => {
  requireAdmin(ctx);
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_pr (title, content, created_at, updated_at, support_pr_category_id) VALUES (?, ?, ?, ?, ?)", ctx.params["title"] ?? "", ctx.params["content"] ?? "", now, now, ctx.params["support_pr_category_id"] ? parseInt(ctx.params["support_pr_category_id"], 10) : null);
  return Number(info);
});

register("admin", "support", "canned_update", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_pr WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10)) as CannedRow | undefined;
  if (!c) throw new FbError("Canned response not found");
  const db = getDbWrite();
  if (ctx.params["title"] !== undefined) await db.prepare("UPDATE support_pr SET title = ? WHERE id = ?").run(ctx.params["title"], c.id);
  if (ctx.params["content"] !== undefined) await db.prepare("UPDATE support_pr SET content = ? WHERE id = ?").run(ctx.params["content"], c.id);
  if (ctx.params["support_pr_category_id"] !== undefined) await db.prepare("UPDATE support_pr SET support_pr_category_id = ? WHERE id = ?").run(parseInt(ctx.params["support_pr_category_id"], 10), c.id);
  await db.prepare("UPDATE support_pr SET updated_at = ? WHERE id = ?").run(nowTimestamp(), c.id);
  return true;
});

register("admin", "support", "canned_delete", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_pr WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10));
  if (!c) throw new FbError("Canned response not found");
  await getDbWrite().prepare("DELETE FROM support_pr WHERE id = ?").run(parseInt(ctx.params["id"], 10));
  return true;
});

register("admin", "support", "canned_category_pairs", async (ctx) => {
  requireAdmin(ctx);
  const out: Record<string, string> = {};
  for (const c of await getDb().prepare("SELECT * FROM support_pr_category ORDER BY id ASC").all() as unknown as { id: number; title: string }[]) out[String(c.id)] = c.title;
  return out;
});

register("admin", "support", "canned_category_get", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_pr_category WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10)) as { id: number; title: string; created_at: string; updated_at: string } | undefined;
  if (!c) throw new FbError("Canned category not found");
  return { id: c.id, title: c.title, created_at: c.created_at, updated_at: c.updated_at };
});

register("admin", "support", "canned_category_create", async (ctx) => {
  requireAdmin(ctx);
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_pr_category (title, created_at, updated_at) VALUES (?, ?, ?)", ctx.params["title"] ?? "", now, now);
  return Number(info);
});

register("admin", "support", "canned_category_update", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_pr_category WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10));
  if (!c) throw new FbError("Canned category not found");
  if (ctx.params["title"] !== undefined) await getDbWrite().prepare("UPDATE support_pr_category SET title = ? WHERE id = ?").run(ctx.params["title"], parseInt(ctx.params["id"], 10));
  await getDbWrite().prepare("UPDATE support_pr_category SET updated_at = ? WHERE id = ?").run(nowTimestamp(), parseInt(ctx.params["id"], 10));
  return true;
});

register("admin", "support", "canned_category_delete", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_pr_category WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10));
  if (!c) throw new FbError("Canned category not found");
  await getDbWrite().prepare("DELETE FROM support_pr_category WHERE id = ?").run(parseInt(ctx.params["id"], 10));
  return true;
});

// ---------------------------------------------------------------- KB

interface KbArticleRow { id: number; views: number; title: string; content: string; slug: string; status: string; created_at: string; updated_at: string; kb_article_category_id: number | null }
interface KbCategoryRow { id: number; title: string; description: string | null; slug: string; created_at: string; updated_at: string }

function kbCategoryArray(c: KbCategoryRow) {
  return { id: c.id, title: c.title, description: c.description, slug: c.slug, created_at: c.created_at, updated_at: c.updated_at, articles: [] };
}

async function kbArticleArray(a: KbArticleRow, withContent: boolean) {
  const cat = a.kb_article_category_id
    ? await getDb().prepare("SELECT id, slug, title FROM support_kb_article_category WHERE id = ?").get(a.kb_article_category_id) as { id: number; slug: string; title: string } | undefined
    : undefined;
  const out: Record<string, unknown> = {
    id: a.id, slug: a.slug, title: a.title, views: a.views,
    created_at: a.created_at, status: a.status, updated_at: a.updated_at,
    category: cat ? { id: cat.id, slug: cat.slug, title: cat.title } : null,
  };
  if (withContent) out.content = a.content;
  out.kb_article_category_id = a.kb_article_category_id;
  return out;
}

register("admin", "support", "kb_article_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM support_kb_article ORDER BY id DESC").all() as unknown as KbArticleRow[];
  return paginateLocal(await Promise.all(rows.map(async (a) => await kbArticleArray(a, false))), ctx.params);
});

register("admin", "support", "kb_article_get", async (ctx) => {
  requireAdmin(ctx);
  const a = await getDb().prepare("SELECT * FROM support_kb_article WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10)) as KbArticleRow | undefined;
  if (!a) throw new FbError("Article item not found");
  return await kbArticleArray(a, true);
});

register("admin", "support", "kb_article_create", async (ctx) => {
  requireAdmin(ctx);
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_kb_article (views, title, content, slug, status, created_at, updated_at, kb_article_category_id) VALUES (0, ?, ?, ?, ?, ?, ?, ?)", ctx.params["title"] ?? "", ctx.params["content"] ?? "", ctx.params["slug"] ?? null, ctx.params["status"] ?? "active", now, now, ctx.params["kb_article_category_id"] ? parseInt(ctx.params["kb_article_category_id"], 10) : null);
  return Number(info);
});

register("admin", "support", "kb_article_update", async (ctx) => {
  requireAdmin(ctx);
  const a = await getDb().prepare("SELECT * FROM support_kb_article WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10)) as KbArticleRow | undefined;
  if (!a) throw new FbError("Article item not found");
  const db = getDbWrite();
  for (const col of ["title", "content", "slug", "status"] as const) {
    if (ctx.params[col] !== undefined) await db.prepare(`UPDATE support_kb_article SET ${col} = ? WHERE id = ?`).run(ctx.params[col], a.id);
  }
  if (ctx.params["kb_article_category_id"] !== undefined) await db.prepare("UPDATE support_kb_article SET kb_article_category_id = ? WHERE id = ?").run(parseInt(ctx.params["kb_article_category_id"], 10), a.id);
  await db.prepare("UPDATE support_kb_article SET updated_at = ? WHERE id = ?").run(nowTimestamp(), a.id);
  return true;
});

register("admin", "support", "kb_article_delete", async (ctx) => {
  requireAdmin(ctx);
  const a = await getDb().prepare("SELECT * FROM support_kb_article WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10));
  if (!a) throw new FbError("Article item not found");
  await getDbWrite().prepare("DELETE FROM support_kb_article WHERE id = ?").run(parseInt(ctx.params["id"], 10));
  return true;
});

register("admin", "support", "kb_category_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM support_kb_article_category ORDER BY id ASC").all() as unknown as KbCategoryRow[];
  return paginateLocal(rows.map(kbCategoryArray), ctx.params);
});

register("admin", "support", "kb_category_get", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_kb_article_category WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10)) as KbCategoryRow | undefined;
  if (!c) throw new FbError("Category not found");
  return kbCategoryArray(c);
});

register("admin", "support", "kb_category_create", async (ctx) => {
  requireAdmin(ctx);
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId("INSERT INTO support_kb_article_category (title, description, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", ctx.params["title"] ?? "", ctx.params["description"] ?? null, ctx.params["slug"] ?? null, now, now);
  return Number(info);
});

register("admin", "support", "kb_category_update", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_kb_article_category WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10));
  if (!c) throw new FbError("Category not found");
  const db = getDbWrite();
  for (const col of ["title", "description", "slug"] as const) {
    if (ctx.params[col] !== undefined) await db.prepare(`UPDATE support_kb_article_category SET ${col} = ? WHERE id = ?`).run(ctx.params[col], c.id);
  }
  await db.prepare("UPDATE support_kb_article_category SET updated_at = ? WHERE id = ?").run(nowTimestamp(), c.id);
  return true;
});

register("admin", "support", "kb_category_delete", async (ctx) => {
  requireAdmin(ctx);
  const c = await getDb().prepare("SELECT * FROM support_kb_article_category WHERE id = ?").get(parseInt(ctx.params["id"] ?? "", 10));
  if (!c) throw new FbError("Category not found");
  await getDbWrite().prepare("DELETE FROM support_kb_article_category WHERE id = ?").run(parseInt(ctx.params["id"], 10));
  return true;
});

// ---------------------------------------------------------------- client

register("client", "support", "ticket_get_list", async (ctx) => {
  requireClient(ctx);
  const rows = await listTicketsFiltered(ctx.params, ctx.session!.client!.id);
  return paginateLocal(await Promise.all(rows.map(async (t) => await ticketArray(t, false, true))), ctx.params);
});

register("client", "support", "ticket_get", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID was not passed");
  const t = await getDb().prepare("SELECT * FROM support_ticket WHERE id = ? AND client_id = ?").get(parseInt(ctx.params["id"], 10), ctx.session!.client!.id) as TicketRow | undefined;
  if (!t) throw new FbError("Ticket not found");
  return await ticketArray(t, false, true);
});

register("client", "support", "helpdesk_get_pairs", async (ctx) => {
  requireClient(ctx);
  const out: Record<string, string> = {};
  for (const h of await getDb().prepare("SELECT * FROM support_helpdesk ORDER BY id ASC").all() as unknown as HelpdeskRow[]) out[String(h.id)] = h.name;
  return out;
});

register("client", "support", "ticket_create", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params["content"]) throw new FbError("Ticket content required");
  if (!ctx.params["subject"]) throw new FbError("Ticket subject required");
  if (!ctx.params["support_helpdesk_id"]) throw new FbError("Ticket support_helpdesk_id required");
  const hd = await findHelpdesk(parseInt(ctx.params["support_helpdesk_id"], 10));
  if (!hd) throw new FbError("Helpdesk invalid");
  const rel = relFields(ctx.params);
  if (rel.relId !== null && rel.relType === "order") {
    const o = await getDb().prepare("SELECT * FROM client_order WHERE id = ? AND client_id = ?").get(rel.relId, ctx.session!.client!.id);
    if (!o) throw new FbError("You do not have permission to reference this order.");
  }
  if (rel.relId && rel.relType && rel.relTask) {
    const dup = await getDb().prepare("SELECT * FROM support_ticket WHERE client_id = ? AND rel_id = ? AND rel_type = ? AND rel_task = ? AND rel_status = 'pending'").get(ctx.session!.client!.id, rel.relId, rel.relType, rel.relTask);
    if (dup) throw new FbError("We have already received this request.");
  }
  const tid = await createTicketRow({
    clientId: ctx.session!.client!.id, helpdeskId: hd.id, subject: ctx.params["subject"],
    authorName: null, authorEmail: null, accessHash: null,
    relType: rel.relType, relId: rel.relId, relTask: rel.relTask, relNewValue: rel.relNewValue,
  });
  await insertMessage(tid, ctx.params["content"], ctx.session!.client!.id, null, ctx.ip);
  return tid;
});

register("client", "support", "ticket_reply", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID was not passed");
  if (!ctx.params["content"]) throw new FbError("Ticket content required");
  const t = await getDb().prepare("SELECT * FROM support_ticket WHERE id = ? AND client_id = ?").get(parseInt(ctx.params["id"], 10), ctx.session!.client!.id) as TicketRow | undefined;
  if (!t) throw new FbError("Ticket not found");
  if (t.status === "closed") {
    const hd = t.support_helpdesk_id ? await findHelpdesk(t.support_helpdesk_id) : undefined;
    if (!hd) throw new FbError("Helpdesk invalid");
    if (hd.can_reopen !== 1) throw new FbError("Ticket cannot be reopened.");
  }
  const msgId = await insertMessage(t.id, ctx.params["content"], ctx.session!.client!.id, null, ctx.ip);
  await touchTicket(t.id, "open");
  return msgId > 0;
});

register("client", "support", "ticket_close", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params["id"]) throw new FbError("Ticket ID was not passed");
  const t = await getDb().prepare("SELECT * FROM support_ticket WHERE id = ? AND client_id = ?").get(parseInt(ctx.params["id"], 10), ctx.session!.client!.id) as TicketRow | undefined;
  if (!t) throw new FbError("Ticket not found");
  await touchTicket(t.id, "closed");
  return true;
});

// ---------------------------------------------------------------- guest

register("guest", "support", "ticket_create", async (ctx) => {
  const content = ctx.params["content"] ?? ctx.params["message"] ?? "";
  if (!content || content.length < 4) throw new FbError("Please enter your message");
  if (!ctx.params["name"]) throw new FbError("Please enter your name");
  if (!ctx.params["email"] || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ctx.params["email"])) throw new FbError("Email address is invalid");
  if (!ctx.params["subject"]) throw new FbError("Ticket subject required");
  // R5h: PHP ticketCreateForGuest() validates the ticket, then
  // dispatches BeforeGuestTicketCreateEvent (guest role only:
  // blocked-IP -> captcha -> SFS -> temp-email, NO honeypot) BEFORE
  // the helpdesk lookup — so a blocked IP beats an invalid helpdesk.
  // This handler IS the guest-role handler; client/admin ticket
  // creates are separate handlers and are not gated, as in PHP.
  await checkGuestTicketAntispam(ctx, ctx.params["email"]);
  const hd = ctx.params["support_helpdesk_id"]
    ? await findHelpdesk(parseInt(ctx.params["support_helpdesk_id"], 10))
    : await getDb().prepare("SELECT * FROM support_helpdesk ORDER BY id ASC LIMIT 1").get() as HelpdeskRow | undefined;
  if (!hd) throw new FbError("Helpdesk invalid");
  const hash = randomBytes(20).toString("hex");
  const tid = await createTicketRow({
    clientId: null, helpdeskId: hd.id, subject: ctx.params["subject"],
    authorName: ctx.params["name"], authorEmail: ctx.params["email"], accessHash: hash,
    relType: null, relId: null, relTask: null, relNewValue: null,
  });
  const msg = await getDbWrite().prepare(
    "INSERT INTO support_ticket_message (client_id, admin_id, content, attachment, ip, created_at, updated_at, support_ticket_id) VALUES (NULL, NULL, ?, NULL, ?, ?, ?, ?)"
  ).run(content, ctx.ip, nowTimestamp(), nowTimestamp(), tid);
  void msg;
  return hash;
});

register("guest", "support", "ticket_get", async (ctx) => {
  if (!ctx.params["hash"]) throw new FbError("Ticket hash required");
  const t = await findTicketByHash(ctx.params["hash"]);
  if (!t) throw new FbError("Guest ticket not found");
  return await ticketArray(t, false, true);
});

register("guest", "support", "ticket_close", async (ctx) => {
  if (!ctx.params["hash"]) throw new FbError("Ticket hash required");
  const t = await findTicketByHash(ctx.params["hash"]);
  if (!t) throw new FbError("Guest ticket not found");
  await touchTicket(t.id, "closed");
  return true;
});

register("guest", "support", "ticket_reply", async (ctx) => {
  if (!ctx.params["hash"]) throw new FbError("Ticket hash required");
  const t = await findTicketByHash(ctx.params["hash"]);
  if (!t) throw new FbError("Guest ticket not found");
  const content = ctx.params["content"] ?? ctx.params["message"] ?? "";
  if (!content) throw new FbError("Message cannot be empty");
  const msgId = await insertMessage(t.id, content, null, null, ctx.ip);
  await touchTicket(t.id, "open");
  return msgId;
});

register("guest", "support", "guest_tickets_enabled", () => true);

register("guest", "support", "helpdesk_get_pairs", async (ctx) => {
  const out: Record<string, string> = {};
  for (const h of await getDb().prepare("SELECT * FROM support_helpdesk ORDER BY id ASC").all() as unknown as HelpdeskRow[]) out[String(h.id)] = h.name;
  return out;
});

register("guest", "support", "kb_article_get_list", async (ctx) => {
  const rows = await getDb().prepare("SELECT * FROM support_kb_article WHERE status = 'active' ORDER BY id DESC").all() as unknown as KbArticleRow[];
  return paginateLocal(await Promise.all(rows.map(async (a) => await kbArticleArray(a, false))), ctx.params);
});

register("guest", "support", "kb_article_get", async (ctx) => {
  if (!ctx.params["id"] && !ctx.params["slug"]) throw new FbError("ID or slug is missing");
  const a = ctx.params["id"]
    ? await getDb().prepare("SELECT * FROM support_kb_article WHERE id = ? AND status = 'active'").get(parseInt(ctx.params["id"], 10)) as KbArticleRow | undefined
    : await getDb().prepare("SELECT * FROM support_kb_article WHERE slug = ? AND status = 'active'").get(ctx.params["slug"]) as KbArticleRow | undefined;
  if (!a) throw new FbError("Article item not found");
  await getDbWrite().prepare("UPDATE support_kb_article SET views = views + 1 WHERE id = ?").run(a.id);
  return await kbArticleArray({ ...a, views: a.views + 1 }, true);
});

register("guest", "support", "kb_category_get_list", async (ctx) => {
  const rows = await getDb().prepare("SELECT * FROM support_kb_article_category ORDER BY id ASC").all() as unknown as KbCategoryRow[];
  return paginateLocal(rows.map(kbCategoryArray), ctx.params);
});

register("guest", "support", "kb_category_get", async (ctx) => {
  const c = ctx.params["id"]
    ? await getDb().prepare("SELECT * FROM support_kb_article_category WHERE id = ?").get(parseInt(ctx.params["id"], 10)) as KbCategoryRow | undefined
    : await getDb().prepare("SELECT * FROM support_kb_article_category WHERE slug = ?").get(ctx.params["slug"]) as KbCategoryRow | undefined;
  if (!c) throw new FbError("Category not found");
  return kbCategoryArray(c);
});

register("guest", "support", "kb_article_views_enabled", () => true);
