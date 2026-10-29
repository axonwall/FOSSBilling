# Phase 5 R5 scope — retirement runtime replacements (DRAFT, awaiting approval)

R5 is the Phase 5 runtime-replacement workstream (plan.md §R5, decisions
D5-1..D5-6 already approved): the TS seam stops depending on PHP for
scheduled work, mail delivery, login limiting, signup checks, installs,
timezones, template evaluation, and the last deferred endpoints. It
closes the deferred-9 (R5a takes the 6 system endpoints, R5i takes the
3 security endpoints) and the standing divergences R1–R4 deliberately
left behind (prepareInvoice NULL semantics, Twig `{% set %}`,
process-local stats midnights, `update_params` validation). R5 changes
runtime MODELS (config store, cron runner, mail transport, limiter
backend, installer) — it does NOT change traffic routing: per-module
proxy removal, shadow runs, and PHP deletion stay R6's, and the proxy
fallback stays untouched throughout R5.

Closing accounting entering R5 (re-derived 2026-10-28 by
`endpoint-accounting.py`, exit 0): **539 TS-served + 31 removed + 9
deferred = 579, 0 proxied outside those buckets.** The 9 deferred are
still PHP-served until R5 closes them: system
`localization_settings`, `update_localization_settings`,
`error_reporting_enabled`, `toggle_error_reporting`,
`last_error_reporting_change`, `instance_id`; security `ip_lookup`,
`run_check`, `run_checks`. R5's end-state accounting is **548 + 31 +
0 = 579**: R5a adds the 6 system endpoints, R5i adds the 3 security
endpoints; no other batch changes the count (the limiter batch changes
the behavior of already-served `rate_limit_*` endpoints, not their
count).

R3c (live Postgres/MySQL verification) is a SEPARATE tap awaiting
Josh's endpoints — it is NOT absorbed into R5. But R5's installer
replaces the R3 SchemaInstaller bridge, so the installer's schema
output must match SchemaInstaller's: that equality is an explicit
verification criterion for the installer batch (see R5j), and R3c's
live driver proof still stands on its own.

## 0. Survey findings (measured 2026-10-28, before scoping)

### 0.1 Cron runner — the "8 missing jobs" count VERIFIED, with a correction to the plan's framing

PHP `src/modules/Cron/Service.php:62` `runCrons()` runs **13 batch
jobs in fixed order**: first `invoice_batch_pay_with_credits` and
`invoice_batch_activate_paid` as NON-isolated `_exec` calls (a failure
here aborts the whole run before `last_cron_exec` is updated), then
11 isolated tasks (each failure caught, logged, collected; the run
still updates `last_cron_exec`, clears sessions, dispatches the After
event, and returns false):
`invoice_batch_generate`, `invoice_batch_send_reminders`,
`invoice_batch_invoke_due_event`, `order_batch_send_suspension_warnings`,
`order_batch_suspend_expired`, `order_batch_cancel_suspended`,
`order_batch_cancel_unpaid`, `support_batch_ticket_auto_close`,
`client_batch_expire_password_reminders`, `cart_batch_expire`,
`email_batch_sendmail`.

Pre-gates: update-finalization pending → 503 exception, no jobs run;
`healSchemaDrift()` attempted first (failures only logged).
Post-steps: set `last_cron_exec`, `clearOldSessions()`
(`Cron/Service.php:187`: `DELETE FROM session WHERE lifetime <:now OR
created_at <=:age`, age = now − `security.session_lifespan` config,
default 7200s), `AfterAdminCronRunEvent` dispatch, return false if any
isolated task failed else true. `BeforeAdminCronRunEvent` /
`AfterAdminCronRunEvent` are dispatched around the jobs. The CLI entry
`src/cron.php` is CLI-only and passes `$argv[1]` as `$interval` to
`runCrons($interval)`, but `runCrons()` takes no parameter in 0.8.9 —
the interval is accepted-and-ignored (extra args to user-defined PHP
methods are ignored); same in `src/modules/Cron/Commands/Run.php:57`
(which also prints last-executed time and maps success/failure to
exit codes, with partial failures surfacing via non-zero exit).

TS `apps/nextjs/src/server/modules/cron.ts` `runCronJobs()` invokes
only **5**: `runBatchActivatePaid`, `runBatchSendReminders`,
`runBatchSuspendExpired`, `runBatchCancelSuspended`,
`runBatchCancelUnpaid` (from invoice.ts/order.ts), then sets
`last_cron_exec`. It does NOT invoke the other **8 — that is the
verified "8 missing" set**: pay_with_credits, generate,
invoke_due_event, send_suspension_warnings, auto_close,
expire_password_reminders, cart_expire, sendmail.

**Correction to the plan's framing:** all 13 batch jobs already have
TS endpoint handlers registered (verified by grep over
`apps/nextjs/src/server/modules/*.ts`: invoice `batch_pay_with_credits`,
`batch_generate`, `batch_invoke_due_event`; order
`batch_send_suspension_warnings`; support `batch_ticket_auto_close`;
client `batch_expire_password_reminders`; cart `batch_expire`; email
`batch_sendmail` — plus the 5 the runner already calls). The gap is
runner wiring + implementation depth, not endpoint existence.
Endpoint depth, measured: REAL implementations exist for
pay_with_credits (invoice.ts:645, but ids-based only — see below),
auto_close (support.ts:354, real SQL: on_hold tickets past
`support_helpdesk.close_after` hours → closed),
expire_password_reminders (client.ts:799, real DELETE of
`client_password_reset` rows older than 2h), cart_expire (cart.ts:1914,
real DELETE of carts older than 7 days excluding `staff:%` sessions),
sendmail (email.ts:219, flip-only: pending → `sending`, returns null,
no transport). STUBS returning true: batch_generate (invoice.ts:1926
— comment claims "subscription-driven generation lives in the
subscription billing engine (gateway-side); no DB-visible effect on
the reference corpus"), batch_invoke_due_event (invoice.ts:1934, bare
true), batch_send_suspension_warnings (order.ts:482, bare true).

Runner semantic gaps vs PHP, all to scope: no update-finalization
gate; no healSchemaDrift; no Before/After event dispatches; no
clearOldSessions; no per-task isolation (TS: first throw aborts
everything and `last_cron_exec` is never set; PHP: isolated failures
collected, `last_cron_exec` still set, returns false); no false
return (TS `admin/cron/run` and `guest/cron/run` always return true
on success); no guest 1-minute throttle (PHP `Cron/Api/Guest.php`
returns false without running if `last_cron_exec` is within the last
minute; TS guest run checks only `cron_guest_enabled` + `cron_hash`).

PHP job implementations the R5 batch must mirror (read 2026-10-28):
`doBatchPayWithCredits` (`Invoice/Service.php:3761`):
`findAllUnpaid($data)` → all unpaid invoices (with `$data` filters if
given) → `tryPayWithCredits` each, per-invoice try/catch with
covered/skipped/failed counts, always returns true. TS endpoint is
ids-based only, so runner wiring needs the no-ids = all-unpaid path,
not just calling the endpoint. `generateInvoicesForExpiringOrders`
(`Invoice/Service.php:4033`): `getSoonExpiringActiveOrders()` → per
order, merge evaluation (`shouldMergeRenewalsForOrder` +
`hasActiveSubscriptionForOrder`) → merged buckets or
`generateForOrder` + `issueInvoice(use_credits=true)`; per-order
failures only logged. **The batch_generate stub's "no DB-visible
effect" comment is therefore suspect — PHP's implementation really
generates — and the batch implements PHP's algorithm rather than
accepting the stub's claim.** `doBatchInvokeDueEvent`
(`Invoice/Service.php:4184`): once-per-day gate via
`invoice_overdue_invoked` setting (86400s) →
`fireDueReminderEvents()` (Before/AfterInvoiceIsDue events for unpaid
issued invoices in range; built-in handlers claim via `reminded_at`
before sending, which is what prevents duplicate reminders across
overlapping runs). `batchSendSuspensionWarnings`
(`Order/Service.php:1847`): `getDueSuspensionWarnings()` → claim via
`client_order_meta` (`META_SUSPENSION_WARNING_FOR`) with row lock →
`sendTemplate` `mod_order_suspension_warning` → release claim on
failure; Before/After batch events around it.

Survey items closed during scoping (evidence, not assumptions): TS
`runBatchSendReminders` DOES claim via `reminded_at`
(invoice.ts:1884, 1910) — so invoke_due_event reuses the same
claiming, and no new claiming mechanism is needed. No in-tree
listeners for Before/AfterInvoiceIsDue exist outside
`Invoice/Service.php` itself (grep over modules + Events found
nothing else) — so invoke_due_event needs no in-process event bus;
the Before/After events are no-ops in TS. Cron Before/After event
listeners are a batch grep item (§6, open question 4).

### 0.2 Email transport — fully mapped from `Email/Service.php` + `src/library/FOSSBilling/Mail.php`

TS today is queue-only: `emailer.ts` exports `queueEmail` (INSERT into
`email_queue` with status `'pending'`, priority default 1),
`queueTemplatedEmail`, `queueInvoiceEmail` (never throws — "a broken
email must not break the money flow"); `email.ts:219`
`batch_sendmail` flips pending → `sending` and returns null — no
transport exists. PHP `Email/Api/Admin.php:413` `batch_sendmail`
returns false if the demo extension is active, else
`Email/Service.php:1173` `batchSend()`: reads the email module config
(`$mod->getConfig()` = extension config for mod_email, stored
encrypted in `extension_meta`); `time_limit` (default 5, ×60s budget
per batch), `queue_once` (default 0); `findDueBatch((int)
$sendPerCron)` (`QueuedEmailRepository.php:72`: statuses
unsent/pending/failed, priority DESC, id ASC; limit > 0 applies, 0 =
unlimited); per email `_sendFromQueue()`: status → `sending`, append
PHP_EOL to content, build `FOSSBilling\Mail(sender, recipient,
subject, content, transport, custom_dsn)` with transport =
settings['mailer']?? 'sendmail', custom_dsn = settings['custom_dsn']??
null; attachment, reply-to (validated, invalid → logged warning +
skipped), bcc (validated list, invalid → logged warning + skipped);
**non-production env → skip send, return true, leaving the row at
`sending`** (a quirk the TS batch must decide to mirror or document);
`$mail->send($settings)`; on success → activity `logEmail` if
`log_enabled` → DELETE the queue row; on failure → priority −1,
status failed, tries +1, flush; if tries > `cancel_after` (default 5)
→ log + DELETE row; if `throw_exceptions`, rethrow a truncated
(350-char) message. Transports in `Mail.php:138` `send()`:
`'sendmail'` → `sendmail://default` (shells out via proc_open +
escapeshellarg; throws if those PHP functions are disabled); `'smtp'`
→ SMTP DSN built by `__smtpDsn` from options `smtp_host`,
`smtp_port`, `smtp_username`, `smtp_password` (host/port required;
auth string only if username present); `'sendgrid'` →
`sendgrid://<key>@default`; `'custom'` → the provided DSN (missing DSN
→ InformationException "Unable to send email: 'Custom' transport
method was selected without a custom DSN"); all via Symfony Mailer
`Transport::fromDsn`. PHP `sendMail($to, $from, …, $send_now = false,
…)` (`Email/Service.php:434`) always queues first; sends immediately
only if `$send_now`.

**Bounce handling: PHP has none** (failed → retries → delete after
max tries; no bounce processing) — the plan's "bounce handling
decisions" is therefore a genuine open decision, with PHP-equivalent
(retry-then-drop) as the conservative default and provider webhooks
deferred. The demo-module guard is vacuous in TS (no demo module in
the registry) — scope note, not a behavior to port. **Decision shape
for the draft (D5-4, still TBD):** options must be grounded in the
codebase — SMTP honoring the existing email-module config keys (the
only transport with stored-credential fields already defined:
smtp_host/port/username/password) vs SendGrid key vs custom DSN vs
sendmail binary (no sendmail binary is known to exist in the Next
runtime — verify before recommending); recommended default is SMTP
via the existing config (encrypted at rest with `info.salt`, the
existing model), with a new npm dep (no mailer lib is a dependency
today — name `nodemailer` as the candidate, not a commitment).
**Open question:** whether Josh wants a transactional-API provider
(SendGrid key field exists in PHP's settings, but no provider has
been chosen) — the draft presents this as his call, not settled
(§6, open question 2).

### 0.3 Rate limiter — fully mapped from `src/library/FOSSBilling/Security/RateLimiter.php` + `src/modules/Api/Controller/Client.php`

Backend: Symfony RateLimiter with `CacheStorage` over the
`rate_limit_cache` pool (`CacheFactory.php`: `NAMESPACE_RATE_LIMIT =
'rate_limit'`); default adapter is `FilesystemAdapter` under
PATH_CACHE (`data/cache/rate_limit_*` files — the plan's "file-based"
is correct for default config), Redis if cache config selects redis
(`createRedisAdapter`). Subjects are HMAC-SHA256 hashed with a key
from `info.salt` (fallback `info.instance_id`, fallback literal
`'fossbilling-rate-limiter'`). Config: `Config::getProperty('rate_limiter', [])`
merged over `getDefaultConfig()` via `array_replace_recursive`
(config.php can override enabled/whitelist/policies). `isEnabled()`:
`enabled=false` → off; **development-env bypass unless
`enforce_in_development` is true** — this is the mechanism behind
"PHP limiters DISABLED on the reference install": the runtime config
has `'rate_limiter' => ['enabled' => true, 'whitelist_ips' => [],
'policies' => []]` (read 2026-10-28, `runtime/src/config.php:93`)
AND the harness runs PHP with `APP_ENV=dev`, so the limiter is inert
on the reference despite `enabled=true` (empty policies array does
not remove defaults under `array_replace_recursive`). A production
PHP install enforces them. TS today has none; `security.ts` already
ports the rate_limit_* admin endpoints as disabled-state reporters
(`rate_limit_status` → `{enabled: false}`, `get_list` → `[]`,
`reset_ip` → `{ip, policy, removed: 0}`, `reset_all` → `{cleared:
true}`) with a comment stating the seam runs no limiter and that
this matches PHP on the reference (APP_ENV=dev disables it there).

**Policies (`getDefaultConfig`, 31 total):** token bucket:
`api_guest` 100/60s, `api_authenticated_ip` 1000/1h,
`api_authenticated_account` 1000/1h; fixed window: `api_login`
10/1h, `client_password_reset_ip` 10/1h,
`client_password_reset_email` 3/1h,
`client_password_reset_confirm_ip`/`_post_ip` 20/60s,
`client_email_confirm_ip` 20/60s, `staff_password_reset_ip` 5/1h,
`staff_password_reset_email` 3/1h,
`staff_password_reset_confirm_ip`/`_post_ip` 20/60s,
`client_signup` 5/1h, `client_signup_email` 5/1h,
`guest_ticket_create` 3/1h, `order_generation_ip` 15/1h,
`domain_lookup_ip` 60/1h, `invoice_payment_ip`/`_hash` 10/1h,
`invoice_pdf_ip`/`_hash` 10/1h, `invoice_get_ip` 10/1h,
`invoice_get_hash` 30/1h, `cart_promo_apply_ip` 10/1h,
`client_email_verification_resend_ip` 30/1h, `_account` 3/1h,
`client_email_resend_ip` 30/1h, `_account` 5/1h,
`profile_password_change_ip` 30/1h, `_account` 5/1h.

**Enforcement structure (`Api/Controller/Client.php` `_apiCall`):**
non-guest roles get TWO checks — pre-auth (IP subject,
`checkPreAuthRateLimit`, before session/token auth) then post-auth
(account subject `client:<id>`/`admin:<id>` when logged in, else IP);
guest roles get only the post-auth check. Policy selection
(`checkRateLimit`): `staff_login`/`client_login` methods (non-admin
role) → `api_login`; guest role → `api_guest`; authenticated →
`api_authenticated_ip` or `_account`. Per-endpoint `consume`/
`consumeOrThrow` calls add the specific policies (signup, password
resets, tickets, order generation, promo apply, invoice payment/pdf/
get, email verification resends, profile password change).
IP-whitelist bypass (`whitelist_ips`, `IpUtils::checkIp`); zero-token
`consume(…, 0)` probes without consuming (used by signup-email quota
checks); IP-index tracking with file lock
(`rate_limiter_ip_index.lock`) backing `listIpCounters`/`resetIp`/
`resetAll` (admin visibility/reset). **Error shape:**
`RateLimitException extends InformationException` with message
`'Rate limit exceeded. Please try again later.'`, code **429**,
carrying the `RateLimitResult` (limit/remaining/retry_after).
Whether the API response surfaces retry-after (header vs envelope)
was NOT verified — check `Client.php` rendering of
`RateLimitException` before finalizing the draft's error-shape
section (§6, open question 1).

**Scope decisions to present:** mirror the full policy table vs a
subset (plan names only `api_login`; the draft recommends the full
default table, since per-endpoint consumes are already wired to
those names in TS-ported endpoints); backend (in-memory per-process
vs DB-backed vs file-backed — document honestly that in-memory does
not survive restarts and does not share across Next instances, and
that PHP's file backend shares via disk; recommended default is
DB-backed counters — the shared DB is already the cross-instance
store — with the new counters table listed as an explicit
TS-only installer delta, never a hidden schema diff); dev-bypass
mirror + a test hook (PHP's `enforce_in_development` equivalent,
e.g. an env override forcing enforcement in parity runs, since a
dev-flagged test server would otherwise never trip the limiter).

### 0.4 Antispam / recaptcha — mapped from `src/modules/Antispam/Service.php` + TS `antispam.ts` + `client.ts`

PHP enforcement is event-listener based: signup
(`onBeforeClientSignUp`): blocked-IP + StopForumSpam + temp-email +
honeypot (captcha is verified in `Client/Api/Guest.php` `create()`
via `checkCaptchaIfEnabled` BEFORE the event fires — CAPTCHA tokens
are single-use, so checking again would reject genuine signups);
guest ticket create (guest role only, `onBeforeGuestTicketCreate`):
blocked-IP + captcha + SFS + temp-email; profile update / admin
client update / client login / admin login: blocked-IP only. Config
keys (Antispam module config, encrypted extension row): `block_ips`,
`blocked_ips` (newline-separated list), `sfs`,
`check_temp_emails` (default true), `honeypot_enabled` (default
true), `honeypot_field` (default `'bio'`), `captcha_enabled`,
`captcha_provider` (default `recaptcha_v2`), recaptcha public/private
keys + `captcha_recaptcha_v3_threshold` (default 0.5), turnstile
site/secret keys, hcaptcha site/secret keys. Blocked-IP error:
`'Your IP address (:ip) is blocked. Please contact our support to
lift your block.'`, 403. Honeypot error: `'Registration failed.'`
(deliberately generic). Temp-email: `isATempEmail` uses a
throwaway-domain adapter over `getTempMailDomainDB()`; parse failure
→ treated as valid (fail-open); throwaway + throw →
`'Disposable email addresses are not allowed'`. The list fetch: `GET
https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt`,
cached 86400s (the docblock says "1 week" but the code sets 86400 =
24h; on non-200 → cache 3600s + return [] — fail-open for HTTP
errors); the fetch writes `tempEmailDB.txt` to PATH_CACHE, reads it,
deletes it; lines filtered to drop `#`-comments and non-domains.
**Critical nuance:** a TRANSPORT exception from the HTTP client
(e.g. the sandbox TLS failure) is NOT caught by
`getTempMailDomainDB` — it propagates, which is why PHP guest signup
500s on the reference install. So PHP is fail-open for HTTP non-200
but fail-hard (500) for transport errors. TS must decide fail-open
vs fail-closed on fetch failure explicitly. SFS
(`isInStopForumSpamDatabase`): `GET
https://www.stopforumspam.com/api?f=json` + ip/email/username params
(no API key); non-object or `success=false` → false (fail-open);
`username/email/ip.appears` → per-field blacklist throws. Captcha
verification (`checkCaptcha`): provider `recaptcha_v2`/
`recaptcha_v3` → POST `https://google.com/recaptcha/api/siteverify`
with secret + `g-recaptcha-response` + remoteip; missing private key
→ "To use reCAPTCHA you must get an API key…"; missing response →
`'You have to complete the CAPTCHA to continue'`;
`success!== true` → `'reCAPTCHA verification failed.'`; v3
additionally clamps threshold to 0–1 (default 0.5), requires score ≥
threshold, and requires action `'fossbilling_submit'` on both the
param and the response. Turnstile → POST
`https://challenges.cloudflare.com/turnstile/v0/siteverify` with
`cf-turnstile-response`; hCaptcha → POST
`https://hcaptcha.com/siteverify` with `h-captcha-response`;
missing secret/response errors as surveyed.

**TS today: config get/set ONLY** (`antispam.ts`: `get_config` with
PHP defaults for missing keys, blocked-IP list save;
`guest/antispam/recaptcha` returning publickey/enabled/version/
provider). **TS guest create (`client.ts:906`) has NO captcha
verification, NO blocked-IP check, NO SFS check, NO temp-email
check, NO honeypot check** (grep for captcha/recaptcha in
`client.ts` returns nothing; `client.ts` line ~201 comment already
records the temp-email gap). So the R5 antispam batch is the whole
enforcement layer, not just the temp list.

**Decision shape for the draft (options + recommended default):**
temp list — fetch + cache with fail-open-on-any-error (documented
deviation from PHP's transport-error 500) PLUS a vendored fallback
snapshot used when the fetch fails (fresh when the network works,
hermetic when it doesn't) vs fetch-only vs vendor-only vs drop the
check (changes signup security posture); captcha — port verification
for the configured provider (recaptcha v2/v3 + turnstile + hcaptcha)
with secret keys from the encrypted antispam config vs leave captcha
unverified (not recommended); SFS — port with fail-open vs drop
(external dependency, fail-open already PHP's behavior); blocked-IP
+ honeypot — port unconditionally (no external dependency, pure
config + param checks). The draft also scopes WHERE the checks land
in TS (guest create + guest ticket create + login paths, mirroring
the listener points — TS has no event dispatcher, so the batch wires
the checks inline at those handlers).

### 0.5 Installer — mapped from `src/install/install.php` + `src/config-sample.php` + `InstallSeeder.php`

PHP `src/install/install.php`: `installPortable()` (line 508) =
`SchemaInstaller::createSchema(entityManager)` +
`InstallSeeder::seedContent(connection, entityManager, content.sql,
now)` + `InstallSeeder::seedAdmin(connection, admin_name, admin_email,
bcrypt-hashed admin_password, admin_api_token, now)` +
`InstallSeeder::setDefaultCurrency(connection, currency_code)` +
`InstallSeeder::seedInstallNudge(connection, VERSION, now)`.
`install()` (line 537) adds: copy client theme config template if
missing, fetch `.htaccess` from
`https://raw.githubusercontent.com/FOSSBilling/FOSSBilling/main/src/.htaccess`
if missing (failure THROWS — "Unable to write required.htaccess
file…" — a TS installer must decide whether to fetch, bundle, or
drop this step), write the config file via `getConfigOutput()`
(failure → exception code 101), `clearstatcache` + opcache
invalidate, `(new UpdateFinalization())->writeCompleteState()`.
Installer session inputs (from `run()`): `admin_name`, `admin_email`,
`admin_password`, `admin_api_token` (optional, null if absent),
`system_url`, `currency_code`; `validateAdmin()` rules: admin email
must be a valid email; password ≥ 8 chars + digit + lowercase +
uppercase; admin name non-empty. DB connect paths: `connectMysql()`,
`connectPostgres()` (creates the database via an admin PDO + quoted
identifier), `connectSqlite()`; `isAlreadyInstalled()` +
`getExistingConfig()` guards.

`getConfigOutput()` (install.php:642): loads the sample config, then
overrides: `security.force_https` from the URL scheme, trusted
proxies if enabled, `debug_and_monitoring.report_errors` from the
install form's error_reporting choice, `debug` flag, `update_branch`
(preview/release by version), `info.instance_id` = fresh UUID v4,
`url` (scheme-stripped), `path_data`, the `db` block per driver
(normalized ports: 5432 pgsql, 3306 mysql), `twig.cache`,
`disable_auto_cron` (true unless preview/dev). The salt comes from
the sample itself: `config-sample.php` evaluates
`bin2hex(random_bytes(16))` at require time, so every generated
config gets a FRESH random salt.

`InstallSeeder::seedContent`: strips mysqldump bookkeeping (comments,
`/*!` directives, LOCK/UNLOCK pairs), strips backticks, replaces
`NOW()` with a literal seed-time timestamp, per-statement unescapes
(`\\n` → newline, `\\"` → quote), portableizes booleans via Doctrine
metadata, executes. `content.sql` holds 16 INSERT statements
(multi-row VALUES). `seedAdmin`: admin row + `admin_group_member`
(group 1, super-admin) row, bcrypt hash via PasswordManager (TS:
bcryptjs generates `$2b$`, PHP accepts — same interop as login).
`setDefaultCurrency`: UPDATE `currency` id 1 to the chosen code
(content.sql seeds USD). `seedInstallNudge`: `setting`
`last_error_reporting_nudge` = VERSION. `UpdateFinalization::
writeCompleteState` (UpdateFinalization.php:308) writes
`data/update-finalization.json` (PATH_DATA) with status `complete`,
version, from/target versions, finalized_at/completed_at.

`config-sample.php` key list (complete): `security` (mode,
force_https, trusted_proxies, session_lifespan 7200,
session_regeneration_grace_period 300,
perform_session_fingerprinting, debug_fingerprint),
`debug_and_monitoring` (debug, log_stacktrace, stacktrace_length,
report_errors), `info` (salt fresh-random per install, instance_id
placeholder UUID), `url`, `admin_area_prefix` (/admin),
`update_branch` (release), `maintenance_mode` (enabled, allowed_urls,
allowed_ips), `disable_auto_cron`, `i18n` (locale en_US,
auto_detect_locale, timezone UTC, date_format medium, time_format
short, datetime_pattern), `path_data`, `db` (driver pdo_mysql +
connection fields, or pdo_sqlite path, or pdo_pgsql), `cache`
(filesystem driver; redis host/port/password/database/TLS; memcached
host/port), `twig` (debug, auto_reload, cache, strict_variables),
`api` (section present; batch reads its keys), `rate_limiter`
(enabled, whitelist_ips, policies).

**Config.php-owned vs DB-owned map (R2e established, batch
re-verifies against the sample + the settings form's 39 DB fields):**
config.php-owned: locale, auto_detect_locale, timezone, cache/redis/
memcached settings, countries, custom_interface, current_locale,
session_lifespan, trusted proxies, security flags, rate_limiter, api,
maintenance_mode, update_branch, debug flags, db, path_data, twig
cache, salt, instance_id, url, admin_area_prefix, disable_auto_cron.
DB-owned (`setting` table): the 39 system-settings fields R2e
verified (21 company, 14 invoices/funds, 4 nameservers) + every other
`setting` row. The deferred-9's ownership falls out of this map:
localization ×2 → config.php (`i18n.locale`,
`i18n.auto_detect_locale`); error_reporting ×3 → config.php
(`debug_and_monitoring.report_errors`) + a CODE constant (see
below); instance_id → config.php (`info.instance_id`).

**R3b salt lesson (must be in the draft):** a fresh target's salt
NEVER matches a source install's, so the installer + importer
interaction must be documented (importer requires overwriting the
target config's salt with the source's; the TS installer must not
silently re-randomize the salt on an import target — it accepts an
explicit `--salt` for import-target installs, default fresh-random
otherwise).

### 0.6 Config-driven TZ — mapped from `src/load.php` + `src/library/FOSSBilling/i18n.php` + `stats.ts`

PHP source of truth: `i18n.timezone` in config.php (sample default
`'UTC'`); `src/load.php:343` sets the process timezone from it:
`date_default_timezone_set(Config::getProperty('i18n.timezone',
'UTC'))` (the installer itself runs at UTC:
`src/install/install.php:25`). `i18n.php:152`'s resolution order
(client timezone → admin timezone → `fossbilling_timezone` cookie →
`i18n.timezone` config → `UTC`) governs per-request RENDERING, while
stats day boundaries use the process default timezone: PHP stats
(`Stats/Service.php:53`) computes `new DateTimeImmutable('today')`
and month starts in the process timezone — i.e. `i18n.timezone`
midnights. (Legacy top-level `timezone` config key is deprecated,
migrated to `i18n.timezone` by `UpdatePatcher.php:152,185`.)

TS today: `stats.ts` uses process-local midnights
(`midnightToday()` with `setHours(0,0,0,0)` on process-local dates;
header comment claims day boundaries are server-local midnights
"matching PHP's…" — the reference PHP configures UTC, so this only
matches when the process TZ is UTC). The only other local-midnight
use in TS server code is `indexmod.ts:306` (`setUTCHours(0,0,0,0)` —
UTC midnights; the TZ batch audits whether that site is also
stats-family or deliberately UTC). Regression servers must run with
`TZ=UTC` today — R5 replaces that with config-driven TZ.

**Draft decision to present:** single source of truth for TS TZ —
options: (a) env var (e.g. `FB_TIMEZONE`, operator-kept in sync with
config.php's `i18n.timezone`, installer writes both); (b) TS reads
config.php's `i18n.timezone` from the config store at startup
(single file, needs the R5a config reader); (c) a new DB setting row
(diverges from PHP's config.php ownership). Recommended default:
(b) with an env override — precedence env > config store >
UTC — so the process TZ follows the same file PHP reads, while
operators can still pin it in containers. The batch validates the
resolved value against the IANA list (`i18n.php` `getTimezoneList`
semantics) and computes boundaries with `Intl`-based zone math (no
new dependency). Verification must cover a non-UTC timezone (e.g.
America/Chicago, including a DST-transition date in the window)
against PHP, not just UTC. The batch audits every process-local
midnight / day-math use across TS server code (stats.ts,
indexmod.ts:306, plus invoice/order/cart/client day math found by
grep) and either converts it or documents why it stays.

### 0.7 Twig `{% set %}` — mapped from `apps/nextjs/src/server/twig.ts` + in-tree email templates

TS `twig.ts` is a minimal subset renderer (header: "just enough for
FOSSBilling's" templates; supports `{% if %}`/`{% for %}` blocks).
`{% set %}` is NOT evaluated: the parser's `parseUntil` treats it as
an "unknown tag: skip" (twig.ts, `parse` function — the tag is
dropped, and the newline after it stripped like any `{% %}` tag).
The strict pre-pass counts loop variables and `{% set %}` names as
defined (`twig.ts:342-345`: "the subset renderer does not evaluate
set, so their shapes are not checked"). Strict mode:
`renderTemplateStrict` mirrors PHP's sandboxed email environment
(`SandboxedStringRenderer` + `strict_variables`) — missing variables
are errors, not empty strings (PHP: missing vars → 9999). Net effect
today: a `{% set %}` contributes NOTHING at render; later references
resolve against the ORIGINAL context, and a variable that exists
only via `set` renders as `""` (echo of undefined → `""`) instead of
its assigned value — while the strict pre-pass still counts it as
defined, so no error is raised either. The failure is silent.

In-tree usage (grep over `src/modules/*/templates/email/`): **35
usages across 32 templates, two shapes, no set-block
(`{% set x %}…{% endset %}`) and no multi-assign anywhere.**
Dominant shape — defensive defaulting: `{% set order =
order|default({}) %}` (Order, Serviceapikey, Servicecustom lifecycle
templates). When `order` is present in a real send, TS's skip
behavior matches PHP (the set is a no-op); when absent, PHP applies
the default and TS renders empty — a divergence only on the
absent-variable path. Live-breaking shape — computed boolean: `{% set
is_guest_ticket = ticket.author.role|default('') == 'guest' %}` (4
Support templates: ticket_open, staff_close, staff_open,
staff_reply). TS drops the assignment, so a later `{% if
is_guest_ticket %}` evaluates undefined → falsy → the guest branch
is NEVER taken, silently, on every guest-ticket email. That is the
batch's concrete failing case.

**Draft ordering question:** whether `{% set %}` lands with the
email-transport batch (both touch sends) or standalone — the draft
recommends standalone FIRST (R5c, before transport): the parser work
is independent of transport, and transport verification then runs
against the completed renderer instead of re-verifying sends twice.

### 0.8 Security homes — mapped from `Security/Service.php` + `Security/Api/Admin.php` + `security.ts`

`ip_lookup` (`Security/Api/Admin.php:19`): `checkPermissions('security',
'view')`, then `Service::lookupIP($data['ip'])`. `lookupIP`
(`Security/Service.php:146`): non-IP input →
`InvalidArgumentException('The provided input was not a valid IP
address.')`; country via `di['geoip']` (MaxMind country DB),
`IncompleteRecord` → `[]`; ASN via `Reader::getAsnDatabase()`,
`IncompleteRecord` → `[]`; returns `{ip: {address, type IPv4|IPv6},
country, asn}`. The databases are bundled in-repo:
`src/library/FOSSBilling/GeoIP/Databases/` holds `CC0-Country.mmdb`
(6.5MB) and `PDDL-ASN.mmdb` (8.8MB), auto-downloaded from HostByBelle
IP-Geolocation-DB GitHub releases when missing (`GeoIP/Reader.php`
~70-77, 192-200; download failure → Exception). TS `security.ts`
header states the three are NOT ported "left on the PHP proxy by
design": `ip_lookup` needs a MaxMind MMDB reader — public IPs return
real country/ASN records (see captures26 sec_ip_public) that the seam
cannot reproduce without a new dependency.

`run_check` / `run_checks` (`Security/Api/Admin.php:43-56`):
`checkPermissions('security', 'run_checks')`, then
`Service::runCheck($id)` / `runAllChecks()`. Discovery is filesystem
based: `getAllChecks()` (`Security/Service.php:62`) scans
`src/modules/Security/Checks/*.php` via Finder — exactly 4 checks:
`dangerousFunctions`, `generalCheck`, `phpVersion`, `webserver` —
each implementing `SecurityCheckInterface` (performCheck/getName/
getDescription). `runCheck` unknown id → InformationException `'The
check :checkName: does not exist.'` (substituted); non-implementing
class → `'The check :checkName: does not seem to be a valid check.'`;
results are JSON-round-tripped with `id` (+ `name` on run_checks)
attached. The service layer re-checks `run_checks` permission
(`runAllChecks`/`runCheck` call
`checkPermissionsAndThrowException('security', 'run_checks')`) — TS
needs one guard entry, not two layers. `list_checks` is ALREADY
ported in TS (static check metadata). The 4 checks probe the PHP
runtime itself (config.php flags, the PHP version via php.watch,
PHP's `disable_functions` list) — and the webserver check
self-fetches via the webserver, which is why the PHP harness server
must run with `PHP_CLI_SERVER_WORKERS=4` (single-threaded `php -S`
deadlocks on the self-fetch). Registering the PHP answers verbatim
would hardcode the reference install's answers — hence the deferred
status.

**TS-equivalent design per endpoint (draft's recommendation, R5-8):**
`ip_lookup` → PORT with a MaxMind reader dep (candidate: `maxmind`
npm package, not a commitment) + the same two DB files (operator-
copied or auto-downloaded from the same HostByBelle URLs; missing DB
→ explicit error naming the file, not silent `[]`). `run_check`/
`run_checks` → PORT the framework (registry + dispatch + the two
error shapes + aggregation) with per-check fates: `generalCheck` →
ported (config-store flags); `webserver` → ported (self-fetch
against the Next origin, mirroring PHP's probe list — the batch
reads `Checks/webserver.php`'s probe list; no WORKERS requirement on
the TS side, PHP parity runs still need it); `phpVersion` +
`dangerousFunctions` → RETIRED with explicit per-check
retired-marked results (not fabricated passes, not silent
reinterpretation — the same anti-fiction rule as R4c's theme).
`run_checks` still returns all four entries (two real, two
retired-marked), preserving the admin security page contract.
Alternative rejected: TS-native reinterpretation (Node version
reported as "phpVersion") — fiction. Alternative rejected: removal
errors for the endpoints — breaks the admin security page contract
that `list_checks` already advertises.

### 0.9 money.ts prepareInvoice NULL semantics — mapped from `money.ts` + `db.ts` + PHP invoice paths

Standing divergence from R1 sub-batch 1: TS `prepareInvoice`
(`money.ts:114`) freezes `currency_rate` from
`findCurrencyByCode(currency)` and `insertInvoice` (`db.ts:2226-2230`)
writes `base_income ?? 0` and a literal `0` for `base_refund`;
PHP leaves all three NULL until payment (invoice entity columns are
nullable; PHP's creation path doesn't set them). Payment fills them:
TS `markInvoicePaid` (`money.ts:245-255`) writes `base_income =
round2(total × rate)` where rate = the invoice's frozen
`currency_rate` (or 1), and moves items pending_payment →
pending_setup; refund paths write `base_refund` (invoice.ts:1725
area — the batch confirms the full writer set: insertInvoice,
markInvoicePaid, refund/credit paths). **Subtlety the batch must
resolve, not assume:** if PHP's `currency_rate` is NULL at creation,
PHP's payment-time computation cannot read a frozen rate — the batch
surveys PHP's Invoice Service creation, issuance, payment, and
refund paths to determine exactly when each of the three fields is
first written, and mirrors that. The fix shape is therefore scoped as
"creation writes NULL for every field PHP leaves NULL, and payment/
refund paths resolve their inputs the way PHP does" — not as a blind
"write NULL at creation" (which would break `markInvoicePaid`'s rate
read if left unadjusted). Readers that coalesce for arithmetic
(invoice.ts:315 `income: (base_income ?? 0) - (base_refund ?? 0)`)
are fine internally; the ENVELOPE must carry null, matching PHP's
`toApiArray`. The batch is its OWN batch with its OWN regression
run (deliberately not smuggled into another batch): the regression
set is parity suites + invoice create/pay/refund flows proving
NULL-until-payment on both stacks (creation envelope shows nulls;
after payment shows computed values; after refund shows
base_refund).

### 0.10 Plan sweep remainder — everything else plan.md R5 names, homed or rejected

- **TS `update_params` server-side `invoice_starting_number`
  validation gap (R2e) → R5a, same handler.** PHP
  (`System/Service.php:297`) validates in `updateParams`'s first
  loop: key `invoice_starting_number` (case-insensitive) must be a
  positive whole number no greater than PHP_INT_MAX − 1, else
  InformationException `'Next invoice number must be a positive
  whole number no greater than :max.'` (substituted). TS
  (`system.ts:317`) `update_params` upserts everything it receives
  with NO validation. The same PHP loop also validates
  `invoice_reminder_send_time` (empty or `HH:MM` 24-hour, else
  `'Reminder send time must be empty or a valid 24-hour time
  (HH:MM).'`); TS lacks that too — R5a ports BOTH validations with
  PHP's exact messages (same function, same batch; a separate batch
  for a 20-line validation in a handler R5a already owns would be
  ceremony, not discipline).
- **Custom gateway configured-template fidelity (R1) → NOT R5.**
  Standing gateway-behavior gap, not retirement scope; stays a
  documented gap for a gateway batch or R6.
- **Gated seo/serviceapikey/cookieconsent active-path logic (7
  endpoints) → NOT R5.** Needs those modules installed on a
  reference; stays unverified-live.
- **R3b follow-ups (importer multi-row INSERT batching, streaming
  reads) → NOT R5.** Operator-tool performance, not retirement;
  revisit if a real import proves too slow.
- **Later-batch UI items → NOT R5.** Client delete UI, invoice
  `update` edit form, product/currency CRUD UI, stats date picker,
  service lifecycle actions, sidebar active highlighting, client-
  role service page, ticket-note display, client-edit field
  clearing. These are UI backlog, not retirement; R5's UI surface
  is limited to what its batches need (none — R5 is seam + scripts,
  except the config-store endpoints' existing system page, which
  R2e already built).
- **Three verified upstream defects → NOT R5 batches.** SQLite
  LOCK_ADVISORY, client invoice transaction_get_list DQL error,
  tld_delete TRIM. Separate fork-fix candidates (PHP-only fixes;
  TS already implements tld_delete's intended behavior).
- **Standing unverified-live items stay standing:** Stripe payment
  success path, live eNom verification (Josh's credentials/test
  account + IP whitelist), live currency refresh (TS fetches fine,
  PHP dies at sandbox TLS), R2d/R2e/R4b form browser click-through,
  client-role order/service pages (API covered by admin parity, UI
  untested), non-Custom/Hestia server-manager URL/secret extras.
  None of these is R5 work; R3c covers the live-server half.

## 1. Architecture

R5 changes five models; everything else reuses R1–R4 structure.

- **Config store (R5a, used by R5d/R5i/R5j).** `config.php` is the
  single file both runtimes read until R6: PHP's
  `Config::setProperty` rewrites it (with a `.old.php` backup,
  `Config.php:102` `setConfig`), and the TS config module must do
  the same — a PHP-array subset parser (scoped to the known sample
  keys) + a var_export-style writer + backup, not a second store.
  Precedence: env overrides config.php for deployment values the
  seam already reads from env (DB path/URL, salts); config.php is
  authoritative for operator-toggled values (`i18n.*`,
  `debug_and_monitoring.report_errors`, `info.instance_id`, cache,
  rate_limiter). The installer generates the file; the importer
  interaction is documented (salt overwrite, §0.5). A JSON sidecar
  store is rejected: it would split truth between runtimes during
  the strangler, and PHP would keep reading the stale file.
- **Cron runner (R5f).** A library function (`runCronJobs`,
  extended), not a new daemon: invoked via the existing
  `admin/cron/run` + `guest/cron/run` endpoints (hash-gated guest
  trigger is the recommended scheduling surface — system cron hits
  the guest trigger, exactly as PHP's cron.php is hit today) plus
  an optional operator script (importer precedent) for operators
  who don't want an HTTP trigger. In-process intervals inside the
  Next server are explicitly NOT recommended (restarts + multiple
  instances double-run). Concurrency: PHP has no lock, and neither
  does TS — idempotency is the guarantee (`reminded_at` claiming,
  claim rows, per-invoice try/catch), mirroring PHP. Isolated
  failures are collected, `last_cron_exec` is still set, and the
  run returns false (not throw) when any isolated job failed;
  non-isolated failures (pay_with_credits, activate_paid) abort
  before `last_cron_exec`, exactly as PHP's `_exec` order.
- **Mail transport (R5e).** Queue → transport → delete-on-success /
  retry-then-drop; no new queue table. Transport is selected from
  the email-module config's `mailer` key (encrypted extension row,
  same row `config_get` already decrypts). The transport module
  takes the queued row + settings and returns success/failure; the
  batch logic (priority decrement, tries, `cancel_after`,
  `logEmail`) is PHP's, ported exactly. The PHP non-production skip
  (leave row at `sending`) is NOT mirrored — a documented deviation:
  it is an environment artifact, and TS has no production/dev mail
  distinction to mirror it with; TS sends whenever a transport is
  configured.
- **Limiter backend (R5g).** DB-backed counters in the shared DB —
  the only store that survives restarts AND shares across Next
  instances without new infrastructure (in-memory fails both;
  file-backed shares via disk but duplicates PHP's cache-dir
  coupling and needs locking the DB already provides). The counters
  table is a TS-only schema addition, listed explicitly as an
  installer delta (§2 R5j), never a hidden diff. Enforcement point
  is seam dispatch, mirroring `Client.php` `_apiCall` order:
  pre-auth IP check, then post-auth account check (or IP when
  anonymous); guest roles get the post-auth check only. Admin
  visibility/reset endpoints (`get_list`, `reset_ip`, `reset_all`)
  become real, reading the same counters (they are reporters today).
- **Installer (R5j).** A standalone TS script (importer/rekey
  precedent), NOT a web wizard: no auth/session surface, testable
  against disposable targets, runnable by an operator over SSH.
  Schema comes from TS entity definitions that must equal
  SchemaInstaller's output (the equality criterion); seeds are a
  portable replay of `content.sql` + seedAdmin + setDefaultCurrency
  + seedInstallNudge; config is generated per `getConfigOutput`;
  finalization writes `data/update-finalization.json`. The script
  targets Postgres (R3) + SQLite for dev; MySQL as an installer
  target is OUT (the importer is the MySQL path — see §4).
- **TZ resolution (R5d).** Resolved once per process/request from
  the config store (`i18n.timezone`) with env override and UTC
  fallback; `Intl`-based zone math, no new dependency. Per-user
  timezone columns (client/admin) are a rendering concern for
  client/admin pages, NOT for the admin stats queries in scope —
  the batch documents that boundary rather than expanding into
  per-user stats.
- **Security check registry (R5i).** A static TS registry (the
  R4a registry precedent), NOT filesystem discovery: TS modules are
  statically imported, so a Finder-style directory scan has no
  meaning. The registry carries id + name + description (already
  ported as `list_checks` metadata) + the check implementation or
  its retired marking.

## 2. Batches (order R5a → R5b → R5c → R5d → R5e → R5f → R5g → R5h → R5i → R5j)

Order rationale: foundations first (R5a config store — R5d/R5i/R5j
all read it), then small correctness items (R5b/R5c/R5d — each
independent, each with a tight regression set), then the runtime
services in dependency order (R5e transport before R5f cron, so the
runner's sendmail job delivers for real from day one), then the
enforcement batches (R5g/R5h/R5i — endpoint-closing, independent of
each other, ordered by blast radius: limiter gates every request,
antispam gates two creation paths, security closes the last
deferred), then the installer last (R5j — it creates NEW installs,
while every other batch serves the EXISTING install; landing it
last keeps its schema-equality verification unentangled with the
other batches, and it depends on the config store + TZ decisions
already being settled). Installer-first was considered and rejected
for that reason: nothing else in R5 needs the installer, but the
installer needs R5a's config module.

### R5a — Config store + deferred system endpoints + update_params validation

- Config module: PHP-array subset read + var_export-style write +
  `.old.php` backup (mirroring `Config::setConfig`), scoped to the
  sample keys; precedence env > config.php for deployment values,
  config.php authoritative for toggled values.
- Endpoints (6, closing over half the deferred-9): system
  `localization_settings` (permission `system/manage_settings`;
  reads `i18n.locale` + `i18n.auto_detect_locale` with PHP's
  defaults en_US/true), `update_localization_settings` (permission
  `system/update_params` — note: NOT manage_settings, mirroring
  PHP; writes locale only when non-empty, always writes
  auto_detect_locale normalized boolean), `error_reporting_enabled`
  (permission `system/view`; reads
  `debug_and_monitoring.report_errors`, default false),
  `toggle_error_reporting` (permission
  `system/toggle_error_reporting`; flips via config rewrite),
  `last_error_reporting_change` (permission `system/view`;
  returns the constant `'0.8.8'` from `SentryHelper::last_change` —
  a code constant, NOT a setting), `instance_id` (permission
  `system/view`; reads `info.instance_id` from the config store).
- `update_params` validation: `invoice_starting_number` (positive
  whole number ≤ PHP_INT_MAX − 1, PHP's exact message) +
  `invoice_reminder_send_time` (empty or `HH:MM`, PHP's exact
  message), in the existing handler's first loop before any write
  (mirroring PHP's validate-then-write order).
- Deliverable: endpoints + config module + parity34 (config
  round-trips incl. backup file created, permission keys per
  endpoint incl. the update_params-key asymmetry, validation
  messages incl. boundary values, constant + instance_id reads;
  config file restored in finally — a config-write parity run that
  leaves the reference config changed is a failed run).

### R5b — prepareInvoice NULL semantics (own batch, own regression)

- Survey PHP's Invoice Service creation, issuance, payment, and
  refund paths for the first-write site of each of
  `currency_rate`, `base_income`, `base_refund`; mirror exactly
  (creation writes NULL for every field PHP leaves NULL; payment/
  refund paths resolve their inputs the way PHP does — including
  whatever rate source PHP's payment path uses when no frozen rate
  exists).
- Touch points: `prepareInvoice`, `insertInvoice`, `markInvoicePaid`,
  refund/credit writers, and every envelope reader that coalesces
  nulls (envelope must carry null; internal arithmetic may still
  coalesce — the batch distinguishes the two and proves the
  envelope).
- Deliverable: fix + parity35 (invoice create/pay/refund flows
  proving NULL-until-payment on both stacks: creation envelope
  shows nulls, after payment shows computed values, after refund
  shows base_refund; plus the full prior-suite regression — this
  batch's regression set IS its gate, not an afterthought).

### R5c — Twig `{% set %}` evaluation (standalone, before transport)

- Parser: `{% set name = expr %}` single-target only (set-block and
  multi-assign explicitly OUT — no in-tree use); evaluation via
  existing `evalExpr` (extended only if the two in-tree expression
  shapes — `x|default(...)` and `a.b|default('') == 'guest'` — are
  not already covered); assignment mutates the passed ctx object,
  so if-bodies share scope (propagates, matching Twig) and
  for-bodies get spread copies (contained, matching Twig's
  for-scoping) — the existing `renderNodes` structure already
  yields correct scoping.
- STRICT interaction: set names stay "defined" for the pre-pass,
  and after evaluation the value is real, so later strict
  references resolve to the computed value instead of `""` — this
  FIXES the strict-pass lie for computed sets.
- Deliverable: parser + evaluation + parity36 (the 4 Support
  guest-branch templates rendered both ways — guest author vs staff
  author — plus defensive-default templates with the variable
  present and absent, plus STRICT-mode cases proving a set variable
  no longer renders as `""`; template_send/_parse paths, not just
  unit renders).

### R5d — Config-driven TZ for TS stats

- TZ resolution: env override > config store `i18n.timezone` > UTC;
  validate against the IANA list (`i18n.php` getTimezoneList
  semantics); `Intl`-based zone-midnight computation, no new dep.
- Audit + convert-or-document every process-local midnight / day-
  math use: stats.ts boundaries + series windows, indexmod.ts:306,
  and any invoice/order/cart/client day math found by grep.
- Deliverable: TZ module + parity37 (stats day boundaries match
  PHP's for America/Chicago including a DST-transition date in the
  window, not just UTC; UTC regression stays green).

### R5e — Email transport (D5-4: SMTP recommended default)

- Transport module: nodemailer candidate (batch confirms no mailer
  dep exists, adds the chosen one); transport selected from the
  email-module config's `mailer` key; SMTP honoring the existing
  `smtp_host`/`smtp_port`/`smtp_username`/`smtp_password` keys
  (host/port required, auth only if username present — PHP's
  `__smtpDsn` rules); sendgrid/custom-DSN/sendmail support are
  follow-ups, NOT in this batch (see §4).
- Batch logic ported exactly: findDueBatch order (statuses
  unsent/pending/failed, priority DESC, id ASC; limit > 0 applies,
  0 = unlimited), `time_limit` budget, `queue_once`, per-email
  status → `sending` + PHP_EOL append, reply-to/bcc validation
  warnings, success → `logEmail` if `log_enabled` → DELETE row,
  failure → priority −1 / status failed / tries +1, tries >
  `cancel_after` (5) → log + DELETE, `throw_exceptions` → truncated
  350-char rethrow. PHP non-production skip NOT mirrored
  (documented deviation, §1). `send_now` callers surveyed in-batch
  (who passes true in PHP?) and mirrored or documented.
- Deliverable: transport + parity38 (delivery against a local SMTP
  sink — never a real provider in parity — proving queued → sent →
  row deleted, retry-then-drop after 5 tries, priority ordering,
  reply-to/bcc validation warnings; queue rows restored in finally;
  a delivery case against a sink that never receives proves nothing
  — the R2e lesson).

### R5f — Cron runner completion

- Wire the 8 missing jobs into `runCronJobs` in PHP's fixed order
  (pay_with_credits first, non-isolated, with the no-ids =
  all-unpaid path; then activate_paid; then the 11 isolated jobs;
  sendmail LAST so the run's own queued mail goes out).
- Implement the three stubs for real: batch_generate (PHP's
  expiring-order algorithm + merge evaluation, NOT the stub's
  "no DB-visible effect" claim), batch_invoke_due_event (once-per-
  day `invoice_overdue_invoked` gate + `fireDueReminderEvents`
  with `reminded_at` claiming), batch_send_suspension_warnings
  (claim via `client_order_meta` + row lock, sendTemplate,
  release-on-failure).
- Runner semantics: update-finalization gate (503 when pending —
  reads `data/update-finalization.json`, the file R5j writes);
  NO healSchemaDrift (documented: schema is an installer/importer
  concern; a schema problem surfaces as a job failure, not a
  silent heal); clearOldSessions (session lifetime config,
  default 7200s); Before/After events as no-ops IF the batch grep
  confirms no in-tree listeners (§6, open question 4); per-task
  isolation (collected failures, `last_cron_exec` still set,
  return false on any isolated failure); guest 1-minute throttle
  (return false without running if `last_cron_exec` within the
  last minute); no lock (idempotency is the guarantee, §1).
- Scheduling surface: system cron hits the guest trigger
  (recommended) or the operator script (alternative); in-process
  intervals explicitly NOT offered.
- Deliverable: runner + parity39 (each of the 8 jobs proven
  individually — crafted expiring orders, due invoices, suspendable
  orders, expirable reminders/carts, queued mail delivered via R5e
  — plus isolation cases (one failing isolated job → run returns
  false, `last_cron_exec` still set, other jobs still ran) +
  non-isolated abort case + guest throttle case; all crafted rows
  removed in finally).

### R5g — TS rate limiter

- Full default policy table (31 policies, §0.3) — NOT api_login-
  only. DB-backed counters (new TS-only table, explicit installer
  delta). Subjects HMAC-SHA256 with `info.salt` → `instance_id` →
  literal fallback (PHP's key order). Config: config.php
  `rate_limiter` section merged over defaults
  (`array_replace_recursive` semantics — empty policies array does
  NOT remove defaults). Dev bypass mirror + env override forcing
  enforcement in parity runs (`enforce_in_development` equivalent).
- Enforcement at seam dispatch, mirroring `Client.php` `_apiCall`:
  pre-auth IP check, post-auth account check (or IP when
  anonymous); guest roles post-auth only; policy selection
  (login → api_login, guest → api_guest, authed →
  api_authenticated_ip/_account) + per-endpoint consumes for the
  wired policies (signup, password resets, tickets, order
  generation, promo apply, invoice payment/pdf/get, email
  verification resends, profile password change). IP-whitelist
  bypass; zero-token probes without consuming.
- Admin endpoints become real: `rate_limit_status` (enabled state),
  `get_list` (counters, with ip/search filtering as PHP's),
  `reset_ip` (ip + optional policy), `reset_all` — replacing
  today's disabled-state reporters.
- Error shape: 429 `'Rate limit exceeded. Please try again
  later.'` + RateLimitResult (limit/remaining/retry_after);
  retry-after surfacing (header vs envelope) settled from
  `Client.php` rendering BEFORE implementation (§6, open
  question 1).
- Deliverable: limiter + parity40 (each policy family tripped at
  its limit on a forced-enforcement server — a limiter that never
  trips in parity proves nothing, the R2e lesson — plus whitelist
  bypass, pre/post-auth subjects, admin reset paths, and the
  reference parity mode: with enforcement OFF (dev default), all
  prior suites still green).

### R5h — Antispam enforcement

- Inline wiring at the listener points (TS has no dispatcher):
  guest create (blocked-IP + SFS + temp-email + honeypot + captcha
  verified BEFORE the creation logic, mirroring
  `checkCaptchaIfEnabled`'s single-use position); guest ticket
  create (guest role only: blocked-IP + captcha + SFS +
  temp-email); profile update / admin client update / client login
  / admin login (blocked-IP only).
- Temp list: fetch + 86400s cache + fail-open-on-any-error PLUS a
  vendored fallback snapshot used when the fetch fails (fresh when
  the network works, hermetic when it doesn't — the documented
  deviation from PHP's transport-error 500); cache file handling
  mirrors PHP (write tempEmailDB, read, delete; drop `#`-comments
  and non-domains). Captcha: verification for the configured
  provider (recaptcha v2/v3 incl. threshold clamp + action
  `'fossbilling_submit'`, turnstile, hcaptcha) with secrets from
  the encrypted antispam config and PHP's exact error strings.
  SFS: port with fail-open. Blocked-IP + honeypot: unconditional.
- Deliverable: enforcement + parity41 (blocked-IP rejection with
  the `:ip`-substituted message, honeypot generic failure,
  temp-email rejection with a fetched list AND with a failed fetch
  (fallback snapshot path), captcha verification paths per
  provider incl. missing-secret/missing-response errors, SFS
  fail-open on bad response; no real external calls in parity —
  the list fetch + captcha verifies + SFS are proven against a
  local mock, never the live providers).

### R5i — Security homes (closes the last 3 deferred)

- `ip_lookup`: MaxMind reader dep (candidate `maxmind`) + the same
  two DB files (operator-copied or auto-downloaded from the same
  HostByBelle URLs; missing DB → explicit error naming the file).
  Return shape `{ip: {address, type}, country, asn}` with
  `IncompleteRecord` → `[]` per section; invalid IP → PHP's
  InvalidArgumentException message as an FbError.
- `run_check` / `run_checks`: static TS check registry (NOT
  filesystem discovery); dispatch + PHP's two error shapes
  (unknown id, non-implementing class); results JSON-shaped with
  `id` (+ `name` on run_checks) attached; service-layer permission
  re-check collapses to the single `run_checks` guard entry.
  Per-check fates: `generalCheck` ported (config-store flags),
  `webserver` ported (self-fetch against the Next origin, probe
  list read from `Checks/webserver.php` in-batch), `phpVersion` +
  `dangerousFunctions` retired-marked (explicit retired results,
  not fabricated passes).
- Deliverable: endpoints + parity42 (ip_lookup public IP vs
  captures26 sec_ip_public shape, private IP sections, invalid IP
  message; run_check each id incl. unknown-id error; run_checks
  aggregation with all four entries incl. the two retired-marked;
  webserver self-fetch proven against the Next origin — PHP parity
  runs still need `PHP_CLI_SERVER_WORKERS=4`).

### R5j — TS installer (last; schema-equality criterion)

- Standalone TS script (importer/rekey precedent), NOT a web
  wizard. Steps in order: (1) DB connect (Postgres incl. database
  creation via an admin connection + quoted identifier, SQLite for
  dev; MySQL target OUT — importer is the MySQL path); (2)
  `isAlreadyInstalled` guard (refuse on an existing install — no
  `--force`, R3b precedent); (3) admin validation (PHP's
  `validateAdmin` rules exactly); (4) config generation per
  `getConfigOutput` (fresh random salt by default, `--salt` for
  import targets, fresh UUID v4 instance_id, force_https from URL
  scheme, report_errors from the installer's diagnostics choice,
  update_branch, normalized DB ports, disable_auto_cron); (5)
  schema creation from TS entity definitions — **verification
  criterion: table-for-table/column-for-column equality with a
  SchemaInstaller-created schema on the same driver** (diffed
  mechanically, not eyeballed); TS-only additions (limiter counters
  table) listed explicitly as deltas; (6) seeds via portable
  `content.sql` replay + seedAdmin (bcrypt, group-1 membership) +
  setDefaultCurrency + seedInstallNudge — **fresh-state criterion:
  the 86-row state** (content.sql 83 + seedAdmin 2 + nudge 1), with
  any deliberate difference documented, not drifted into; (7)
  `data/update-finalization.json` written (status complete,
  version, timestamps — the file R5f's gate reads). DROPPED with
  reasons: `.htaccess` fetch (Next routing doesn't use it; a
  fetch failure must not fail an install), client theme config
  template copy (no theme files in Next).
- Installer owns, as steps/inputs: locale + auto_detect_locale
  (localization step), report_errors initial value (diagnostics
  choice), instance_id generation (never edited — R5a's endpoint
  only reads it).
- Deliverable: script + installer-test (script-test precedent:
  disposable Postgres-if-available/SQLite targets, fresh-state row
  counts, schema diff vs a PHP-installed schema on the same driver,
  config file contents incl. fresh salt + UUID, finalization JSON,
  refusal on existing install, admin validation rejections;
  live-Postgres proof rides on R3c's endpoints when available —
  the script test on SQLite proves the logic, not the Postgres
  dialect).

## 3. Decisions (R5-1..R5-12, recommended defaults)

- **R5-1 — Batch order R5a → R5b → R5c → R5d → R5e → R5f → R5g →
  R5h → R5i → R5j.** Recommended default. Rationale per §2 header:
  foundations, then correctness, then services in dependency
  order (transport before cron), then enforcement by blast
  radius, installer last (it creates new installs; everything
  else serves the existing one).
- **R5-2 — Config store: single config.php file, TS reads/writes
  it (subset parser + var_export-style writer + .old.php backup).**
  Recommended default. Rationale: one source of truth during the
  strangler (PHP keeps reading the same file until R6); a JSON
  sidecar would split truth. Precedence: env > config.php for
  deployment values, config.php authoritative for toggled values.
- **R5-3 — Email transport: SMTP via the existing email-module
  config keys (nodemailer candidate), SendGrid/custom-DSN/sendmail
  as follow-ups.** Recommended default. Rationale: SMTP is the
  only transport with stored-credential fields already defined in
  the codebase; the model (encrypted at rest with `info.salt`) is
  unchanged. Bounce handling: PHP-equivalent retry-then-drop;
  provider webhooks deferred (§4).
- **R5-4 — Antispam: fetch + cache + fail-open-on-any-error +
  vendored fallback snapshot; captcha ported per configured
  provider; SFS ported fail-open; blocked-IP + honeypot
  unconditional.** Recommended default. Rationale: preserves
  PHP's effective behavior on a working network, fixes the
  sandbox-500 class (transport error no longer 500s signups),
  and stays hermetic when the network fails.
- **R5-5 — Rate limiter: full 31-policy table, DB-backed
  counters, dev-bypass mirror + env force flag.** Recommended
  default. Rationale: the full table costs little once the
  enforcement point exists (per-endpoint consumes are already
  wired to those names); DB-backed is the only store that
  survives restarts and shares across instances without new
  infrastructure; the force flag is what makes parity prove
  anything (a dev-default server never trips).
- **R5-6 — Installer scope: Postgres + SQLite targets, script
  form, schema-equality + 86-row fresh-state criteria, .htaccess
  + theme-template steps dropped.** Recommended default.
  Rationale: matches plan.md (Postgres + SQLite dev) and D5-3;
  MySQL installs come via the importer, not a second installer
  target; the criteria are what make "replaces the bridge"
  verifiable instead of aspirational.
- **R5-7 — TZ source: config store `i18n.timezone`, env override,
  UTC fallback (env > config > UTC).** Recommended default.
  Rationale: follows the same file PHP reads (`load.php:343`);
  the env override exists for container-pinned processes.
  Per-user TZ columns stay a rendering concern, not a stats
  concern (§1).
- **R5-8 — Security homes: ip_lookup PORTED (MaxMind + same DB
  files); run_check/run_checks framework PORTED with generalCheck
  + webserver ported and phpVersion + dangerousFunctions
  retired-marked.** Recommended default. Rationale: preserves
  the admin security page contract without fabricating checks
  (anti-fiction rule, R4c precedent).
- **R5-9 — prepareInvoice batch placement: own batch (R5b) with
  its own regression run, not smuggled.** Recommended default.
  Rationale: R1's deliberate deferral; the fix touches money
  creation + payment + refund paths, and its proof (NULL-until-
  payment on both stacks) deserves a gate of its own.
- **R5-10 — update_params validation home: R5a, same handler.**
  Recommended default. Rationale: a 20-line validation in a
  handler R5a already owns; a separate batch would be ceremony.
- **R5-11 — Twig `{% set %}` placement: standalone batch (R5c)
  BEFORE email transport.** Recommended default. Rationale:
  parser work is independent of transport, and transport
  verification then runs against the completed renderer instead
  of re-verifying sends twice. Set-block + multi-assign stay out
  (no in-tree use).
- **R5-12 — Installer form: standalone script, NOT a web wizard.**
  Recommended default. Rationale: operator-tool precedent
  (importer, rekey); no auth/session surface; testable against
  disposable targets. A web wizard is deferred to R6/post-cutover
  if ever (§4).

## 4. Explicitly NOT in R5

- Per-module proxy removal / shadow runs / PHP deletion (R6).
- Full secret store, vault/KMS integration (out; env salt is the
  model — D4-5 carried).
- R3c live verification as its own tap (needs Josh's
  Postgres+MySQL endpoints; R5j's live-Postgres proof rides on
  it when available, but R5 does not wait for it).
- Non-0.8.9 sources; multi-tenant or sharded targets.
- Web installer wizard (deferred; script first, R5-12).
- Bounce handling via provider webhooks (PHP-equivalent
  retry-then-drop is the R5 model; webhooks are a follow-up).
- SendGrid / custom-DSN / sendmail transports (follow-ups to R5e
  if Josh taps them; sendmail additionally needs a binary
  availability check, §6 open question 3).
- Twig set-block (`{% set x %}…{% endset %}`) and multi-assign
  (no in-tree use; add if a template ever needs them).
- Later-batch UI items (client delete UI, invoice `update` edit
  form, product/currency CRUD UI, stats date picker, service
  lifecycle actions, sidebar active highlighting, client-role
  service page, ticket-note display, client-edit field clearing).
- Custom configured-template fidelity; gated seo/serviceapikey/
  cookieconsent active-path logic (stays unverified-live).
- Importer performance follow-ups (multi-row INSERT batching,
  streaming reads — revisit if a real import proves too slow).
- Three verified upstream defects as R5 batches (separate fork-fix
  candidates; TS already implements tld_delete's intended
  behavior).
- Live gateway re-verification (unchanged standing items: Stripe
  success, live eNom, live currency refresh, form click-through).

## 5. Verification standard (per batch, same discipline as R1–R4)

- `tsc` + `next build` clean; new code landed (grep string
  literals, not minified function names).
- New parity/test suite per batch where the batch has HTTP surface
  (numbering continues from parity33): parity34 (R5a), parity35
  (R5b), parity36 (R5c), parity37 (R5d), parity38 (R5e), parity39
  (R5f), parity40 (R5g), parity41 (R5h), parity42 (R5i);
  script-test precedent for non-HTTP batches (R5j installer-test,
  driver-test/import-test/rekey-test pattern).
- Every batch: all prior suites green, parity21 at exactly the
  known 9, fixtures 13/13 both, DB invariants clean before AND
  after (incl. the tables each batch touches — config file
  restored after R5a, queue rows after R5e/R5f, crafted jobs' rows
  after R5f, counters after R5g).
- A case that cannot fail proves nothing (R2e lesson, applied
  per batch in §2: refresh cases with a fetchable currency,
  delivery cases against a receiving sink, limiter cases on a
  forced-enforcement server, re-key-style vacuous checks refused
  with VACUOUS, never PASS).
- No PHP source changes; no commit/push without a separate tap.

Standing verification facts a future batch must preserve:

- Parity runs include `theme` in `FB_TS_MODULES` (35 names);
  without it, theme calls proxy to PHP and shape assertions fail
  with PHP's list.
- Fixtures require `--stack` + fixture files (a bare
  `run-fixtures.py` runs 0 fixtures and is vacuous, and overwrites
  the PHP results file with `{}`); gate is 13 fixtures, verified
  via the results JSON files, not just the summary line.
- Servers die on runtime restarts and must be checked first (PHP
  :8080 with `PHP_CLI_SERVER_WORKERS=4` — the security webserver
  check self-fetch deadlocks single-threaded `php -S` — Next
  :3001; kill by PID or `fuser -k <port>/tcp`, never a
  self-matching `pkill -f` pattern; verify ports clear with curl
  before restarting).
- `next start` serves the LAST BUILD — run `npm run build` and
  check its exit code after any source change before parity runs.
- Capture/parity runs that mutate the reference DB must clean
  balance rows too, not just invoices; long parity scripts (~200s)
  must run via nohup + log file from the start (a tool-timeout
  kill mid-run strands the script's finally-restore seeds).
- Parity logs go under `~/scratch/` (persistent), NOT `/tmp`
  (wiped by restarts); after ANY killed parity run, check DB
  invariants + repair before trusting the next gate.

## 6. Open questions (not settled by the code — Josh's call, or a live-server check)

1. **Rate-limit retry-after surfacing (header vs envelope).** Not
   verified: read `Api/Controller/Client.php`'s rendering of
   `RateLimitException` before implementing R5g's error shape.
   What settles it: that rendering code.
2. **Email provider final choice (D5-4).** SMTP is the recommended
   default (R5-3), but SendGrid / custom-DSN support is Josh's tap
   if he wants a transactional-API provider. What settles it: his
   provider choice + credentials.
3. **Sendmail binary availability in the Next deployment.** Unknown
   whether the deployment environment provides a sendmail binary;
   affects whether the sendmail transport is offered at all.
   What settles it: checking the deployment image.
4. **Cron Before/After event listeners in-tree.** Expected none
   (InvoiceIsDue listeners: none outside Invoice/Service itself),
   but the R5f batch must grep for Before/AfterAdminCronRunEvent
   listeners before declaring them no-ops. What settles it: that
   grep.
5. **PHP webserver check probe list.** R5i's webserver check
   mirrors PHP's probes against the Next origin; the probe list
   itself was not read during scoping. What settles it: reading
   `src/modules/Security/Checks/webserver.php` in-batch.
6. **Live Postgres/MySQL (R3c).** Still a separate tap awaiting
   Josh's endpoints/infra. R5j's Postgres schema-equality proof
   and R5e/R5g's Postgres-path behavior ride on it when available;
   R5 does not wait for it (SQLite proves the logic).
7. **MMDB auto-download in the sandbox.** PHP's Reader downloads
   missing DBs from HostByBelle GitHub releases; sandbox TLS may
   block that fetch. What settles it: the R5i batch verifies
   against the DB files already bundled in-repo (no download
   needed) and treats download as an operator step otherwise.
8. **Limiter scope: full table vs api_login-only subset.** Full
   table recommended (R5-5); a minimal subset is Josh's call if he
   wants the smallest blast radius first. What settles it: his tap.
