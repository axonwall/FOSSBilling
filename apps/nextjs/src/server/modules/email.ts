// Email module — admin queue/history/templates. Sending is
// queue-based in PHP: send() writes an email_queue 'pending' row;
// batch_sendmail flips pending rows to 'sending' and the transport
// delivers them (no transport exists in the sandbox, and rows stay
// 'sending' there — mirrored). email_* history endpoints read
// activity_client_email (delivered mail), NOT the queue.

import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { getDb, getDbWrite, nowTimestamp } from "../db";
import { paginate } from "../util";
import {
  findEmailTemplate, listEmailTemplates, queueEmail, templateToApi,
} from "../emailer";
import { renderTemplate } from "../twig";

interface HistoryRow {
  id: number; client_id: number | null; sender: string; recipients: string;
  subject: string; content_html: string | null; content_text: string | null;
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
  queueEmail({
    recipient: row.recipients,
    sender: row.sender,
    subject: row.subject,
    content: row.content_html ?? row.content_text ?? "",
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
  return pager(ctx, listEmailTemplates().map((t) => templateToApi(t)));
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
function validateTemplateSyntax(subject: string, content: string): void {
  for (const text of [subject, content]) {
    const re = /\{\{[^}]*?([A-Za-z_][\w]*)|\{%\s*(?:if|for)\s+([A-Za-z_][\w]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const top = m[1] ?? m[2];
      if (top) {
        throw new FbError(
          `Email template rendering error: Variable "${top}" does not exist in "__string_template__" at line 1.`
        );
      }
    }
  }
}

register("admin", "email", "template_create", (ctx) => {
  requireAdmin(ctx);
  required(ctx, {
    action_code: "Email template code is required",
    subject: "Email template subject is required",
    content: "Email template content is required",
  });
  validateTemplateSyntax(ctx.params.subject, ctx.params.content);
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
