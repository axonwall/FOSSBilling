# Phase 5 R1 batch 3 findings — Core admin CRUD (Client / Product / Invoice / Order)

Branch: `feat/nextjs-phase5-r1`, stacked on R1b2 commit
`8b24a5c`. 85 endpoints ported, TS-served total rises from
261 to **346 of 579**. Cart (10 incl. staff-basket) and staff
(5) are NOT in this batch: the tap said "core admin CRUD
(client/product/invoice/order)" and those stay for a later batch.

## Client — 28 of 29 ported (capture19.py / captures19/, parity16 67/67)

Ported: admin get_list, get, create, update, delete,
login (impersonation), login_history_get_list,
balance_get_list, balance_add, balance_delete,
balance_get_total, group_get_pairs, group_create,
group_update, group_delete, group_get_list,
batch_expire_password_reminders, batch_delete,
export_csv is DEFERRED (below); guest create, login,
reset_password, update_password, resend_email_verification,
plus client-role balance_get_list / balance_get_total /
get (self) reads. Admin `export_csv` returns a CSV
download, not a JSON envelope: it needs a download route,
and the proxy still serves it from PHP.

Pinned semantics (abridged; the corpus is the record):

- RequiredParams messages are dispatcher-validated first,
  per endpoint; guest create returns boolean true (PHP
  discards login()'s return; the session is established
  server-side) and duplicate email is enumeration-safe
  (returns true, attempts login). Guest login failure is
  `Please check your login details.` code 401.
- Admin login (impersonation) sets `client_id` in the SAME
  session; `strip_admin_identity` removes the admin key.
- Admin create/update validation chains: duplicate email
  "This email address is already registered.", welcome-email
  rules, currency-change guards, phone_cc/phone validation
  (phone_cc is stored as a STRING — the node:sqlite
  float-formatting trap: a JS number bound into a VARCHAR
  column stores as "1.0", PHP/PDO stores "1"; bind strings).
  Birthday/country/lang/timezone validators as in PHP.
- Admin delete is service-blocked first (service_hosting /
  domain / downloadable / license / custom / apikey rows)
  then cascades orders, invoices, tickets, balances,
  password resets, extension_meta, group memberships.
  Groups live in `client_group` + `client_group_members`.
- Balance list quirks, mirrored not fixed: admin amount is
  a NUMBER, client amount a STRING; date_from/date_to
  bind strtotime ints against the text column.
- `batch_expire_password_reminders` horizon is 2 hours;
  reset-confirmation expiry is 900 seconds; guest
  reset_password is enumeration-safe; resend_email_verification
  writes a 50-char token into extension_meta.
- Documented gaps: no Antispam fetch, no rate limiter,
  encrypted client config reads as no-config defaults,
  fine-grained staff permissions approximated, PHP domain
  events not dispatched.

## Product — 25 ported (capture20.py / captures20/, parity17 77/77)

Ported: admin get_types, prepare, update, update_priority,
update_config, addon_get_pairs, addon_create, addon_get,
addon_update, addon_delete, delete, category_get_pairs,
category_get_list, category_update, category_update_priority,
category_get, category_create, category_delete,
promo_get_list, promo_create, promo_get, promo_duplicate,
promo_redemption_get_list, promo_update, promo_delete.

Pinned semantics (abridged):

- Finder messages: "Product not found", "Category not
  found", "Promo not found", "Addon not found".
- prepare: type `domain` with an existing domain product
  -> "You have already created domain product." code 413;
  unknown type -> "Product type <type> is not registered."
  code 413 (PHP's template has a space, not a colon).
- createProduct makes a default `free` product_payment,
  unique slug, status `disabled`, setup `after_payment`,
  priority = max + 10.
- update: icon >255 chars errors; suspension_grace_days
  must be a non-negative integer (int or int-string);
  pricing type in {free, once, recurrent} else "Pricing
  type is required"; recurrent periods REPLACE the set,
  period codes validated (D 1-90, W 1-52, M 1-24, Y 1-5);
  config array-merges; `product_category_id` `""` OR `"0"`
  clears (PHP `empty()`); upgrades/addons filter falsy
  incl. `"0"`.
- update_priority takes a `{priority: {id: value}}` map;
  unknown ids silently skipped. update_config intersects
  current keys with submitted keys; a submitted empty
  non-numeric value DELETES the key;
  `new_config_name`/`new_config_value` adds a pair.
- delete: ANY order with that product_id blocks
  ("Cannot remove product which has active orders.");
  only the product row is deleted (product_payment
  orphaned — mirrored).
- Categories: admin list is NOT paginated, lean
  `{id, title, priority}`, default order priority ASC +
  id ASC, explicit-sort ties break by id in the SAME
  direction; create priority defaults to max + 10; update
  touches only non-null params; update_priority validates
  EVERY value first ("Priority must be an integer.");
  category_get includes `price_starting_from`, `type`,
  and deep product arrays; delete blocked while products
  exist.
- Promos: unique code ("This promotion code already
  exists."); duplicate generates `-COPY`, `-COPY-2`, ...
  (base truncated to <=100 chars) with active=false,
  used=0; delete blocked by redemption history; promo_get
  (deep) adds `usage_stats`; empty id->title enrichment
  maps are null while the decoded list fields are `[]`.
- Seam fix found by parity17 (in db.ts): a read following
  a write in the same request changed the file stamp,
  `getDb()` closed the write connection, and a handler
  holding that handle then failed with "database is not
  open" (hit by update_priority's read-write-read loop).
  Fix: `getDb()` no longer closes `dbWrite`;
  `getDbWrite()` stamp-checks on every acquisition and
  reopens only on a fresh call after an external stamp
  change.

## Invoice leftovers — 21 ported (capture21.py / captures21/, parity18 114/114 + 1 divergence)

Ported, admin (17): get_statuses, get_failed_items,
item_requeue, gateway_get_pairs, gateway_get_available,
gateway_get_list, gateway_get, gateway_install,
gateway_copy, gateway_update, gateway_delete,
batch_delete, batch_delete_subscription,
batch_delete_transaction, batch_delete_tax, promo_add,
promo_remove. Client (3): get_tax_rate, renewal_invoice,
transaction_get_list. Guest (1): funds_enabled.
Deferred (PHP-served via the now binary-safe proxy):
admin `export_csv` (CSV download), guest `payment`
(adapter-generated HTML/payment data from PHP adapter
code), guest `pdf` (binary Response).

- Gateway semantics: known adapters are exactly the 4
  bundled files. install: name=gateway=code, enabled 0,
  allow_single/allow_recurrent default true,
  accepted_currencies/config NULL; unavailable or
  already-installed code -> "Payment gateway is not
  available for installation.". copy: name + `" (Copy)"`,
  enabled false, allow flags NOT copied (entity defaults
  true/true), accepted/test_mode/config/custom_logo
  copied; returns the new id. Delete guards in order
  invoices -> subscriptions -> transactions ("Cannot
  remove payment gateway with existing invoices", etc.).
  get_pairs returns ALL gateways (id->name, id ASC)
  regardless of enabled. get_list default order is id ASC
  and items carry the full ADMIN array.
- `gatewayArray` rewritten to PHP's `toApiArray` (admin
  extras are identity-gated, not deep-gated): adapter
  metadata snapshotted in an ADAPTER_META table for the 4
  adapters; secret fields (Stripe api_key, webhook_secret,
  test_api_key, test_webhook_secret, form `secret => true`,
  plus declared adapter secrets) are nulled in config
  output with `<field>_set` booleans appended;
  accepted_currencies falls back to ALL currency codes;
  empty config encodes as `[]`; callback =
  `{FOSSBILLING_URL}/ipn.php?gateway_id=<id>`;
  custom_logo_url/avif only for a 64-hex filename (file
  existence not checked — documented).
- gateway_update: title->name; config merges with secret
  preservation (blank/whitespace/`__KEEP__` keeps the
  stored value); enabling validates the merged config
  against the adapter constructor (Stripe test mode
  requires test_api_key then test_pub_key; live requires
  api_key then pub_key; PayPalEmail requires email) ->
  failures are code 819 with `The "<Adapter>" payment
  gateway is not fully configured. Please configure the
  <field>`. `logo_url` download and `logo_file` upload
  are NOT implemented (documented gap).
- get_statuses: `{total, paid, unpaid, refunded,
  canceled}` from a GROUP BY over invoice.status.
  get_failed_items returns the ENTITY item array (incl.
  attempts, rel_id as stored string), id DESC;
  item_requeue: missing id -> "Invoice item ID was not
  passed", missing item -> "Invoice item was not found",
  non-failed -> "Invoice item is not in a failed state";
  success sets status `pending_setup`, attempts 0.
- Batch deletes loop the single-delete logic per id and
  throw on first failure: batch_delete missing ids ->
  "IDs were not passed", missing invoice -> "Invoice not
  found", non-deletable -> the immutability message;
  batch_delete_subscription missing -> "Subscription not
  found"; batch_delete_tax missing -> "Tax rule not
  found"; batch_delete_transaction uses the shared
  transaction delete (below).
- `transaction_create` rewritten to PHP semantics:
  validation order gateway-exists ("Invalid payment
  gateway") -> invoice present ("Transaction invoice ID
  is missing") -> gateway present ("Payment gateway ID
  is missing") -> invoice exists ("Invoice was not
  found"); caller-supplied type/status/txn_status are
  IGNORED (new rows are always status `received`,
  type/txn_status NULL, amount/currency NULL); returns
  the new id (int); dedupe: same (txn_id, gateway)
  already `processed` -> that id, else same
  (gateway_id, ipn_hash) -> that id (ipn_hash = sha256
  of the recursively key-sorted IPN JSON `{source, get,
  post, http_raw_post_data, server}`; source defaults
  to `"admin"`).
- `transaction_delete` shares `deleteTransactionById`:
  `processed` -> "Processed transactions cannot be
  deleted because they record money that already moved.";
  unprocessed deletes first remove `client_balance` rows
  with type `transaction` and rel_id = the id (as string).
- Promo engine (promo_add/promo_remove) pinned from PHP
  source + capture: invoice lookup first ("Invoice was
  not found"), promo resolution (code takes precedence;
  unknown/inapplicable code -> "The promo code has
  expired or does not exist"; promo_id missing row ->
  "Promo not found"; neither -> "Promo code or promo ID
  was not passed"), then unpaid check ("Promotions can
  only be applied to unpaid invoices" / "...removed
  from..."), then editability (issued invoices are
  immutable unless the `invoice_immutability` setting is
  `relaxed`, with the retired
  `invoice_allow_edit_unpaid`/`invoice_allow_delete_approved`
  keys as fallback). Target order resolution: explicit
  order_id must belong to the invoice (items' rel_id or
  `unpaid_invoice_id`); otherwise exactly one order must
  be derivable ("This invoice has no orders to apply the
  promotion to" / "This invoice covers several orders;
  select which order to apply the promotion to").
  Percentage discount = round2(order line total x
  value/100) off the invoice line; absolute = catalog
  `getProductDiscount` x currency rate. Cap:
  min(discount, line total - order.discount). Effects:
  promo.used incremented atomically (maxuses guard ->
  "This promo code has reached its maximum number of
  uses."), order.discount += amount, order
  promo_id/promo_recurring/promo_used set (primary-promo
  rules on stacking), a discount line (`Discount: <order
  title>`, price -amount, unit `discount`, type `custom`,
  task `void`, taxed = client taxable) created or
  adjusted, and a `promo_redemption` row (phase
  `checkout`, status `reserved`, created_at = the ORDER's
  created_at). promo_add returns the float amount
  (capture: 1, then 1 again on re-add). promo_remove
  sums the order's RESERVED checkout redemptions for the
  promo ("This promotion is not applied to the selected
  order" when none), releases them (status `released`,
  reason `admin_removed`, promo.used decremented),
  recomputes the order's primary promo from remaining
  reserved/committed applications, adjusts/deletes the
  discount line (deleted when its price reaches >= 0),
  and returns the total removed (capture: 2).
  `promoApplicationsForInvoice` in db.ts now returns
  PHP's grouped shape (`{promo_id, code, title,
  order_id, discount_amount, status, removable}`
  grouped by promo:order, phase `checkout` only;
  percentage title `Promotional Code: <code> -
  <value>%`). Documented gap: absolute promos on
  DOMAIN products (TLD pricing) throw a TS-side error
  instead of computing a discount; percentage promos
  never touch that path.
- Client renewal_invoice: order must belong to the caller
  ("Order not found"); PHP reuses an existing unpaid
  `unpaid_invoice_id` invoice or generates one (renewal
  line priced from the order; due_at = the order's
  `expires_at`, NOT now + invoice_due_days), issues it
  with `use_credits = true`, and returns the invoice
  hash (48 hex). Documented gap: domain-order renewal
  repricing (TLD price x rate).
- Client get_tax_rate returns
  `resolveTaxForClient(client).rate` as a STRING ("0"
  for client 1, who is not taxable). Client
  transaction_get_list forces own client_id + status
  `processed`, supports invoice_hash/gateway_id/currency/
  type/txn_id/date_from/date_to/search filters and the
  transaction sort set (default id DESC); items use
  `transactionArray` minus `ipn`.
- Guest funds_enabled: setting `funds_enabled` unset ->
  TRUE (an initial TS bug returned false for unset;
  fixed during parity18).
- Fidelity fixes from the draft-get comparisons: invoice
  `nr` is NULL on drafts/notes in PHP, not `""` —
  `money.ts` prepareInvoice, the funds-invoice insert,
  and `noteRowFrom` now pass `nr: null` (db.ts
  `insertInvoice`/`insertInvoiceNote` types widened);
  `invoiceArray`'s `currency_rate` is a NUMBER (1), not
  a formatted string. `due_at` on prepared invoices is
  now + invoice_due_days on both stacks (parity compares
  it date-only/scrubbed).
- Prepare bracket fix: admin invoice `prepare` now parses
  form-bracket items (`items[0][title]`, ...) in addition
  to JSON arrays (capture21's first run exposed that PHP
  receives nested arrays from the admin UI's form
  encoding; TS silently dropped form-posted items), and
  `toItemInput` accepts digit-string `rel_id`. Related
  db.ts fix: `insertInvoiceItem` binds `rel_id` as a
  string (VARCHAR trap, as above).
- Proxy fix in `src/app/api/fb/[...path]/route.ts`:
  non-JSON PHP responses now pass through as
  `arrayBuffer()` instead of `res.text()` (which mangled
  non-UTF-8 bytes) — guest PDF and CSV exports are
  byte-safe through the proxy. PDF parity checks
  status/content-type/length (28808 for invoice 1) +
  `%PDF-1.7` header, not the hash (dompdf output bytes
  vary per run).
- DOCUMENTED DIVERGENCE (parity18's 1 known divergence):
  PHP client `invoice/transaction_get_list` with an
  `invoice_hash` filter dies with a DQL semantical error
  (`'i' is already defined`) because the forced
  `client_id` filter and the `invoice_hash` filter both
  introduce alias `i`. TS filters correctly; parity18
  treats this as a documented divergence, checked
  against a DB-derived expectation.

## Order leftovers — 11 ported (capture22.py / captures22/, parity19 54/54)

Ported, admin (7): get_invoice_options, service, addons,
can_cancel_at_period_end, update_config, renew,
batch_delete. Client (4): addons, service, upgradables,
delete. Deferred: admin `export_csv` (CSV download;
PHP-served via the now-binary-safe proxy).

- Message split pinned: admin `_getOrder` -> missing
  "Order ID was not passed", missing row "Order Not
  Found" (capital F); client `_getOrder` -> missing
  "Order id required", missing/not-owned "Order not
  found" (lowercase f). get_invoice_options is a static
  map (`issue-invoice`/`no-invoice` -> labels).
- service: `getOrderServiceData` — null service_id ->
  null; custom orders return the service_custom array
  (config JSON keys merged first, then
  id/client_id/plugin/updated_at/created_at override);
  non-custom service types return null in TS (documented
  gap — their PHP `toApiArray`s are unported). Client
  service additionally requires status active ("Order is
  not active").
- addons (both roles): orders with the same group_id +
  client_id, `group_master` falsy, excluding the order
  itself, id ASC; output uses the CLIENT-flavor order
  array (PHP calls `toApiArray` without an admin identity
  — no `plugin`/`product_suspension_grace_days` keys).
- can_cancel_at_period_end: active subscriptions linked
  via invoice items (`rel_type='invoice'`, item type
  `order`, item rel_id = order id as TEXT) must ALL have
  a non-empty sid and a gateway adapter implementing
  `cancelSubscriptionAtPeriodEnd` — among bundled
  adapters only Stripe does, so TS checks gateway code
  `Stripe`. Reference DB has NO subscription rows at all
  -> false everywhere (the join/logic is ported but only
  the empty case is parity-pinned).
- update_config: the `config` RequiredParams check runs
  BEFORE the order lookup — missing/empty/scalar config
  -> "Order config not passed" even when the id is also
  missing; with a config present, a missing order ->
  "Order Not Found". Non-form orders replace the config
  JSON wholesale. Documented gap: form-linked orders
  merge form answers via formbuilder (unported); NO
  order on the reference install has a form_id, so the
  replacement path is exact there.
- renew: pending_setup/failed_setup orders go through the
  activate path; other statuses extend expiry by the
  order's period FROM the current expires_at (default
  renewal logic; `order_renewal_logic` setting is unset
  on the reference install), set status active, clear
  suspended_at/unsuspended_at/canceled_at, and write a
  status row ("active", "Order renewed"). Service-module
  renew calls are no-ops for null-plugin custom orders.
- Admin/client delete rebuilt around a shared
  `deleteOrderFull` (PHP `deleteFromOrder` subset):
  pending_setup orders first lose their
  `pending_payment` invoice items (rel_id as string);
  reserved promo redemptions (any phase) are released
  with reason `order_deleted` (checkout-phase releases
  decrement promo.used); a `stock_reserved_qty` row in
  `client_order_meta` releases stock back to the product;
  status rows and all meta rows are deleted; the
  `service_custom` row is deleted for custom orders;
  then the order row. (The old TS cascade deleted only
  status rows + the order and leaked service_custom rows
  — capture22 caught a surviving service row.) Admin
  delete honors `delete_addons`/`force_delete`;
  batch_delete loops it per id (missing ids param ->
  "Order IDs were not passed"; missing order -> "Order
  Not Found") and only deletes addons when
  `delete_addons` is truthy (PHP
  `Tools::normalizeBoolean`). Client delete gates on
  status first: only pending_setup/failed_setup ("Only
  pending and failed setup orders can be deleted.").
- upgradables: the product's `upgrades` JSON ids ->
  id->title map excluding self; empty -> `[]` (not `{}`).
- Order create fixes (capture22's config-order get
  exposed them; PHP `createOrder` +
  `getProductOrderLineConfig` are the oracle): pricing
  now branches on payment type — explicit `price` param
  wins; `once` -> once_price; `recurrent` -> the enabled
  period's price (missing period -> "Product <id> payment
  type is recurrent, but period was not selected";
  unknown/disabled period -> "Selected billing period is
  not available for this product"); `free` -> 0 (the old
  code priced a once product at 0 whenever a period
  param was present). Currency resolves param -> client
  -> default, unknown code -> "Currency could not be
  determined for order". A supplied `group_id` joins that
  group as a non-master (parent must be a same-client
  order in the group, else "Parent order <group_id> was
  not found"); an addon product without group_id ->
  "Group ID parameter is missing for addon product
  order" code 832; otherwise a fresh group with
  group_master 1. Config: submitted config (JSON or
  bracket) merged, `period` injected, empty config
  stores `"[]"`. Discount inserts as NULL (PHP never
  sets it at create; single-get coalesces NULL -> 0).
  Not addressed (pre-existing simplifications, still
  gaps): promo_code/promo_id handling and
  `mark_invoice_paid` in admin create.
- orderArray typing fixes: single-get `discount` — NULL
  -> number 0, stored -> DECIMAL STRING (`"0"`); list-mode
  discount — NULL -> number 0, stored -> number. (The
  stored-vs-NULL distinction is real in the DB: order 1
  has discount stored as integer 0 after promo remove;
  orders 2/3 have NULL.) Single-get `promo_recurring` —
  Doctrine boolean (NULL stays null; stored 0 -> false);
  list mode passes the raw value. `total` = price x
  quantity - discount.
- activateOrderRow expiry fix (shared): activation now
  extends from the order's existing `expires_at` (or now
  when unset), matching PHP `createFromOrder` —
  previously TS always extended from now.
- Shared seam note (applies to all four modules): the
  Next route does NOT expand form bracket notation
  (`ids[0]=x`) into `rawParams` arrays; form posts only
  populate `params` with literal `ids[0]` keys. JSON
  bodies do populate `rawParams`. Handlers that accept
  nested/array params need a bracket scan of
  `ctx.params` (pattern now used in client.ts,
  product.ts, invoice.ts, order.ts).

## Close-out regressions (2026-10-25) — what the gate caught

All foreground-verified, after the module parities above:

- Fixtures: 13/13 on BOTH stacks (results in
  `~/scratch/fossbilling/phase0/results-{php,next}.json`;
  fixture definitions are `fixtures-tax.json` /
  `fixtures-money.json` in the same dir). The first Next run
  returned 3/13 (actually 2/13 by file) and was an
  ENVIRONMENT failure, not a code failure:
  `run-fixtures.py::start_next` does not kill an existing
  :3001 listener, so its new `next start` failed with
  EADDRINUSE while the readiness probe connected to the
  OLD parity19 server (reference DB, not the disposable
  DB) and reported success. Taxes seeded only in the
  disposable DB were invisible (taxrate 0) and cloned
  fixture clients did not exist in the reference DB
  ("Client not found"). Fix for the gate: kill :3001
  first, then rerun. Second failure mode of the same
  runner: it SIGTERMs the `npx` wrapper, but the
  `next-server` child survives reparented (pid 1) and
  still holds :3001 — kill it explicitly after every
  fixture run. The wrong-DB run also polluted the
  reference DB; cleaned (backup at
  `~/scratch/fossbilling/reference-before-cleanup-2026-10-25.sqlite`):
  invoices 368-381, invoice_items 348-363, invoice_events
  490-504, transaction 191 (`fixture-txn-1`, which is
  what made the later mark_as_paid fixture fail: PHP
  mark_as_paid throws the same "Transaction ID is already
  associated with another invoice." on a polluted DB),
  carts 203-214 + their cart_products. Reference DB
  verified clean after: client-1 balance 0, order 1 at
  baseline, order 3 `unpaid_invoice_id` cleared, product
  priorities 2=11 / 3=21.
- REAL BUG 1 (cart, found by the fixture gate): the new
  TS guest client login regenerated the session id and
  deleted the old session row WITHOUT transferring the
  guest cart, so a cart built as guest vanished at login
  and checkout said "Cannot checkout an empty cart".
  PHP `Guest::login` calls
  `Cart::transferFromOtherSession($oldSession)` after
  regenerating. Fix in `loginClientSession` (client.ts):
  re-key the cart row's session_id to the new id before
  deleting the old session. Before this batch, guest
  client login was PHP-served via the proxy, which is
  why the fixtures passed in Phases 3-4.
- REAL BUG 2 (stats, found by regression): admin stats
  `get_summary` / `get_summary_income` errored with
  "Unknown named parameter 'yesterday_start'".
  node:sqlite rejects named parameters the statement does
  not use, and the handlers passed the full
  dayBoundaries() bag to two-bound queries. Fix in
  stats.ts: `namedParams()` filters the bag to exactly
  the names the SQL references. (Why parity15 passed at
  R1b2 with the same code is unexplained — the bug is
  reproducible in isolation against node:sqlite, so the
  R1b2 20/20 for those two endpoints is not trusted
  retrospectively; the live PHP comparison below is the
  evidence now.)
- Stats TZ lesson: TS stats uses process-local midnights;
  the reference PHP install configures timezone UTC.
  A Next server started with TZ=America/Chicago shifts
  dated Flot series by +5h vs the oracle. The regression
  server must run with TZ=UTC (as the reference
  install does). Config-driven TZ for TS stats is an
  open R5/runtime gap, not fixed here.
- Parity15 oracle refresh: captures18 stats oracles
  (16:43 CDT) went stale during parity17/18/19 runs
  (paid/refunded invoices added after capture: income
  4541 -> 4976, refunds 570 -> 600, sales US 75 -> 82).
  Verified TS == live PHP on ALL 20 stats cases before
  refreshing, then refreshed the 11 changed
  captures18 stats files from live PHP (parity7
  precedent). Parity15: 20/20 after refresh.
- Parity10 regression (script, not product): the CRUD
  rewrite made `transaction_create` PHP-faithful,
  including IPN-hash dedupe — and a BARE admin create
  (no get/post payload) has a canonical IPN, so it
  dedupes to the FIRST such transaction ever created.
  Verified live against PHP: two distinct txn_ids both
  returned transaction id 95. Parity10's
  approve_received_settles case assumed a fresh row per
  txn_id (true only under the old TS simplification).
  Fix in phase4/parity10.py: the create now carries a
  unique `post.probe` payload so it mints a fresh row on
  both stacks. Parity10: 14/14, twice in a row.
- Parity18 staleness + script cleanup: the 4 remaining
  diffs (get_statuses totals 299 vs oracle 274;
  transaction list totals 121/111 vs 105/100) are
  accumulated parity artifacts, verified TS == live PHP
  exactly for all 4 cases. The renewal case initially
  failed because client-1 balance had drifted to +35
  from orphaned balance rows (parity12 deposit leftovers
  + parity18 renewal payments whose invoices were
  deleted without their balance rows): with balance >=
  total, renewal issues with use_credits and pays
  immediately instead of staying unpaid. Cleaned the 7
  orphaned rows (35-41) back to the documented rows 1-4
  (net 0), and fixed parity18.py's renewal cleanup to
  delete the renewal invoice's balance row too.
  Parity18 after cleanup: 110/114 vs stale oracles +
  the 1 documented divergence, renewal passing, balance
  still 0 afterward.
- Regression totals: fixtures 13/13 both stacks;
  parity16 67/67, parity15 20/20, parity14 44/44,
  parity13 47/47, parity12 12/12, parity11 16/16,
  parity10 14/14, parity9 16/16, parity7 19/19 (the
  20th case, guest_invoice_get, is conditional on the
  script's admin session surviving the client login and
  did not execute this run; guest invoice get is covered
  by parity18), parity17 77/77, parity18 110/114 vs
  stale oracles + live-verified + 1 divergence,
  parity19 54/54.
- Environment note: a VM replacement mid-regression
  killed both servers (PHP :8080, Next :3001); both were
  restarted (PHP from runtime/src, Next with TZ=UTC +
  the full module list + PayPal test hooks) and the
  remaining parities rerun — no results above depend on
  the pre-restart server.

## Gates

- parity16.py: 67/67 MATCH
- parity17.py: 77/77 MATCH
- parity18.py: 114/114 MATCH at module completion
  (110/114 vs stale oracles at close-out, live-verified;
  1 documented divergence: client_transaction_get_list_hash)
- parity19.py: 54/54 MATCH
- fixtures: 13/13 PHP, 13/13 Next (after the stray-server
  fix above)
- regressions: see close-out list above
- tsc --noEmit clean; `npm run build` exit 0 before
  every parity/fixture run (stale-build trap: `next
  start` serves the last build)
