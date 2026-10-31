# Shadow criteria — Phase 5 batch R6b (cutover comparison rules)

Scope: R6 (r6-scope.md, decisions D6-1..D6-10). This doc states what the
shadow comparison compares, where diffs go, what aborts cutover, how
non-money diffs are triaged, how long a shadow runs, and what R6d's
checklist gates on. The harness that implements it:
`docs/nextjs-strangler/phase5/shadow-harness.py`; its proof and per-scenario
results are in `findings-r6b.md`.

## 1. What is compared, per category (with reasons)

### 1.1 API response envelopes — COMPARED (primary signal)

Every step's response envelope is compared recursively with numeric tolerance
(round to 2dp, the fixture runner's num_eq rule extended across the
string/number boundary — PHP returns PDO strings, TS returns JSON numbers;
booleans never coerce). HTTP status is NOT compared: TS error envelopes are
always HTTP 200 (seam-wide convention), except the R5g real 429 and the R5f
gate 503, which are documented exceptions. Reason: the envelope IS the API
contract (D2: preserve `/api/:role/:class/:method` until PHP is gone); a
divergent envelope is a divergent contract even if the DB matches.

### 1.2 DB rows after money writes — COMPARED (primary signal)

After each scenario, the harness diffs DELTAS (added/removed/changed rows vs
that stack's own post-preamble baseline) for exactly DIFF_TABLES:

- MONEY_TABLES (9): invoice, invoice_item, transaction, client_order,
  client_order_meta, cart, cart_product, client_balance, subscription.
- Dependents (5): invoice_event, client_order_status, email_queue,
  service_custom, setting.

Excluded entirely: session (random tokens), all activity_* audit tables
(timestamps + IPs, no money signal), rate_limit_counter (TS-only table, no
PHP counterpart). Reason: money writes are the cutover risk (double-billing,
lost payments, wrong balances); row-level comparison catches what envelopes
hide (e.g. a handler that returns success while writing nothing — the exact
failure the R6b bracket-expansion fix caught). A blind full-DB diff would
drown in volatile rows, so the table set is scoped, not blind.

### 1.3 Invoice PDFs — NOT compared byte-for-byte; compared indirectly

PDFs are binary derived artifacts: their content is fully determined by
invoice rows (compared in §1.2) + template inputs, and PHP (dompdf) vs TS
renderers produce different bytes for identical content. Byte comparison
would fail on every invoice for renderer reasons, proving nothing. What IS
compared: the invoice rows, totals, and email-queue rows that feed PDF
generation. A PDF-content extraction comparison (text + totals extracted
from both PDFs) is a future enhancement, not an R6b gate. If a shadow run
shows invoice-row parity but a PDF renders wrong, that is a rendering bug
found by inspection, not a shadow abort — unless the rows themselves differ,
in which case §4 applies.

### 1.4 Emails queued — COMPARED as rows; send status triaged

email_queue rows are compared (recipient, subject, content with hash/datetime
scrubbing, status at creation). Reason: queued mail is the observable side
effect of money operations (invoice created, credit note issued, order
placed) and a missing queue row is a real behavioral gap. BUT send STATUS
after a cron/send pass is transport-dependent (disposable TS with no SMTP
fails sends PHP mail() "succeeds" on in the sandbox — findings-r6b.md §8,
cron-run) and is therefore TRIAGED, not gating: row CREATION is compared;
send outcome (sending vs failed, tries, priority) is environment-dependent
and does not abort. Wiring the R5e mock SMTP (:18025) into disposable TS so
send outcomes compare is a harness enhancement candidate, not a gate.

## 2. Where diffs go (one concrete destination)

The harness `--out` dir, per run:

- `report.json` — machine-readable: per scenario, envelope diffs (with
  `diff_fields`: only the dotted paths that REALLY differ
  post-normalization), DB diffs per table (added/removed/changed rows),
  `money_diff` flag, `normalized_fields` (every normalized occurrence, named
  with field + reason — never silently dropped), and the disposable paths
  used (proving no reference target was touched).
- `<scenario-id>.capture.jsonl` — the resolved request log for that scenario
  (capture format: JSONL, one request per line, `{"n", "persona",
  "request": {"kind": "api"|"ipn", ...}}`), so any run can be replayed with
  `--replay` and must reproduce the same diff signature.

For deployment shadow runs (live window, one-cycle parallel run), the same
`--out` dir is the artifact: it is retained for the full billing cycle
alongside the rollback artifact (R6d), and a run's report is the evidence
attached to the cutover decision. There is no separate log/table/alert
destination — one destination, implemented by the harness, reviewable by a
human (per-scenario, per-call envelope diffs + per-table row diffs).

## 3. What counts as a "money diff" (precise definition)

A money diff is EITHER:

(a) an envelope diff on a money-method step — a step whose module is in
{invoice, order, cart, transaction, subscription, product}, or any ipn step
(gateway callbacks are money by definition); OR

(b) any delta diff in a MONEY_TABLE (invoice, invoice_item, transaction,
client_order, client_order_meta, cart, cart_product, client_balance,
subscription) — any added/removed row, or any changed field after
normalization, in those tables.

Everything else is a non-money diff: envelope diffs on non-money methods,
and delta diffs in invoice_event, client_order_status, email_queue,
service_custom, setting. (Email-queue row CREATION diffs are non-money by
this definition but are still reported and triaged — they are notification
gaps, not money computation gaps.)

NO money field is normalized: money-table rows compare every field except
the volatile keys (timestamps, hashes, ids — never amounts, statuses, or
rates). The normalization list is in findings-r6b.md §6, proven by
php-vs-php capture48 (20/20 clean); parity45 §(iv) asserts each normalized
field is in that list AND that no money field is normalized.

## 4. Abort threshold + triage procedure

**Threshold (D6-3 default, unchanged): ANY money diff aborts cutover.**
There is no tolerance, no percentage, no "small money diff" category. A
single money diff stops the cutover until it is fixed (in-batch, with PHP
evidence) or explicitly waived by Josh with the diff attached to the waiver.

**Triage procedure for non-money diffs** (operational meaning of "triaged"):

1. The diff is recorded in the run's `report.json` with its table/step,
   the php vs ts values, and a disposition written into the findings doc.
2. Dispositions are exactly three: FIXED (small in-batch fix, PHP evidence
   cited), FLAGGED (needs Josh's decision — the diff, its evidence, and its
   consequence are surfaced in the batch report; cutover does not proceed
   on that item until he decides), or TRIAGED-KNOWN (a documented,
   understood, non-money gap — e.g. invoice_event shape, order emails,
   cron send-status transport, setting typing — that does not block cutover
   but stays listed as a known gap for a later batch).
3. A TRIAGED-KNOWN disposition requires: the root cause or the precise
   behavioral difference stated, the reason it is not money (which side of
   the §3 definition it falls on), and the later batch that would fix it
   (or "no batch planned" if it is accepted permanently).
4. Classifier-conservative case, ruled explicitly: cart ∈ MONEY_TABLES, so
   ANY cart delta flags money — including lifecycle-only deltas where the
   end state matches (e.g. PHP's login-created session cart present in the
   baseline but deleted by checkout on both sides). Such a case is NOT an
   auto-abort if end-state equivalence is proven (zero carts for the session
   on both sides post-checkout, no cart_product diff, and all order/invoice/
   transaction state matching) — it is reclassified to TRIAGED-KNOWN with
   that proof attached. If end states differ, it stays a money diff and
   aborts. (In the final R6b runs no cart diffs remain at all, so this rule
   costs nothing here; it exists so a future lifecycle-only cart delta
   cannot silently pass OR spuriously abort.)

## 5. Cycle length

One full billing cycle (D5-6, unchanged). The shadow comparison is not a
one-shot run: the harness's scenario + fixture corpus proves the mechanics
in the sandbox, and the deployment shadow (live window + one-cycle parallel
run, §6) runs for one full billing cycle before cutover is approved. A cycle
is used because money behavior is periodic (renewals, reminders, overdue
handling, cron invoice generation) — a shorter window cannot observe it.

## 6. Deployment-tap split (live window + one-cycle parallel run)

R6b delivers the harness + these criteria. It does NOT execute the live
window or the parallel run — those are deployment taps on Josh's infra
(D6-4). What each side provides:

**Harness provides:** the scenario format, the capture format (JSONL request
log — a live-traffic capture in this format feeds `--replay` directly), the
envelope + DB diffing, the money classifier, the report + capture artifact
per run, and the php-vs-php normalization proof (capture48).

**Josh's infra must provide:** (a) live-traffic capture in the harness's
capture format (request log with persona + resolved params, recorded without
recording secrets — session tokens, passwords, and gateway secrets must NOT
enter capture files; the harness's replay re-authenticates with its own
logins, it does not replay captured credentials); (b) a TS instance for the
parallel run, pointed at a scratch DB fed from a production snapshot (never
the production DB — no shared-DB shadow mode is offered, per the read-only
decision in findings-r6b.md §3); (c) retention of each run's `--out` dir
for the full cycle; (d) the rollback artifact (R6d: root Dockerfile's
`release-artifact` tagged at the last pre-deletion commit, retained one full
billing cycle; hosting/command are Josh's infra answers, recorded as R6d
deployment-tap details).

**R6d's checklist gates on (cutover approval requires ALL):**

1. Harness scenario corpus + fixture corpus green on money (envelope diffs
   0, money flags False) on the cutover candidate build.
2. Captured live-traffic replay green on money (same criterion), or the
   explicit statement that no live traffic exists to replay — in which case
   the cutover case rests on fixture shadow + one-cycle parallel run (D6-4).
3. One-cycle parallel run complete with no money diffs (any money diff
   aborts per §4, or is waived by Josh with the diff attached).
4. Non-money diffs from all three all triaged per §4 (no untriaged diffs).
5. Rollback artifact tagged at the last pre-deletion commit + retention
   confirmed for one full billing cycle.
6. D6-9 gate: if production runs Postgres, live-Postgres proof (R3c) is a
   go/no-go gate before flipping production traffic.
7. D6-2 gate: fork `src/` deleted in R6c; `runtime/` retained as frozen
   oracle until D6-1 exit criteria met, then deleted as a separate later
   decision — not both at once.
8. PHP themes external-consumer confirmation (D6-6) complete before deletion.

## 7. R6b/R6c boundary

Relocation/deletion untouched by R6b. The oracle stays live for comparison
through R6c per D6-1. R6c items (GeoIP DB relocation + FB_GEOIP_DB_DIR,
content.sql vendoring, email template vendoring per D6-10, Servicelicense/
Plugin, Page templates, Version fallback, fork `src/` + composer.* + PHP
Dockerfile stages deletion, Next deployment definition, `tests/` Pest
disposition) are not decided here and must not be assumed decided by this
doc.
