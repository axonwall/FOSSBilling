# Phase 5 R2e findings — bounded system settings UI (LAST R2 batch)

## 0. What was built (uncommitted, on top of 81b7b28)

Next-native admin pages, Phase 1 style (server components, Tailwind,
`adminApi` from `@/lib/fossbilling`, session-cookie auth, no new
libraries, no new API endpoints). All data comes from endpoints TS
already serves; reads go via `fbCall` to the PHP origin, mutations via
`fbPost` to `/api/fb` (established Phase 1 pattern).

Routes:

- `/admin/system` — system settings. Editable form (39 fields, §1) +
  read-only table of all non-editable params + links to Currencies and
  Statistics. Files: `apps/nextjs/src/app/(admin)/admin/system/page.tsx`,
  `SettingsForm.tsx` (client), `apps/nextjs/src/lib/system-settings-fields.ts`
  (field catalog, non-client module).
- `/admin/system/currencies` — currency list from
  `admin/currency/get_list` (per_page 100) + default from `get_default`
  + a refresh button posting `admin/currency/update_rates` with `{}` and
  surfacing the result/error verbatim. Files: `currencies/page.tsx`,
  `RefreshRatesButton.tsx`.
- `/admin/system/stats` — 12 stats endpoints via `Promise.allSettled`
  (per-section error notes; whole-page box only if every call fails).
  Income summary, income vs refunds, products by active orders, product
  sales map, per-day series tables (last 14 days + period total),
  client/sales country tables (limit 10). Default date window
  throughout, no date picker in R2e. File: `stats/page.tsx`.
- Sidebar: `(admin)/layout.tsx` `NEXT_ROUTES` gained
  `system: "/admin/system"` (maps the PHP nav Settings subpage);
  static "Currencies" + "Statistics" links appended to the System
  section when it renders. The section renders only for callers with
  system module access, so gating is the group's own, fail-closed
  (same pattern as R2d's static Staff section, appended to an existing
  nav group rather than a new section). Currency and Stats modules
  declare no `fetchNavigation`, so static entries are the only option;
  PHP's system/update subpage (R1-deleted) is correctly dropped by the
  component filter since `NEXT_ROUTES` has no `system/update` entry.
- `apps/nextjs/src/lib/fossbilling.ts`: new `adminApi` wrappers with
  explicit `fbCall` generics — `systemGetParams`,
  `systemUpdateParams`, `currencyList`, `currencyGetDefault`,
  `currencyUpdateRates`, `statsSummaryIncome`, `statsIncomeVsRefunds`,
  `statsProductSummary`, `statsProductSales`, `statsIncome`,
  `statsRefunds`, `statsOrders`, `statsClients`, `statsInvoices`,
  `statsTickets`, `statsClientCountries`, `statsSalesCountries`.
- Error-box fix during verification: the settings, currencies, and
  stats pages now distinguish logged-out from denied viewers. A
  logged-in viewer without access gets the API error with no sign-in
  link (the link would be wrong — they are signed in, just denied);
  logged-out viewers keep the sign-in link. Implemented with
  `readSession` in-process, same import the admin layout uses.

## 1. Editable settings: 39 fields, verified = PHP template field AND DB-backed `setting` row

The form posts EXACTLY these fields and nothing else, because
`update_params` upserts every param it receives on both stacks.

- Company (21): company_name, company_email, company_tel,
  company_address_1/2/3, company_logo, company_logo_dark,
  company_favicon, company_number, company_vat_number,
  company_account_number, company_bank_name, company_bic,
  company_display_bank_info (checkbox), company_bank_info_pagebottom
  (textarea), hide_company_public (checkbox), company_signature,
  company_tos, company_privacy_policy, company_note (textareas).
- Invoices and funds (14): invoice_series, invoice_starting_number
  (number, min 1), invoice_cn_series, invoice_cn_starting_number,
  invoice_dn_series, invoice_dn_starting_number, invoice_due_days,
  invoice_auto_issue (checkbox), invoice_refund_logic (select:
  credit_note / negative_invoice / manual — options verified from the
  PHP invoice settings template), invoice_hash_lifetime_days,
  invoice_issue_days_before_expire, funds_min_amount, funds_max_amount.
- Nameservers (4): nameserver_1..4 (global default nameservers;
  currently empty strings in the table).

Fields absent from the current table but in the templates (e.g.
company_number, company_vat_number, bank fields) are created on save
by `update_params`, same as PHP; parity29's write case uses only
pre-existing params, and the full settings-table comparison proves
no rows were created or lost.

## 2. Read-only or omitted, and why

Read-only display (system-managed rows, shown in a table on the
settings page): theme, last_patch, schema_metadata_hash,
servicedomain_last_sync, invoice_overdue_invoked,
last_error_reporting_nudge, issue_invoice_days_before_expire (legacy
duplicate of invoice_issue_days_before_expire — displayed, not
edited; editing both would be ambiguous).

OMITTED from editing (noted on the page):

- locale, auto_detect_locale, interface/driver/ext cache settings,
  redis_* (incl. redis_password), memcached_*, countries,
  custom_interface, current_locale — all config.php-owned (R5
  installer). They are not in the settings table and `update_params`
  cannot change them; editing them in R2e would be fiction.
- Extension install/activate/config UI — EXCLUDED to R4, which
  replaces the extension mechanism. No extension UI was built.
- Currency create/edit/delete UI — endpoints exist but the UI is a
  later-batch option, named here, not built (R2e scope is list/rates
  view + refresh only).
- Stats date picker — later-batch option, not built; the page uses
  the endpoints' default window throughout.

## 3. Secret audit: CLEAN

Recursive key scan over rendered envelopes on both stacks
(`get_params`, currency list, stats income + product summary):
no `password`/`passwd`/`api_token`/`secret`/`salt`/`private_key`/
`webhook`/`smtp`/`captcha` keys at any depth, on either stack.
The settings table itself holds 38 rows and no credential secrets
(verified by inspection; bank fields company_account_number/
bank_name/bic are business data displayed as PHP does, not
credentials). The pages render no secret values in plaintext.
Notably, the config.php-owned cache/redis settings that WOULD hold
credentials are not in the settings table and are never rendered.

## 4. Currency refresh: parity design and its limits

Reference DB has exactly ONE currency (USD, default, rate 1, not
manual) and NO mod_currency extension config row.

- (a) Manual-only refresh: craft EUR manual 0.9, refresh both stacks,
  both return true, rates unchanged (no fetch happens on either
  stack). PASS.
- (b) Keyed-provider-no-key refresh: set config via
  `admin/extension/config_save` on the PHP stack
  (`{ext: "mod_currency", provider: "currency_data_api"}`; shared DB
  so TS reads the same encrypted row), refresh both stacks, identical
  missing-key error envelopes, no rate changes; clear afterwards.
  PASS — but only after fixing the case design: the first attempt
  was VACUOUS (both stacks returned true) because with no
  non-manual, non-default currency present, `update_rates` never
  fetches (default pinned, manual skipped). The corrected case
  crafts a non-manual EUR first so the provider path actually
  executes. Lesson recorded: a refresh case without a fetchable
  currency proves nothing.
- (c) Live refresh stays UNVERIFIED-LIVE (standing R1 item): TS Node
  fetch reaches the exchangerate API, PHP's fetch dies at the
  sandbox TLS layer, so live refresh cannot be envelope-equal.
  Documented, not faked.
- config_save-clear semantics found: `config_save` NEVER deletes
  the row — it rewrites the encrypted config, so "clear" leaves a
  row holding `{"ext": ...}` with no provider. parity29 asserts the
  effective config (config_get has no provider key), not row
  absence; the full-DB restore in finally removes the row, so the
  reference DB is untouched.

## 5. Non-super viewer outcomes (TS pages, crafted support-only persona)

- `/admin/system`: 725 error box ("You do not have access to the
  system module"), NO "Save settings" form rendered.
- `/admin/system/currencies`: 725 error box ("...currency module"),
  NO table rendered.
- `/admin/system/stats`: 725 error box ("...stats module"), NO
  sign-in link (viewer is signed in), NO stats data rendered.
- Dashboard sidebar for the persona: NO `/admin/system/currencies`
  or `/admin/system/stats` links (System section does not render
  without system access).
All asserted on the TS stack in parity29 §G.

## 6. Divergences and notes (no hidden edits)

- PRE-EXISTING TS divergence, documented not fixed (pages-only
  scope): TS `update_params` does NOT validate
  invoice_starting_number; PHP validates it as a positive whole
  number. The R2e form enforces min=1 in the browser. A server-side
  validation port is a separate small batch if wanted.
- Stats series timestamps: PHP emits second precision, TS
  millisecond precision, and PHP's own consecutive calls differ by a
  second, so exact envelope equality for default-window flot series
  is unachievable even in principle. Per the parity15 practice
  documented in `stats.ts` itself, parity29 compares the six series
  endpoints by calendar day + value (same days, same values, same
  length). No `stats.ts` change: flooring TS to seconds would not
  fix cross-stack second straddles.
- React SSR splits dynamic text with `<!-- -->` comment nodes
  ("Default currency: <!-- -->USD"), so the currencies page check
  asserts the label and the USD marker separately. Not a product
  issue; a parity-harness note.
- TS error envelopes are always HTTP 200 by seam convention (PHP
  answers 4xx with the same envelope). parity29 compares envelopes
  only, never HTTP status, except page-smoke 200s.
- PHP `update_params` validates all-then-writes-all and throws
  `You do not have permission to update the parameter:param` for
  denied params; PHP's `canUpdateParam` returns true for everything
  EXCEPT company fields without `manage_company_details` and
  company-legal fields without `manage_company_legal` — i.e. PHP's
  update surface is effectively everything, so the R2e form's field
  list IS the allowlist. parity29's write case runs as super-admin
  on both stacks.
- TS `update_params` route gate enforces the system/update_params
  key check from R2a; page reads go via `fbCall` to the PHP origin
  (PHP guards apply on reads).

## 7. Gates (all observed, none claimed from backgrounded runs)

- `npx tsc --noEmit`: clean.
- `npm run build`: clean (exit code checked), new routes confirmed
  in build output (`admin/system/`, `currencies/`, `stats/`).
- parity29 (new suite): **62/62** — page smoke (super + logged-out),
  secret audit, settings-write equivalence + full settings-table
  restore proof, currency list/default + both refresh cases, 12
  stats endpoints, non-super viewer behavior.
- parity28: **128/128**. parity27: **27/27**. parity26: **62/62**.
  parity25: **203/203**.
- Fixtures: **13/13 on BOTH stacks** (results-php.json,
  results-next.json). Fixture-runner traps respected: :3001 killed
  before the Next run; the surviving next-server child killed by
  PID afterwards (a `pkill -f` bracket pattern self-matched the
  exec shell this run and SIGTERMed it — kill by PID, not pattern,
  in this environment; no work was lost, servers were restarted
  and verified 200 before parity21).
- parity21: **194/203, exactly the known 9 diffs, no new ones**:
  3 tld_delete (verified upstream MySQL-only TRIM defect), 1
  sd_reg_available (Enom), 4 downstream .cap24 survivors, 1
  dl_admin_send_file_missing_stored (HTTP-status harness artifact:
  TS error envelopes are always HTTP 200).
- DB invariants clean before AND after every suite, including
  admin 2 / groups 3 / members 1; settings table verified restored
  (38 rows, values identical to the pre-run snapshot, incl. id 52
  `2026-10-26 03:24:56`).

## 8. Left unverified / later batches

- Browser click-through of the new forms was NOT exercised (no live
  browser in this worker); forms proven at API path (fbPost→seam,
  fbCall→PHP origin) + rendering only. Same standing caveat as R2d.
- Live currency-rate refresh equivalence (standing R1 item, §4c).
- Currency create/edit/delete UI and a stats date picker (named
  later-batch options, §2).
- Extension install/activate/config UI (R4).
- config.php-owned settings editing (R5 installer).

## 9. What this completes

R2 is now COMPLETE (R2a–R2e): full API permission enforcement +
nav + sidebar (R2a), core admin sections (R2b), products + service
detail (R2c), staff + groups (R2d), system settings + currencies +
stats (R2e). Next fork for Josh: **R3** (Postgres driver behind
db.ts + one-way MySQL importer) **or the push tap** for the stack
through R2e. Whole local stack remains unpushed, per the standing
rule that push/PR/merge are separate explicit taps.
