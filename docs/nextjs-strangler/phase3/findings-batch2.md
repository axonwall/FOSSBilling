# Phase 3 batch 2 findings — Invoice module

Second commit on `feat/nextjs-phase3-money`. The `invoice` module
joins `FB_TS_MODULES`: admin get/get_list (incl. summary mode),
prepare/update/issue, mark_as_paid, pay_with_credits (+ batch),
delete, item_delete, tax CRUD; client get (hash, owner-scoped) and
get_list; guest get (hash) and gateways. Built on the batch-1
`money.ts` invoice core.

## Gates

- **Fixture corpus: 13/13 on PHP and 13/13 through the Next origin** —
  now with TS serving the invoice lifecycle end to end (prepare →
  update → issue → mark_as_paid / pay_with_credits), not just the
  cart paths.
- **Parity: capture10 corpus 20/20** (invoice reads across
  admin/client/guest, the full mutation sequence, tax CRUD, and the
  pinned error cases). Regression: parity6 15/15, parity2 16/16,
  parity3 32/32, parity4 21/21. tsc clean, build PASS.

## Semantics pinned by the captures

- **Item lifecycle:** lines are created `pending_payment`; paying the
  invoice moves them to `pending_setup`. The `charged` amounts are
  NOT written by the admin/Custom payment path (they belong to item
  execution), and payment records `base_income` (total converted at
  the invoice's frozen currency rate).
- **mark_as_paid** creates the gateway transaction record (status
  processed, `ipn` JSON with source `admin`, sha256 ipn_hash,
  "Custom transaction No: …" note) and refuses a transaction id
  already attached to another invoice.
- **Client invoice access is hash-only and owner-scoped** — passing
  an id is an error ("Invoice hash was not passed"), and another
  client's hash is "Invoice was not found".
- **Guest access is policy-checked** (`checkInvoiceAuth`): admins and
  the owner pass; everyone else needs the
  `invoice_accessible_from_hash` setting, and an expired hash link is
  refused first ("This invoice link has expired", code 403; malformed
  hashes get code 4001). PHP's per-IP/hash rate limiter on this
  endpoint is not mirrored.
- **DECIMAL surfacing:** line `price` and `currency_rate` come back
  as strings from the database; PHP's in-memory entities occasionally
  show them as numbers instead — storage-form noise, normalized in
  the parity harness.
- Tax create/update require name + rate (update requires all fields);
  missing pieces produce PHP's exact "Tax … is missing" messages.

## Infrastructure changes

- The API route now preserves nested JSON bodies (`ctx.rawParams`)
  alongside the flattened string params — invoice `new_item`/`items`
  and batch id lists need real structures.
- **The DB connection is keyed to a file identity stamp**
  (inode + mtime + size). The fixture harness restores the DB by
  copying over it in place (same inode), which defeated the batch-1
  inode-only check and served stale pages; the stamp catches both
  replacement styles.
- Harness lesson: a leftover Next server on :3001 makes the fixture
  runner's readiness probe succeed against the WRONG server (reading
  the reference DB instead of the disposable one). Kill stray servers
  before fixture runs; a misdirected run also wrote a
  `fixture-txn-1` transaction into the reference DB, which then
  poisoned every later snapshot's mark-as-paid fixture until removed.

## Deferred

Refunds/credit notes, debit notes, reissue/cancel flows, renewal
invoices, transaction & subscription CRUD, batch jobs and reminders
(Phase 3 batch 3 + cron work), invoice PDF, gateway payment/IPN
handling (Phase 4). `related_invoices` currently returns [] (PHP
computes cross-invoice references via shared orders); promo
applications on the admin detail view mirror the redemption rows the
cart checkout writes.
