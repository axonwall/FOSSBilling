# Findings — Phase 5 batch R5h: antispam enforcement (TS)

Branch `feat/nextjs-phase5-r1`, on tip `404222d` (R5g limiter + parity21
cart/session restore fix). TS only; no PHP source modified; not committed,
not pushed. Companion artifacts: `capture44.py` + `captures44/`,
`antispam-mock-server.mjs` (port :18026), `parity41.py`.

Status at write time (2026-10-30): implementation complete, typechecked,
built, bundle-verified. `parity41` run-1: 124/127 (see §8 for the three
failures and their dispositions). An independent re-verification run
(`my-r5h-check.sh`, not this batch's script) reproduced parity41 at
129/130 with the same single failure (pre-fix file), then went green
on the full chain (parity40 120/120, parity39 212/212, parity38 86/86
with oracle, parity37 green, parity36 51/51, parity35 210/210,
parity34 164/164, parity33 77/77, parity32 65/65, parity31 63/63,
parity30 179/179, parity29 62/62, parity28 128/128, parity27 27/27,
parity26 62/62, parity25 green, parity21 194/203 at the known 9
diffs, fixtures 13/13 both stacks). One parity41 assertion failure
was root-caused to a suite bug (reused emails, §8.3) and fixed in
`parity41.py`.

Parent-verification addendum (2026-10-30, after this doc was first
written): the §8.3 fix was confirmed — a standalone drop-phase repro
(mock hits 1 → 2 → 3 across the two drop signups + the seed signup)
passed, and a full post-fix parity41 re-run passed **130/130**
against unchanged code. The chain + rerun together are the complete
gate: no source file changed between them. Batch-end state verified:
reference Next (:3001, TZ=UTC) answering; :8081, :18025, :18026,
:3003 all down; DB invariants clean (queue 67, client 3, admin 2,
cart 283/seq 305, counters 0); config hash unchanged
(`6e3c529673c1d089`); no mod_antispam row. Committed as the R5h
commit on `feat/nextjs-phase5-r1`; push remains Josh's tap.

## 1. PHP survey (the truth; all citations are `src/` paths in this repo)

Antispam enforcement in PHP is event-listener based
(`src/modules/Antispam/Service.php`). The six listeners, and the TS
handler each maps to:

| PHP listener | Gating | TS handler |
|---|---|---|
| `onBeforeClientSignUp` (Service.php:69) | blocked-IP → SFS → temp-email → honeypot | `modules/client.ts` guest `create`, `checkSignupAntispam` after the existing/rate-limited early returns, just before `createClientRow` |
| `onBeforeGuestTicketCreate` (Service.php:82) | guest role ONLY (`author_role === 'guest'`): blocked-IP → captcha → SFS → temp-email. NO honeypot on tickets | `modules/support.ts` guest `ticket_create`, `checkGuestTicketAntispam` after subject validation, BEFORE the helpdesk lookup |
| `onBeforeClientProfileUpdate` (Service.php:97) | blocked-IP ONLY (CLIENT profile event, `Profile/Service.php` updateClientProfile) | `modules/profile.ts` client `update` |
| `onBeforeAdminClientUpdate` (Service.php:104) | blocked-IP ONLY (admin updating a client record) | `modules/client.ts` admin `update` |
| `onBeforeClientLogin` (Service.php:111) | blocked-IP ONLY, after email validation, before credential checks | `modules/client.ts` guest `login` |
| `onBeforeAdminLogin` (Service.php:118) | blocked-IP ONLY, after email validation, before credential checks | `modules/staff.ts` guest `login` |

Deliberately NOT gated (verified from code and by counterproof in
capture44/parity41): admin profile update (`BeforeAdminProfileUpdateEvent`
has no antispam listener) and admin client CREATE
(`BeforeAdminClientCreateEvent` is a different event with no listener).
TS mirrors both non-gatings, with comments saying so.

Captcha is NOT part of the signup event. It is verified in
`Client/Api/Guest.php` `create()` via `checkCaptchaIfEnabled` (line 107)
BEFORE the event fires — the comment at Service.php:69-72 notes tokens
are single-use, so re-checking inside the event would reject genuine
signups. Guest `create` order: RequiredParams → limiter `client_signup`
→ disable_signup → passwordsMatch/extra/custom/strength → email
validate+sanitize → captcha → email-quota probe → existing-account
early return → `guestCreateClient` → event. Consequence: captcha fires
even for existing emails; the event fires ONLY for genuinely new
signups (existing/rate-limited calls return `true` early). This ordering
is what bit the parity41 drop phase (§8.3).

Survey extra, contradicting the scope doc's handler list:
`checkCaptchaIfEnabled` is also called by client `reset_password`
(`Client/Api/Guest.php:307`, between the ip probe and the email probe)
and staff `passwordreset` (`Staff/Api/Guest.php:154`, between ip and
email probes) — captcha ONLY, no blocked-IP on either. Password
CHANGE/confirm endpoints have no antispam hook and were left alone.
`AbstractApi.php:130` is the shared `checkCaptchaIfEnabled`, gated on
`isExtensionActive('mod','antispam')`; antispam IS a core module
(`Module.php` CORE_MODULES), so it is always active.

### 1.1 Config (encrypted extension row, R4a config path + `crypt.ts`)

`Extension/Service.php` `getConfig` (line 709): no row → `[]` (plus
`ext`); `Module::getConfig` likewise returns `[]`. Reference baseline:
extension_meta = 3 rows (`mod_theme`, `mod_cron`, `mod_massmailer`) —
NO `mod_antispam` row — so reference behavior = all defaults, on both
stacks (TS `readExtensionConfig` returns `{}` on a missing/undecryptable
row, matching PHP; there is no separate "config error" path).
`setConfig` REPLACES the whole config, so every `config_save` must post
the full desired config. The enforcement path reads via `mod_config` →
`Module::getConfig` (direct DB read, uncached), so TS-written rows are
visible to PHP immediately.

| Key | Default | Notes |
|---|---|---|
| `block_ips` | false (falsy) | Flag; the check reads flag AND list — neither alone blocks |
| `blocked_ips` | `""` | Newline-separated (`PHP_EOL` explode), trimmed, exact `in_array` match — NO CIDR/subnet matching |
| `sfs` | false | StopForumSpam check |
| `check_temp_emails` | true | Temp-email check ON by default (this is why sandbox signups hit the temp fetch) |
| `honeypot_enabled` | true | |
| `honeypot_field` | `'bio'` | |
| `captcha_enabled` | false | |
| `captcha_provider` | `'recaptcha_v2'` | |
| recaptcha site/private keys | null | Missing private key → missing-key error (not a skip) |
| `captcha_recaptcha_v3_threshold` | 0.5 | Clamped to 0–1; non-finite → 0.5 |
| turnstile / hcaptcha keys | null | Missing secret → missing-secret error |

### 1.2 Each check's exact semantics + error shape

PHP envelope (`Http/ApiResponseFactory.php`): exception code 0 →
envelope code 9999 (HTTP 200); code 403 → real HTTP 403. Uncaught
transport exceptions surface as the sanitized generic
`An unexpected error occurred. Please try again later.`, code 9999,
HTTP 200 — NOT a raw HTTP 500 (earlier lore said 500; capture44
disproved it). TS envelopes are always HTTP 200 (seam convention);
envelopes are compared, never HTTP status, except the R5g limiter's
real 429 and the R5f gate's 503.

**Blocked-IP** (`checkBlockedIp`, Service.php:124): requires
`block_ips` truthy AND `blocked_ips` set; exact match against
`$di['request']->getClientIp()` = Symfony REMOTE_ADDR unless trusted
proxies are configured (`Http/RequestFactory.php`). TS seam `ctx.ip` =
first X-Forwarded-For entry else `127.0.0.1` (pre-existing seam
behavior inherited from R5g) — the IP fed into the identical
list-membership test differs behind a proxy; named caveat, not a
failure. Error: `Your IP address (:ip) is blocked. Please contact our
support to lift your block.` with `:ip` substituted, code 403
(PHP: real HTTP 403; TS: HTTP-200 envelope with code 403).

**Honeypot** (`checkHoneypot`, Service.php:267): field = config
`honeypot_field` (default `'bio'`); PHP `!empty()` semantics — `'0'`
counts as EMPTY and passes; filled → `Registration failed.`
(deliberately generic), code 9999. Signup only (guest ticket ignores
the field — proven in capture44/parity41).

**Temp-email** (`checkTempEmail` Service.php:253, `isATempEmail`
Service.php:327, `getTempMailDomainDB` Service.php:357): fetch GET
`https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt`,
cached 86400s — the docblock says "1 week" but the code sets 86400 =
24h; code wins. Non-200 → cache 3600s + return `[]`; empty file →
3600s + `[]`; lines filtered to drop `#`-comments and non-domains
(`FILTER_VALIDATE_DOMAIN`). Matching is EXACT-domain only on the
lowercased domain (vendor `ArrayAdapter.php` uses
`isset($domainSet[$domain])` — no subdomain matching). Parse exception
→ treated as valid (fail-open). Throwaway + throw →
`Disposable email addresses are not allowed`, code 9999. The
`tempEmailDB.txt` write/read/delete under PATH_CACHE is only a transfer
buffer; the cache itself is the Symfony cache pool. A TRANSPORT
exception is NOT caught — it propagates (the deviation anchor: on the
sandbox, every guest signup with defaults hits it, because sandbox TLS
fails the fakefilter fetch).

**SFS** (`isInStopForumSpamDatabase` Service.php:289, called from
`checkSpam` Service.php:137): GET
`https://www.stopforumspam.com/api?f=json` + ip/email/username params
(no key). `checkSpam` builds data with ONLY `ip` + `email` — username
is NEVER sent on this path, despite `isInStopForumSpamDatabase`'s
docblock listing username (scope-doc correction). Non-object JSON or
`success=false` → false (fail-open). Flag messages, checked in order
username → email → ip: `Your username is blacklisted in the Stop Forum
Spam database`, `Your e-mail is blacklisted in the Stop Forum Spam
database`, `Your IP address is blacklisted in the Stop Forum Spam
database`, code 9999. Transport errors are NOT caught — they propagate
(like temp-email), so PHP fail-hards with the generic error.

**Captcha** (`checkCaptcha` Service.php:152, gated on
`captcha_enabled` truthy; provider default `recaptcha_v2`):
- recaptcha v2/v3: missing/empty private key →
  `To use reCAPTCHA you must get an API key from <a href='https://www.google.com/recaptcha/admin/create'>here</a>`;
  missing/empty `g-recaptcha-response` →
  `You have to complete the CAPTCHA to continue`; POST
  `https://google.com/recaptcha/api/siteverify` with secret + response
  + remoteip; `success !== true` → `reCAPTCHA verification failed.`
  (code 9999). v3 additionally clamps threshold to 0–1 (default 0.5,
  non-finite → 0.5), requires score ≥ threshold (missing score → 0.0),
  and requires action `fossbilling_submit` — with the nuance that a
  MISSING `g-recaptcha-action` param defaults to the expected value
  (`$params['g-recaptcha-action'] ?? $expectedAction`), so only a
  present-but-wrong param or a wrong response action fails.
- Turnstile: POST
  `https://challenges.cloudflare.com/turnstile/v0/siteverify`; missing
  secret → `Cloudflare Turnstile secret key is not configured.`;
  missing response → `Please complete the CAPTCHA verification.`;
  failure → `CAPTCHA verification failed. Please try again.`
- hCaptcha: POST `https://hcaptcha.com/siteverify`, same
  missing-secret/missing-response/failure messages as turnstile (with
  `hCaptcha secret key is not configured.`).
- Unknown provider: silently passes. Single-use is PROVIDER-side
  (providers reject reused tokens); PHP stores no tokens. Transport
  errors propagate (Symfony `toArray()` throws) — NOT caught, so PHP
  fail-hards with the generic error.

### 1.3 Ordering (inside a handler, and vs validation, and vs limiter)

- Signup: validation (RequiredParams, email) → captcha → (event, new
  signups only) blocked-IP → SFS → temp-email → honeypot. So a signup
  that is both invalid and blocked yields the validation error; a
  blocked signup with a bad captcha token yields the captcha error
  (captcha beats blocked on signup).
- Guest ticket: validation → limiter → email validate → event
  (blocked-IP → captcha → SFS → temp-email) → helpdesk lookup AFTER
  the event. So a blocked ticket with a bad captcha token yields the
  blocked error (blocked beats captcha on tickets).
- Logins / profile / admin client update: email validation (and, for
  admin client update, email/billing/birthday/currency validations)
  precede the blocked-IP check; nothing else precedes it.
- R5g limiter: route level, BEFORE handlers. A rate-limited signup
  yields 429 even if also blocked; an antispam-blocked signup still
  consumed route quota. TS preserves this exactly (antispam is inline
  in handlers, after the limiter; the limiter was not re-ordered).

## 2. TS implementation (files changed, all under `apps/nextjs/`)

- `src/server/modules/antispam.ts` — enforcement layer added above the
  existing config handlers (config get/set, block/unblock untouched).
  Exports `readAntispamConfig`, `checkBlockedIp`, `checkCaptcha`,
  `checkTempEmail`, `checkStopForumSpam`, `checkHoneypot`,
  `checkSignupAntispam` (blocked→SFS→temp→honeypot),
  `checkGuestTicketAntispam` (blocked→captcha→SFS→temp). Long header
  comment documents the listener→handler map, orderings, IP caveat,
  and error-code mapping. `FbError` default code 9999 matches PHP's
  code-0 → 9999 rendering.
- `src/server/antispam-temp-seed.ts` — NEW vendored SEED (header dated
  2026-10-30, explicitly "a SMALL hand-written seed, NOT the full
  fakefilter list; production gets the full list via fetch+cache"):
  28 domains (10minutemail.com/.net, dispostable.com, fakeinbox.com,
  getnada.com, guerrillamail.biz/.com/.de/.net, maildrop.cc,
  mailinator.com/.net/.org, mailnesia.com, mintemail.com, mohmal.com,
  mytemp.email, sharklasers.com, spamgourmet.com, temp-mail.org,
  tempail.com, tempmail.com, tempmailaddress.com, throwaway.email,
  throwawaymail.com, trashmail.com, yopmail.com/.net). None collides
  with seeded personas or prior-suite example.com/example.invalid
  addresses.
- Wiring (all inline, AFTER the R5g limiter, in PHP order):
  - `modules/client.ts`: guest create — `checkCaptcha` right after
    `validateEmail`, BEFORE the email-quota probe/existing path;
    `checkSignupAntispam` after existing/rate-limited early returns,
    just before `createClientRow`. Guest login — `checkBlockedIp`
    after `validateEmail`, before credential check. Guest
    `reset_password` — `checkCaptcha` between the ip probe and the
    email probe. Admin `update` — `checkBlockedIp` after
    email/billing/birthday/currency validations, before
    phone/country/lang/timezone; the confirm-email DELETE was deferred
    until after the blocked check so a rejected call has no side
    effects (PHP persists nothing before dispatch).
  - `modules/support.ts`: guest `ticket_create` —
    `checkGuestTicketAntispam` after subject validation, BEFORE the
    helpdesk lookup. Client/admin ticket handlers NOT gated
    (guest-role-only event).
  - `modules/staff.ts`: guest login — `checkBlockedIp` after email
    validation, before `findAdminAuthByEmail`; guest `passwordreset`
    — `checkCaptcha` between ip and email probes; removed the
    now-stale "captcha is unset — still skipped" comment.
  - `modules/profile.ts`: client `update` — validate email if
    present, then `checkBlockedIp`, then existing body (dup check etc.
    remain after dispatch, as in PHP). Admin `update` deliberately
    NOT gated, with an explanatory comment.
  - No changes to password-change/confirm endpoints (no antispam hook
    in PHP).
- Verification of build: `npx tsc --noEmit` clean (exit 0);
  `npm run build` clean; bundle grep confirmed string literals
  `Disposable email addresses are not allowed`,
  `is blocked. Please contact our support`, `fossbilling_submit` all
  present in `.next/server/chunks/8268.js`. :3001 restarted on the new
  build and answered; a probe signup on :3001 (`probe3001@example.com`)
  returned `true` (live fail-open working) — that probe client was
  deleted immediately (see §7).

Temp-list details (TS): fetch with 10s timeout; success → parse (trim,
lowercase, drop empty/`#`-comments/non-domains via a domain regex
approximating `FILTER_VALIDATE_DOMAIN`) and cache 86400s (TTL
overridable for tests ONLY via `FB_ANTISPAM_TEMP_LIST_TTL_SECONDS`,
default 86400); non-200 or empty body → negative-cache the FAILURE
3600s (no refetch in window) with seed deciding; transport error →
NOT cached (refetch each time, matching PHP's no-write) with seed
deciding. Cache is process-local in-memory (PHP's is the filesystem
cache pool — durability differs, TTL semantics identical). Matching is
exact lowercased domain only; unparseable address → allow (PHP
parse-failure → valid).

Captcha details (TS): per-provider verify with env-overridable verify
URLs for testing ONLY (defaults stay real provider URLs); v3 threshold
parse + non-finite→0.5 + clamp 0–1, missing score→0.0, missing action
param defaults to `fossbilling_submit` (PHP `??` semantics); unknown
provider falls through silently (as PHP). Transport/non-200/malformed
→ FAIL-CLOSED with the provider's verify-failed error (decision:
outcome matches PHP's fail-hard, message differs specific vs generic;
a captcha that cannot be verified must never pass). Single-use is
provider-side; TS stores no tokens.

SFS details (TS): sends ONLY ip + email (+ `f=json`); non-object or
`success=false` → allow; appears checks in PHP order
username→email→ip with PHP's exact messages; appears uses a TRUTHY
check (real SFS returns 0/1, not booleans — fixed after first build).
Transport error → TS FAILS OPEN (allow) per R5-4 — pinned deviation
from PHP's fail-hard generic error.

Env overrides (test-only, following the `FB_ENOM_API_URL` precedent):
`FB_ANTISPAM_TEMP_LIST_URL`, `FB_ANTISPAM_SFS_URL`,
`FB_ANTISPAM_RECAPTCHA_VERIFY_URL`,
`FB_ANTISPAM_TURNSTILE_VERIFY_URL`,
`FB_ANTISPAM_HCAPTCHA_VERIFY_URL`,
`FB_ANTISPAM_TEMP_LIST_TTL_SECONDS`. Defaults NEVER change.

## 3. Snapshot resolution (scope text vs chosen behavior)

R5-4 says "fetch + cache + fail-open-on-any-error + vendored fallback
snapshot" without settling the snapshot's role (seed? fallback when
fetch fails? fallback when cache is cold?). Chosen + documented
resolution: fetch → cache (86400s); on ANY fetch error, consult the
vendored snapshot if it covers the domain (block if listed) and
fail-open (allow) otherwise. This is a deliberate THIRD behavior:
stronger than PHP's non-200 allow for seed-listed domains, weaker than
a live fetch; TS blocks on snapshot-listed domains where PHP would
fail-hard (transport error) or allow (non-200 with empty result).
The snapshot is a seed (28 domains, §2), not the full fakefilter list,
and the header says so; production deployments get the full list via
fetch+cache. A live list, when available, is authoritative and the seed
is not consulted.

## 4. Deviation table (TS vs PHP, as pinned)

| Check / path | PHP | TS | Note |
|---|---|---|---|
| Temp-email transport error | fail-hard (generic `An unexpected error occurred...`, 9999, signup fails) | allow (unlisted) / seed-block (seed-listed) | Documented R5-4 deviation; capture44 anchor |
| Temp-email non-200 | allows (empty result cached 3600s) | allows unlisted BUT blocks seed-listed | Third behavior via snapshot (§3) |
| SFS transport error | fail-hard (generic 9999) | allow | R5-4 "SFS ported fail-open" deviation |
| Captcha transport/non-200 error | fail-hard with GENERIC message | fail-closed with provider-specific verify-failed message | Same outcome (call rejected), message differs |
| Blocked-IP HTTP status | real HTTP 403 | HTTP-200 envelope with code 403 | Seam convention; envelopes compared |
| IP sourcing | REMOTE_ADDR (unless trusted proxies) | first X-Forwarded-For else 127.0.0.1 | Pre-existing seam behavior; list test identical |
| Temp cache durability | filesystem cache pool | process-local in-memory | TTL semantics identical; restart refetches |
| All other messages/codes | — | match exactly | incl. blocked-IP 403, honeypot `Registration failed.` 9999, temp block `Disposable email addresses are not allowed` 9999, SFS blacklist messages 9999, captcha messages 9999, PHP code-0 → envelope 9999 equivalence |

## 5. Capture corpus (capture44, 2026-10-30)

`capture44.py` + `captures44/` (manifest.json + per-call JSON). Method:
prod oracle :8081 for non-email-validated endpoints + dev :8080 for
signup/ticket/captcha/SFS/temp (prod signup/ticket observations are
unconstructible in the sandbox: prod-only Egulias DNSCheckValidation
fails every address since sandbox DNS answers no MX/A records, AND the
prod `client_signup` 5/hour/IP budget is shared; run 1 recorded `Email
address is invalid` then 429s proving both masks). Admin logged in ONCE
via dev, session reused on the oracle (proven working); client persona
logged in ONCE on the oracle before any block. Config via PHP's own
admin `config_save`; mod_antispam row deleted in finally. Two early
capture runs had harness bugs (double-`make_opener()` splitting
opener/jar causing CSRF 403; a block left active before fresh logins)
— the final run is clean.

Observed on PHP (exact texts/codes): blocked-IP message+code 403 on
signup, guest ticket, client login, staff login, client profile update,
admin client update (prod login/profile/admin-update + dev
signup/ticket); validation beats blocked (signup missing `first_name`
while blocked → `First name required`, 9999); NOT gated while blocked:
admin profile update → `true`, admin client create → success (created
id 24, cleaned up); honeypot filled `bio` → `Registration failed.`,
9999; `bio='0'` → signup succeeds; absent → succeeds; guest ticket
with `bio` filled → ticket created (honeypot signup-only); blocked +
existing email → `true` (event never fires for existing accounts);
captcha missing private key → recaptcha missing-key message, 9999;
missing token → `You have to complete the CAPTCHA to continue`, 9999;
verify POST TLS failure → generic error, 9999, HTTP 200; turnstile
missing secret → `Cloudflare Turnstile secret key is not configured.`;
turnstile missing token → `Please complete the CAPTCHA verification.`;
hcaptcha missing secret → `hCaptcha secret key is not configured.`;
reset-password captcha points confirmed (with recaptcha enabled + no
private key, BOTH client `reset_password` and staff `passwordreset`
return the recaptcha missing-key message; follow-up script cap44d, dev
only, config restored to 3 rows after); ordering: signup blocked +
captcha token (verify TLS-fails) → generic error (captcha runs BEFORE
blocked on signup); guest ticket blocked + captcha token → blocked 403
(blocked BEFORE captcha on tickets); SFS transport failure → generic
error (fail-hard, like temp-email); temp-email transport anchor (NO
config row = all defaults) → generic error (fail-hard); captcha-disabled
default: token-less signup succeeds (with temp check off).
Capture44 finally verified: extension_meta back to 3 rows, cart
283/seq 305, 0 cap44 clients/tickets left.

Code-only (NOT observable live; never faked): temp-email BLOCK message,
SFS flagged messages, captcha verify-failure messages
(`reCAPTCHA verification failed.`,
`CAPTCHA verification failed. Please try again.`), v3 score/action
checks — all from code, since live fetches/verify POSTs TLS-fail in the
sandbox.

## 6. Mock server (:18026) and parity41

`antispam-mock-server.mjs` (Node, suite-owned lifecycle: kill any :18026
listener at suite start, start its own, kill in finally; a LEAKED mock
makes cache/retry cases pass vacuously — R5e lesson, twice).
- GET `/temp-list`: fakefilter-format text (comment line, blank line,
  `mockthrow.test`, `mockthrow2.test`, invalid line `not a domain!!`,
  `UPPERCASE-TEST.test`, `sub.listed.test`) + hit counter. Modes: `ok` /
  `500` / `drop` (destroys socket, simulating transport error, mock
  stays alive).
- POST `/recaptcha`, `/turnstile`, `/hcaptcha`: form-encoded, provider
  shapes. Tokens: `valid-token` → success true (recaptcha adds score
  0.9 + action `fossbilling_submit`); `low-score-token` → success true,
  score 0.2; `wrong-action-token` → success true, score 0.9, action
  `someone_else`; `reuse-token` → success ONCE then success false
  (provider-side single-use simulation, per-provider marking); anything
  else → success false. Modes include `drop` per provider.
- GET `/sfs`: stopforumspam-shaped JSON (`success`, per-field `appears`
  0/1): email `sfsflag@example.com` → email appears; ip `203.0.113.99`
  → ip appears; username `sfsuser` → username appears. Modes: `ok` /
  `successfalse` (`{success:false}`) / `drop`.
- POST `/control {service, mode}`, GET `/hits`, POST `/reset` (zeroes
  counters, token state, modes). NEVER logs request bodies; records
  token validity only, never secret values.

`parity41.py` sections: (i) blocked-IP every gated endpoint + two
non-gated counterproofs, TS + PHP dev; (ii) honeypot; (iii) temp-email
incl. cache/TTL/negative-cache/transport/snapshot/exact-domain;
(iv) SFS; (v) captcha per provider incl. v3 clamp + reuse;
(vi) ordering; (vii) limiter interaction on forced :3003; (viii)
restore. Test IPs: blocked XFF `203.0.113.7`, SFS-flagged XFF
`203.0.113.99`; PHP blocked IP `127.0.0.1`; crafted password
`Par41-Pass!42`. TS sections run on reference :3001 (real provider
URLs — sandbox TLS fails, so TS fail-open is exercised for real) and
on mock-backed servers :3004/:3005/:3006/:3007 (one fresh port per
temp phase — see §8.2 for why). Suite asserts :3001 still answers and
:18026/:3003/:3004-:3007/:8081 all down at suite end.

## 7. Incidents during the batch (stated plainly)

**Cart incident (2026-10-30, RESOLVED).** The :3001 probe signup
created client id 28 (`probe3001@example.com`); cleanup deleted the
client, then a mistaken `DELETE FROM cart WHERE id>283...` removed 19
LEGITIMATE cart rows (cart ids are sparse: count 283 but ids run to
seq 305; the `NOT IN (empty set)` clause did not protect them). Count
dropped 283 → 264. Recovery: `.recover` failed (sandbox sqlite3 lacks
`sqlite_dbpage`). Restored from
`~/scratch/fossbilling/r5-logs/reference-before-r5g-admin-cleanup-2026-10-29.sqlite`
(284 rows): live set was a subset of the backup with ZERO common-row
diffs; the 19 deleted rows were exactly the backup's id>283 rows
excluding id 306 (the row the R5g cleanup had removed + seq reset).
Re-inserted those 19 rows; verified live cart = 283 rows, seq 305, and
live id set == backup id set minus {306}. Post-delete state was
preserved first at `~/scratch/fossbilling/recover-cart/live-post-delete.sqlite`
(plus `copy.sqlite`). LESSON (applied in parity41): snapshot
cart/client/ticket/queue/reset id SETS and delete only non-snapshot
ids — never an id-range delete. Note: TS signup does NOT create a cart
row (unlike PHP login) — count stayed 283 through the probe itself.

**Queue residue (RESOLVED, pre-existing, not the batch's).**
Parity41 run-1 inv-before AND inv-after both showed email_queue 71 !=
67: parity41 added/removed exactly its own rows (before == after).
The 4 extra rows were capture44c residue (2026-10-30 ~05:14, ids
471/473/474/477: three `[Company Name] New Client Signed Up` to admin
+ one `cap44 honeypot ticket` to info@yourcompany.com — recipients are
admin/info addresses, so capture44's `LIKE 'cap44%@example.com'`
queue cleanup missed them). Rows backed up to
`~/scratch/fossbilling/r5-logs/r5h-queue-residue-backup.json`, then
deleted; queue verified back to exactly 67 = 5 pending + 62 sending
(the task baseline).

**Repro config_save 201 (open minor question, non-blocking).** The
fresh-server drop-mode reproduction (below) used a snippet that fetched
`/login` for a CSRF token but never POSTed a staff login, so its
TS-admin `config_save` returned `Authentication Failed` 201 and the
config was never set — but this did NOT invalidate the hits proof,
because the default config (no row) already enables the temp check.
Parity41's own logins are proper; its config_saves assert success.

**VM restart (2026-10-30 ~05:29–05:32).** System uptime showed 3 min
after the restart; all servers (:8080, :3001, mock, forced) died and
had to be restarted. A parity41 re-run launched into the dead
environment failed at login (connection refused) — the suite's
"verify both servers 200 immediately before launching" rule exists
for exactly this. A second re-run attempt then failed with
`Could not find a production build in the '.next' directory` for
:3004 while :3001 answered on the same build — transient post-restart
filesystem visibility, not a build problem (`.next` verified present
immediately after).

**Concurrent independent verification.** While this batch's re-runs
were being debugged, an independent re-verification
(`~/scratch/fossbilling/r5-logs/my-r5h-check.sh`, self-described as
"NOT the build worker's script") ran parity41 itself on the same
shared DB/ports. That explains one otherwise-mysterious failure: a
re-run started mid-verifier-run saw dirty inv-before state
(extension_meta 4, client 5, cart 285/307) and a blocked admin login
(the verifier's block config) — the dirt was the verifier's mid-run
state, not this batch's residue; the verifier's finally restored
baseline (verified after: cart set == backup set, seq 305, queue 67,
meta 3, client 3, counters 0). LESSON: never run two parity41 (or any
two DB-mutating suites) concurrently — snapshot-diff cleanup in one
run will delete the other run's rows.

## 8. Parity41 results

### 8.1 Run-1: 124/127 (log `~/scratch/fossbilling/r5-logs/parity41.log`)

Everything PASSED except the three failures below: TS + PHP blocked-IP
message+code 403 on signup, ticket, client login, staff login, client
profile, admin client update; admin profile NOT gated + admin client
create NOT gated on both stacks; blocked+existing signup → `true` on
TS; honeypot filled → `Registration failed.` 9999 (both stacks), `'0'`
passes (both), absent passes, ticket ignores honeypot field; temp
mock-listed blocks, fetch hit 1 then cached (hits still 1),
exact-domain-only (subdomain passes, listed subdomain blocks),
case-insensitive domain blocks, TTL expiry refetch (hits 2 after 6s
sleep, TTL 5s on :3004), non-200 allows + second call no refetch,
transport-error allows, snapshot seed-listed blocks on drop + unlisted
allows on drop, PHP temp transport generic failure, TS real-URL
transport allows unlisted; SFS flagged email/ip block with exact
messages, success=false allows, transport allows (deviation), disabled
allows flagged, PHP SFS transport generic failure; captcha v2
valid/invalid/missing-token/missing-secret, provider-down fails
closed, v3 valid/low-score/wrong-action/missing-action-param-passes
(PHP `??` default)/threshold-2-clamps-to-1 (0.9 fails)/threshold-(-1)-
clamps-to-0 (0.2 passes), reuse first passes/second fails, turnstile +
hcaptcha valid/invalid/missing-token/missing-secret, disabled
token-less passes, client reset_password + staff passwordreset captcha
enforced, PHP captcha missing-secret/missing-token/verify-transport-
generic; ordering signup captcha-beats-blocked+temp, signup
validation-beats-blocked, ticket blocked-beats-captcha, PHP
validation-beats-blocked; limiter rate-limited signup is 429 (not
antispam), antispam-blocked signup is 403 (not 429) + consumed route
quota (`client_signup` counter ≥1), blocked+rate-limited first 5 are
403 and 6th is 429 (limiter first); all inv-after checks pass except
email_queue (below); counters empty after; :3001 still answers;
:18026/:3003/:3004/:8081 all down at suite end.

Failures:
1. `inv-before email_queue 71 != 67` and `inv-after email_queue 71 !=
   67` — pre-existing capture44c residue, §7. Cleaned after the run;
   queue back to 67.
2. `ts temp transport-error refetches (not cached)` (expected hits==2,
   got hits==0, while both drop signups correctly allowed) — suite
   bug, root-caused in §8.3, fixed in `parity41.py` after both runs.
   Product behavior was proven correct by a fresh-server reproduction
   (new mock in drop mode + fresh :3004 → two drop signups both
   allowed, mock hits exactly 2: transport errors refetch, not
   cached).

### 8.2 The stale-server detour (wrong theory, kept for the record)

Run-1's hits==0 was first diagnosed as a stale :3004 surviving the
restart between the non-200 phase and the drop phase (the old server's
3600s negative-cache entry serving seed decisions with zero new
fetches — consistent with all drop-phase outcomes being correct while
hits stayed 0). The fix applied on that theory — one fresh mock-TS
port per temp phase (:3004/:3005/:3006/:3007) plus a proc-alive check
in the startup poll — is harmless and kept, but the independent
re-verification run (which used the fresh-port version, proven by its
`next-3005/3006/3007-parity41.log` files at 05:34–35, :3006 starting
cleanly in 1522ms) reproduced the SAME single failure. Fresh ports
did not fix it, so the stale-server theory was wrong. The real cause
is §8.3.

### 8.3 Root cause of the refetch failure (suite bug, not product bug)

Phase B (non-200 mode) ALLOWS `user@mockthrow.test` and
`user@mockthrow2.test` — and therefore CREATES those two clients.
Phase C (drop mode) reused the same two emails. On TS, guest create
returns early with `true` for an existing account BEFORE the event
(and therefore before the temp check) ever runs — the same ordering
§1.3 documents for PHP. So Phase C's two drop signups never attempted
a fetch, the mock recorded zero hits, and the hits==2 assertion
failed — while both signups "allowed" correctly and the later
seed-block check passed precisely because `mailinator.com` WAS fresh
(its signup reached the temp check, fetched, hit the drop, consulted
the seed, and blocked). Evidence chain: (a) run-1 + verifier run both
failed only this assertion while all adjacent drop/seed assertions
passed; (b) the fresh-server repro with FRESH emails recorded hits
exactly 2; (c) the code order (existing early return before
`checkSignupAntispam`) is in both PHP (`Guest.php` create) and TS
(`modules/client.ts`).

Fix (in `parity41.py`, not yet re-run): Phase C drop pair now uses
fresh local parts `par41drop1@mockthrow.test` /
`par41drop2@mockthrow.test`, with a comment documenting the trap.
Phase A emails stay fresh (blocked signups create no clients), Phase
B emails stay fresh (Phase A blocked them), and all other phases
already used fresh emails.

Also fixed in `parity41.py` after run-4: logins ran BEFORE the suite's
`try/finally` (the try starts at `start_mock`), so a login failure
aborted with no cleanup at all. The login block is now wrapped in its
own try/except that deletes any login-created cart rows not in the
start snapshot and resets the cart sequence before re-raising.

Independent run result (verifier, pre-fix file): parity41 129/130
(single failure = §8.3), parity40 120/120. Post-fix confirmation
(parent verification, 2026-10-30): standalone drop-phase repro passed
(hits 1 → 2 → 3) and a full post-fix parity41 re-run passed 130/130
in a quiescent environment (invariants clean before and after, no
concurrent suite). The §8.3 fix is therefore confirmed, not merely
plausible.

## 9. Coverage table (per check per endpoint)

- PHP-observed: blocked-IP on all six gated endpoints; honeypot
  (filled/`'0'`/absent; ticket non-gating); ordering
  (validation-beats-blocked; signup captcha-beats-blocked; ticket
  blocked-beats-captcha); captcha missing-secret/missing-token;
  temp/SFS/captcha transport generic failures; captcha-disabled
  default; admin-profile/admin-create non-gating; blocked+existing →
  `true`.
- Mock-proven TS: temp list/caching/TTL/negative-cache/snapshot/
  exact-domain/case-insensitivity; SFS flags (email/ip) /
  success=false / drop / disabled; captcha per provider incl. v3
  clamp + reuse + provider-down fail-closed + missing-token/secret;
  reset-password captcha (both roles); limiter interaction (both
  directions + quota consumption + limiter-first).
- Code-only: temp BLOCK message text (proven by code + transport
  anchor); SFS flagged messages' PHP side (TS side mock-proven);
  captcha verify-success shapes beyond the mock (live providers
  unreachable); v3 live score/action beyond mock shapes.

## 10. Limiter-interaction proof (parity41 §vii, forced :3003)

- Rate-limited signup → 429 (not an antispam error).
- Antispam-blocked signup → 403 (not 429) AND its `client_signup`
  counter incremented (route consume precedes handler).
- Blocked-IP + rate-limited: first 5 → 403, 6th → 429 (limiter first).
- Parity40's forced-server signup trips still trip at exactly 5/hour
  (independently re-verified 120/120, §8.3) — antispam fail-open does
  not swallow the limiter's 429, and antispam blocks do not consume
  extra limiter quota beyond the route-level consume.
- Counters reset between subsections (`reset_all`); forced :3003
  killed by explicit PID in finally.

## 11. R5h/R5i boundary

R5h touches ONLY the six antispam listeners (§1) + the two
reset-password captcha call sites. R5i security homes (`ip_lookup`,
`run_check`, `run_checks`) are separate and untouched — no file, no
handler, no config key in this batch overlaps them.

## 12. Scope-doc contradictions (PHP code is the truth)

(a) SFS `checkSpam` sends ip+email ONLY, never username. (b) "Profile
updates" = CLIENT profile only — admin profile update is NOT gated.
(c) Admin client CREATE is not gated (only UPDATE). (d) Captcha is
also verified on client `reset_password` and staff `passwordreset`
(scope doc omits both) — implemented. (e) v3 missing action param
does NOT fail (PHP `??` default). (f) Temp-list cache TTL is 86400s
in code despite the "1 week" docblock. (g) `tempEmailDB.txt` is a
transfer buffer, not the cache. (h) PHP transport failures surface as
the generic 9999 message with HTTP 200, not a raw HTTP 500. (i) Temp
matching is exact-domain only (no subdomain matching). (j) Scope text
does NOT settle the snapshot's role — the chosen resolution is §3
(seed decides on ANY fetch error; live list, when available, is
authoritative and the seed is not consulted).

## 13. What is left

- Post-fix parity41 re-run: DONE (130/130, parent verification).
  Full regression tail: DONE by the independent verifier (counts in
  the Status addendum above).
- Live provider verification (real Google/Cloudflare/hCaptcha
  verifies, live SFS flags, live fakefilter fetch) — needs real
  network/keys, unconstructible in the sandbox.
- The repro `config_save` 201 anomaly (§7) is a harness-snippet
  artifact, not a product question; no action unless it recurs in a
  proper suite run.
- Batch-end state: VERIFIED (Status addendum). No push (Josh's tap).
