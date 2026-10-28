/**
 * Phase 5 R2e: the editable system-settings surface.
 *
 * Every field here satisfies BOTH conditions:
 *  - it is a field of a PHP settings form (System mod_system_settings or
 *    Invoice mod_invoice_settings, or the Servicedomain nameserver
 *    defaults), so its meaning is verified against the PHP template;
 *  - it is a DB-backed `setting` row, written by admin/system/
 *    update_params on both stacks.
 *
 * The form posts EXACTLY these fields and nothing else. That matters
 * because update_params upserts every param it receives (PHP and TS
 * alike): posting the whole params object back would let any stray
 * field write through. Fields not listed here are rendered read-only
 * on the settings page (system-managed rows) or omitted entirely
 * (config.php-owned values — locale, cache, redis/memcached — which
 * belong to the R5 installer, not to this form).
 *
 * Types: "text" | "textarea" | "number" | "checkbox" | "select".
 * Select options are [value, label] pairs. Checkbox values in the DB
 * are "1"/"0" strings; the form always posts "1" or "0" explicitly.
 */

export type FieldType = "text" | "textarea" | "number" | "checkbox" | "select";

export interface SettingsField {
  name: string;
  label: string;
  type: FieldType;
  options?: [string, string][];
  min?: number;
}

export interface SettingsGroup {
  title: string;
  note?: string;
  fields: SettingsField[];
}

export const EDITABLE_SETTINGS: SettingsGroup[] = [
  {
    title: "Company",
    note: "Shown on invoices and the client area. PHP gates the company and company-legal subsets behind the system manage_company_details / manage_company_legal permissions; the seam route gate enforces the same keys.",
    fields: [
      { name: "company_name", label: "Name", type: "text" },
      { name: "company_email", label: "Email", type: "text" },
      { name: "company_tel", label: "Phone", type: "text" },
      { name: "company_address_1", label: "Address line 1", type: "text" },
      { name: "company_address_2", label: "Address line 2", type: "text" },
      { name: "company_address_3", label: "Address line 3", type: "text" },
      { name: "company_logo", label: "Logo path", type: "text" },
      { name: "company_logo_dark", label: "Dark logo path", type: "text" },
      { name: "company_favicon", label: "Favicon path", type: "text" },
      { name: "company_number", label: "Company number", type: "text" },
      { name: "company_vat_number", label: "VAT number", type: "text" },
      { name: "company_account_number", label: "Account number", type: "text" },
      { name: "company_bank_name", label: "Bank name", type: "text" },
      { name: "company_bic", label: "BIC / SWIFT", type: "text" },
      { name: "company_display_bank_info", label: "Display bank info on invoices", type: "checkbox" },
      { name: "company_bank_info_pagebottom", label: "Bank info footer", type: "textarea" },
      { name: "hide_company_public", label: "Hide company details publicly", type: "checkbox" },
      { name: "company_signature", label: "Signature", type: "textarea" },
      { name: "company_tos", label: "Terms of service", type: "textarea" },
      { name: "company_privacy_policy", label: "Privacy policy", type: "textarea" },
      { name: "company_note", label: "About / note", type: "textarea" },
    ],
  },
  {
    title: "Invoices and funds",
    note: "invoice_starting_number is validated by PHP (positive whole number); the TS endpoint does not validate it, so this input enforces min=1 in the browser — see findings-r2e.md.",
    fields: [
      { name: "invoice_series", label: "Invoice series prefix", type: "text" },
      { name: "invoice_starting_number", label: "Next invoice number", type: "number", min: 1 },
      { name: "invoice_cn_series", label: "Credit note series prefix", type: "text" },
      { name: "invoice_cn_starting_number", label: "Next credit note number", type: "number", min: 1 },
      { name: "invoice_dn_series", label: "Debit note series prefix", type: "text" },
      { name: "invoice_dn_starting_number", label: "Next debit note number", type: "number", min: 1 },
      { name: "invoice_due_days", label: "Invoice due days", type: "number", min: 0 },
      { name: "invoice_auto_issue", label: "Auto-issue invoices", type: "checkbox" },
      {
        name: "invoice_refund_logic",
        label: "Refund logic",
        type: "select",
        options: [
          ["credit_note", "Credit note"],
          ["negative_invoice", "Negative invoice"],
          ["manual", "Manual"],
        ],
      },
      { name: "invoice_hash_lifetime_days", label: "Invoice link lifetime (days)", type: "number", min: 0 },
      { name: "invoice_issue_days_before_expire", label: "Issue days before expiry", type: "number", min: 0 },
      { name: "funds_min_amount", label: "Add-funds minimum amount", type: "number", min: 0 },
      { name: "funds_max_amount", label: "Add-funds maximum amount", type: "number", min: 0 },
    ],
  },
  {
    title: "Nameservers",
    note: "Global default nameservers for new domains.",
    fields: [
      { name: "nameserver_1", label: "Nameserver 1", type: "text" },
      { name: "nameserver_2", label: "Nameserver 2", type: "text" },
      { name: "nameserver_3", label: "Nameserver 3", type: "text" },
      { name: "nameserver_4", label: "Nameserver 4", type: "text" },
    ],
  },
];

export const EDITABLE_PARAM_NAMES: string[] = EDITABLE_SETTINGS.flatMap((g) =>
  g.fields.map((f) => f.name),
);
