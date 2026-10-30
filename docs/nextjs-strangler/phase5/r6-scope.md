# Phase 5 R6 scope — cutover: per-module proxy removal + shadow run + PHP deletion (DRAFT, awaiting approval)

R6 is the plan's cutover workstream, and it is explicitly **not a big
flip** (D5-6 gradual cutover posture). R5 closed the runtime
replacements (config store, prepareInvoice, Twig `{% set %}`, TZ,
SMTP, cron, limiter, antispam, security homes, installer); R6 removes
the PHP dependency itself, in dependency order, money last. Rollback
throughout: the last PHP-serving image is kept one full billing cycle
(D5-6).

Starting state (measured 2026-10-30, branch `feat/nextjs-phase5-r1`,
tip `a8cc1d0`): accounting 548 TS-served + 31 removed + 0 deferred =
579, still proxied 0. That "proxied 0" is narrower than it sounds —
see §0.1.

## 0. Survey findings (measured 2026-10-30, before scoping)

### 0.1 The proxy mechanism is GLOBAL, and "proxied 0" does not mean PHP is unused

The seam fallback is one global branch, not per-module code.
`apps/nextjs/src/app/api/fb/[...path]/route.ts`:

- A TS handler is used only when the path has 3 segments AND the
  module is in `FB_TS_MODULES` (`server/dispatch.ts:84–91`) AND
  `findHandler()` (or the R4d servicecustom magic handler) resolves.
- Everything else falls through to `fetchPhp()` (`route.ts:48`,
  called at `:202` and `:241`): the request is re-issued to
  `FOSSBILLING_URL` (default `http://127.0.0.1:8080`, `route.ts:26`),
  cookies/CSRF/content-type/accept forwarded, PHP's response
  returned verbatim (status, content-type, set-cookie, binary-safe).
- Triggers, exhaustively: path not 3 segments; module not in
  `FB_TS_MODULES`; method with no handler and no magic; the
  `__prime` special route (fetches PHP `/login` to relay cookies);
  and exactly one TS-error case — a `FB_DATABASE_PATH` error, whose
  catch branch only logs ("falling back to PHP", `route.ts:217–219`)
  and then falls through. The header comment's "Any failure in the
  TS path falls back to PHP" is overbroad versus the code: every
  other TS error returns the TS error envelope, including the R5g
  real-429. When PHP is down, the fallthrough `fetch()` throws and
  Next returns a 500 — there is no TS error shape for "proxy target
  unreachable" today.
- `FB_PARITY=1` (`route.ts:200–214`) is a second, comparison-only
  PHP call: TS-served calls also hit PHP and diff envelopes into
  `[parity]` logs; the TS response is still returned. It is a
  verification aid, not serving traffic, and dies with PHP deletion.

`docs/nextjs-strangler/phase5/endpoint-accounting.py:82–90` defines
"still proxied 0" as: catalog endpoints minus (TS literal
`register()` handlers + servicecustom magic) minus REMOVED = 0. It
covers only the 579 catalog entries. It says nothing about
non-catalog methods, unknown routes, non-3-segment paths, `__prime`,
or a misconfigured DB — all of which still proxy today.

**Consequence for "per-module":** since the fallback is global,
per-module removal cannot be a per-module code deletion. It means
removal *order + verification per module*: for each module, prove no
request path reaches PHP (catalog methods served, unknown methods
handled in TS, UI reads repointed), then delete the single global
branch once, at the end.

The one new TS behavior removal requires is a **740 for unknown
methods**: PHP's dispatcher throws `:type API call :method does not
exist in module :module`, code 740 (`src/library/FOSSBilling/Api/
Dispatcher.php:75,95`), which today only surfaces via the PHP proxy.
TS has no 740 path; R6 must add it (message shape is a small spec
decision — mirror the Dispatcher wording with role/method/module
substituted).

### 0.2 The finding the plan's framing misses: the Next UI pages bypass the seam entirely

`apps/nextjs/src/lib/fossbilling.ts` builds `fbCall()` URLs against
`FOSSBILLING_URL` directly — *not* through `/api/fb` — and the
server-component pages use it for all their reads (`adminApi.
clientList`, `invoiceList`, `orderList`, `ticketList`,
`statsSummary`, etc.; e.g. `app/(admin)/admin/clients/page.tsx:21`).
So even with API accounting at "proxied 0", killing PHP today breaks
every admin/client list and detail page. "Per-module proxy removal"
therefore has two distinct code jobs: (a) delete/neutralize the seam
fallthrough in `route.ts`, and (b) repoint `fbCall()` at the TS seam
(D6-7 decides how). The browser-side `fbPost`/`fbPostJson`
(`src/lib/browser.ts`) already go through `/api/fb` and are
unaffected. The `ipn.php` route (`app/ipn.php/route.ts`, TS-native
Stripe HMAC + transaction processing) and the invoice PDF route
(`app/(client)/invoices/[hash]/pdf/route.ts`, TS-native via
`server/pdf.ts`) do **not** proxy and need no R6 work.

Also in the removal blast radius: `__prime` and CSRF priming.
`src/lib/browser.ts:ensureCsrf()` fetches `/api/fb/__prime` because
the CSRF cookie "is set only by PHP web pages" — but TS client login
already sets both `fossbilling_session` and `fossbilling_csrf`
(`server/modules/client.ts:478–479`), and CSRF enforcement only
applies when a session exists (`server/dispatch.ts:157–161`). So a
TS-native `__prime` (issue a CSRF cookie without PHP) is a small,
well-bounded R6a item — it is also what the fixture runner's
`--stack next` prime depends on (see §0.4).

Every `FOSSBILLING_URL` URL-construction site must be repointed in
R6a, not just `fbCall()`: `extension.ts:108,616`,
`invoice.ts:1399`, `system.ts:56`, `seo.ts:22`,
`payment-adapters.ts:191`, `emailer.ts:83,109`, `order.ts:511`,
`massmailer.ts:191`, `email.ts:722` (invoice-email `__baseUrl`/`www`,
gateway callback URLs built from `FOSSBILLING_URL` via
`systemBase()`/`toolsUrl()`). Live gateway callbacks break if these
still point at a dead PHP origin — D6-8 decides the variable's
future.

### 0.3 PHP-tree runtime dependency table (the deletion checklist)

Every `FOSSBILLING_PHP_SRC` / `FB_GEOIP_DB_DIR` /
`FB_INSTALL_CONTENT_SQL` read in `apps/nextjs/src` + `scripts`:

| Site | Reads | If `src/` disappears | R6 answer |
|---|---|---|---|
| `server/geoip.ts:59–67` (`resolveGeoipDir`) | `FB_GEOIP_DB_DIR`, else `$FOSSBILLING_PHP_SRC/library/FOSSBilling/GeoIP/Databases/` (`CC0-Country.mmdb` 6.5 MB + `PDDL-ASN.mmdb` 8.8 MB) | `ip_lookup` fails with the explicit missing-file error; server otherwise fine | Relocate, not just env-var: R5j's installer already copies both files to `<installRoot>/data/geoip/` and reports the `FB_GEOIP_DB_DIR` value. R6c sets that var in the deployment *and* decides where the 15.3 MB lives long-term (install-root data dir vs vendored copy). Note the running server still defaults to the PHP tree today — the env var is not set by default anywhere in the repo. |
| `server/modules/security.ts:103–127` (`isPreviewVersion`) | `$FOSSBILLING_PHP_SRC/library/FOSSBilling/Version.php`, regexes `VERSION = '…'` | Degraded-safe: unset/unreadable/unparseable → preview = true (conservative warn). `generalCheck` still runs | None strictly needed; optionally vendor a version constant (the TS server has no version source of its own today). |
| `server/emailDefaults.ts:34–37,71–110` (`phpModulesDir`, `parseDefaultFile`, `getDefaultTemplate`) | `$FOSSBILLING_PHP_SRC`, else `join(cwd, ../../src)` (i.e. **defaults to the fork tree even with no env var**); reads `modules/<Module>/templates/email/<code>.html.twig` subject/content blocks | Email template defaults break: `getOrCreateTemplateId` (`emailDefaults.ts:166–180`) falls back to a disabled custom record for new templates, and built-in row sync (`email.ts:690–692`) silently stops syncing. Existing `email_template` rows keep working | **Vendored copy** (D6-10): 52 files across 11 modules, small (tens of KB total) — measured 2026-10-30. This is the largest *silent* dependency: no error, just degraded templates. |
| `server/modules/page.ts:32–50` (`get_pairs`) | `$FOSSBILLING_PHP_SRC/themes/<theme>/html` + `modules/Page/templates/client`, `mod_page_*.html.twig` | Degraded: no env → dirs = [] → returns `{}` (empty pairs, no error) | Vendor the theme html dir + Page client templates, or accept empty pairs (decision in R6c: the pairs feed the admin page picker; empty is a UX loss, not a billing loss). |
| `server/modules/servicelicense.ts:148–162` (`plugin_get_pairs`) | `$FOSSBILLING_PHP_SRC/modules/Servicelicense/Plugin/*.php` | Degraded: missing dir caught → returns `[]` | Vendor the `Plugin/` dir (today just `Simple.php`) or accept empty. |
| `server/config-store.ts:79–85` (`resolveConfigPath`) | `FB_CONFIG_PATH` > `dirname(dirname(FB_DATABASE_PATH))/config.php` > `$FOSSBILLING_PHP_SRC/config.php` | Only breaks deployments relying on the third fallback (running against the PHP tree). Standard install-root layout resolves via the second rule | Deployment must set `FB_CONFIG_PATH` or keep the standard layout; the PHP-tree fallback can be deleted. |
| `scripts/install.ts:219` + `install-config.ts:65` | `content.sql` via `--content-sql` / `FB_INSTALL_CONTENT_SQL` (default: the PHP tree's `install/sql/content.sql`, 24 KB); `config-sample.php` defaults are **transcribed** in code, not read | Installer cannot run fresh installs without a content.sql source | **Vendor `install/sql/content.sql`** (R5j's flagged R6 execution item) and point the installer default at it. Install-time only, not a runtime read. |
| `scripts/installer-test.mjs:182` | Runs a `php` CLI binary to cross-check config parse-back | Installer-test's PHP cross-check section cannot run | Keep a `php` binary available for the test host, or drop that cross-check post-deletion (it proves TS↔PHP config agreement, which is moot once PHP is gone). No PHP *server* needed. |

NOT PHP-tree dependencies (checked, to prevent false checklist
items): `FB_DATABASE_PATH` / `FB_DATABASE_URL` (the database
itself, `server/db.ts:100–103`); `server/modules/cron.ts:59–68,268`
(finalization state file under the install-root `data/` dir,
derived from the DB path); `server/modules/order.ts:1214`,
`server/modules/servicedownloadable.ts:143` (uploads dir next to
the DB file); `server/update-finalization.ts:81–86` (same state +
lock files under install root); `apps/nextjs/package.json` scripts
and `next.config.ts` (pure Next build — no PHP-tree reads at build
time). Session rows are DB rows in PHP's serialized format,
read/written by both sides (`server/session.ts:1–50`,
`php-serialize.ts`) — no file dependency.

### 0.4 Harness PHP dependencies and the post-deletion verification story

**Which suites call PHP:** all of them, in practice. Every parity
suite `parity21.py`–`parity43.py` compares TS against the dev PHP
oracle on `:8080` (e.g. `parity21.py:15`, `parity43.py:5` "calls
:8080/:3001"); `parity38.py`–`parity42.py` additionally use the
`:8081` prod oracle. The fixture runner
(`~/scratch/fossbilling/phase0/run-fixtures.py`) serves a disposable
PHP copy on `:8081` for `--stack php`, and `--stack next` still
needs `:8080` alive for the `/api/fb/__prime` cookie prime
(`run-fixtures.py:211`) plus any residual proxying. TS-only
harnesses exist but are narrow: `installer-test.mjs` (needs only a
`php` CLI binary, §0.3), `driver-test.mjs`, `rekey-test.mjs`,
`config-store-test.ts` — none of them prove endpoint behavior.

**What "PHP deletion" deletes — a definitional decision, because
there are two different PHP trees:**

- The **fork's `src/`** (28 MB, repo tree): what R6 deletes from
  the repo. It is *not* the server the harness talks to.
- The **reference install `~/scratch/fossbilling/runtime/src/`**: a
  scratch copy (no `.git`) that the harness's `:8080`/`:8081`
  servers actually serve. Deleting fork `src/` does not delete
  `runtime/`; deleting `runtime/` kills the harness oracles but not
  the repo. R6 must state which deletion it means, and in which
  order (D6-2).

**Three post-deletion verification options (framed, not picked —
D6-1 decides):**

1. **Frozen oracle copy outside the repo.** Keep a `runtime/`-style
   PHP install (frozen at the last PHP-serving commit) purely as a
   regression oracle; parity suites keep running unchanged against
   it. *Pros:* zero suite rewrites, keeps the strongest signal.
   *Cons:* PHP must still run somewhere forever; "deletion"
   becomes "deletion from the product repo, oracle retained," which
   may not satisfy the goal; oracle bit-rot (it stops tracking any
   post-cutover TS change by definition — which is the point, but
   it must be documented as frozen).
2. **Golden files.** Freeze the php-side expected outputs of every
   parity suite as checked-in goldens; suites compare TS against
   goldens instead of live PHP. *Pros:* no PHP runtime at all;
   deterministic; reviewable diffs. *Cons:* large golden corpus to
   generate and review (parity21 alone is 203 cases; the full set
   is ~2,000 checks); goldens freeze PHP behavior including its
   bugs, and any intentional TS behavior change needs a golden
   update with justification; fixture `php` stack dies (fixtures
   become next-only, compared against goldens or against the
   fixture expectations themselves).
3. **TS-only gate.** Drop cross-stack comparison; the gate becomes
   the fixture corpus on the next stack (13/13) + TS
   unit/integration tests (installer-test, driver-test, rekey-test,
   config-store-test) + the accounting script. *Pros:* cleanest, no
   PHP anywhere. *Cons:* weakest signal — it proves TS agrees with
   itself and with fixtures, not that it still agrees with PHP; a
   regression that changes TS behavior uniformly across fixtures
   would pass silently.

A hybrid is plausible (goldens for the money paths, TS-only
elsewhere) but that is itself a decision. Note also: whichever
option is chosen, the parity suites' *restore/snapshot* machinery
(which assumes a PHP side to restore) needs surgery, and the
fixture runner's `__prime` dependency (§0.2) must be replaced by a
TS-native prime first.

### 0.5 Money paths and what "shadow run" actually means

**Money-path inventory (TS handlers, all live today):**

- `server/modules/invoice.ts` (75 `register()` calls): invoice CRUD
  + `mark_as_paid`, `pay_with_credits` /
  `batch_pay_with_credits`, `transaction_*`, `subscription_*`,
  `refund`, guest `invoice/payment`, `prepareInvoice` /
  `markInvoicePaid` via `server/money.ts` (phpFloat precision-14,
  NULL-until-populated semantics, R5b).
- `server/modules/order.ts` (33): `create`, `activate`,
  `cancel`/`uncancel`, `renew`, `batch_cancel_suspended` /
  `batch_cancel_unpaid`.
- `server/modules/cart.ts` (19): client `checkout`, staff
  `staff_basket_checkout`.
- `server/modules/product.ts` (33): product/pricing CRUD feeding
  order totals.
- `server/modules/cron.ts`: the 13-job runner, money-relevant jobs
  `invoice_batch_generate`, `invoice_batch_send_reminders`,
  `invoice_batch_invoke_due_event`,
  `order_batch_send_suspension_warnings` /
  `order_batch_suspend_expired` / `order_batch_cancel_suspended` /
  `order_batch_cancel_unpaid`, `email_batch_sendmail`,
  `cart_batch_expire`, `invoice_journal_heal`.
- Gateways: `app/ipn.php/route.ts` (TS-native Stripe HMAC webhook +
  form callbacks + manual-approval 7002 parking) and
  `server/payment-adapters.ts` (Stripe/PayPal/Custom; callback URLs
  built from `FOSSBILLING_URL` via `systemBase()`/`toolsUrl()` —
  these URLs must be repointed at the Next origin in R6a or live
  gateway callbacks break).
- Money-adjacent: `server/modules/currency.ts` (rates, default
  currency), `server/modules/email.ts` + `emailer.ts` (invoice
  emails carry `__baseUrl`/`www` built from `FOSSBILLING_URL` —
  repoint, same as §0.2).

**Shadow, separated into the three things the plan's wording
conflates:**

- **(a) Fixture-corpus shadow — DONE.** Parity suites comparing TS
  vs PHP across the fixture corpus *are* a shadow over fixtures. R6
  does not need to build this; it needs to preserve its signal
  through the verification-story decision (§0.4).
- **(b) Live-traffic replay window — NOT built, NOT
  sandbox-buildable.** The plan's Phase 3 wording ("diffs must be
  zero across the fixture corpus and a live-traffic replay window
  before cutover") requires real production traffic mirrored to TS
  with response diffing. Nothing in the repo does request mirroring
  or response diffing against live traffic today (`FB_PARITY=1`
  only diffs TS-vs-PHP inside the seam, on the same request, and
  only logs). Building it needs: a production deployment where TS
  receives a copy of live requests, a diff harness with a defined
  comparison (envelopes? side effects? money writes must not
  double-execute), and a decision about whose traffic and whose
  infra. This is Josh's production infrastructure, not a sandbox
  artifact — R6 can build the *harness* (a replay-diff tool fed by
  captured request logs) in the sandbox, but it cannot run a
  live-traffic window without his deployment.
- **(c) One-billing-cycle shadow — a deployment posture, not a
  tool.** TS computes alongside PHP billing for a full cycle, diffs
  zero, then cutover. Operationally this means: PHP remains the
  billing authority while TS runs in parallel (dual-write or
  recompute-and-compare), diffs are collected somewhere with an
  abort threshold, and cutover flips authority. Open sub-questions
  the code does not settle: what is compared (API responses only?
  DB rows after money writes? invoice PDFs? emails queued?), where
  diffs go (log? table? alert?), what threshold aborts cutover (any
  diff? money diffs only? N diffs?), and whether TS writes during
  shadow are real or dry-run (dual-write risks double-billing if
  both sides execute money effects; recompute-and-compare needs a
  read-only TS mode that does not exist today). D6-3 decides the
  criteria; R6b costs the read-only mode if recompute-and-compare
  is chosen.

**What R6 can build in the sandbox vs what needs Josh's infra:**
sandbox-buildable: the 740 + `__prime` + `fbCall` repointing, the
relocation/vendoring of §0.3, a replay-diff harness skeleton fed by
captured logs, golden-file generation tooling (§0.4 option 2), and
the cutover checklist. Needs Josh's infra: any live-traffic replay,
any one-cycle parallel run, the rollback artifact's hosting, and
the production `FB_GEOIP_DB_DIR` / public-URL repointing.

### 0.6 PHP deletion inventory

**Fork `src/` (28 MB total):** `modules/` 11 MB (40 entries: 39
modules + `index.html` — every module PHP, templates, and tests),
`library/` 17 MB (of which `FOSSBilling/GeoIP/Databases/` alone is
15 MB; the rest is ~1 MB core + `Payment/`, `Server/`,
`Registrar/`, `Box/` adapters), `themes/` 548 KB (`default/`
admin+client+shared; built assets come from `frontend/`), `public/`
180 KB, `install/` 184 KB (`install.php`, `session.php`, `sql/`
incl. `content.sql`, `assets/`), `data/` 16 KB (runtime dirs:
`cache/`, `log/`, `uploads/`, `index.html` — structure, not code),
`locale/` 8 KB, plus top-level `config-sample.php`, `di.php`,
`load.php`, `index.php`, `cron.php`, `console.php`, `ipn.php`,
`robots.txt`, `rewrite-missing.html`. `src/vendor/` is **not
committed** (0 tracked files; `.gitignore:16` has `/src/vendor/*`)
— it is built by Composer in the Dockerfile. `frontend/`
(Next-independent core browser assets + theme build tooling) is
*not* PHP but is referenced by the PHP themes; whether it survives
depends on whether the Next UI replaces the PHP themes entirely (it
does not yet — see §0.2's UI pages, which are a new admin/client
UI, not a theme replacement; the PHP themes' fate is D6-6).

**Other PHP in the repo:** `src/install/` (above); `tests/` (Pest
suite, PHP-only — dies with PHP unless retained as oracle
documentation); `tools/` (check contents in R6c — not surveyed
here); `composer.json`/`composer.lock` (delete with `src/`); the
root `Dockerfile` (see §0.7). **Docs referencing PHP paths:**
`docs/nextjs-strangler/` findings docs cite `FOSSBILLING_PHP_SRC`
paths throughout — historical docs, no action needed beyond noting
they describe the pre-cutover layout.

**Per-piece disposition (to confirm in R6c):** delete:
`src/modules/`, `src/library/` except GeoIP DBs, `src/themes/`
(pending D6-6), `src/public/` (verify no Next route reads
`src/public` first), `src/install/*.php` (keep `sql/content.sql`
vendored elsewhere), `src/*.php` entry points, `composer.*`,
`tests/` (or retain as frozen reference — R6c decision), root
`Dockerfile`'s PHP stages (replaced by a Next deployment
definition, which does not exist today). Retain/relocate: GeoIP DBs
(→ install-root data dir), `install/sql/content.sql` (→ vendored
copy the installer reads), email `templates/email/*.html.twig` (→
vendored copy, D6-10), `Servicelicense/Plugin/` (→ vendored copy),
Page theme html templates (→ vendored copy or accept empty pairs).
**Build-time:** the Next build does not read the PHP tree (§0.3) —
deleting `src/` cannot break `npm run build`. **Git history:**
deleting `src/` from the tree does not delete it from history, and
that is *good* for rollback: any pre-deletion commit still contains
the full PHP tree, so a rollback-by-checkout is always possible. It
does not by itself satisfy D5-6 (which speaks of a kept *image*,
§0.7) — history gives you source, not a runnable artifact.

### 0.7 Rollback, concretely

**D5-6's artifact, in this repo's terms:** the plan's "last
PHP-serving image" has no existing deployment definition to point
at. What exists is the root `Dockerfile`: multi-stage (`php-base`
→ `composer-base` → `php-vendor`/`php-dev-vendor` →
`frontend-assets` → `release-tree` → `release-artifact`, a `FROM
scratch` copy of `/app/src`). That `release-artifact` — PHP +
Composer vendor + built frontend assets, built from the last
pre-deletion commit — is the natural rollback artifact: tag it, keep
it for one full billing cycle, roll back by redeploying it.
**There is no Next/Docker deployment definition today**
(`apps/nextjs/` has no Dockerfile; no deploy docs under
`docs/nextjs-strangler/`), so R6 must define both sides: the TS
deployment artifact *and* the retained PHP image, where each lives,
and the exact rollback command (re-pointing a reverse proxy?
redeploying? — unanswerable from the repo; it depends on Josh's
hosting, which the repo never describes). D6-5 decides the
retention/hosting posture; the command itself is a deployment-tap
detail.

**Database compatibility — the crux, and the answer is mostly
reassuring:** TS and PHP share one schema. TS writes nothing PHP
cannot read, with one exception class and one caveat:

- The TS-only table `rate_limit_counter` (`server/ratelimit.ts:164`,
  `CREATE TABLE IF NOT EXISTS` on first limiter use) is ignored by
  PHP, and PHP's `SchemaSynchronizer` is additive-only and never
  drops tables — so it survives a PHP rollback harmlessly.
- Shared tables use the same columns; the TS config writer is
  byte-identical to PHP's pretty-printer (R5a); session rows are
  PHP-format serialized data both sides read/write; the
  finalization state file is the same `PATH_DATA/
  update-finalization.json` with the same `pending`/`finalized`/
  `complete` statuses on both sides
  (`server/update-finalization.ts:81–127`; upstream
  `src/library/FOSSBilling/UpdateFinalization.php:21–36`), and the
  TS tool even honors PHP's `update-finalization.lock` filename
  with exclusive-create semantics
  (`update-finalization.ts:39–40,527–539`).
- The caveat: **rollback is forward-only for data, not a true DB
  rollback.** After TS has served billing traffic, a PHP rollback
  would serve a DB containing TS-written rows (invoices,
  transactions, orders). Those rows are schema-compatible, but PHP
  has never seen TS's exact write patterns (e.g. R5b
  NULL-until-populated semantics, R5g limiter rows, any TS-only
  `setting` values). Nothing found in the survey says PHP would
  *crash* on them, but nothing proves it either — that proof is a
  parity-style test (PHP reading a TS-written DB) that does not
  exist today and cannot run post-deletion without the frozen
  oracle (§0.4 option 1). Also, a rollback cannot "un-send" emails,
  un-charge cards, or un-generate invoices: the rollback story must
  include a data note (what TS wrote during the window, and that
  PHP resumes from that state rather than rewinding it). Whether
  sessions survive rollback is a minor sub-decision (R3's D3-6
  precedent chose forced logout on migration; the same logic
  applies here).

### 0.8 Plan sweep remainder — everything else the plan names, homed or rejected

- Phase 3's shadow/parallel-run gate ("TS computes, PHP bills,
  diffs must be zero across the fixture corpus and a live-traffic
  replay window before cutover") is homed: fixture-corpus shadow is
  done (§0.5a); the live-traffic window is R6b's harness + a
  deployment tap (§0.5b); the one-cycle parallel run is R6b's
  criteria + a deployment posture (§0.5c).
- D6 (payments at cutover: Stripe + ClientBalance + Custom) and D7
  (provisioning: Hestia + Custom + one registrar) stand from the
  plan; R6 does not relitigate them. R6a's gateway-callback
  repointing (§0.2) is what makes D6 true at the Next origin.
- D5-6 gradual cutover posture stands; R6's batch order (§2) is its
  execution.
- The R5 scope's §4 exclusion ("Per-module proxy removal / shadow
  runs / PHP deletion (R6)") is exactly this document's scope.

## 1. Architecture

R6 changes no API contract and no handler behavior. It removes the
PHP *dependency* in four layers, in order:

1. **Serving layer (R6a).** The seam stops being a proxy with a TS
   fast path and becomes a TS-only dispatcher: unknown methods get
   the 740 (§0.1), `__prime` becomes TS-native, UI reads go through
   the seam, and every `FOSSBILLING_URL` URL-construction site
   points at the Next origin (or its D6-8 successor). After R6a, PHP
   is still *running* (as the parity oracle) but no longer *serving*
   anything.
2. **Shadow layer (R6b).** A replay-diff harness + written shadow
   criteria. The harness compares TS against captured traffic
   (envelopes + DB rows after money writes); the criteria state what
   counts as a diff, where diffs go, and what aborts cutover. The
   live-traffic window and the one-cycle parallel run are deployment
   executions of these criteria, not sandbox builds (§0.5b/c).
3. **Deletion layer (R6c).** Every §0.3 item is relocated or
   vendored, fork `src/` (+ `composer.*` + PHP Dockerfile stages)
   is deleted, and a Next deployment definition is added (none
   exists today). The strongest R6c test: delete `src/` in a scratch
   copy and prove a fresh TS install boots and serves with no PHP
   tree present.
4. **Cutover layer (R6d).** The rollback artifact (root Dockerfile's
   `release-artifact`, tagged at the last pre-deletion commit, kept
   one full billing cycle), the forward-only data note (§0.7), and
   the cutover checklist with its go/no-go gates (including D6-9's
   Postgres gate).

Ordering constraint: R6a before R6c (prove nothing serves from PHP
before deleting PHP); R6b's harness before any live shadow
execution; R6d's artifact tagged at the last pre-deletion commit
(i.e. R6d's tagging happens as part of R6c's deletion commit
sequence, even though the checklist lands in R6d).

## 2. Batches (order R6a → R6b → R6c → R6d)

### R6a — Seam cutover (proxy removal + UI repointing)

- Delete the `fetchPhp` fallthrough in `route.ts` (keeping the
  file's structure: TS dispatch, gates, limiter, envelopes).
- Add the TS 740 for unknown methods (mirror the Dispatcher
  wording, §0.1).
- Replace `__prime` with a TS-native CSRF prime (issue a CSRF
  cookie without PHP; TS client login already sets both session and
  CSRF cookies, and CSRF enforcement only applies when a session
  exists).
- Repoint `lib/fossbilling.ts:fbCall` at the TS seam (D6-7).
- Repoint every `FOSSBILLING_URL` URL-construction site (§0.2) at
  the Next origin or its D6-8 successor (gateway callback URLs,
  invoice-email `__baseUrl`/`www`, extension/system/seo URL sites).
- Remove `FB_PARITY=1`'s PHP comparison call (it dies with PHP
  deletion; its logging value is superseded by parity suites +
  R6b's harness). Keep or remove the flag itself as a no-op —
  R6a decision, documented in findings.
- *Verification:* accounting still 548+31+0; full parity chain
  green *against a PHP oracle that is now only a comparison target,
  not a serving fallback* — i.e. prove no test passes *because* of
  proxying (a run with PHP down must pass the TS-served suites,
  failing only the oracle-comparison suites by design); new
  parity44: unknown-method 740s, `__prime` without PHP, UI pages
  rendering with PHP down (a page-smoke suite — does not exist
  today and must be built), gateway callback URLs pointing at Next.

### R6b — Shadow harness + shadow criteria

- Build the replay-diff harness skeleton: request-log capture
  format, envelope + DB-row diffing, and a money-write compare mode.
  If D6-3 chooses recompute-and-compare, R6b also builds the
  read-only TS mode it needs (costed explicitly — it does not
  exist today).
- Write the shadow criteria doc: what is compared (API responses?
  DB rows after money writes? invoice PDFs? emails queued?), where
  diffs go (log? table? alert?), what threshold aborts cutover
  (D6-3), cycle length (one full billing cycle, D5-6).
- *Verification:* harness runs against the fixture corpus and
  reproduces parity's zero-diff result; criteria doc approved.
  Live-traffic execution itself is *not* an R6b sandbox
  deliverable (§0.5b) — R6b delivers the tool + criteria, and the
  live window is a separate deployment tap.
- Money diffs found by the harness escalate: any shadow-proven
  money diff becomes an R6b fix item even if the underlying gap was
  a standing follow-up (§4) — the shadow is the arbiter, not the
  follow-up list.

### R6c — Relocation + deletion

- Vendor/relocate every §0.3 item: GeoIP DBs (→ install-root data
  dir; set `FB_GEOIP_DB_DIR` in the deployment — R5j's flagged
  item), `install/sql/content.sql` (→ vendored copy the installer
  reads; installer default repointed — blocking for fresh installs
  post-deletion), email `templates/email/*.html.twig` (D6-10),
  `Servicelicense/Plugin/` (just `Simple.php`), Page theme html
  templates (vendored copy, or accept empty pairs — R6c decision,
  documented), Version fallback (optional vendored constant; safe
  to leave as preview-default).
- Delete fork `src/` + `composer.json`/`composer.lock` + PHP
  Dockerfile stages; add the Next deployment definition (Dockerfile
  or equivalent — currently missing). `tests/` (Pest suite): delete
  or retain as frozen reference — R6c decision, documented.
  `frontend/`: survives or goes with the themes per D6-6 (verify
  no Next route reads `src/public` before deleting it).
- *Verification:* `npm run build` clean with `src/` gone;
  installer-test green (minus the PHP cross-check, or with a
  retained `php` binary); a fresh install from the TS installer
  boots and serves with no PHP tree present (the strongest R6
  test: delete `src/` in a scratch copy and run the smoke set);
  accounting unchanged. R6c runs against both SQLite and pg-mem at
  minimum (R3c's live proof is a D6-9 gate, not an R6c blocker).

### R6d — Rollback artifact + cutover checklist

- Build and tag the `release-artifact` image from the last
  pre-deletion commit (root Dockerfile's `FROM scratch` copy of
  `/app/src`: PHP + Composer vendor + built frontend assets);
  document where it lives, the rollback command (deployment-tap
  detail — the repo defines no hosting or reverse proxy), the
  one-billing-cycle retention rule, and the forward-only data note
  (§0.7: PHP resumes from TS-written state rather than rewinding
  it; rollback cannot un-send emails, un-charge cards, or
  un-generate invoices; sessions: forced logout on rollback, per
  R3's D3-6 precedent, unless D6-5's checklist says otherwise).
- Cutover checklist with go/no-go gates: R6a–R6c green; shadow
  criteria met or explicitly waived; R3c status acknowledged
  (D6-9); rollback artifact tagged and retention confirmed.
- *Verification:* a rollback drill in staging (deploy the PHP
  image against a TS-written DB copy, prove it serves) — needs
  staging infra; if unavailable, the drill is documented as
  unexecuted, not claimed.

## 3. Decisions (R6-1..R6-10, recommended defaults)

- **R6-1 — Post-deletion verification story.** Recommended default:
  frozen oracle outside the repo through R6c (parity suites keep
  running unchanged against a `runtime/`-style PHP install frozen
  at the last PHP-serving commit), then goldens for money paths +
  TS-only elsewhere once the oracle's exit criteria are met
  (criteria: R6c green + one clean full-chain run against the
  frozen oracle + the money-path goldens generated and reviewed).
  Alternatives: goldens immediately (no PHP runtime at all, but a
  ~2,000-check corpus to generate and review); TS-only immediately
  (cleanest, weakest signal). This is the fork in the road the
  scope cannot be written without — see §6.
- **R6-2 — What "PHP deletion" deletes, and when.** Recommended
  default: fork `src/` in R6c; `runtime/` retained as the frozen
  oracle until R6-1's exit criteria are met, then deleted as a
  separate, later decision. Not both at once.
- **R6-3 — Shadow criteria.** Recommended default: any *money*
  diff aborts cutover; non-money diffs are triaged. TS in shadow
  mode is recompute-and-compare (no dual money effects) — which
  means R6b builds the read-only TS mode. Alternative: dual-write
  (rejected as default: double-billing risk if both sides execute
  money effects).
- **R6-4 — Live-traffic replay window.** Recommended default: R6b
  builds the harness; the window itself is a deployment tap on
  Josh's infra, not an R6 sandbox deliverable. If there is no live
  traffic to replay, the cutover case rests on fixture shadow +
  the one-cycle parallel run, stated explicitly in R6d's
  checklist rather than silently assumed.
- **R6-5 — Rollback artifact hosting and command.** Recommended
  default: tag the root Dockerfile's `release-artifact` at the
  last pre-deletion commit and retain it one full billing cycle.
  Where it is stored and how rollback executes are Josh's infra
  answers, not code answers — the scope records them as
  deployment-tap details for R6d, not as R6 code.
- **R6-6 — PHP themes' fate.** Recommended default: delete
  `src/themes/default` with `src/` — nothing in the Next app reads
  the PHP themes. Confirm first: no external consumer (e.g. a
  PHP-served public page) depends on them. If one does, that
  consumer is named in R6c's findings and the themes are retained
  until it is migrated.
- **R6-7 — UI pages' server-side data path.** Recommended default:
  in-process dispatch for server components (import handlers
  directly — no HTTP round-trip, no auth-header juggling). It
  changes `lib/fossbilling.ts`'s contract, so R6a names it
  explicitly. Alternative: HTTP to same-origin `/api/fb`.
- **R6-8 — The `FOSSBILLING_URL` variable's future.** Recommended
  default: introduce `FB_PUBLIC_URL` (or equivalent) for URL
  construction and delete `FOSSBILLING_URL` with the proxy.
  Keeping the old name pointing at Next invites confusion about
  what it means. All repointed sites (§0.2) use the new variable.
- **R6-9 — R3c before production cutover?** Recommended default:
  R6's *code* does not wait for R3c (separate tap, needs Josh's
  Postgres+MySQL endpoints). But if production runs Postgres, live
  -Postgres proof is a go/no-go gate in R6d's checklist before
  *flipping production traffic* — sandbox proof is pg-mem only
  until then. R6c's fresh-install smoke test runs against both
  SQLite and pg-mem at minimum.
- **R6-10 — Email template defaults: vendor or generate?**
  Recommended default: vendor the 52 `.html.twig` files (exact PHP
  parity, no transcription drift) under a new in-tree path with a
  path override in `emailDefaults.ts`. Alternative: generate an
  in-tree defaults file from them (smaller repo weight, but a
  transcription step that can drift).

## 4. Explicitly NOT in R6

- Standing follow-ups (canUpdateParam checks, N1 JSON-null, Twig
  `formatDateValue` config-TZ + write-side stored-timestamp TZ
  harmonization, empty keyValue map `[]` vs `{}`, staff basket
  checkout money-columns parity case, GeoIP DB freshness refresh,
  R5b leftovers, R5e leftovers incl. SendGrid/custom/sendmail
  transports and the string-`send_now` PHP 9998 fork-fix question,
  R5f leftovers incl. live currency fetch and registrar sync):
  **not R6** — they are handler-behavior gaps, not cutover
  blockers. Exception: any gap a shadow run proves to be a money
  diff escalates into R6b's criteria (§2 R6b). Otherwise they ride
  as a separate small batch (or attach to the relevant module's
  next touch).
- R3c live verification as its own tap (D6-9: a production-cutover
  gate, not an R6 code blocker).
- Live-traffic replay window *execution* and one-cycle parallel
  run *execution* (deployment taps on Josh's infra; R6b delivers
  the harness + criteria).
- The rollback drill's staging execution if no staging infra
  exists (documented as unexecuted, §2 R6d).
- Full secret store, vault/KMS integration (out; env salt is the
  model — D4-5 carried).
- Non-0.8.9 sources; multi-tenant or sharded targets.
- Later-batch UI items (client delete UI, invoice `update` edit
  form, product/currency CRUD UI, stats date picker, service
  lifecycle actions, sidebar active highlighting, client-role
  service page, ticket-note display, client-edit field clearing)
  — except the R6a UI repointing itself (§0.2), which is cutover
  work, not UI feature work.
- The three verified upstream defects as R6 batches (separate
  fork-fix candidates; TS already implements tld_delete's intended
  behavior).

## 5. Verification standard (per batch, same discipline as R1–R5, plus R6 specifics)

- `tsc` + `next build` clean; new code landed (grep string
  literals, not minified function names).
- New parity/test suite per batch where the batch has HTTP surface
  (numbering continues from parity43): parity44 (R6a: 740s,
  TS-native `__prime`, UI smoke with PHP down, gateway callback
  URLs at Next); harness proof for R6b (fixture-corpus zero-diff
  reproduction); scratch-copy deletion proof for R6c (fresh
  install boots + serves with no PHP tree); checklist + artifact
  proof for R6d (or documented-as-unexecuted drill).
- Every batch: all prior suites green, parity21 at exactly the
  known 9, fixtures 13/13 both (while the oracle lives; per D6-1
  thereafter), DB invariants clean before AND after, accounting
  548+31+0 (R6 changes no handler count — any accounting move is
  a finding, not a silent drift).
- A case that cannot fail proves nothing (R2e lesson, applied per
  batch): R6a's PHP-down run must fail the oracle-comparison
  suites by design and pass the TS-served suites — a run that
  passes everything with PHP down proves the oracle comparison is
  vacuous; R6c's scratch-copy test must actually delete `src/`
  (a test run against a present-but-ignored tree proves nothing).
- No PHP source changes except deletion itself (R6c); no
  commit/push without a separate tap.
- R6's cutover proof is cumulative: R6a proves nothing serves
  from PHP; R6b proves the shadow criteria are executable; R6c
  proves the product runs without PHP; R6d proves rollback exists.
  No single batch claims "cutover complete."

Standing verification facts a future batch must preserve (from
R5 §5, still true until D6-1 changes them):

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
- Kill :3001 before any `--stack next` fixture run, no exceptions
  (R5j incident lesson, re-confirmed: `start_next()` only waits
  for the port, so a live reference server silently absorbs the
  run's API calls).

## 6. Open questions (not settled by the code — Josh's call, or a live-server check)

Approving R6-1..R6-10 at defaults settles the scope; what remains
open is execution detail for R6d, not scope:

1. Production hosting/topology: where the rollback artifact lives
   and the exact rollback command (reverse-proxy re-point?
   redeploy?). Needed for R6d's checklist; unanswerable from the
   repo, which never describes hosting.
2. Whether live traffic exists to replay, and whose infra the
   replay window runs on (D6-4's deployment tap).
3. Whether any external consumer depends on the PHP themes
   (D6-6's confirm-first).
4. The exact shadow abort threshold beyond "any money diff"
   (D6-3's default) — e.g. whether a money diff in a
   non-billing-adjacent field still aborts, and who triages
   non-money diffs. A business risk call, not a code property.
5. `tools/` contents (not surveyed — R6c checks before deleting).
6. `src/public/` consumers: verify no Next route reads
   `src/public` before R6c deletes it (surveyed as unchecked).
7. Whether sessions survive rollback, or forced logout applies
   (R3's D3-6 precedent says forced logout; R6d confirms).
8. R3c endpoints (Postgres+MySQL) for the D6-9 production gate —
   separate tap, still standing.
