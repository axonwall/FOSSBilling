# R5f findings: the 13-job cron runner (TS port)

Scope: `src/modules/Cron/Service.php::runCrons()` + the Cron Api
Guest/Admin endpoints, ported to `apps/nextjs/src/server/modules/cron.ts`
plus the batch jobs in `invoice.ts`, `order.ts`, `cart.ts`,
`support.ts`, `client.ts`, `email.ts` and the helpers in `money.ts`,
`db.ts`, `tz.ts`, `emailer.ts` (extraVars param only),
`currency.ts`. No `twig.ts` change was needed
(`renderTemplateStrict` already existed and is now used by the
suspension-warning send). Proof: `parity39.py` (212 checks, 0
failures) against
the `capture42.py` corpus (79/79, unmodified). Where this doc and the
scope doc (`r5-scope.md` §2 R5f) differ, the PHP code and the capture
corpus win — the corrections are called out explicitly below.

## 1. PHP runCrons, per file/function

`src/modules/Cron/Service.php::runCrons()` (CLI entry
`src/cron.php` passes `$argv[1]` as `$interval`, but `runCrons()`
takes NO parameter — TS likewise takes no interval; no
interval-gating was invented):

| Step | Code | Notes |
|---|---|---|
| Gate | `Cron\Service::runCrons` own gate | Throws before any job/event/`last_cron_exec` write. For admin calls it is normally UNREACHABLE: the dispatcher throws first (see §2). |
| Heal | `healSchemaDrift()` | Attempted first; failures only logged, execution continues. The `UpdatePatcher::healInvoiceJournal`-style sync never throws (an unreadable DB reports in-sync). |
| Before event | `BeforeAdminCronRunEvent` dispatch | Listeners in §5. |
| Non-isolated 1 | `invoice_batch_pay_with_credits` via `_exec` | A throw here aborts the run BEFORE `last_cron_exec` updates. |
| Non-isolated 2 | `invoice_batch_activate_paid` via `_exec` | Same abort semantics. |
| Isolated 1–11 | see table below, each in try/catch | Failures collected in `$failedTasks`; return values IGNORED — a task returning `false` does NOT fail the run, only a throw does. |
| Post | `setParamValue('last_cron_exec', date('Y-m-d H:i:s'))` | Written EVEN when isolated tasks failed; NOT written on non-isolated abort or gate throw. PHP time is process-TZ wall time (config TZ); TS writes UTC `nowTimestamp()` — equal on the reference (config UTC), pinned as part of the standing write-side TZ gap (§8). |
| Post | `clearOldSessions()` | See §4. |
| After event | `AfterAdminCronRunEvent` dispatch | Listeners in §5. |
| Return | `false` iff `$failedTasks` non-empty, else `true` | Practically unreachable as `false` in a clean run: NO isolated task throws on any constructible input (all swallow per-item failures), and the non-isolated callees swallow per-item failures internally — a non-isolated abort needs a catastrophic failure. Parity39 therefore proves isolation by (1) this code-path inspection, (2) per-item fault tolerance on both stacks (negative generate order skipped while bucket-mates proceed; suspension-warning send failure releases the claim while others proceed; pay per-invoice failure skipped, batch continues, run returns true), (3) run returns true on both stacks for all crafted cases. No task failure was faked. |

Isolated order (PHP fixed order, mirrored exactly in TS):

1. `invoice_batch_generate`
2. `invoice_batch_send_reminders`
3. `invoice_batch_invoke_due_event`
4. `order_batch_send_suspension_warnings`
5. `order_batch_suspend_expired`
6. `order_batch_cancel_suspended`
7. `order_batch_cancel_unpaid`
8. `support_batch_ticket_auto_close`
9. `client_batch_expire_password_reminders`
10. `cart_batch_expire`
11. `email_batch_sendmail` (LAST)

PHP's own inconsistency, mirrored not fixed: in a full run,
send_reminders (#2) runs first and — when its once-per-day gate
path fires — claims, sends, and SETS `invoice_overdue_invoked`;
invoke_due (#3) then sees the gate set and returns `false` with NO
second fire. When the gate was already set, send_reminders falls
back to the pending fire (events fire, gate untouched) and
invoke_due still returns `false`. So invoke_due fires inside a full
run ONLY if send_reminders threw. The standalone endpoint fires
whenever the gate allows. Parity39 asserts both shapes.

## 2. Finalization gate — exact shape

State file: `<dirname(dirname(FB_DATABASE_PATH))>/data/update-finalization.json`
(`PATH_DATA + update-finalization.json`).

- `stateRequiresFinalization`: status `pending` or `finalized`.
- `isCompleteForCurrentVersion`: status `complete` AND version
  `0.0.1` (`Version::VERSION` — NOT 0.8.9).
- BEFORE dispatch, request bootstrap runs `finalizePendingUpdate()`:
  a pre-existing PENDING state is FINALIZED in place (core patches
  applied — the journal backfill adds exactly the 60 event-less
  invoice rows — state stamped `finalized`, NO maintenance-mode
  change). A MISSING state file is turned into pending by
  `ensureCurrentVersionFinalization()` (source
  `missing-finalization-state`, branch from config `update_branch`,
  default `release`) AND `createPendingState()` flips config.php
  `maintenance_mode` ON (`enabled=true`,
  `allowed_urls=[/admin/staff/login, /admin/system/update/finalize]`)
  — this is the ONLY maintenance flipper. A `finalized` state still
  requires finalization.
- Admin layering: the dispatcher
  (`src/modules/Api/Controller/Client.php::checkUpdateFinalization`)
  throws FIRST for admin role when finalization is required and the
  call is not in `ALLOWED_ADMIN_API_CALLS =
  [system_update_finalization_status, system_finalize_update,
  system_complete_update_finalization, profile_logout]`
  (`cron_run` is NOT in the list):
  HTTP 503 + envelope `{result: null, error: {message:
  'FOSSBilling update finalization is pending. Complete
  finalization before using the admin API.', code: 503}}`.
- Guest layering: the dispatcher gate is admin-only, so a guest
  `cron/run` reaches the runner's own gate, which throws HTTP 503 +
  message `'Update finalization is pending. Cron jobs are paused
  until finalization is completed.'` code 503.
- Gate throws BEFORE any job, event, or `last_cron_exec` write.

TS shape (parity39 §2 proves all of it):

- Admin `cron/run`: HTTP **200** + envelope code 503 + the
  DISPATCHER message (TS envelopes are always HTTP 200 by seam
  convention — the HTTP-status difference from PHP's 503 is
  documented, not faked). The handler checks the gate BEFORE
  `runCronJobs()`, mirroring dispatcher-first layering.
- Guest `cron/run`: HTTP 200 + envelope code 503 + the RUNNER
  message (gate inside `runCronJobs()`, after hash/throttle).
- DELIBERATE DIVERGENCE, asymmetric assertions: TS does NOT mirror
  the finalize side effects — no patch application (no TS patcher
  exists), no maintenance toggle. A pending state stays `pending`
  after a TS gate refusal; a missing file stays missing. That work
  belongs to update-finalization (R5j), not the cron runner.
- TS treats a missing, unreadable, or unparseable state file as
  gate CLOSED (503, no jobs): PHP's `ensure()` would create a
  pending state and close the gate, and TS mirrors the observable
  outcome without the ensure side effect. Any status other than
  complete/0.0.1 (including complete for a non-0.0.1 version, or a
  missing status) is likewise closed.

## 3. Guest throttle — exact comparison and layering

`src/modules/Cron/Api/Guest.php::run()`:

- Config source CORRECTION (scope doc's settings framing was
  wrong, and the old TS handler was wrong with it): PHP reads the
  mod_cron EXTENSION config, NOT settings. There are no `cron_*`
  setting rows on the reference, so the old TS guest handler always
  403'd. TS now uses `readExtensionConfig('mod_cron')` (R4a path).
- Order: `guest_cron` falsy → 403 `'You do not have permission to
  perform this action'`; `cron_hash` empty → 403 DISTINCT `'Guest
  cron is enabled but no security hash has been configured'`;
  provided hash non-string or `!hash_equals` → 403 permission
  message. TS hash comparison `!==` vs PHP `hash_equals` is
  unobservable (both are equality checks on the same strings);
  noted, not chased.
- Throttle (GUEST endpoint only — admin runs are NOT throttled):
  `if (!is_null(last)) { $t1 = new DateTime(last); $t2 = new
  DateTime('-1min'); if ($t1 >= $t2) return false; }` — return
  `false` WITHOUT running and WITHOUT updating `last_cron_exec`.
- Boundary semantics, corrected during parity39: `$t1` carries
  second precision (microseconds 0) while `$t2` carries the current
  microseconds, so the boundary is age ≤ 60.000s in wall-clock
  terms and "exactly 60s ago" is throttled only in the measure-zero
  instant — a stored T−60 value ages past the boundary during any
  probe. TS matches with millisecond precision
  (`Date.now() - lastMs <= 60_000`), NOT second truncation (which
  would throttle up to ~1s too long). Parity39 brackets the boundary
  (30s throttled, 61s runs, null runs) rather than asserting the
  untestable exact-60s instant.

## 4. clearOldSessions — exact SQL and config

`src/modules/Cron/Service.php::clearOldSessions()`:

```
now = time()
maxAge = now - Config::getProperty('security.session_lifespan', 7200)
DELETE FROM session WHERE lifetime < :now OR created_at <= :age
```

- `security.session_lifespan` is a CONFIG.PHP property, NOT a
  setting (reference: 7200 explicit). TS reads it fresh from the
  config store (R5a `getConfigProperty`), so it is current.
- `lifetime`/`created_at` are INTEGER Unix timestamps.
- `session.id` is a BLOB pk holding 32-hex Symfony ids (NOT
  autoincrement — crafted session rows need explicit string ids;
  `lastrowid` returns the integer rowid, NOT the id).
- Session COUNT is not a stable invariant (logins add rows, full
  runs purge stale ones): parity39 asserts crafted rows +
  login-session survival, never absolute counts. A full PHP run
  purges ~150 stale sessions on first run (161→27 observed) —
  expected, not residue.

## 5. Before/After listeners — scope correction

SCOPE CORRECTION: listeners DO exist — the scope's "no listeners"
expectation is FALSE. TS has no event bus and none was invented:
each listener's DB-visible effect runs as a discrete function at
the Before point (after gate+heal slot, before pay_with_credits)
or the After point (after clearOldSessions, before return), in
dispatch order, each try/caught so a listener failure never fails
the run.

| Listener | Effect | TS |
|---|---|---|
| Activity cleanup (Before) | mod_activity config `max_age` (default 90, intval) + `email_max_age` (default 0); both 0 → return; else `DELETE FROM activity_admin_history / activity_client_history / activity_system WHERE created_at <= now - max_age*86400`; if `email_max_age != 0`, same for `activity_client_email` | Implemented |
| Client 900s prune (Before) | `DELETE FROM client_password_reset WHERE createdAt < now-900s` — SEPARATE from the isolated 2h expire job; the runner runs BOTH | Implemented |
| Currency rates (Before) | If config `sync_rate ?? 'auto'` !== `'never'`, `updateCurrencyRates()` (default → 1.0; manual-rate → skip; others → live fetch; compute-then-write, a fetch failure writes nothing) | Implemented (`runCurrencyRatesBeforeCron`). SANDBOX ASYMMETRY, PINNED: TS fetches fine, PHP dies at sandbox TLS and swallows it (listener try/catch) → crafted non-default non-manual currencies update on TS, not PHP. Parity proves default/manual/never-gate paths, NOT live-fetch. |
| Extension refresh (Before) | `getExtensionsList` — its only DB effect is pruning vanished-module rows on read | DOCUMENTED NO-OP: R4a deliberately does NOT prune on read; implementing it would contradict R4a. |
| SEO ping (Before) | Sets `mod_seo_last_sitemap_submit` | DOCUMENTED NO-OP — SCOPE CORRECTION: Seo is NEITHER in `Module::CORE_MODULES` NOR installed (no mod_seo extension row), so its Before listener never registers on the reference; the timestamp is NOT set on PHP. TS must NOT set it either. |
| Servicedomain sync (Before) | Gate: `servicedomain_last_sync` within 30 days → return false, NO write; else per-domain `syncExpirationDate` (registrar calls, each try/catch) then set `servicedomain_last_sync = now` if no programming error | Implemented for the gate + timestamp; per-domain registrar sync is a PINNED GAP (no TS registrar client; 0 domains on reference). Parity covers the stale + 0-domain case only. |
| System GeoIP/cache (Before) | GeoIP `Reader::updateDefaultDatabases` + cache prune | DOCUMENTED NO-OP: no-op with bundled DBs present; cache prune covers only filesystem pools, which TS has none of. |
| Invoice journal heal (After) | `UpdatePatcher::healInvoiceJournal`, max 1 page of 500 by id: invoices with NO `invoice_event` row, keyset `id > last`, LIMIT 500; per row atomic claim (`UPDATE invoice SET updated_at = updated_at WHERE id AND NOT EXISTS event`), then INSERT with BACKFILL snapshot (see below) | Implemented. Reference: 60 event-less invoices → a run backfills all 60, on both stacks. |
| Expired-unpaid removal (After) | Setting `remove_after_days` unset/falsy → no-op; else `findUnpaidOlderThan(days)` (status unpaid + dueAt NOT NULL + calendar-date diff `CURRENT_TIMESTAMP` vs dueAt > days, SQLite `CAST(julianday(date(a)) - julianday(date(b)) AS INTEGER)`) → per invoice: cancellable (issued + unpaid + creditNoteFor/debitNoteFor/replacedBy all null) → `cancelInvoice` with reason `'Expired unpaid — automatically voided after {days} days.'`; elseif unissued + unpaid + all note links null → `rmInvoice` hard delete (order unlink `unpaid_invoice_id = NULL`, transaction DETACH not delete, items delete, invoice delete) | Implemented. Cancel email only when setting `invoice_send_cancel_email` === `'1'` (default `'0'`; the `'1'` path's template code is `mod_invoice_canceled`, unasserted on the reference). Issued notes are left alone. |

Backfill snapshot (NOT a `recordJournalEvent` snapshot — do not
conflate them): `{serie_nr` (padding from setting
`invoice_number_padding`, default 5 — reference absent → 5,
matching TS `serieNr` hardcoded 5), `status`, `issued` (bool),
`subtotal: null`, `tax: null`, `total: null`, `buyer:
{first_name, last_name, company, company_vat, company_number,
address, city, state, country, phone, email, zip}` (buyer_address
= the invoice row's SINGLE buyer_address field, NOT TS
snapshotParties' address_1+address_2 join), `seller: {company,
company_vat, company_number, address, phone, email}`, `paid_at`,
`due_at`, `created_at}`; type `'created'` if unissued else
paid→`'paid'`, canceled→`'canceled'`, refunded→`'refunded'`,
default→`'issued'`; event `created_at` = invoice `created_at`
(NOT now — `insertInvoiceEvent` gained optional `clientId` +
`createdAt` params for the NEW R5f events only; pre-existing
callers keep the old shape, and their NULL-client_id gap is
deliberately NOT rewritten).

Other event families: Before/AfterInvoiceIsDue listeners exist ONLY
in `Invoice/Service.php` (the built-in reminder handlers —
implemented inline, see §6). Before/AfterAdminBatchSendSuspensionWarnings:
NONE outside `Order/Service.php` + tests → no-ops justified.
Before/AfterAdminInvoiceSendReminders,
BatchSuspendOrders, BatchCancelSuspendedOrders,
BatchCancelUnpaidOrders: no listeners outside the batch services
themselves → no-ops.

## 6. The three stub algorithms

### 6a. Generate — `Invoice/Service.php::generateInvoicesForExpiringOrders`

Qualifying query (`Order/Service.php::getSoonExpiringActiveOrdersQuery`):
active + `invoice_option` EXACTLY `'issue-invoice'` (hyphen —
reference orders 1–3 carry `'issue_invoice'` underscore and do NOT
qualify; the underscore variant is PINNED as non-qualifying) +
period NOT NULL + `expires_at` NOT NULL + `unpaid_invoice_id` NOT
pointing at an UNPAID invoice (LEFT JOIN on status=unpaid +
`i.id IS NULL` — a link to a PAID invoice does NOT block; a link
to an UNPAID invoice EXCLUDES the order from the batch entirely —
the batch NEVER reaches `generateForOrder`'s reuse branch;
capture proved: unpaid-linked order skipped with draft untouched,
paid-linked order qualifies with link cleared + NEW invoice +
re-stamp) + NOT EXISTS `cancel_at_period_end` meta = `'1'` + NOT
EXISTS (non-executed renew item on a PAID invoice for the order) +
`expires_at < expires_before`, where `expires_before = (today in
PHP process TZ + (invoice_issue_days_before_expire + 1) days) at
00:00:00`, setting default 14 (reference: 14 explicit). ORDER BY
`client_id` DESC. "Today" is zone-aware via R5d `tz.ts`
(`resolveZone()` + zone-midnight), NOT UTC `nowTimestamp()`, or
the boundary shifts under non-UTC config.

Per-order loop: `mergeable = shouldMergeRenewalsForOrder &&
!hasActiveSubscriptionForOrder` (merge evaluation exception →
mergeable=false, logged). Non-mergeable: `generateForOrder` +
`issueInvoice(use_credits: true)`, each try/catch → logged,
continue. Mergeable: bucket by renewalMergeKey =
`client_id|currency|expires_at(Y-m-d)|period`; single buckets →
`generateForOrder`; multi buckets →
`generateMergedInvoiceForOrders`; on generation exception fall
back per-order (TS has no EntityManager; log + per-order fallback
mirrors the non-EM-closed path). Issuance runs OUTSIDE generation
(an issue failure never re-generates).

- `shouldMergeRenewalsForOrder`: per-order meta
  `merge_renewals` (`'1'`→true, `'0'`→false, last-write-wins)
  else client column `merge_renewals` (null → fall through) else
  setting `invoice_merge_renewals` default false (reference:
  absent → false).
- `hasActiveSubscriptionForOrder`: subscriptions for the order
  with status `'active'` where `trim(sid) !== ''` (SQL join
  subscription → invoice_item on `rel_type='invoice'`).
  Reference: 0 rows → always false.
- `generateForOrder`: unpaid-invoice REUSE branch first (return
  existing unpaid draft — unreachable from the batch but
  implemented faithfully) else if link set but not unpaid →
  `unsetUnpaidInvoice` then proceed; `resolveRenewalLine`
  (default price=order.price; if order status in
  {active, failed_renew, suspended} AND product type == DOMAIN:
  TLD renewal repricing — see gap below; if price*quantity < 0 →
  throw `'Invoices are not generated for negative amount
  orders.'`, batch catches per-order → skipped); client must
  exist else `'Client not found'`; create proforma (client_id,
  unpaid, currency = ORDER currency NOT client currency, issued
  false); `setInvoiceDefaults` (serie from `invoice_series`
  setting, reference 'FOSS'; hash 30–60 hex; `hash_expires` from
  `invoice_hash_lifetime_days` default '90', int-cast, ≤0 → null,
  else now+days, reference 90; taxname/taxrate from
  `getTaxRateForClient` — TS `resolveTaxForClient` matches:
  state+country, country, global, else 0/''; notes from
  `invoice_default_note`, reference None → null; due_at default
  overwritten below); `generateFromOrder` (taxed =
  `isClientTaxable(client)` — the admin renewal_invoice handler's
  hardcoded taxed:true is WRONG for the batch path, use
  isClientTaxable; item: type order, rel_id = order id STRING,
  task renew, status pending_payment, title = line.title ??
  order.title, period normalized, quantity, unit, price;
  `setUnpaidInvoice` stamps `unpaid_invoice_id` AT GENERATION
  time, before issuance); promo adjustments via
  `getRenewalPromoAdjustments` → PINNED GAP (TS has no
  renewal-promo path; parity39 uses orders without recurrent
  promos); due: batch passes null due_days → due_at = expires_at
  (single) or MAX expires_at (merged); `recordJournalEvent(CREATED)`.
- `issueInvoice` fixes in `money.ts`: guard (unissued +
  non-unpaid → throw `'Only unpaid draft invoices can be
  issued.'`); `snapshotPartiesFromLiveRecords` returns early if
  already issued (TS `snapshotParties` ALWAYS overwrote — FIXED:
  skip when already issued); nr claim SKIPPED when nr already
  numeric (TS ALWAYS re-claimed — FIXED: skip nr/serie claim when
  numeric nr exists); issued=true; `recordJournalEvent(ISSUED)`;
  if use_credits → `tryPayWithCredits`. PHP also queues the
  'Invoice Created' email via the AfterAdminInvoiceIssueEvent
  listener `sendIssuedInvoiceEmail` AFTER tryPay: only when total >
  0 AND status != paid AND client id set — TS mirrors this
  timing/condition (previously it queued BEFORE tryPay,
  unconditionally; see §9 for the regression consequence, which
  was none — no prior suite asserted the old timing). TS has no
  hash-lifetime extension — PINNED GAP.
- Journal events for generate: full `recordJournalEvent` snapshots
  (serie_nr via serieNr padding 5, subtotal/tax/total from
  invoiceTotals + taxrate, buyer/seller blocks, gateway_id +
  gateway name/key, admin_id NULL during cron, client_id = invoice
  client_id, created_at now) — built by the new
  `buildJournalSnapshot` in `money.ts` (NOT by reusing
  `invoice.ts::invoiceArray`, which would create a money→invoice
  circular import; `invoice.ts` already imports `money.ts`).
  `issueInvoice` gains `opts.fullJournal`: true → full snapshot +
  real client_id (generate path only); false (default) → legacy
  partial snapshot, existing callers unchanged.
- Generate iteration order note: TS iterates the qualifying
  query's ORDER BY client_id DESC order; PHP reloads via `findBy`
  without orderBy (likely id ASC). Final per-order state is
  order-independent except nr assignment sequence, so parity39
  asserts nr numeric/distinct/serie, NOT exact nr values or
  cross-client nr order.
- Generate due_at note: TS inserts the proforma with due_at =
  expires_at directly (PHP's `setInvoiceDefaults` intermediate due
  = now+invoice_due_days is overwritten by `generateForOrder`
  before the CREATED journal event, so the intermediate is
  unobservable in final state).
- DOMAIN REPRICING, PINNED GAP: `resolveRenewalLine` for
  domain-type products does the rate lookup first (missing/NULL
  rate → PHP's exact `'Currency rate for <code> is not
  configured'` throw); if the rate exists, it throws a logged gap
  error so the order is SKIPPED, not generated at the wrong order
  price. Parity39 generate cases use non-domain orders only.

### 6b. Invoke-due + send-reminders

`Invoice/Service.php::doBatchInvokeDueEvent` (4184):
once_per_day default true; key `invoice_overdue_invoked`; if
once_per_day AND last_time AND (now − strtotime(last)) < 86400 →
return false (gate closed; NO fire, NO update; exactly 86400s ago
→ NOT less → gate open — PHP compares int-second timestamps
`time()`/`strtotime()`, and TS matches with second-precision
arithmetic). Else `fireDueReminderEvents()`; `setParamValue(key,
now)`; return true. Reference: `2026-10-24 05:31:25` (gate open
first run, then set).

`fireDueReminderEvents` (4221): before intervals =
`parseInvoiceReminderIntervals(getParamValue('invoice_reminder_before_due_days',
''))` (split on `/[,\s]+/`, numeric, int-cast, >0, unique,
sorted; reference absent → []); after intervals =
parse(`getParamValue('invoice_reminder_after_due_days', '5')`)
(reference absent → [5] — NOTE: `getParamValue` returns the row
value even when NULL, and returns the default only when the ROW IS
MISSING; the reference rows are absent, hence defaults apply);
tomorrowStart = today+1 day at 00:00:00 (process TZ); daysLeft =
dateDiffDays(due_at, now) (calendar-date diff,
`CAST(julianday(date(a)) - julianday(date(b)) AS INTEGER)`);
before list: unpaid + issued + due_at > now → dispatch
BeforeInvoiceIsDueEvent(id, days_left, beforeIntervals);
daysPassed = ABS(dateDiffDays); after list: unpaid + issued +
due_at < tomorrow_start → AfterInvoiceIsDueEvent(id, days_passed,
afterIntervals).

CORRECTION FOUND DURING PARITY39 (the brief's "same helper for
both paths" framing was wrong — PHP's two handlers DIFFER, and
the first parity39 run proved it: PHP wrote NO reminder event for
an after-path invoice while the old TS code wrote one):

- BEFORE handler (`onEventBeforeInvoiceIsDue`): send-time gate →
  interval check → atomic claim UPDATE (`UPDATE invoice SET
  reminded_at = now, updated_at = now WHERE id AND status =
  'unpaid' AND issued AND due_at > now AND (reminded_at IS NULL OR
  reminded_at < today_start)`; 0 rows → return) → reload →
  `sendInvoiceReminder` (paid → no-op; else reminded_at=now,
  `sendInvoiceReminderEmail` → template
  `mod_invoice_payment_reminder` + billing-email override +
  invoice-PDF attachment if non-null + hash-lifetime extension,
  then REMINDER journal event) → exception AFTER claim → release
  claim (reminded_at=NULL); before claim → nothing.
- AFTER handler (`onEventAfterInvoiceIsDue`): send-time gate →
  interval check → atomic claim UPDATE (same shape but due_at <
  tomorrow_start) → reload → toApiArray + client check (missing
  client → throw `'Invoice client data is unavailable.'` → claim
  released) → template `mod_invoice_due_after` with
  `days_passed`, billing-email override, PDF attachment if
  non-null → sendTemplate. NO journal event, NO reminded_at
  re-stamp (the claim already did it), NO hash-lifetime
  extension.
- TS mirrors both paths exactly (`sendInvoiceReminder` for
  before, new `sendOverdueInvoiceEmail` for after, with
  `days_passed` passed through the extended `queueInvoiceEmail`
  `extraVars` param; existing callers unchanged). Pinned gaps for
  BOTH paths: NO PDF attachment (R5e template_send attachment
  gap) and NO hash-lifetime extension (TS has no
  extendInvoiceHashLifetime). Parity39 asserts the template split
  by subject (`Payment Reminder` first — before-list fires first —
  then `Invoice Due`) and the journal split (D3 before → REMINDER
  event with client_id 1; D1 after → NO event).
- `isReminderSendTimeReached` gate: `invoice_reminder_send_time`
  (default ''; read exception → true; empty → true; regex
  `/^(\d{1,2}):(\d{2})$/` fail → true; hour>23/minute>59 → true;
  else true iff current zone-local HH*60+MM >= configured;
  reference absent → true) — return early WITHOUT claiming if not
  reached. Parity39 proves the deferral shape: future send_time →
  run true, 0 sends, 0 claims, gate STILL updated.
- `doBatchRemindersSend` (4169) REPLACES the old TS job (which
  queued for EVERY overdue issued unpaid invoice + stamped
  reminded_at, with no gate, no intervals, no claiming): dispatch
  Before event (no listeners → no-op), then
  `doBatchInvokeDueEvent({once_per_day: true})`; if false →
  `doBatchInvokePendingReminderEvents()` (fire WITHOUT updating
  the gate); return result. No parity suite referenced
  `batch_send_reminders` (grep-verified) — no old assertion needed
  updating; regression arbitrates (it did — see §9). The
  replacement DOES write REMINDER journal events on the before
  path (same helper as the due-event path), matching PHP.

### 6c. Suspension warnings — `Order/Service.php::batchSendSuspensionWarnings`

Before/After batch events have NO listeners → no-ops.
`getDueSuspensionWarnings` (`OrderRepository.php:146`): grace =
MAX(COALESCE(order.suspension_grace_days,
product.suspension_grace_days, 0), 0); suspension_at =
datetime(expires_at, '+' || grace || ' days'); SELECT id,
suspension_at FROM (active + expires_at NOT NULL) WHERE grace_days
> 0 AND suspension_at > now AND suspension_at <= tomorrow (now+1
day, SAME time-of-day, NOT calendar day) ORDER BY id; per
candidate: reload order; if missing OR !claimSuspensionWarning →
skip; claim: transaction + row lock ('' on SQLite = no-op); read
client_order_meta (name 'suspension_warning_for') ORDER BY id
LIMIT 1; if existing value === suspensionAt → false; else UPDATE
existing row's value (+updated_at now) or INSERT (client_order_id,
name, value, created_at now, updated_at now) → true; try:
orderData = toApiArray(order, false) + orderData['suspension_at']
= candidate.suspension_at; emailService->sendTemplate({to_client:
clientId, code 'mod_order_suspension_warning', order: orderData});
on Throwable → releaseSuspensionWarningClaim (DELETE meta WHERE
order + name + value = suspensionAt) + log, continue; return true.
Reference: all products grace 0, all orders grace NULL/0 → NO
candidates (parity crafts grace > 0 + expires placing
suspension_at in (now, now+1d]).

TS send path: render directly with `findEmailTemplate` +
strict renderer + `queueEmail` (NOT `queueTemplatedEmail`, which
swallows all errors and cannot drive the release path).
CORRECTION FOUND DURING PARITY39: the brief claimed TS
`renderTemplate` throws on unclosed `{{ }}` — it does NOT; the
FORGIVING renderer tolerates it. Only `renderTemplateStrict`
(used by template_send/_parse/validate) throws
`Email template syntax error: Unclosed "variable"...`. PHP's
sendTemplate renders STRICT, so the TS suspension send now uses
`renderTemplateStrict` for subject and content — the broken-template
release case passes on both stacks. Missing/disabled template →
no queue, claim kept, WITHOUT auto-creating the disabled row PHP's
`getOrCreateTemplateByCode` would — documented minor divergence
(unasserted: parity crafts an enabled template). The template does
NOT exist on the reference: a brand-new code creates a DISABLED
template and template_send returns false without queueing (R5e
§J) — parity39 crafts an ENABLED template row first
(snapshot-restored, as parity38 §J did).

## 7. Pay with credits (non-isolated, first)

PHP `Invoice/Api/Admin.php` → `doBatchPayWithCredits` →
`findAllUnpaid(filter)`: issued + unpaid + a balance ROW >= a
non-deposit item's PRICE (per-row comparison, NOT a sum; deposit
items excluded), optional client_id filter; SQL says `ORDER BY id
DESC` BUT `doBatchPayWithCredits` reloads via `findBy(['id'=>ids])`
with NO orderBy, so the EFFECTIVE order is the repository's
natural ASC order (capture proved: lower id pays first with a
shared limited balance). Per invoice try/catch: tryPay true →
covered; false → skipped; throw → failed count + logged,
continue. Returns true ALWAYS (even with failures).

PRE-EXISTING TS ENDPOINT DIVERGENCE (flagged, not R5f scope to
fix the endpoint contract itself, but the RUNNER must not use
it): TS `batch_pay_with_credits` is ids-based only (no ids →
`{}`); PHP ignores ids (only client_id read). The runner uses the
NEW `runBatchPayWithCredits()` implementing findAllUnpaid +
per-invoice try/catch + return true.

`tryPayWithCredits` (`Invoice/Service.php:1626`) vs TS
`money.ts:327` — two TS gaps FIXED: (a) TS returned false for
total <= 0 — PHP PAYS zero/negative invoices WITHOUT a balance
row; (b) TS had NO issued/paid guard inside `tryPayWithCredits`
itself — added both (issued required, paid → false). TS
`markInvoicePaid` (R5b) already mirrors
`markAsPaidInTransaction` (rate read LIVE at payment —
`getRateByCode` throws `"Currency rate for code '<code>' is not
configured"` when row missing OR conversion_rate NULL; invoice
marked issued + paid; `countIncome` writes base_income/base_refund;
items pending_payment → pending_setup; paid journal event +
`mod_invoice_paid` email queue).

PINNED DIVERGENCE (not fixed): PHP `tryPayWithCredits` executes
item tasks IMMEDIATELY via `executeInvoiceItemTasks`, so a
credits-paid custom order gets an activation attempt during pay on
PHP but waits for activate_paid's 10-min cutoff on TS. Parity39
pay section asserts invoice paid + balance rows only, NOT item
execution; the full-runner section records that a credits-paid
custom order's activate item is attempted during pay on PHP but
untouched (attempts 0) on TS in the same run.

## 8. Existing-job fix-vs-pin table

| Job | PHP truth | TS change in R5f | Pinned, not fixed |
|---|---|---|---|
| activate_paid | Item-driven: `getAllNotExecutePaidItems` (paid invoices, item NOT IN (executed, failed), AND (paid_at IS NULL OR paid_at <= now-10min)) → per item claim → `executeTask` (activate: if product setup == after_payment → `activateOrder`, failure → status note + `recordTaskFailure` (attempts+1, status→failed only at MAX attempts = 3); renew → unsuspend if suspended + `renewOrder`; deposit → markAsExecuted unconditionally; custom → markAsExecuted unconditionally) | FIX (bounded): kept order-driven activation BUT added the 10-minute cutoff (paid invoice must have paid_at NULL or ≤ now−10min) AND mark the activated order's activate-task items executed (`UPDATE invoice_item SET status='executed' WHERE invoice_id=? AND type='order' AND rel_id=? AND task='activate' AND status NOT IN ('executed','failed')`) | Renew-task execution (TS has order-renew logic at `order.ts:1145` but wiring renew-task execution into the batch is a separate larger piece; parity39 does not assert it). Deposit/custom items on paid invoices left pending_payment (PHP marks them executed unconditionally). |
| suspend_expired | Grace-aware list (active + expires_at NOT NULL + datetime(expires_at, '+' \|\| MAX(COALESCE(order grace, product grace, 0), 0) \|\| ' days') <= now); reason = order config `batch_suspend_reason` trimmed, else `'Non-payment'`; `suspendFromOrder` (active check else throw; service suspend call — hosting passes reason, others no args; status suspended + reason + suspended_at now + updated_at now; note = reason null → `'Order suspended'` else `'Order suspended for ' + reason`) | FIXED: grace-aware expiry, reason from mod_order config else `'Non-payment'`, note `'Order suspended for ' + reason`, per-order try/catch | Hosting-manager suspend call (parity39 uses custom-type orders; for custom services PHP's `_callOnService` suspend is a no-op in practice — `Servicecustom` plugin-less adapter returns null) |
| cancel_suspended | Config GATE (order config `batch_cancel_suspended` falsy/missing → return false, NO cancels); days = `resolveBatchAfterDays(batch_cancel_suspended_after_days)` (null/'' → default 7; negative → default 7); cutoff = today (calendar, process TZ) − days at 00:00:00; suspended + suspended_at < cutoff ORDER BY id DESC; per order try/catch → `cancelFromOrder` (reason = config `batch_cancel_suspended_reason` ?? null; note reason null → `'Order canceled'` else `'Canceled order for ' + reason`) | FIXED: config gate (disabled → false, matching PHP; runner ignores returns so the observable is 'no cancels'), calendar-day cutoff via zone-aware today − config days (default 7), reason from config, PHP note format, return true when enabled even with zero cancels, `completeCancellation` mirrored fully (status canceled + reason + canceled_at + expires_at NULL + suspended_at NULL + delete `cancel_at_period_end` meta) | Subscription-cancel + promo/stock-release internals are no-ops on reference-like orders (verified by comparing related tables in parity39; a crafted order with redemptions would pin it) |
| cancel_unpaid | Config gate (falsy/missing → false); days default 7; `getStaleUnpaid` (pending_setup + NOT EXISTS order item with paid invoice + [EXISTS unpaid linked invoice with COALESCE(due_at,created_at) < cutoff OR (no unpaid linked invoice AND created_at < cutoff)], cutoff = today calendar − days, ORDER BY id); invoice-group logic (linked PAID invoice → skip ALL its orders; UNPAID → `deleteInvoiceByAdmin` then group true; gone/other → true); per order re-check pending_setup → `deleteFromOrder` (DELETES the order row — `cancelFromOrder` explicitly rejects pending_setup) | GATE ONLY: disabled → false (matching PHP's most common reference state); enabled path keeps the existing cancel behavior + returns true even with zero cancels; existing 7×24h cutoff kept (moot given the semantic divergence) | PINNED SEMANTIC DIVERGENCE, deliberately NOT fixed in R5f (full cascade rewrite too big): PHP DELETES stale pending_setup orders (after removing their linked unpaid invoice); TS marks them canceled. Parity39 asserts the GATE only, never the enabled path (it would fail on TS by design). |
| ticket_auto_close | `findExpiredOnHold` (on_hold + datetime(updated_at, '+' \|\| close_after \|\| ' hours') <:now, close_after NULL → NULL → not expired, ORDER BY id ASC) → `autoClose` → close() | NO change (matches) | now-TZ note: TS compares against SQLite datetime('now') (UTC) vs PHP process-TZ wall now — equal under config UTC; belongs to write-side harmonization, not R5f |
| expire_password_reminders | 2h cutoff delete | NO change (matches) | Same now-TZ note as auto_close |
| cart_expire | Cutoff = today (calendar, process TZ) − 7 days at 00:00:00; carts with created_at < cutoff AND session_id NOT LIKE `'staff:%'` → DELETE cart_product + DELETE cart; return true | FIXED: zone-aware today via `tz.ts` (`resolveZone()` + zone-midnight − 7 days). On reference (config UTC) they already agreed. | — |
| sendmail | `batchSend()`: time_limit (default 5, ×60s), queue_once (default 0 = unlimited); findDueBatch; loop `_sendFromQueue`; break AFTER each send if time_limit && elapsed > time_limit (0 never breaks; −1 breaks after exactly 1). Per-email failures handled inside `_sendFromQueue` (never throw the task without throw_exceptions, which batchSend does not pass) | R5e's `batchSendMail()` (`email.ts:498`, module-private) EXPORTED, no logic change | R5e proved: PHP dev (`:8080`, `APP_ENV=dev`) SKIPS sending in `_sendFromQueue` (row stays `'sending'`, mock empty) — parity39's sendmail section NEEDS the `:8081` prod oracle (no `APP_ENV` → actually sends) + mock SMTP `:18025`, with parity39 OWNING the mock lifecycle. NEVER point any suite at a real SMTP host. The reference email config does NOT point at the mock — parity39 crafts the mock email config first (admin/extension/config_save as_json=True, ext=mod_email, mailer=smtp, smtp_host=127.0.0.1, smtp_port=18025, smtp_username='', smtp_password='', log_enabled=1, queue_once=0, time_limit=5, cancel_after=5 — parity38's set_config shape), snapshot-restored. |

ACTIVATE INVESTIGATION RESULT (supersedes the brief's open
question): capture I's bare-custom-order activation failure
(`'Order could not be activated due to error: Module service does
not have a service class. Make sure Service.php exists and is
valid..'` + attempts 1 + order stays pending_setup) is an artifact
of the capture's crafted orders having `service_type` NULL:
`Order::getServiceType()` returns the raw column, and
`_callOnService` calls `mod_service('service'. null)` →
`Module.php:124` throws. For WELL-FORMED custom orders
(`service_type='custom'`, as all baseline orders 1–10, 167 have),
PHP activation SUCCEEDS: `custom` IS in
`BUILT_IN_SERVICE_TYPES`, `Servicecustom\Service::action_activate`
exists (returns true via adapter), and TS `activateOrderRow` also
activates. Parity39 therefore crafts BOTH: (a) well-formed custom
old-paid → both activate (agree path); (b) service_type-NULL
old-paid → PHP attempts 1 + note + stays pending_setup while TS
activates (documented divergence, per-stack expectations — TS
`activateOrderRow` sets status active regardless of service_type).
The MUST-pass activate assertions: fresh-paid (within 10 min)
untouched on both stacks (attempts 0, no note, stays
pending_setup); old-paid processed per above. No parity suite
references `batch_activate_paid` — no old assertion to update.

SUSPEND/CANCEL service-call note (consequence of the same
survey): PHP `suspendFromOrder`/`cancelFromOrder` call
`_callOnService` BEFORE the status change; `Servicecustom` HAS
`action_suspend`/`action_cancel` (both return true via adapter for
plugin-less services), so well-formed custom orders suspend/cancel
on PHP. With service_type NULL, PHP suspend/cancel throws →
per-order catch → order unchanged. Parity suspend/cancel crafts
therefore set `service_type='custom'` (matching real checkout
orders) with fresh `service_custom` rows, mirroring baseline
orders 1–3 (service_id 1–3).

## 9. Regression standard — results

Run 2026-10-29 on the final R5f code (after the §6b/§6c
corrections), reference servers `:8080` (PHP dev, workers=4) +
`:3001` (Next, TZ=UTC, full 35-module env, R5f build — bundle
verified by distinctive string literals, not minified function
names). `npx tsc --noEmit` clean; `npm run build` clean.

| Suite | Result | Notes |
|---|---|---|
| parity39 (this batch) | 212 checks, 0 failures | Full 13-job runner, gate, throttle, sessions, all three algorithms, pay, jobs, listeners, prod sendmail, expired-unpaid, final invariants. |
| parity38 (R5e SMTP) | 86 checks, 0 failures | Needed the externally-started `:8081` prod oracle (the suite does not start it itself — the first attempt crashed on connection-refused before any check; no DB state changed; re-ran with the oracle up). |
| parity37 (R5d TZ stats) | TOTAL 115 pass, 0 fail | Different report style (per-section lines, no PASS prefix). |
| parity36 (R5c Twig) | 51 checks, 0 failures | |
| parity35 (R5b prepareInvoice) | 210 checks, 0 failures | |
| parity34 (R5a config store) | 164 checks, 0 failures | |
| parity33 (R4 dispatch) | 77 checks, 0 failures | |
| parity32 | 65 checks, 0 failures | |
| parity31 | 63 checks, 0 failures | |
| parity30 | 179 checks, 0 failures | |
| parity29 | 62 checks, 0 failures | |
| parity28 | 128 checks, 0 failures | |
| parity27 | 27 checks, 0 failures | |
| parity26 | 62 checks, 0 failures | |
| parity25 | 203 checks, 0 failures | |
| parity21 | cases 203, match 194, diff 9 | EXACTLY the known 9 diffs, same names: sd_tld_delete, sd_tld_delete_used, sd_tld_delete_notfound, sd_reg_available, sd_guest_tlds, sd_guest_tlds_reg, sd_guest_tlds_trans, sh_guest_free_tlds_fallback, dl_admin_send_file_missing_stored. |
| fixtures `--stack php` | 13/13 PASS | Verified via results-php.json (all entries PASS), not just the summary line. |
| fixtures `--stack next` | 13/13 PASS | Verified via results-next.json. Fixture phase started with `:8081` FREE (killed before running) and `:3001` killed first (the runner's `start_next()` does not kill an existing listener); orphaned next-server child killed by explicit PID afterwards; reference `:3001` restarted with the full 35-module env after the run. |

OLD ASSERTIONS UPDATED: NONE. No prior suite asserted the old
`runBatchSendReminders` behavior (grep-verified before the change,
and the regression confirms it: parity25–38 all green without any
edit), and no prior suite asserted the old `issueInvoice`
created-email timing/condition or the old partial issued-event
snapshot in a way the `money.ts` rewrite breaks (parity35/34/33
green unmodified). The two mid-parity39 corrections (§6b
before/after split, §6c strict renderer) were CODE fixes driven by
PHP evidence, not assertion updates — the parity39 checks were
written to PHP truth from the start and the first run's failures
were the implementation disagreeing with PHP, fixed in code and
re-proven green (212/212).

DB invariants clean before AND after the full regression
(invoice 323, client_order 11, email_queue 67 = 5 pending + 62
sending, invoice_event 776, setting 38, order_meta 0,
email_history 0); config hash stable
(`6e3c529673c1d089405d319802708b2b81a3f41335171c49df046ed76a1d0b48`);
reference Next (`:3001`, TZ=UTC) answering after the suite;
`:8081` and `:18025` both DOWN at batch end.

Process notes from the run (not product findings): the first
parity39 attempt crashed on a harness-ordering bug (PHP admin
`config_save` called AFTER setting a pending state 503s at the
dispatcher — config must be set BEFORE the state is flipped; fixed
in the suite, not the product). A mid-run probe left one stray
pending queue row (probe 1's reminder email, cleanup missed the
queue table); the next parity39 run's §0 invariant caught it, the
row was deleted by id, and the clean re-run went 212/212. A
`pkill -f parity39.py` self-matched the operator's own shell
(the brief's warned trap) — subsequent kills used explicit PIDs.

## 10. Every divergence pinned (complete list)

1. Gate HTTP status: PHP 503 vs TS HTTP 200 + envelope code 503
   (seam convention, documented not faked).
2. Gate side effects: PHP bootstrap finalizes a pending state (+60
   backfill) and flips maintenance ON for a missing state file;
   TS does neither (R5j scope).
3. TS missing/unparseable state → gate closed (mirrors PHP
   ensure→pending outcome without the side effect).
4. Throttle microsecond boundary: PHP `DateTime('-1min')` carries
   microseconds; TS matches with ms precision (§3).
5. TS hash `!==` vs PHP `hash_equals` — unobservable, not chased.
6. `last_cron_exec` TZ: PHP process-TZ wall time vs TS UTC
   `nowTimestamp()` — equal under config UTC (standing write-side
   TZ gap).
7. now-TZ notes: ticket auto_close, expire_password_reminders
   (SQLite UTC `datetime('now')` vs PHP process-TZ wall now);
   cart/suspend/cancel cutoffs fixed to zone-aware in R5f; the
   remaining now-comparisons keep UTC `nowTimestamp()` (identical
   on the reference).
8. Activity-cleanup cutoffs use UTC arithmetic (not in the brief's
   zone list; identical on the reference).
9. Currency live fetch: TS fetches, PHP dies at sandbox TLS and
   swallows — only default/manual/never-gate paths proven.
10. Servicedomain per-domain registrar sync: not implemented
    (timestamp + gate only; 0 domains on reference).
11. Extension refresh pruning: deliberately NOT implemented
    (would contradict R4a).
12. SEO ping: deliberately NOT implemented (Seo inactive on the
    reference).
13. GeoIP/cache prune: no-op (no filesystem pools in TS).
14. healSchemaDrift: documented no-op (installer/importer concern).
15. Domain renewal repricing: fail-safe skip (rate lookup throws
    PHP's exact message when unconfigured; configured domain
    orders skipped, not generated at a wrong price).
16. Renewal promos: no TS path (parity uses orders without
    recurrent promos).
17. Renew-task execution in activate_paid: not wired (pinned gap).
18. Deposit/custom item execution in activate_paid: TS leaves them
    pending_payment; PHP marks executed unconditionally.
19. Credits-pay immediate item execution (PHP) vs TS activate
    deferral with 10-min cutoff.
20. Cancel_unpaid enabled path: PHP deletes, TS cancels (gate only
    in R5f).
21. Reminder PDF attachment: not implemented (R5e template_send
    attachment gap) — parity compares queued rows + reminded_at +
    journal events, NOT attachment bytes.
22. Hash-lifetime extension on reminders/created emails: not
    implemented (TS has no extendInvoiceHashLifetime).
23. Hosting-manager suspend calls: not implemented (custom-type
    orders only in parity).
24. Suspension-warning missing/disabled template: TS does not
    auto-create the disabled row PHP's getOrCreateTemplateByCode
    would (minor, unasserted — parity crafts an enabled template).
25. Money-flow template rendering: TS `queueInvoiceEmail` uses the
    FORGIVING renderer while PHP's sendTemplate renders STRICT — a
    broken money-flow template would throw (caught, email skipped,
    reminded_at/journal kept) on PHP but queue a literal render on
    TS. Only the suspension-warning send was switched to strict in
    R5f (it is the directly-asserted sendTemplate mirror); switching
    `queueTemplatedEmail` globally is a later batch's call (it would
    change R5e behavior for all money emails).
26. service_type-NULL activation/suspend/cancel: PHP throws
    (attempts/note/unchanged), TS activates (per-stack assertions).
27. Pre-existing journal snapshot shapes + NULL client_id gap for
    paid/canceled/refunded events from pre-R5f callers: deliberately
    NOT rewritten (only NEW R5f events carry real client_id).
28. Generate iteration order: TS client_id DESC (query order) vs
    PHP findBy natural order — nr sequence differs, final
    per-order state does not (parity asserts nr
    numeric/distinct/serie, not exact values).
29. `sendInvoiceReminder`'s paid no-op is unreachable via the
    claim (claim requires unpaid) — implemented anyway, matching
    PHP.
30. PHP's own inconsistencies, mirrored: invoke_due effectively
    dead within a full run after send_reminders sets the gate (§1);
    run=false practically unreachable (§1); TS send_reminders
    replacement has no old parity assertion to update.

## 11. R5f/R5g boundary

- Nothing in R5f changes rate limiting: the `api_login` 10/hour
  fixed-window limiter is PHP-side only (ENFORCED on the `:8081`
  prod oracle, BYPASSED on `:8080` dev — parity39 logs in ONCE via
  dev and reuses the session, never burning prod logins per
  section). TS still has no limiter; R5g ports it.
- No new endpoints were required: all 13 jobs run through existing
  admin/guest cron endpoints plus the existing batch endpoints
  (generate, invoke_due_event, send_suspension_warnings now call
  real implementations; their ADMIN_GUARDS entries already
  existed). The runner itself does not re-check permissions; PHP
  passes via the cron-admin identity rule ("cron admin → true" in
  hasPermission), and TS calling internal functions directly is
  the practical equivalent — documented, not a new endpoint.
- `cron.ts` header comment updated: the old claim that
  PHP-only-module jobs "still run under PHP cron during the
  strangler period" is obsolete after R5f and was removed.

## 12. Left unverified (with what would verify it)

- Live currency fetch parity: deliberately unasserted (sandbox
  TLS asymmetry, §5). Verifying it needs a network path where
  PHP's fetcher succeeds (non-sandbox TLS) or a local rate server
  both stacks can reach.
- Registrar per-domain sync: needs registrar credentials + a real
  domain row (0 domains on reference).
- Hosting-manager suspend calls: needs a hosting-type order +
  manager (out of scope for custom-type parity).
- Renew-task execution, domain repricing, renewal promos,
  reminder PDF attachment, hash-lifetime extension: each needs its
  own implementation batch + parity section (all pinned above).
- Cancel_unpaid enabled path: needs the delete-cascade
  implementation (a full rewrite, out of R5f scope) before it can
  be asserted.
- `invoice_send_cancel_email === '1'` path: setting is `'0'`/absent
  on the reference; the template code (`mod_invoice_canceled`)
  was read from `Invoice/Service.php::sendCancelEmail` but the
  path is unasserted. Verifying it needs the setting flipped +
  a crafted expired-unpaid invoice.
- Task-level isolation failure (`run === false`) and non-isolated
  abort: not constructible without violating constraints (no DB
  corruption, no PHP changes, no fake throws) — proven by code
  inspection + per-item tolerance (§1), not by a live failing run.
- `runBatchExpireCarts`' staff-exclusion and the `batch_expire`
  ADMIN_GUARDS entry: the handler uses `requireAdmin` inline (as
  its siblings do); the guards file was not touched, so no
  separate verification was needed.
