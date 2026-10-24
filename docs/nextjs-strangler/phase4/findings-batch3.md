# Phase 4 batch 3 findings — deposit top-ups + PayPalEmail IPN

Third Phase 4 commit on `feat/nextjs-phase4-gateways`. Clients can
top up their balance through funds invoices, and the PayPalEmail
IPN adapter is ported.

## Gates

- **Parity: parity12 checks 12/12** against the capture15 PHP
  oracle (deposit cases are oracle runs; PayPal post-verification
  cases run with `FB_PAYPAL_SKIP_VERIFY=1` and are
  source-verified — see below). Regression: parity11 16/16,
  parity10 14/14, parity9 16/16 (refund-core extraction),
  parity7 20/20; fixtures 13/13 on both stacks. tsc clean,
  build PASS.

## What the captures pinned

- **Funds invoices** (`client/invoice/funds_invoice`): amount
  required ('Amount is required'), numeric ('You need to enter
  numeric value'), client must have a currency, `funds_enabled`
  setting (disabled → 980), min/max settings (981/982). The
  invoice is born issued with one line: type `deposit`, title
  'Add funds to account', price = amount, quantity 1, taxed 0,
  charged 1, status `pending_payment`, due in 5 days
  (`invoice_due_days`).
- **Paying a deposit credits the balance, and the credit row
  differs by path.** Admin `mark_as_paid` (which requires a
  transactionId for Custom — 'Transaction ID is required when
  using the Custom payment gateway.', a check TS previously
  lacked and now enforces) credits type `invoice`, rel_id =
  invoice id, description 'Custom transaction No: <txn>'. The
  approve path credits type `gift`, rel_id null, description
  'Custom transaction No: <txn_id or empty>'. Plain
  `markAsPaid` does NOT credit — only the admin path and the
  approve service do, so TS credits in exactly those two
  handlers, not in the shared `markInvoicePaid`.
- **PayPalEmail verification runs in this environment.**
  `Environment::isTesting()` is true only for APP_ENV=testing;
  the reference install runs dev, so every IPN with post data
  attempts the PayPal re-post — and fails at the sandbox TLS
  layer, parking the transaction as `error` with the TLS message
  and leaving the invoice unpaid. Missing post data still errors
  first (7021, 'PayPal payment data is missing.'). TS mirrors
  the order: missing-post → 7021, then verification (POST
  cmd=_notify-validate + receiver-email check), then the
  callback-signature binding. The TS verification failure text
  differs (fetch abort/TLS wording) — structure, not wording,
  is the parity claim there.
- **PayPal settlement (source-verified, skip-verify runs):**
  signature = HMAC-SHA256(`gatewayId|invoiceId`, app salt)
  ('PayPal callback signature is invalid' without it);
  currency mismatch and missing-currency messages pinned;
  non-Completed payments stay `received` with
  'PayPal payment not completed: <status>'; Completed
  web_accept adds a `PayPal`-type balance row (rel_id = txn id)
  and pays the invoice from it (net balance effect 0 for normal
  invoices), or marks a deposit invoice paid without a second
  credit; replays are idempotent (dedupe returns the processed
  txn id). Subscription signup/modify/cancel/failed/skipped
  branches and the Refunded → credit-note path are ported from
  the adapter source (the refund core is now shared with the
  admin refund handler); they are not oracle-verified.

## Implementation notes

- `src/server/paypal.ts` is the adapter. `FB_CALLBACK_SALT`
  must be set for signature verification (the install's
  `info.salt`); `FB_PAYPAL_SKIP_VERIFY=1` is a dev-only
  bypass for testing the post-verification logic.
- Verification fetches are capped at 15s — an unbounded fetch
  hung the IPN endpoint in the sandbox during verification.
- Two type-fidelity fixes fell out of parity: `client_balance`
  rel_id is VARCHAR, so TS now binds it as text (node:sqlite
  stored floats as '263.0' where PHP stores '263'), and
  `insertInvoiceItem` gained an optional `charged` field
  (deposit lines carry charged=1).
- Deferrals remaining in Phase 4: support/extension leftovers
  (ticket/knowledge-base surfaces are Phase 1 UI only; the
  Support admin API and Extension module APIs are unported).

## Gate correction: fixture pollution, not a code regression

- The first post-batch fixture run failed 9/13 on the Next
  stack. Root cause was reference-DB pollution, not batch-3
  code: the runner re-snapshots the live reference DB at every
  run, and capture15/parity12 had left client 1's balance at
  235 (funds credits + PayPal rows). With balance >= basket
  total, checkout pays from credits at issuance and returns
  `invoice_hash: null` by design — so three checkout fixtures
  failed their invoice-get step, and the pay-with-credits
  fixture's seeded-balance expectation (0 + 50 - 30 = 20) read
  255. Fix was hygiene, not code: the batch-3 artifact balance
  rows (ids >= 5) and funds/PayPal invoices were deleted from
  the reference DB, restoring balance 0; re-run 13/13 on both
  stacks. Rule going forward: capture/parity runs that touch
  the reference balance must clean their balance rows too
  (parity12's invoice cleanup was not enough).
