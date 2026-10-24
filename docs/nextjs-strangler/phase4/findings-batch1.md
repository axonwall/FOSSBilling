# Phase 4 batch 1 findings — IPN intake + transaction processing

First Phase 4 commit, on new branch `feat/nextjs-phase4-gateways`
(stacked on `feat/nextjs-phase3-money`). The payment callback path
is now served by TS at the same URL PHP uses: `POST /ipn.php`.

## Gates

- **Parity: parity10 checks 14/14** against the capture13/13b PHP
  oracle (Custom IPN + approve/process/claim/process-all + Stripe
  signature paths). Regression: parity7 20/20; fixtures **13/13 on
  both stacks**. tsc clean, build PASS (route `/ipn.php` live).

## What the captures pinned

- **Custom is a manual-approval gateway.** A form IPN to
  `/ipn.php?gateway_id=1` does NOT settle: PHP persists a
  transaction in status `error` with
  `"Custom payments must be approved by an administrator."` and
  answers with that error envelope (**code 7002**); the invoice
  stays unpaid. `transaction_process` on Custom refuses with the
  same 7002. Settlement is `transaction_approve` — allowed even on
  the errored transaction — which fills amount/currency/note from
  the invoice and pays it from the existing transaction record
  (no second transaction, no net balance change).
- **Stripe webhooks authenticate before anything is stored.** A bad
  `Stripe-Signature` yields `Invalid Stripe webhook signature`
  (9999) and leaves no transaction row. A validly signed
  *unhandled* event type returns the new transaction id and the row
  is then deleted (PHP adapter behavior) — mirrored.
- **Documented divergence (sandbox-only):** for
  `payment_intent.succeeded`, PHP's handler verifies event
  ownership against the live Stripe API; in this sandbox that call
  cannot succeed, so PHP deletes the transaction and the invoice
  stays unpaid. The TS handler instead settles from the *signed*
  payload (signature verification makes the payload trustworthy):
  metadata `invoice_id` + `amount_received` must match the invoice
  total in cents, then the transaction is processed and the invoice
  paid — which is PHP's production outcome with live keys. Other
  handled event types (subscription lifecycle, refunds) are kept as
  `received` rows pending Stripe API access, rather than deleted.
- The seeded reference install gained a **test-mode Stripe gateway**
  (id 3, `whsec_test_…` secret) inserted directly in the DB by the
  capture script, solely to exercise the signature path.

## Implementation notes

- `src/app/ipn.php/route.ts` mirrors `src/ipn.php`: 400s for
  non-integer gateway/invoice ids, 1 MiB body cap (413), form vs
  JSON split, txn-id idempotency for form callbacks (a processed
  duplicate returns the existing transaction id).
- Stripe signature verification: HMAC-SHA256 over `t.payload` with
  the gateway's `(test_)webhook_secret`, timing-safe compare,
  300-second timestamp tolerance (Stripe's default, as in PHP's
  `Webhook::constructEvent`).
- Admin `transaction_process` / `transaction_approve` /
  `transaction_process_all` / `transaction_claim_for_processing`
  now have real implementations behind the batch-3 stubs;
  process-all parks per-transaction failures on the rows' error
  fields and still returns true.
