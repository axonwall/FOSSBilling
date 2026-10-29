# Findings — R5a: config store + deferred system endpoints + update_params validation

Scope: docs/nextjs-strangler/phase5/r5-scope.md §R5a, decisions R5-2
(config store) and R5-10 (update_params validation in R5a). Capture
corpus: capture37.py + captures37/ (42 files). Parity: parity34.py
(**164/164**). Script test: scripts/config-store-test.ts via
scripts/run-config-store-test.mjs (**25/25**). No PHP source changed.
No commit (left uncommitted for review, per standing pattern).

## 1. Survey answers (PHP is the truth; the scope draft survived intact)

All six endpoints live in `src/modules/System/Api/Admin.php`; the
validation lives in `System\Service::updateParams()`; the config
mechanics in `src/library/FOSSBilling/Config.php`.

### 1.1 The six endpoints

| Endpoint | Permission key | Behavior (measured) |
|---|---|---|
| `localization_settings` | `system/manage_settings` | Returns `{locale, auto_detect_locale}` from config.php: locale string-cast, default `'en_US'`; auto_detect via `Tools::normalizeBoolean(value, true)`. |
| `update_localization_settings` | `system/update_params` — **NOT manage_settings** | Writes locale only when set AND non-empty; ALWAYS writes auto_detect normalized (absent/null → true → true). Returns true. |
| `error_reporting_enabled` | `system/view` | `(bool)` cast of `debug_and_monitoring.report_errors`, default false. |
| `toggle_error_reporting` | `system/toggle_error_reporting` | Reads current (default false), writes `!current`, returns true. |
| `last_error_reporting_change` | `system/view` | Returns the code constant `SentryHelper::last_change = '0.8.8'` — NOT a setting. No read, no write, nothing to configure. |
| `instance_id` | `system/view` | Returns `INSTANCE_ID`, defined at load (`load.php:358`) from `info.instance_id`, default `'Unknown'`. |

The asymmetry is PINNED, not fixed: `update_localization_settings`
checks `update_params` while its read sibling checks
`manage_settings`. parity34 §C proves it from both directions (an
update_params-only persona CAN write localization; a
manage_settings-only persona CANNOT). A future batch must not
uniformize this.

### 1.2 update_params validation (the R2e gap, closed)

`System\Service::updateParams()` validates EVERY key in a first loop
and writes in a second loop — validate-then-write, so one invalid
value rejects the whole call and nothing is written (parity34 §D
proves the nothing-written half twice: a probe param + a full-form
38-field post with one bad field).

- `invoice_starting_number` (key matched case-insensitively):
  value must be int or string AND pass `FILTER_VALIDATE_INT` with
  min 1, max `PHP_INT_MAX - 1`. Else `InformationException`
  (code 0 → envelope 9999):
  `Next invoice number must be a positive whole number no greater than 9223372036854775806.`
  (The `:max` placeholder substitutes `PHP_INT_MAX - 1`.)
- `invoice_reminder_send_time`: null or blank (after trim) passes;
  otherwise the trimmed value must match
  `/^([01]\d|2[0-3]):[0-5]\d$/`. Else:
  `Reminder send time must be empty or a valid 24-hour time (HH:MM).`
- JSON bodies carry native types into the same rules: null/true/5.5
  for starting_number all fail; 5 passes; null for reminder passes
  (and is then WRITTEN — see §5 N1 for the stored-value divergence).
- Deliberately NOT added: `canUpdateParam`'s company-field
  permission checks (`manage_company_details` /
  `manage_company_legal`). That is a separate concern; R5a scope is
  validation only, and the write loop is otherwise untouched.

### 1.3 Scalar semantics the TS code mirrors exactly

- `Tools::normalizeBoolean($value, $default)`: bool passes; int/float
  cast (0/0.0 false, everything else true); strings via
  `FILTER_VALIDATE_BOOLEAN` — `1/true/on/yes` true,
  `0/false/off/no/''` false (note: empty string is FALSE, not the
  default), anything else → default, case-insensitive; anything
  else → default. This is why `auto_detect_locale: "banana"` reads
  back true (default true) while `"0"` reads back false.
- PHP `(bool)` cast (error_reporting_enabled, toggle): `false, 0,
  0.0, '', '0', null, []` are false; everything else — including
  the string `'false'` — is true.
- PHP `(string)` cast (locale, instance_id): null → `''`, true →
  `'1'`, false → `''`, numbers → decimal, arrays → `'Array'`.

### 1.4 Config file mechanics (Config::setConfig / setProperty)

- Read: `include PATH_CONFIG`, dot-notation walk, default on any
  missing segment. `PATH_CONFIG` = install root `config.php`
  (`load.php:293`).
- Write: `setProperty` walks/creates intermediate arrays (a scalar
  intermediate is REPLACED with `[]`), then `setConfig` copies the
  current file to `config.old.php` and rewrites the whole file with
  `prettyPrintArrayToPHP` (var_export-style, 4-space indent, nested
  empty arrays single-line, top-level empty arrays multi-line, no
  trailing newline). Two consecutive `setProperty` calls therefore
  produce TWO backups, the second holding the first call's result —
  on TS. On PHP there is a quirk (see §5, backup mtime gate).
- `setConfig` also wipes PHP's Twig/Doctrine cache. The TS store
  does NOT: config.php values are not held in those pools (the 1h
  app-pool cache covers DB-backed extension config, not config.php),
  and the seam reads config.php fresh on every call.

### 1.5 The R2e "39 fields" correction

R2e's findings claim 39 editable settings fields, but its own
enumeration totals 38 (21 company + 13 invoices/funds + 4
nameservers), and `system-settings-fields.ts` lists exactly those
38. parity34 posts the actual 38. The "39" was an arithmetic slip
in the R2e note, not a missing field: no 39th template field was
found. (The form contract — post exactly the listed fields — is
unchanged; only the count was wrong.)

## 2. Config store design (apps/nextjs/src/server/config-store.ts)

Interface for later batches (R5d TZ, R5i security, R5j installer):

- `resolveConfigPath()` — `FB_CONFIG_PATH` (explicit; tests and
  disposable copies) → `dirname(dirname(FB_DATABASE_PATH)) +
  "/config.php"` (standard layout: data dir directly under the
  install root) → `FOSSBILLING_PHP_SRC + "/config.php"` → throw
  (never silently read a wrong file).
- `getConfigProperty(path, def)` / `setConfigProperty(path, value)`
  — dot-notation, PHP semantics (§1.3/§1.4). Reads are fresh every
  call (no cache, by design: a PHP write must be visible to the
  next TS read and vice versa).
- `readConfigFile()` / `writeConfigFile()` / `parseConfigSource()`
  / `serializeConfig()` — full-file operations.
- `phpNormalizeBoolean(value, def)` / `phpBoolCast(value)` /
  `phpStringCast(value)` — §1.3 helpers, shared by the endpoints.

Parser subset (refusals are fail-fast FbErrors, never silent
misreads): the file must be `<?php return [...]` with array
literals only — strings (single/double quoted), ints, floats,
bools, null, nested arrays (`[...]` or `array(...)`), `=>` pairs,
trailing commas, comments. Refused: constants, function calls,
concatenation, arithmetic, string interpolation, unsafe ints
(beyond 2^53 — a silent precision loss would be worse than a
refusal), nesting past 25 (mirroring `MAX_RECURSION_LEVEL`).
PHP's own writer drops comments; this writer does the same.

Writer fidelity, PROVEN not asserted: the script test's T2 case
compares TS output byte-for-byte against the real PHP
pretty-printer (via reflection on `Config::prettyPrintArrayToPHP`)
for a sample covering quoted/backslashed/newlined strings, ints,
floats (1.5, 1e20), bools, null, nested + empty arrays, and a
sequential list — identical. T3 proves PHP can `include` the
TS-written file and read the same values back.

Two honest representation limits (JS has no int/float distinction):

- Integral JS numbers below 1e14 serialize as PHP ints; at/above
  1e14 they serialize as PHP floats (`1e20` → `1.0E+20`, matching
  PHP's %G exponent threshold). The VALUE always survives; only
  the int-vs-float tag is ambiguous near the threshold, and no
  config value in the corpus sits there. Float formatting otherwise
  follows PHP's precision-14 %G rendering (`1.0` → `"1.0"` is
  unrepresentable in JS — `1.0` IS `1` — so integer-valued numbers
  serialize without `.0`; accepted, documented).
- Backup semantics: TS copies unconditionally (deterministic);
  PHP's copy is mtime-gated (see §5). TS is deliberately the safer
  of the two; mirroring the skip would be mirroring a race.

Precedence contract (R5-2): env > config.php for DEPLOYMENT values
(salt, DB credentials — the existing `FB_INFO_SALT` /
`FB_CALLBACK_SALT` precedent in crypt.ts); config.php is
authoritative for TOGGLED values (locale, report_errors,
instance_id). This module is the config.php side only — it does
not invent env names for toggled values. R5d's TZ read will apply
the env override at its own layer, per its scope.

## 3. parity34 results (164/164)

- §A invariants baseline: exact match (incl. setting 38 rows,
  service_custom 17, extension 6 installed, extension_meta 3).
- §B super reads: all four read endpoints byte-equal envelopes on
  both stacks; localization shape `{locale: "en_US",
  auto_detect_locale: true}`; last_change constant `"0.8.8"`.
- §C permission matrix: 5 crafted groups/staff (access-only,
  manage_settings, view, update_params, support-only) × 7 methods,
  envelopes equal on both stacks throughout; pinned semantics hold
  (support-only 725 everywhere; access-only 403 everywhere;
  manage_settings reads localization but 403s toggle;
  view reads the three view endpoints but 403s localization;
  update_params writes localization — the asymmetry — but 403s
  localization read). Logged-out 201s on all seven, both stacks.
- §D validation: all invalid/valid/combined/mixed-case/JSON cases
  equal with PHP's exact messages; JSON 5 stored `"5"` both;
  validate-then-write (probe absent both); full-form 38-field post
  with current values succeeds both with read-back equality;
  full-form-with-one-bad-field errors both with nothing written
  both. (The full-form post with current values is also the
  regression proof that validation did not break the R2e 39→38
  field contract.)
- §E config writes: toggle round-trips flip-and-restore on each
  stack; TS toggle visible to a PHP read (polled — no opcache
  staleness observed, first poll hit); TS toggle-back visible too.
  Localization round-trips (write, then empty-locale + banana →
  locale unchanged, auto_detect defaults true) on each stack.
  Backup chain: TS backup after a two-write call holds the FIRST
  write's result exactly as PHP intends; PHP's backup holds the
  pre-call file OR the first write (§5 quirk), asserted as the
  disjunction.
- §F secret scan over all captured envelopes: clean.
- §G restore proof: DB snapshot restored (invariants identical),
  config.php bytes identical, config.old.php state identical
  (absent before, absent after — the run created and removed it
  via restore), all five crafted personas gone.

### 3.1 A real bug parity34 caught (fixed in-batch, not papered over)

The first parity34 run failed `D json-null-remind`: TS answered
the reminder error for a JSON null, while PHP accepts it. Root
cause was in the NEW handler, not the suite: the validation loop
used `rawOrParam(ctx, k) ?? v`, and `??` treats JSON null as
missing, substituting the stringified params form (`"null"`),
which fails the regex. For starting_number the same bug was
invisible (null and `"null"` both fail, for different reasons).
Fix: presence-checked raw value (`k in ctx.rawParams ?
rawParams[k] : v`) with a comment naming the trap. Rebuilt,
restarted, re-ran: 164/164. The lesson generalizes: never use `??`
to fall back from rawParams — null is a value, not an absence.

### 3.2 Two harness lessons from capture37 (kept, not repeated)

- The first JSON capture run was vacuous: JSON posts without a
  CSRFToken inside the body get PHP CSRF 403s (PHP's CSRF check
  reads the token from the parsed body; a bare JSON post has none).
  Fixed by including the token in the JSON payload — after which
  all JSON cases proved real behavior (null/true/5.5 → 9999, 5 →
  stored `"5"`, null reminder → stored NULL).
- The N1 stored-value comparison must reset between stacks: both
  stacks share one DB, so reading "both" after the pair only ever
  shows the last write. parity34 resets to `"09:30"`, calls TS
  alone (reads `"null"`), then PHP alone (reads NULL).

## 4. What R5d / R5i / R5j reuse

- R5d (TZ): `getConfigProperty("i18n.timezone", ...)` from this
  module, plus the env-override-at-caller pattern from §2. The
  runtime config already carries `i18n.timezone` (and
  `date_format`/`time_format`/`datetime_pattern`) — R5d does not
  need a new store, only the read + precedence rule.
- R5i (security): `ip_lookup` needs no config writes; the
  `run_check`/`run_checks` port reads config-store flags for
  `generalCheck` (same `getConfigProperty` calls PHP's checks
  make via `Config::getProperty`). No new store work expected.
- R5j (installer): `writeConfigFile` + `serializeConfig` for the
  fresh config, `setConfigProperty` for post-install toggles, and
  the writer byte-equality proof (T2) as the "PHP can read what we
  wrote" gate. The installer must also handle the salt lesson
  (fresh target salt never matches a source install's) — the store
  itself is salt-agnostic by design.

## 5. Divergences (pinned, not hidden)

- **N1 — JSON-null reminder stored value (pre-existing write loop,
  out of R5a scope):** PHP stores NULL; TS stores the string
  `"null"` (the route stringifies JSON null into params, and the
  R5a scope leaves the write loop untouched). Envelopes agree
  (`true`); `get_params` afterwards differs (`null` vs `"null"`).
  Fixing it means changing the write loop to prefer rawParams
  values — a separate batch with its own regression run, since it
  touches every update_params caller, not just validation. (The
  same write-loop question applies to JSON bools/ints on
  non-validated keys — e.g. a JSON `true` for a checkbox field
  stores `"true"` on TS while PHP stores via Doctrine native
  typing. Untested by parity34; named here so a future batch does
  not rediscover it as a surprise.)
- **PHP backup mtime gate (PHP quirk, TS deliberately safer):**
  Symfony `Filesystem::copy` (vendor source, `Filesystem.php:47-48`)
  sets `$doCopy = filemtime($origin) > filemtime($target)` when not
  overwriting. Two `setProperty` calls in one request usually land
  in the same second, so the second backup is skipped and
  `config.old.php` keeps the PRE-call file. TS copies
  unconditionally, so its backup always holds the first write.
  Mirroring the skip would be mirroring a race; the suite asserts
  the PHP disjunction (pre-call OR first-write) and the TS exact
  state.
- **JS int/float ambiguity (§2):** integral values serialize as
  PHP ints below 1e14 and as PHP floats at/above it; a JSON number
  past 2^53 is imprecise in JS, so the starting-number boundary is
  exact only for string inputs (the realistic path — urlencoded
  forms). A JSON number `9223372036854775806` arrives rounded and
  is conservatively rejected; PHP would accept it. Documented,
  accepted: no realistic caller posts invoice numbers as JSON
  floats past 2^53.
- **PHP 1h app-pool cache (pre-existing, R4a):** DB-backed
  extension config reads can go stale after out-of-band writes.
  Not a config.php issue (config.php is included fresh per
  request, modulo opcache revalidation — and §E's cross-stack poll
  proves TS writes are visible to PHP reads without delay here).

## 6. Left unverified (with what would verify it)

- No admin UI was built in R5a (endpoints only, per scope) — the
  R2e settings form still posts its 38 fields, proven at the API
  path; no new form click-through exists to verify.
- The store against a live Postgres-backed deployment: config.php
  is filesystem state, driver-independent, but no Postgres-backed
  Next server exists in the sandbox to run parity34 against. R3c's
  live Postgres proof would cover the deployment shape, not the
  store logic (which has no DB dependency).
- Writer floats outside the tested range (subnormals, >1e21):
  the precision-14 %G algorithm covers them by construction, but
  no case asserts them; a future float-valued config key should
  add a T2 sample entry first.
- The R2e live-currency-refresh and Stripe-success items are
  unchanged standing items, untouched by R5a.

## 7. Files changed (uncommitted)

- `apps/nextjs/src/server/config-store.ts` (new, ~700 lines) —
  parser, writer, dot-notation access, PHP scalar helpers.
- `apps/nextjs/src/server/modules/system.ts` — six endpoint
  handlers + update_params validation loop + raw-aware reads.
- `apps/nextjs/src/server/guards.ts` — six ADMIN_GUARDS entries
  (incl. the pinned update_params asymmetry).
- `apps/nextjs/scripts/config-store-test.ts` (new) +
  `apps/nextjs/scripts/run-config-store-test.mjs` (new) +
  `apps/nextjs/scripts/config-store-php-pretty.php` (new, test
  helper only) — 25/25.
- `docs/nextjs-strangler/phase5/capture37.py` (new) +
  `docs/nextjs-strangler/phase5/captures37/` (42 files) — PHP
  reference corpus, config + settings restored.
- `docs/nextjs-strangler/phase5/parity34.py` (new) — 164/164.
- `docs/nextjs-strangler/phase5/findings-r5a.md` (this file).

## 8. Regression results

All run against the freshly rebuilt server (bundle chunk verified to
contain the new validation message + `"0.8.8"` literal):

- tsc + `next build` clean; config-store-test **25/25**; parity34
  **164/164** (after the §3.1 fix; the first run was 161/164 with
  the three failures diagnosed above, none waived).
- Prior suites, all green: parity33 77/77, parity32 65/65, parity31
  63/63, parity30 179/179, parity29 62/62, parity28 128/128,
  parity27 27/27, parity26 62/62, parity25 203/203 (its
  `php=403 ts=200` line for `canned_delete` is the standing
  seam-wide convention — TS envelopes are always HTTP 200 — printed
  informationally; the suite verdict is ALL GREEN).
- parity21: **194/203 with exactly the known 9 diffs by name**
  (`sd_tld_delete`, `sd_tld_delete_used`, `sd_tld_delete_notfound`,
  `sd_reg_available`, `sd_guest_tlds`, `sd_guest_tlds_reg`,
  `sd_guest_tlds_trans`, `sh_guest_free_tlds_fallback`,
  `dl_admin_send_file_missing_stored` — confirmed from the
  regenerated `parity21-diffs.json` keys).
- Fixtures: **13/13 both stacks**, verified via the results JSONs
  (all entries PASS), re-run properly isolated (see incident note).
- Invariants after everything: all counts at baselines (invoice
  323, client_order 11, email_queue 67, service_custom 17,
  extension 6, extension_meta 3, setting 38, admin 2, groups 3,
  members 1); config.php bytes identical to the capture37 baseline
  hash; config.old.php content preserved (en_US / auto true /
  report_errors false). Standing sequence note, corrected:
  `setting` seq 56 and `extension_meta` seq 41 are the PRE-R5a
  values (proven by the 02:08 disposable snapshot, which predates
  all R5a regression runs) — parity21's partial restore does not
  cover those tables' sequences, so they sit above the R4d note's
  54/39, which was captured at a different point in that
  verification order. Rows are correct; only the counters differ.

### 8.1 Regression incident (my miss, repaired, disclosed)

The first regression pass ran the fixture runner while my
reference-DB Next server still held :3001. The runner's
`start_next()` does not kill an existing listener (known trap,
documented in prior batches) — its wait-ready probe succeeded
against MY server, so the "next" fixture run executed tax/money
flows against the REFERENCE database instead of the disposable
copy, creating 10 invoices, 3 orders, 11 email-queue rows and
their subgraph (12 invoice items, 23 invoice events, 1
transaction, 3 order statuses, 10 admin-history rows) at
2026-10-29 02:09 UTC. The 13/13 result itself was valid as a seam
test (it ran the fresh R5a build), but the isolation was broken.

Repair (backup taken first at
`~/scratch/fossbilling/r5-logs/reference-before-r5a-cleanup-2026-10-29.sqlite`):
deleted exactly the 02:09 burst subgraph (children first, by
invoice/order id sets) and reset those 8 tables' sequences to the
pre-burst snapshot values; verified zero orphans reference burst
ids (the 283 orphan invoice events + 2 orphan transactions that
remain are pre-existing, Oct 24–26, from earlier partial-restore
eras). Fixtures were then re-run properly isolated (:3001 killed
first): 13/13 both, reference counts unchanged afterwards.
A second incident in the same window: a `pkill -f parity34.py`
self-matched my own shell (the documented trap) and killed a
parity34 run mid-flight, stranding its 5 crafted personas; they
were deleted manually (memberships → admins → groups, sequences
reset to max id) and parity34 was re-run clean: 164/164. The
fixture runner's orphaned `next-server` child (SIGTERM hits the
npx wrapper, the child survives reparented) also had to be killed
by explicit PID before my server could rebind :3001. All three
are the standing traps, re-learned the hard way; none were hidden
from the counts above, and the final state was re-verified after
each repair rather than assumed.
