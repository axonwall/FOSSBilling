# R5b findings: invoice `currency_rate` / `base_income` / `base_refund` NULL-until-populated

**Scope:** make the TS seam match PHP's NULL-until-populated semantics for the
three invoice money columns. This is the batch findings-r1g.md sub-batch 1
deliberately deferred ("Fixing the helper is a separate batch with its own
regression run — not smuggled in here"). Pre-fix TS froze `currency_rate`
and zeroed `base_income`/`base_refund` at creation; PHP leaves all three
NULL until payment (refund/debit excepted, see below). Verified from code,
not from the brief: every rule below traces to a PHP function read during
the survey, and every TS site was found by grep, not by assumption.

**Result:** fix implemented, `tsc` + `next build` clean, parity35 198/198,
full regression green (parity34–25, parity21 at exactly the known 9 diffs,
fixtures 13/13 both stacks). Nothing committed, nothing pushed, no PHP
source touched. Branch `feat/nextjs-phase5-r1`, still at R5a tip `0c02ae5`.

---

## 1. PHP writer survey (the truth)

Entity defaults are nullable (`src/modules/Invoice/Entity/Invoice.php`):
`currency_rate` DECIMAL(13,6) nullable, `base_income`/`base_refund`
DECIMAL(18,2) nullable. Setter grep over all of `src/` plus `countIncome`
callers proves the writer set is complete (excluding legacy `UpdatePatcher`
data patches, which never touch these columns on a live invoice).

| Writer | When | What |
|---|---|---|
| `Invoice\Service::prepareInvoice` (:1419), `generateFundsInvoice` (:4320), credit-note creation, debit-note creation, reissue/renewal (all via `prepareInvoice`) | Creation | NONE of the three columns is set → all NULL |
| `markAsPaidInTransaction` (~1100–1121) | Payment | `currency_rate` = live `getRateByCode(invoice currency)` at payment time, throwing `FOSSBilling\Exception` "Currency rate for code 'X' is not configured." when null; then `countIncome(invoice)`. Also sets `issued = true`. All PHP payment paths (admin mark_as_paid, gateway callbacks, credit payment) funnel through `markAsPaid` → `markAsPaidInTransaction` |
| `countIncome` (:1385) | Payment, refund, debit-note creation — the ONLY writer of the base pair | `base_income = toBaseCurrency(currency, getTotal(invoice))`; `base_refund = toBaseCurrency(currency, refund)` if refund non-null, else NULL. Called from exactly 3 sites: payment (1121), refund (1984), debit-note creation (2594) |
| `refundInvoice` (1764) + `createRefundDocument` | Refund | Original's `refund` column INCREMENTS by the credit amount; status → `refunded` when `total − refund ≤ 0.005`; then `countIncome(original)`. The credit note itself gets NO three-column values (status `refunded`, issued, paidAt set, negative-price items) |
| `debitInvoice` (~2500–2594) | Debit-note issuance — THE exception | New note gets status `unpaid`, issued, currency copied, NO `currency_rate`; then `countIncome(new)` → `base_income` populated immediately at issuance, `base_refund` NULL |
| Issue path, reissue/cancel paths, cron/batch paths | — | Touch none of the three columns |

Supporting rules:

- `toBaseCurrency` (`src/modules/Currency/Service.php:110`): default
  currency → amount as-is; else amount × `getBaseCurrencyRate` =
  `1 / conversion_rate`. `getRateByCode`
  (`CurrencyRepository.php:204`) returns the `conversion_rate` column or
  null.
- `getTotal` (`Service.php:1752`, item `getTotal` = price × quantity)
  EXCLUDES tax. Refund-remaining computations use `getTotalWithTax`
  instead. Stats reads use `COALESCE` (NULL-safe).
- PHP float rendering: floats are cast to string with precision 14
  (`(string)` in `setCurrencyRate`/`setBaseIncome`/`setBaseRefund`), so
  PHP-on-SQLite stores `"66.666666666667"` for 60/0.9, not the raw
  double. TS must bind precision-14 strings (same algorithm as the R5a
  config-store writer) so SQLite stores the identical double and
  PG/MySQL round identically (DECIMAL scale enforces 2dp there on both
  stacks). Verified with node: `100 − 66.666666666667 = 33.333333333333`,
  matching PHP's envelope income exactly, provided the precision-14
  string (not the raw JS double) is bound.

## 2. TS reader audit (why no read-path change was needed)

- `invoice.ts` `invoiceArray` (line ~281, used by admin/client/guest get
  and get_list) exposes `currency_rate: Number(inv.currency_rate ?? 1)`
  and `income: (base_income ?? 0) − (base_refund ?? 0)`, and NO
  `base_income`/`base_refund` keys. Both coalesces match PHP exactly:
  PHP `toApiArray`'s second-half mapper uses `currency_rate ?? 1` and its
  income line uses `COALESCE`-equivalent arithmetic. **No `invoiceArray`
  change.**
- `stats.ts` uses `COALESCE` everywhere (NULL-safe). **No `stats.ts`
  change.**
- No code under `apps/nextjs/src/app/` or `src/lib/` reads
  `currency_rate` from envelopes; the payment view reads only
  subtotal/tax/total/lines/buyer from `invoiceArray`. `summaryArray`
  (invoice.ts:352) does not expose `currency_rate`.
- **Envelope correction to the scope doc:** PHP's get envelope does NOT
  carry null `currency_rate` and does NOT carry `base_income`/
  `base_refund` keys at all — its key set is identical to TS's (47 keys,
  verified from captures). PHP `toApiArray`'s raw row values feed only
  the computed `income`; the returned result uses `currency_rate ?? 1`.
  So PHP draft envelope `currency_rate` = int 1, paid = DECIMAL string
  (`'1'`, `'0.9'`); TS = number (1, 0.9). Value-equal, type differs
  (string vs number) — a pre-existing representation difference,
  documented in parity35 as an asserted note, not fixed. The fix is
  DB-level writers + the `countIncome` mirror only.

## 3. TS creation sites found (all fixed)

- `money.ts` `prepareInvoice`: froze `currency_rate` from
  `findCurrencyByCode` (`?? 1`) → now `null`.
- `db.ts` `insertInvoice` (used by `prepareInvoice` and the
  funds_invoice direct call): wrote `currency_rate` from caller,
  `base_income` literal 0, `base_refund` literal 0 → now NULL/NULL for
  the base pair, `currency_rate: number | null`. (Its `credit` column
  is written NULL already — the `credit: 0` passed by callers is
  ignored by the SQL — matching PHP's unset credit. No change needed.)
- `db.ts` `insertInvoiceNote` (used by refund credit notes and debit
  notes): wrote `currency_rate` from `noteRowFrom`, `base_income ?? 0`,
  `base_refund` literal 0 → now `currency_rate: number | null`,
  `base_income ?? NULL`, `base_refund` NULL.
- `invoice.ts` `noteRowFrom`: copied the original's rate (`?? 1`) →
  now `null` always.
- `money.ts` `markInvoicePaid`: `base_income = round2(total × frozen
  rate)` where total was WITH tax and rate was the frozen
  `currency_rate` (or 1) — two errors vs PHP (wrong rate direction,
  wrong total) → rewritten (see §4).
- `invoice.ts` refund core: `base_refund = round2((base_refund ?? 0) +
  amount × frozen rate)` — incremental with × rate, vs PHP's recompute
  → rewritten (see §4).
- `invoice.ts` debit handler: inline `base_income = round2(sum × frozen
  rate)` at note creation → restructured (see §4).
- `cart.ts` staff checkout: the R1g patch NULLing all three after
  `prepareInvoice` → REMOVED (redundant after the shared fix, with a
  comment saying so), not kept.
- `cart.ts` `staffMarkInvoicePaid`: pre-set `currency_rate = rate`
  (live basket currency rate) before calling `markInvoicePaid` →
  REMOVED, along with the now-unused `rate` param (call site updated).
  The `rate` variable in the staff-checkout handler itself is still
  used for order pricing and stays.
- `invoice.ts` funds_invoice direct `insertInvoice` call: passed
  `currency_rate = getCurrencyRate(client.currency)` → now `null`;
  `getCurrencyRate` was then unused (only caller was that line) and
  was REMOVED.
- Other `prepareInvoice` callers covered by the shared fix with no
  separate change: admin create, reissue, renewal_invoice, client
  renewal, client checkout, order create with issue-invoice option,
  `tryPayWithCredits` → `markInvoicePaid`, gateway IPN payment paths →
  `markInvoicePaid`, subscription generation → `prepareInvoice`.
- Types widened to `| null` in `db.ts` `InvoiceRowFull`
  (`currency_rate`, `base_income`, `base_refund`, plus `credit` and
  `refund`, which the DB genuinely returns as NULL and `invoiceArray`
  already handles as null). `updateInvoiceFields`' type still lists
  `base_refund: number`; no caller passes it anymore — type-only
  residue, left as-is.

## 4. Fix shape per site

`apps/nextjs/src/server/money.ts`:

- `phpFloat(n)` (new, exported): precision-14 `%G` rendering, same
  algorithm as the R5a config writer — every base-currency write binds
  this string.
- `toBaseCurrency(code, amount)` (new): default currency → amount
  as-is; else amount × 1/live `conversion_rate`; mirrors PHP throws
  ("Currency not found." for a null rate row, "Currency conversion
  rate cannot be zero." for 0) as `FbError` default 9999.
- `countIncome(invoiceId)` (new): mirrors PHP exactly. No-tax subtotal
  = raw float sum of price × quantity (NOT `invoiceTotals`, which is
  tax-inclusive and round2'd); `base_income =
  toBaseCurrency(subtotal)`; `base_refund = refund == null ? NULL :
  toBaseCurrency(refund)`; single UPDATE, values bound as phpFloat
  strings.
- `prepareInvoice`: `currency_rate: null`, no rate lookup.
- `markInvoicePaid`: (a) live rate lookup, throw `FbError("Currency
  rate for code 'X' is not configured.")` if null — before any write;
  (b) UPDATE `currency_rate` (phpFloat string), `status` paid,
  `paid_at`, `issued = 1`; (c) items pending_payment → pending_setup;
  (d) `countIncome(id)`; (e) paid event + email unchanged.

`apps/nextjs/src/server/db.ts`: `insertInvoice` / `insertInvoiceNote`
SQL + types per §3.

`apps/nextjs/src/server/modules/invoice.ts`:

- Refund core: replaced the incremental `base_refund` UPDATE with
  UPDATE `refund = newRefundTotal`, then `countIncome(inv.id)`
  (recomputes `base_income` identically and `base_refund` from the
  running refund). Status-flip rule and refund-column logic unchanged.
- Debit handler: deleted the inline `base_income` override; create
  note (NULLs), insert items (existing code), then
  `countIncome(noteId)`.
- Funds call: `currency_rate: null`; `getCurrencyRate` removed.

`apps/nextjs/src/server/modules/cart.ts`: staff-checkout NULLing patch
deleted; `staffMarkInvoicePaid` currency_rate pre-set + `rate` param
deleted.

Deliberately NOT changed: tax resolution, totals-at-read-time,
numbering, snapshots, the refund status-flip rule (TS
`newRefundTotal >= total` vs PHP `total − refund ≤ 0.005` tolerance —
exact-amount cases agree; see §6), `invoiceArray`, `stats.ts`.

## 5. Capture corpus (before the fix)

`docs/nextjs-strangler/phase5/capture38.py` + `captures38/php.json` +
`captures38/ts.json`; log `~/scratch/fossbilling/r5-logs/capture38.log`.
Setup per stack (snapshot-restored): EUR currency row
(conversion_rate 0.9, non-default, manual), EUR client
(`eur.capture@example.com`), tax rule (US/TX 10%) +
`tax_enabled = 1`. Flows per stack: USD draft → issue → pay; USD taxed
pay; EUR draft → pay; EUR partial refund (lines 60+30, refund 60-line);
USD full refund; debit on issued unpaid (25); funds_invoice (50,
client session); missing-rate pay (EUR draft, currency row deleted,
then pay).

PHP vs pre-fix TS, DB values (the proof the brief's divergence was real):

| Flow | PHP | Pre-fix TS |
|---|---|---|
| USD draft/issued | NULL/NULL/NULL | rate 1, base 0/0 (issue changes nothing on either) |
| USD paid | rate 1, base_income 100, base_refund NULL | rate 1, base_income 100, base_refund 0 |
| USD taxed paid (100 + 10% = 110) | base_income 100 (no tax) | 110 (with tax) |
| EUR draft | NULLs | rate 0.9, base 0/0 |
| EUR paid (90 @ 0.9) | rate 0.9, base_income 100 (= 90/0.9) | rate 0.9, base_income 81 (= 90×0.9) |
| EUR partial refund | refund 60, base_refund 66.666666666667, base_income 100, income 33.333333333333, status paid | refund 60, base_refund 54, base_income 81, income 27 |
| USD full refund | identical already (rate 1, base 100, base_refund 100, refunded) | identical |
| Credit notes (both refund cases) | NULL/NULL/NULL | rate + 0/0 |
| Debit note (USD 25) | base_income 25, rate NULL, base_refund NULL | base_income 25, rate 1, base_refund 0 |
| Funds invoice | NULLs | rate 1, base 0/0 |
| Missing-rate pay | error `{message: "Currency rate for code 'EUR' is not configured.", code: 9999}`, invoice stays unpaid with NULL rate | PAID it (rate fallback 1, no throw) |

Baseline note: reference invoice 1 (paid, USD) carries the old bug
(`base_refund` 0 instead of NULL) from Phase 0/1-era TS payment.
Baseline invoices are never touched; parity35 uses crafted invoices
only, snapshot-restored.

## 6. Parity35 results — 198/198

`docs/nextjs-strangler/phase5/parity35.py`. Runs PHP flows, restores,
runs TS flows, restores, then compares field by field (DB-exact,
None-aware; envelope `currency_rate` compared numerically with the
raw-type difference asserted separately). One failure on the first run
was the list comparison comparing PHP's `'0.9'` string to TS's `0.9`
number — the documented representation difference, not a value
difference; the check now normalizes numerically, and the second run
is 198/198. Sections: B creation NULLs (draft/issued/EUR/funds);
C population transitions (USD pay, taxed pay, EUR pay, EUR partial,
USD full, both debit notes, both credit notes); D missing-rate throw
before any write on both stacks; E read paths (admin get, admin
get_list filtered by the crafted EUR client, stats `get_income`
series by calendar day — the issued=1 visibility proof); F restore
proof (invariants, sequences, config hash, crafted rows gone).

Divergences found and pinned (not hidden):

- **Additional payment-path correction, INCLUDED in this batch:**
  PHP `markAsPaidInTransaction` also sets `issued = true` at payment;
  TS `markInvoicePaid` did not. Since TS stats queries filter
  `issued = 1`, TS-paid invoices were stats-invisible. Fixed in the
  same UPDATE (same PHP function being mirrored), with its own
  parity case (DB `issued` + `get_income` series equality). The
  regression run adjudicated: stats series match on both stacks.
- **Envelope correction (scope-doc fix, §2):** PHP's get envelope
  carries NO `base_income`/`base_refund` keys and `currency_rate ?? 1`,
  so no `invoiceArray` change was needed; the fix is DB-level only.
- **Representation note:** PHP `currency_rate` is int 1 (draft) /
  DECIMAL string (paid); TS is a JSON number. Values equal; asserted
  as documentation in parity35 §E, not fixed.
- **Partial-refund param shape (pre-existing, NOT fixed):** PHP takes
  an `{id: qty}` map with partial quantities supported; TS takes a
  `[{id}]` array, full lines only. parity35 compares outcomes, not
  encoding (PHP map vs TS array per stack, same refunded line).
- **Status-flip tolerance (pre-existing, NOT changed):** TS
  `newRefundTotal >= total` vs PHP `total − refund ≤ 0.005`. Agrees
  on exact-amount cases; a 0.004-gap partial refund would flip on PHP
  but not TS. Out of scope; noted for a later batch if anyone cares.
- **Refund/credit envelope null-vs-0 handling** is outside the three
  columns and untouched.
- **No old assertion needed updating.** The expected risk (suites
  asserting the old frozen/zeroed creation values) did not
  materialize: parity34–25 all pass unchanged. The old values were
  asserted nowhere in the parity corpus — the divergence lived only
  in the implementation, which is why the capture corpus, not the
  suites, caught it.

## 7. Regression results (exact counts)

- `tsc --noEmit` clean; `npm run build` exit 0; new build verified
  live by grepping the production bundle for the missing-rate message
  string (`Currency rate for code`) after restart.
- parity35: **198/198**.
- parity34: **164/164**; parity33: **77/77**; parity32: **65/65**;
  parity31: **63/63**; parity30: **179/179**; parity29: **62/62**;
  parity28: **128/128**; parity27: **27/27**; parity26: **62/62**;
  parity25: **203/203** (its `admin/support/canned_delete` php=403 /
  ts=200 note line is pre-existing suite output, not a failure).
- parity21: **194/203, exactly the known 9 diffs** (re-run with full
  output to confirm names): `sd_tld_delete`, `sd_tld_delete_used`,
  `sd_tld_delete_notfound`, `sd_reg_available`, `sd_guest_tlds`,
  `sd_guest_tlds_reg`, `sd_guest_tlds_trans`,
  `sh_guest_free_tlds_fallback`, `dl_admin_send_file_missing_stored`.
- Fixtures: **13/13 both stacks**, verified via `results-php.json` /
  `results-next.json` (all entries PASS), not the summary lines.
- DB invariants clean before AND after: invoice 323, client_order 11,
  email_queue 67, service_custom 17, extension 6, extension_meta 3,
  setting 38, admin 2, admin_group 3, admin_group_member 1, currency 1,
  client 3, support_ticket 2, tld 1; sequences setting 56 /
  extension_meta 41 / currency 8; reference `config.php` hash
  unchanged. Reference Next (:3001) restarted on the fresh build
  after the fixture run (fixture runner's own :3001 listener killed
  by explicit PID first, per the R5a trap); PHP:8080 untouched
  throughout the regression.
- Logs: `~/scratch/fossbilling/r5-logs/parity35b.log`
  (198/198), `regress35.log` (parity34–25 + parity21 tails),
  `parity21-r5b.log` (full diff names), `parity25-r5b.log`
  (203 count), `fixtures-r5b.log`.

## 8. Review fix (parent, pre-commit): payment/refund/debit atomicity

The parent's diff review found a hole in the NEW payment code, fixed
before commit (not a worker miss hidden from the counts):

- PHP wraps payment (`markAsPaid:1050`), refund (1861) and debit
  (2516) in `wrapInTransaction`, so ANY countIncome throw rolls
  everything back: the observable outcome is "error + nothing
  changed". TS has no transaction across these handlers. The
  worker's `markInvoicePaid` validated only row existence before
  writing, so a zero conversion rate would leave a PAID invoice
  (status + rate 0.0, NULL bases, items unmoved) where PHP leaves
  it unpaid — and a NULL rate would leave the same partial state
  with the wrong message ("cannot be zero" instead of PHP's
  "not configured").
- Fix: `money.ts` `assertCountIncomeWritable(code)` — default row
  must exist ("Default currency not found."), non-default rows
  must exist ("Currency not found.") with a positive rate
  ("Currency conversion rate cannot be zero."), default-currency
  invoices short-circuit exactly as PHP's `toBaseCurrency` does —
  called in `markInvoicePaid` (after the live rate lookup, before
  the first UPDATE), at the top of `refundInvoiceCore` (after the
  remaining check, before the nr claim + note creation), and in the
  debit handler (after client lookup, before the nr claim + note
  creation). Placement preserves PHP's validation-error precedence
  and never consumes a CN/DN number on an FX failure.
- Null-rate branch note: the reference schema declares
  `currency.conversion_rate NUMERIC NOT NULL`, and the Doctrine
  entity types it non-nullable — so a NULL rate is unreachable on
  any real install; the null check mirrors PHP's `getRateByCode`
  null branch defensively and is covered by code inspection, not
  by a parity case (one cannot be constructed without violating
  the NOT NULL constraint). The zero-rate case IS constructible
  and is proven by parity35 §G (pay + refund + debit, error +
  unchanged + no note, both stacks).
- Parity35 grew by the §G cases (pay/refund/debit zero-rate);
  counts below are the worker's pre-fix runs and must be re-read
  from the parent's re-verification (parity35 re-run with §G).

## 9. Left for a later batch (not hidden)

- Staff-checkout end-to-end flow beyond the shared helper: the R1g
  patch is deleted and the shared helper is fixed, but no parity case
  runs a full staff basket checkout asserting the three columns after
  this batch — the next batch touching cart checkout should add one
  (or confirm coverage elsewhere).
- R5a N1 (JSON-null reminder stored value: PHP NULL, TS `"null"`
  string — pre-existing write-loop stringification, needs its own
  batch).
- R5a gap: `update_params` `canUpdateParam` company-field permission
  checks NOT ported (18 company fields need `manage_company_details`,
  3 legal need `manage_company_legal`; the `settings-fields.ts` note
  claiming the seam enforces them is inaccurate).
- Status-flip tolerance (§6) and partial-refund param shape (§6),
  if anyone wants them unified.
- `updateInvoiceFields` type residue: `base_refund: number` with no
  remaining caller (type-only, harmless).
- Baseline invoice 1's old-bug `base_refund` 0 (Phase 0/1-era TS
  payment) is left as-is: baseline rows are never rewritten by
  parity work. A data migration for pre-fix rows is a separate
  decision, not part of this batch.
