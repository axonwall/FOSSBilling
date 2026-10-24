# Phase 3 prep: the money map and the shadow-run gate

Phase 3 ports the money path — Product/Cart/Order, then
Invoice/Tax/Transaction/Subscription — under the conversion plan's
critical gate: **TS computes, PHP bills, and the diffs must be zero**
across the fixture corpus (and later a live-traffic replay window)
before any money module may serve real traffic. This prep batch
builds the executable form of that gate.

## The money calculation seams (where the numbers come from)

- **Pricing** lives in two tables: `product_payment` (`type`,
  `once_price`, `once_setup_price`) and `product_payment_period`
  (`code` like `1M`, `price`, `setup_price`, `enabled`). There is no
  JSON pricing blob at 0.8.9.
- **Cart totals** are computed by `Cart\Service` from the session cart
  (`cart` + `cart_product` rows): `guest/cart/get` returns
  `subtotal`, `discount`, `total`, and the applied `promocode`.
  Promos are `Product\Entity\Promo` rows: `type` is `percentage` or
  `absolute`, plus `value`, `freesetup`, `recurring`, `stackable`,
  usage caps. `client/cart/checkout` creates the order(s) and the
  invoice and returns `order_id` + `invoice_hash`.
- **Tax** is resolved once, when an invoice is prepared
  (`Invoice\Service::prepareInvoice` → `Tax` service
  `getTaxRateForClient`): precedence is **state+country rule →
  country rule → global rule (country/state NULL) → 0**. Two gates sit
  in front of it (`Client\Service::isClientTaxable`): the
  **`tax_enabled` system setting** must be on, and the client must not
  be `tax_exempt`. The resolved rate + name are frozen onto the
  invoice row (`taxrate`, `taxname`).
  - ⚠️ **`tax.taxrate` is a percentage, not a fraction**: storing
    `21` means 21%. The Pest tax tests mock the value `'0.21'` and
    only assert pass-through, so they never reveal this — the live
    baseline did (a `0.10` rule produced 0.1% tax). Fixtures store
    percent values.
- **Invoice totals are computed at read time**, not stored:
  `get` returns `subtotal` (Σ price×qty over lines), `tax`
  (Σ over **taxed** lines of line-total × rate, rounded to cents),
  `total = subtotal + tax`. Lines carry a `taxed` flag.
  - ⚠️ **Form encoding cannot set `taxed`**: the API's form path
    delivers the string `"1"`, which the strictly-typed
    `InvoiceItem::setTaxed(int|bool|null)` rejects (error code 9998).
    A JSON body with a real boolean works. The fixture harness
    therefore supports per-step JSON encoding, and any TS client of
    this API must do the same for typed fields.
- **Payments**: `admin/invoice/mark_as_paid` (gateway id, e.g. the
  Custom gateway) and `admin/invoice/pay_with_credits`, which draws
  down the client's balance (`client_balance` ledger rows; the
  balance is their signed sum). Transactions and subscriptions are
  entities of the Invoice module (`transaction`, `subscription`
  tables); cron's first two batch jobs (pay-with-credits,
  activate-paid) consume them.

## The fixture corpus (`fixtures/`)

Stack-agnostic JSON: declarative `seed_sql` / `clone_client` ops,
API `steps` (identity, route, params, optional JSON encoding,
`save` of values for `$references`), and `expect` assertions —
dotted paths into step results or scalar SQL against the DB.
Expectations were extracted from the Pest money suites
(`ServiceTaxTest`, Cart/Invoice service tests) and from live probes;
each fixture names its source.

Current corpus (12 fixtures, all passing on PHP):

- **tax**: state-beats-country-and-global, country rule, global
  fallback, no rule → 0, tax-exempt client, tax disabled globally.
- **invoice**: mixed taxed/untaxed lines (150 + 10 tax), quantity
  and rounding (33.33 × 3 @ 7% → tax 7.00, total 106.99).
- **cart**: one-time product checkout (order + unpaid invoice of
  10.00), 10% promo (discount 1.00, invoice 9.00).
- **payments**: pay-with-credits (50 balance − 30 invoice → 20 left,
  status paid), mark-as-paid via the Custom gateway.

## The harness (`run-fixtures.py`)

- Builds a **disposable copy** of the reference install (app copy,
  vendor **hardlink** copy — a symlink makes PHP resolve `__DIR__`
  into the original tree and fatals on duplicate classes; the whole
  `data/` dir is copied because a completed
  `update-finalization.json` is what keeps the app out of
  maintenance mode), rewrites its config to its own SQLite, serves
  it on :8081.
- Snapshots the reference DB once and **restores it before every
  fixture** — fixtures are order-independent and repeat runs are
  deterministic (verified: two consecutive 12/12 runs).
- Writes `results-php.json` (scrubbed step envelopes) as the
  baseline artifact.

## The gate, going forward

1. Every Phase 3 batch ports its module behind `FB_TS_MODULES` as
   before, with `FB_PARITY=1` spot checks.
2. The batch is done only when `run-fixtures.py` replays the corpus
   **through the Next origin** (TS serving the money modules against
   the same disposable DB) with the same expectations passing —
   zero differing expectations, not "close enough".
3. The corpus grows with each batch: recurring-period pricing and
   setup fees, absolute promos and free-setup, renewals/subscription
   generation, Stripe webhook/IPN replays, and the cron batch jobs
   are the known next fixture areas. Any PHP/TS divergence found by
   the corpus is a finding to document here, never a silent fixture
   edit.
