// Email queueing — the TS counterpart of PHP's Email service.
// Everything lands in email_queue as 'pending'; delivery (SMTP) is
// out of scope for the strangler seam, exactly as batch_sendmail
// in the sandbox leaves rows 'sending' with no transport behind
// them. Template rendering uses the twig.ts subset renderer.

import { findDefaultCurrency, getDb, getDbWrite, getSetting, listCurrencies, nowTimestamp } from "./db";
import { renderTemplate } from "./twig";

interface TemplateRow {
  id: number; action_code: string; category: string | null; enabled: number;
  subject: string; description: string | null; content: string | null;
  is_custom: number; is_overridden: number; last_error: string | null;
}

export function findEmailTemplate(codeOrId: string | number): TemplateRow | undefined {
  const db = getDb();
  const row = (typeof codeOrId === "number"
    ? db.prepare("SELECT * FROM email_template WHERE id = ?").get(codeOrId)
    : db.prepare("SELECT * FROM email_template WHERE action_code = ?").get(codeOrId)) as unknown as TemplateRow | undefined;
  return row;
}

export function listEmailTemplates(): TemplateRow[] {
  return getDb().prepare("SELECT * FROM email_template ORDER BY id ASC").all() as unknown as TemplateRow[];
}

export function templateToApi(t: TemplateRow, withContent = false) {
  // PHP semantics: for built-in templates the DB row IS the override
  // of the file-backed default, so subject_override/content_override
  // echo the row; custom templates report null overrides.
  const base: Record<string, unknown> = {
    id: t.id,
    action_code: t.action_code,
    category: t.category,
    enabled: !!t.enabled,
    subject: t.subject,
    description: t.description,
    is_custom: !!t.is_custom,
    has_default: !t.is_custom,
    is_overridden: !!t.is_overridden,
    has_error: t.last_error !== null && t.last_error !== undefined,
    last_error: t.last_error ?? null,
  };
  if (withContent) {
    base.content = t.content;
    base.vars = null; // stored encrypted at rest; TS does not decrypt
    base.subject_override = t.is_custom ? null : t.subject;
    base.content_override = t.is_custom ? null : t.content;
  }
  return base;
}

export function queueEmail(row: {
  recipient: string; sender: string; subject: string; content: string;
  toName?: string | null; fromName?: string | null;
  clientId?: number | null; adminId?: number | null; priority?: number;
}): number {
  const now = nowTimestamp();
  const info = getDbWrite().prepare(
    `INSERT INTO email_queue (recipient, sender, subject, content, to_name, from_name, client_id, admin_id, priority, tries, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`
  ).run(row.recipient, row.sender, row.subject, row.content, row.toName ?? null,
        row.fromName ?? null, row.clientId ?? null, row.adminId ?? null,
        row.priority ?? 1, now, now);
  return Number(info.lastInsertRowid);
}

export function companyContext(): Record<string, unknown> {
  return {
    name: getSetting("company_name"),
    email: getSetting("company_email"),
    signature: getSetting("company_signature"),
    www: process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080",
  };
}

/** Render a template by action code and queue it. Returns the queue
 * id, or null when the template is missing/disabled. Never throws —
 * a broken email must not break the money flow that triggered it
 * (PHP dispatches these through event listeners). */
export function queueTemplatedEmail(
  actionCode: string,
  recipient: string,
  ctx: Record<string, unknown>,
  opts: { toName?: string | null; clientId?: number | null } = {}
): number | null {
  try {
    const t = findEmailTemplate(actionCode);
    if (!t || !t.enabled) return null;
    const company = companyContext();
    const formats: Record<string, string> = {};
    for (const c of listCurrencies()) {
      if (c.format_pattern) formats[c.code] = c.format_pattern;
    }
    const full: Record<string, unknown> = {
      ...ctx,
      guest: { system_company: company, system_email: { signature: company.signature } },
      default_currency: findDefaultCurrency()?.code ?? "USD",
      __baseUrl: (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080") + "/",
      __currencyFormats: formats,
    };
    const subject = renderTemplate(t.subject, full);
    const content = renderTemplate(t.content ?? "", full);
    return queueEmail({
      recipient,
      sender: String(company.email ?? ""),
      fromName: String(company.name ?? ""),
      toName: opts.toName ?? null,
      subject,
      content,
      clientId: opts.clientId ?? null,
    });
  } catch {
    return null;
  }
}

/** Build the { c, invoice } context the invoice templates expect. */
export function invoiceEmailContext(invoiceId: number): Record<string, unknown> | null {
  const db = getDb();
  const inv = db.prepare("SELECT * FROM invoice WHERE id = ?").get(invoiceId) as Record<string, unknown> | undefined;
  if (!inv) return null;
  const client = db.prepare("SELECT * FROM client WHERE id = ?").get(inv.client_id as number) as Record<string, unknown> | undefined;
  if (!client) return null;
  const items = db.prepare("SELECT DISTINCT rel_id AS order_id FROM invoice_item WHERE invoice_id = ? AND type = 'order' AND rel_id IS NOT NULL").all(invoiceId) as unknown as { order_id: number }[];
  const orders = items.map(({ order_id }) => {
    const o = db.prepare("SELECT o.id, o.expires_at, p.title AS product_name FROM \"order\" o LEFT JOIN product p ON p.id = o.product_id WHERE o.id = ?").get(order_id) as Record<string, unknown> | undefined;
    return o ?? { id: order_id };
  });
  const sums = db.prepare(
    `SELECT COALESCE(SUM(price * quantity), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN taxed THEN price * quantity ELSE 0 END), 0) AS taxable
     FROM invoice_item WHERE invoice_id = ?`
  ).get(invoiceId) as { subtotal: number; taxable: number };
  const taxrate = parseFloat(String(inv.taxrate ?? 0)) || 0;
  const total = Math.round((sums.subtotal + (sums.taxable * taxrate) / 100) * 100) / 100;
  return {
    c: client,
    invoice: {
      ...inv,
      serie_nr: `${inv.serie ?? ""}${String(inv.nr ?? inv.id).padStart(5, "0")}`,
      total,
      orders,
    },
  };
}

export function queueInvoiceEmail(actionCode: string, invoiceId: number): number | null {
  const ctx = invoiceEmailContext(invoiceId);
  if (!ctx) return null;
  const client = ctx.c as Record<string, unknown>;
  return queueTemplatedEmail(actionCode, String(client.email), ctx, {
    toName: `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || null,
    clientId: Number(client.id),
  });
}
