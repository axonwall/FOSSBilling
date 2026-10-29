// Email module — admin queue/history/templates. Sending is
// queue-based in PHP: send() writes an email_queue 'pending' row;
// batch_sendmail runs _sendFromQueue over due rows, and the transport
// (Symfony Mailer in PHP, nodemailer here — R5e) delivers them.
// email_* history endpoints read activity_client_email (delivered
// mail), NOT the queue.

import nodemailer from "nodemailer";
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

async function getHistoryOrThrow(id: number): Promise<HistoryRow> {
  const row = await getDb().prepare("SELECT * FROM activity_client_email WHERE id = ?").get(id) as unknown as HistoryRow | undefined;
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

register("admin", "email", "send", async (ctx) => {
  requireAdmin(ctx);
  required(ctx, {
    to: "Receiver email is required",
    to_name: "Receiver name is required",
    from: "Sender email is required",
    from_name: "Sender name is required",
    subject: "Email subject is required",
    content: "Email content is required",
  });
  await queueEmail({
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

register("admin", "email", "email_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM activity_client_email ORDER BY id DESC").all() as unknown as HistoryRow[];
  return pager(ctx, rows.map(historyToApi));
});

register("admin", "email", "email_get", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  return historyToApi(await getHistoryOrThrow(parseInt(ctx.params.id, 10)));
});

register("admin", "email", "email_resend", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = await getHistoryOrThrow(parseInt(ctx.params.id, 10));
  // PHP resend() renders from content_html only and names the recipient
  // from the client record (missing client -> 'Client not found').
  const client = row.client_id !== null ? await findClientById(row.client_id) : undefined;
  if (row.client_id !== null && !client) throw new FbError("Client not found");
  await queueEmail({
    recipient: row.recipients,
    sender: row.sender,
    subject: row.subject,
    content: row.content_html ?? "",
    toName: client ? `${client.first_name} ${client.last_name}` : null,
    fromName: await getSetting("company_name"),
    clientId: row.client_id,
  });
  return true;
});

register("admin", "email", "email_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = await getHistoryOrThrow(parseInt(ctx.params.id, 10));
  await getDbWrite().prepare("DELETE FROM activity_client_email WHERE id = ?").run(row.id);
  return true;
});

register("admin", "email", "template_get_list", async (ctx) => {
  requireAdmin(ctx);
  const rows = await listEmailTemplates();
  // PHP's default list order is category ASC, action_code ASC (NULL
  // categories first); an explicit sort param goes through paginate.
  if (!ctx.params.sort) {
    rows.sort((a, b) => ((a.category ?? "").localeCompare(b.category ?? "")
      || a.action_code.localeCompare(b.action_code)));
  }
  return pager(ctx, await Promise.all(rows.map(async (t) => {
    const api = await templateToApi(t) as Record<string, unknown>;
    // PHP's list mapping coerces nulls to '' (template_get keeps null).
    api.category = t.category ?? "";
    api.description = t.description ?? "";
    api.subject = t.subject ?? "";
    api.id = t.id ?? "";
    return api;
  })));
});

register("admin", "email", "template_get", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = await findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  return await templateToApi(t, true);
});

/** PHP validates templates by rendering them strictly (unknown
 * top-level variables are an error). The Twig template-name hash
 * in PHP's message is not reproducible; the prefix and variable
 * name are. */
register("admin", "email", "template_create", async (ctx) => {
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
  const info = await getDbWrite().insertAndGetId(`INSERT INTO email_template (action_code, category, enabled, is_custom, is_overridden, subject, content, description)
     VALUES (?, ?, ?, 1, 0, ?, ?, NULL)`, ctx.params.action_code, ctx.params.category ?? null, ctx.params.enabled === "1" || ctx.params.enabled === "true" ? 1 : 0, ctx.params.subject, ctx.params.content);
  return Number(info);
});

register("admin", "email", "template_update", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = await findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  const subject = ctx.params.subject ?? t.subject;
  const content = ctx.params.content ?? t.content ?? "";
  // The DB row is the override store for built-ins too.
  await getDbWrite().prepare("UPDATE email_template SET subject = ?, content = ?, is_overridden = ? WHERE id = ?")
    .run(subject, content, t.is_custom ? 0 : 1, t.id);
  return true;
});

register("admin", "email", "template_delete", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = await findEmailTemplate(parseInt(ctx.params.id, 10));
  if (!t) throw new FbError("Email template not found");
  await getDbWrite().prepare("DELETE FROM email_template WHERE id = ?").run(t.id);
  return true;
});

register("admin", "email", "template_render", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const t = await findEmailTemplate(parseInt(ctx.params.id, 10));
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

// ---- Phase 5 R5e: SMTP transport + queue state machine ----
// PHP truth: Email/Service.php batchSend() + _sendFromQueue(),
// Mail.php (Symfony Mailer), QueuedEmailRepository.php findDueBatch().
// The state machine is per-attempt; retries happen across batch runs
// (findDueBatch re-picks 'failed' rows), so R5f's cron job drives
// repetition and R5e only implements one attempt faithfully:
//
//   due = status IN (unsent, pending, failed) ORDER BY priority DESC, id ASC
//   batchSend limit = queue_once; limit <= 0 means unlimited; the
//   time_limit budget (minutes, default 5) breaks AFTER each send when
//   elapsed > limit (limit 0 never breaks; -1 breaks after 1 send).
//   _sendFromQueue: demo-active -> false, NO state change. Else status
//   -> 'sending' + flush, content += "\n" (persisted on failure, and
//   logged with the newline on success/cancel). Success -> logEmail
//   if log_enabled -> DELETE row (delete failure only logged).
//   Failure (ANY exception from transport selection or delivery) ->
//   priority -1 iff priority truthy, status 'failed', tries +1,
//   content (with \n) flushed; tries > cancel_after (default 5) ->
//   logEmail if log_enabled -> DELETE row (delete failure propagates).
//   throw_exceptions -> rethrow, truncated past 350 chars with the
//   __trans() prefix. Validation errors (bad/missing SMTP config,
//   unknown mailer, unported mailer) rethrow UNWRAPPED; transport
//   errors rethrow WRAPPED as 'Failed to send email via <mailer> with
//   the exception: <original>' (Mail.php's try/catch boundary).
//   A row left at 'sending' by a crash is NEVER re-picked (both stacks).
//   PHP's non-production skip (leave at 'sending', return true) is
//   NOT mirrored: TS has no production/dev mail distinction (scope
//   R5e, documented deviation). PHP's per-instance Bcc cache is
//   mirrored by parsing once per batchSend call.

type EmailSettings = {
  mailer: string; smtpHost: string; smtpPortRaw: unknown; smtpPort: number | null;
  smtpUsername: string; smtpPassword: string; replyTo: string; bccEmail: string;
  logEnabled: boolean; queueOnce: number; timeLimit: number; cancelAfter: number;
};

/** PHP truthiness: "0", "", 0, false, null, undefined are falsy. */
function phpTruthy(v: unknown): boolean {
  return !(v === false || v === 0 || v === "0" || v === "" || v === null || v === undefined);
}

function cfgStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** PHP (int) cast for config numbers: absent -> default, else trunc, garbage -> 0. */
function cfgInt(v: unknown, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Tools::normalizePort: trimmed int 1..65535, else null. */
function normalizePort(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= 1 && n <= 65535 ? n : null;
}

async function readEmailSettings(): Promise<EmailSettings> {
  const cfg = await readExtensionConfig("mod_email");
  const mailer = cfgStr(cfg.mailer) || "sendmail";
  return {
    mailer,
    smtpHost: cfgStr(cfg.smtp_host),
    smtpPortRaw: cfg.smtp_port,
    smtpPort: normalizePort(cfg.smtp_port),
    smtpUsername: cfgStr(cfg.smtp_username),
    smtpPassword: cfgStr(cfg.smtp_password),
    replyTo: cfgStr(cfg.reply_to),
    bccEmail: cfgStr(cfg.bcc_email),
    logEnabled: phpTruthy(cfg.log_enabled),
    queueOnce: cfgInt(cfg.queue_once, 0),
    timeLimit: cfgInt(cfg.time_limit, 5),
    cancelAfter: cfgInt(cfg.cancel_after, 5),
  };
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** parseBccAddresses: comma-split, trim, valid only (invalid logged, skipped). */
function parseBccAddresses(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const addr = part.trim();
    if (!addr) continue;
    if (isValidEmail(addr)) valid.push(addr);
    else invalid.push(addr);
  }
  return { valid, invalid };
}

/** Validation error: thrown before any transport attempt (unwrapped on rethrow). */
class ValidationMailError extends Error {}
/** Transport error: thrown by the delivery attempt (wrapped on rethrow). */
class TransportMailError extends Error {}

interface QueueRowFull {
  id: number; recipient: string; sender: string; subject: string; content: string;
  to_name: string | null; from_name: string | null; client_id: number | null;
  admin_id: number | null; priority: number | null; tries: number; status: string;
  attachment_name: string | null; attachment_content: Buffer | string | null;
  attachment_mime: string | null;
}

async function queueRowById(id: number): Promise<QueueRowFull | undefined> {
  return (await getDb().prepare("SELECT * FROM email_queue WHERE id = ?").get(id)) as unknown as QueueRowFull | undefined;
}

/** Activity/Service.php logEmail(): sender/recipients are the queue strings. */
async function logEmailRow(row: QueueRowFull, contentWithNewline: string): Promise<void> {
  const hasAttachment = row.attachment_content !== null && row.attachment_content !== undefined;
  await getDbWrite().prepare(
    `INSERT INTO activity_client_email (client_id, sender, recipients, subject, content_html, content_text,
       attachment_name, attachment_content, attachment_mime, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    row.client_id, row.sender, row.recipient, row.subject, contentWithNewline,
    hasAttachment ? row.attachment_name : null,
    hasAttachment ? row.attachment_content : null,
    hasAttachment ? (row.attachment_mime ?? "application/octet-stream") : null,
    nowTimestamp(),
  );
}

function truncateThrowMessage(message: string): string {
  if (message.length > 350) {
    return "Error message truncated due to length, please check the error log for the complete message: "
      + message.slice(0, 350) + "...";
  }
  return message;
}

/** Deliver one queued row via the configured transport. Throws
 * ValidationMailError (config/transport-selection problems) or
 * TransportMailError (delivery problems). Never logs credentials. */
async function deliverQueuedMail(
  row: QueueRowFull, content: string, settings: EmailSettings, bcc: string[],
): Promise<void> {
  const from = row.from_name ? { name: row.from_name, address: row.sender } : row.sender;
  const to = row.to_name ? { name: row.to_name, address: row.recipient } : row.recipient;
  const hasAttachment = row.attachment_content !== null && row.attachment_content !== undefined;
  const attachments = hasAttachment ? [{
    filename: row.attachment_name ?? "attachment",
    content: row.attachment_content as Buffer | string,
    contentType: row.attachment_mime ?? "application/octet-stream",
  }] : [];
  // PHP: reply_to set iff non-empty AND valid, else a logger warning.
  const replyTo = settings.replyTo && isValidEmail(settings.replyTo) ? settings.replyTo : undefined;
  if (settings.replyTo && !replyTo) console.warn(`[email] Skipping invalid Reply-To address: ${settings.replyTo}`);
  // Wire-body compensation (parity38 probes): nodemailer trims
  // exactly ONE trailing newline from SINGLE-PART string html (input
  // "X\n" decodes to "X"; "X\n\n" decodes to "X\r\n"), while Symfony
  // QP preserves PHP's appended PHP_EOL as a trailing CRLF. But in
  // MULTIPART messages nodemailer preserves the newline verbatim, so
  // the same compensation overshoots by one CRLF there (probe: PHP
  // part "<p>…</p>\r\n" vs compensated TS "<p>…</p>\r\n\r\n"). Hence
  // the compensation applies ONLY to single-part mail; multipart
  // html passes content through unchanged. Both shapes are pinned
  // by parity38 §A (single) and §B (multipart). The LOGGED content
  // (activity row) always keeps the single appended newline.
  const mail = {
    from, to, subject: row.subject, html: hasAttachment ? content : content + "\n",
    ...(replyTo ? { replyTo } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
  if (settings.mailer === "smtp") {
    // Mail::__smtpDsn: empty host OR port -> 'not configured' (checked
    // first); unparseable port -> 'invalid'. Auth iff username non-empty.
    const portRawEmpty = settings.smtpPortRaw === undefined || settings.smtpPortRaw === null
      || settings.smtpPortRaw === "" || settings.smtpPortRaw === "0" || settings.smtpPortRaw === 0;
    if (!settings.smtpHost || portRawEmpty) {
      throw new ValidationMailError("SMTP host or port is not configured");
    }
    if (settings.smtpPort === null) {
      throw new ValidationMailError("SMTP port is invalid");
    }
    const auth = settings.smtpUsername
      ? { user: settings.smtpUsername, pass: settings.smtpPassword }
      : undefined;
    const transporter = nodemailer.createTransport({
      host: settings.smtpHost, port: settings.smtpPort, secure: false,
      ...(auth ? { auth } : {}),
      // No TLS upgrade unless the server advertises STARTTLS (the
      // mock does not); nodemailer opportunistic-upgrades like
      // Symfony's smtp:// DSN when it is advertised.
    });
    try {
      await transporter.sendMail(mail);
    } catch (e) {
      throw new TransportMailError(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (settings.mailer === "sendgrid") {
    // Mail::send: key required (exact PHP message); the SendGrid
    // transport itself is a follow-up, NOT this batch.
    throw new ValidationMailError("A SendGrid API key is required to send emails via SendGrid");
  }
  if (settings.mailer === "custom") {
    // Mail::send: DSN required (exact PHP message); custom-DSN
    // transport is a follow-up, NOT this batch.
    throw new ValidationMailError("Unable to send email: 'Custom' transport method was selected without a custom DSN");
  }
  if (settings.mailer === "sendmail") {
    // KNOWN transport, not yet ported (follow-up). Deliberately NOT
    // PHP's 'Unknown mail transport' message: claiming unknown for a
    // known transport would be a lie, and parity38 pins this wording.
    throw new ValidationMailError("Sendmail transport is not yet supported by the Next.js port (SMTP only)");
  }
  throw new ValidationMailError(`Unknown mail transport: ${settings.mailer}`);
}

/** Mirror of Email/Service.php _sendFromQueue(). Returns false only
 * for the demo-active case; true otherwise (even on failure, unless
 * throwExceptions rethrows). */
async function sendFromQueue(
  row: QueueRowFull, opts: { throwExceptions: boolean; validatedBcc?: string[] },
): Promise<boolean> {
  // Demo check FIRST: no state change when the demo extension is active.
  if (await isModuleActive("demo")) return false;
  const now = nowTimestamp();
  await getDbWrite().prepare("UPDATE email_queue SET status = 'sending', updated_at = ? WHERE id = ?")
    .run(now, row.id);
  // PHP_EOL appended on EVERY attempt; persisted on failure, logged on success/cancel.
  const content = row.content + "\n";
  const settings = await readEmailSettings();
  const parsed = parseBccAddresses(settings.bccEmail);
  // Batch runs parse once (PHP's per-instance cache); single sends parse here.
  const bcc = opts.validatedBcc ?? parsed.valid;
  if (opts.validatedBcc === undefined) {
    for (const bad of parsed.invalid) console.warn(`[email] Skipping invalid Bcc address: ${bad}`);
  }
  try {
    await deliverQueuedMail(row, content, settings, bcc);
  } catch (e) {
    console.error(`[email] Failed to send queued email ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    const priority = row.priority ? row.priority - 1 : row.priority;
    const tries = row.tries + 1;
    await getDbWrite().prepare(
      "UPDATE email_queue SET priority = ?, status = 'failed', tries = ?, content = ?, updated_at = ? WHERE id = ?",
    ).run(priority, tries, content, nowTimestamp(), row.id);
    if (tries > settings.cancelAfter) {
      if (settings.logEnabled) await logEmailRow(row, content);
      // UNPROTECTED in PHP: a delete failure propagates and aborts the batch.
      await getDbWrite().prepare("DELETE FROM email_queue WHERE id = ?").run(row.id);
    }
    if (opts.throwExceptions) {
      const message = e instanceof Error ? e.message : String(e);
      const finalMessage = e instanceof TransportMailError
        ? `Failed to send email via ${settings.mailer} with the exception: ${message}`
        : message;
      throw new FbError(truncateThrowMessage(finalMessage));
    }
    return true;
  }
  if (settings.logEnabled) await logEmailRow(row, content);
  try {
    await getDbWrite().prepare("DELETE FROM email_queue WHERE id = ?").run(row.id);
  } catch (e) {
    // PROTECTED in PHP: a delete failure is only logged.
    console.error(`[email] Failed to delete sent queued email ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}

/** Mirror of Email/Service.php batchSend(). Due rows only, priority
 * DESC + id ASC, queue_once limit (<=0 unlimited), time_limit budget
 * in minutes checked AFTER each send. Returns null like PHP (void). */
async function batchSendMail(): Promise<null> {
  const settings = await readEmailSettings();
  const parsed = parseBccAddresses(settings.bccEmail);
  const bcc = parsed.valid;
  for (const bad of parsed.invalid) console.warn(`[email] Skipping invalid Bcc address: ${bad}`);
  const limitClause = settings.queueOnce > 0 ? ` LIMIT ${settings.queueOnce}` : "";
  const rows = await getDb().prepare(
    `SELECT * FROM email_queue WHERE status IN ('unsent', 'pending', 'failed')
     ORDER BY priority DESC, id ASC${limitClause}`,
  ).all() as unknown as QueueRowFull[];
  const start = Date.now();
  const budgetMs = settings.timeLimit * 60 * 1000;
  for (const row of rows) {
    await sendFromQueue(row, { throwExceptions: false, validatedBcc: bcc });
    // PHP breaks AFTER the send when elapsed > budget; limit 0 never breaks.
    if (settings.timeLimit && Date.now() - start > budgetMs) break;
  }
  return null;
}

/** Queue one templated mail, then immediately attempt it when
 * send_now is set (PHP sendMail(..., $send_now, $throw_exceptions)).
 * Attachments are NOT plumbed (pre-existing template_send gap). */
async function queueOrSendNow(
  mail: { recipient: string; sender: string; subject: string; content: string;
    toName?: string | null; fromName?: string | null;
    clientId?: number | null; adminId?: number | null },
  sendNow: boolean, throwExceptions: boolean,
): Promise<void> {
  const id = await queueEmail(mail);
  if (!sendNow) return;
  const row = await queueRowById(id);
  if (!row) return;
  await sendFromQueue(row, { throwExceptions });
}

register("admin", "email", "batch_sendmail", async (ctx) => {
  requireAdmin(ctx);
  return batchSendMail();
});

register("admin", "email", "send_test", async (ctx) => {
  requireAdmin(ctx);
  const adminEmail = ctx.session?.admin?.email ?? "";
  await queueEmail({
    recipient: adminEmail,
    sender: adminEmail,
    subject: "Test email",
    content: "This is a test email from FOSSBilling.",
    adminId: ctx.session?.admin?.id ?? null,
  });
  return true;
});

// ---- Phase 5 R1 comms: template groups, reset, batch, send, queue ----

async function templateRowOrThrow(id: number): Promise<TemplateRowFull> {
  const row = await getDb().prepare("SELECT * FROM email_template WHERE id = ?").get(id) as unknown as TemplateRowFull | undefined;
  if (!row) throw new FbError("Email template not found");
  return row;
}

async function templateGroupIds(templateId: number): Promise<number[]> {
  return ((await getDb().prepare("SELECT admin_group_id FROM email_template_group WHERE email_template_id = ? ORDER BY admin_group_id ASC").all(templateId)) as unknown as { admin_group_id: number }[])
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

register("admin", "email", "template_group_get_list", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const template = await templateRowOrThrow(parseInt(ctx.params.id, 10));
  const ids = await templateGroupIds(template.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const groups = await getDb().prepare(
    `SELECT id, name, protected FROM admin_group WHERE id IN (${placeholders}) ORDER BY id ASC`
  ).all(...ids) as unknown as { id: number; name: string; protected: number }[];
  return groups.map((g) => ({ id: g.id, name: g.name, protected: !!g.protected }));
});

register("admin", "email", "template_group_add", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  if (!ctx.params.group_id) throw new FbError("Staff group ID was not passed");
  const template = await templateRowOrThrow(parseInt(ctx.params.id, 10));
  const groupId = parseInt(ctx.params.group_id, 10);
  const group = await getDb().prepare("SELECT id FROM admin_group WHERE id = ?").get(groupId) as unknown as { id: number } | undefined;
  if (!group) throw new FbError("Staff group not found");
  const existing = await getDb().prepare(
    "SELECT id FROM email_template_group WHERE email_template_id = ? AND admin_group_id = ?"
  ).get(template.id, groupId) as unknown as { id: number } | undefined;
  if (existing) return true;
  await getDbWrite().prepare(
    "INSERT INTO email_template_group (admin_group_id, created_at, email_template_id) VALUES (?, ?, ?)"
  ).run(groupId, nowTimestamp(), template.id);
  return true;
});

register("admin", "email", "template_group_remove", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  if (!ctx.params.group_id) throw new FbError("Staff group ID was not passed");
  const template = await templateRowOrThrow(parseInt(ctx.params.id, 10));
  const groupId = parseInt(ctx.params.group_id, 10);
  await getDbWrite().prepare(
    "DELETE FROM email_template_group WHERE email_template_id = ? AND admin_group_id = ?"
  ).run(template.id, groupId);
  return true;
});

register("admin", "email", "template_reset", async (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params.code) throw new FbError("Email template code was not passed");
  const code = ctx.params.code;
  const def = getDefaultTemplate(code, { code });
  if (!def) throw new FbError(`Email template ${code} does not have a file-backed default`);
  const id = await getOrCreateTemplateId(code, { code });
  const row = await templateRowOrThrow(id);
  if (row.is_custom) throw new FbError(`Custom email template ${code} cannot be reset to a default`);
  await applyRowChanges(id, { subject: def.subject, content: def.content, is_overridden: 0, last_error: null, error_checked_at: null });
  return true;
});

register("admin", "email", "batch_template_generate", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM email_template ORDER BY id ASC").all() as unknown as TemplateRowFull[];
  for (const row of rows) {
    if (row.is_custom) continue;
    const def = getDefaultTemplate(row.action_code);
    if (!def) continue;
    await applyRowChanges(row.id, { subject: def.subject, content: def.content, is_overridden: 0, last_error: null, error_checked_at: null });
  }
  return true;
});

async function syncFileBackedTemplates(): Promise<void> {
  for (const { code, module } of listDefaultTemplateCodes()) {
    if (!await isModuleActive(module)) continue;
    const def = getDefaultTemplate(code, { code });
    if (!def) continue;
    const existing = await getDb().prepare("SELECT * FROM email_template WHERE action_code = ?").get(code) as unknown as TemplateRowFull | undefined;
    if (!existing) {
      await createBuiltinRecord(code, def);
    } else if (!existing.is_custom) {
      await applyRowChanges(existing.id, syncBuiltinChanges(existing, def));
    }
  }
}

register("admin", "email", "batch_template_disable", async (ctx) => {
  requireAdmin(ctx);
  await syncFileBackedTemplates();
  await getDbWrite().prepare("UPDATE email_template SET enabled = 0").run();
  return true;
});

register("admin", "email", "batch_template_enable", async (ctx) => {
  requireAdmin(ctx);
  await syncFileBackedTemplates();
  await getDbWrite().prepare("UPDATE email_template SET enabled = 1").run();
  return true;
});

/** Email render context: stored/call vars + the email env globals. */
async function emailRenderCtx(vars: Record<string, unknown>): Promise<Record<string, unknown>> {
  const company = await companyContext();
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
async function parseTemplateOrThrow(row: TemplateRowFull, vars: Record<string, unknown>): Promise<[string, string]> {
  const [subjectTpl, contentTpl] = effectiveParts(row);
  const ctx = await emailRenderCtx(vars);
  try {
    const content = renderTemplateStrict(contentTpl, ctx);
    const subject = decodeEntities(renderTemplateStrict(subjectTpl, ctx));
    if (row.last_error !== null) {
      await applyRowChanges(row.id, { last_error: null, error_checked_at: null });
    }
    return [subject, content];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await applyRowChanges(row.id, { last_error: message, error_checked_at: nowTimestamp() });
    throw new FbError(message);
  }
}

register("admin", "email", "template_validate_all", async (ctx) => {
  requireAdmin(ctx);
  const rows = await getDb().prepare("SELECT * FROM email_template ORDER BY id ASC").all() as unknown as TemplateRowFull[];
  const results: { valid: number; invalid: number; errors: { id: number; action_code: string; error: string }[] } =
    { valid: 0, invalid: 0, errors: [] };
  for (const row of rows) {
    try {
      await parseTemplateOrThrow(row, await templateVars(row));
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

async function setTemplateVars(row: TemplateRowFull, vars: Record<string, unknown>): Promise<void> {
  const encoded = encryptV2(JSON.stringify(vars));
  await applyRowChanges(row.id, { vars: encoded });
}

register("admin", "email", "template_send", async (ctx) => {
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
  const id = await getOrCreateTemplateId(code, ctx.params);
  let row = await templateRowOrThrow(id);

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
    const groupIds = await templateGroupIds(row.id);
    if (groupIds.length) {
      const placeholders = groupIds.map(() => "?").join(",");
      staffList = await getDb().prepare(
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

  let customer: Awaited<ReturnType<typeof clientAdminArray>> | null = null;
  if (has("to_client")) {
    const clientRow = await findClientById(parseInt(ctx.params.to_client, 10));
    if (!clientRow) throw new FbError("Client not found");
    customer = await clientAdminArray(clientRow);
    vars.c = customer;
  }

  let oneStaff: { id: number; email: string; name: string; signature: string | null } | null = null;
  if (has("to_admin")) {
    const admin = await getDb().prepare("SELECT id, email, name, signature FROM admin WHERE id = ?").get(parseInt(ctx.params.to_admin, 10)) as unknown as
      { id: number; email: string; name: string; signature: string | null } | undefined;
    if (!admin) throw new FbError("Admin not found");
    oneStaff = admin;
    vars.c = { id: admin.id, email: admin.email, name: admin.name, signature: admin.signature };
  }

  await setTemplateVars(row, vars);
  row = await templateRowOrThrow(id);
  if (!row.enabled) return false;

  const emailConfig = await readExtensionConfig("mod_email");
  const company = await companyContext();
  const from = ctx.params.from
    ?? (typeof emailConfig.from_email === "string" && emailConfig.from_email ? emailConfig.from_email : null)
    ?? (company.email || null);
  const fromName = ctx.params.from_name
    ?? (typeof emailConfig.from_name === "string" && emailConfig.from_name ? emailConfig.from_name : null)
    ?? (company.name || null);
  if (!from) throw new FbError('The "from" email address cannot be empty');

  // R5e: send_now is honored (PHP sendTemplate -> sendMail send_now):
  // the mail is queued, then immediately attempted through the same
  // _sendFromQueue path batch_sendmail uses; throw_exceptions
  // rethrows the (possibly truncated) send error. Attachments are
  // still dropped (pre-existing gap, not transport work). PHP enters
  // the staff branch whenever to_staff was passed, even with an empty
  // staff list (sent stays false) — and it parses the template once
  // first, so a staff-referencing template still throws.
  const sendNowRaw = ctx.rawParams && "send_now" in ctx.rawParams ? ctx.rawParams.send_now : ctx.params.send_now;
  const throwRaw = ctx.rawParams && "throw_exceptions" in ctx.rawParams ? ctx.rawParams.throw_exceptions : ctx.params.throw_exceptions;
  const sendNow = phpTruthy(sendNowRaw);
  const throwExceptions = phpTruthy(throwRaw);
  let sent = false;
  if (has("to_staff")) {
    if (staffList.length === 0) {
      await parseTemplateOrThrow(row, vars);
    }
    for (const staff of staffList) {
      const staffVars = { ...vars, staff: { id: staff.id, email: staff.email, name: staff.name, signature: staff.signature } };
      const [subject, content] = await parseTemplateOrThrow(row, staffVars);
      await queueOrSendNow({
        recipient: staff.email, sender: from, subject, content,
        toName: staff.name, fromName, clientId: null, adminId: staff.id,
      }, sendNow, throwExceptions);
      sent = true;
    }
  } else if (oneStaff) {
    const [subject, content] = await parseTemplateOrThrow(row, vars);
    await queueOrSendNow({
      recipient: oneStaff.email, sender: from, subject, content,
      toName: oneStaff.name, fromName, clientId: null, adminId: oneStaff.id,
    }, sendNow, throwExceptions);
    sent = true;
  } else if (customer) {
    const [subject, content] = await parseTemplateOrThrow(row, vars);
    await queueOrSendNow({
      recipient: customer.email, sender: from, subject, content,
      toName: `${customer.first_name} ${customer.last_name}`, fromName, clientId: customer.id, adminId: null,
    }, sendNow, throwExceptions);
    sent = true;
  } else {
    const [subject, content] = await parseTemplateOrThrow(row, vars);
    await queueOrSendNow({
      recipient: ctx.params.to, sender: from, subject, content,
      toName: ctx.params.to_name ?? null, fromName, clientId: null, adminId: null,
    }, sendNow, throwExceptions);
    sent = true;
  }
  return sent;
});

register("admin", "email", "batch_template_delete", async (ctx) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (ids === undefined) throw new FbError("IDs were not passed");
  for (const id of ids) {
    const row = await templateRowOrThrow(id);
    if (!row.is_custom && hasDefaultTemplate(row.action_code)) continue;
    await getDbWrite().prepare("DELETE FROM email_template WHERE id = ?").run(id);
  }
  return true;
});

register("admin", "email", "batch_delete", async (ctx) => {
  requireAdmin(ctx);
  const ids = idsParam(ctx);
  if (ids === undefined) throw new FbError("IDs were not passed");
  for (const id of ids) {
    await getHistoryOrThrow(id);
    await getDbWrite().prepare("DELETE FROM activity_client_email WHERE id = ?").run(id);
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

register("admin", "email", "get_queue", async (ctx) => {
  requireAdmin(ctx);
  let rows = await getDb().prepare("SELECT * FROM email_queue").all() as unknown as QueueRow[];
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

async function clientHistoryOrThrow(clientId: number, id: number): Promise<HistoryRow> {
  const row = await getDb().prepare("SELECT * FROM activity_client_email WHERE id = ? AND client_id = ?").get(id, clientId) as unknown as HistoryRow | undefined;
  if (!row) throw new FbError("Email not found");
  return row;
}

async function historyListQuery(ctx: CallContext, clientId: number): Promise<HistoryRow[]> {
  let rows = await getDb().prepare("SELECT * FROM activity_client_email WHERE client_id = ?").all(clientId) as unknown as HistoryRow[];
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

register("client", "email", "get_list", async (ctx) => {
  requireClient(ctx);
  const clientId = ctx.session!.client!.id;
  return pager(ctx, (await historyListQuery(ctx, clientId)).map(historyToApi));
});

register("client", "email", "get", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  return historyToApi(await clientHistoryOrThrow(ctx.session!.client!.id, parseInt(ctx.params.id, 10)));
});

register("client", "email", "resend", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = await clientHistoryOrThrow(ctx.session!.client!.id, parseInt(ctx.params.id, 10));
  const client = await findClientById(row.client_id ?? -1);
  if (!client) throw new FbError("Client not found");
  await queueEmail({
    recipient: row.recipients,
    sender: row.sender,
    subject: row.subject,
    content: row.content_html ?? "",
    toName: `${client.first_name} ${client.last_name}`,
    fromName: await getSetting("company_name"),
    clientId: row.client_id,
  });
  return true;
});

register("client", "email", "delete", async (ctx) => {
  requireClient(ctx);
  if (!ctx.params.id) throw new FbError("Email ID was not passed");
  const row = await clientHistoryOrThrow(ctx.session!.client!.id, parseInt(ctx.params.id, 10));
  await getDbWrite().prepare("DELETE FROM activity_client_email WHERE id = ?").run(row.id);
  return true;
});
