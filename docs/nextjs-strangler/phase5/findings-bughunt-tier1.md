# Findings — Bug-hunt Tier 1 fix batch

Branch `fix/bughunt-tier1`, off `b376b03` (money goldens). Built 2026-11-05 by a
coordinator + 4 workstreams (money core, seam/auth, installer, cron settings),
merged onto one branch; parent re-verified 2026-11-11 and committed. NOT pushed
— push is Josh's separate tap. Hunt report:
`~/workspace/your_files/fossbilling-bug-hunt-2026-11-04.md`.

Scope is EXACTLY the hunt's Tier 1 (15 items). Adjacent Mediums (A-F5 discount
sign, A-F8 note series, A-F14 cancel, B-M1..M6, C-F1/F2/F3/F5/F7/F8/F9, all D
items, E-3..E-10, F2) and all 32 suspects stay for later batches. The known
K1 map-shape gap (partial-refund id→qty map) was NOT in Tier 1 scope and is
NOT fixed here — see §5, it is now the top next-batch item, with new evidence.

## §1 — Per-item fixes (all 15)

| # | Finding | Fix (files) | Re-probe evidence |
|---|---------|-------------|-------------------|
| A-F1 | Tax rounded per line (1¢ drift) | `money.ts` `invoiceTotals`: tax rounded ONCE on the taxable subtotal (PHP `Invoice\Service::getTax`), never per line | s01-tax-aggregate-rounding: 0 diffs |
| A-F2 | Paid invoices voidable | `invoice.ts` cancel: `isCancellable` guard, PHP wording | s02-cancel-paid, s03-cancel-draft: 0 diffs |
| A-F3 | Paid invoices reissuable | `invoice.ts` reissue: guard + buyer_state/due_at frozen from the original | s04-reissue-paid, s05-reissue-tax-change: 0 diffs |
| A-F4 | Refund core triple-counts credit | `invoice.ts` `refundInvoiceCore`: (a) stored refund = credit note's own total WITH tax (`round(abs(getTotalWithTax(note)), 2)`); (b) lines resolved against remaining quantities via `refundedQuantities` — second refund of a credited line throws PHP's exact "Refund quantity exceeds the remaining refundable quantity of 0"; (c) full-after-partial credits only still-unrefunded lines; "No remaining refundable amount" guard | s06/s07/s08-list: see §2 (K1-only diffs); map probes p06/p08: see §5 |
| A-F6 | Lines deletable off paid invoices | `invoice.ts` item_delete: invoice-state guard, PHP "immutable… correct them with a credit note" wording | s10-item-delete-paid: 0 diffs |
| A-F7 | Drafts debitable, negative-price debits mintable | `invoice.ts` debit: eligibility guard ("Only issued unpaid or paid invoices can be debited") + "Price cannot be negative." | s11-debit-draft, s12-debit-negative: 0 diffs |
| A-F9 | Admin order create: EUR 2×, sells out-of-stock | `order.ts` create: catalog price × conversion rate (no explicit price override); stock check, PHP 831 "Product … is out of stock."; item `taxed` via `isClientTaxable`, task `renew` | s13-taxed-flag, s14-eur, s15-stock: 0 diffs |
| A-F10 | Client checkout: no stock check, no transaction, orphan orders | `cart.ts` checkout: staff checkout's stock check mirrored; checkout wrapped in a transaction | s16-checkout-stock, s17-checkout-partial: 0 diffs |
| A-F11 | Every activate click grants a free month | `order.ts` `activateOrderRow`: active → no-op; only pending_setup/failed_setup may activate, else throw; expiry still extends from existing expiry (PHP's `$from_time` rule) — the guard, not the arithmetic, stops repeat activation; clears suspended_at/canceled_at | s21-activate-twice: 0 diffs |
| A-F12 | Renewal invoices duplicate into payable doubles | `invoice.ts` renewal_invoice: return the existing unpaid renewal invoice if one exists; PHP `isClientTaxable` + `use_credits=true` semantics | s22-renewal-duplicate: 0 diffs |
| A-F13 | Stripe refunds recorded offline, no card money moves | `invoice.ts` refund handler: gateway-refund planning mirrored — no refundable gateway payment → 9999 "No refundable gateway payment found for invoice #:id. Return the payment in the gateway dashboard, or record an offline-only refund." (PHP-exact, including the `#:id` colon — see §3) | s20-stripe-refund: 1 diff, error.message only (colon — resolved, §3) |
| B-H1 | `fossbilling_csrf` cookie never validated | `dispatch.ts` `enforceCsrf`: non-empty csrf cookie must equal the session token (constant-time `timingSafeTokenEqual`); param check also constant-time; absent/empty cookie not validated, exactly as PHP | Coordinator probe P1 re-run: correct param + wrong cookie → 403 on both; control passes on both |
| B-H2 | No HTTP Basic api_token auth | `seam-call.ts` pipeline gains an auth step (session CSRF, or Basic api_token login which skips CSRF); `session.ts` `parseBasicAuth` + `loginWithApiToken` (constant-time token compare); `route.ts` forwards the Authorization header; profile api-key methods pinned to session auth when that role holds a session (PHP `shouldPreferSessionAuth`) | 9/10 cases agree (§4) |
| E-1 | Installer PG DDL order fails on forward FKs | `scripts/install.ts`: PG path now uses deferred `emitFullSchemaPostgres()` (all CREATEs + indexes, then FK ALTERs) instead of `flatMap(emitCreateTablePostgres)` | Code-verified; hunt's pg-mem proof (installer order failed 92/211, deferred passed 211/211) applies to the same function. Live-PG execution still unproven (no PG server in sandbox) |
| E-2 | Critical: post-commit installer failure bricks re-runs | `scripts/install.ts`: resume/repair design — post-commit steps idempotent; two cases auto-resume on re-run (no flag, no manual cleanup); `--repair` re-runs post-commit steps against a complete install the installer reported as failed (never re-seeds, never regenerates a salt) | W3 probes instA2/instA3: config-write EISDIR after DB commit → honest failure ("Re-run the installer to resume — no manual cleanup is needed") → re-run completes (full install result JSON). GeoIP-copy failure path covered by the same resume machinery; live-PG resume unproven |
| F1 | New-ticket page dead-ends (no CSRF) | `support/new/page.tsx`: bare `fetch` replaced with `fbPost` (carries CSRF via `ensureCsrf`); page renders helpdesk options for a logged-in client | Coordinator probe: page-shaped request → pairs, not 403 |
| C-F4 | `batch_cancel_unpaid` cancels the wrong orders | `order.ts` `runBatchCancelUnpaid`: `batch_cancel_unpaid_after_days` (default 7, blank/negative → 7), calendar-day cutoff, per-invoice group guard (skips paid-invoice groups); the enabled-path delete-vs-cancel outcome is still the known cascade gap (not Tier 1) | Coordinator re-probe: (a) after_days=30, 10-day-old order kept; (b) paid-invoice order kept; (c) same-day-boundary order kept — all matching PHP |
| C-F6 | Cron settings endpoints are no-op stubs | `modules/cron.ts`: `save_settings` writes the mod_cron config (`{ext, guest_cron, cron_hash}`; enabling keeps an existing hash, generates fresh 64-hex only when none; disabling clears it) and `regenerate_cron_hash` returns a fresh hash; failed write throws rather than reporting success | W4 probes: config row changes + fresh 64-hex hash returned on both stacks; guest cron enable/disable/rotate now works via the API |

## §2 — W1 money re-probe (out-reprobe1/report.json, 17 scenarios)

15/17 scenarios 0 envelope diffs, money_diff False: s01, s02, s03, s04, s05,
s10, s11, s12, s13, s14, s15, s16, s17, s21, s22. The remaining 4 diffs are
all the KNOWN K1 map-shape gap, not Tier 1 regressions:

- s06/s07/s08-list: PHP rejects the LIST-shaped refund input outright
  ("Invoice line #0 was not found", 9999) while TS accepts lists. Step 6
  therefore diverges (TS mints a note PHP never creates). Step 7 of s07 is
  still the A-F4b proof, stated precisely (correcting the coordinator's
  interim summary, which overstated it): TS now throws "Refund quantity
  exceeds the remaining refundable quantity of 0" where pre-fix TS minted a
  second note. It is NOT PHP's exact message for the same call — PHP's
  message at step 7 is its list-input rejection — because PHP never reaches
  its quantity guard on list input. The guard behavior matches in substance
  (second refund refused); the exact-message match is only provable with
  map input, which is K1 (§5).
- s20: 1 diff, error.message only (§3).

## §3 — s20 colon (resolved in the committed tree)

The re-probe report showed TS "invoice #489" vs PHP "invoice #:489". The
committed code at `invoice.ts:1820` is `` `…invoice #:${inv.id}. …` `` —
template-literal `#:` + id — and direct evaluation with id 489 produces
"invoice #:489", PHP-exact. The report's TS string came from a stale build
during W1's re-probe (the message was corrected to `#:` after that probe
ran). No code change was needed at commit time; the literal was verified by
evaluation, and the handler path is proven by the report (TS throws the
9999 with that message shape).

## §4 — B-H2 9/10 (bh2b/bh2c logs)

Admin good, client good (shared token set on both disposable DBs — the
reference client token is NULL), bad tokens, cron token, cross-role both
ways, no header, Bearer ignored: all agree. The single mismatch is
empty-password Basic auth (TS 206 vs PHP 202): the php-cli-server drops the
empty `PHP_AUTH_PW` var, so the oracle sees no password where TS sees an
empty one. Both stacks reject the call; only the error code differs, and
only for a credential no real client sends. Recorded, not blocking.

## §5 — K1 residual (NOT fixed here; top next-batch item)

Map-shaped partial refunds (PHP's native input shape) still silently
full-refund on TS. New evidence from W1's map probes
(out-phpmap-w1/report.json, p06-map-partial-twice, p08-map-partial-then-full):

- p06 step 7 (get invoice after first partial refund): TS's invoice differs
  in income/lines/refund/refunded_total/remaining_refundable/status — TS
  fully refunded where PHP partially refunded. Step 8 (get credit note):
  note lines/subtotal/tax/total differ for the same reason. Step 9 (second
  refund of the same line): PHP "Refund quantity exceeds the remaining
  refundable quantity of 0"; TS "Only paid invoices can be refunded" — the
  status guard fires because TS's own first refund flipped the invoice to
  `refunded`.
- p08 step 7 (full refund after partial): PHP mints note 491 (line B only);
  TS throws "Only paid invoices can be refunded". Step 8: PHP has note 491,
  TS "Invoice was not found".

Consequences for A-F4's verification record, stated plainly:

- A-F4b (credited quantities) is probe-proven for LIST input (s07 step 7).
  Its map-input proof is blocked on K1: with map input the status guard
  fires first, so the quantity guard is never reached.
- A-F4a (tax-inclusive stored refund) is CODE-verified (stored amount =
  the note's own total with tax, `invoiceTotals` with once-rounding) but has
  NO end-to-end probe: PHP rejects list input (K1) and TS full-refunds map
  input (K1), so no probe can compare partial-refund stored amounts across
  stacks yet. A K1 fix unlocks the direct probe; re-probe p06/p08 then.
- A-F4c (full-after-partial credits only remaining lines) is probe-proven
  for list input modulo the K1 note-number offset (s08 step 7: PHP 490 vs
  TS 491, caused by step 6's K1 divergence); its map-input proof is also
  blocked on K1 (p08).

K1 fix shape (for the next batch, not this one): the refund handler must
resolve a PHP id→qty map into remaining-quantity lines (same resolution
A-F4 added for lists), keep status `paid` after a partial refund, and only
mark `refunded` when the cumulative refund covers the invoice total.

## §6 — Verification (coordinator chain + parent re-verification)

Coordinator chain (`my-tier1-chain.log`, script `my-tier1-chain.sh`):
parity47 86/86; parity46 21/0/2 skips; parity45 171/171; parity44 77/77;
parity43 16/16; parity42 73/73; parity41 130/130; parity40 120/120;
parity39 212 checks / 6 failures — the SAME expected date-window set as
§10 (both stacks agreeing, §1 sendmail + §6 reminder counts), reported
honestly, NOT forced green, parity39.py NOT modified (re-pin is a separate
decision); parity37 51/51; parity36 51/51; parity35 211/211 (date-windowed
count vs October's 210); parity34 164/164; parity33 77/77; parity32 65/65;
parity31 63/63; parity30 179/179; parity29 62/62; parity28 128/128;
parity27 27/27; parity26 62/62; parity25 ALL GREEN; installer-test 119/119
+ 2 SKIP; parity38 86/86; parity21 194/203 with exactly the known 9 diffs;
fixtures 13/13 BOTH stacks; accounting 548+31+0. Sequences before→after:
email_queue 538→552, client 579→637, invoice 488 (unchanged — no chain
suite creates invoices), cart 337→342 (count still 283); counts invariant;
config hash `6e3c529673c1d089` unchanged. Second parity48
(`my-parity48-tier1-B.log`): 19/19 MATCH, 201/0.

Parent re-verification 2026-11-11 (fresh rebuild, `npm run build` exit 0,
both servers restarted + 200/200, invariants clean): parity48
(`my-parity48-tier1-verify.log`) 19/19 MATCH, 201/0, SCOPE lines present;
negative control 4/4 PASS; cron-money control PASS; accounting 548+31+0.
Code reads: A-F1, A-F4 core, A-F9, A-F11, B-H1, B-H2, E-1, E-2, C-F4, C-F6,
F1, and the A-F2/F3/F6/F7 guards — all match the PHP semantics the hunt
probed. W1 re-probe report + W3 installer probe logs + W4 cron probe logs
read from disk (see §2/§4/§5).

## §7 — Goldens: NO regeneration, NO file changed

No golden file was modified by this batch (`git status` proves it) and
parity48 re-verified 19/19 on the fixed tree — twice by the coordinator
(second run after the chain) and once by the parent. The fixed edge cases
(per-line tax drift on multi-line taxed invoices, double refunds,
partial-refund tax, EUR/stock order-create, activate-twice, renewal
duplication, Stripe-refund refusal) are not exercised by the golden
scenarios' inputs, so no golden diverged and none needed regeneration. If a
future golden covers them, it will pin the FIXED behavior; the goldens'
PHP-review verdicts stand unchanged.

## §8 — What's NOT fixed (next batches)

- K1 partial-refund id→qty map shape (§5) — top priority; unlocks the
  A-F4a/A-F4b/A-F4c map-input proofs (re-run p06/p08 after).
- A-F5 discount-line sign on credit notes; A-F8 note series
  (`invoice_cn_series`/`invoice_dn_series`); A-F14 order cancel side
  effects; B-M1..M6/B-L1..L6 seam items; C-F1/F2/F3/F5/F7/F8/F9 cron items;
  all D items (GeoIP PS/AQ/GS, twig filters, PDF blocks); E-3..E-10
  (php-serialize multibyte, finalize port/string, finalization lock,
  pg timestamp shift, importer verified-flag); F2 (no purchase/payment flow
  in the UI); all 32 suspects (each with its proof step in the hunt slice
  notes).
- Live-PG proof for E-1/E-2 resume; live Stripe success + webhook goldens;
  R3c; parity39 re-pin; oracle deletion; cutover (still NOT approved).
