# Findings — R5e: SMTP transport + queue state machine

Branch: `feat/nextjs-phase5-r1` (on top of R5d `ce82931`). **Not committed,
not pushed.** No PHP source modified. No `~/MEMORY.md` edits.

## 0. Short version

TS `batch_sendmail` used to flip pending rows to `'sending'` and return
null — delivery never completed. R5e gives it a real transport:
**nodemailer 10.3.1 over SMTP**, configured from the existing email-module
config keys, plus an exact port of PHP's per-attempt queue state machine
(success → log + DELETE; failure → priority −1 if truthy, status
`'failed'`, tries +1, tries > `cancel_after` → log + DELETE; `throw_exceptions`
→ truncated 350-char rethrow, unwrapped for validation errors, wrapped for
transport errors). `template_send`'s `send_now` path is wired through the
same machine. parity38 proves it against a local mock SMTP sink, PHP-prod
vs TS, **86/86**.

SendGrid, custom-DSN, and sendmail transports are follow-ups (validation
messages mirrored exactly; see §7). Real-provider delivery (Gmail/SES/etc.)
is **UNVERIFIED-LIVE** by necessity in the sandbox — the mock is the only
proof surface, stated plainly in §10.

## 1. The PHP send path (code-read + mock-proven)

### 1.1 Entry points

| PHP entry | File:line | Behaviour |
|---|---|---|
| `Email\Service::sendMail()` | `src/modules/Email/Service.php:434` | Queues via `_queue` (:661), then if `$send_now` calls `_sendFromQueue($email, $throw_exceptions)` |
| `Email\Service::batchSend()` | `:1173` | `time_limit` (default 5, ×60 s), `queue_once` (default 0 = unlimited); `$mailQueue = findDueBatch((int)$sendPerCron)`; loop `_sendFromQueue($email)`; break AFTER each send if `$time_limit && time() - $start > $time_limit` (so 0 never breaks; −1 breaks after exactly 1) |
| `Email\Service::_sendFromQueue()` | `:1232` | The per-attempt machine (§2) |
| `Email\Api\Admin::batch_sendmail` | `src/modules/Email/Api/Admin.php` | Permission `email/send_emails` + demo-active → false, else `batchSend()` |
| `Email\Api\Admin::send_test` | `:405` | `sendTemplate` with `send_now => true, throw_exceptions => true` (templated `mod_email_test` mail, immediate) |
| `Email\Service::sendTemplate()` | `:261` | Passes `$send_now`/`$throw_exceptions` from `$data` through all 4 recipient paths (:376 staff-list, :381 oneStaff, :387 customer, :391 plain) into `sendMail` |
| `Massmailer\Service::sendMessage()` | `src/modules/Massmailer/Service.php:273` | Passes `$sendNow` into `sendMail`; callers with true: `Massmailer\Api\Admin.php:164`; `:186` and `Service.php:295` pass default false |
| `Email\Service::resend()` | `Email/Service.php:768` | Passes false, false (queue only) |
| `Email\Api\Admin::send()` | `Email\Api\Admin.php:79` | Passes neither (false, false → queue only) |

### 1.2 Transport selection and construction

`src/library/FOSSBilling/Mail.php` (Symfony Mailer). The constructor builds
an `Email` with `->from($fromAddress)->to($toAddress)->subject($subject)->html($bodyHTML)`
— **HTML only, no text part**. From/to: `isset($from['email']) &&
isset($from['name'])` → `Address(email, name)`; email-only → `Address(email)`;
else `$fromAddress = $to` (unreachable from `_sendFromQueue` since sender
email is always set). `isset(null)` is FALSE, so a null name → no display
name (TS mirrors: omit name when null/empty).

`send($options)` switch (validation OUTSIDE the try block — see §2.4):

| `mailer` value | DSN / behaviour | Missing-config error (exact) |
|---|---|---|
| `sendmail` | `sendmail://default` (+ `assertSendmailFunctionsAvailable`: proc_open + escapeshellarg must exist, else InformationException) | — |
| `smtp` | `__smtpDsn($options)` | see §1.3 |
| `sendgrid` | `sendgrid://<key>@default` | `A SendGrid API key is required to send emails via SendGrid` |
| `custom` | caller DSN required | `Unable to send email: 'Custom' transport method was selected without a custom DSN` |
| anything else | — | `Unknown mail transport:<transport>` |

Then `Transport::fromDsn($dsn)` + `Mailer->send($email)` inside try/catch →
wrapped Exception (see §2.4). No encryption param on the SMTP DSN:
Symfony uses opportunistic STARTTLS (upgrades only if advertised).

### 1.3 SMTP DSN rules (`__smtpDsn`)

- Empty host OR port → InformationException `SMTP host or port is not configured`
  (checked first; port `'0'` is `empty()` → this error, not the invalid one).
- Port via `Tools::normalizePort` (`src/library/FOSSBilling/Tools.php:236`:
  int or trimmed string, `FILTER_VALIDATE_INT` 1..65535, else default) —
  null default here → InformationException `SMTP port is invalid`
  (`'abc'`, `70000` → invalid; `'25'` string → 25).
- Auth ONLY if username non-empty (username urlencoded+trimmed; password
  urlencoded+trimmed; auth string `user:pass` if pass non-empty else `user`).
- DSN `smtp://[auth@]host:port`.

TS mirrors all three rules in `deliverQueuedMail` (nodemailer `secure:
false`, opportunistic STARTTLS like Symfony's DSN).

### 1.4 Non-production skip (NOT mirrored — documented deviation)

`_sendFromQueue`: `if (!Environment::isProduction())` → log info
`'Skip email sending. Application ENV:...'` and return true — the row
STAYS at `'sending'` (status was set + flushed before). Reference PHP runs
`APP_ENV=dev`, so it skips — which is why TS's old flip-only behaviour
matched sandbox PHP exactly, and why parity38's PHP oracle must be a
second PHP instance WITHOUT `APP_ENV` (→ production → actually sends;
see §5). TS has no production/dev mail distinction, so TS sends whenever
a transport is configured (scope R5e, documented deviation).

`Environment.php`: `ENV_KEY='APP_ENV'`; `POSSIBLE=[prod, dev, test]`;
`DEFAULT=prod`. UNSET or unrecognized `APP_ENV` → production → SENDS.
No `.env` file exists under the runtime dir — OS env is the only source.

### 1.5 Config keys (full list + defaults)

From `src/modules/Email/templates/admin/mod_email_settings.html.twig`:

| Key | Default | Secret? |
|---|---|---|
| `from_name`, `from_email` | — (company fallback) | no |
| `reply_to`, `bcc_email` | — | no |
| `queue_once` | 0 (unlimited) | no |
| `time_limit` | 5 (minutes) | no |
| `cancel_after` | 5 | no |
| `log_enabled` | falsy | no |
| `mailer` | `sendmail` | no |
| `smtp_host`, `smtp_port` | — | no |
| `smtp_username` | — | no |
| `smtp_password` | — | **YES** |
| `sendgrid_key` | — | **YES** |
| `custom_dsn` | — | **YES** |

Reference DB state: NO `mod_email` config row (extension_meta rows are
only mod_theme, mod_cron, mod_massmailer) → PHP email config = defaults;
TS `readExtensionConfig("mod_email")` returns `{}` for a missing row, so
TS defaults match. Config is v2-encrypted at rest via `crypt.ts` (R4a
path); the transport decrypts via `readExtensionConfig` and NEVER logs
credentials (the mock records AUTH mechanism only, never values).

### 1.6 Demo-mode check

`_sendFromQueue` FIRST checks the demo extension: active → return false,
NO state change. TS mirrors via `isModuleActive("demo")` (extension row
`type='mod' AND name='demo' AND status='installed'`). Unobservable on the
reference (demo not installed) — implemented, not merely documented,
because it is 4 lines and exactly PHP's behaviour. (TS previously had NO
demo handling anywhere; this is the first.)

## 2. The queue state machine (exact)

### 2.1 Row shape

`src/modules/Email/Entity/QueuedEmail.php`: id, recipient, sender,
subject, content (TEXT), to_name, from_name, client_id (BIGINT, null),
admin_id (BIGINT, null), priority (INTEGER, null), tries (INTEGER,
default 0), status (VARCHAR 20, default `'pending'`), attachment_name,
attachment_content (BLOB, null), attachment_mime, created_at, updated_at.
Status constants: `STATUS_PENDING='pending'`, `STATUS_SENT='sent'`
(**never set** by `_sendFromQueue` — success DELETES), `STATUS_FAILED='failed'`,
`STATUS_UNSENT='unsent'`.

`QueuedEmailRepository.php:72` `findDueBatch(int $limit = 50)`: statuses
IN (`unsent`, `pending`, `failed`), `ORDER BY priority DESC, id ASC`;
limit applied ONLY if `$limit > 0` (0 = unlimited). A row left at
`'sending'` by a crashed run is NEVER re-picked, on either stack.

### 2.2 Per-attempt transitions (`_sendFromQueue`)

1. Demo active → return false, no state change.
2. Status → `'sending'` + flush.
3. Content .= `PHP_EOL` (`"\n"`) — appended on EVERY attempt, persisted
   on the failure-path flush; on success the row is deleted (moot) but
   `logEmail` logs content WITH the appended newline.
4. Settings: `log_enabled` truthy check. Sender `{email, name}`, recipient
   `{email, name}`. Attachment via `queuedAttachmentToArray` (content null
   → null; else name ?? `'attachment'`, mime ?? `'application/octet-stream'`).
   `new Mail(sender, recipient, subject, content, transport,
   settings['custom_dsn'] ?? null)`; attach if present; reply_to if
   non-empty AND valid email else logger warning
   `'Skipping invalid Reply-To address:...'`; bcc_email parsed by
   `parseBccAddresses` (comma-split, trim, valid only, invalid → logger
   warning `'Skipping invalid Bcc address:...'`), cached per service
   instance in `$this->validatedBccAddresses` (parsed once per batch run
   — TS mirrors: parse once per `batchSendMail` call, fresh parse for
   single send_now calls).
5. Success: `$mail->send($settings)`; if log → `activityService->logEmail(
   subject, clientId, sender, recipient, content, null, attachment)`; then
   try{remove queue row + flush}catch{log error} — a remove failure
   leaves the row at `'sending'` (protected).
6. Failure (ANY exception from Mail construction/send): log error;
   priority −1 ONLY if priority truthy (0 or NULL → no decrement);
   status → `STATUS_FAILED`; tries +1; flush. If tries > `cancel_after`
   (default 5): if log → logEmail; remove row + flush — UNPROTECTED (a
   remove failure propagates out of `_sendFromQueue` and aborts the
   batch — TS mirrors: let it propagate). If `$throw_exceptions`:
   truncate message if >350 chars (prefix `__trans('Error message
   truncated due to length, please check the error log for the complete
   message: ')` + `substr($message, 0, 350)` + `'...'`); throw
   `FOSSBilling\Exception`. Return true otherwise (except demo false,
   throw path).

### 2.3 Failure-class table (the required table, not a slogan)

PHP has NO per-class retry policy, NO delay, NO `retry_after`: every
failure class funnels into the SAME transition (step 6 above). Retries
happen ACROSS batch runs because `findDueBatch` re-picks `'failed'` rows.

| Failure class | Attempts → state | Delay | Final state |
|---|---|---|---|
| Transport connect error / timeout / socket drop | tries+1, failed, priority−1 (if truthy) | none (next batch run) | deleted+logged when tries > 5 |
| 4xx transient (e.g. 451) | same | none (next batch run) | same |
| 5xx permanent (e.g. 550) | same | none (next batch run) | same |
| Validation error (missing/invalid SMTP config, unknown mailer) | same | none (next batch run) | same |
| Unported mailer (TS-only: sendmail) | same | none (next batch run) | same |
| Demo active | no state change, return false | — | row stays pending |
| Non-production (PHP only, NOT mirrored) | row stays `'sending'` | — | stuck until a production run |
| Crash mid-send | row stays `'sending'` | — | stuck forever (never re-picked) |

**R5e/R5f boundary (exact):** R5e implements the per-attempt machine
above. R5f drives repeated runs (cron's `sendmail` job calls this batch
on schedule, so `'failed'` rows get retried and eventually dropped).
Nothing in R5e schedules, throttles, or delays anything.

### 2.4 Error-message wrapping (must mirror)

`__smtpDsn` validation errors and unknown-transport errors are thrown
OUTSIDE the try block in `Mail::send()` → reach `_sendFromQueue`
UNWRAPPED. Transport failures (connection etc.) are thrown INSIDE the
try → wrapped as `'Failed to send email via:<transport> with the
exception:<e>'` (params substituted). TS parity: status/tries/priority
transitions exactly; error MESSAGE exact only for validation errors
(via `throw_exceptions`), by class for transport errors (Symfony vs
nodemailer texts differ). parity38 §J proves the exact validation
message (`SMTP host or port is not configured`) through `template_send`
with `send_now + throw_exceptions`.

Truncation is unit-provable only for the short case in parity (a
deterministic >350-char transport error is not available in the
sandbox); the truncate helper itself mirrors the PHP rule exactly
(prefix + first 350 chars + `'...'`; PHP `substr` is byte-based, TS
`slice` is UTF-16-unit-based — identical for ASCII errors).

## 3. Attachments

PHP DOES send them: `queuedAttachmentToArray` + `Mail::attach` (see §2.2
step 4). Wire shape (capture41 + parity38 §B, Symfony vs nodemailer
compared decoded, not raw): `multipart/mixed`, html part QP, attachment
part base64 with `Content-Disposition: attachment; name=<name>;
filename=<name>`. TS `queueEmail` has NO attachment param (TS-queued mail
never carries attachments) — but `batch_sendmail` with CRAFTED attached
rows (via SQL, both stacks) DOES deliver attachments in R5e. The
remaining gap is `template_send`-originated attachments: PHP
`sendTemplate` passes its `attachment` param through; TS `template_send`
drops it (pre-existing gap, NOT transport work — see §10).

## 4. The TS side before the fix (verified from code)

- `email.ts` `batch_sendmail` (:219 pre-fix): `UPDATE email_queue SET
  status = 'sending' WHERE status = 'pending'`, return null. NO
  findDueBatch ordering/limit, NO per-email machine, NO transport.
- `emailer.ts` `queueEmail`: INSERTs (recipient, sender, subject,
  content, to_name, from_name, client_id, admin_id, priority ?? 1,
  tries 0, status `'pending'`, created/updated) — NO attachment columns.
- `template_send` (:462+ pre-fix): stripped `send_now`,
  `throw_exceptions`, `attachment` from call vars with the comment
  "send_now/attachments/transport are out of scope for the seam".
- `cron.ts` `runCronJobs()`: 5 jobs, NO sendmail — R5f wires it.
- `massmailer.ts` `send_test` (:279): queues only (see §10 for the
  send_now gap there).
- No prior parity suite passed `send_now` (grep across parity*.py +
  capture39.py: nothing) — so wiring it cannot regress prior suites.

## 5. Mock SMTP design

`docs/nextjs-strangler/phase5/smtp-mock-server.mjs` (eNom-mock
precedent: small Node script, NOT in shipped `scripts/`). Plain `net`
server on **127.0.0.1:18025** (argv overrides port/capture file).
EHLO advertises `AUTH PLAIN LOGIN` + `8BITMIME`, deliberately NOT
STARTTLS, so both Symfony (`smtp://` DSN) and nodemailer
(`secure: false`) stay on plain connections and conversations are
comparable. Handles EHLO/HELO/MAIL FROM/RCPT TO/DATA/RSET/NOOP/QUIT
(+ AUTH PLAIN/LOGIN prompt flow, STARTTLS → 502).

Capture: JSONL, one object per accepted message or rejected attempt
(`{type, ts, mailFrom, rcptTo[], auth, stage, code, data?}`), appended
with O_APPEND. **AUTH credentials are NEVER recorded** — only the
mechanism (`PLAIN`/`LOGIN`) and a boolean. Scripted failures by
recipient pattern (deterministic, no control channel): `fail@` → 550 at
RCPT every time; `flaky@` → 451 at DATA first time, 250 afterwards
(in-memory per-recipient set); `drop@` → socket destroyed after DATA.

**Mock lifecycle lesson (parity38e):** the mock's `flakySeen` set lives
in memory, so a leaked mock from an earlier run makes §E pass
vacuously (flaky already seen → accepted first try). parity38 now OWNS
the mock lifecycle: kills any `:18025` listener at suite start, starts
its own, kills it in finally. (Also found in-batch: the mock's MAIL
FROM handler must reset the envelope — a reused SMTP connection would
otherwise accumulate `rcptTo` across messages; fixed.)

**PHP oracle:** second PHP instance on **:8081 WITHOUT `APP_ENV`**
(→ production → actually sends) on the same src dir + DB. `:8080`
(`APP_ENV=dev`) SKIPS sending (capture41 proved: row stays `'sending'`,
mock empty) and is NOT the oracle here.

## 6. The fix (files changed)

- `apps/nextjs/src/server/modules/email.ts` (+~330/−~15):
  - `readEmailSettings()` (decrypted `mod_email` config + PHP
    truthiness/`(int)`-cast/`normalizePort` mirrors),
    `parseBccAddresses`, `deliverQueuedMail` (nodemailer SMTP;
    sendgrid/custom/sendmail/unknown validation errors with exact PHP
    messages, except sendmail — see §7), `sendFromQueue` (the §2.2
    machine incl. demo check, protected/unprotected deletes, wrapped
    vs unwrapped rethrow), `batchSendMail` (findDueBatch order/limit,
    time_limit budget incl. −1 → exactly 1), `queueOrSendNow`
    (template_send send_now wiring), `logEmailRow`
    (`Activity/Service.php:224` insert shape: queue strings for
    sender/recipients, content WITH `\n` as content_html, attachment
    name/content/mime with the `?? 'application/octet-stream'` rule).
  - `batch_sendmail` rewritten to `batchSendMail()`; `template_send`
    reads `send_now`/`throw_exceptions` via the R5a rawParams-presence
    pattern and routes all four recipient paths through
    `queueOrSendNow`. Header comment updated (the old "no transport
    exists" comment described pre-fix behaviour).
- `apps/nextjs/package.json` + `package-lock.json`: **`nodemailer
  ^10.3.1`** added (dependencies). Single-line package.json format
  preserved (npm kept it). Server-only verified: zero
  nodemailer/createTransport references in `.next/static/chunks/`;
  transport code present in server chunks; new strings
  (`SMTP host or port is not configured`, `Sendmail transport is not
  yet supported…`) in the production bundle (chunk 8268.js).
- `docs/nextjs-strangler/phase5/smtp-mock-server.mjs` (new, §5).
- `docs/nextjs-strangler/phase5/capture41.py` + `captures41/corpus.json`
  (new; 18/18 — see §8).
- `docs/nextjs-strangler/phase5/parity38.py` (new; 86/86 — see §8).

No PHP source modified. No commit. No push.

## 7. Divergences (pinned, not hidden)

1. **Sendmail mailer (TS-only error, documented):** PHP would attempt
   the sendmail binary; TS throws `Sendmail transport is not yet
   supported by the Next.js port (SMTP only)` — deliberately NOT PHP's
   `Unknown mail transport` message (sendmail is a KNOWN transport,
   just not yet ported; claiming unknown would be a lie). State
   outcome is identical (failed/tries+1, parity38 §H).
2. **SendGrid/custom-DSN (validation only, fail-closed):**
   `deliverQueuedMail` throws the exact PHP required-key/required-DSN
   message UNCONDITIONALLY for `sendgrid`/`custom` — i.e. even with a
   key/DSN configured, TS refuses (a deliberate fail-closed placeholder
   until the transports land). This differs from PHP-with-key, which
   would send. Pinned here; the follow-up batch replaces these branches
   with real transports. (The state outcome for the no-key case is
   identical: failed/tries+1, parity38 §H covers the unknown-mailer
   shape; sendgrid-no-key and custom-no-DSN shapes are the same code
   path, proven by code inspection, not by a parity case.)
3. **Non-production skip NOT mirrored** (§1.4): TS sends whenever a
   transport is configured.
4. **Wire trailing newline (compensated, not diverged):** nodemailer
   trims exactly one trailing newline from SINGLE-PART string html
   (probe: `"X\n"` → `"X"`, `"X\n\n"` → `"X\r\n"`), while Symfony QP
   preserves PHP's appended `PHP_EOL` as trailing CRLF. TS passes
   `content + "\n"` for single-part mail so decoded bodies match PHP
   exactly. In MULTIPART mail nodemailer preserves the newline
   verbatim, so the same compensation overshoots by one CRLF (probe:
   PHP part `"<p>…</p>\r\n"` vs compensated TS
   `"<p>…</p>\r\n\r\n"`) — the compensation therefore applies ONLY
   when no attachment is present. Both shapes pinned by parity38 §A
   (single) and §B (multipart).
5. **AUTH mechanism choice:** Symfony picked LOGIN, nodemailer may
   pick PLAIN or LOGIN against the same advertisement. parity38
   asserts auth-attempted (mechanism ∈ {PLAIN, LOGIN}), not mechanism
   equality — both authenticate; the gate is delivery + envelope +
   body.
6. **Message-ID / Date:** nondeterministic on both stacks (Symfony
   random hex @ sender domain; nodemailer random @ hostname) — masked,
   not compared. Everything else (From/To/Subject/Content-Type/
   charset/decoded body/Bcc-header absence/Reply-To) compared exactly.
7. **String `send_now` (TS more permissive):** PHP's `sendMail()` takes
   strict bool `$send_now`/`$throw_exceptions` — a JSON string `"1"`
   9998s (`…must be of type bool, string given`). TS `phpTruthy`
   accepts `"1"`/`"true"` and sends. The JSON-bool path (the documented
   API shape) matches exactly; the string shape is pinned by parity38
   §J as a divergence, not mirrored (the seam is stringly-typed; a
   strict-bool gate at this one boundary would be inconsistent).
   Upstream note: PHP `send_now` via urlencoded form posts is broken
   the same way (string → 9998) — a candidate first fork fix, unfiled.
8. **No other divergences found.** In particular: priority/tries/
   status transitions, `cancel_after` boundary (tries 4 kept, tries 5
   dropped), `queue_once`, priority ordering, `time_limit=-1` → exactly
   1, reply-to/bcc validation, activity-log shape — all exact.

## 8. Capture + parity results

### capture41.py — 18/18 (pre-fix corpus)

- PHP-prod delivers via mock (row deleted, wire message captured,
  activity logged for ALL due rows — including the 5 baseline pendings,
  which is why assertions are relative/delta-based, never absolute).
- PHP-prod: attachment multipart, bcc envelope (valid only, invalid
  skipped), no Bcc DATA header, Reply-To header, 550 → failed/tries
  1/priority 0, missing host → failed/tries 1, unknown mailer →
  failed/tries 1.
- PHP-dev: row stays `'sending'`, mock empty (the skip proof).
- TS pre-fix: returns null, row `'sending'`, mock empty (the flip-only
  proof).

### parity38.py — 86/86, 0 failures

| § | Case | Result |
|---|---|---|
| A1 | Basic delivery, no auth: row deleted, mock accepted, activity equal, wire From/To/Subject/Content-Type/charset/html equal, no Bcc header, msgid+date present, body has appended newline, no auth either stack | PASS |
| A2 | Auth delivery: delivered + auth attempted both stacks, wire body + headers equal | PASS |
| B | Attachment: row deleted, mock accepted, body equal, attachment (filename + bytes + MIME) equal | PASS |
| C | Reply-To + Bcc: envelope includes valid bcc only, Reply-To equal, no Bcc header | PASS |
| D | Invalid reply-to: delivered, no Reply-To header | PASS |
| E | Flaky: first attempt failed/tries 1/priority 0 + mock 451 once; second attempt deleted + mock accepted | PASS (both stacks) |
| F | `cancel_after` boundary: tries 4 kept (failed/tries 5), tries 5 dropped (tries 6 > 5) | PASS (both stacks) |
| G | Connection drop: failed/tries 1, mock drop recorded | PASS (both stacks) |
| H | Config errors (nohost, badport, unknown mailer, sendmail): failed/tries 1/priority 0 | PASS (both stacks × 4) |
| I | `queue_once=2` sends exactly 2 (highest id left pending); priority order 5,3,1; `time_limit=-1` sends exactly 1 | PASS (both stacks × 3) |
| J | `send_now` via `template_send`: returns true, delivered, body, no queue row left; absent → row stays pending, mock empty; `throw_exceptions` + missing host → exact message + row failed/tries 1; string `send_now` divergence pinned (PHP 9998, TS sends) | PASS (both stacks) |
| — | Invariants after + config hash after | PASS |

Note: a brand-new template code creates a DISABLED template on both
stacks (PHP `_getDefaults` leaves enabled=0, `template_send` returns
false without queueing) — so §J crafts an ENABLED custom template row
first (snapshot-restored). This is shared PHP/TS behaviour, not a
divergence.

## 9. Incidents + harness lessons (all disclosed, all repaired)

1. **api_login 10/hour fixed-window limiter** (`RateLimiter.php`
   `api_login`: fixed window, 10/hour; `enforce_in_development: false`
   means `:8080` dev BYPASSES it, `:8081` prod ENFORCES it — which is
   why no prior suite (all dev-oracle) ever saw a 429, and parity38's
   per-run prod logins tripped it mid-run). Fix: parity38 logs in ONCE
   via dev (bypass, zero budget consumed) and reuses the session.
   R5g relevance: TS has NO limiter today, so TS logins never 429 —
   the constrained side is the PHP-prod oracle only.
2. **Snapshot restore wipes the login session** (sessions live in the
   snapshotted `session` table): the shared session died at the first
   internal restore → 201s. Fix: `restore()` re-logs in via dev, and
   multi-subsection loops (§I, §J) refetch `SESS` after each restore.
3. **Service restart killed parity38c mid-run** (after a batch send,
   before restore): DB left dirty (5 baseline pendings sent, 6 activity
   rows, 1 mod_email row). Repaired backup-first from
   `r5-logs/reference-before-r5e-repair-2026-10-29.sqlite`: the 5
   pending rows re-inserted VERBATIM from the disposable fixture
   snapshot (`disposable/snapshot.sqlite`, queue total 67 — proven
   identical by matching the 5 activity residue rows on
   recipient/subject/client_id/content+`\n`), activity rows deleted
   (baseline 0), mod_email row deleted, sequences restored
   (email_queue 469, activity 32, extension_meta 41). Verified:
   queue 67 (5 pending + 62 sending), activity 0, ext_meta 3.
4. **A debug probe re-ate the 5 baseline pendings** (its batches sent
   them; the probe cleaned only its own rows). Repaired the same way.
   Lesson: EVERY probe/batch against the reference DB must
   snapshot-restore, not just the named suites.
5. **Mock `flakySeen` persistence** (§5): suite now owns mock lifecycle.
6. **§B comparison bug (suite bug, not product):** the first version
   compared the FIRST accepted mock message instead of filtering by
   recipient — i.e. a baseline pending, not the crafted row. Fixed with
   recipient filters (same class of bug as the R5d empty-keyValue note:
   filter, don't assume position).
7. **Fixture port collision (harness, not product):** the fixture
   runner's disposable PHP binds **:8081** — the same port as this
   batch's PHP-prod oracle. The regression script left php-prod
   running, so the disposable PHP never bound; fixtures then ran API
   calls against php-prod (reference DB) while seeds went to the
   disposable copy → "Client not found", tax 0, promo expired, then
   201s (api_login budget on prod) / CSRF 403s (session split across
   DBs). The failed runs also left reference residue (invoices
   476–482, orders 168–169, queue 470–478 + children), cleaned
   backup-first (`r5-logs/reference-before-r5e-fixture-cleanup-2026-10-29.sqlite`;
   log tables left alone — append-only, never invariant-tracked).
   Fix: kill `:8081` + `:3001` before fixtures so the runner's own
   servers bind; re-run then passed 13/13 both. Standing rule: the
   fixture phase of any future regression must start with `:8081`
   free whenever a prod oracle was used.

## 10. R5e/R5f boundary + what is left

**R5f still has to wire:** cron `runCronJobs()` gains the `sendmail`
job LAST (PHP's fixed order: pay_with_credits, activate_paid, generate,
send_reminders, invoke_due_event, send_suspension_warnings,
suspend_expired, cancel_suspended, cancel_unpaid, auto_close,
expire_password_reminders, cart_expire, sendmail) + the runner semantic
gaps (update-finalization gate, per-task isolation, `last_cron_exec`
set even on isolated failures, false return propagation, guest
1-minute throttle, clearOldSessions; healSchemaDrift + Before/After
events per scope). R5e's `batchSendMail()` is the callable R5f invokes;
nothing in R5e schedules it.

**Left for later (not R5e):**
- SendGrid transport (real send, not just validation) + custom-DSN
  transport + sendmail transport (see §7.2 — TS currently fail-closes
  on sendgrid/custom even with a key/DSN present).
- Real-provider delivery (Gmail/SES/etc.) — UNVERIFIED-LIVE; the sandbox
  proves mock delivery only.
- `template_send` attachment plumbing (PHP passes `attachment`
  through; TS drops it).
- `massmailer` single-send `send_now=true` path
  (`Massmailer\Api\Admin.php:164`): TS `massmailer.send` queues only.
  (The batch path + `template_send` send_now are the R5e mirrors.)
- TS `send_test` generic-vs-template gap (pre-existing, NOT R5e: PHP
  `send_test` sends the templated `mod_email_test` mail immediately
  with send_now + throw_exceptions; TS queues a generic "Test email").
- PHP `send_now` via urlencoded form posts 9998s upstream (§7.7) —
  candidate first fork fix, unfiled.
- The R5a follow-ups are untouched: `canUpdateParam` company-field
  permission checks, N1 JSON-null reminder stored value.
- R3c (live Postgres/MySQL) still outstanding; R5j's installer must not
  invalidate it.

## 11. Regression standard (all green)

- tsc exit 0, build exit 0 (fresh build serving parity38 + regression).
- parity38: **86/86** (§8).
- parity37: **115 pass, 0 fail, 0 skipped**; parity36: 51/51; parity35:
  210/210; parity34: 164/164; parity33: 77/77; parity32: 65/65; parity31:
  63/63; parity30: 179/179; parity29: 62/62; parity28: 128/128; parity27:
  ALL GREEN (27); parity26: ALL GREEN (62); parity25: ALL GREEN (203).
- parity21: **194/203, diff names exactly the known 9**
  (`sd_tld_delete`, `sd_tld_delete_used`, `sd_tld_delete_notfound`,
  `sd_reg_available`, `sd_guest_tlds`, `sd_guest_tlds_reg`,
  `sd_guest_tlds_trans`, `sh_guest_free_tlds_fallback`,
  `dl_admin_send_file_missing_stored`).
- Fixtures: **13/13 both stacks** (verified via results JSONs, 0
  failures each) — after the incident in §9.7, re-run properly.
- Invariants after: invoice 323, client_order 11, email_queue 67
  (5 pending + 62 sending), service_custom 17, extension 6,
  extension_meta 3, setting 38, client 3, support_ticket 2,
  activity_client_email 0; config hash unchanged
  (`d6345cae63632b94`); `:3001` (TZ=UTC, full 35 modules) prime 200
  and `:8080` 200 at batch end. No commit (branch tip still R5d
  `ce82931`); `:8081` php-prod left stopped (batch-specific oracle,
  not a standing server).
