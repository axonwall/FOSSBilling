# Phase 5 R1 — comms batch findings (email leftovers + massmailer + notification)

Batch scope: 32 endpoints → TS-served 346 → **378/579**.
Email remaining 16 (of 29; 13 already TS-served in Phase 4 batch 2):
template_group_get_list/add/remove, template_reset, batch_template_generate,
batch_template_disable, batch_template_enable, template_validate_all,
template_send, batch_template_delete, batch_delete, get_queue, plus client
get_list/get/resend/delete. Massmailer: all 11 admin endpoints.
Notification: all 5 admin endpoints.

Gate: **parity20 146/146** (live TS vs live PHP, same sequence,
snapshot/restore between stacks, incl. `sqlite_sequence` high-water
marks — see below). Fixtures **13/13 both stacks**. Regressions:
parity7 19/19, parity9 16/16, parity10 14/14, parity11 16/16,
parity12 12/12, parity13 47/47, parity14 44/44, parity15 20/20,
parity16 67/67, parity17 77/77, parity18 114/114 + 1 documented
divergence, parity19 54/54.

## Environment setup (kept, reversible)

Massmailer and notification were not installed/activated on the
reference install: PHP returned error 715 for every endpoint and the
`mod_massmailer` table did not exist. Both were activated via the PHP
admin extension API (`admin/extension/activate`, type=mod). Activation
ran massmailer's `install()`, creating `mod_massmailer`
(id, from_email, from_name, subject, content, filter, status, sent_at,
created_at, updated_at) and seeding default config (extension_meta id
13, `mod_massmailer`/`config`, encrypted) = `{limit: '2', interval:
'10', test_client_id: 1}`. Reversible via deactivate (removes the
extension row; the table remains).

## Crypto interop (new `src/server/crypt.ts`)

PHP at-rest encryption is reproducible in Node: AES-256-CBC, key =
PBKDF2-SHA256(passphrase = config.php `info.salt`, salt string
`'fossbilling_salt'`, 100000 iterations, 32 bytes), IV prepended,
base64, `v2:` prefix. This unlocks template vars decryption, extension
config reads (email from_email/from_name, massmailer test_client_id),
and interoperable setVars encryption. TS reads the passphrase from env
`FB_INFO_SALT ?? FB_CALLBACK_SALT` (the sandbox passes
`FB_CALLBACK_SALT` = info.salt to the Next server).

## Strict Twig (PHP email env is strict; proven by capture, not config)

- Missing top-level variables are rendering errors
  (`Email template rendering error: Variable "c" does not exist in
  "__string_template__<hash>" at line 1.`, code 9999); syntax errors
  throw via SandboxedStringRenderer with prefix `Email template`.
  Template-name hashes are not reproducible — parity scrubs
  `__string_template__[0-9a-f]+`.
- `renderTemplateStrict` (new in `twig.ts`) now counts `{% for x in
  %}` loop variables and `{% set %}` names as defined, and skips Twig
  keywords/operators (`not`, `and`, `or`, `is`, `defined`, ...) when
  scanning expressions. Without this, baseline templates
  `mod_invoice_created` (loop var `order`), `mod_support_ticket_open`
  (set var `is_guest_ticket`) falsely validated invalid.
- `template_create` renders subject then content with empty vars,
  strictly, before inserting (PHP `templateCreate` order); a failure
  creates nothing. `_parse` (send/validate path) renders content then
  subject; success clears a stored error, failure stores `last_error` +
  `error_checked_at` and rethrows.
- Known gap, unchanged: the subset renderer does not *evaluate*
  `{% set %}`. Validate treats set names as defined (correct), but a
  send of a set-dependent template (support templates compute
  `is_guest_ticket` via set) renders the falsy branch in TS while PHP
  evaluates it. No parity case covers a support-template send; this
  joins the `template_render` system-context-only gap as follow-up
  work, not a found divergence.

## Template list/get semantics (fixed this batch)

- `template_get_list` default order is category ASC, action_code ASC
  (NULL categories first), not id order. TS sorts that way when no
  explicit sort param is given.
- The list mapping coerces nulls to `''` (PHP `$item['x'] ?? ''`);
  `template_get` keeps nulls. TS mirrors both shapes now.
- `template_get` vars for an empty var set is `[]`, not `{}`: PHP
  `getVars` returns an empty array, and an encrypted `"{}"` must read
  the same way. Fixed in `templateToApi`.
- `template_send` vars = request data minus PHP's unset list (routing
  keys + `default_*` + `code` + `send_now`/`throw_exceptions`/
  `attachment`); `CSRFToken` never reaches the API layer in PHP.
  Staff (`staff` = first staff's safe vars) and client (`c`) vars are
  augmented the same way PHP augments them before `setVars`.
  Verified: auto-created `comms23_newcode` reads back vars `[]`.

## Pinned semantics (abridged; full sequence in parity20.py)

- Groups: template 7 baseline groups [1,2,3]; missing id → "Email ID
  was not passed"; missing template → "Email template not found"; bad
  group → "Staff group not found"; add-duplicate → true, no dup row;
  remove-absent → true; output `[{id, name, protected:bool}]` id ASC.
- `template_send`: missing code → "Template code not passed";
  no receiver → "Receiver is not defined..."; `client_billing_email`
  set → "client_billing_email cannot be set via the API"; to+to_client
  → combined-parameters error; to_admin alone → the no-receiver error
  (the API check excludes to_admin); to_client 99999 → "Client not
  found"; to_staff with no groups → result **false**, no queue row;
  to_staff grouped → true, one queue row to admin@phase0.local (admin 2
  excluded — system_name 'cron'), admin_id=1; disabled → false, no
  queue row; unknown code + defaults → creates custom row (category
  `custom`, enabled **false**), returns false; unknown code with a file
  default → creates built-in row (category `email`, enabled true) and
  queues rendered mail. Queue rows: recipient/sender
  `support@yourcompany.com`, from_name `Company Name`, priority 1,
  tries 0, status pending.
- `get_queue`: default order priority DESC, id ASC; filters status +
  client_id only; item shape excludes sender/from_name/client_id/
  admin_id/priority; pager pages=0 when empty.
- `validate_all` with seeds: **{valid: 30, invalid: 3}** (broken
  `{% if %}` unclosed, `{{ nosuchvar }}`, staff var with no staff
  vars). Baseline untouched: **24 valid / 0 invalid**.
- Batch template delete: missing ids → "IDs were not passed";
  [custom, builtin-with-default] → custom deleted, builtin skipped
  (true); [custom, 99999] → "Email template not found" AFTER the
  custom was deleted (partial). History batch_delete: missing id →
  "Email not found".
- Reset: override then reset `mod_invoice_paid` → subject back to file
  default; custom reset → "... does not have a file-backed default";
  unknown code → same; missing code → "Email template code was not
  passed".
- `batch_template_generate` regenerates existing built-ins only (no
  creation): totals 32 → 32. `batch_template_disable/enable` call
  **sync** first (creates missing file-backed rows): totals 30 → **52**
  after disable (22 new rows of 51 template files); enable restores
  enabled=1 everywhere. Staff-category created rows get ALL admin
  groups assigned.
- Client email: get_list forces own client_id; filters
  id/sender/recipient/subject/search/date_from/date_to; get other
  client's row → "Email not found"; missing id → "Email ID was not
  passed"; resend → true + queue row (content = **content_html only**,
  to_name = client first+last, from_name = company_name, client_id
  set); delete → true then get → "Email not found". Admin resend
  shares the content_html-only semantics ("Client not found" when the
  client_id is set but the client is missing).
- Massmailer: create requires subject ("Message subject was not
  passed"); defaults from = company email/name, filter `[]`, status
  `draft`; no content → default content verbatim from PHP source (690
  chars, byte-diffed identical). `_getMessage`'s RequiredParams is on
  a private method and is NOT enforced: missing id on
  get/update/preview → **"Message not found"**. Update: strict filter
  normalization — bad enum → `Mass mail filter contains invalid
  values for "client_status"`; unknown key → `... for "nope"`; empty
  from_name → "Message from name cannot be empty"; bad from_email →
  "Email address is invalid"; filter serialized (strict) BEFORE
  from_* checks. Enums deduped in allowed order; id filters
  (client_groups→client_group, has_order→product) must exist or
  strict-throw; only non-empty fields survive. Receivers: DISTINCT
  client ids, email non-empty + valid, ORDER BY id DESC (all 3
  reference clients → [3,2,1]; client_groups [1] → [] because
  client_group_members is empty). Preview (test_client_id=1): renders
  subject (HTML-entity-decoded) + content with client 1 as `c`;
  include_recipients truthy (any value except ''/'0'/absent) →
  recipients in receivers order. **send_test/send in dev queue
  NOTHING** (PHP sendMessage early-returns outside production):
  send_test → true; empty content → "Add some content before sending
  message"; send → status `sent`, sent_at set, still no queue rows.
  Copy → subject + " (Copy)", status draft, filter copied raw.
  get_test_client → client 1's email (or "Unknown" on any failure).
  List: filters id/status/search; sort set
  id/subject/status/from_email/from_name/sent_at/created_at/updated_at;
  sorted → id tiebreak same direction; default created_at DESC with
  NO tiebreak.
- Notification: rows in extension_meta (extension `mod_notification`,
  meta_key `message`, rel_type `staff`, rel_id string `'1'`,
  client_id null); get_list filters id/search(meta_value
  LIKE)/date_from/date_to, sort id/created_at/updated_at, default id
  DESC; shape = ExtensionMeta toApiArray; get/delete missing id param
  → "Notification ID was not passed"; missing row → "Notification
  message was not found"; add without message → result **false** (not
  an error); add with `""` → creates a row; delete_all deletes by
  extension+meta_key.

## Parity-script lesson (sqlite_sequence)

Tables with AUTOINCREMENT keep high-water marks in
`sqlite_sequence`; row-only restore leaves the second run's fresh ids
above the first run's. parity20 snapshots and restores
`sqlite_sequence` for all six touched tables. Future dual-run parity
scripts must do the same.

## Regression triage (state drift, not code regressions)

parity15 fell to 7/20 and parity18 to 109/114 on first re-run after
the comms batch. Live PHP-vs-TS spot checks of every failing case
(stats summaries, invoice statuses, transaction lists) matched
exactly on the same DB, proving oracle staleness: counts grew from
later parity runs' entities, the stats day-series shifted as "today"
moved, and parity12's leftover deposit balance rows (+65) made
parity18's renewal pay immediately instead of staying unpaid
(the failure mode parity18's own comments predict). Fix applied:
deleted the parity12 balance rows (client-1 back to 4 rows, net 0),
refreshed captures18 (read-only) and captures21 (its funds cases are
read-only; all 50 non-OK entries are expected error pins) from live
PHP, copied them to the docs oracles, and re-ran: parity15 20/20,
parity18 114/114 + the pre-existing documented DQL divergence
(`transaction_get_list` with `invoice_hash`, upstream defect, TS
filters correctly). Reference DB re-verified clean afterwards
(templates 24, no comms23/PAR21/CAP21 residue, order states clean,
client-1 balance 0). Reference queue depth fell 114 → 68 across the
regression reruns (transient mail-queue state; parity20 snapshots it
dynamically, so no gate impact).

## Simplifications / open items carried forward

- `emailRenderCtx` hardcodes default_currency "USD" (should be
  findDefaultCurrency) and FOSSBillingVersion "0.8.9" (Version.php
  reads '0.0.1' in this checkout). Values only matter if a template
  references them; parity cases avoid them.
- `template_render` still renders with system context only
  (deliberately untouched).
- Deferred from the CRUD block, still PHP-served: guest invoice
  `payment`/`pdf`, admin/client/invoice/order `export_csv`, admin
  `client/export_csv` (needs a non-JSON route).
