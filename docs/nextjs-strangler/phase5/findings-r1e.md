# Phase 5 R1 D7 findings — service provisioning (78 endpoints, 378 → 456/579)

Scope: servicedomain (36), servicehosting (30), servicedownloadable (4 of 9),
servicelicense (7), servicecustom (1 of 3). TS-served total after this batch:
**456/579**. Deferred to the PHP proxy (binary/plugin runtime): downloadable
send_file ×3, upload ×2, servicecustom client `call` + admin `__call`.

Gates: **parity21 196/203** (7 diffs, all one upstream defect — see below),
fixtures **13/13 both stacks**, regressions parity7 19/19, parity9 16/16,
parity10 14/14, parity11 16/16, parity12 12/12, parity13 47/47, parity14 44/44,
parity15 20/20, parity16 67/67, parity17 77/77, parity18 114/114 + 1 known
divergence (the transaction_get_list DQL defect), parity19 54/54,
parity20 146/146.

## Verified upstream defect #3: `tld_delete` SQL-errors on SQLite

PHP `Servicedomain/Api/Admin.php::tld_delete` counts domains with:

```sql
SELECT id FROM service_domain
WHERE LOWER(TRIM(TRAILING '.' FROM TRIM(tld))) IN (?, ?)
```

`TRIM(TRAILING '.' FROM …)` is MySQL syntax. SQLite rejects it:

> `An exception occurred while executing a query: SQLSTATE[HY000]:
> General error: 1 near "'.'": syntax error` (code 1)

So on SQLite installs **every** `tld_delete` fails — used, unused, and
not-found alike — before the 707 check or the delete. The TS port uses the
SQLite-native equivalent `LOWER(RTRIM(TRIM(tld), '.'))` and implements the
intended behavior (707 when used, `true` on delete, `TLD not found`).
This is the third verified 0.8.9 defect (after the SQLite session lock and
the transaction_get_list DQL error), and it is SQLite-only: on MySQL the
PHP query runs and behaves like the TS port.

parity21's 7 diffs are this defect (3 direct) plus 4 downstream consequences:
because PHP never deletes `.cap24`, every later TLD-listing case
(`sd_guest_tlds*`, `sh_guest_free_tlds_fallback`) shows it on PHP and not
on TS. No TS bug remains behind any of the 7.

## Pinned D7 semantics (beyond the plan)

- **Cut adapters are errors, not ports.** Per D5-2, only Hestia + Custom
  managers and the Custom registrar are TS-served. Any other manager code
  returns `Server manager ${m} is not a valid server manager`; any other
  registrar code returns `Domain registrar ${code} was not found` — the
  post-cut shape, documented where it diverges from live PHP until R6.
  `manager_get_pairs` is the declared divergence: TS returns
  `{Custom, Hestia}` only (PHP returns all 6).
- **Hestia network errors compare by shape, not message.** PHP reports
  OpenSSL TLS strings; Node reports transport errors. parity21 compares
  these cases (change_plan, change_password, test_connection) by error
  presence + code 9999 only. The TS Hestia timeout is **10s**, not 30s: a
  panel that cannot be reached must fail before a caller's own 30s
  deadline, or the abort races the client timeout (this race killed one
  parity run mid-suite; parity21 now also restores the DB in a `finally`).
- **Server update persists before validating.** Hestia with an empty
  hostname stores the update, then throws 719
  (`The HestiaCP server hostname is missing…`). parity21 pins both halves
  (error + a follow-up `server_get` showing the stored empty hostname).
- **Doctrine booleans preserve NULL.** A server row with no `secure`
  value reports `secure: null`, not `false` (same for `active`).
- **Empty pairs encode as `[]`, not `{}`.** PHP json-encodes an empty
  pairs array as `[]`; fixed for server/hp/registrar/plugin pairs
  (client `hp_get_pairs` was the case that caught it). Other modules'
  pairs endpoints carry the same latent bug when empty — follow-up sweep,
  not changed here.
- **Form brackets are not expanded by the route.** `ips[0]=x` arrives as
  a literal key, but PHP sees an array: license list fields with bracket
  keys now throw the exact `explode()` TypeError (9998), and `hp_update`
  scans `config[…]` brackets. `update_contacts` and `registrar_update`
  already scanned their brackets; contact updates also accept a JSON
  `contact` object (new parity21 cases).
- **License `check` details.** `format=2` exposes LogicException codes
  1000–1010 in the result; non-format2 hides them behind the generic
  envelope. `pinged_at` stamps before other checks; `isValid*` appends
  the presented value when the list is empty or validation is off.
- **Downloadable cascade.** Product `file_delete` with `update_orders=1`
  rewrites every order config for the product even when nothing matched,
  and removes the stored file only when no service file row or product
  config still references it (64-hex names only).
- **Proxy fix (route.ts).** The PHP proxy forwarded only `content-type`;
  it now also forwards `content-disposition`, so proxied `send_file`
  responses keep their attachment filename (3 parity21 diffs fixed).
- **In-use counts include pending_setup orders.** Server/plan delete
  counts services linked to orders of any status as "active"; orphaned
  means no linked order at all. 704 messages match PHP exactly.

## Regression notes

- parity12 needs `FB_CALLBACK_SALT` (from the reference install's config)
  on the Next server, or all four PayPal IPN cases fail signature
  validation. The regression server now sets it.
- parity15/parity18 compare against stored oracles (`captures18/`,
  `captures21/`). Passing regression runs add real money rows (parity10
  captures, parity12 IPN settlements), so the oracles drift; refreshed
  both from live PHP this run (read-only captures) and re-ran green.
  The refreshed oracles are committed alongside this batch.
- Reference DB final state: templates 24, groups 15, history 0,
  massmailer 0, notifications 0, client-1 balance 4 rows net 0, order 3
  `unpaid_invoice_id` NULL, no Cap24 residue, product 2 config NULL,
  order-1 service config `{"period":"1M"}`. Email queue is 67 (was 68):
  ordinary churn — regression scripts snapshot/restore the queue by id
  set and sendmail consumes pending test mail; the 6 removed rows were
  comms-era invoice mails, the 5 added rows are today's parity16/18/20
  mails. Not corruption; left as-is.

## Remaining after D7

R1 platform leftovers (formbuilder 13, security 8, theme 7 → R4, redirect 5,
antispam 5, extension remainder 16 → R4, widgets 2, seo 2, currency
`update_rates`, cart 10, staff 5, deferred CSV/PDF downloads, system
update/cache/template family deleted not ported). Registrar expansion
(all in-tree registrars + new eNom adapter) still awaits Josh's scope
answer — it would supersede D5-2's one-registrar cap.
