# FOSSBilling Phase 0 — Auth/Password Portability + Golden-Fixture & Cron Recon

*Scope B (strangler) Phase 0 deliverable. Source: `~/scratch/fossbilling/repo`, FOSSBilling 0.8.9, upstream `92e4d13`. Read-only recon, 2026-10-23. Nothing in the repo was modified.*

## Headline verdicts

1. **Passwords are fully portable — no password resets needed at cutover.** Both clients and staff/admins use PHP `password_hash()` with `PASSWORD_DEFAULT` and cost 12 — on PHP 8.3 that is **bcrypt, stored as `$2y$12$…`** in a `VARCHAR(255)` column. Verified empirically in this sandbox: **`bcryptjs` (v3.0.3) verifies PHP-format `$2y$12$` hashes directly** (correct password → `true`, wrong → `false`). Node's native `bcrypt` (v6.0.0) silently returns `false` for `$2y$` hashes and needs a one-line prefix normalization (`$2y$` → `$2b$`, identical algorithm body/salt) — with that swap it verifies correctly. New hashes made in Node (`$2b$12$`) are accepted by PHP's `password_verify`, so the two stacks can share one user table during the whole strangler.
2. **Sessions are the awkward part, not passwords.** Sessions are Symfony/PHP sessions persisted in the DB `session` table with **PHP-serialized** payloads, a server-side fingerprint, and a 2-hour lifespan. The Next.js frontend phase doesn't care (it just carries the cookie), but the TS-backend phase must either keep PHP owning sessions until the auth module ports, or parse PHP serialization.
3. **API keys are stored in plaintext** (both the personal `api_token` on client/admin rows and the Serviceapikey product keys). Porting them is a copy, not a migration — but the TS implementation should hash-at-rest as a deliberate, flagged behavior change.
4. **Golden fixtures: the portable layer is the live-API E2E suites, not the unit tests.** The big unit suites pin money behavior through Mockery mock-interactions (not extractable as data); the 28 E2E files (~5.1k LOC) drive real API scenarios with asserted totals and *are* transcribable to stack-agnostic JSON scenarios. Top extraction targets in §3.4. One gap: **there is no proration anywhere** — no `prorat*` code or tests in 0.8.9; nothing to extract and no parity obligation.
5. **Cron is one undifferentiated run-all job**: **13 batch API tasks** (+ housekeeping) executed in a fixed order on every invocation, expected every ~5 minutes. There are no per-task intervals in code — the `$interval` argument `cron.php` passes is silently ignored by `runCrons()` in 0.8.9. Full TS-worker job list in §4.

---

## 1. Password storage

### 1.1 The single code path

All password hashing/verifying goes through one class — there is no per-module hashing:

- `src/library/FOSSBilling/PasswordManager.php` — wraps `password_hash()` / `password_verify()` / `password_needs_rehash()`.
  - Constructor defaults: `__construct(string $algo = PASSWORD_DEFAULT, array $options = [])`.
  - `setOptions()` merges `['cost' => 12]` over caller options.
  - `hashIt()` → `password_hash($password, $this->algo, $this->options)`; `verify()` → `password_verify()`; dummy timing hash hardcoded in `dummyVerify()` is `$2y$12$PQthNKx3xYyijvBtW0W6kOpwM0T4VkfCabQ5kWCPxht6L71W6tw.K` — itself proof of the on-disk format.
- Instantiation: `src/di.php:692` — `$di['password'] = fn () => new PasswordManager();` — **no config override anywhere** (no algo/options in `config-sample.php`), so every install runs the defaults.
- Algorithm resolution: repo requires PHP ≥ 8.3 (`composer.json`). On PHP 8.3/8.4, `PASSWORD_DEFAULT === PASSWORD_BCRYPT`, so stored hashes are **`$2y$12$<22-char salt><31-char hash>`** (60 chars), cost **12**, per-password random salt generated internally by `password_hash`.

### 1.2 Who uses it

| Population | Column | Verify path | Set/change path |
|---|---|---|---|
| Clients | `client.pass` — `src/modules/Client/Entity/Client.php:68`, `VARCHAR(255) nullable` | `Client\Service::authorizeClient()` (`Service.php:990`) → `Box_Authorization::authorizeUser()` (`src/library/Box/Authorization.php:56`) → `PasswordManager::verify()` | `Client\Service` create (`hashIt`, `Service.php:716`); `Client\Api\Admin::change_password`; `Client\Api\Guest::update_password` (reset flow) — all `hashIt()` |
| Staff/admins | `admin.pass` — `src/modules/Staff/Entity/Admin.php:45`, `VARCHAR(255) nullable` | `Staff\Service::authorizeAdmin()` (`Service.php:~1044`) → `PasswordManager::verify()` directly (duplicates the Authorization logic) | `Profile\Service::changePassword`, `Staff\Api\Admin::change_password`, staff reset flow — all `hashIt()` |
| System "cron admin" | `admin` row, `system_name = 'cron'` | Never password-authenticated (blocked at login paths: `isCron()` checks) | Auto-created by `Staff\Service::getCronAdmin()` with `hashIt(generatePassword(256))` |

One dead code path to ignore: `Client\Service::getByLoginDetails($email, $password)` does a plaintext equality lookup on `pass` — it has no production callers (only its own unit test); it is *not* an auth path and does not imply plaintext passwords exist.

### 1.3 Legacy hash upgrade path

- **Opportunistic rehash on login only.** Both verify paths (`Box_Authorization::authorizeUser` and `Staff\Service::authorizeAdmin`) do: `verify()` → if `needsRehash(stored)` (i.e. `password_needs_rehash($hash, PASSWORD_DEFAULT, ['cost' => 12])`) then re-hash the just-presented plaintext and persist. There is no batch/offline upgrader — impossible by construction, since bcrypt is one-way.
- Consequence: any older/weaker hash that `password_verify()` can still read (historical `$2a$`/`$2y$` at lower cost, or Argon2i/id if a past PHP default produced it) is transparently upgraded to `$2y$12$` the next time that user logs in. Fossil hashes nobody logs into stay fossil — the TS side must keep verifying them, not force-reset them.
- The pre-`password_hash()` scheme is already gone: `UpdatePatcher` patch113 drops the legacy `admin.salt` column with the comment that it's "dead weight from a pre-password_hash() auth scheme — nothing in the codebase reads or writes it." No md5/sha1+salt password format survives in 0.8.9 code paths.

### 1.4 Node/TypeScript verdict

**Existing users keep their passwords. Zero-reset cutover is safe.** Recommended TS implementation:

- **Library: `bcryptjs` (pure JS, v3.x)** — `compare(plain, stored)` against `$2y$12$…` works unmodified (empirically verified in this sandbox, Node 24: correct → `true`, wrong → `false`, and it parses the repo's own dummy hash without throwing).
  - Caveat: bcryptjs hashes *new* passwords as `$2b$12$…`. PHP `password_verify()` accepts `$2b$`, so dual-running stacks stay compatible in both directions.
- **Alternative: native `bcrypt` (v6.x)** — faster, but empirically it returns `false` (no error) for both right and wrong passwords against a `$2y$` hash; it verifies correctly only after normalizing the prefix `$2y$` → `$2b$` (same salt/body; the prefixes denote the same EksBlowfish computation for these inputs). If native bcrypt is chosen, the normalize step is mandatory and must be covered by a golden-vector test, because the failure mode is silent (looks like "wrong password").
- **Not needed: `argon2`** — nothing in a default 0.8.9 install produces Argon2 hashes. Only add an Argon2 verify branch if a pre-flight scan of a real target database finds `$argon2i$`/`$argon2id$` prefixes (possible in theory if an install was ever run under a non-default `PasswordManager` — the class accepts it, the DI never passes it).
- **Rehash parity:** implement the `needsRehash` equivalent in TS: parse prefix + cost from the stored hash; if prefix ≠ current or cost ≠ 12, re-hash on successful login and persist. New TS hashes should use cost **12** to stay byte-compatible in policy with PHP.
- **Phase 0 action (golden vectors):** before any auth code is written, generate ~10 hashes with the real PHP app (varied passwords incl. >72-byte and non-ASCII inputs — bcrypt's 72-byte truncation must match across stacks) and pin `(plaintext, hash)` pairs as JSON test vectors for the TS verifier. My sandbox test used a `$2b$`-generated hash with the prefix swapped to `$2y$` (identical body for that input class); vectors from PHP itself remove that last assumption.

Password *policy* (for completeness): strength/match validation lives in the validator (`isPasswordStrong`, `passwordsMatch`) at the API layer for create/change/reset — port the policy rules with the auth module; they don't affect stored-hash portability.

---

## 2. Sessions & API keys

### 2.1 Sessions

- **Engine:** Symfony HttpFoundation session over PHP's native storage with `serialize_handler = 'php'`, wired in `src/di.php:203–249` (`$di['session']`).
- **Storage:** database table **`session`** via Symfony `PdoSessionHandler` (`db_table=session`, id/content/lifetime/modified_at columns, advisory locking), wrapped by `src/library/FOSSBilling/Session.php`, which adds app-level `fingerprint` and `created_at` columns on the same table.
- **Cookie:** name **`fossbilling_session`** (`FOSSBilling\Http\CookieNames::SESSION`), `HttpOnly`, `Secure` when `security.force_https` (default true) or the request is HTTPS, `SameSite=Strict` in strict security mode else `Lax`, path `/`. It's a browser-session cookie (`cookie_lifetime = 0`)…
- **…but server-side lifespan is 2 hours:** `security.session_lifespan` default **7200s** (`config-sample.php:31`) drives both `gc_maxlifetime` and an explicit age check in `Session::canUseSession()` — a session row older than the lifespan is deleted and the cookie expired regardless of activity bookkeeping. (This is creation-age based in the app check, not sliding idle timeout — a parity detail the TS port must replicate or deliberately change.)
- **Fingerprinting:** on by default (`security.perform_session_fingerprinting = true`). `FOSSBilling\Fingerprint` builds a browser fingerprint from the request; it's stored as JSON in `session.fingerprint` and re-checked every request — mismatch destroys the session and expires the cookie.
- **Contents — two disjoint login states in one session:**
  - Client login: `client_id = <id>` (set in `Client\Api\Guest::login` after `regenerateId()`; the cart is transferred from the old session id).
  - Staff login: `admin = {id, email, name}` (set in `Staff\Service::login`, after `regenerateId()`).
  - Plus `csrf_token` (see §2.3), `redirect_uri`, cart linkage, etc.
- **Rotation:** login and logout call `Session::regenerateId()`, which uses a **300s obsolete-session grace period** (`security.session_regeneration_grace_period`): the old id is flagged obsolete with an expiry, auth data is cleared from it once expired. Logout is per-role (`destroy('admin'|'client')` deletes that role's keys + rotates; full `invalidate()` otherwise).
- **Auth re-validation per request:** `Box_Authorization::isClientLoggedIn()/isAdminLoggedIn()` re-loads the entity and requires status ACTIVE on every check (and rejects the cron admin for admin sessions) — a deactivated user is logged out effectively immediately.
- **Invalidation side-effects:** changing a password or regenerating an API key calls `Profile\Service::invalidateSessions(...)` for that identity.
- **Password-reset tokens** (adjacent to sessions): both client (`Client\Service::createPasswordResetRequestForClient`) and staff (`Staff\Api\Guest`) resets use `hash('sha256', random_bytes(32))` — a 64-hex token stored in dedicated reset tables; client reset requests are pruned when older than 15 minutes by service logic, and unconfirmed reminders are swept by cron (see §4). Straightforward to port 1:1.

**Strangler implications:**
- Phase 1 (Next.js frontend, PHP backend): trivial — same-origin proxy/BFF forwards the `fossbilling_session` cookie; the browser never talks to PHP cross-origin (which would trip SameSite=Strict + the Origin checks in §2.3 anyway).
- TS-backend phase: the `session.content` column is **PHP-serialized Symfony session data**, not JSON. Options: (a) keep PHP as session owner until the Client/Staff auth modules port, then cut sessions over atomically with forced re-login for stragglers; (b) write a PHP-serialization reader for the subset actually stored (flat scalar keys + one small `admin` array — feasible but fiddly). Recommendation: (a), with the 2-hour lifespan making forced-expiry painless.
- If TS must *validate* PHP sessions mid-strangler, it also has to reproduce the fingerprint check and the creation-age rule, or sessions will behave differently depending on which stack serves the request — another reason to keep one session owner at a time.

### 2.2 API keys — two different systems (don't conflate them)

**(a) Personal API tokens — these authenticate to the FOSSBilling API**

- Stored **plaintext** in `client.api_token` and `admin.api_token` (`VARCHAR(128)`, `Client.php:149`, `Admin.php:57`).
- Generated by `Profile\Service::generateNewApiKey()` (admin) / `resetApiKey()` (client) as `Tools::generatePassword(32)` — 32 chars from `[a-zA-Z0-9]` (the generator guarantees one lower/upper/digit; random via `random_int`). Resetting a key **invalidates that identity's sessions**.
- Presented as **HTTP Basic auth**: `Authorization: Basic base64("<role>:<token>")` where the username must be literally `client` or `admin` matching the route role, and the password is the token. PHP surfaces it as `PHP_AUTH_USER`/`PHP_AUTH_PW`; `Api\Controller\Client::_tryTokenLogin()` looks the token up **by direct equality** (`findOneBy(['apiToken' => …])`) plus ACTIVE status, explicitly rejects the cron admin, and then **bootstraps a normal session** (sets `client_id` / `admin`) for the request.
- Three endpoints are carved out to prefer session auth when a session exists (`profile_api_key_get`, `profile_api_key_reset`, `profile_generate_api_key`) so a token can't be used to read/rotate itself.
- Note there is no token expiry, scope, or per-token permissions — role is the whole authorization boundary (plus module permissions for admin).

**(b) Serviceapikey module — API keys as a *sold product***

- `src/modules/Serviceapikey` models keys a client *buys* (e.g. access to some external service); it is not a credential for FOSSBilling itself.
- Table `service_apikey` (`client_id`, `api_key VARCHAR(255)`, `config TEXT`), entity `Entity/ServiceApiKey.php`.
- Generation (`Service::generateKey`): `random_bytes(ceil(length/2))` → hex, default **length 32, uppercase, dash-split every 8 chars** (`XXXXXXXX-XXXXXXXX-…`), configurable length/case/split via the product `config`; uniqueness enforced by lookup-retry (max 10). Stored **plaintext**; lifecycle (create on order activation, suspend/expire with the order) ties into the order system.
- Porting note: format compatibility matters if external consumers validate the key shape — keep the generator's exact format defaults.

**(c) Cron hash** — `mod_cron` extension config `cron_hash = bin2hex(random_bytes(32))` (64 hex chars), presented as a `hash` parameter to the guest cron endpoint and compared with `hash_equals` (§4). Not a user credential, but part of the auth surface to re-implement.

**Hashing-at-rest recommendation:** the TS port *could* store personal tokens hashed (SHA-256 + prefix lookup), which is strictly better — but it's a behavior change (breaks "view your current key" in Profile, which today can display the stored plaintext token). Flag as an explicit Phase 2 decision; do not silently change it during the strangler.

### 2.3 CSRF handling on the API

- **Token:** per-session, `bin2hex(random_bytes(32))` (64 hex), generated lazily by `Twig\TwigFactory::getCsrfToken()` and stored in the session as `csrf_token`; exposed to every page as the Twig global `CSRFToken` and mirrored into the `fossbilling_csrf` cookie (legacy name `csrf_token` also read). The frontend wrapper (`frontend/core/api.js`) appends it automatically.
- **Enforcement** (`Api\Controller\Client::_checkCSRFToken`, `Client.php:502`): applies to **session-authenticated** client/admin API calls. Token accepted from, in order: JSON body field `CSRFToken`, form field, query param, or `X-CSRF-TOKEN` header; compared with `hash_equals` against the session token. If the CSRF *cookie* is present it must also equal the session token (double-submit flavor on top of the session token). Failure → `403 CSRF token invalid`.
- **Config escape hatch:** `api.CSRFPrevention` in config, default `true`; the Security module's checks flag installs that disable it. CLI invocations are exempt.
- **Token (Basic-auth) API calls do not go through the CSRF check** — `requireSessionAuth()` is the only path that calls `_checkCSRFToken()`; the `_tryTokenLogin()` path doesn't. Sensible (no ambient cookie authority), and the TS port should preserve exactly this split.
- **Guest sensitive endpoints get a pre-auth variant** (`checkGuestAuthentication`, `Client.php:~245`): `client_login`, `client_create`, `staff_login` require POST + the pre-login session nonce (body/header only — query deliberately excluded) **plus** `Origin` must equal `SYSTEM_URL`'s scheme+host and `Sec-Fetch-Site` must not be `cross-site`. Cart mutations (`cart_add_item`, `cart_remove_item`, `cart_apply_promo`, `cart_remove_promo`, `cart_reset`, `cart_set_currency`) get the same nonce check but may arrive by GET with the nonce in the query.
- **Next.js frontend requirements (Phase 1):** server-render or fetch the current `CSRFToken` for the session, send it as `X-CSRF-TOKEN` on every mutating API call, stay same-origin (proxy `/api/*` through the Next.js origin or a same-site subdomain that still satisfies the `Origin == SYSTEM_URL` check — cross-site fetch will be rejected by design). Also note general API defenses that sit next to CSRF and will bite a careless frontend port: optional API IP allowlist (`api.allowed_ips`), referer checking (`checkHttpReferer` in the controller), and per-role/method rate limiting.

---

## 3. Golden fixtures — what pins money behavior, and what's extractable

### 3.1 How the test corpus is shaped (read this before extracting anything)

- **Unit suites** (`src/modules/*/tests/Unit`, `tests/Unit`) run under Pest with **Mockery**: collaborators are mocked, and assertions are a mix of (i) plain expected scalars/arrays inline in the test and (ii) mock-interaction expectations ("repository X called once with Y"). Category (ii) pins *PHP implementation structure*, not behavior — it cannot and should not be ported. Category (i) is real behavioral data and is transcribable to JSON, but only by reading each test and separating the two — there is no fixture-file layer to lift wholesale.
- **`tests/Datasets`** holds only three small shared datasets — `GeographicData.php`, `ValidationData.php` (form validation), and `PeriodCodes.php` (billing-period math, genuinely golden — see table). None of the money suites parameterize from shared dataset files; their inputs are constructed inline per test (entities via `Tests\Helpers\createEntity`, services via a permissive test container).
- **`tests/Fixtures`** is thin: `entity-columns.snapshot.json` (22.7 KB — a full entity→columns snapshot; *very* useful for the TS schema work, not money behavior), one legacy email Twig fixture, one cross-table migration helper.
- **E2E suites** (`src/modules/*/tests/E2E`, 28 files, ~5,084 LOC) are **live-API tests**: skipped unless `APP_URL` + `TEST_API_KEY` are set; they create real clients/products/orders/invoices through `Tests\Helpers\ApiClient::request('admin/…', …)` and assert on API results (invoice counts, totals, statuses). These are stack-agnostic by construction — the same scenarios can run against the TS implementation unchanged in spirit, and each scenario transcribes mechanically to a JSON fixture (setup API calls → action → expected reads). **This is the parity harness's primary source.**
- **Grading used below:** **A** = transcribe scenario to JSON (setup/actions/expected outputs), high fidelity. **B** = hand/LLM-extract inline input→expected-output cases to JSON; worth it for pure calculators. **C** = mock-interaction tests; skip (behavior is covered by A/B sources or the API contract snapshots).

### 3.2 Suite-by-suite inventory (money-relevant)

| Suite | Pins | Extractable? |
|---|---|---|
| `src/modules/Invoice/tests/Unit/ServiceTest.php` — 9,867 lines, 224 tests | The core money engine: invoice totals & total-with-tax, zero-total invoices skipping payment, pay-with-credits (incl. concurrency/insufficient-balance/one-cent edge cases), deposit invoices crediting client balance, refunds (negative-invoice and credit-note logic, reserved numbering, refusal paths), renewal invoice generation, "return existing unpaid invoice instead of duplicating" | **B** — heavy mock scaffolding, but the scenario *data* (amounts, balances, expected totals/outcomes) is inline and is the richest single source of money semantics. Extract scenarios, not assertions. |
| `src/modules/Invoice/tests/Unit/ServiceTaxTest.php` — 254 lines, 12 tests + `Entity/TaxTest.php`, `Repository/TaxRepositoryTest.php` | Tax-rate resolution order: state+country → country → global rule; tax-exempt clients; rate returned as string decimal (e.g. `'0.21'`, title e.g. "VAT"). Underlying code: `Invoice\ServiceTax::getTaxRateForClient()`, `getTax(Invoice)` | **B, near-A** — small, pure, table-like. Extract first among unit suites. |
| `src/modules/Invoice/tests/Unit/ServiceInvoiceItemTest.php` — 879 lines, 32 tests | Line-item math: `ServiceInvoiceItem::getTotal()`, `getTax()`, `getTotalWithTax()` (price × qty, taxed flag, period), item generation from orders incl. promo application flag | **B** — pure-calculator core; expected values inline. |
| `src/modules/Invoice/tests/Unit/ServiceSubscriptionTest.php` + `Repository/SubscriptionRepositoryTest.php` | Subscription records tied to gateways (creation/cancellation bookkeeping) | **B/C** — bookkeeping more than math; extract cancellation/creation state expectations only. |
| `src/modules/Invoice/tests/Unit/ServiceTransactionTest.php` + `tests/E2E/TransactionApprovalTest.php` | Transaction lifecycle: gateway transaction processing, approval workflow, error handling | **B** (unit) / **A** (E2E approval flow). |
| `src/modules/Invoice/tests/E2E/CreditNoteTest.php` (345 lines), `DebitNoteTest.php` (153) | Credit/debit note issuance against real invoices via API — amounts, numbering, balance effects | **A** |
| `src/modules/Invoice/tests/E2E/MergeRenewalsTest.php` (213) | Renewal batch merging: orders sharing client+currency+due-date+period merge onto one invoice; per-order `merge_renewals` opt-out and different period stay separate; `invoice_merge_renewals` system flag; drives `admin/invoice/batch_generate` | **A** — and it's also a cron-behavior fixture (§4). |
| `src/modules/Invoice/tests/E2E/InvoiceCancelTest.php`, `InvoiceRefusalPathsTest.php` (485), `InvoiceEditLockTest.php`, `InvoiceAttachReissueTest.php`, `InvoiceJournalTest.php` | Invoice state machine: cancel/void semantics, which operations are refused in which states, edit locking, journal entries | **A** |
| `src/modules/Product/tests/Unit/ServiceTest.php` — 3,848 lines, 145 tests (promo sections) | Promo engine rules: create/duplicate codes, `canBeApplied` conditions, once-per-client, usage limits, reserve-for-order, redemption records per order, related-product (domain) discounts, staff price overrides (trusted-only) | **B** — rules are inline-data rich; extract the promo decision table (conditions → allowed/denied + discount effect). |
| `src/modules/Product/tests/E2E/AutoPromoTest.php` (413), `BundlePromoTest.php` (358), `MultiGroupPromoTest.php` (220), `ApiAddonQuantityTest.php` (342) | End-to-end discounts: auto-apply promos (percentage, recurring, client-only eligibility — guests excluded), bundle-condition promos, multi-group promos, addon quantities at cart/checkout with asserted totals | **A** — the discount golden fixtures. |
| `src/modules/Cart/tests/Unit/ServiceTest.php` — 2,815 lines, 68 tests + `DomainPricingTest.php`, `tests/E2E/StaffBasketTest.php`, `ApiGuestTest.php` | Cart totals flow, promo application at cart level (incl. bundle-condition rejection, once-per-client, limit-reached, compensation/rollback of promo usage when checkout fails), domain pricing/TLD addons, staff basket behavior | **B** (unit) / **A** (E2E). |
| `src/modules/Currency/tests/Unit/ServiceTest.php` — 864 lines, 27 tests; `FormattingTest.php` — 166 lines, 6 tests; `tests/E2E/ApiAdminTest.php` | Conversion math: `toBaseCurrency()` / `getBaseCurrencyRate()` against stored rates, default-currency handling; display formatting via ICU patterns, per-currency fraction digits & overrides. (Live rate *fetching* from exchangerate APIs is I/O, not pinned math.) | **B, near-A** — conversion/formatting cases are pure input→output. Extract early; currency rounding differences are a classic silent-divergence bug. |
| `src/modules/Order/tests/Unit/ServiceTest.php` — 4,853 lines, 122 tests | Order lifecycle economics: activation, renewal setup, batch suspend/cancel rules & day thresholds, promo reservation on create, failure compensation | **B** for batch/threshold rules; rest **C**. Pair with MergeRenewals E2E. |
| `tests/Datasets/PeriodCodes.php` + `tests/Unit/Box/PeriodTest.php` | Billing-period arithmetic: `1D=1d … 2W=15d, 1M=30d, 1Y=360d` — the 30-day-month/360-day-year convention that renewal dates and period pricing silently depend on | **A** — it's already a data table; copy to JSON verbatim. |
| `tests/Fixtures/entity-columns.snapshot.json` | Not money behavior: entity/column inventory snapshot | **A** for schema parity (Drizzle) — include in Phase 0 for the DB workstream. |

**Proration — explicit non-finding:** searching the entire tree finds no `prorat*` code or tests. 0.8.9 has no mid-cycle proration: plan changes are handled as new orders/lines at full period price, and renewals via the batch generator. The parity harness has *nothing to extract* here, and the TS port must not invent proration semantics FOSSBilling doesn't have. (If Josh wants proration as a *new* feature, that's a product decision, not parity work.)

**Coupons/discounts terminology:** "coupons" = the Product module's **promos** (codes + auto-apply); coverage is the Product/Cart rows above. Client-credit/balance spending is covered by Invoice `ServiceTest` pay-with-credits cases and `Client\ServiceBalance`.

### 3.3 What "extractable as JSON" concretely means here

For **A-grade** (E2E): fixture = `{ setup: [API calls with payloads], action: API call, expect: [API reads with expected fields/totals] }`, with dates expressed relatively (`+3 days`) as the originals do. The runner needs a seeded admin API token — the same `APP_URL`/`TEST_API_KEY` contract the PHP suites already use, so both implementations can be graded by the identical harness.
For **B-grade** (unit): fixture = `{ inputs: {…entity fields…}, expected: {…scalar outputs…} }` per test case, transcribed from inline constructions; mock expectations are dropped. Budget real time for this — it's reading comprehension work across ~20k lines of tests, not a script run.

### 3.4 Top 10 fixture sources to extract first

1. **`src/modules/Invoice/tests/E2E/MergeRenewalsTest.php`** — renewal generation + merging rules; exercises cron's most valuable task end-to-end.
2. **`src/modules/Product/tests/E2E/AutoPromoTest.php`** — auto-apply percentage/recurring promos at display & checkout, guest exclusion.
3. **`src/modules/Product/tests/E2E/BundlePromoTest.php`** + **`MultiGroupPromoTest.php`** — conditional discount eligibility (the cases most likely to diverge silently).
4. **`src/modules/Invoice/tests/E2E/CreditNoteTest.php`** (+ `DebitNoteTest.php`) — refund-adjacent money-out documents with numbering.
5. **`src/modules/Invoice/tests/Unit/ServiceTaxTest.php`** — tax resolution order table; tiny, pure, extract in an hour.
6. **`src/modules/Currency/tests/Unit/ServiceTest.php`** (conversion cases) + **`FormattingTest.php`** — base-currency conversion and ICU formatting/rounding.
7. **`tests/Datasets/PeriodCodes.php`** — period-length table; verbatim JSON copy, underpins all renewal dates.
8. **`src/modules/Invoice/tests/Unit/ServiceTest.php`** — pay-with-credits, totals, refund scenarios (B-grade transcription; largest single effort, highest value).
9. **`src/modules/Invoice/tests/Unit/ServiceInvoiceItemTest.php`** — line-item total/tax calculator cases.
10. **`src/modules/Invoice/tests/E2E/InvoiceRefusalPathsTest.php`** — invoice state-machine refusals; cheap A-grade transcription, prevents illegal-transition regressions.

Honorable mention: `tests/Fixtures/entity-columns.snapshot.json` (schema parity, different workstream) and `Cart/tests/Unit/DomainPricingTest.php` if domain products are in the cutover scope (D7).

---

## 4. Cron inventory — the TS worker's job list

Source: `src/modules/Cron/Service.php::runCrons()` (0.8.9). Entry points: `php src/cron.php` (CLI; it reads `$argv[1]` as an "interval" and passes it, but **`runCrons()` accepts no parameters — the value is silently ignored**), Symfony console command `cron:run` (`src/modules/Cron/Commands/Run.php`), admin API `cron/run`, and guest API `cron/run` (requires `guest_cron` enabled + `cron_hash`, hash_equals-checked, self-throttles to once per minute).

**Cadence model: there are no per-task schedules.** Every invocation runs every task, in the fixed order below. The expected invocation cadence is **~every 5 minutes** — inferred from `Cron\Service::isLate()`, which flags cron as late when `last_cron_exec` is older than 6 minutes. All tasks execute as the system **cron admin** identity via `$di['api_system']` (`FOSSBilling\Api\Proxy` over `Staff\Service::getCronAdmin()`), i.e. each task is literally an admin-API call of the form `<module>_batch_<task>` — the TS worker can preserve this shape task-for-task.

**Failure semantics (port these):** the first two tasks run *unisolated* — if either throws, the run aborts (exception propagates; only the `is_cron` flag is restored in `finally`). The remaining 11 run in a per-task try/catch: failures are logged, collected, the run continues, `last_cron_exec` is still updated, and the run returns `false` at the end naming the failed tasks. Before any task: if update-finalization is pending, the whole run is refused (503) and logged; a schema-drift heal is attempted first with failures only logged. `BeforeAdminCronRunEvent` / `AfterAdminCronRunEvent` bracket the tasks.

| # | Cron call (`api_system`) | Module API → service method invoked | What it does / internal throttling |
|---|---|---|---|
| — | *(pre-flight)* | `update_finalization->isRequired()` gate + `healSchemaDrift()` | Refuse run during pending update finalization; heal same-version schema drift (failures logged only) |
| 1 | `invoice_batch_pay_with_credits` | `Invoice\Api\Admin::batch_pay_with_credits` → `Invoice\Service::doBatchPayWithCredits()` | Pays open invoices from client credit balances (optionally per-client). **Unisolated — aborts run on failure.** Also invoked opportunistically after Stripe/PayPal payments. |
| 2 | `invoice_batch_activate_paid` | `Invoice\Api\Admin::batch_activate_paid` → `Invoice\Service::doBatchPaidInvoiceActivation()` | Activates/provisions order lines on paid invoices. **Unisolated — aborts run on failure.** |
| 3 | `invoice_batch_generate` | `Invoice\Api\Admin::batch_generate` → `Invoice\Service::generateInvoicesForExpiringOrders()` | Generates renewal invoices for expiring orders (merge rules per MergeRenewals fixture, §3). Isolated. |
| 4 | `invoice_batch_send_reminders` | `Invoice\Api\Admin::batch_send_reminders` → `Invoice\Service::doBatchRemindersSend()` | Payment reminders for unpaid invoices. Internally throttled to ~once per rolling 24h (via the due-event batch) with per-invoice atomic `reminded_at` claiming so overlapping runs never double-send. Isolated. |
| 5 | `invoice_batch_invoke_due_event` | `Invoice\Api\Admin::batch_invoke_due_event` → `Invoice\Service::doBatchInvokeDueEvent()` | Fires Before/AfterInvoiceIsDue events on unpaid/issued invoices (extension hook point). `once_per_day` parameter defaults true. Isolated. |
| 6 | `order_batch_send_suspension_warnings` | `Order\Api\Admin::batch_send_suspension_warnings` → `Order\Service::batchSendSuspensionWarnings()` | Final warnings for orders due to be suspended within 24h. Isolated. |
| 7 | `order_batch_suspend_expired` | `Order\Api\Admin::batch_suspend_expired` → `Order\Service::batchSuspendExpired()` | Suspends expired orders. Isolated. |
| 8 | `order_batch_cancel_suspended` | `Order\Api\Admin::batch_cancel_suspended` → `Order\Service::batchCancelSuspended()` | Cancels orders suspended longer than the configured days (order config: enabled flag, reason, after-days). Isolated. |
| 9 | `order_batch_cancel_unpaid` | `Order\Api\Admin::batch_cancel_unpaid` → `Order\Service::batchCancelUnpaid()` | Removes pending-setup orders whose invoice stayed unpaid past due date + configured days. Isolated. |
| 10 | `support_batch_ticket_auto_close` | `Support\Api\Admin::batch_ticket_auto_close` → `Support\Service::getExpired()` + `autoClose()` per ticket | Auto-closes expired/awaiting-reply tickets. Isolated. |
| 11 | `client_batch_expire_password_reminders` | `Client\Api\Admin::batch_expire_password_reminders` → `Client\Service::getExpiredPasswordReminders()` + delete | Sweeps expired client password-reset requests. Isolated. |
| 12 | `cart_batch_expire` | `Cart\Api\Admin::batch_expire` (logic inline in the API class) | Deletes guest/client carts older than 7 days (calendar-date comparison); staff baskets (`staff:` session keys) are explicitly exempt. Isolated. |
| 13 | `email_batch_sendmail` | `Email\Api\Admin::batch_sendmail` → `Email\Service::batchSend()` | Flushes the queued email outbox (no-op `false` if the demo extension is active). Isolated. Must run last-ish: earlier tasks queue mail into this outbox. |
| — | *(housekeeping, in `runCrons` itself)* | `System\Service::setParamValue('last_cron_exec', …)`; `Cron\Service::clearOldSessions()` | Stamps last-run time; deletes `session` rows past `lifetime` or older than `session_lifespan` (ties §2.1's 2h rule to this purge). |

**Count for the TS worker: 13 batch jobs + 2 housekeeping steps + the finalization gate.** Ordering constraints that matter: credits before activation (1→2), generation before reminders/due-events (3→4→5), warnings before suspension before cancellation (6→7→8), email flush after everything that queues mail (13 last). The PHP test `src/modules/Cron/tests/Unit/ServiceTest.php` pins exactly this ordering (it asserts relative positions of generate < reminders < due-event and that the email flush is included) — transcribe it as the worker's first parity test.

**Notable absence:** currency exchange-rate refresh is *not* in `runCrons()`. `Currency\Service::updateCurrencyRates()` is only invoked via the admin API (`currency/update_rates`), gated by a config flag (`isCronEnabled()`) — i.e. upstream expects installs that want fresh rates to schedule that API call externally. The TS worker should list it as an optional 14th job, off by default, to match upstream behavior.

---

## Appendix — file map for the implementer

- Passwords: `src/library/FOSSBilling/PasswordManager.php`; `src/library/Box/Authorization.php:56–82`; `src/di.php:692`; `src/modules/Client/Service.php:990` (`authorizeClient`), `:716` (create); `src/modules/Staff/Service.php:~1044` (`authorizeAdmin`), `:131` (`login`); entities `src/modules/Client/Entity/Client.php:68,149`, `src/modules/Staff/Entity/Admin.php:45,57`; legacy-salt drop: `src/library/FOSSBilling/UpdatePatcher.php` patch113.
- Sessions: `src/di.php:203–249`; `src/library/FOSSBilling/Session.php`; `src/library/FOSSBilling/Http/CookieNames.php`; `src/library/FOSSBilling/Fingerprint.php`; `src/config-sample.php:19–33` (security defaults).
- API tokens: `src/modules/Api/Controller/Client.php` (`_tryTokenLogin`, `getAuth`, `shouldPreferSessionAuth`); `src/modules/Profile/Service.php:84` (`generateNewApiKey`), `:253` (`resetApiKey`), `:303` (`invalidateSessions`); `src/library/FOSSBilling/Tools.php:52` (`generatePassword`).
- Service keys: `src/modules/Serviceapikey/Service.php` (`generateKey` ~:274), `src/modules/Serviceapikey/Entity/ServiceApiKey.php`.
- CSRF: `src/modules/Api/Controller/Client.php:502` (`_checkCSRFToken`), `:~245` (`checkGuestAuthentication`); `src/library/FOSSBilling/Twig/TwigFactory.php:~496` (`getCsrfToken`); `src/config-sample.php:248` (`CSRFPrevention`).
- Cron: `src/modules/Cron/Service.php`; `src/cron.php`; `src/modules/Cron/Api/{Admin,Guest}.php`; `src/di.php:523` (`api_system` / cron admin).
