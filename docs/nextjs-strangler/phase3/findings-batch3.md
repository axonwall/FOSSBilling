# Phase 3 batch 3 findings — Order module + transaction/subscription CRUD

Third commit on `feat/nextjs-phase3-money`. The `order` module joins
`FB_TS_MODULES`, and the invoice module gains its transaction and
subscription surfaces.

## Scope

- **Order:** admin/client get + get_list, admin create (with the
  issue-invoice option), update, the status state machine
  (activate/suspend/unsuspend/cancel/uncancel/delete), status
  history (list/add/delete), get_statuses counts, get_status_pairs.
- **Transactions:** get/get_list/create/update/delete,
  get_statuses counts, statuses pairs, gateway statuses, types.
- **Subscriptions:** create/get/get_list/update/delete, with the
  currency-match rule against the client.

## Gates

- **Parity: capture11 corpus 27/27** (order reads and lifecycle,
  transaction and subscription CRUD, pinned error cases). Regression:
  parity7 20/20, parity6 15/15; fixtures **13/13 on both stacks**.
- tsc clean, production build PASS.

## Semantics pinned by the captures

- **Activation materializes the service:** activating a `custom`
  order inserts a `service_custom` row (carrying the order config)
  and links it as `service_id`. Other service types (hosting,
  domains, licenses) keep their provisioning in PHP.
- **Serializer split:** single-order reads use the entity array —
  price as a DECIMAL string, discount defaulted to 0, group_master
  as a boolean, `plugin` and `product_suspension_grace_days`
  attached. List rows are the pager's raw rows — price and
  group_master pass through in storage form, and
  `product_suspension_grace_days` is absent.
- **Order creation leaves `suspension_grace_days` NULL** (it is not
  copied from the product) — this corrects the batch-1 cart, which
  copied it; existing TS-created orders keep their stored 0.
- **Transaction create is an IPN-envelope record:** amount/currency
  stay unset (0/null in the array) until processing fills them;
  update applies the service whitelist and revalidates invoice and
  gateway references. The processed-status history freeze PHP
  applies is noted but not enforced.
- **Subscription arrays embed the full client record** (the admin
  extras shape without balance/api_token) and the **full gateway
  array** — adapter form fields and description for the Custom
  gateway are mirrored; other gateways get the generic shape, and an
  empty `accepted_currencies` column falls back to the default
  currency, as PHP does.
- Money values written by TS (order price/discount, invoice line
  price) are now bound as strings, matching PHP's decimal binding so
  both runtimes read each other's rows in the same form.

## Deferred

Order renewals and batch jobs (cron batch 4), CSV export, addons
management, per-service data handlers, transaction processing/IPN
(Phase 4 with the Stripe webhook), subscription gateway-cancel side
effects for non-Custom gateways.
