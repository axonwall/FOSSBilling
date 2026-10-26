// Massmailer module — admin bulk-mail messages. Sends queue nothing
// in this seam: PHP's sendMessage early-returns in non-production
// environments (the sandbox runs APP_ENV=dev), so send()/send_test()
// flip status/sent_at and return true without queue rows; the real
// transport is Phase 5 R5 work, like the email queue itself.

import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { findClientById, getDb, getDbWrite, getSetting, nowTimestamp } from "../db";
import { paginate } from "../util";
import { readExtensionConfig } from "../crypt";
import { renderTemplateStrict } from "../twig";
import { clientAdminArray } from "./client";

interface MessageRow {
  id: number; from_email: string | null; from_name: string | null; subject: string | null;
  content: string | null; filter: string | null; status: string; sent_at: string | null;
  created_at: string; updated_at: string;
}

const CLIENT_STATUSES = ["active", "suspended", "canceled"];
const ORDER_STATUSES = ["pending_setup", "failed_setup", "failed_renew", "active", "canceled", "suspended"];
const FILTER_KEYS = ["client_status", "client_groups", "has_order", "has_order_with_status"];

const DEFAULT_CONTENT = `{% apply markdown_to_html %}
Hi {{ c.first_name }} {{ c.last_name }},

Your email is: {{ c.email }}

Aenean vut sagittis in natoque tortor. Facilisis magnis duis nec eros! Augue
sed quis tortor porttitor? Rhoncus tortor pid et a enim dis adipiscing eros
facilisis nunc. Phasellus dis odio lacus pulvinar vel lundium dapibus turpis.

Urna parturient, ultricies nascetur? Et a. Elementum in dapibus ut vel ut
magna tempor, dapibus lacus sed? Ut velit dignissim placerat, tristique pid
vut amet et nunc! Elementum dolor, dictumst porta ultrices. Rhoncus, amet.

Order our services at {{ "order"|url }}

{{ guest.system_company.name }}
{% endapply %}
{{ guest.system_email.signature }}
        `;

function invalidFilter(field: string, strict: boolean): [] {
  if (strict) throw new FbError(`Mass mail filter contains invalid values for "${field}"`);
  return [];
}

function normalizeEnum(values: unknown, allowed: string[], field: string, strict: boolean): string[] {
  if (values === null || values === undefined || (Array.isArray(values) && values.length === 0)) return [];
  if (!Array.isArray(values)) return invalidFilter(field, strict) as [];
  const selected = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" && typeof v !== "number") return invalidFilter(field, strict) as [];
    const s = String(v).trim();
    if (s === "" || !allowed.includes(s)) return invalidFilter(field, strict) as [];
    selected.add(s);
  }
  return allowed.filter((a) => selected.has(a));
}

function normalizeIds(values: unknown, table: string, field: string, strict: boolean): number[] {
  if (values === null || values === undefined || (Array.isArray(values) && values.length === 0)) return [];
  if (!Array.isArray(values)) return invalidFilter(field, strict) as [];
  const ids: number[] = [];
  for (const v of values) {
    let n: number;
    if (typeof v === "number" && Number.isInteger(v)) n = v;
    else if (typeof v === "string" && /^\d+$/.test(v)) n = parseInt(v, 10);
    else return invalidFilter(field, strict) as [];
    if (n < 1) return invalidFilter(field, strict) as [];
    ids.push(n);
  }
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const placeholders = unique.map(() => "?").join(",");
  const existing = getDb().prepare(`SELECT id FROM ${table} WHERE id IN (${placeholders})`).all(...unique) as unknown as { id: number }[];
  const existingIds = existing.map((r) => r.id).sort((a, b) => a - b);
  if (existingIds.length !== unique.length) return invalidFilter(field, strict) as [];
  return existingIds;
}

/** PHP normalizeFilter: non-strict drops bad fields, strict throws. */
export function normalizeFilter(filter: unknown, strict: boolean): Record<string, unknown> {
  let parsed: unknown = filter;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (trimmed === "") return {};
    try { parsed = JSON.parse(trimmed) as unknown; } catch { return invalidFilter("filter", strict) as unknown as Record<string, unknown>; }
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) return invalidFilter("filter", strict) as unknown as Record<string, unknown>;
  const obj = parsed as Record<string, unknown>;
  if (strict) {
    const unknown = Object.keys(obj).find((k) => !FILTER_KEYS.includes(k));
    if (unknown) return invalidFilter(unknown, strict) as unknown as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  const cs = normalizeEnum(obj.client_status, CLIENT_STATUSES, "client_status", strict);
  if (cs.length) out.client_status = cs;
  const cg = normalizeIds(obj.client_groups, "client_group", "client_groups", strict);
  if (cg.length) out.client_groups = cg;
  const ho = normalizeIds(obj.has_order, "product", "has_order", strict);
  if (ho.length) out.has_order = ho;
  const hs = normalizeEnum(obj.has_order_with_status, ORDER_STATUSES, "has_order_with_status", strict);
  if (hs.length) out.has_order_with_status = hs;
  return out;
}

function serializeFilter(filter: unknown): string {
  return JSON.stringify(normalizeFilter(filter, true));
}

function messageToApi(row: MessageRow): Record<string, unknown> {
  return {
    id: row.id,
    from_email: row.from_email,
    from_name: row.from_name,
    subject: row.subject,
    content: row.content,
    filter: normalizeFilter(row.filter, false),
    status: row.status,
    sent_at: row.sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getMessageOrThrow(id: number): MessageRow {
  const row = getDb().prepare("SELECT * FROM mod_massmailer WHERE id = ?").get(id) as unknown as MessageRow | undefined;
  if (!row) throw new FbError("Message not found");
  return row;
}

function messageIdParam(ctx: CallContext): number {
  // The RequiredParams attribute lives on PHP's private _getMessage
  // and is never enforced: a missing id reads as "not found".
  return ctx.params.id ? parseInt(ctx.params.id, 10) : 0;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function getMessageReceivers(model: MessageRow): { id: number }[] {
  const filter = normalizeFilter(model.filter, true);
  const clauses: string[] = ["c.email IS NOT NULL AND TRIM(c.email) != ''"];
  const params: unknown[] = [];
  const inClause = (col: string, values: unknown[]) => {
    if (!values.length) return;
    clauses.push(`${col} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inClause("c.status", (filter.client_status as unknown[] | undefined) ?? []);
  if ((filter.client_groups as unknown[] | undefined)?.length) {
    const vals = filter.client_groups as unknown[];
    clauses.push(`EXISTS (SELECT 1 FROM client_group_members cgm WHERE cgm.client_id = c.id AND cgm.client_group_id IN (${vals.map(() => "?").join(",")}))`);
    params.push(...vals);
  }
  inClause("co.product_id", (filter.has_order as unknown[] | undefined) ?? []);
  inClause("co.status", (filter.has_order_with_status as unknown[] | undefined) ?? []);
  const rows = getDb().prepare(
    `SELECT DISTINCT c.id, c.email FROM client c LEFT JOIN client_order co ON co.client_id = c.id
     WHERE ${clauses.join(" AND ")} ORDER BY c.id DESC`
  ).all(...(params as (string | number)[])) as unknown as { id: number; email: string }[];
  return rows.filter((r) => isValidEmail(r.email)).map((r) => ({ id: r.id }));
}

function testClientId(): number {
  const config = readExtensionConfig("mod_massmailer");
  const raw = config.test_client_id;
  if (raw === undefined || raw === null || raw === "") {
    throw new FbError("Client ID needs to be configured in mass mailer settings.");
  }
  return parseInt(String(raw), 10);
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function getParsed(model: MessageRow, clientId: number): [string, string] {
  const clientRow = findClientById(clientId);
  if (!clientRow) throw new FbError("Client not found");
  const company = { name: getSetting("company_name"), email: getSetting("company_email"), signature: getSetting("company_signature") };
  const ctx = {
    c: clientAdminArray(clientRow),
    guest: { system_company: company, system_email: { signature: company.signature } },
    default_currency: "USD",
    FOSSBillingVersion: "0.8.9",
    __baseUrl: (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080") + "/",
  };
  const subject = decodeEntities(renderTemplateStrict(model.subject ?? "", ctx));
  const content = renderTemplateStrict(model.content ?? "", ctx);
  return [subject, content];
}

function pager<T>(ctx: CallContext, items: T[]) {
  const p = paginate(items, ctx.params);
  if (p.total === 0) p.pages = 0;
  return p;
}

register("admin", "massmailer", "get_list", (ctx) => {
  requireAdmin(ctx);
  let rows = getDb().prepare("SELECT * FROM mod_massmailer").all() as unknown as MessageRow[];
  const p = ctx.params;
  if (p.id) rows = rows.filter((r) => r.id === parseInt(p.id, 10));
  if (p.status) rows = rows.filter((r) => r.status === p.status);
  if (p.search) {
    const s = p.search.toLowerCase();
    rows = rows.filter((r) => [r.subject, r.content, r.from_email, r.from_name]
      .some((v) => String(v ?? "").toLowerCase().includes(s)));
  }
  const allowed: Record<string, string> = {
    id: "id", subject: "subject", status: "status", from_email: "from_email",
    from_name: "from_name", sent_at: "sent_at", created_at: "created_at", updated_at: "updated_at",
  };
  const dir = (p.direction ?? "").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const cmp = (a: unknown, b: unknown): number => {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  if (p.sort && allowed[p.sort]) {
    const key = allowed[p.sort];
    rows = [...rows].sort((a, b) => {
      const c = cmp((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key]);
      if (c !== 0) return dir === "ASC" ? c : -c;
      return dir === "ASC" ? cmp(a.id, b.id) : -cmp(a.id, b.id);
    });
  } else {
    rows = [...rows].sort((a, b) => -cmp(a.created_at, b.created_at));
  }
  return pager(ctx, rows.map(messageToApi));
});

register("admin", "massmailer", "get", (ctx) => {
  requireAdmin(ctx);
  return messageToApi(getMessageOrThrow(messageIdParam(ctx)));
});

register("admin", "massmailer", "update", (ctx) => {
  requireAdmin(ctx);
  const model = getMessageOrThrow(messageIdParam(ctx));
  const filterRaw = ctx.rawParams?.["filter"] ?? ctx.params.filter;
  // PHP serializes the filter (strict) before the from_* checks.
  const serializedFilter = filterRaw !== undefined ? serializeFilter(filterRaw) : model.filter;
  if (ctx.params.from_name !== undefined && ctx.params.from_name === "") {
    throw new FbError("Message from name cannot be empty");
  }
  if (ctx.params.from_email !== undefined && !isValidEmail(ctx.params.from_email)) {
    throw new FbError("Email address is invalid");
  }
  getDbWrite().prepare(
    `UPDATE mod_massmailer SET content = ?, subject = ?, status = ?, filter = ?, from_name = ?, from_email = ?, updated_at = ? WHERE id = ?`
  ).run(
    ctx.params.content ?? model.content,
    ctx.params.subject ?? model.subject,
    ctx.params.status ?? model.status,
    serializedFilter,
    ctx.params.from_name ?? model.from_name,
    ctx.params.from_email !== undefined ? ctx.params.from_email.trim() : model.from_email,
    nowTimestamp(),
    model.id,
  );
  return true;
});

register("admin", "massmailer", "create", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.subject) throw new FbError("Message subject was not passed");
  const info = getDbWrite().prepare(
    `INSERT INTO mod_massmailer (from_email, from_name, subject, content, filter, status, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', 'draft', NULL, ?, ?)`
  ).run(
    getSetting("company_email"), getSetting("company_name"), ctx.params.subject,
    ctx.params.content ?? DEFAULT_CONTENT, nowTimestamp(), nowTimestamp(),
  );
  return Number(info.lastInsertRowid);
});

register("admin", "massmailer", "send_test", (ctx) => {
  requireAdmin(ctx);
  const model = getMessageOrThrow(messageIdParam(ctx));
  const clientId = testClientId();
  if (!model.content) throw new FbError("Add some content before sending message");
  getParsed(model, clientId); // strict render: a broken template errors here, like PHP
  return true; // dev early-return: no queue row, exactly like PHP outside production
});

register("admin", "massmailer", "send", (ctx) => {
  requireAdmin(ctx);
  const model = getMessageOrThrow(messageIdParam(ctx));
  if (!model.content) throw new FbError("Add some content before sending message");
  getMessageReceivers(model); // strict filter validation, like PHP
  getDbWrite().prepare("UPDATE mod_massmailer SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?")
    .run(nowTimestamp(), nowTimestamp(), model.id);
  return true;
});

register("admin", "massmailer", "copy", (ctx) => {
  requireAdmin(ctx);
  const model = getMessageOrThrow(messageIdParam(ctx));
  const info = getDbWrite().prepare(
    `INSERT INTO mod_massmailer (from_email, from_name, subject, content, filter, status, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`
  ).run(
    model.from_email, model.from_name, `${model.subject ?? ""} (Copy)`, model.content,
    model.filter, nowTimestamp(), nowTimestamp(),
  );
  return Number(info.lastInsertRowid);
});

register("admin", "massmailer", "receivers", (ctx) => {
  requireAdmin(ctx);
  return getMessageReceivers(getMessageOrThrow(messageIdParam(ctx)));
});

register("admin", "massmailer", "delete", (ctx) => {
  requireAdmin(ctx);
  const model = getMessageOrThrow(messageIdParam(ctx));
  getDbWrite().prepare("DELETE FROM mod_massmailer WHERE id = ?").run(model.id);
  return true;
});

register("admin", "massmailer", "preview", (ctx) => {
  requireAdmin(ctx);
  const model = getMessageOrThrow(messageIdParam(ctx));
  const clientId = testClientId();
  const [subject, content] = getParsed(model, clientId);
  const recipients: { email: string; name: string }[] = [];
  const include = ctx.params.include_recipients;
  // PHP truthiness: any present string except "" and "0" counts.
  const wantRecipients = include !== undefined && include !== null && include !== "" && include !== "0";
  if (wantRecipients) {
    for (const r of getMessageReceivers(model)) {
      const clientRow = findClientById(r.id);
      if (!clientRow) throw new FbError("Client not found");
      recipients.push({ email: clientRow.email, name: `${clientRow.first_name} ${clientRow.last_name}` });
    }
  }
  return { subject, content, recipients };
});

register("admin", "massmailer", "get_test_client", (ctx) => {
  requireAdmin(ctx);
  try {
    const clientRow = findClientById(testClientId());
    if (!clientRow) return "Unknown";
    return clientRow.email ?? "Unknown";
  } catch {
    return "Unknown";
  }
});
