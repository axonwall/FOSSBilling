# Findings — R5g: rate limiting (TS mirror of PHP's limiter)

Batch R5g, scope decision R5-5 at recommended defaults: the FULL 31-policy
table, DB-backed counters, dev-bypass mirror + env force flag. TS only; no
PHP source changed, no commit, no push. Survey from PHP code first, then a
PHP capture corpus, then the TS implementation, then parity40 (120/120).

## 1. The 31-policy table

Source of truth: `src/library/FOSSBilling/Security/RateLimiter.php`
`getDefaultConfig()`, lines 44–86. Defaults are merged over `config.php`
`rate_limiter` with `array_replace_recursive` semantics; an empty `policies`
array does NOT remove defaults. The reference config
(`~/scratch/fossbilling/runtime/src/config.php:93`) has
`'rate_limiter' => ['enabled' => true, 'whitelist_ips' => [], 'policies' => []]`,
so all 31 defaults are live on the reference install — but see §4: they are
bypassed in dev, which is why TS having no limiter was consistent until now.

| Policy | Limit | Window | Type | Scope / key | Enforcement point |
|---|---|---|---|---|---|
| `api_guest` | 100 | 60 s | token bucket | IP | dispatcher post-auth, guest role (`Client.php:139-164`) |
| `api_authenticated_ip` | 1000 | 1 h | token bucket | IP | dispatcher pre-auth, non-guest roles (`Client.php:165-168`, `217`) |
| `api_authenticated_account` | 1000 | 1 h | token bucket | `client:<id>` / `admin:<id>` | dispatcher post-auth, logged-in roles (`Client.php:139-164`, `229`) |
| `api_login` | 10 | 1 h | fixed window | IP | dispatcher, login methods, non-admin roles (`Client.php:141-142`); pre-auth AND post-auth both consume it for client/staff logins |
| `client_password_reset_ip` | 10 | 1 h | fixed window | IP | `guest/client/reset_password` body, silent-return |
| `client_password_reset_email` | 3 | 1 h | fixed window | email | same body, after IP consume, silent-return |
| `client_password_reset_confirm_ip` | 20 | 60 s | fixed window | IP | page controller only (`Client/Controller/Client.php:86`) — NO API equivalent, not enforced in TS |
| `client_password_reset_confirm_post_ip` | 20 | 60 s | fixed window | IP | `guest/client/update_password` body |
| `client_email_confirm_ip` | 20 | 60 s | fixed window | IP | page controller only (`Client/Controller/Client.php:49`) — NO API equivalent, not enforced in TS |
| `staff_password_reset_ip` | 5 | 1 h | fixed window | IP | `guest/staff/passwordreset` body, silent-return |
| `staff_password_reset_email` | 3 | 1 h | fixed window | email | same body, after IP consume, silent-return |
| `staff_password_reset_confirm_ip` | 20 | 60 s | fixed window | IP | page controller only — NO API equivalent, not enforced in TS |
| `staff_password_reset_confirm_post_ip` | 20 | 60 s | fixed window | IP | `guest/staff/update_password` body |
| `client_signup` | 5 | 1 h | fixed window | IP | `guest/client/create` body (`Client/Api/Guest.php:87`) |
| `client_signup_email` | 5 | 1 h | fixed window | email | same body, probe-before-create (see §6) |
| `guest_ticket_create` | 3 | 1 h | fixed window | IP | `guest/support/ticket_create` body (`Support/Api/Guest.php:39`) |
| `order_generation_ip` | 15 | 1 h | fixed window | IP | `client/cart/checkout` body |
| `domain_lookup_ip` | 60 | 1 h | fixed window | IP | `guest/servicedomain/check`, `can_be_transferred` (`Servicedomain/Api/Guest.php:82,117`) |
| `invoice_payment_ip` | 10 | 1 h | fixed window | IP | `guest/invoice/payment` body, before hash consume |
| `invoice_payment_hash` | 10 | 1 h | fixed window | hash param | same body, after IP consume |
| `invoice_pdf_ip` | 10 | 1 h | fixed window | IP | `guest/invoice/pdf` body, before hash consume |
| `invoice_pdf_hash` | 10 | 1 h | fixed window | hash param | same body, after IP consume |
| `invoice_get_ip` | 10 | 1 h | fixed window | IP | `guest/invoice/get` body (`Invoice/Api/Guest.php:37`), before hash consume |
| `invoice_get_hash` | 30 | 1 h | fixed window | hash param | same body, after IP consume |
| `cart_promo_apply_ip` | 10 | 1 h | fixed window | IP | `guest/cart/apply_promo` body |
| `client_email_verification_resend_ip` | 30 | 1 h | fixed window | IP | `client/client/resend_email_verification` body, after early return |
| `client_email_verification_resend_account` | 3 | 1 h | fixed window | `client:<id>` | same body, after IP consume |
| `client_email_resend_ip` | 30 | 1 h | fixed window | IP | `client/email/resend` body, before account consume |
| `client_email_resend_account` | 5 | 1 h | fixed window | `client:<id>` | same body, after IP consume |
| `profile_password_change_ip` | 30 | 1 h | fixed window | IP | `admin/profile/change_password` + `client/profile/change_password`, after entity fetch + password-match, before current-password verification |
| `profile_password_change_account` | 5 | 1 h | fixed window | `client:<id>` / `admin:<id>` | same bodies, after IP consume |

Enabled default for every policy: the limiter itself defaults to
`enabled: true` (`RateLimiter.php:47`); there is no per-policy enabled flag.
All 31 are enforced whenever the limiter is enabled (see §4).

TS enforcement points mirror PHP's layering: dispatcher-level policies
(`api_*`) run in the seam route
(`apps/nextjs/src/app/api/fb/[...path]/route.ts`, pre-auth before CSRF,
post-auth after the identity 201 check, before dispatcher gates);
per-endpoint policies run as a seam-level table before the handler, except
the in-handler specials below, where seam-level enforcement would give the
wrong shape:

- Silent-return reset requests (`guest/client/reset_password`,
  `guest/staff/passwordreset`): consume IP then email; when limited, return
  `true`, never 429 — PHP's enumeration-safe behavior.
- Signup-email flow (`guest/client/create`): probe `client_signup_email`
  with 0 tokens before creation; if probe-limited, take the existing-account
  path without consuming again; otherwise consume on both paths. This
  matches PHP's comment that malformed submissions must not exhaust another
  address's quota.
- Verification resend: consumes AFTER the already-approved early return.
- Profile password change: consumes AFTER entity fetch and password-match
  checks, BEFORE current-password verification.

## 2. Storage decision: PHP cache pool vs TS DB table (deliberate adaptation)

PHP backend, verified from code: a Symfony `CacheStorage` over the
`rate_limit_cache` pool (`src/di.php:274` creates the pool,
`src/di.php:285` creates the limiter; `CacheFactory.php:45`
`NAMESPACE_RATE_LIMIT = 'rate_limit'`; default adapter is `FilesystemAdapter`
under `PATH_CACHE`, i.e. `data/cache/rate_limit_*` files on the reference
install, Redis if cache config selects it). Subjects are HMAC-SHA256 hashed
(`RateLimiter.php:402-410`) with key order `info.salt` → `info.instance_id`
→ literal `'fossbilling-rate-limiter'`, over lowercased/trimmed subjects.

TS backend is a DELIBERATE ADAPTATION, not a mirror: DB-backed counters in
the shared database, table **`rate_limit_counter`**, created lazily via
`CREATE TABLE IF NOT EXISTS` on first limiter use. Never a migration
rewriting the reference schema; never a change to existing tables.

Justification: the shared DB is the only store that survives restarts and
shares across Next instances without new infrastructure; in-memory fails
both; file-backed would duplicate PHP's cache-dir coupling and need locking
the DB already provides. The table is a TS-only schema addition, listed
explicitly as an installer delta for R5j.

Schema:

```
policy TEXT NOT NULL, subject_hash TEXT NOT NULL, subject_display TEXT,
window_start_ms REAL, count INTEGER, tokens REAL, updated_ms REAL,
PRIMARY KEY (policy, subject_hash)
```

Raw subjects are stored only when the subject is an IP address
(`subject_display`); account/email/hash subjects are stored hashed-only,
matching PHP storing only hashes in cache keys. `updated_ms` is the bucket
timer for token-bucket rows and the last-consume time for fixed-window rows.
Fixed-window rows track `count`; token-bucket rows track `tokens` (`count`
stays 0 on bucket rows — the parity40 run-3 lesson: a counter assertion
that reads `count` for a bucket policy reads 0 for a bucket with 998 tokens
left). Invariant rule for suites: the table must be empty at suite end;
absent counts as empty.

## 3. Rendering decision: real 429 + Retry-After header + envelope body

PHP does NOT render limiter errors as a 200-envelope only. The scope's open
question is settled from code, in this order:

- `src/modules/Api/Controller/Client.php` `tryCall` catches every exception
  and renders it through `ApiResponseFactory`.
- `src/library/FOSSBilling/Http/ApiResponseFactory.php` `error()`
  (lines 34–48): HTTP status comes from the exception code; 429 is in the
  400–599 range and maps to itself, so PHP returns a real HTTP 429. It sets
  a `Retry-After` header in whole SECONDS, not an HTTP-date, only when the
  exception is a `RateLimitException` with a retry time. The envelope body
  carries NO retry field:
  `{result: null, error: {message: "Rate limit exceeded. Please try again later.", code: 429}}`.
- `src/library/FOSSBilling/Security/RateLimitException.php:20`: message
  exactly as above, code 429, carrying a `RateLimitResult`.
- Page-level `checkPageRateLimit` (`Client/Controller/Client.php:110`) uses
  the same pattern: 429 + `Retry-After` seconds header.

TS mirror, implemented: a `RateLimitError` is converted by the seam route to
a real HTTP 429 + `Retry-After: <seconds>` header + the same envelope body.
Every other `FbError` keeps the seam's HTTP-200 envelope convention. This is
the seam's one non-200 error shape, documented the way R5f documented the
503 gate. PHP also sends `Cache-Control`/`Expires`/Symfony headers that TS
does not set; only status + `Retry-After` + body are compared, and that
header difference is named here, not hidden.

Observed rendering equality (parity40 §1, PHP prod oracle vs TS forced):
both 429, both `Retry-After: 60`, both the exact body above, for the 101st
`api_guest` call. Capture43's full PHP rendering capture additionally
showed `Cache-Control: max-age=0, private, must-revalidate` and
`Expires: Mon, 26 Jul 1997 05:00:00 GMT` on the PHP side.

## 4. Dev bypass + force flag

PHP, from `RateLimiter.php` `isEnabled()` (lines 148–162):

- `enabled === false` in the strict boolean sense disables.
- Otherwise, `APP_ENV=dev` without `enforce_in_development === true` in the
  strict boolean sense disables. `enforce_in_development` is GLOBAL, not
  per-policy. PHP resolves unset `APP_ENV` to production.

TS adaptation, implemented and documented in code comments:

- TS development is `APP_ENV=dev` OR `APP_ENV` unset/empty. Rationale: the
  Next seam in the harness runs with no `APP_ENV` set; treating unset as
  production would throttle the dev harness, which is exactly what the
  bypass exists to prevent. Explicit `APP_ENV=prod` or `test` enforces.
- Config `enabled` and `enforce_in_development` keep PHP's strict boolean
  semantics, read from config.php `rate_limiter` via the R5a config store
  and deep-merged over defaults with `array_replace_recursive` semantics
  (objects merge per key; arrays replace wholesale).
- Force flag: **`FB_RATE_LIMIT_ENFORCE`**, parsed with the codebase's
  existing `phpNormalizeBoolean` helper: `1/true/on/yes` case-insensitive
  are truthy; default unset means not forced. It forces enforcement even
  on a dev server. Proven live: dev `:3001` status `enabled:false` and 15
  failed dev logins never 429, while forced `:3003` trips exactly at each
  boundary.

## 5. Counter semantics

Verified against vendor Symfony code in
`~/scratch/fossbilling/runtime/src/vendor/symfony/rate-limiter/Policy/` and
confirmed live in capture43/parity40:

- Fixed window: window starts at FIRST consume; timer is first-call time,
  NOT calendar-aligned. N calls pass; the (N+1)th trips (increment-then-
  check: the Nth call is accepted, the (N+1)th is rejected). Rejected
  consumes still increment the hit count as debt, carried across rolls in
  whole-window multiples. Rollover: when `now - timer > interval`,
  effective count is `max(0, count - floor(elapsed/interval) * limit)` and
  timer jumps to the rollover call time.
- Token bucket: starts FULL. Refill is WHOLESALE, not continuous:
  `floor(elapsed / interval) * limit` tokens per whole elapsed interval,
  capped at limit; timer advances by whole intervals only, so phase is
  anchored at bucket creation. Rejected consumes drive the balance negative
  as debt.
- Retry-after math: fixed-window rejected/probe uses Symfony
  `Window::calculateTimeForTokens(1, now)` with pre-add hit count;
  accepted-and-drained uses post-add hit count; token bucket uses whole
  cycles, `ceil(needed / limit) * interval`. An ordinary bucket trip
  therefore has `Retry-After` of one full interval — 60 s for `api_guest`,
  3600 s for authenticated policies — even though a token would
  conceptually refill sooner. Confirmed live in capture43, not just read
  from code.
- Zero-token probes never consume; limited iff remaining < 1.
- Failed-auth attempts DO count: PHP's pre-auth IP check runs before auth,
  and its post-auth login check runs before the login body validates
  credentials. Proven: 10 failed logins then an 11th 429 on both stacks.
- PHP whitelist check uses the REQUEST IP, not the subject, even for
  account/email subjects. TS `consume()` therefore takes a separate
  `requestIp` argument.
- PHP `listIpCounters` returns only currently-limited IP entries, sorted by
  `[ip, policy]`, with fields `policy, ip, last_seen, limit, remaining,
  limited, retry_after, retry_after_seconds`. TS `listIpCounters`
  reproduces that shape but does NOT prune counter rows, because TS
  counters must persist for window continuity; PHP prunes only its IP index.
- PHP `resetIp` returns the count of limited index entries removed, while
  still deleting all counters keyed by that IP. TS mirrors that counting
  rule. PHP `resetAll` clears the whole pool; TS deletes all counter rows
  and returns `{cleared: true}`.
- Concurrency: consumes are serialized per-process through a promise mutex
  and run inside a DB transaction, so an increment is atomic within one
  Next instance. Documented limitation: two Next instances sharing one DB
  can race a single increment under exact simultaneity. Parity runs are
  sequential, so this cannot affect them.
- Fail-closed by design: a limiter DB error surfaces as an envelope error
  rather than silently disabling enforcement. This is a stated decision,
  not an oversight.
- Proxied-to-PHP calls are NOT counted by TS; PHP enforces on its own side.
  The `__prime` probe is not an API call and is not limited.

## 6. Coverage table: tripped live vs counter-proven

### Tripped live end-to-end on PHP (capture43, prod oracle :8081)

- `api_guest`: 100 pass, 101st 429, `Retry-After: 60`.
- `api_login`: 10 pass, 11th 429, `Retry-After: 3593` in the capture run.
- `client_password_reset_confirm_post_ip`: 20 pass, 21st 429,
  `Retry-After: 55`; passes again after the first-call window edge.
- Admin surfaces: `get_list` returned exactly 1 entry for the tripped
  `api_guest` counter (limit 100, remaining 0, limited true,
  `retry_after_seconds: 60`); `reset_ip` returned `removed: 1`.

### Tripped live end-to-end on TS forced (parity40, :3003)

- `api_guest` (rendering equality vs PHP, §1 + §3), `api_login`,
  `client_signup`, `guest_ticket_create`, `domain_lookup_ip`,
  `cart_promo_apply_ip`, invoice `get`/`payment`/`pdf` IP policies,
  `order_generation_ip`, both confirm-post policies,
  `profile_password_change_account` (+ IP passthrough to 31),
  `client_email_resend_account` (+ IP passthrough to 31),
  `client_email_verification_resend_account` (+ IP passthrough to 31).
- Silent-request boundaries by counter row + `get_list` limited entry
  (endpoints return `true`, never 429): `client_password_reset_ip` row 11
  / email row 10 (11th call short-circuits before the email consume);
  `staff_password_reset_ip` row 6 / email row 5 (same short-circuit).
- Signup-email probe gating: 6 existing-client creates across 6 distinct
  XFF IPs all return `true`; `client_signup_email` row stays 5 because the
  probe-limited 6th call does not consume (spreading probes across IPs
  must not help hammer one address, per PHP's comment).
- Window semantics: confirm-post trips at 21, `api_guest` trips at 101,
  immediate bucket retry still 429 (wholesale refill), both pass after the
  shared ~62 s wait past the first-call window edges — fixed window, not
  sliding; bucket refill, not continuous.
- Scope isolation: XFF IP trips on the 11th `api_login` call while loopback
  still returns 401; tripped admin profile policy does not block a client
  profile change (user isolation); tripped promo policy does not block a
  domain check (endpoint isolation).
- Dev bypass: dev `:3001` never trips (15 failed logins, hammer with no
  counters). Force flag: forced `:3003` trips exactly at each boundary.
- Persistence: `api_login` tripped, forced server restarted, next failed
  login still 429 — DB-backed counters survive restart.
- Failed-auth counting: 10 failed logins pass with credential errors, 11th
  429, on both stacks.

### Counter-proven by design, not live-tripped

- `api_authenticated_ip` and `api_authenticated_account` (1000 each):
  after reset + 5 admin status calls, both token-bucket rows read 995
  tokens. PHP consumes BOTH for an authenticated call (pre-auth IP subject
  + post-auth account subject, `Client.php:165-168,229`). 1000 live calls
  are impractical; row arithmetic + config value is the sound proof, and
  the shared `consume()` path is already proven by the 429 policies.
- `invoice_payment_hash`, `invoice_pdf_hash`, `invoice_get_hash`: shadowed
  by their IP policies because PHP consumes IP first; the hash counter
  stalls at the IP limit (observed: IP row 11 with debt, hash row 10) and
  cannot reach its own trip on either stack. This is a PHP-behavior
  finding, not a TS defect.
- `client_signup_email`, `client_password_reset_email`,
  `staff_password_reset_email`: email subjects have no admin list surface
  and their endpoints return `true` silently when limited, so the boundary
  is proven by counter rows plus the shared `consume()` path.
- `client_password_reset_ip` and `staff_password_reset_ip` boundaries are
  proven by counter rows plus `get_list` limited entries, since their
  endpoints also return `true` silently.

### Not enforced in TS, by PHP's own layering

- `client_password_reset_confirm_ip`, `staff_password_reset_confirm_ip`,
  `client_email_confirm_ip`: page-controller checks with no API equivalent
  (`Client/Controller/Client.php:49,86`,
  `Staff/Controller/Admin.php:119`). Their API post variants ARE enforced.
  This is a scope boundary, not a gap: the seam serves API calls, and
  these policies never fire on an API call in PHP.

## 7. Divergences found (pinned, not hidden)

1. **TS seam-before-validation order.** TS per-endpoint consumes precede
   handler validation, while a few PHP bodies validate first — support
   ticket content length and profile password-match are the named cases.
   A call that is both invalid and limited gets 429 from TS but the
   validation error from PHP. Parity40's ticket section uses this order
   deliberately (short content trips on the 4th call); PHP would not trip
   on short content. Precedence-only; the boundary itself matches.
2. **TS CSRF precedes the GUEST post-auth check**, while PHP's guest-auth
   CSRF follows it. A CSRF-invalid guest call consumes in PHP but not in
   TS. Precedence-only.
3. **Hash shadowing** (§6): invoice hash policies can never trip while
   their IP policy trips first, on either stack. PHP behavior, mirrored.
4. **XFF IP sourcing.** TS IP extraction from `X-Forwarded-For` is
   pre-existing seam behavior inherited by the limiter. PHP's IP is
   `REMOTE_ADDR` unless trusted proxies are configured, so XFF-based
   isolation is a TS-subject property, not PHP-equal IP sourcing.
5. **Unset-`APP_ENV` adaptation** (§4): TS treats unset/empty `APP_ENV` as
   development; PHP treats it as production. Deliberate: the Next seam in
   the harness runs with no `APP_ENV` set, and treating unset as production
   would throttle the dev harness.
6. **TS storage adaptation** (§2): DB table instead of PHP's cache pool.
7. **TS `listIpCounters` does not prune rows** (§5): PHP prunes only its IP
   index; TS must keep rows for window continuity.
8. **PHP login creates a cart row.** Observed during parity40 debugging: a
   PHP client login alone adds a `cart` row for the new session; checkout
   adds nothing further. This is pre-existing PHP behavior, not R5g, but
   parity40 snapshots cart state before any login and restores it in
   finally so login-created rows do not leak into later suites.

## 8. R5g / R5h boundary (exact)

R5h antispam — blocked-IP / honeypot / captcha / SFS / temp-email — is a
SEPARATE enforcement layer and is NOT conflated with rate limiting. R5g
changes nothing about antispam config or behavior. R5g also does not touch
the R5f guest 60 s cron throttle, which is a separate mechanism, not the
rate limiter. The R5g admin surfaces (`rate_limit_status`,
`rate_limit_get_list`, `rate_limit_reset_ip`, `rate_limit_reset_all`) are
real now, reading DB counters instead of reporting disabled state.

## 9. Files changed (TS only, uncommitted)

- NEW `apps/nextjs/src/server/ratelimit.ts`: 31-policy defaults, config
  deep merge, dev/force logic, HMAC subject hashing, CIDR + exact IP
  whitelist, fixed-window and token-bucket engines, `consume` /
  `consumeOrThrow`, `listIpCounters`, `resetIp`, `resetAll`, counter
  introspection helpers, seam enforcement helpers.
- `apps/nextjs/src/app/api/fb/[...path]/route.ts`: pre-auth before CSRF,
  identity 201 check, post-auth before full gates, per-endpoint before
  handler, `RateLimitError` → real 429 + `Retry-After` + envelope body.
  Regression fix during this batch (see §10): the identity 201 check was
  first hoisted above the removed-endpoint exemption, breaking
  parity32/parity30 logged-out removed-endpoint expectations (201 instead
  of the 9999 removal error). Fixed in code, not by updating assertions:
  `isRemoved` is now computed first and the identity/post-auth/gates/
  per-endpoint steps are skipped for removed endpoints, while pre-auth +
  CSRF still run (pre-R5g behavior; PHP itself consumes pre-auth before
  its session-auth 201).
- `apps/nextjs/src/server/modules/security.ts`: the four admin rate-limit
  endpoints are real now.
- `apps/nextjs/src/server/modules/client.ts`: signup-email probe/consume
  flow; silent client reset-password limits; verification-resend consumes
  after the approved early return.
- `apps/nextjs/src/server/modules/staff.ts`: silent staff reset-password
  limits.
- `apps/nextjs/src/server/modules/profile.ts`: admin and client
  change-password consumes.
- `apps/nextjs/src/server/modules/invoice.ts`: comment-only updates noting
  per-endpoint limits live in the seam's R5g table.
- `docs/nextjs-strangler/phase5/capture43.py` + `captures43/` (10 JSON
  files): PHP limiter behavior observed on the prod oracle.
- `docs/nextjs-strangler/phase5/parity40.py`: 120/120 green (log
  `~/scratch/fossbilling/r5-logs/parity40d.log`). Harness lessons from
  runs 1–3, all fixed in the script, not by weakening assertions:
  never share a cookie jar between PHP and TS (a stray PHP session cookie
  403s TS guest calls before the limiter runs); `expect_trip` rejects 403
  pre-trip calls loudly; signup-email probe uses distinct XFF IPs because
  the 5-limit signup IP budget would otherwise trip before the handler
  probes; authenticated-policy assertions read `tokens`, not `count`;
  finally kills `:3003`/`:8081` by port in a retry loop.
- This file, `docs/nextjs-strangler/phase5/findings-r5g.md`.

## 10. Regression results (final, after the route fix + rebuild)

- tsc + build: clean (tsc exit 0, `npm run build` exit 0), re-run after
  the route fix.
- parity40: 120/120, re-run on the fixed build (log
  `~/scratch/fossbilling/r5-logs/parity40e.log`), no FAIL/WARNING lines.
- parity39: 212/212. parity38: 86/86 (with the `:8081` oracle started
  externally, killed before fixtures).
- parity37: green (invariants + config hash OK). parity36: 51/51.
  parity35: 210/210. parity34: 164/164. parity33: 77/77.
- parity32: first run 65 checks, 3 failures — all `removed-loggedout-*`
  cases returning 201 instead of the 9999 removal error, caused by the
  R5g route change hoisting the identity 201 above the removed-endpoint
  exemption (see §9). Fixed in code; re-run 65/65, ALL GREEN. No old
  assertion was updated.
- parity31: 63/63.
- parity30: first run 179 checks, 1 failure — the same
  `removed_loggedout` cause. Fixed in code; re-run 179/179, ALL GREEN.
- parity29: 62/62. parity28: 128/128. parity27: 27/27. parity26: 62/62.
  parity25: 203/203.
- parity21: exactly the known 9 diffs, 194/203
  (`sd_tld_delete`, `sd_tld_delete_used`, `sd_tld_delete_notfound`,
  `sd_reg_available`, `sd_guest_tlds`, `sd_guest_tlds_reg`,
  `sd_guest_tlds_trans`, `sh_guest_free_tlds_fallback`,
  `dl_admin_send_file_missing_stored`).
- Fixtures: 13/13 on php (verified in `results-php.json`) and 13/13 on
  next (verified in `results-next.json`).
- Invariants clean before and after (invoice 323, client_order 11,
  email_queue 67, service_custom 17, extension 6, extension_meta 3,
  setting 38, admin 2, currency 1, client 3, support_ticket 2, tld 1,
  activity_client_email 0, invoice_event 776, client_order_meta 0;
  cart 283, cart seq 305; `last_cron_exec` absent;
  `invoice_overdue_invoked` = 2026-10-24 05:31:25); config hash
  `6e3c529673` unchanged; `rate_limit_counter` empty at end.
- End state: reference Next `:3001` (TZ=UTC) answering (`{"primed":
  true}`) on the fixed build; PHP dev `:8080` answering; `:8081`,
  `:18025`, `:3003` all down. No commit, no push, no PHP source change,
  no `~/MEMORY.md` change.

## 11. Left for later (with what would verify it)

- The three page-only policies (`*_confirm_ip` without `_post_`) remain
  unenforced in TS because the seam serves API calls, not pages. A future
  page-rendering batch would need page-level hooks; verify by tripping the
  page controllers on PHP and comparing.
- The 1000-limit authenticated policies are counter-proven, not live-
  tripped. Tripping them live would need 1001 authenticated calls on a
  disposable server with a lowered config limit — but lowering the limit
  changes the policy under test, so the honest proof remains row
  arithmetic + the shared consume path.
- Multi-instance counter races (exact-simultaneity increments across two
  Next instances sharing one DB) are a documented limitation; verifying
  would need a concurrent-load harness against two forced servers.
- The TS counter table is a TS-only schema addition: R5j must list
  `rate_limit_counter` as an installer delta (creation is lazy via
  `CREATE TABLE IF NOT EXISTS`, so no migration is needed for existing
  installs, but fresh installs should include it in their schema).
