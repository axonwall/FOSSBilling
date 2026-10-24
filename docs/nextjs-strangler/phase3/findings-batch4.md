# Phase 3 batch 4 findings — corrections, renewals, batch jobs, cron

Fourth commit on `feat/nextjs-phase3-money`. This closes the Phase 3
money surface: invoice corrections (refund/credit notes, debit notes,
cancel, reissue), renewal invoices, the journal, reminders, the
invoice/order batch jobs, and a cron module with a TS runner.

## Gates

- **Parity: capture12 corpus 16/16.** Regression: parity7 **20/20**
  (capture10 corpus refreshed against current PHP state — see the
  state note below), parity8 27/27, parity6 15/15, Phase 2 suite
  21/21; fixtures **13/13 on both stacks**. tsc clean, build PASS.

## Semantics pinned by the captures

- **Refunds create credit notes** (serie `CN-`, own numbering,
  negative lines with status `executed`, task `void`, lines linked
  back via `refunded_item_id`), set the original's `refund` column
  and `base_refund`, and flip the original to `refunded` when fully
  covered. Admin detail reads now compute per-line
  `remaining_quantity` from those links. **Debit notes** (serie
  `DN-`) are issued, unpaid, carry a due date, and count their total
  as income immediately.
- **PHP appends audit lines to invoice notes** —
  `"<ts>: Refund invoice #N generated."`, `"Debit for #N invoice."`,
  `"Invoice canceled (voided) without replacement."`,
  `"Reissued as invoice #N."` / `"Replacement for invoice #N."` —
  each padded and newline-terminated. Cancel is a status flip (no
  document); reissue issues a replacement and cancels the original
  with cross-links both ways.
- **`subscribable` is real:** an invoice with a recurrent order line
  reports `subscribable: true` plus `subscription {unit, cycle,
  period}` — no longer hardcoded false.
- **NULL-vs-zero money columns:** PHP-created invoices carry NULL
  `credit`/`refund` (surfaced as 0); TS inserts originally wrote
  literal 0s, which read back as the string `'0'` through the
  decimal typing. Both invoice insert paths now write NULL like PHP.
- A controlled experiment settled a wrong turn: PHP's
  `batch_activate_paid` does **not** execute manual-invoice items
  (verified live: a fresh paid invoice's lines stay `pending_setup`
  through the job) — it activates paid orders only. An interim TS
  version that executed items was reverted, and the reference DB
  rows it flipped were restored.

## Cron

`admin/cron/info` (path derived from the DB location,
`last_cron_exec` from settings) and `admin/cron/run` execute the
TS-owned jobs in order (activate-paid, reminders, suspend-expired,
cancel-suspended, cancel-unpaid) and stamp `last_cron_exec`.
`guest/cron/run` mirrors PHP's gate (module setting + security
hash, 403 otherwise). Batch-job thresholds that PHP derives from
product/system settings it doesn't expose in the corpus
(cancel-suspended 30 days, cancel-unpaid 7 days) are implemented as
documented approximations. `batch_generate` remains a run-and-true
endpoint: subscription-driven generation is gateway-side and has no
DB-visible effect on the corpus.

## State note

The capture corpora share one evolving reference install, and this
batch's PHP flows legitimately mutated seeded state (invoice 1 was
refunded by the batch-4 capture itself). Seeded rows were restored
where a corpus depends on them (invoice 1 back to paid, order 3's
`unpaid_invoice_id` cleared after renewal probes), and captures10
was refreshed from PHP so batch-2 parity measures code, not drift.

## Phase 3 status

Money is ported end to end: Product, Cart, Invoice (+ tax,
transactions, subscriptions, corrections), Order, Cron. Remaining
money-adjacent work sits in Phase 4 by plan: payment gateway
processing (Stripe webhook/IPN, transaction processing), invoice
PDF/email delivery, and the deposit-invoice balance flows.
