// Email queueing — the TS counterpart of PHP's Email service.
// Everything lands in email_queue as 'pending'; delivery (SMTP) is
// out of scope for the strangler seam, exactly as batch_sendmail
// in the sandbox leaves rows 'sending' with no transport behind
// them. Template rendering uses the twig.ts subset renderer.

import { findDefaultCurrency, getDb, getDbWrite, getSetting, listCurrencies, nowTimestamp } from "./db";
import { templateVars } from "./emailDefaults";
import { renderTemplate } from "./twig";
import { publicOrigin } from "./public-url";

interface TemplateRow {
  id: number; action_code: string; category: string | null; enabled: number;
  subject: string; description: string | null; content: string | null;
  is_custom: number; is_overridden: number; last_error: string | null;
  vars?: string | null; error_checked_at?: string | null;
}

export async function findEmailTemplate(codeOrId: string | number): Promise<TemplateRow | undefined> {
  const db = getDb();
  const row = (typeof codeOrId === "number"
    ? await db.prepare("SELECT * FROM email_template WHERE id = ?").get(codeOrId)
    : await db.prepare("SELECT * FROM email_template WHERE action_code = ?").get(codeOrId)) as unknown as TemplateRow | undefined;
  return row;
}

export async function listEmailTemplates(): Promise<TemplateRow[]> {
  return await getDb().prepare("SELECT * FROM email_template ORDER BY id ASC").all() as unknown as TemplateRow[];
}

export async function templateToApi(t: TemplateRow, withContent = false) {
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
    // Stored vars decrypt via crypt.ts (same v2: format PHP writes);
    // undecryptable or absent vars read as [] exactly like PHP getVars.
    const vars = await templateVars({
      id: t.id, action_code: t.action_code, category: t.category, enabled: t.enabled,
      subject: t.subject, content: t.content, description: t.description, vars: t.vars ?? null,
      is_custom: t.is_custom, is_overridden: t.is_overridden, last_error: t.last_error,
      error_checked_at: t.error_checked_at ?? null,
    });
    // PHP getVars returns [] for an empty var set; an encrypted "{}"
    // must read the same way, not as an empty object.
    base.vars = (vars && typeof vars === "object" && !Array.isArray(vars)
      && Object.keys(vars).length === 0) ? [] : vars;
    base.subject_override = t.is_custom ? null : t.subject;
    base.content_override = t.is_custom ? null : t.content;
  }
  return base;
}

export async function queueEmail(row: {
  recipient: string; sender: string; subject: string; content: string;
  toName?: string | null; fromName?: string | null;
  clientId?: number | null; adminId?: number | null; priority?: number;
}): Promise<number> {
  const now = nowTimestamp();
  const info = await getDbWrite().insertAndGetId(`INSERT INTO email_queue (recipient, sender, subject, content, to_name, from_name, client_id, admin_id, priority, tries, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`, row.recipient, row.sender, row.subject, row.content, row.toName ?? null, row.fromName ?? null, row.clientId ?? null, row.adminId ?? null, row.priority ?? 1, now, now);
  return Number(info);
}

export async function companyContext(): Promise<Record<string, unknown>> {
  return {
    name: await getSetting("company_name"),
    email: await getSetting("company_email"),
    signature: await getSetting("company_signature"),
    // PHP's company www is SYSTEM_URL verbatim (trailing slash on the
    // reference, from the config url) — same slashed shape as the
    // API's systemUrl(), not the bare origin.
    www: publicOrigin() + "/",
  };
}

/** Render a template by action code and queue it. Returns the queue
 * id, or null when the template is missing/disabled. Never throws —
 * a broken email must not break the money flow that triggered it
 * (PHP dispatches these through event listeners). */
export async function queueTemplatedEmail(
  actionCode: string,
  recipient: string,
  ctx: Record<string, unknown>,
  opts: { toName?: string | null; clientId?: number | null; adminId?: number | null } = {}
): Promise<number | null> {
  try {
    const t = await findEmailTemplate(actionCode);
    if (!t || !t.enabled) return null;
    const company = await companyContext();
    const formats: Record<string, string> = {};
    for (const c of await listCurrencies()) {
      if (c.format_pattern) formats[c.code] = c.format_pattern;
    }
    const full: Record<string, unknown> = {
      ...ctx,
      guest: { system_company: company, system_email: { signature: company.signature } },
      default_currency: (await findDefaultCurrency())?.code ?? "USD",
      __baseUrl: publicOrigin() + "/",
      __currencyFormats: formats,
    };
    const subject = renderTemplate(t.subject, full);
    const content = renderTemplate(t.content ?? "", full);
    return await queueEmail({
      recipient,
      sender: String(company.email ?? ""),
      fromName: String(company.name ?? ""),
      toName: opts.toName ?? null,
      subject,
      content,
      clientId: opts.clientId ?? null,
      adminId: opts.adminId ?? null,
    });
  } catch {
    return null;
  }
}

/** Build the { c, invoice } context the invoice templates expect. */
export async function invoiceEmailContext(invoiceId: number): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const inv = await db.prepare("SELECT * FROM invoice WHERE id = ?").get(invoiceId) as Record<string, unknown> | undefined;
  if (!inv) return null;
  const client = await db.prepare("SELECT * FROM client WHERE id = ?").get(inv.client_id as number) as Record<string, unknown> | undefined;
  if (!client) return null;
  const items = await db.prepare("SELECT DISTINCT rel_id AS order_id FROM invoice_item WHERE invoice_id = ? AND type = 'order' AND rel_id IS NOT NULL").all(invoiceId) as unknown as { order_id: number }[];
  const orders = await Promise.all(items.map(async ({ order_id }) => {
    const o = await db.prepare("SELECT o.id, o.expires_at, p.title AS product_name FROM client_order o LEFT JOIN product p ON p.id = o.product_id WHERE o.id = ?").get(order_id) as Record<string, unknown> | undefined;
    return o ?? { id: order_id };
  }));
  const sums = await db.prepare(
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

export async function queueInvoiceEmail(
  actionCode: string,
  invoiceId: number,
  extraVars: Record<string, unknown> = {},
): Promise<number | null> {
  // Never throws: an email-context failure must not break the money
  // flow that triggered it (PHP dispatches these via listeners).
  try {
    const ctx = await invoiceEmailContext(invoiceId);
    if (!ctx) return null;
    const client = ctx.c as Record<string, unknown>;
    return await queueTemplatedEmail(actionCode, String(client.email), { ...ctx, ...extraVars }, {
      toName: `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || null,
      clientId: Number(client.id),
    });
  } catch {
    return null;
  }
}
