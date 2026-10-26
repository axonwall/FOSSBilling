// Email module — admin queue/history/templates. Sending is
// queue-based in PHP: send() writes an email_queue 'pending' row;
// batch_sendmail flips pending rows to 'sending' and the transport
// delivers them (no transport exists in the sandbox, and rows stay
// 'sending' there — mirrored). email_* history endpoints read
// activity_client_email (delivered mail), NOT the queue.

import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import { findClientById, getDb, getDbWrite, getSetting, nowTimestamp } from "../db";
import { paginate } from "../util";
import { encryptV2, readExtensionConfig } from "../crypt";
import {
  applyRowChanges, createBuiltinRecord, effectiveParts, getDefaultTemplate,
  getOrCreateTemplateId, hasDefaultTemplate, isModuleActive, listDefaultTemplateCodes,
  syncBuiltinChanges, templateVars, type TemplateRowFull,
} from "../emailDefaults";
import {
  companyContext, findEmailTemplate, listEmailTemplates, queueEmail, templateToApi,
} from "../emailer";
import { renderTemplate, renderTemplateStrict } from "../twig";
import { clientAdminArray } from "./client";

interface HistoryRow {
  id: number; client_id: number | null; sender: string; recipients: string;
  subject: string; content_html: string | null; content_text: string | null;
  attachment_name: string | null;
  created_at: string; updated_at: string;
}

function historyToApi(r: HistoryRow) {
  return {
    id: r.id,
    client_id: r.client_id,
    sender: r.sender,
    recipients: r.recipients,
    subject: r.subject,
    content_html: r.content_html,
    content_text: r.content_text,
    has_attachment: r.attachment_name !== null && r.attachment_name !== undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getHistoryOrThrow(id: number): HistoryRow {
  const row = getDb().prepare("SELECT * FROM activity_client_email WHERE id = ?").get(id) as unknown as HistoryRow | undefined;
  if (!row) throw new FbError("Email not found");
  return row;
}

function required(ctx: CallContext, fields: Record<string, string>): void {
  for (const [key, message] of Object.entries(fields)) {
    const v = ctx.params[key];
    if (v === undefined || v === null || v === "") throw new FbError(message);
  }
}

/** PHP's pager reports pages: 0 for an empty list. */
function pager<T>(ctx: CallContext, items: T[]) {
  const p = paginate(items, ctx.params);
  if (p.total === 0) p.pages = 0;
  return p;
}

register("admin", "email", "send", (ctx) => {
  requireAdmin(ctx);
  required(ctx, {
    to: "Receiver email is required",
    to_name: "Receiver name is required",
    from: "Sender email is required",
    from_name: "Sender name is required",
    subject: "Email subject is required",
    content: "Email content is required",
  });
  queueEmail({
    recipient: ctx.params.to,
    sender: ctx.params.from,
    subject: ctx.params.subject,
    content: ctx.params.content,
    toName: ctx.params.to_name,
    fromName: ctx.params.from_name,
    clientId: ctx.params.client_id ? parseInt(ctx.params.client_id, 10) : null,
    adminId: ctx.session?.admin?.id ?? null,
  });
  return true;
});

register("admin", "email", "email_get_list", (ctx) => {
  requireAdmin(ctx);
  const rows = getDb().prepare("SELECT * FROM activity_client_email ORDER BY id DESC").all() as unknown as HistoryRow[];
  return pager(ctx, rows.map(historyToApi));
});

register("admin", "email", "email_get", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  return historyToApi(getHistoryOrThrow(parseInt(ctx.params.id, 10)));
});

register("admin", "email", "email_resend", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = getHistoryOrThrow(parseInt(ctx.params.id, 10));
  // PHP resend() renders from content_html only and names the recipient
  // from the client record (missing client -> 'Client not found').
  const client = row.client_id !== null ? findClientById(row.client_id) : undefined;
  if (row.client_id !== null && !client) throw new FbError("Client not found");
  queueEmail({
    recipient: row.recipients,
    sender: row.sender,
    subject: row.subject,
    content: row.content_html ?? "",
    toName: client ? `${client.first_name} ${client.last_name}` : null,
    fromName: getSetting("company_name"),
    clientId: row.client_id,
  });
  return true;
});

register("admin", "email", "email_delete", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = getHistoryOrThrow(parseInt(ctx.params.id, 10));
  getDbWrite().prepare("DELETE FROM activity_client_email WHERE id = ?").run(row.id);
  return true;
});

register("admin", "email", "template_get_list", (ctx) => {
  requireAdmin(ctx);
  const rows = listEmailTemplates();
  // PHP's default list order is category ASC, action_code ASC (NULL
  // categories first); an explicit sort param goes through paginate.
  if (!ctx.params.sort) {
    rows.sort((a, b) => ((a.category ?? "").localeCompare(b.category ?? "")
      || a.action_code.localeCompare(b.action_code)));
  }
  return pager(ctx, rows.map((t) => {
    const api = templateToApi(t) as Record<string, unknown>;
    // PHP's list mapping coerces nulls to '' (template_get keeps null).
    api.category = t.category ?? "";
    api.description = t.description ?? "";
    api.subject = t.subject ?? "";
    api.id = t.id ?? "";
    return api;
  }));
});

register("admin", "email", "template_get", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  return templateToApi(t, true);
});

/** PHP validates templates by rendering them strictly (unknown
 * top-level variables are an error). The Twig template-name hash
 * in PHP's message is not reproducible; the prefix and variable
 * name are. */
register("admin", "email", "template_create", (ctx) => {
  requireAdmin(ctx);
  required(ctx, {
    action_code: "Email template code is required",
    subject: "Email template subject is required",
    content: "Email template content is required",
  });
  // PHP templateCreate renders subject then content with empty vars,
  // strictly, before inserting; a failure creates nothing.
  try {
    renderTemplateStrict(ctx.params.subject, {});
    renderTemplateStrict(ctx.params.content, {});
  } catch (e) {
    throw new FbError(e instanceof Error ? e.message : String(e));
  }
  const info = getDbWrite().prepare(
    `INSERT INTO email_template (action_code, category, enabled, is_custom, is_overridden, subject, content, description)
     VALUES (?, ?, ?, 1, 0, ?, ?, NULL)`
  ).run(ctx.params.action_code, ctx.params.category ?? null,
        ctx.params.enabled === "1" || ctx.params.enabled === "true" ? 1 : 0,
        ctx.params.subject, ctx.params.content);
  return Number(info.lastInsertRowid);
});

register("admin", "email", "template_update", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  const subject = ctx.params.subject ?? t.subject;
  const content = ctx.params.content ?? t.content ?? "";
  // The DB row is the override store for built-ins too.
  getDbWrite().prepare("UPDATE email_template SET subject = ?, content = ?, is_overridden = ? WHERE id = ?")
    .run(subject, content, t.is_custom ? 0 : 1, t.id);
  return true;
});

register("admin", "email", "template_delete", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  getDbWrite().prepare("DELETE FROM email_template WHERE id = ?").run(t.id);
  return true;
});

register("admin", "email", "template_render", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  // PHP renders with the template's stored sample vars — those are
  // encrypted at rest (v2: prefix) and TS does not decrypt them, so
  // the preview renders with system context only (documented gap).
  const tpl = ctx.params._tpl ?? t.content ?? "";
  return renderTemplate(tpl, {
    guest: {
      system_company: { name: "Company Name" },
      system_email: { signature: "" },
    },
  });
});

register("admin", "email", "batch_sendmail", (ctx) => {
  requireAdmin(ctx);
  getDbWrite().prepare("UPDATE email_queue SET status = 'sending', updated_at = ? WHERE status = 'pending'")
    .run(nowTimestamp());
  return null;
});

register("admin", "email", "send_test", (ctx) => {
  requireAdmin(ctx);
  const adminEmail = ctx.session?.admin?.email ?? "";
  queueEmail({
    recipient: adminEmail,
    sender: adminEmail,
    subject: "Test email",
    content: "This is a test email from FOSSBilling.",
    adminId: ctx.session?.admin?.id ?? null,
  });
  return true;
});

// ---- Phase 5 R1 comms: template groups, reset, batch, send, queue ----

function templateRowOrThrow(id: number): TemplateRowFull {
  const row = getDb().prepare("SELECT * FROM email_template WHERE id = ?").get(id) as unknown as TemplateRowFull | undefined;
  if (!row) throw new FbError("Email template not found");
  return row;
}

function templateGroupIds(templateId: number): number[] {
  return (getDb().prepare("SELECT admin_group_id FROM email_template_group WHERE email_template_id = ? ORDER BY admin_group_id ASC").all(templateId) as unknown as { admin_group_id: number }[])
    .map((r) => r.admin_group_id);
}

/** ids[] from a JSON body array or form bracket keys, in index order. */
function idsParam(ctx: CallContext): number[] | undefined {
  const raw = ctx.rawParams?.["ids"];
  if (Array.isArray(raw)) return raw.map((v) => Number(v));
  const bracket: [number, string][] = [];
  for (const k of Object.keys(ctx.params)) {
    const m = /^ids\[(\d+)\]$/.exec(k);
    if (m) bracket.push([parseInt(m[1], 10), ctx.params[k]]);
  }
  if (bracket.length) return bracket.sort((a, b) => a[0] - b[0]).map(([, v]) => Number(v));
  if (ctx.params.ids !== undefined && ctx.params.ids !== "") {
    return String(ctx.params.ids).split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  }
  return undefined;
}

function sortRows<T extends Record<string, unknown>>(
  rows: T[], params: Record<string, string>, allowed: Record<string, string>,
  defaultKey: string, defaultDir: "ASC" | "DESC",
): T[] {
  const sort = params.sort;
  const dir = (params.direction ?? "").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const cmp = (a: unknown, b: unknown): number => {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  const sorted = [...rows];
  if (sort && allowed[sort]) {
    const key = allowed[sort];
    sorted.sort((a, b) => {
      const c = cmp(a[key], b[key]);
      if (c !== 0) return dir === "ASC" ? c : -c;
      return dir === "ASC" ? cmp(a.id, b.id) : -cmp(a.id, b.id);
    });
  } else {
    sorted.sort((a, b) => {
      const c = cmp(a[defaultKey], b[defaultKey]);
      if (c !== 0) return defaultDir === "ASC" ? c : -c;
      return 0;
    });
  }
  return sorted;
}

const like = (hay: unknown, needle: string) =>
  String(hay ?? "").toLowerCase().includes(needle.toLowerCase());

register("admin", "email", "template_group_get_list", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const template = templateRowOrThrow(parseInt(ctx.params.id, 10));
  const ids = templateGroupIds(template.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const groups = getDb().prepare(
    `SELECT id, name, protected FROM admin_group WHERE id IN (${placeholders}) ORDER BY id ASC`
  ).all(...ids) as unknown as { id: number; name: string; protected: number }[];
  return groups.map((g) => ({ id: g.id, name: g.name, protected: !!g.protected }));
});

register("admin", "email", "template_group_add", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  if (!ctx.params.group_id) throw new FbError("Staff group ID was not passed");
  const template = templateRowOrThrow(parseInt(ctx.params.id, 10));
  const groupId = parseInt(ctx.params.group_id, 10);
  const group = getDb().prepare("SELECT id FROM admin_group WHERE id = ?").get(groupId) as unknown as { id: number } | undefined;
  if (!group) throw new FbError("Staff group not found");
  const existing = getDb().prepare(
    "SELECT id FROM email_template_group WHERE email_template_id = ? AND admin_group_id = ?"
  ).get(template.id, groupId) as unknown as { id: number } | undefined;
  if (existing) return true;
  getDbWrite().prepare(
    "INSERT INTO email_template_group (admin_group_id, created_at, email_template_id) VALUES (?, ?, ?)"
  ).run(groupId, nowTimestamp(), template.id);
  return true;
});

register("admin", "email", "template_group_remove", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  if (!ctx.params.group_id) throw new FbError("Staff group ID was not passed");
  const template = templateRowOrThrow(parseInt(ctx.params.id, 10));
  const groupId = parseInt(ctx.params.group_id, 10);
  getDbWrite().prepare(
    "DELETE FROM email_template_group WHERE email_template_id = ? AND admin_group_id = ?"
  ).run(template.id, groupId);
  return true;
});

register("admin", "email", "template_reset", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.code) throw new FbError("Email template code was not passed");
  const code = ctx.params.code;
  const def = getDefaultTemplate(code, { code });
  if (!def) throw new FbError(`Email template ${code} does not have a file-backed default`);
  const id = getOrCreateTemplateId(code, { code });
  const row = templateRowOrThrow(id);
  if (row.is_custom) throw new FbError(`Custom email template ${code} cannot be reset to a default`);
  applyRowChanges(id, { subject: def.subject, content: def.content, is_overridden: 0, last_error: null, error_checked_at: null });
  return true;
});

register("admin", "email", "batch_template_generate", (ctx) => {
  requireAdmin(ctx);
  const rows = getDb().prepare("SELECT * FROM email_template ORDER BY id ASC").all() as unknown as TemplateRowFull[];
  for (const row of rows) {
    if (row.is_custom) continue;
    const def = getDefaultTemplate(row.action_code);
    if (!def) continue;
    applyRowChanges(row.id, { subject: def.subject, content: def.content, is_overridden: 0, last_error: null, error_checked_at: null });
  }
  return true;
});

function syncFileBackedTemplates(): void {
  for (const { code, module } of listDefaultTemplateCodes()) {
    if (!isModuleActive(module)) continue;
    const def = getDefaultTemplate(code, { code });
    if (!def) continue;
    const existing = getDb().prepare("SELECT * FROM email_template WHERE action_code = ?").get(code) as unknown as TemplateRowFull | undefined;
    if (!existing) {
      createBuiltinRecord(code, def);
    } else if (!existing.is_custom) {
      applyRowChanges(existing.id, syncBuiltinChanges(existing, def));
    }
  }
}

register("admin", "email", "batch_template_disable", (ctx) => {
  requireAdmin(ctx);
  syncFileBackedTemplates();
  getDbWrite().prepare("UPDATE email_template SET enabled = 0").run();
  return true;
});

register("admin", "email", "batch_template_enable", (ctx) => {
  requireAdmin(ctx);
  syncFileBackedTemplates();
  getDbWrite().prepare("UPDATE email_template SET enabled = 1").run();
  return true;
});

/** Email render context: stored/call vars + the email env globals. */
function emailRenderCtx(vars: Record<string, unknown>): Record<string, unknown> {
  const company = companyContext();
  return {
    ...vars,
    guest: {
      system_company: company,
      system_email: { signature: company.signature },
    },
    default_currency: "USD",
    FOSSBillingVersion: "0.8.9",
    __baseUrl: (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080") + "/",
  };
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

/** PHP _parse: render content then subject strictly; on failure the
 * template keeps the error and the call throws. */
function parseTemplateOrThrow(row: TemplateRowFull, vars: Record<string, unknown>): [string, string] {
  const [subjectTpl, contentTpl] = effectiveParts(row);
  const ctx = emailRenderCtx(vars);
  try {
    const content = renderTemplateStrict(contentTpl, ctx);
    const subject = decodeEntities(renderTemplateStrict(subjectTpl, ctx));
    if (row.last_error !== null) {
      applyRowChanges(row.id, { last_error: null, error_checked_at: null });
    }
    return [subject, content];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    applyRowChanges(row.id, { last_error: message, error_checked_at: nowTimestamp() });
    throw new FbError(message);
  }
}

register("admin", "email", "template_validate_all", (ctx) => {
  requireAdmin(ctx);
  const rows = getDb().prepare("SELECT * FROM email_template ORDER BY id ASC").all() as unknown as TemplateRowFull[];
  const results: { valid: number; invalid: number; errors: { id: number; action_code: string; error: string }[] } =
    { valid: 0, invalid: 0, errors: [] };
  for (const row of rows) {
    try {
      parseTemplateOrThrow(row, templateVars(row));
      results.valid++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // parseTemplateOrThrow already stored last_error; keep the row's
      // error_checked_at from that write (do not double-write).
      results.invalid++;
      results.errors.push({ id: row.id, action_code: row.action_code, error: message });
    }
  }
  return results;
});

function setTemplateVars(row: TemplateRowFull, vars: Record<string, unknown>): void {
  const encoded = encryptV2(JSON.stringify(vars));
  applyRowChanges(row.id, { vars: encoded });
}

register("admin", "email", "template_send", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.code) throw new FbError("Template code not passed");
  const code = ctx.params.code;
  const has = (k: string) => ctx.params[k] !== undefined && ctx.params[k] !== null && ctx.params[k] !== "";
  if (!has("to") && !has("to_staff") && !has("to_client")) {
    throw new FbError("Receiver is not defined. Define to or to_client or to_staff parameter");
  }
  if (ctx.params.client_billing_email !== undefined && ctx.params.client_billing_email !== null) {
    throw new FbError("client_billing_email cannot be set via the API");
  }
  if (has("to_client") && has("to")) {
    throw new FbError("Parameters `to` and `to_client` cannot be combined. Client-bound emails are always sent to the client's registered email address.");
  }
  const id = getOrCreateTemplateId(code, ctx.params);
  let row = templateRowOrThrow(id);

  // Call vars: everything except routing/default keys (PHP unsets the
  // same list; CSRFToken never reaches the API layer there either).
  const stripped = new Set(["to", "to_client", "to_staff", "to_name", "from", "from_name", "to_admin",
    "client_billing_email", "default_description", "default_subject", "default_template", "code",
    "send_now", "throw_exceptions", "attachment", "CSRFToken"]);
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.rawParams ?? {})) {
    if (!stripped.has(k)) vars[k] = v;
  }
  for (const [k, v] of Object.entries(ctx.params)) {
    if (!stripped.has(k) && !(k in vars)) vars[k] = v;
  }

  let staffList: { id: number; email: string; name: string; signature: string | null; timezone: string | null }[] = [];
  if (has("to_staff")) {
    const groupIds = templateGroupIds(row.id);
    if (groupIds.length) {
      const placeholders = groupIds.map(() => "?").join(",");
      staffList = getDb().prepare(
        `SELECT DISTINCT a.id, a.email, a.name, a.signature, a.timezone FROM admin a
         INNER JOIN admin_group_member m ON m.admin_id = a.id
         WHERE m.admin_group_id IN (${placeholders}) AND a.status = 'active'
           AND (a.system_name IS NULL OR a.system_name != 'cron') ORDER BY a.id ASC`
      ).all(...groupIds) as unknown as typeof staffList;
    }
    if (staffList.length) {
      const first = staffList[0];
      vars.staff = { id: first.id, email: first.email, name: first.name, signature: first.signature };
    }
  }

  let customer: ReturnType<typeof clientAdminArray> | null = null;
  if (has("to_client")) {
    const clientRow = findClientById(parseInt(ctx.params.to_client, 10));
    if (!clientRow) throw new FbError("Client not found");
    customer = clientAdminArray(clientRow);
    vars.c = customer;
  }

  let oneStaff: { id: number; email: string; name: string; signature: string | null } | null = null;
  if (has("to_admin")) {
    const admin = getDb().prepare("SELECT id, email, name, signature FROM admin WHERE id = ?").get(parseInt(ctx.params.to_admin, 10)) as unknown as
      { id: number; email: string; name: string; signature: string | null } | undefined;
    if (!admin) throw new FbError("Admin not found");
    oneStaff = admin;
    vars.c = { id: admin.id, email: admin.email, name: admin.name, signature: admin.signature };
  }

  setTemplateVars(row, vars);
  row = templateRowOrThrow(id);
  if (!row.enabled) return false;

  const emailConfig = readExtensionConfig("mod_email");
  const company = companyContext();
  const from = ctx.params.from
    ?? (typeof emailConfig.from_email === "string" && emailConfig.from_email ? emailConfig.from_email : null)
    ?? (company.email || null);
  const fromName = ctx.params.from_name
    ?? (typeof emailConfig.from_name === "string" && emailConfig.from_name ? emailConfig.from_name : null)
    ?? (company.name || null);
  if (!from) throw new FbError('The "from" email address cannot be empty');

  // send_now/attachments/transport are out of scope for the seam: like
  // the sandbox PHP install, sends land in the queue as 'pending'.
  // PHP enters the staff branch whenever to_staff was passed, even
  // with an empty staff list (sent stays false) — and it parses the
  // template once first, so a staff-referencing template still throws.
  let sent = false;
  if (has("to_staff")) {
    if (staffList.length === 0) {
      parseTemplateOrThrow(row, vars);
    }
    for (const staff of staffList) {
      const staffVars = { ...vars, staff: { id: staff.id, email: staff.email, name: staff.name, signature: staff.signature } };
      const [subject, content] = parseTemplateOrThrow(row, staffVars);
      queueEmail({
        recipient: staff.email, sender: from, subject, content,
        toName: staff.name, fromName, clientId: null, adminId: staff.id,
      });
      sent = true;
    }
  } else if (oneStaff) {
    const [subject, content] = parseTemplateOrThrow(row, vars);
    queueEmail({
      recipient: oneStaff.email, sender: from, subject, content,
      toName: oneStaff.name, fromName, clientId: null, adminId: oneStaff.id,
    });
    sent = true;
  } else if (customer) {
    const [subject, content] = parseTemplateOrThrow(row, vars);
    queueEmail({
      recipient: customer.email, sender: from, subject, content,
      toName: `${customer.first_name} ${customer.last_name}`, fromName, clientId: customer.id, adminId: null,
    });
    sent = true;
  } else {
    const [subject, content] = parseTemplateOrThrow(row, vars);
    queueEmail({
      recipient: ctx.params.to, sender: from, subject, content,
      toName: ctx.params.to_name ?? null, fromName, clientId: null, adminId: null,
    });
    sent = true;
  }
  return sent;
});

register("admin", "email", "batch_template_delete", (ctx) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (ids === undefined) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const row = templateRowOrThrow(id);
    if (!row.is_custom && hasDefaultTemplate(row.action_code)) continue;
    getDbWrite().prepare("DELETE FROM email_template WHERE id = ?").run(id);
  }
  return true;
});

register("admin", "email", "batch_delete", (ctx) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (ids === undefined) throw new FbError("IDs were not passed");
  for (const id of ids) {
    getHistoryOrThrow(id);
    getDbWrite().prepare("DELETE FROM activity_client_email WHERE id = ?").run(id);
  }
  return true;
});

interface QueueRow {
  id: number; recipient: string; subject: string; content: string; to_name: string | null;
  status: string; tries: number; attachment_name: string | null; created_at: string; updated_at: string;
}

function queueToApi(r: QueueRow) {
  return {
    id: r.id,
    recipient: r.recipient,
    subject: r.subject,
    content: r.content,
    to_name: r.to_name,
    status: r.status,
    tries: r.tries,
    has_attachment: r.attachment_name !== null && r.attachment_name !== undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

register("admin", "email", "get_queue", (ctx) => {
  requireAdmin(ctx);
  let rows = getDb().prepare("SELECT * FROM email_queue").all() as unknown as QueueRow[];
  if (ctx.params.status) rows = rows.filter((r) => r.status === ctx.params.status);
  if (ctx.params.client_id) rows = rows.filter((r) => (r as unknown as { client_id: number | null }).client_id === parseInt(ctx.params.client_id, 10));
  const allowed: Record<string, string> = {
    subject: "subject", recipient: "recipient", sender: "sender", to_name: "to_name",
    status: "status", priority: "priority", tries: "tries", created_at: "created_at",
    updated_at: "updated_at", id: "id",
  };
  // PHP's default queue order is priority DESC, id ASC (not the id
  // tiebreak the other lists use).
  if (ctx.params.sort && allowed[ctx.params.sort]) {
    const dir = (ctx.params.direction ?? "").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const key = allowed[ctx.params.sort];
    rows = sortRows(rows as unknown as Record<string, unknown>[], { ...ctx.params, direction: dir },
      { [ctx.params.sort]: key }, "id", "ASC") as unknown as QueueRow[];
  } else {
    rows = [...rows].sort((a, b) => {
      const pa = (a as unknown as { priority: number }).priority ?? 0;
      const pb = (b as unknown as { priority: number }).priority ?? 0;
      if (pb !== pa) return pb - pa;
      return a.id - b.id;
    });
  }
  return pager(ctx, rows.map(queueToApi));
});

// ---- client email history ----

function clientHistoryOrThrow(clientId: number, id: number): HistoryRow {
  const row = getDb().prepare("SELECT * FROM activity_client_email WHERE id = ? AND client_id = ?").get(id, clientId) as unknown as HistoryRow | undefined;
  if (!row) throw new FbError("Email not found");
  return row;
}

function historyListQuery(ctx: CallContext, clientId: number): HistoryRow[] {
  let rows = getDb().prepare("SELECT * FROM activity_client_email WHERE client_id = ?").all(clientId) as unknown as HistoryRow[];
  const p = ctx.params;
  if (p.id) rows = rows.filter((r) => r.id === parseInt(p.id, 10));
  if (p.sender) rows = rows.filter((r) => like(r.sender, p.sender));
  if (p.recipient) rows = rows.filter((r) => like(r.recipients, p.recipient));
  if (p.subject) rows = rows.filter((r) => like(r.subject, p.subject));
  if (p.search) rows = rows.filter((r) => like(r.subject, p.search) || like(r.sender, p.search)
    || like(r.recipients, p.search) || like(r.content_text, p.search) || like(r.content_html, p.search));
  if (p.date_from) rows = rows.filter((r) => r.created_at >= `${p.date_from} 00:00:00`);
  if (p.date_to) rows = rows.filter((r) => r.created_at <= `${p.date_to} 23:59:59`);
  return sortRows(rows as unknown as Record<string, unknown>[], p,
    { id: "id", sender: "sender", recipient: "recipients", subject: "subject", created_at: "created_at", updated_at: "updated_at" },
    "id", "DESC") as unknown as HistoryRow[];
}

register("client", "email", "get_list", (ctx) => {
  requireClient(ctx);
  const clientId = ctx.session!.client!.id;
  return pager(ctx, historyListQuery(ctx, clientId).map(historyToApi));
});

register("client", "email", "get", (ctx) => {
  requireClient(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  return historyToApi(clientHistoryOrThrow(ctx.session!.client!.id, parseInt(ctx.params.id, 10)));
});

register("client", "email", "resend", (ctx) => {
  requireClient(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = clientHistoryOrThrow(ctx.session!.client!.id, parseInt(ctx.params.id, 10));
  const client = findClientById(row.client_id ?? -1);
  if (!client) throw new FbError("Client not found");
  queueEmail({
    recipient: row.recipients,
    sender: row.sender,
    subject: row.subject,
    content: row.content_html ?? "",
    toName: `${client.first_name} ${client.last_name}`,
    fromName: getSetting("company_name"),
    clientId: row.client_id,
  });
  return true;
});

register("client", "email", "delete", (ctx) => {
  requireClient(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = clientHistoryOrThrow(ctx.session!.client!.id, parseInt(ctx.params.id, 10));
  getDbWrite().prepare("DELETE FROM activity_client_email WHERE id = ?").run(row.id);
  return true;
});
