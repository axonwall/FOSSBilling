# R6a findings — seam cutover (proxy removal + UI repointing)

Batch: R6a of the approved R6 scope (D6-1..D6-10, `r6-scope.md`).
Branch: `feat/nextjs-phase5-r1` (stacked on R5j `a8cc1d0`). No commit
yet — the parent commits `r6-scope.md` + R6a together after independent
re-verification. No PHP source modified. `~/MEMORY.md` untouched.

## 1. What changed (TS only)

- **New `apps/nextjs/src/server/seam-call.ts`** — the full TS pipeline
  factored out of the route, in the route's exact order: pre-auth
  limiter → CSRF → removed-endpoint hoist → identity 201 → post-auth
  limiter → dispatcher gates (715/725/403) → per-endpoint limiter →
  handler (or servicecustom magic, or 740/9998). Used by both the HTTP
  route and `lib/fossbilling.ts` fbCall, so the two entry points
  cannot drift apart. Handler cookies (`setCookies`) are appended by
  seam-call; the route no longer appends them (no double-append).
- **Rewritten `apps/nextjs/src/app/api/fb/[...path]/route.ts`** — no
  `fetchPhp`, no `phpBaseUrl`, no `forwardCookies`, no `sortKeys`, no
  FB_PARITY block, no DB-error fallthrough. Flow: exact 1-segment
  `__prime` → TS-native prime; 3 segments + valid role → body parsing
  (unchanged) → session → `dispatchSeamCall` (RateLimitError → real
  429 as before, everything else → `errorEnvelope`, INCLUDING
  DB-not-configured errors); anything else → HTTP-200 envelope 879
  `Unknown API call <path>`. The `tsModulesEnabled()` gate is DROPPED:
  the registered-handler set is exactly the 35 FB_TS_MODULES names
  (measured), so the gate was behavior-preserving on the reference and
  its gradual-enable lever retires at cutover. `tsModulesEnabled()`
  itself is now uncalled (still exported from `modules/index.ts`) —
  dead-code cleanup candidate, left in place deliberately (it reads
  the FB_TS_MODULES env flag; the brief forbids removing env-flag
  readers beyond FB_PARITY).
- **New `apps/nextjs/src/server/public-url.ts`** — `publicOrigin()`:
  FB_PUBLIC_URL (trimmed, slashes stripped) if set/non-empty, else
  SYSTEM_URL semantics from config (force_https default true via
  `phpNormalizeBoolean`, config `url` schemes stripped; no
  request-isSecure term — R5i webserver precedent, since URL
  construction runs in request-less contexts too). Throws a clear
  FbError naming FB_PUBLIC_URL if neither exists. Returns the origin
  WITHOUT a trailing slash; callers add `/` or paths as before.
- **`lib/fossbilling.ts` fbCall → in-process dispatch (D6-7).** Builds
  the CallContext (session via `readSession(cookieHeader)`, ip
  `127.0.0.1`, requestUri `/api/<role>/<module>/<method>`, stringified
  params + empty rawParams — the old urlencoded wire shape) and
  unwraps the envelope. `adminBasicAuth` now THROWS (TS seam is
  session-cookie auth only; zero callers, verified by grep — fail
  loudly, don't silently ignore). The `method` option is accepted and
  ignored (handlers never branch on the verb). Non-JSON handler
  responses throw (pages never call binary handlers). The stale doc
  comment (PHP dispatcher + Basic-auth synthetic sessions) is
  rewritten.
- **FOSSBILLING_URL deleted everywhere in `apps/nextjs/src`** (grep:
  zero hits outside intentional doc comments). All 11 URL sites now
  use `publicOrigin()` (see §5). `apps/nextjs/README.md` updated
  (proxy → seam wording, FB_PARITY removal, run block, `__prime`
  bullet, `/login` bullet, `/invoices/[hash]/pdf` bullet — the last
  was stale since Phase 4, fixed while touching the file).
- **Two product fixes the cutover exposed (in-scope: without them the
  PHP-down proofs fail, so they are R6a blockers, not scope creep):**
  1. `server/session.ts` `loginAsAdmin`: see §7.1.
  2. `server/emailer.ts` `companyContext`: see §7.2.
- **Incidental catch:** `server/twig.ts` `|url` filter fallback was a
  hardcoded `http://127.0.0.1:8080/` (not a FOSSBILLING_URL read, so
  the §5 grep list missed it). Now `publicOrigin() + "/"` — identical
  on the reference with FB_PUBLIC_URL unset, Next origin when set.

## 2. PHP Dispatcher survey (the truth for §3)

Source: `src/library/FOSSBilling/Api/Dispatcher.php`
`dispatchWithArguments`, read in full, plus live captures (capture47).

Resolution order (HTTP-reachable shapes only):

1. Method must contain `_` else 710 — UNREACHABLE via HTTP: the API
   controller always prefixes `class_` (`Client.php` get/post_method),
   so dispatch sees `invoice_foo` for a bare `foo` and 740s on `foo`
   (message strips the prefix — capture47 B4).
2. Role from identity; `mod` = first `_`-segment lowercased,
   `methodName` = remainder joined. Empty mod → 714
   (`Invalid module name`) — unreachable via the 3-segment seam (the
   route lowercases non-empty segments; an empty segment can't arrive
   as a path segment).
3. Extension-active check → 715
   (`FOSSBilling module <mod> is not installed/activated`).
4. Admin permission check → 725
   (`You do not have access to the <mod> module`) — skipped only for
   finalization-allowed admin calls.
5. Api class existence → 740 (`<Type> API call <method> does not exist
   in module <module>`, `<Type>` = ucfirst(role) → Admin/Client/Guest,
   `<method>` = methodName WITHOUT the module prefix, `<module>` =
   lowercased mod).
6. Api class must be AbstractApi → 730 (unreachable: all shipped Api
   classes extend it).
7. Method exists/callable else `__call` check → same 740.
8. RequiredParams validation → InformationException (9999-class).
9. Call the method (method-body permission checks, e.g.
   `checkPermissions`, run AFTER RequiredParams — see §7.3).

Around dispatch, `_apiCall` runs session/token auth + rate-limit +
CSRF + finalization gate (503) BEFORE dispatch. Guest callers get
non-`FOSSBilling\Exception` internal errors sanitized to generic
`An unexpected error occurred...` (`sanitizeGuestError`).

### Precedence table (TS 740 fires exactly here)

| Caller / target | PHP | TS (parity44 §1) |
|---|---|---|
| Unknown method, known active module, authorized | 740 | 740 (per role: Admin/Client/Guest message shapes) |
| Unknown module (`nosuchmod`) | 715 | 715 (activation precedes method existence) |
| Inactive module (`embed`: in `src/modules`, not CORE, no extension row) | 715 | 715 |
| Removed endpoint (route-hoisted: admin/system/update_available, admin/extension/install, admin/theme/select, guest/extension/languages) | PHP implements it (9999 shapes recorded, not compared) | Removal error (hoist precedes 740 AND precedes identity/gates, as before) |
| guest/system/template_exists (handler-only exception, NOT hoisted) | `false` result | Removal error (gates run first, then the removal handler — the R1/R4a/R4c exception is preserved, NOT "fixed") |
| Literal `admin/servicecustom/__call` | 9998 ArgumentCountError (message embeds the deployment's runtime path) | 9998, message WITHOUT the path (`...__call(), 1 passed and exactly 2 expected`) — asserted by substring, not exact equality |
| Unknown servicecustom method (magic fallback) | Handler runs → 9999 `Order ID is required` | Same (magic only for admin/servicecustom, method ≠ `__call`) |
| Client session on admin call | 201 | 201 (identity precedes 740) |
| Anonymous admin call | 201 | 201 |
| Restricted staff (support-only group) on invoice unknown | 725 | 725 (module access precedes 740) |
| Restricted staff on support unknown | 740 (gates pass: support.access true, no guard entry for unknown methods) | 740 |
| Restricted staff on known guarded method (support/canned_create, WITH params) | 403 `You need the "support.manage_canned" permission...` | 403, identical message (see §7.3 for the missing-params ordering divergence) |
| Non-3-segment path / invalid role (`/api/admin/invoice`, `/api/admin/invoice/get_list/extra`, `/api/unknown`, `/api/root/invoice/get_list`) | Router 879 `Unknown API call <path>` (HTTP 400) | 879, same message, HTTP-200 envelope (seam convention) |
| Zero-segment `/api/fb` | Next `[...path]` routing 404 (never reaches the handler) | Same (documented, no code) |

HTTP-status divergences are seam-convention only: PHP renders 740
as 404, 201 as 401, 879 as 400; TS keeps HTTP-200 envelopes except
the R5g real 429. Compare envelopes, never status.

## 3. `__prime` survey + TS-native design

- **Old prime:** `GET /api/fb/__prime` fetched PHP `/login` and
  relayed its cookies. PHP `/login` (capture47 §A, live): 200 with
  `fossbilling_session=<32-hex>; path=/; HttpOnly; SameSite=Strict`
  and `fossbilling_csrf=<64-hex>; path=/; samesite=strict`.
- **Fixture runner need** (`run-fixtures.py:211`): prime, then login
  presenting the primed csrf token. **Browser need**
  (`ensureCsrf()`): when no csrf cookie exists, fetch `__prime`;
  the cookie must be browser-readable (no HttpOnly) so JS can send
  it as `CSRFToken`/header on the next POST.
- **PHP login REQUIRES priming (empirical, capture47):** an unprimed
  login POST 403s even on a fresh jar, because PHP auto-creates a
  session for the request and then enforces its token. Working
  pattern: GET `/login` first, then POST with that token. TS login
  does NOT need priming (no session → CSRF passes) — but priming is
  harmless there and keeps the helper identical for both stacks.
- **TS-native prime:** reads the session from the request cookie
  header (no DB touch when no session cookie is presented); token =
  session's csrfToken when a session resolves (so subsequent POSTs
  pass `enforceCsrf`), else fresh `randomBytes(16).hex` (matching TS
  login's token format; PHP's were 32-byte hex). Sets ONLY
  `fossbilling_csrf=<token>; Path=/` (flags mirror TS login's csrf
  cookie exactly — readable by JS, no SameSite attr; this
  deliberately differs from PHP's `samesite=strict`, following
  pre-existing TS login behavior). Creates NO session row and sets
  NO session cookie — priming is CSRF-only by design, unlike PHP's
  relay which minted an anonymous session. Body `{primed: true}`
  always (no PHP to fail). Edge: DB down + session cookie presented
  → readSession throws → 9999 envelope (documented, acceptable).
- **Proven in parity44 §2 (PHP down):** prime sets a 32-hex csrf
  cookie and no session cookie; the cookie has no HttpOnly and
  `Path=/`; a primed admin login succeeds and the following
  authenticated call works; the browser pattern
  (prime → login → POST) works. `:8080` restarted + verified 200 in
  finally.

## 4. fbCall caller split (D6-7)

Measured by grep (all importers of `lib/fossbilling.ts`, none with
`"use client"`): ALL callers are server-component pages — admin
clients/invoices/orders/tickets/products/services/staff/system/
extensions pages, client invoices/orders/dashboard/support pages, and
the client landing page. NO client-component callers. Pages pass auth
via `sessionOpts()` (`lib/session.ts`): the request's cookie jar as
`cookieHeader` + the `fossbilling_csrf` cookie value as `csrfToken` —
exactly what in-process CSRF enforcement needs. Browser-side
`fbPost`/`fbPostJson` (`lib/browser.ts`) already go through
same-origin `/api/fb` and are unaffected except that `__prime` is now
TS-native (their stale "PHP dispatcher"/"proxy" doc comments updated).
`adminBasicAuth` has ZERO callers outside `lib/fossbilling.ts` itself
— it now throws instead of silently degrading.

## 5. FOSSBILLING_URL site inventory + PHP counterparts

Exhaustive grep over `apps/nextjs/src` + `scripts` + docs/config in
`apps/nextjs` (pre-change). Every site now uses `publicOrigin()`:

| Site | Constructs | PHP counterpart | TS shape post-R6a |
|---|---|---|---|
| route.ts `phpBaseUrl` | proxy target | — (the proxy itself) | DELETED |
| lib/fossbilling.ts `phpBaseUrl` | API base | — (transport) | Repointed to in-process dispatch |
| email.ts:722 `__baseUrl` | email-template base | SYSTEM_URL (slashed) | `publicOrigin() + "/"` |
| emailer.ts:83 `www` (companyContext) | email-context company www | SYSTEM_URL (slashed) | `publicOrigin() + "/"` (was bare origin — §7.2 fix) |
| emailer.ts:109 `__baseUrl` | email-template base | SYSTEM_URL (slashed) | `publicOrigin() + "/"` |
| extension.ts:108 `origin` (manifestEntry icon_url) | `{origin}//modules/{dir}/{iconUrl}` — double slash IS PHP's shape | SYSTEM_URL + `//modules/...` | Same shape, origin swapped (parity44 asserts the double slash) |
| extension.ts:616 `base` (buildAdminNavigation) | `{base}/admin/{path}` | SYSTEM_URL + `/admin/...` | Same shape, origin swapped |
| extension.ts:400 comment | (doc) | — | Updated to FB_PUBLIC_URL / config url |
| invoice.ts:1399 `www` (gatewayRowToApiArray) | gateway `callback` = `{www}ipn.php?gateway_id={id}` | SYSTEM_URL + `ipn.php?...` | Same shape, origin swapped |
| massmailer.ts:191 `__baseUrl` | massmailer-template base | SYSTEM_URL (slashed) | `publicOrigin() + "/"` |
| order.ts:511 `__baseUrl` | order-email-template base | SYSTEM_URL (slashed) | `publicOrigin() + "/"` |
| seo.ts:22 `phpBase` (sitemap_url) | `{base}/sitemap.xml` | SYSTEM_URL + `/sitemap.xml` | Renamed `publicBase`, same shape (mod_seo inactive on reference → code-only; get_info 715s on both stacks) |
| system.ts:56 `systemUrl` | company `www` + logo/favicon URLs | SYSTEM_URL + `/` / paths | `publicOrigin() + "/"` etc. |
| payment-adapters.ts:191 `systemBase`/`toolsUrl`/`link` | gateway return/cancel/notify/redirect/continue_shopping/thankyou/invoice URLs | SYSTEM_URL-based | Same shapes, origin swapped (gateway_get `callback` is the assertable representative) |
| twig.ts:242 `\|url` fallback | filter base when ctx lacks `__baseUrl` | SYSTEM_URL | `publicOrigin() + "/"` (was hardcoded `:8080/` — §1 incidental catch) |
| (client)/page.tsx:44 | user-facing hint string only | — | Reworded (no PHP to start) |

PHP's SYSTEM_URL (`src/load.php:365`): scheme from config
`security.force_https` (default TRUE) OR request isSecure, + config
`url` schemes-stripped, NOT slash-normalized. Reference config:
`url='127.0.0.1:8080/'`, `force_https=false` → `http://127.0.0.1:8080/`
under the dev server (note: under a secure request PHP would say
`https://` — TS drops the request term by design, R5i precedent).

**FB_PUBLIC_URL semantics (decided in-batch, parity44 §5 pins both):**
- SET (e.g. `http://127.0.0.1:3011`): every site names that origin.
  Proven on a separate :3011 instance: company www, nav links,
  gateway callback, extension icon_urls, AND the email probe (mock
  SMTP:18025 + enabled custom template rendering
  `{{ guest.system_company.www}}|{{ __baseUrl}}` → MIME carries the
  :3011 origin twice, zero `:8080`).
- UNSET: SYSTEM_URL fallback from config → `:8080` URLs on the
  reference. This is PHP-faithful, NOT "points at Next": the
  deployment story is "set FB_PUBLIC_URL to the Next origin" (or
  update config `url` to the same value). Documented, not papered
  over.
- If neither FB_PUBLIC_URL nor a config url exists: loud FbError
  naming FB_PUBLIC_URL (a real install always has a config url —
  the R5j installer requires --url).

**Harness decision:** parity suites + fixture runner KEEP passing
FOSSBILLING_URL (harmless dead var now that the Next server ignores
it; zero suite churn). The reference :3001 in this batch was started
WITHOUT FOSSBILLING_URL to prove the server no longer needs it.
Parity44's set-case instance passes FB_PUBLIC_URL instead.

## 6. FB_PARITY disposition

REMOVED entirely, not left as a no-op (dead code invites confusion).
The route's FB_PARITY=1 block (old route.ts:200–214) deep-compared
sorted PHP vs TS envelopes into `[parity]` logs; it dies with PHP
deletion, and parity suites + R6b's harness supersede its logging
value. Proof in parity44 §6: zero `process.env.FB_PARITY` readers
remain in `apps/nextjs/src`, and a :3011 instance started WITH
FB_PARITY=1 serves TS calls cleanly with PHP DOWN (a surviving PHP
comparison call would fail there). No other env-flag readers were
removed.

## 7. Deviations / fixes / findings from the run

### 7.1 FIXED (R6a blocker): TS staff login issued a csrf-less session

`server/session.ts` `loginAsAdmin` kept the old token if a session
existed, but for a fresh login stored NO `csrf_token` in the session
row and set NO `fossbilling_csrf` cookie — unlike
`loginClientSession`, which carries-or-generates the token and sets
both cookies. Consequence: every authenticated call from a
TS-logged-in staff session failed `enforceCsrf` with 403 (the
primed cookie value never equals the session's missing token).
Masked until now because every suite and browser flow logged in via
PHP, whose sessions always carry `csrf_token`. With the proxy
deleted, TS staff login must yield a working session on its own.
Fix mirrors client login exactly: token = old token ?? fresh
`randomBytes(16).hex`, stored in attrs, both cookies set. Parity44
§1–§5 (all TS-logged-in admin flows) prove it. Adjacent gap, NOT
fixed here (out of scope, needs its own probe): `ensureSession`
(cart.ts only) also creates sessions without a `csrf_token` — an
anonymous-cart-then-authenticated-call flow may hit the same 403;
the loginAsAdmin fix is the pattern if a probe confirms it.

### 7.2 FIXED: email-context company www missed its trailing slash

`server/emailer.ts` `companyContext().www` was the bare
`publicOrigin()` (unslashed), while PHP's email-context www is
SYSTEM_URL verbatim (slashed on the reference) and the API's company
www is slashed on both stacks. The parity44 email probe caught it:
MIME rendered `http://127.0.0.1:3011|http://127.0.0.1:3011/` (www
unslashed, `__baseUrl` slashed). Fixed to `publicOrigin() + "/"`;
probe now renders the origin twice, slashed, zero `:8080`.

### 7.3 PRE-EXISTING divergence (documented, NOT fixed — out of scope)

Method-guard vs RequiredParams order: PHP validates RequiredParams
in the Dispatcher BEFORE calling the method, so a restricted caller
with missing params gets 9999 (e.g. canned_create without title →
`Canned reply title is missing`), never reaching the method-body
`checkPermissions`. TS enforces method guards BEFORE the handler's
param validation, so the same call gets 403. With VALID params both
stacks agree exactly (403 + identical
`You need the "support.manage_canned" permission...` message —
parity44 §1 proves it). Fixing the order would mean moving TS param
validation ahead of guards (a seam-behavior change, not R6a's
brief); recorded here for a follow-up batch.

### 7.4 Other deviations (all deliberate, all pinned by parity44)

- Proxy-unreachable 500 is gone: there is no proxy left, so no
  "proxy target down" shape exists at all.
- DB-not-configured: was silent PHP fallback (served PHP data); now
  a loud HTTP-200 envelope 9999 (`FB_DATABASE_PATH is not set...`).
- 740/879 HTTP statuses: PHP 404/400 → TS 200 envelopes (seam
  convention; envelopes identical).
- 9998 message: PHP's embeds the deployment runtime path; TS omits
  it (a path leak TS has no reason to reproduce).
- Prime: csrf-only, no session row (PHP's relay minted an anonymous
  session); token 16-byte hex (PHP's 32-byte); no SameSite attr
  (PHP's `samesite=strict`) — all follow pre-existing TS login
  behavior, not PHP.
- FB_TS_MODULES gate dropped (see §1); helper left as dead code.
- `guest/system/version` is NOT an endpoint (no `version` method in
  System Guest.php, not in the catalog) — both stacks 740 it. An
  early parity44 draft wrongly expected a version string; corrected
  to a negative control.

### 7.5 FIXED after the first regression chain (same R6a batch)

The first full chain run exposed three more cutover breaks. All three
are seam-entry/dispatch behavior the cutover requires (not handler
logic), and all are verified by the re-run set below:

1. **Mixed-case handler keys 740'd (parity21 16 diffs, not 9).**
   TS registers servicehosting/servicelicense `_getService`
   (capital S, 4 registrations: admin+client × 2 modules), but the
   seam route lowercases path segments before lookup, so the lookup
   missed and 740'd. Pre-R6a the proxy silently served these (PHP's
   method lookup is case-insensitive). Fix: `dispatch.ts`
   `register()` normalizes role/module/method to lowercase —
   matching PHP semantics; no two handlers differ only by case (PHP
   couldn't distinguish them either). These 4 are the ONLY
   mixed-case registrations in the tree (measured by grep).
   Servicedomain's `_getService` is `protected` in PHP (not
   dispatcher-callable → PHP 740s too; TS has no registration →
   consistent, no action). Parity21 is back to exactly the known 9
   diffs (194/203).
2. **Guest-cart flows 403'd (fixtures-next 10/13).** The TS-native
   prime is csrf-only by design, but `ensureSession` (cart.ts's
   session minting) created sessions with NO `csrf_token` and set no
   csrf cookie — so the first cart call minted a token-less session
   and every later call on that jar failed `enforceCsrf`. Pre-R6a
   the old prime relayed a PHP `/login` session (which always
   carries `csrf_token`), masking the hole. Fix: `ensureSession`
   now mints a token, stores it, and sets the matching cookie (same
   invariant as both login paths). Fixtures-next is back to 13/13.
   The three session-creating paths are now all token-issuing:
   `loginAsAdmin` (§7.1), `loginClientSession` (already was),
   `ensureSession` (this fix).
3. **Three stale suite assertions, updated with evidence (no product
   change):** parity33 §B compared literal-`__call` envelopes
   exactly — obsolete now that TS no longer proxies `__call` to PHP
   (differs by exactly PHP's deployment path; now code + substring,
   as in parity44 §1). parity43 A2 and parity41's `BASE_INV` pinned
   `cart_seq == 305` exactly — the R5j value; the sequence is a
   high-water mark (DELETE never rewinds it), advanced to 316 by the
   chain's own cleaned login rows, while the count holds at 283.
   Both now assert a `>= 305` floor (parity41 additionally asserts
   the after-value equals its restored start value).

### 7.6 Pre-existing divergence, unchanged (for completeness)

The R5d deployment question (does production Next keep `TZ=UTC`?)
and the R6 scope §6 execution details are untouched by this batch.

## 8. Coverage table

| Area | PHP-observed | TS-proven (parity44) | Code-only |
|---|---|---|---|
| 740 per role + bare-method strip | capture47 B1/B4/B10/B11 + §1 oracle | §1 (12 checks) | — |
| 715 unknown/inactive module | capture47 B2/B3 + §1 oracle | §1 | — |
| 725/201 precedence | capture47 B12 + §1 oracle | §1 | — |
| 403 guard (valid params) | §1 oracle | §1 | Missing-params order (§7.3) |
| Removal preempts 740 (4 hoisted + template_exists) | PHP shapes recorded (PHP implements them) | §1 TS assertions | — |
| Literal `__call` 9998 | capture47 B8 + §1 oracle | §1 (code + substring) | — |
| Magic servicecustom fallback | capture47 B9 + §1 oracle | §1 | — |
| 879 non-3-segment/invalid-role | capture47 §C + ad-hoc root probe | §1 (4 paths) | Zero-segment Next 404 |
| `__prime` cookies | capture47 §A | §2 (PHP down) | DB-down prime → 9999 edge |
| PHP-down TS subset | — (oracle down by design) | §3 (10 checks) | — |
| Page smoke PHP down | capture47 §E baselines | §4 (4 pages, tag-stripped markers) | — |
| URL repointing set + unset | capture47 §D (PHP :8080 shapes) | §5 (both cases + email MIME) | seo sitemap_url (mod_seo inactive → 715 both) |
| FB_PARITY removal | — | §6 (grep + PHP-down probe) | — |
| DB-not-configured loud 9999 | code read (`db.ts` throws plain Error → 9999) | — | Not live-probed (would need a DB-less instance; the code path is the old fallthrough's trigger, now routed to `errorEnvelope`) |

## 9. R6a/R6b boundary + what is left

- Untouched by R6a, per scope: no handler behavior changes (except
  the §7/§7.5 seam-entry blockers, which repair dispatch/login/cart
  behavior the cutover requires); accounting holds at 548+31+0
  (verified — any move would have been a finding); no PHP-tree
  deletion (R6c); no shadow harness (R6b); no frozen-oracle/golden
  changes — parity suites still compare against the :8080 oracle
  exactly as before (D6-1 through R6c).
- Final regression state (after the §7.5 fixes): parity44 77/77;
  parity43 16/16; parity42 73/73; parity41 130/130; parity40 120/120;
  parity39 212/212; parity38 86/86 (external :8081 oracle); parity37
  green; parity36 51/51; parity35 210/210; parity34 164/164; parity33
  77/77; parity32 65/65; parity31 63/63; parity30 179/179; parity29
  62/62; parity28 128/128; parity27 27/27; parity26 62/62; parity25
  203/203; parity21 194/203 at exactly the known 9 diffs; fixtures
  13/13 both stacks; invariants + config hash clean; accounting
  548+31+0 exit 0; :8081/:18025/:18026/:3003 down at batch end;
  reference :3001 (TZ=UTC, new build) + :8080 answering.
- Left for later taps: R6b (shadow harness + criteria), R6c
  (relocation incl. GeoIP `Databases/` + `Version.php` per R5i/R5j,
  + deletion incl. `src/themes/default` per D6-6), R6d (rollback
  artifact + cutover checklist, incl. the D6-9 live-Postgres gate).
  Follow-ups NOT in R6 (from the R6 scope §6 list) are unchanged.
- Suite-bug history (for the next suite author): parity44's first
  run died on `login_ts` indexing the opener instead of the jar
  (fixed: jar attached as `op._cj`); the 740 loop first reused the
  admin session for client-role calls (PHP 201s, not 740s — each
  role needs its own session); the canned_create probe first passed
  no params (PHP 9999s before its permission check — §7.3); the
  version probe first assumed a non-existent endpoint; page markers
  must match against tag-stripped text (raw HTML splits counts
  across elements). The §5 email probe's activity row is now in the
  suite's id-set cleanup (activity_client_email), and cart_seq is
  correctly treated as a high-water mark (308 → 311 across the run
  from cleaned login rows), not an invariant — count 283 is.
