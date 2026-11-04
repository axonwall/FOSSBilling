# Findings — Phase 5 batch: money goldens (D6-1 third exit criterion)

**Batch:** money goldens — generation + review. This batch satisfies
D6-1's third exit criterion (money-path goldens generated AND
reviewed). It does NOT execute oracle deletion (D6-2): that remains
a separate later decision (see §6). It does NOT commit, push, or
modify `runtime/` — the frozen oracle was read (snapshot copies)
and never written.

**HEAD:** `8be5ab7` (R6d) plus the uncommitted working tree listed
in §4 — the goldens were recorded against HEAD **plus** the two
in-batch fixes, not bare HEAD. Every golden file records this in
its metadata (`ts_commit` + `ts_worktree_dirty_files` +
`ts_worktree_note`), so a future reader is not misled.

**Tools:** `generate-goldens.py` (generator),
`golden-scenarios.json` (9 scenarios), `goldens/` (19 golden
files), `review-goldens.py` (PHP-review step), `parity48.py`
(replay runner). The harness reused throughout is R6b's
`shadow-harness.py` + `shadow-criteria.md` (table set,
normalization, money classifier, abort rule).

## 1. The golden set — definition with reasoning

Money paths ONLY (D6-1: goldens for money paths, TS-only
elsewhere). One file per golden under `goldens/` (19 files, 372K
total — per-golden files so a diff is reviewable and regeneration
is surgical; a single file would be unreviewable). Each file holds:
normalized envelopes per step, normalized DB deltas on
DIFF_TABLES (the 9 MONEY_TABLES + 5 dependents, unchanged from
shadow-criteria — NO table added, NO table dropped), the resolved
request capture, the input scenario (steps + seeds — parity48
replays from this, not from the capture; see §3), metadata, and
`php_review`.

### 1a. The 9 scenario goldens

Every R6b scenario verbatim (same steps, same seeds), plus two
new ones built by probing (see §4):

| Golden | Money steps | R6b fix it pins |
|---|---|---|
| invoice-pay-refund | prepare → update 25 (bracket form) → issue → mark_as_paid gw 1 txn shadow-txn-1 → refund → get | fix 1 (bracket expansion, via the form update), fix 3 (CN counter), fix 4 (mark_as_paid ip), fix 7 (refund email original_invoice context) |
| invoice-pay-credits | seed balance 50 → prepare → update 30 → issue → pay_with_credits → get | fix 5 (pay_with_credits item execution) |
| order-lifecycle | create product 9 1M → activate → renew → cancel → get | order money lifecycle (totals/statuses through activate/renew/cancel) |
| cart-checkout | guest cart reset → add item 3 → get → checkout gw 1 → invoice get by hash | cart checkout money flow |
| staff-basket-checkout | staff add item 3 → get → checkout gw 1 mark_invoice_paid → invoice get + order get | R5b §9 tripwire (base_income/base_refund/currency_rate) |
| cron-run | admin cron run (all 13 jobs) | fix 6 (cron batch activation of paid-invoice items) |
| gateway-ipn-form | prepare → update 25 → issue → IPN form post gw 1 → transaction_get_list | fix 2, form path (amount NULL-until-processing, request IP, error_code 7002 manual-approval park) |
| invoice-debit-note (NEW) | prepare → update 25 → issue → debit [{title, price 10, qty 1}] → note get | fix 3, debit side (DN counter) + the bracket-array fix + debit-email original_invoice context (both §4 fixes) |
| invoice-paypal-form (NEW) | prepare → update 25 → issue → get (hash) → guest payment gw 2 | PayPalEmail gateway form generation (no live call) |

Envelope fields compared: the full envelope per step (money
methods included), modulo the R6b normalization (§3). DB tables +
columns compared: all DIFF_TABLES rows, every column except the
volatile keys — amounts, statuses, rates, and counts are never
normalized. **Hard rule, re-asserted by parity48 §C: NO money
field is ever normalized; VOLATILE_KEYS ∩ money fields = ∅. If a
money field ever turns out volatile, that is a finding, not a
normalization.**

### 1b. The 10 fixture goldens

The fixture corpus's money outputs, insofar as they add coverage
beyond §1a (harness `--fixtures` translation, same steps/seeds
the fixture runner uses):

| Golden | Why it adds coverage |
|---|---|
| invoice-mixed-taxed-and-untaxed-lines | taxed + untaxed lines on one invoice at 10% TX tax — no scenario seeds tax rules |
| invoice-quantity-and-rounding | 33.33 × 3 rounding (phpFloat precision-14) — no scenario exercises rounding |
| cart-promo-percentage | 10% promo applied at checkout — no scenario uses a promo |
| cart-recurring-with-setup-checkout | setup-fee + recurring checkout; the invoice get pins fix 8 (subscribable ALL-lines rule: the setup line has no period, so the invoice is NOT subscribable) |
| tax-state-beats-country-and-global, tax-country-rule-when-no-state-match, tax-global-fallback, tax-no-rule-means-zero, tax-exempt-client-pays-none, tax-disabled-globally (6) | tax rule SELECTION changes invoice totals (money). Each fixture is a distinct selection branch; none is covered by a scenario |

### 1c. Deliberately EXCLUDED — what is out, and why

Fixture exclusions (duplicates, stated not assumed):
- `cart-once-product-checkout` — duplicates cart-checkout (same
  product 3, gateway 1, checkout flow; only the get role differs).
- `pay-with-credits-consumes-balance` — byte-identical steps and
  seeds to invoice-pay-credits.
- `mark-as-paid-via-custom-gateway` — a strict prefix of
  invoice-pay-refund (prepare/update/issue/mark_as_paid/get);
  the refund golden's delta is a superset.

Money-shaped exclusions (each probed or proven, none hand-waved):
- **Stripe success path** — NOT golden-recordable in the sandbox.
  The adapter header states it outright (success paths call the
  live Stripe API; external fetch fails at the TLS layer), and it
  is a standing unverified-live item from before R6b. Marking it
  here, not faking it. What would verify it: a live Stripe test
  run (or a Stripe mock the adapter can point at) + a recorded
  success-path golden.
- **Stripe JSON webhook path** (fix 2's JSON side: amount NULL /
  ip / error_code on webhook transactions) — NOT expressible in
  the harness: ipn steps are form-only with no header support,
  and Stripe verification needs a `stripe-signature` HMAC header
  (test webhook secret). The form path of fix 2 IS golden-covered
  (gateway-ipn-form). What would verify the JSON side: harness
  ipn steps extended to JSON bodies + headers, then a signed
  `payment_intent.succeeded` event golden.
- **ClientBalance gateway** — no gateway row exists in the
  reference install (pay_gateway rows are Custom 1, PayPalEmail 2,
  Stripe 3-test-mode only), and PHP gives ClientBalance no getHtml
  path (adapter header). Its money path IS covered by
  invoice-pay-credits (`pay_with_credits`).
- **batch_pay_with_credits (ids shape)** — probed, found
  DIVERGENT, excluded, flagged (§5): PHP's
  `doBatchPayWithCredits($data)` is filter-based (all qualifying
  unpaid invoices, optional client_id filter; returns bool true),
  while TS implements an ids-based per-invoice map. The probe
  proved it (PHP paid a pre-existing reference invoice and
  returned true; TS paid the two new invoices and returned a
  map). Fixing it means reimplementing PHP's semantics — a
  handler rewrite, not a golden. Single-invoice
  `pay_with_credits` IS covered (invoice-pay-credits).
- **Partial refund (map shape)** — probed, found DIVERGENT,
  excluded, flagged (§5): PHP's `resolveRefundLines` iterates
  items as an id→qty MAP (`foreach ($items as $id => $qty)`),
  while TS's refund takes an id-valued list (or null for maps,
  i.e. a silent FULL refund). The probe proved it (PHP errored
  "Invoice line #0 was not found" on a scalar-id list; TS
  refunded). Partial-quantity refunds are already documented
  deferred in TS. Full refund IS covered (invoice-pay-refund).
- **Anonymous-add-then-login cart migration** — no successful
  money flow exists to record: R6b §5 proved both stacks fail
  identically on orphaned guest carts. The covered cart shape is
  the single-jar flow (cart-checkout).
- **Invoice PDFs** — binary derived artifacts, compared
  indirectly via rows per shadow-criteria §1.3 (byte comparison
  would fail on renderer differences for identical content).
- **Order-task credit payment / renew-task batch execution**
  (parity39 §8/§9 pinned gaps) — NOT frozen by any golden: the
  goldens' credit-payment steps use custom lines, never order
  lines, so no golden records the deferred-to-activate_paid
  behavior. Stating this so a future reader does not mistake
  golden coverage for gap closure.

### 1d. Gateway coverage map

- Custom (gw 1): invoice-pay-refund, staff-basket-checkout,
  cart-checkout, gateway-ipn-form — mark_as_paid, checkout, and
  IPN form paths.
- PayPalEmail (gw 2): invoice-paypal-form — form generation.
- Stripe (gw 3, test-mode): NOT covered — success path needs the
  live API; webhook path needs harness header support (see §1c).
- ClientBalance: no gateway row; covered via pay_with_credits.

## 2. Generation record

- Generator: `generate-goldens.py`, one disposable TS instance
  (`next start` on :3012) on a scratch DB copy of the reference
  snapshot. The generator asserts its TS DB path lives under its
  own work dir and is not inside the reference data dir, and
  refuses to run if :3012 is already up (no concurrent
  DB-mutating suites).
- Goldens generated 2026-11-01 against HEAD `8be5ab7` + the §4
  working tree. Reference config hash at generation:
  `6e3c529673c1d089` (unchanged before/after; parity48 §A/§E).
- Determinism: two full generation runs produced IDENTICAL
  compared payloads (envelopes + deltas + payload_sha256) for
  19/19 goldens. The stored `capture` differs in exactly 4
  goldens (cart-checkout, cart-promo-percentage,
  cart-recurring-with-setup-checkout, invoice-paypal-form) and
  ONLY in the resolved invoice-hash param — random per run by
  construction (the same reason hash ∈ VOLATILE_KEYS). Capture
  is an audit artifact, not compared content, and is excluded
  from the determinism comparison by design (generator docstring
  states this). A first, vacuous determinism check (empty glob
  from a backgrounded `cd`) was caught and re-run properly —
  the re-run is what this paragraph reports.
- Generator bug found and fixed during this batch: `payload_sha`
  hashed the pre-serialization payload, where delta row keys are
  ints; after the JSON round-trip they are strings, and
  `sort_keys` orders ints numerically but strings
  lexicographically — cron-run's hash (mixed small + 3-digit
  changed-row ids) was unreproducible from the file. Fixed by
  round-tripping through JSON before hashing; all 19 stored
  hashes now verify from the files alone (parity48 §C
  re-verifies every run). Same int/str class bit parity48's
  first run in `diff_deltas` (fixed the same way: round-trip the
  fresh delta before diffing).

## 3. Per-golden review table (TS-vs-PHP, harness evidence)

Review method: the R6b harness run TS-vs-PHP for the same steps
— scenarios report `goldens-review-scen/report.json`, fixtures
report `goldens-review-fix/report.json` — then
`review-goldens.py` filled each golden's `php_review` from those
reports. Result: **envelope diffs 0 and money_diff False for
19/19 goldens; 0 DIFFERS, 0 MISSING.** No golden required a
DIFFERS disposition, so the escalation rule's fix-or-flag branch
was never triggered by the golden set itself (the two flagged
divergences in §5 came from probes OUTSIDE the set).

Verdict taxonomy (machine-readable in each golden file):
- AGREES-WITH-PHP: envelope 0, money False, NO db tables differ.
  Count: **0** — not because money disagrees, but because every
  invoice-creating flow carries the known invoice_event shape gap
  (below), so no golden is table-clean.
- TRIAGED-DIVERGENCE: envelope 0, money False, db tables a
  subset of the triaged non-money set, each with its findings-r6b
  §8 reason recorded in the golden. Count: **19**.
- DIFFERS: **0**. KNOWN-PHP-BUG as a standalone verdict: **0**
  assigned — see the note below the table.

| Golden | Verdict | Diff tables (triaged) |
|---|---|---|
| invoice-pay-refund | TRIAGED-DIVERGENCE | invoice_event |
| invoice-pay-credits | TRIAGED-DIVERGENCE | invoice_event |
| order-lifecycle | TRIAGED-DIVERGENCE | client_order_status, email_queue |
| cart-checkout | TRIAGED-DIVERGENCE | email_queue, invoice_event |
| staff-basket-checkout | TRIAGED-DIVERGENCE | invoice_event |
| cron-run | TRIAGED-DIVERGENCE | email_queue, setting |
| gateway-ipn-form | TRIAGED-DIVERGENCE | invoice_event |
| invoice-debit-note | TRIAGED-DIVERGENCE | invoice_event |
| invoice-paypal-form | TRIAGED-DIVERGENCE | invoice_event |
| invoice-mixed-taxed-and-untaxed-lines | TRIAGED-DIVERGENCE | invoice_event |
| invoice-quantity-and-rounding | TRIAGED-DIVERGENCE | invoice_event |
| cart-promo-percentage | TRIAGED-DIVERGENCE | email_queue, invoice_event |
| cart-recurring-with-setup-checkout | TRIAGED-DIVERGENCE | email_queue, invoice_event |
| tax-state-beats-country-and-global | TRIAGED-DIVERGENCE | invoice_event |
| tax-country-rule-when-no-state-match | TRIAGED-DIVERGENCE | invoice_event |
| tax-global-fallback | TRIAGED-DIVERGENCE | invoice_event |
| tax-no-rule-means-zero | TRIAGED-DIVERGENCE | invoice_event |
| tax-exempt-client-pays-none | TRIAGED-DIVERGENCE | invoice_event |
| tax-disabled-globally | TRIAGED-DIVERGENCE | invoice_event |

Triaged-table reasons (findings-r6b §8, recorded per golden):
- invoice_event: PHP logs created+updated+issued+paid(+refunded)
  with full buyer/seller snapshots + actor ids; TS logs
  issued+paid(+refunded) minimal, NULL actors, unpadded serie_nr
  in snapshots. Audit-only, not a money table.
- email_queue (order-lifecycle, cart flows, cron-run): order
  Activated/Renewed/Canceled + "New Order Placed" notifications
  PHP queues and TS does not (notification gap, later batch);
  cron-run's email_queue diff is send-STATUS only (PHP `sending`
  vs TS `failed`, disposable TS has no SMTP — transport, not
  money; row creation matches).
- client_order_status (order-lifecycle): TS writes an extra
  pending_setup row at create; PHP's first row is active.
- setting (cron-run): last_cron_exec typing (PHP public NULL vs
  TS 0 via upsertSetting default).

On KNOWN-PHP-BUG flags: no golden in this set freezes a known
PHP bug as its recorded behavior, so none carries that flag.
Three items a future reader might expect here, stated plainly:
- The pre-existing `base_refund` 0 on reference invoice 1
  (findings-r5b) is BASELINE state, not golden content: goldens
  record deltas vs a snapshot baseline, and no golden's delta
  asserts that value. It is not frozen by this batch.
- The parity39 §8/§9 order-task gaps are NOT in any golden (§1c).
- The cron golden's own delta DOES contain 60 invoice_event
  rows — that is TS cron behavior (the `invoice_journal_heal`
  job backfilling one event per journal-less invoice), and the
  harness proves PHP's equivalent heal produces the same rows
  normalized: cron-run's harness diff tables are email_queue +
  setting only. A golden delta is TS-side effects; a harness
  diff is TS-vs-PHP disagreement. Do not read the 60 rows as a
  PHP disagreement.

## 4. In-batch TS fixes (escalation rule: money diffs fixed with PHP evidence)

This batch changed TS source — so the regression standard is
the FULL chain (§7), not just parity48. Both fixes were found by
golden probes, both have PHP evidence, both are covered by a
golden in this set.

### Fix 1 — Bracket expansion now yields real arrays (seam-call.ts, cart.ts)

- Probe: form-posted debit (`items[0][title]...`) — PHP minted
  note 490; TS answered "Debit items are missing" (9998).
- Root cause: `expandBracketParams` (and cart's `expandBrackets`
  copy) built plain objects with "0"/"1" keys for indexed
  brackets, never arrays. PHP parses `items[0][...]` into a list
  natively; `Admin::debit` requires an array and calls
  `array_values($items)` (Admin.php:226-237).
- Fix: a post-order pass converts any object whose keys are
  exactly 0..n-1 (canonical integers) into a real array. The
  rule is conservative by construction: update's `items` are
  DB-id-keyed (e.g. items[490]) and never form a 0..n-1 sequence,
  so update behavior is untouched; `new_item`, theme `client`,
  and other string-keyed maps are untouched. Side effects in
  the PHP-faithful direction: support `batch_delete` ids and
  invoice `batch_pay_with_credits` ids now parse as arrays on
  form posts (both previously required arrays and got objects);
  refund `items` as an id-valued list now parses as an array
  (its map-shape divergence in §5 is separate and remains).
- Re-probe after fix: debit env 0, money False, remaining diff
  invoice_event only. `npm run build` clean, `tsc --noEmit` clean.

### Fix 2 — Debit email original_invoice context (invoice.ts)

- Probe (after fix 1): debit email_queue content differed —
  TS rendered an empty "against invoice" slot where PHP renders
  FOSS00358. This is the exact item R6b §10 left as "uncompared,
  not fixed" (no debit scenario existed then); this batch's
  debit golden compared it.
- PHP evidence: `mod_invoice_debited.html.twig:40` renders
  `{{ original_invoice.serie_nr }}`. TS `queueInvoiceEmail`
  was called without that var.
- Fix: mirror the R6b refund fix — pass `original_invoice:
  {serie_nr}` with the same padded formula. Re-probe: debit
  email_queue matches; remaining diff invoice_event only.

## 5. Flagged for a later batch (probed divergences, NOT goldens, NOT fixed here)

Per the escalation rule these are flagged with full evidence,
never silently recorded and never normalized away. Neither
blocks the golden set (neither is in it), but both are real
TS-vs-PHP money divergences a future batch owns:

1. **batch_pay_with_credits semantics.** PHP:
   `doBatchPayWithCredits($data)` → `findAllUnpaid($data)` (all
   qualifying unpaid invoices, optional client_id filter) →
   bool true (Service.php:3761-3792, 4568-4592). TS: ids array →
   per-invoice map (invoice.ts:653-665). Probe evidence:
   harness run `golden-probe4` (probe-batch-credits): PHP
   returned true and paid a pre-existing reference invoice;
   TS returned `{489: true, 490: true}` and paid the two new
   invoices. Fix shape is a handler rewrite (PHP semantics +
   bool return), out of golden-batch scope.
2. **Partial-refund items shape.** PHP `resolveRefundLines`
   iterates items as id→qty MAP (Service.php:2384-2387). TS
   refund takes an id-valued list, or null for maps (silent
   full refund). Probe evidence: harness run `golden-probe4`
   (probe-partial-refund): PHP errored "Invoice line #0 was
   not found" on a scalar-id list; TS issued a credit note.
   Partial-quantity refunds are already documented deferred in
   TS; a full fix is qty-aware refund core, out of scope here.

## 6. D6-1 status after this batch

- (1) R6c green — MET (unchanged).
- (2) One clean full-chain run against the frozen oracle — MET
  (the R6c chain; this batch's full chain in §7 re-proves it
  on the fixed tree).
- (3) Money-path goldens generated AND reviewed — **MET (this
  batch)**: 19 goldens, parity48 19/19 MATCH, review 0 DIFFERS.
- **Oracle deletion is STILL a separate later decision.**
  D6-1's criteria being met does not approve deletion: deletion
  needs Josh's explicit tap, AND the parity suites' PHP side
  must be repointed at goldens (or retired) BEFORE `runtime/`
  is deleted — deleting first would orphan every suite's PHP
  comparison. `cutover-checklist.md` G5 was updated to say
  exactly this (and no other gate was touched — see §7).
- Cutover as a whole is STILL NOT approved: G2 (live window +
  one-cycle parallel run), G4 (artifact build + push + digest),
  and G3-conditional (R3c if production runs Postgres) remain
  outstanding infra taps, plus the open decisions (TZ=UTC,
  D6-6 external-consumer confirmation). "Goldens done" must not
  be read as "cutover approved".

## 7. Regression standard — results

Because §4 changed TS source, the standard is the FULL chain
(all run 2026-11-01 on the fixed tree, sequentially, never
concurrently; reference :3001 restarted onto the final build
before the parity runs that need it; logs under `r5-logs/`):

- parity48: **201 passed, 0 failed; 19/19 MATCH; 0 SKIPs**
  (log `parity48b.log`). §A invariants clean before, §E
  invariants + config hash clean after, :8080 + :3001 answering
  at end, :8081/:18025/:18026/:3003/:18081/:3012 DOWN.
- parity47: **86 passed, 0 failed**.
- parity46: **21 passed, 0 failed, 2 labeled skips** (A0:
  git-show cross-check, HEAD has no src/ post-R6c, manifest-only
  mode; C6: pg-mem structural proof, covered by parity43 §B
  in-chain).
- parity45: **171 passed, 0 failed** (the harness still works —
  goldens build on it).
- parity44: **77/77 passed**.
- parity43: **16 PASS, 0 FAIL**, including §B installer-test:
  **119 PASS, 0 FAIL, 2 SKIP**.
- parity42: **73/73 passed**.
- parity41: **130/130 passed**.
- parity40: **120/120 passed**.
- parity39: **212 checks, 0 failures**.
- parity38: **86 checks, 0 failures** — with the documented
  precondition honored: parity38 expects an externally started
  prod PHP oracle on :8081 (no APP_ENV, same src dir + DB);
  the first run failed connection-refused because :8081 was
  down, so the oracle was started, parity38 re-run green, and
  :8081 killed afterwards (R6c's lesson: parity38 leaves :8081
  to the operator).
- parity37: **115 pass, 0 fail, 0 skipped**.
- parity36: **51 checks, 0 failures**.
- parity35: **211 checks, 0 failures** — the brief's "210" is
  the October run's count; the income-series section is
  date-windowed, and today's window covers 2026-10-30/10-31/
  11-01 vs October's 2026-09-30/10-01 (diffed line-by-line
  against the old log: only the series dates moved). 0
  failures in both.
- parity34: **164 checks, 0 failures**.
- parity33: **77 checks, 0 failures**.
- parity32: **65 checks, 0 failures**.
- parity31: **63 checks, 0 failures**.
- parity30: **179 checks, 0 failures**.
- parity29: **62 checks, 0 failures**.
- parity28: **128 checks, 0 failures**.
- parity27: **27 checks, 0 failures**.
- parity26: **62 checks, 0 failures**.
- parity25: **203 checks, 0 failures, ALL GREEN**.
- parity21: **203 cases, 194 match, 9 diff — the diff set is
  byte-identical to the known 9** (diffed against the prior
  run's diff list: same 9 ids, no new diff, none missing).
- Fixtures: **13/13 on the PHP stack, 13/13 on the Next
  stack** — with :3001 killed first (the runner starts its
  own :3001) and :8081 free, per the standing lesson; the
  reference :3001 was restarted afterwards.
- endpoint-accounting.py: exit 0, **548+31+0** (goldens + fixes
  change no handler count).
- Reference invariants + config hash `6e3c529673c1d089`
  unchanged before AND after every suite in this batch;
  final verification after the chain: invariants CLEAN,
  :8080 + :3001 answering, :8081/:18025/:18026/:3003/:18081/
  :3012 DOWN.

## 8. Goldens maintenance rule (the goldens' whole point)

- While `runtime/` still exists: when TS money code changes,
  regenerate the goldens AND re-review them against PHP with
  the harness. A replay diff after a money change is either a
  regression (fix the code) or an intentional behavior change
  (regenerate + re-review with justification in a findings
  update) — never a hand-edit to the golden file (parity48 §C
  fails a hand-edited golden on payload_sha256).
- After `runtime/` is gone (separate later decision, §6):
  goldens become the only PHP-agreement evidence. Regeneration
  then is TS-only (record + review against the previous
  golden, with justification) — the PHP review half can never
  be repeated, which is why the review in §3 is stored in each
  golden file, not just in this doc.
- The cron golden is date-sensitive in principle (cron jobs
  read wall-clock due windows), though deterministic from a
  fixed snapshot: if a future replay diverges on cron-run only,
  regenerate + re-review it first before suspecting a money
  regression — and say so in the report.
- Excluded paths (§1c) stay excluded until their stated
  verification exists; do not add a golden for them by
  weakening a comparison.

## 9. What is left for later

- Oracle deletion decision + execution (Josh's tap; suites
  repointed first) — §6.
- The two flagged divergences in §5 (batch_pay_with_credits
  rewrite; qty-aware partial refund).
- Stripe success + Stripe webhook goldens (live Stripe or a
  mock; harness JSON+header ipn steps) — §1c.
- Order-lifecycle + checkout notification gaps (TS queues
  fewer order emails than PHP) and the invoice_event shape gap
  — pre-existing triaged items, unchanged by this batch.
- The uncommitted working tree (§4 fixes + this batch's files)
  is intentionally uncommitted per the batch brief; committing
  it is a separate decision. When it IS committed, the goldens'
  `ts_commit` should be re-recorded (or the goldens
  regenerated) so the metadata points at the committed tree
  rather than HEAD-plus-working-tree.

## 10. Comparison-side fix (2026-11-04) — parity48.py ONLY, no golden payload touched

Why this section exists: the goldens batch's replay proof did not
reproduce. Re-run on 2026-11-04 gave parity48 183 passed / 18 failed,
1/19 MATCH (order-lifecycle only) — not the batch's order-dependent
201/0. The brief's 184/17, 2/19 premise was already stale by one
extra failure: cron-run, which had MATCHED in the worker's run
because the worker replayed before its own chain advanced the
sequences. Root cause, confirmed: goldens record raw autoincrement
ids, sqlite_sequence never goes back on delete, so any
reference-touching suite run advances sequences and breaks naive
key comparison. The product behavior is correct; the comparison
was sequence-fragile. This fix is comparison-side ONLY, in
`parity48.py` ONLY (plus the G5 hunk and the metadata re-record
below). No golden payload byte changed; no money field was ever
canonicalized, remapped, or normalized; no string content was
silently normalized except the one established class below.

### 10a. What parity48.py now does (diff summary)

- Per table, ADDED rows only (rows present after the scenario
  that were absent before) are paired nth-to-nth in sorted-by-id
  order, golden side to replay side. If added-row counts differ
  for any table, the golden verdicts COUNT-MISMATCH with the
  table + both counts — never guessed, never padded or dropped.
  The diff is still reported for diagnosis.
- A replay-id → golden-id map is built from that pairing and
  applied FIELD-AWARE only: to delta keys (added-row
  identities), to declared id fields in envelopes
  (`result.client.id`, `result.client_id`, `result.id`,
  `result.list[].id`, nested `{"x": {"id"}}` shapes), and to
  foreign-key fields in deltas (client_id→client,
  invoice_id→invoice, order_id→client_order,
  transaction_id→transaction, cart_id→cart,
  subscription_id→subscription, plus
  credit_note_for_invoice_id / debit_note_for_invoice_id /
  replaces_invoice_id / replaced_by_invoice_id→invoice,
  refunded_item_id→invoice_item). Deliberately NOT mapped:
  gateway_id, product_id, service_id, admin_id (stable catalog
  ids; mapping them would hide linkage bugs).
- FK derivation is SNAPSHOT-CONSTRAINED (this constraint was
  added because the first negative-control run exposed a real
  bug: unconstrained derivation from a corrupted golden email
  row client_id 1→99999 derived client 1→99999 and poisoned
  envelopes + invoice rows into a fake MONEY-DIFF). A paired
  row's differing FK field derives a map entry ONLY when the
  replay FK is NOT in the pre-seed snapshot ids for that table
  (seed/scenario-created ids only; baseline ids never derive).
  With snapshot_ids=None, FK derivation is disabled
  (fail-closed). Conflicting derivations → COUNT-MISMATCH.
- Month-name date scrub (the ONE established-class exception to
  "string contents unmapped"): "Mon D, YYYY" (abbreviated +
  full month names) → `*DATE*`, comparison-time only, in
  memory, both sides. Justification: the harness already
  normalizes every wall-clock date field (created_at,
  updated_at, due_at, paid_at, …) and ISO datetimes in strings;
  the month-name format in email prose ("generated on Nov 1,
  2026", "Due Date: Nov 6, 2026") was the one gap, and it is a
  date, not an id or a money value. Amounts ("$105.00") are
  untouched. The brief's "row bodies byte-identical" claim for
  the email_queue failures was WRONG in this respect: bodies
  differ by content dates + ids; after scrub + mapping, the
  bodies match exactly. All other string contents stay unmapped;
  if they diff, they surface loudly.
- Numeric ids sort numerically (JSON round-trip makes delta
  keys strings); non-numeric keys sort after by string, never
  crashing pairing. Removed rows are untouched (baseline ids).
  Verdicts: MATCH / MONEY-DIFF / NON-MONEY-DIFF /
  COUNT-MISMATCH. Golden files are never modified by the runner.
- §C guardrails unchanged and all passing, including
  payload_sha256 validation for all 19 goldens.

### 10b. Sorted-pairing confirmation (empirical, from golden + replay data)

- Schema proof: every DIFF_TABLE id is INTEGER PRIMARY KEY
  AUTOINCREMENT (verified with quoted table names, including
  `transaction` and `client`) — SQLite guarantees
  monotonically increasing, never-reused ids, so sorted-by-id
  == creation order for added rows. No interleaving or
  reordering is possible for added rows within one scenario's
  execution on either side, because both sides run the same
  scenario steps against a fresh disposable copy of the same
  snapshot.
- Multi-row tables confirmed (≥2 added rows in some golden):
  invoice_item (2), email_queue (2–3), invoice (2),
  invoice_event (2–3, 60 in cron-run), client_order_status (4
  in order-lifecycle). All other tables 0–1 added rows
  (pairing trivial). Confirmation per table: after mapping,
  every paired row's body matches field-for-field (money
  fields compared exactly, never remapped) across 18/19 goldens
  in BOTH acceptance runs — a wrong pairing would surface as
  body mismatches, and none occur outside the two documented
  date-window failures.
- Repeat stability: run (A) and run (B) (after a full chain
  that advanced email_queue 535→538 and client 550→579) give
  IDENTICAL verdicts (18/19, 200/1, same single failure with
  the same signature) — pairing is stable across sequence
  drift.
- The one table that FAILS LOUDLY instead of pairing: cron-run
  email_queue (golden added 0 vs replay added 12) and its cart
  purge counts (golden removed 113 vs replay removed 248).
  No comparison-side pairing can fix a count difference, and
  none is attempted — COUNT-MISMATCH is the correct verdict
  (see §10e).

### 10c. Negative control (parity48.py --negative-control, repeatable, disposable TS only)

Self-contained, refuses if :3012 is up, never touches the real
goldens. Four assertions, all PASS (log
`my-parity48-negctl2.log`):
- (a) money: invoice_item price 25→26 → MUST MONEY-DIFF —
  PASS (db_tables=['invoice_item']).
- (b) body-id: email_queue first row body id 530→9999 (key
  untouched) → MUST NON-MONEY-DIFF — PASS
  (db_tables=['email_queue']). NOTE: the first control design
  corrupted the row KEY instead; that cannot MATCH by design
  (pairing is positional on sorted keys), so it was redesigned
  to body-id corruption and is documented in the control
  docstring as a body-integrity tripwire, not a mapping case.
- (c) dependent FK: email_queue client_id 1→99999 → MUST
  NON-MONEY-DIFF, never MONEY-DIFF — PASS
  (db_tables=['email_queue']). The first run FAILED this
  assertion and exposed the unconstrained-derivation poisoning
  bug; the snapshot constraint (§10a) was added because of it.
- (d) pristine golden vs drifted replay → MUST MATCH
  ("match via mapping" proof) — PASS.
First control run log `my-parity48-negctl.log` (FAILED,
superseded) is kept for the audit trail.

### 10d. Metadata re-record (payload bytes proven unchanged)

Script `~/scratch/fossbilling/r5-logs/rerecord-golden-metadata.py`
(one-off, not committed). Proved payload_sha256 covers
envelopes+deltas ONLY (generator `payload_sha(envelopes,
deltas)`; parity48 §C recomputes from those two). All 19
goldens re-recorded: ts_commit UNCHANGED (already the full
`8be5ab7` SHA, verified vs `git rev-parse`); ts_worktree_dirty_files
→ `[]` (the batch commits; the 3 pre-existing untracked
byproducts are NOT batch files and are not listed);
ts_worktree_note → new committed-batch note; ts_fix_files
ADDED = the 3 TS paths (seam-call.ts, cart.ts, invoice.ts).
Assertions per file: canonical envelopes+deltas dump identical
before/after, payload_sha identical before/after and equal to
stored, unchanged metadata keys equal to the ORIGINAL (the
script's first version had a vacuous check comparing the
mutated dict — fixed with deepcopy of original
metadata/review/capture/scenario before mutation),
php_review/capture/scenario identical. Result: 19 files, 0
payload bytes changed. The batch commit SHA itself cannot be
recorded in advance; it goes in the commit message + this
section's successor, not invented here.

### 10e. Acceptance results, in order (2026-11-04)

- (A) parity48 immediate re-run (log `my-parity48-fix-A.log`):
  18/19 MATCH, 200 passed / 1 failed. Sole failure: cron-run
  COUNT-MISMATCH table email_queue golden added 0 vs replay
  added 12; db_tables=['cart', 'email_queue'] (NO setting — the
  mapping fixed the setting id drift; NO env diffs; NO money
  tables). (A) is therefore NOT green — it is 18/19, reported
  with true numbers, NOT forced green. Forcing green by
  weakening the comparison (ignoring cart/email diffs for
  cron-run) would be dishonest and against the fail-loudly
  rules.
- (B) FULL regression chain (log
  `my-goldens-fix-chain.log`), then parity48 again (log
  `my-parity48-fix-B.log`): parity47 86/86; parity46 21/0/2
  skips; parity45 171/171; parity44 77/77; parity43 16/16;
  parity42 73/73; parity41 130/130; parity40 120/120; parity39
  212 checks, 6 failures — ALL date-window (see below);
  parity37 green; parity36 51/51; parity35 211/211 (0 failures,
  date-windowed income series as in the goldens batch);
  parity34 164/164; parity33 77/77; parity32 65/65; parity31
  63/63; parity30 179/179; parity29 62/62; parity28 128/128;
  parity27 27/27; parity26 62/62; parity25 ALL GREEN;
  installer-test 119/119 + 2 SKIP; parity38 86/86 (external
  :8081 oracle killed after, confirmed down); parity21 194/203
  (exactly the known 9 diffs); fixtures 13/13 BOTH stacks
  (counters clear, extension_meta 3, :3001 killed first);
  accounting 548+31+0. Reference sequences BEFORE chain:
  email_queue 535, client 550, invoice 488, cart 335 (count
  283). AFTER chain: email_queue 538, client 579, invoice 488
  (unchanged — no chain suite creates invoices), cart 337
  (count still 283); counts invariant; config hash unchanged
  (`6e3c529673c1d089`). Second parity48: 18/19 MATCH, 200
  passed / 1 failed, IDENTICAL signature to (A) — sequence
  drift survived, no new failure. (B)'s parity48 leg therefore
  passes the robustness test; the chain leg carries the two
  date-window exceptions below.
- (C) Negative control: 4/4 PASS (§10c). Re-run only if
  parity48.py changes; it did not during (B) iteration.
- (D) parity45 171/171 INSIDE the chain + accounting
  548+31+0 — cited, not re-run for padding.

### 10f. The two date-window exceptions (same root cause, NOT regressions)

Both are wall-clock due windows moving between generation
(Nov 1) and replay (Nov 4). Neither is caused by this fix
(this fix touches only parity48.py comparison + golden
metadata; it cannot affect PHP/TS cron behavior, and parity39
does not import parity48 or goldens). Both stacks agree with
each other in every case; only pinned Nov-1 counts break.

1. parity48 cron-run (sole parity48 failure, both runs):
   batch_expire cart purge cutoff = zone-today minus 7 days at
   00:00:00 (`cart.ts` `runBatchExpireCarts`); replay Nov 4
   cutoff Oct 28 removes 248 baseline carts vs golden 113 —
   the extra 135 removed have created_at Oct 25 21:26:22 →
   Oct 27 23:52:06, exactly the 3-day window opened since
   generation; kept carts ≥ Oct 28 00:00:17 (35 carts); 0
   staff-session carts removed; boundary exact (removed ≤
   Oct 27 23:52:06 < Oct 28 00:00 ≤ kept). Reminder job queues
   12 new "[Company Name] Invoice Due" emails (status
   'failed', no SMTP on disposable TS) vs golden 0. Money
   tables (invoice/invoice_item/transaction/client_order)
   show NO diff in the cron replay; invoice_event 60 rows
   identical keys, no diff. This is §8's own rule firing:
   "if a future replay diverges on cron-run only, regenerate
   + re-review it first" — that regeneration is Josh's call,
   NOT executed quietly here (it would also need a recorded
   date, since any regenerate is itself date-pinned).
   Alternatives for Josh: regenerate + re-review at a
   recorded date; narrow cron-run's scope (exclude the
   purge/reminder counts, keeping money tables); or freeze
   the clock in the harness. NOT done here.
2. parity39 chain run, 6 failures (§1 sendmail counts + §6
   reminder counts, BOTH stacks, D1–D6 per-invoice checks all
   PASS): §1 PHP requires pending==0 AND sending==67, but the
   Nov-4 cron run queues the same 12 extra reminders, so
   sending==79 (or pending==12, depending on job order);
   §1 TS requires mock accepted==5, but the 12 extra
   reminders also deliver to the mock (17 ≠ 5; "queue total
   62" still PASSES). §6 `batch_invoke_due_event` processes
   ALL invoices, not just the 6 crafted ones, and counts ALL
   new queue rows — the reference due-window invoices add
   extra sends beyond the crafted D3 + D1, so "exactly 2
   sends" and the [Payment Reminder, Invoice Due] subjects
   split fail on both stacks identically. parity39's restore()
   is rigorous (full table snapshots + sqlite_sequence
   restore), so no residue cascades: parity37 passed
   immediately after with "restored; config hash OK;
   invariants OK". parity39.py was NOT modified (outside
   this fix's scope); re-pinning its expectations is a
   separate decision, same as cron-run.

### 10g. G5 rewrite + what remains

- `cutover-checklist.md` G5 hunk ONLY rewritten with the
  post-fix numbers above (18/19, 200/1 both runs; cron-run
  date-window divergence stated plainly; the order-dependent
  19/19, 201/0 claim SUPERSEDED). No other gate touched.
  Oracle deletion remains explicitly NOT approved.
- What remains for Josh (taps, not executed here): (1) commit
  the batch (the batch commit SHA goes in the commit message;
  goldens metadata re-recorded for it in §10d); (2) the
  cron-run decision in §10f.1 (regenerate + re-review at a
  recorded date, narrow scope, or freeze clock); (3) the
  parity39 re-pin decision in §10f.2; (4) oracle deletion
  (separate tap, suites repointed first); (5) the §9 items
  (batch_pay_with_credits rewrite, qty-aware partial refund,
  Stripe goldens, order-lifecycle/invoice_event gaps).
- Left unverified by this fix (unchanged from §9): everything
  in §9, plus live Stripe / live eNom / live currency refresh /
  R3c Postgres proof (separate taps, need Josh's endpoints
  or credentials).

## §11 — Cron-run scope narrowing (2026-11-04; Josh's tap: "narrow cron-run's scope, then commit")

  §10 left parity48 at 18/19 MATCH (200/1): the sole failure was
  cron-run COUNT-MISMATCH, a proven date-window divergence, not
  money and not sequence drift. Regenerating the golden was
  explicitly rejected (a date treadmill: it would diverge again
  in 7+ days); freezing the clock was rejected as heavier
  harness surgery for this round. The narrowing below is
  comparison-side only, in parity48.py only. No golden file
  payload changed, no TS product code changed, no other suite
  changed. §10's history and its 18/19 record stand as written;
  this section appends, it does not revise them.

  ### §11.1 — Analysis (§1): what actually diverges by date

  Golden `goldens/cron-run.json` (Nov 1 generation): 1 step,
  `admin/cron/run`. Its deltas: cart added 0 / removed 113 /
  changed 0; cart_product added 0 / removed 4 / changed 0;
  email_queue added 0 / removed 0 / changed 5 (keys 463–467,
  status pending→failed, tries, priority — send attempts on
  disposable TS with no SMTP); invoice_event added 60 /
  removed 0 / changed 0; invoice_item added 0 / removed 0 /
  changed 106 (all exactly {status, updated_at}, status
  pending_setup→executed — batch activation); invoice added 0 /
  removed 0 / changed 0; setting added 1 (id 64,
  `last_cron_exec`, normalized `*TS*`) / changed 1. No
  transaction, client_order, client_order_meta, client_balance,
  or subscription deltas.

  (a) Cart delta — purge removals ONLY. Schema proof
  (reference DB, quoted names): cart columns = [id,
  session_id, currency_id, promo_id, created_at, updated_at]
  — NO money columns; cart_product columns = [id, product_id,
  config, cart_id] — NO money columns (no price/amount).
  Golden cart_product removed rows (keys 5, 7, 10, 12) are
  {id, product_id, config (period `1M` + `__cart_family`
  hash, or hash only), cart_id 16–19}. A diagnostic replay
  (disposable TS only) confirmed: cart removed 248 vs golden
  113 (added 0/0, changed 0/0); cart_product removed 4 vs 4
  (MATCH — same rows). The purge job is `cart_batch_expire`
  (runBatchExpireCarts) in `apps/nextjs/src/server/modules/
  cron.ts`. The purge creates no invoice, charge,
  transaction, or order — it is operational cleanup, not
  money. MONEY_TABLES includes cart and cart_product by
  blanket rule (cart operations feed money flows); for the
  purge delta specifically that classification is a
  technicality, stated here explicitly: these rows carry no
  money values and the purge has no money effect. The actual
  money signal (invoice, invoice_item, transaction,
  client_order) still compares exactly — see (c).

  (b) Email_queue added rows — ALL 12 are one kind. The
  diagnostic replay's 12 added rows (keys 539–550) are
  uniformly subject `'[Company Name] Invoice Due'`,
  client_id=1, status=failed (disposable TS, no SMTP). NO
  payment confirmations, NO invoice-generated notifications,
  NO other kinds. They reference due invoices but move no
  money. Corroboration: the replay's 12 invoice CHANGED rows
  (keys 312, 315, 316, 329, 332, 333, 387, 392, 395, 396, 398,
  401) have ONLY fields ['reminded_at', 'updated_at'] —
  reminded_at is in VOLATILE_KEYS and updated_at ends in
  `_at`, so diff_deltas skips both and no invoice diff
  results; the 12 reminders correspond 1:1 to 12 invoice
  reminded_at touches. The reminder job is
  `invoice_batch_send_reminders` (doBatchRemindersSend) in
  the same cron.ts. The "[Company Name]" prefix is the
  company-name placeholder — the kind rule uses substring
  "Invoice Due" (robust to company-name variation, specific
  to this reminder kind); a future differently-subject
  reminder kind will NOT be excluded and will surface loudly.
  The exclusion is therefore by row kind (reminder-subject
  rows only), NOT a blanket email_queue exclusion: email_queue
  CHANGED rows (send attempts) still compare exactly, and any
  non-reminder added row still compares exactly.

  (c) Money tables in the cron replay — NO diff. invoice:
  12 changed rows, volatile-only (see (b)); invoice_item:
  106 changed, MATCH; transaction: no delta either side;
  client_order: no delta either side; plus invoice_event 60
  added MATCH, setting MATCH, email_queue changed 5 MATCH.
  The cron replay's money tables show NO diff. The cron
  step's envelope carries no ids (returns `true`), so env
  diffs are empty.

  A reading note on diff_deltas output, recorded because it
  misled once: for added/removed kinds it stores {"php":
  <rows>, "ts": <rows>} — a printed count of 2 for a kind
  means the two sides, NOT two rows; the true row counts
  are inside (cart removed 113 vs 248; email_queue added 0
  vs 12).

  ### §11.2 — Exclusion rules (parity48.py only)

  Named construct: `CRON_RUN_SCOPE_TABLES_REMOVED =
  ("cart", "cart_product")` and
  `CRON_RUN_SCOPE_EMAIL_SUBJECT = "Invoice Due"`, applied
  by `apply_cron_scope(g_delta, r_delta)` inside
  `compare_golden`, for golden id `cron-run` ONLY — a
  per-scenario scope override, NOT a global weakening.
  Rules, all symmetric (both sides) and in-memory only
  (golden files are never modified):

  - cart / cart_product: drop the `removed` key from BOTH
    sides. A table whose only kind was removed rows
    disappears from that side's delta, which diff_deltas
    treats as no diff (empty == empty). Other kinds are
    kept: a future cart added/changed row would still
    compare — tighter than whole-table exclusion.
  - email_queue: drop ADDED rows whose subject (dict rows
    only) contains "Invoice Due" from BOTH sides; rows with
    any other subject are kept; if zero rows drop, the
    delta is returned unchanged. The rule is "this
    comparison class is out of scope for this golden", not
    "ignore replay extras".
  - Still compared exactly: all money tables (invoice,
    invoice_item, transaction, client_order,
    client_order_meta, cart added/changed kinds,
    client_balance, subscription), email_queue CHANGED rows
    and non-reminder ADDED rows, invoice_event, setting,
    and the cron envelope.

  Side-effect check: dropped email ids have no mapping side
  effects (nothing FK-references email_queue rows; cron
  envelopes carry no ids). After scoping, build_id_maps
  sees email_queue added 0/0 (no COUNT-MISMATCH) and cart
  added 0/0.

  Reporting: the hook prints one ` SCOPE cron-run: <line>`
  per rule inside compare_golden, so exclusions are visible
  even on MATCH (the main loop prints only `MATCH {gid}`
  without detail on match). Observed lines, both runs:
  `cart removed rows excluded (golden 113, replay 248) —
  purge cleanup, no money columns, no money effect`;
  `cart_product removed rows excluded (golden 4, replay 4)
  — purge cleanup, no money columns, no money effect`;
  `email_queue added rows with subject containing 'Invoice
  Due' excluded (golden 0, replay 12) — date-window
  reminder counts, not money`.

  ### §11.3 — Guards

  (a) Existing negative control (`parity48.py
  --negative-control`): 4/4 PASS, unchanged by the
  narrowing — (a) money price 25→26 → MONEY-DIFF
  (db_tables=['invoice_item']); (b) email_queue body id
  530→9999 → NON-MONEY-DIFF; (c) email_queue client_id
  1→99999 → NON-MONEY-DIFF, never MONEY-DIFF; (d)
  pristine vs drifted → MATCH. Log:
  `my-parity48-narrow-negctl.log`.

  (b) NEW cron-money control (`parity48.py
  --cron-money-control`, disposable TS only, refuses if
  :3012 is up): replays cron-run once on disposable TS and
  compares the SAME replay against (i) the pristine golden
  → must MATCH with narrowing active (SCOPE lines print,
  proving the narrowing is on), and (ii) a money-corrupted
  in-memory copy → must report MONEY-DIFF. Corruption
  target: the first invoice_item changed row's POST status
  executed → pending_setup ("the cron activation did not
  happen") — chosen because the cron golden's money signal
  IS the 106 pending_setup→executed activations, its
  changed rows carry no price/amount columns, and status is
  the money-behavior field (invoice_item ∈ MONEY_TABLES;
  changed-row diffs on it classify as money via
  is_money_diff). The 12 invoice reminded_at touches are
  volatile-only and cannot serve as a money control.
  compare_golden does not mutate its inputs (scrub/map
  functions build new objects), so reusing the same replay
  envs/delta for (i) and (ii) is safe — same pattern as
  the existing negative control. Result: PASS — (i) MATCH
  with SCOPE lines, (ii) MONEY-DIFF
  (db_tables=['invoice_item']). The narrowing did not blind
  money. Log: `my-parity48-narrow-cronctl.log`.

  ### §11.4 — Post-narrowing numbers

  (A) Immediate re-run: parity48 19/19 MATCH, 201 passed /
  0 failed, SKIPs: 0 (log `my-parity48-narrow-A.log`).
  No golden other than cron-run changed verdict vs the
  200/1 runs — the narrowing affected cron-run ONLY.

  (C) Full regression chain (same set as §10's chain) +
  parity48 again. Chain results: parity47 86/86; parity46
  21/0/2 labeled skips; parity45 171/171; parity44 77/77;
  parity43 16/16; parity42 73/73; parity41 130/130;
  parity40 OK; parity39 212 checks / 6 failures — the SAME
  expected date-window set as §10 (both stacks agreeing:
  §1 sendmail counts + §6 reminder counts), reported
  honestly, NOT forced green, parity39.py NOT modified
  (its re-pin is a separate decision); parity37 restored
  clean (config hash OK, invariants OK); parity36 51/51;
  parity35 211/211 (date-windowed count, vs October's
  210 — not a regression); parity34 164/164; parity33
  77/77; parity32 65/65; parity31 63/63; parity30 179/179;
  parity29 62/62; parity28 128/128; parity27 27/27;
  parity26 62/62; parity25 ALL GREEN; installer-test
  119/119 + 2 SKIP; parity38 86/86 (external :8081 oracle,
  killed after, confirmed down); parity21 194/203 with
  exactly the known 9 diffs; fixtures 13/13 BOTH stacks
  (results JSONs, counters clear, extension_meta 3, :3001
  killed first); accounting 548+31+0. Reference sequences
  BEFORE the chain: email_queue 538, client 579, invoice
  488, cart 337 (count 283). AFTER: email_queue 541,
  client 608, invoice 488 (unchanged — no chain suite
  creates invoices), cart 339 (count still 283); counts
  invariant; config hash unchanged (`6e3c529673c1d089`).
  Second parity48 (log `my-parity48-narrow-B.log`):
  19/19 MATCH, 201 passed / 0 failed, SCOPE lines with the
  same exclusion counts (cart removed golden 113 / replay
  248; email 'Invoice Due' added golden 0 / replay 12).
  The narrowing survived advanced sequences. Chain log:
  `my-narrow-chain.log` (script `my-narrow-chain.sh`, the
  §10 chain script with log paths renamed so the §10 logs
  were not clobbered).

  (D) parity45 171/171 inside the chain + accounting
  548+31+0 — cited, not re-run for padding.

  ### §11.5 — Goldens untouched (§5)

  No golden file payload byte changed. Proof: parity48's
  own §C SHA checks passed for all 19 goldens in BOTH the
  immediate run (A) and the post-chain run (B) (201/0
  includes them); the §10 rerecord proof established that
  payload_sha256 covers envelopes+deltas ONLY. Metadata
  verified directly across all 19 files after the chain:
  `ts_commit` = full 40-char SHA
  8be5ab7621905643ce17e24a6f4382ee8a9969df (the repo tip
  — the batch is still uncommitted on top of it),
  `ts_worktree_dirty_files` = [], `ts_fix_files` = the 3 TS
  paths each, `payload_sha256` present each. The batch
  commit SHA cannot be recorded in advance — it goes in
  the commit message.

  ### §11.6 — Supersession and standing items

  The §10 numbers (18/19, 200/1) are SUPERSEDED by the
  post-narrowing numbers above (19/19, 201/0, both runs).
  The G5 hunk in `cutover-checklist.md` was rewritten with
  the post-narrowing numbers, stating the narrowing
  explicitly; oracle deletion remains explicitly NOT
  approved there. This batch does NOT approve cutover as a
  whole (G2 live window + one-cycle run, G4 artifact
  build/push/digest, G3-conditional R3c, TZ=UTC, D6-6
  external-consumer confirmation all remain), does NOT
  re-pin parity39 (separate decision), and does NOT delete
  the oracle (separate tap, suites repointed first). The
  batch is uncommitted pending the parent's re-verification
  and commit; the "then commit" in Josh's tap is executed
  by the parent, not by this batch.
