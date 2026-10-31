# Findings — Phase 5 batch R6b: shadow replay-diff harness + shadow criteria

Status: BUILD complete, uncommitted, pending parent re-verification and commit.
Branch: `feat/nextjs-phase5-r1`. Prior tip: `c1337f0` (R6 scope + R6a seam cutover).
R6b adds no handlers — accounting must stay 548 TS-served + 31 removed + 0 deferred = 579.

## 1. Survey (from code/docs, with citations)

### 1.1 Fixture runner — reused, not reinvented

`~/scratch/fossbilling/phase0/run-fixtures.py` (325 lines):

- Scenario format: a fixture file holds fixtures with `seed_sql` / `seed_ops`
  (`clone_client`: clone client 1, save name, set overrides incl. country/state/
  email/tax_exempt) then `steps` (`call: role/module/method`, `params`, optional
  `as` persona, `save` dotted paths, `json: true` for JSON bodies). Expectations
  are dotted paths into step results, or scalar SQL.
- Disposable PHP: copytree of `runtime/src` ignoring vendor/data/cache, vendor +
  data HARDLINKED (not symlinked — PHP resolves `__DIR__` through symlinks and
  autoloads the original tree's classes alongside the copy's, causing "class
  already in use" fatals), snapshot DB from reference at setup, config data-path
  rewritten, served on :8081 with `APP_ENV=dev`. The reference DB is snapshotted
  once and restored before EVERY fixture (order-independent, deterministic).
- Comparison: `num_eq` (numbers rounded to 2dp); VOLATILE_KEYS scrubbed in saved
  steps output only: hash, hash_expires_at, created_at, updated_at, due_at,
  paid_at, reminded_at, `__cart_family`.
- "13/13" proves 13 money/tax fixtures pass on a stack against expectations
  derived from PHP baseline behavior — not a php-vs-next diff.

Reuse vs divergence (explicit): the harness REUSES the disposable-PHP machinery
(copytree + hardlink vendor/data + snapshot DB + config rewrite + :8081-style
disposable port, here :18081) and the scenario vocabulary (seed_sql/seed_ops,
steps, save/subst, form-vs-JSON). It DIVERGES in three places, each for a stated
reason: (a) it runs BOTH stacks per scenario and diffs envelopes + DB deltas,
where the runner runs one stack against fixed expectations; (b) it snapshots
the DB per stack AFTER the prime/login preamble and diffs DELTAS, where the
runner restores a fixed snapshot before each fixture — deltas absorb login side
effects the runner never sees (see §5); (c) it adds a capture/replay mode the
runner has no equivalent of.

### 1.2 Parity snapshot machinery — pattern adopted

parity38.py's snapshot/restore pattern (and the other suites): snapshot id SETS
per table, restore by deleting non-snapshot ids (never id-range deletes — the
R5h cart incident: a mistaken `DELETE FROM cart WHERE id>283` removed 19
legitimate rows, recovered from the R5g backup). Sequences are NOT restored
(they are high-water marks). Sessions are excluded (random tokens); volatile
timestamps are scrubbed, not asserted.

The harness builds on this: per-stack baseline snapshots after preamble, delta
= added/removed/changed rows vs that stack's own baseline, keyed by id.
Excluded entirely: `session`, all `activity_*` audit tables (timestamps + IPs,
no money signal), `rate_limit_counter` (TS-only table, no PHP counterpart).
Normalization is listed explicitly in every report (`normalized_fields`); a
field is normalized ONLY if two identical PHP runs disagree on it, or is of the
same proven class (wall-clock/random) with the PHP evidence cited in §6.

### 1.3 Money-path inventory (r6-scope.md §0.5 + code)

- `invoice.ts`: 75 registers incl. prepare/update/issue/mark_as_paid/
  pay_with_credits/batch_pay_with_credits/transaction_*/subscription_*/refund/
  debit/guest payment/pdf.
- `order.ts`: 33 registers incl. create/activate/renew/cancel/uncancel/suspend/
  unsuspend/batch_*.
- `cart.ts`: 19 registers incl. client checkout, staff_basket_add_item:1335,
  staff_basket_get:1370, staff_basket_checkout:1552.
- `cron.ts`: `admin/cron/run` (:281, direct) and `guest/cron/run` (:300, requires
  mod_cron config guest_cron + cron_hash, plus 60s guest throttle). Reference
  extension_meta includes mod_cron, so the harness cron scenario uses admin run
  (all 13 jobs).
- Gateway scenario without live secrets: form POST to `/ipn.php?gateway_id=1`
  (Custom, manual-approval) parks the transaction as status `error` with error
  "Custom payments must be approved by an administrator." and error_code 7002
  (proven on PHP in capture48). JSON Stripe webhooks require an HMAC secret —
  live-only, not in R6b scenarios.

### 1.4 What a "money write" touches (DB-row diff scope)

Money writers: `money.ts` (phpFloat precision-14, toBaseCurrency, countIncome,
prepareInvoice/markInvoicePaid with NULL semantics), `invoice.ts`
transaction/subscription paths, `order.ts` activation. Per operation the
touched tables are: invoice, invoice_item, transaction, client_order,
client_order_meta, cart, cart_product, client_balance, subscription — these
nine are MONEY_TABLES. DIFF_TABLES adds their dependents: invoice_event,
client_order_status, email_queue, service_custom, setting. A blind full-DB diff
would drown in volatile rows; the harness diffs exactly DIFF_TABLES.

### 1.5 FB_PARITY replacement (R6a removed it — not resurrected)

Nothing replaced its logging value inside the seam. Its value is replaced by
parity suites + this harness: parity suites assert fixed expectations per batch,
the harness diffs two live stacks per scenario. Saying so explicitly because
the scope asked: there is no seam logging mode anymore, and none is needed —
the harness IS the comparison tool.

## 2. Harness design

Tool: `docs/nextjs-strangler/phase5/shadow-harness.py` (Python, parity-suite
convention — it drives HTTP + sqlite, like the parity suites and the fixture
runner). Placement justification: it drives PHP and TS over HTTP and sqlite;
a TS placement under `apps/nextjs/scripts/` would still shell out to a
disposable PHP copy and duplicate the runner's Python machinery. Python under
`docs/nextjs-strangler/phase5/` follows the parity-suite convention and reuses
the runner's patterns directly.

CLI: `--scenarios FILE | --fixtures F... | --replay capture.jsonl`,
`--out DIR`, `--php-only` (capture mode: each scenario on PHP twice),
`--keep` (skip teardown).

Targets (harness-owned ports only, never the reference):
- Disposable PHP on :18081 (fixture-runner pattern, `APP_ENV=dev`, workers=4).
- Disposable TS on :3012 (`npx next start` from `apps/nextjs`, TZ=UTC, 35
  FB_TS_MODULES names, FB_DATABASE_PATH=scratch DB, FB_CONFIG_PATH=scratch
  config (reference config with data path rewritten), FB_PAYPAL_SKIP_VERIFY=1,
  FB_CALLBACK_SALT from reference config, FOSSBILLING_PHP_SRC=repo src).
- Safety: the harness refuses if any stack DB path resolves inside the
  reference data dir; every target is disposable under a fresh tmp dir
  (`~/scratch/fossbilling/r5-logs/shadow-run-<pid>/`), deleted in finally
  unless `--keep`. Reference ports are never touched; reference invariants +
  config hash are asserted by parity45 before AND after, never by the harness
  (it never touches the reference by construction, and prints disposable
  paths in every report).
- Teardown: SIGTERM wrappers AND fuser-kill of :18081/:3012 (a `next start`
  child survives SIGTERM of its wrapper — the first full run left :3012
  answering after exit; the fix is verified down after subsequent runs).

Session model — SINGLE JAR + LAZY LOGIN (the runner's model, §5 proves why):
one jar per stack run, primed once, logging in lazily the first time a step
needs admin/client, keeping that session for the rest of the run (a later step
for a different persona re-logs in on the same jar). Login envelopes are NOT
diffed (they carry tokens) but a failed login aborts the run. Session rows
are excluded from diffs.

Step execution: form-encoded POST with CSRFToken by default (flatten like the
runner), JSON + X-CSRF-TOKEN header if step `json=true`; save/subst semantics
copied from the runner (`$name` substitution, dotted save paths);
`allow_error` permits error envelopes; IPN steps post raw form to the stack
base (TS `/ipn.php` route; PHP disposable `/ipn.php`).

Envelope comparison: recursive, numeric tolerance (round to 2dp, the runner's
num_eq rule extended across the string/number boundary — PHP returns PDO
strings like currency_rate `'1'`, TS returns JSON numbers; booleans never
coerce, True ≠ 1), normalization applied first. `diff_fields` lists only the
dotted paths that REALLY differ post-normalization (raw dumps hide the real
difference behind normalized fields).

DB comparison: rows keyed by id per table; added/removed/changed field diffs
after normalization.

Money classification: an envelope diff on a money-method step (module in
{invoice, order, cart, transaction, subscription, product} or an ipn step),
OR any delta diff in a MONEY_TABLE, is a MONEY diff. Everything else
(email_queue notifications, invoice_event audit, client_order_status,
setting) is non-money. A money diff aborts cutover (D6-3); non-money diffs
are triaged (see shadow-criteria.md).

Capture format (JSONL, one request per line):
`{"n": i, "persona":..., "request": {"kind": "api", "role", "module",
"method", "params" (RESOLVED), "json"}}` or `{"kind": "ipn", "path",
"form"}`. The harness writes one capture per scenario run. `--replay`
re-runs a capture on both stacks (fresh restores + prime + lazy logins in
capture order; saves/subst NOT in captures because params are already
concrete) and diffs the same way.

Diff destination: the report JSON + per-scenario capture JSONL under the
harness `--out` dir (see shadow-criteria.md §2).

## 3. Read-only TS mode decision: SUBSUMED-BY-DISPOSABLE-DB (with proof)

D6-3's default is recompute-and-compare (no dual money effects). The scope
said R6b builds the read-only TS mode the default needs, or proves it
subsumed. Decision: **subsumed by disposable-DB comparison. No read-only
mode is built, and none is offered.**

Proof, per shadow use case:

- Fixture corpus: the harness runs all 13 fixtures on disposable TS + disposable
  PHP and diffs envelopes + DB deltas. TS writes land in its scratch DB, PHP
  writes land in its disposable DB, both are discarded after the run. This IS
  recompute-and-compare: the same money computation executes on both stacks,
  and the comparison is over results, not over a shared store. No read-only
  flag is needed for the comparison to be valid, because no production row is
  ever written by either side.
- Captured-log replay: a capture file (requests only, resolved params) replays
  against fresh disposable stacks the same way. The replay proof (§7) shows
  replay reproduces the live run's diff signature exactly. Again, writes land
  in scratch DBs and are discarded.
- One-cycle parallel run: the deployment execution (R6d checklist) runs a TS
  instance against a scratch DB fed from a production snapshot, alongside the
  authoritative PHP instance, for one full billing cycle, diffing with this
  harness's report format. The TS instance's writes are real writes — to a
  scratch DB that is discarded — which is exactly what recompute-and-compare
  requires. A read-only flag would make the TS instance's money code take a
  different path from production (compute-but-don't-write is not the code
  path being cut over), weakening the proof rather than strengthening it.

The one case where a read-only mode would still matter: **dry-run serving of
live traffic** — a TS instance answering real user requests without writing,
so users see TS-computed responses while PHP remains authoritative. That case
is OUT of R6b scope and handled otherwise, for three reasons: (a) D6-3 rejects
dual-write for double-billing risk, and dry-run serving is the mirror risk
(users acting on responses whose writes never landed — e.g. a shown-as-paid
invoice that PHP never marked paid); (b) no shadow mode in this design shares
a database with production — every comparison target is disposable by
construction, and a shared-DB dry-run mode would violate the harness's
central safety invariant; (c) the cutover case does not need it: fixture
shadow + captured-log replay + one-cycle parallel run (all disposable-DB)
cover the comparison surface, and D6-4 states the live-traffic window itself
is a deployment tap, not an R6b sandbox deliverable. If Josh ever wants
dry-run serving, it is a new design (response-only shadowing with explicit
no-write guarantees per handler), not a flag on this harness.

Scope wording refinement (justified above): D6-3's "R6b builds the read-only
TS mode the default needs" is refined to "R6b proves disposable-DB comparison
subsumes the read-only mode for every shadow use case, and offers no
shared-DB shadow mode." The default's substance — recompute-and-compare, no
dual money effects — is honored exactly.

Survey of what a genuine read-only mode would take (for the record, not
built): a flag threaded through `money.ts` (prepareInvoice/markInvoicePaid),
`invoice.ts` transaction/subscription/refund/debit paths, `order.ts`
activation, `cart.ts` checkout, and `cron.ts` — every money writer would need
a compute-only branch returning what it WOULD have written, plus a diffable
representation of those phantom writes. That is a second implementation of
every money path, diverging from the production path it is meant to validate.
The disposable-DB design avoids the divergence entirely: the production path
runs, against scratch data.

## 4. Scenario set + per-scenario results (final runs)

Scenarios: `docs/nextjs-strangler/phase5/shadow-scenarios.json` (7).
Final run `shadow-full-scen5`: ALL envelope diffs = 0 across all 7; money
flags False everywhere. Remaining DB diffs are non-money only:

| Scenario | Money | Remaining tables (non-money, triaged §8) |
|---|---|---|
| invoice-pay-refund (prepare → update 25 → issue → mark_as_paid gw 1 txn `shadow-txn-1` → refund → get) | False | invoice_event |
| invoice-pay-credits (seed balance 50 → prepare → update 30 → issue → pay_with_credits → get) | False | invoice_event |
| order-lifecycle (create product 9 1M → activate → renew → cancel → get) | False | client_order_status, email_queue |
| cart-checkout (logged-in client drives guest cart add → checkout) | False | email_queue, invoice_event |
| staff-basket-checkout TRIPWIRE (admin add_item client 1 id 3 → get → checkout gw 1 mark_invoice_paid true txn `shadow-staff-txn-1` → invoice get + order get) | False | invoice_event |
| cron-run (admin cron run, all 13 jobs) | False | email_queue, setting |
| gateway-ipn-form (prepare → update 25 → issue → IPN form post → transaction_get_list) | False | invoice_event |

TRIPWIRE RESULT: PASS. invoice/invoice_item/transaction/order rows all
matched, including the R5b money columns (base_income/base_refund/
currency_rate). No money diff on staff basket checkout. (findings-r5b.md §9's
gap — "no parity case runs a full staff basket checkout asserting the three
columns" — is now covered by this scenario.)

Fixtures through the harness (final run `shadow-fixtures3`): 13/13 with
envelope diffs = 0 and money flags False. 10/13 differ ONLY on invoice_event
(non-money, §8). The 3 cart fixtures differ on email_queue + invoice_event
only. No cart/cart_product diffs remain (see §5).

## 5. The single-jar lesson (a harness bug, not a TS bug)

The harness originally used per-persona jars with preamble logins. That broke
the fixture cart flow: guest steps ran on the anon jar, checkout on the client
jar, and neither PHP nor TS transfers a guest-session cart to a separately-
logged-in client session — the cart is session-bound. Both stacks failed
identically with empty-cart errors and created zero orders/invoices (kept run
`shadow-run-36731`: PHP orders≥180 = 0, invoices≥485 = 0, TS same). The
scenario "passed" vacuously: envelopes matched only because both errored.

Probe 1 (disposable PHP, single jar): prime → guest reset → guest add
(subtotal 10) → client login (same jar) → client checkout SUCCEEDS (order
182, invoice_hash returned), post-state carts empty (checkout deleted it).
Probe 2 (disposable PHP, single jar, login only): prime → client login
CREATES an empty cart row (id 319) for the new session — PHP login eagerly
creates a session cart; TS login does not (lazy). Consequence: the harness
now uses one jar per stack run with lazy login (the fixture runner's model:
`run-fixtures.py:197-258`, single `Jar()`, prime once, log in on first use of
a persona). The cart-checkout scenario was rewritten the same way: the
LOGGED-IN client jar drives the guest cart endpoints too (guest cart
endpoints are session-based, not auth-gated — a logged-in user hitting
storefront cart endpoints is a legitimate flow). Anonymous-add-then-login
cart migration is NOT covered by either shape (no shape covers it — the old
shape's only value was proving both stacks fail identically on orphaned
carts, recorded here as a note).

Baseline handling (decided explicitly): preamble = prime only, baseline
dumped after prime but before steps, so login side effects land in deltas —
acceptable because session rows are excluded, and the PHP login cart is
deleted by any checkout that uses it. The exact PHP call that creates the
login-time session cart is UNPROVEN (login Api Guest.php:236-266 shows
authorize + events + regenerateId + set client_id, no cart call; no
AfterClientLoginEvent cart listener found) — findings state it as observed
behavior (PHP login → empty cart row for the new session, proven by probe 2),
not attributed to a mechanism. Fixing TS to create a cart at login would be
guessing — NOT done.

## 6. Normalization list (proven by capture48, php-vs-php)

`capture48.py` + `captures48/` — PHP behavior OBSERVED, not assumed. Final
re-run `capture48d.log`: 20/20 scenarios clean (7 scenarios + 13 fixtures),
php-vs-php envelope diffs = 0, db tables with diffs = 0, on the FINAL harness
(single-jar). The normalization list is now proven against the rewritten
scenario set. Every normalized occurrence is named in the report
(`normalized_fields`); nothing is silently dropped.

VOLATILE_KEYS (10): hash, hash_expires_at, created_at, updated_at, due_at,
paid_at, reminded_at, last_cron_exec, group_id, ipn_hash — plus any key ending
in `_at` (all `*_at` fields are wall-clock stamps), plus embedded-string
scrubs (variable-length 30–60 hex invoice hashes; datetimes
`\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}` → `*TS*`), plus the transaction `ipn`
column's `$_SERVER` sub-object (replaced with `"*"`).

PHP evidence per item:

- Invoice hashes: `src/modules/Invoice/Service.php:1502` (and 4 other sites)
  `$model->setHash(bin2hex(random_bytes(random_int(15, 30))))` — RANDOM length
  30–60 hex, validated by Guest.php `/^[a-f0-9]{30,60}$/`. Hence the range
  scrub `\b[0-9a-f]{30,60}\b` → `*HASH*`, not fixed 32. Capture48 proved two
  PHP runs produce different-length hashes (40 vs 56 hex) for the same
  invoice.
- Datetimes in strings: invoice `notes` embeds "YYYY-MM-DD HH:MM:SS: Refund
  invoice #N generated." — wall-clock by construction.
- group_id: `src/modules/Order/Service.php:960`
  `$order->setGroupId($parentGroupId ?? uniqid())` — time-based random by
  construction.
- ipn_hash: `src/modules/Invoice/ServiceTransaction.php:882-890` `ipnHash` =
  sha256 of the canonical JSON of the ipn dump (normalizeIpn:868-877), and the
  dump INCLUDES `$_SERVER` — DOCUMENT_ROOT differs per harness tmp dir,
  REMOTE_PORT is ephemeral, REQUEST_TIME is wall-clock — so it varies across
  identical runs by construction. It is duplicate-detection metadata over a
  transport dump, not money signal; the money signal (status/error/
  error_code/invoice_id/gateway_id/amount) is compared separately. TS records
  server null in its dump, so TS-vs-PHP ipn_hash differs systematically too —
  normalized on both sides for the same reason. The `ipn` column's `server`
  sub-object is likewise replaced with `"*"` (TS records server null).
- `_at` suffix rule: every `*_at` field observed is a wall-clock stamp; the
  rule is principled, not per-field whack-a-mole.

NO money field is normalized: invoice/invoice_item/transaction/order/cart/
balance/subscription rows compare every field except the volatile keys above
(which are timestamps/hashes/ids, never amounts, statuses, or rates).
parity45 §(iv) asserts this from the harness report.

Harness bugs found and fixed during smoke testing (all in
`shadow-harness.py`, uncommitted): login-without-prime PHP 403 (jars must
prime before login — the fixture runner primes first); `normalize()` dead
`if False else` construction rewritten; datetime scrub; variable-length hash
scrub; seed_op saves discarded by `run_steps` (now merged, runner-style);
group_id + `_at` volatility; ipn `$_SERVER` normalization (and
`diff_deltas` now normalizes field values before comparing, not just
key-filter + string scrub); ipn_hash volatility; teardown orphan (next-server
child survives SIGTERM — now fuser-killed); guest jar never primed (PHP guest
cart 403s); disposable TS cron 503 (finalization state file not copied into
the TS disposable data dir — TS cron gate treats a MISSING file as closed;
fixed by copying reference `update-finalization.json`); numeric-string vs
number envelope diffs (PHP PDO strings vs TS JSON numbers — num_eq extended
across the boundary, booleans never coerce); `diff_fields` (only real
post-normalization differences listed).

## 7. TS fixes (in-batch, escalation rule — all with PHP evidence)

Eight fixes. The first seven were driven by harness runs 1–3; the eighth by
the single-jar fixture run (the orphaned-cart shape had hidden it).

1. **Route-level bracket expansion** (`seam-call.ts` new `expandBracketParams`,
   `route.ts` urlencoded branch sets `rawParams` from it; `dispatch.ts` doc
   comment updated). Root cause: TS route left `rawParams` EMPTY for
   urlencoded bodies (JSON body → rawParams = parsed object; urlencoded →
   params = flat literal keys like `new_item[price]`, rawParams = `{}`).
   Invoice `update` reads `new_item`/`items` from `ctx.rawParams`
   (invoice.ts:506/523), so form-posted nested params were silently dropped
   while returning success. PHP parses brackets natively into nested arrays.
   The helper mirrors cart.ts:844 `expandBrackets` semantics (empty brackets
   → next index; CSRFToken skipped; values stay strings, matching PHP form
   values). `params` keeps flat literal keys, so handlers with their own
   bracket fallbacks are unaffected (verified: `requestedCsvHeaders`
   csv.ts:44, `nestedObjectParam` invoice.ts:1135, `idsParam`
   invoice.ts:2812, `accepted_currencies` invoice.ts:3034, scalar
   `rawParams["x"] !== undefined ? rawParams : params` patterns cart.ts:1557,
   invoice.ts:1689, order.ts:254). Known limitation (not a regression):
   batch endpoints reading `ids` as an array still get an object for
   bracket-encoded ids (previously undefined → same empty outcome); not
   covered by harness scenarios.
2. **ipn.php route transaction fields** (`ipn.php/route.ts`, form + Stripe JSON
   paths). PHP evidence: `markTransactionError` (ServiceTransaction.php:
   717-732) sets status ERROR + error message + error_code = (int)$e->getCode();
   `manualApprovalException` (ServiceTransaction.php:836-843) returns code
   7002 for Custom (and other manual gateways); PHP's `create` leaves amount
   unset (NULL) until gateway processing fills it; PHP records request IP
   (REMOTE_ADDR). TS hardcoded amount `"0"`, ip null, and its catch persisted
   only status + error (dropping the 7002). Fix: amount `"0"` → null; ip null
   → derived request IP (same XFF-first-entry-or-127.0.0.1 derivation as the
   seam route, route.ts:128); catch persists `error_code` from the thrown
   FbError's code (7002 for manual approval; 9999 fallback for non-FbError).
3. **Credit/debit note numbering** (`db.ts` new `reserveNumericParamValue`,
   invoice.ts:1626 refund + :1733 debit). Harness proved TS refund minted
   credit-note nr 29 (MAX(nr)+1 over surviving CN notes) where PHP minted 3
   (the counter) and advanced it to 4; setting
   `invoice_cn_starting_number` (setting id 22) did not move on TS. PHP
   evidence: refund uses `reserveNextNumericParamValue(
   'invoice_cn_starting_number', 1)` (Service.php:1866); debit uses
   `invoice_dn_starting_number` (Service.php:2519); `reserveNextNumericParamValue`
   semantics (System/Service.php:813-921): return current int value, write
   current+1 (missing/non-numeric row seeds to `seed`, writing seed+1).
   Regular invoices already use the counter pattern in TS (`nextInvoiceNumber`,
   money.ts:100-109). Fix uses getSetting/setSettingValue→upsertSetting (missing
   rows created); NO max guard — PHP trusts the counter exactly.
   `nextNrForSerie` (db.ts:2187, MAX+1) is now unused by invoice.ts (import
   removed) but kept exported. This also fixed the pay-refund email content
   diff (CN-00003 vs CN-00029 in the credit-note email body).
4. **mark_as_paid transaction IP** (invoice.ts): TS inserted `ip: null`; PHP
   records the request IP. Fix: `ip: ctx.ip ?? null` (fallback for in-process
   fbCall callers that may not set ip).
5. **pay_with_credits item execution** (money.ts:470). Harness proved a custom
   line stayed `pending_setup` on TS after pay_with_credits where PHP marks it
   `executed`. PHP evidence: `tryPayWithCredits` (Service.php:1626-1700)
   calls `markAsPaid($invoice, false, false, true)` then, after commit,
   `executeInvoiceItemTasks(...)`; `executeTask` (ServiceInvoiceItem.php:
   132-205) marks TYPE_CUSTOM items executed unconditionally (line 202-205)
   and TYPE_DEPOSIT likewise (line 193-195); TYPE_ORDER items go through
   activate/renew task handling. TS `tryPayWithCredits` called only
   `markInvoicePaid` (which moves items pending_payment → pending_setup).
   Fix: after `markInvoicePaid`, mark custom + deposit items executed
   (`UPDATE invoice_item SET status='executed'... WHERE type IN ('custom',
   'deposit') AND status NOT IN ('executed','failed')`). Order-task items stay
   deferred to the activate_paid batch — preserving parity39 §8's pinned
   divergence for order items (its test items are all type "order", so §8
   assertions are unaffected).
6. **Cron batch paid-invoice activation** (invoice.ts:1975). Harness proved
   PHP cron executed 106 custom/void items of paid reference invoices
   (status → executed) while TS cron left them unchanged. PHP evidence:
   `doBatchPaidInvoiceActivation` (Service.php:4125-4165) executes EVERY
   non-executed item of every paid invoice (`getAllNotExecutePaidItems`:
   status NOT IN (executed, failed) AND invoice.status = paid); TS
   `runBatchActivatePaid` only handled pending_setup orders' activate-task
   items (with a 10-minute cutoff). Fix: after the existing order loop, TS
   batch now also marks custom + deposit items of paid invoices executed
   (same unconditional branches as fix 5). Order-task handling + cutoff
   untouched; renew-task execution remains a pinned gap. Stale batch comment
   at invoice.ts:1979 updated.
7. **Refund email original_invoice context** (invoice.ts refund path,
   non-money but small and adjacent). Harness proved TS's "Credit Note
   Issued" email rendered an empty "against invoice" slot where PHP renders
   FOSS00358. PHP template evidence:
   `src/modules/Invoice/templates/email/mod_invoice_refunded.html.twig:40`
   renders `{{ invoice.serie_nr}}` (the note) and
   `{{ original_invoice.serie_nr}}` (the original). TS
   `queueInvoiceEmail("mod_invoice_refunded", noteId)` passed only `{c,
   invoice}` (the note). Fix: `refundInvoiceCore` now passes
   `original_invoice: {serie_nr}` computed with the same formula as
   `invoiceEmailContext` (emailer.ts:163). Debit email context
   (mod_invoice_debited original_invoice var) was NOT compared (no debit
   scenario) — noted as uncompared, not fixed.
8. **Invoice subscribable rule** (invoice.ts, found by the single-jar fixture
   run — the orphaned-cart shape had hidden it because both stacks failed
   before reaching invoice get). The recurring fixture's invoice get differed
   ONLY in `result.subscribable` + `result.subscription`: PHP false/null, TS
   true/`{unit M, cycle 1, period 1M}`. PHP evidence: toApiArray
   (Service.php:484-493) sets `subscribable =
   getSubscriptionPeriod($invoice) !== null`; `getSubscriptionPeriodByInvoiceId`
   (ServiceSubscription.php:361-407) scans ALL lines by id — skips zero/
   negative lines, returns null if any positive line has an empty period or
   if positive periods differ, else the single period. The recurring
   checkout's setup line (positive price, no period) therefore makes the
   invoice NOT subscribable. TS's rule was "exists an order-type line with a
   period" (invoice.ts:219 + :355) — wrong. Fix: new pure
   `subscriptionPeriodForItems(items)` implementing PHP's rule exactly, used
   at both array sites; the existing `subscriptionPeriodForInvoice`
   (payment path, already correct — its comment even says "Deliberately NOT
   the type-filtered invoiceArray subscription") now delegates to it.
   Note: PHP's result OMITS the `subscription` key when not subscribable
   (it is not null — the earlier read of `.get()` as null was a misread);
   TS likewise omits it now, so the shapes match.

## 8. Triaged non-money diffs (NOT fixed — not money-table diffs, escalation rule does not require fixing them)

- **invoice_event shape (all scenarios + 10 fixtures):** PHP logs more events
  with full buyer/seller snapshots and actor ids (admin_id/client_id = 1); TS
  logs fewer events (no 'created' event; first event is 'issued') with minimal
  snapshots (`{"serie_nr":"FOSS358","status":"unpaid","issued":true}`,
  `{"status":"paid"}`, `{"status":"refunded"}`) and NULL actor ids. Also
  serie_nr padding: PHP "FOSS00358"/"FOSS00489" (zero-padded to 5) vs TS
  "FOSS358" (unpadded) in event snapshots. Note: the harness `added`
  comparison keys rows by id, so PHP's created/updated/issued/paid/refunded
  sequence misaligns against TS's issued/paid/refunded sequence by position —
  describe it as "PHP logs created+updated+issued+paid(+refunded); TS logs
  issued+paid(+refunded) with minimal snapshots", not as row-by-row field
  diffs. invoice_event is NOT a money table.
- **client_order_status extra row (order-lifecycle):** TS writes an extra
  `pending_setup` / "Order Created" row at order create; PHP writes no status
  row at create (its first row is active/"Order activated"). Subsequent rows
  shift by one id. Non-money audit table.
- **Order lifecycle emails missing on TS (order-lifecycle):** PHP queues 3
  emails (subjects "[Company Name] Phase3 Recurring Widget Activated",
  "... Renewed", "... Canceled", all status pending); TS queues 0. TS
  `activate` (order.ts:426) is just `activateOrderRow` + return true, with no
  email send; same for renew/cancel presumably. Non-money notification gap;
  candidate for a later batch (needs template-code survey).
- **Checkout "New Order Placed" email missing on TS (cart-checkout):** PHP
  queues "Invoice Created" + "New Order Placed" (2); TS queues only "Invoice
  Created" (1). Same notification family as above.
- **Cron email send-status transport diff (cron-run):** 5 pending queue rows
  (ids 463–467): PHP marks them `sending` (priority null, tries null); TS
  marks them `failed` (priority 0, tries 1). Cause: disposable TS has no SMTP
  configured (nodemailer fails) while PHP mail() "succeeds" in the sandbox.
  Triaged as non-money transport diff: queue ROW CREATION is compared; send
  STATUS is environment-dependent. Follow-up idea (NOT done): wire the R5e
  mock SMTP (:18025) into the harness's disposable TS so send outcomes
  compare — a harness enhancement, not required for the money proof.
- **last_cron_exec setting row typing (cron-run):** PHP inserts `public` NULL;
  TS inserts `public` 0 (via upsertSetting default). Trivial non-money typing
  diff; changing the upsertSetting default would ripple across all TS setting
  writes, so triaged, not fixed.
- **Cart-lifecycle classifier case (run 3, resolved by run 4/5):** PHP delta
  showed `cart.removed {319}`; TS showed no cart delta. Analysis: PHP's
  post-login baseline contains a session cart (319); TS's does not (TS creates
  carts lazily). At checkout both stacks delete the checked-out cart, so
  POST-checkout end states are identical (zero carts for the session on both
  sides; no cart_product diff). The delta differed only because the BASELINES
  differ. The money signal matched exactly. The classifier is conservative
  (cart ∈ MONEY_TABLES, so any cart delta flags money); this instance was
  triaged non-money with end-state equivalence proof. In the final runs
  (scen5, fixtures3) NO cart diffs remain at all — the single-jar checkout
  deletes the cart on both sides — so the rule's conservatism costs nothing
  here, and the rule is kept as-is (see shadow-criteria.md §4 for the
  triage procedure that governs such cases).

## 9. R6b/R6c boundary

Relocation/deletion untouched. The oracle is still live for comparison through
R6c per D6-1. GeoIP DBs are still read from repo `src/` at runtime (R6c
relocates them + content.sql + email templates; FB_GEOIP_DB_DIR must then be
set). Fork `src/`, composer.*, PHP Dockerfile stages, PHP themes, `tests/`
Pest disposition, and the Next deployment definition are all R6c items, not
touched here. R6d items (rollback artifact tagging + retention, cutover
checklist, D6-9 Postgres gate, shadow-criteria-met-or-waived gate) are
deployment taps, not R6b deliverables.

## 10. What is left for later

- Live-traffic window execution + one-cycle parallel run execution (Josh's
  infra taps; R6d checklist gates on them — see shadow-criteria.md §6).
- R6c relocation + deletion; R6d rollback artifact + cutover checklist.
- Order lifecycle emails + checkout "New Order Placed" email (notification
  gap, §8) — later batch candidate.
- invoice_event shape gap (created event, snapshots, actor ids, serie_nr
  padding) — later batch candidate; audit-only, not money.
- Cron mock-SMTP wiring for disposable TS (send-status comparison) — harness
  enhancement candidate.
- Debit email context (mod_invoice_debited original_invoice var) — uncompared
  (no debit scenario), not fixed.
- Order-task immediate execution on credit payment (vs deferred to
  activate_paid batch with 10-min cutoff) and order renew-task execution in
  the batch — remain pinned gaps (parity39 §8/§9 document them; harness
  scenarios do not cover order-task credit payment).
- Anonymous-add-then-login cart migration — not covered by any harness shape
  (both stacks fail identically on orphaned carts; §5).
- Live verification items standing from before R6b (unchanged): Stripe success
  path, live eNom, live currency refresh, live provider verification, gated
  seo/serviceapikey/cookieconsent active paths, R2d/R2e/R4b form click-through,
  R3c live Postgres proof.

## 11. Regression chain (final, 2026-10-31)

parity45: 171/171 (see §4–§7 for what it proves; its first run exposed two
suite bugs, both fixed in the suite, not the harness: `invoice_starting_number`
is a setting row, not a table; PHP returns HTTP 404 with a 740 envelope for
unknown API methods, so :8080 health must be TCP-connect, not HTTP 200; and
the harness exits 1 whenever ANY diff exists, so "ran successfully" means a
report was written, not exit 0).

Full chain (chain4 + clean re-runs, after a VM restart and a concurrent-run
incident — see below): tsc clean; build clean ("Compiled successfully in
9.5s"); parity44 77/77, parity43 16/16, parity42 73/73, parity41 130/130,
parity40 OK (120), parity39 212/212, parity38 86/86, parity37 green,
parity36 51/51, parity35 210/210, parity34 164/164, parity33 77/77,
parity32 65/65, parity31 63/63, parity30 179/179, parity29 62/62,
parity28 128/128, parity27 27/27, parity26 62/62, parity25 203 checks green,
parity21 194/203 with exactly the known 9 diffs; fixtures 13/13 both stacks
(results JSONs all status PASS); accounting exit 0, 548+31+0=579; reference
invariants clean after (cart 283, invoice 323, orders 11, queue 67,
invoice_event 776, counters 0), config hash 6e3c529673c1d089; :3001 answering
after; :8081/:18025/:18026/:3003/:18081/:3012 all DOWN at batch end; no
shadow-run-* tmp dir left.

Incident during the chain (disclosed, not hidden): a VM restart at 15:48
killed both reference servers mid-chain; the first chain's parity43 survived
the kill of its chain shell and ran CONCURRENTLY with the second chain,
poisoning parity44 ("readonly database"), parity43 (installer 2 FAIL +
cart_seq drift), parity42 (":3003 down" — the killed parity40's forced
:3003 next-server child survived its parent, the known orphan pattern),
and parity41 ("counters empty before" — a single api_guest probe row,
tokens 99/100, from parity42's own :3003 probe). Cleanup, all backup-first:
deleted login-created empty cart 321 (0 products, PHP client session) and 2
rate_limit_counter rows from the killed parity40 run; cart count restored to
283. Cart sequence is a high-water mark and moved 318 → 323 across the
incident (killed runs' PHP logins); count 283 is the invariant, and no suite
pins the sequence exactly (parity44 §0 prints it as informational only).
The chain script now fails fast if any suite process is already running.
parity42/41 content had passed in the poisoned run (72/73 and 129/130 with
only the environment checks failing) and both pass clean on re-run.
