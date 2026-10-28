import { readExtensionConfig } from "../crypt";
import {
  clientBalanceSum,
  findClientById,
  getDb,
  getSetting,
} from "../db";
import { FbError, register, requireClient } from "../dispatch";
import { clientBaseArray } from "./client";

/**
 * Index module — TS port of Index/Api/Client.php::get_dashboard (+
 * Service::getDashboardData). Named indexmod.ts because
 * modules/index.ts is the registry bootstrap.
 *
 * Fidelity notes (all pinned by captures26 idx_dashboard):
 * - profile is toApiArray(client, deep=true) with NO identity, so
 *   it is base fields + balance only: no billing_email (that needs
 *   a self identity, which getDashboardData does not pass) and no
 *   group info (admin-only). Custom fields from the mod_client
 *   config are included when active and non-empty.
 * - recent_orders are raw client_order rows + decoded config +
 *   total (float price × int quantity) + meta map (or [] when
 *   empty) + open/on_hold ticket count + the base client array.
 * - recent_tickets are non-admin batch rows: the row minus
 *   support_helpdesk_id/client_id/priority/access_hash/rel_*
 *   (+ hash when access_hash is set) + reply count (ALL messages)
 *   + first message + non-admin helpdesk + author/client summaries.
 */

function phpEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || v === "0" || v === 0 || v === false;
}

async function dashboardProfile(clientId: number): Promise<Record<string, unknown>> {
  const row = await findClientById(clientId);
  if (!row) throw new FbError("Client not found");
  const out: Record<string, unknown> = {
    ...clientBaseArray(row),
    balance: await clientBalanceSum(clientId),
  };
  const config = await readExtensionConfig("mod_client");
  const customFields = config["custom_fields"] as Record<string, { active?: unknown }> | undefined;
  if (customFields && typeof customFields === "object") {
    for (let i = 1; i <= 20; i++) {
      const field = `custom_${i}`;
      const value = (row as unknown as Record<string, unknown>)[field];
      if (customFields[field]?.active && !phpEmpty(value)) out[field] = value;
    }
  }
  return out;
}

async function statusCounts(
  sql: string,
  clientId: number,
  buckets: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = { total: 0 };
  for (const b of buckets) counts[b] = 0;
  const rows = await getDb().prepare(sql).all(clientId) as unknown as { status: string; total: number }[];
  for (const r of rows) {
    counts["total"] = (counts["total"] ?? 0) + r.total;
    if (buckets.includes(r.status)) counts[r.status] = r.total;
  }
  return counts;
}

function fmtTs(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function recentOrders(clientId: number): Promise<Record<string, unknown>[]> {
  const ids = await getDb()
    .prepare(
      "SELECT id FROM client_order WHERE client_id = ? AND group_master = 1 ORDER BY updated_at DESC LIMIT 5",
    )
    .all(clientId) as unknown as { id: number }[];
  const out: Record<string, unknown>[] = [];
  for (const { id } of ids) {
    const row = await getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as Record<
      string,
      unknown
    > | null;
    if (!row) continue;
    let config: unknown = [];
    if (typeof row["config"] === "string" && row["config"] !== "") {
      try {
        const parsed = JSON.parse(row["config"]);
        config = parsed === null || parsed === undefined ? [] : parsed;
      } catch {
        config = [];
      }
    }
    const metaRows = await getDb()
      .prepare("SELECT name, value FROM client_order_meta WHERE client_order_id = ?")
      .all(id) as unknown as { name: string; value: string | null }[];
    let meta: unknown = [];
    if (metaRows.length > 0) {
      const m: Record<string, unknown> = {};
      for (const r of metaRows) m[r.name] = r.value;
      meta = m;
    }
    const activeTickets = (
      (await getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM support_ticket WHERE rel_id = ? AND rel_type = 'order' AND (status = 'open' OR status = 'on_hold')",
        )
        .get(id)) as { n: number }
    ).n;
    const clientRow = await findClientById(Number(row["client_id"]));
    out.push({
      ...row,
      config,
      total: Number(row["price"]) * Math.trunc(Number(row["quantity"])),
      title: row["title"],
      meta,
      active_tickets: activeTickets,
      client: clientRow ? clientBaseArray(clientRow) : [],
    });
  }
  return out;
}

async function clientSummary(clientId: number): Promise<{ id: number; first_name: string; last_name: string }> {
  const row = await getDb()
    .prepare("SELECT id, first_name, last_name FROM client WHERE id = ?")
    .get(clientId) as unknown as { id: number; first_name: string; last_name: string };
  return { id: row.id, first_name: row.first_name, last_name: row.last_name };
}

async function clientAuthor(clientId: number): Promise<Record<string, unknown>> {
  const row = await getDb()
    .prepare("SELECT id, first_name, last_name, email FROM client WHERE id = ?")
    .get(clientId) as unknown as { id: number; first_name: string; last_name: string; email: string };
  return {
    id: row.id,
    name: `${row.first_name} ${row.last_name}`.trim(),
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    role: "client",
  };
}

async function messageAuthor(
  msg: Record<string, unknown>,
  ticket: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const adminId = msg["admin_id"];
  const clientId = msg["client_id"];
  if (adminId !== null && adminId !== undefined) {
    const row = await getDb().prepare("SELECT name FROM admin WHERE id = ?").get(Number(adminId)) as unknown as {
      name: string;
    } | null;
    if (!row) return {};
    return { name: row.name, role: "admin" };
  }
  if (clientId !== null && clientId !== undefined) {
    try {
      return { name: ((await clientAuthor(Number(clientId)))["name"] as string) ?? "", role: "client" };
    } catch {
      return {};
    }
  }
  if ((ticket["client_id"] === null || ticket["client_id"] === undefined) && ticket["access_hash"]) {
    return {
      name: ticket["author_name"] ?? "",
      email: ticket["author_email"] ?? "",
      role: "guest",
    };
  }
  return {};
}

async function recentTickets(clientId: number): Promise<Record<string, unknown>[]> {
  const ids = await getDb()
    .prepare(
      "SELECT id FROM support_ticket WHERE client_id = ? ORDER BY updated_at DESC LIMIT 5",
    )
    .all(clientId) as unknown as { id: number }[];
  const idList = ids.map((r) => r.id);
  if (idList.length === 0) return [];
  const marks = idList.map(() => "?").join(",");
  const replyRows = await getDb()
    .prepare(
      `SELECT support_ticket_id, COUNT(id) AS counter FROM support_ticket_message WHERE support_ticket_id IN (${marks}) GROUP BY support_ticket_id`,
    )
    .all(...idList) as unknown as { support_ticket_id: number; counter: number }[];
  const replies = new Map(replyRows.map((r) => [r.support_ticket_id, r.counter]));
  const firstRows = await getDb()
    .prepare(
      `SELECT support_ticket_id, MIN(id) AS message_id FROM support_ticket_message WHERE support_ticket_id IN (${marks}) GROUP BY support_ticket_id`,
    )
    .all(...idList) as unknown as { support_ticket_id: number; message_id: number }[];
  const firstIds = new Map(firstRows.map((r) => [r.support_ticket_id, r.message_id]));
  const out: Record<string, unknown>[] = [];
  for (const id of idList) {
    const ticket = await getDb().prepare("SELECT * FROM support_ticket WHERE id = ?").get(id) as unknown as Record<
      string,
      unknown
    > | null;
    if (!ticket) continue;
    const data: Record<string, unknown> = { ...ticket };
    for (const k of [
      "support_helpdesk_id",
      "client_id",
      "priority",
      "access_hash",
      "rel_type",
      "rel_id",
      "rel_task",
      "rel_new_value",
      "rel_status",
    ]) {
      delete data[k];
    }
    if (ticket["access_hash"]) data["hash"] = ticket["access_hash"];
    data["replies"] = replies.get(id) ?? 0;
    const firstId = firstIds.get(id);
    if (firstId !== undefined) {
      const msg = await getDb()
        .prepare("SELECT * FROM support_ticket_message WHERE id = ?")
        .get(firstId) as unknown as Record<string, unknown> | null;
      data["first"] = msg
        ? {
            id: msg["id"],
            content: msg["content"],
            attachment: msg["attachment"],
            created_at: msg["created_at"],
            updated_at: msg["updated_at"],
            author: await messageAuthor(msg, ticket),
          }
        : null;
    } else {
      data["first"] = null;
    }
    const helpdeskId = ticket["support_helpdesk_id"];
    if (helpdeskId !== null && helpdeskId !== undefined) {
      const hd = await getDb().prepare("SELECT * FROM support_helpdesk WHERE id = ?").get(Number(helpdeskId)) as unknown as {
        id: number;
        name: string;
        can_reopen: number | null;
      } | null;
      data["helpdesk"] = hd ? { id: hd.id, name: hd.name, can_reopen: !!hd.can_reopen } : null;
    } else {
      data["helpdesk"] = null;
    }
    const tid = ticket["client_id"];
    if ((tid === null || tid === undefined) && ticket["access_hash"]) {
      data["author"] = {
        name: ticket["author_name"],
        email: ticket["author_email"],
        role: "guest",
      };
      data["client"] = [];
    } else if (tid === null || tid === undefined) {
      data["author"] = {
        name: ticket["author_name"] ?? "",
        email: ticket["author_email"] ?? "",
        role: "guest",
      };
      data["client"] = [];
    } else {
      const cid = Number(tid);
      try {
        data["author"] = await clientAuthor(cid);
        data["client"] = await clientSummary(cid);
      } catch {
        data["author"] = {
          name: ticket["author_name"] ?? "",
          email: ticket["author_email"] ?? "",
          role: "guest",
        };
        data["client"] = [];
      }
    }
    out.push(data);
  }
  return out;
}

register("client", "index", "get_dashboard", async (ctx) => {
  requireClient(ctx);
  const clientId = ctx.session!.client!.id;
  const tickets = await statusCounts(
    "SELECT status, COUNT(*) AS total FROM support_ticket WHERE client_id = ? GROUP BY status",
    clientId,
    ["open", "on_hold", "closed"],
  );
  const invoices = await statusCounts(
    "SELECT status, COUNT(*) AS total FROM invoice WHERE client_id = ? AND issued = 1 GROUP BY status",
    clientId,
    ["paid", "unpaid"],
  );
  const orders = await statusCounts(
    "SELECT status, COUNT(*) AS total FROM client_order WHERE client_id = ? AND group_master = 1 GROUP BY status",
    clientId,
    ["active"],
  );
  // Expiring: DATEDIFF calendar-date stand-in — expires_at before the
  // start of day (days + 1) from today, mirroring Index Service.
  const daysRaw = await getSetting("invoice_issue_days_before_expire");
  const days = daysRaw === null ? 14 : parseInt(daysRaw, 10);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const expiresBefore = fmtTs(new Date(today.getTime() + (days + 1) * 86400000));
  const expiring = (
    (await getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM client_order WHERE client_id = ? AND group_master = 1
         AND status = 'active' AND invoice_option = 'issue-invoice' AND period IS NOT NULL
         AND expires_at IS NOT NULL AND unpaid_invoice_id IS NULL AND expires_at < ?`,
      )
      .get(clientId, expiresBefore)) as { n: number }
  ).n;
  orders["expiring"] = expiring;
  return {
    profile: await dashboardProfile(clientId),
    tickets,
    invoices,
    orders,
    recent_orders: await recentOrders(clientId),
    recent_tickets: await recentTickets(clientId),
  };
});
