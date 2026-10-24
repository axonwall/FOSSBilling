# Phase 3 batch 1 findings — Product reads + Cart (incl. checkout)

Branch `feat/nextjs-phase3-money` (stacked on `feat/nextjs-phase3-prep`).
Modules behind `FB_TS_MODULES`: `product`, `cart`. The invoice core
the checkout needs (tax resolution, totals, prepare/issue, credit
payment) landed as `src/server/money.ts`, ready for batch 2's Invoice
module port.

## Gates

- **Fixture corpus: 13/13 on PHP and 13/13 through the Next origin**
  (`run-fixtures.py --stack next`; the runner now starts the Next
  server against the disposable install). The cart fixtures are the
  TS-gated ones: TS computes cart totals, creates orders + the
  invoice, freezes the tax rate — and PHP's own invoice reads then
  verify the totals from the rows TS wrote.
- **Parity: capture9 corpus 15/15** (product guest/admin reads, cart
  flows). Regression: parity2 16/16, parity3 32/32, parity4 21/21.
  parity5 (Phase 2 staff-mutation corpus) could not be fully
  re-verified this round: its PHP oracle itself fails in the sandbox
  right now — staff creation returns "Email address is invalid"
  because PHP's email validation does live DNS lookups the sandbox
  proxy breaks intermittently (same class as the Phase 1 signup
  observation). Recapture + rerun is a five-minute job when DNS
  behaves; nothing in this batch touches the staff paths.
- tsc clean, production build PASS.

## Behaviors worth knowing

- **`guest/cart/add_item` resets the cart by default.** Unless the
  caller passes `multiple`, each add starts a fresh cart (the
  storefront's one-product flow). The stored item config is the whole
  request minus id/addons — `multiple` itself leaks into the item
  array. Both quirks are mirrored.
- **TS can now create sessions.** A session-less guest cart call makes
  TS insert a PHP-shaped session row (empty Symfony bags, hex id) and
  set the cookie; verified bidirectionally — PHP reads a TS-created
  session and returns the same cart.
- **The DB layer reopens its connections when the database file is
  replaced** (inode check). The fixture harness restores the DB by
  file replacement between fixtures; without this, the long-lived
  Next server would keep reading the unlinked inode.
- **Checkout shape:** one order per cart item (family group_ids from
  the `__cart_family` stamps), one invoice for the basket (order
  lines + discount lines + setup lines), promo redemptions reserved
  against an unpaid invoice, `promo.used` reserved per order, orders
  linked via `unpaid_invoice_id`, cart deleted. When the client's
  balance covers the total, issuance pays from credits exactly as
  PHP does (balance ledger row + paid status + journal events).
- Product pricing titles for periods are generated (`Every 1 month`);
  domain products expose the TLD price map (DECIMAL prices as strings,
  registrar object on admin reads only); domain unit is `year`.

## Deferred (documented, not silent)

- Addons and bundled domains in carts; domain/hosting product order
  configs; automatic promos (manual codes only); staff baskets;
  related-item discounts; stock control; price overrides.
- Order activation: `after_payment` products activate via the paid
  invoice + cron exactly as in PHP (cron stays PHP in the strangler);
  `after_order` immediate activation is not yet mirrored (no such
  products in the reference catalog).
- Product mutations (admin create/update/delete, categories, promos
  admin) — batch 2/3 scope alongside the Invoice and Order ports.

## Environment notes (reference instance)

- PHP rate-limits logins (`api_login`: fixed window, 10/hour/IP);
  heavy parity days will trip it. The limiter state lives in
  `data/cache/rate_limit_*` and can be cleared there.
- The parity corpora are stateful against the shared reference DB;
  mutation corpora (capture8/parity5) need their artifacts cleaned
  (or a recapture) between runs.
