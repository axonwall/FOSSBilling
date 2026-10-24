# Phase 5 — Retirement plan (FOSSBilling → Next.js, Scope B)

Status: **plan, not execution.** Phase 4 is complete; this is the
map for removing PHP. Nothing here is built yet, and no PHP code
is deleted by this document.

## 1. Where the strangler stands (measured 2026-10-24)

All counts are mechanical diffs of the TS handler registry
against the PHP Api classes at upstream 0.8.9, not estimates.

- **API: 228 of 579 endpoints served by TS; 351 still served
  by PHP through the proxy.** "Unported" means PHP-served
  today, not missing: the proxy already answers every one of
  these. Retirement is closing the proxy, not building from
  zero.
- **UI: 20 Next routes vs 276 Twig templates.** The Next app
  covers the client area end to end (home, login, signup,
  dashboard, orders, invoices, support) and the admin top
  surfaces (dashboard, clients, orders, invoices, tickets).
  Everything else an admin or client can click is still a
  Twig page served by PHP.
- **DB: the TS server reads SQLite via `node:sqlite`**
  (`FB_DATABASE_PATH`). The plan's D3 target (PostgreSQL for
  new installs + a MySQL importer) is not started.
- **Money paths are fully TS** (cart, invoice, order, cron
  money jobs, Stripe/Custom/PayPalEmail processing, invoice
  PDF, email queueing). **Email delivery is queued, not
  delivered**: `batch_sendmail` flips rows to `sending` and
  no transport exists in the sandbox.
- **Cron: the TS runner covers a subset** (invoice activation
  / reminders, order suspension / cancellation sweeps). Still
  PHP-run: pay-with-credits batch, invoice generation,
  due-event invocation, suspension warnings, support
  auto-close, client password-reminder expiry, cart expiry,
  email sendmail.

## 2. The unported 351, grouped

| Block | Count | Notes |
| --- | --- | --- |
| Service provisioning: servicedomain, servicehosting, servicedownloadable, servicelicense, servicecustom | 85 | Drive 6 server managers + 7 registrars. D7 already caps this: Hestia + Custom first, one registrar max. |
| Core admin CRUD: client (29), product (26), invoice (24), order (12), cart (10), profile (12), staff (5) | 118 | Mostly straightforward ports: client create/update/delete/groups, product addons/categories/promos, invoice gateway admin + batch deletes, order renew/service/config, staff-basket checkout, profile password/API-key/session management. |
| Comms/admin: email (16), massmailer (11), notification (5) | 32 | Email template groups/reset/validate, client email history reads, massmailer send/preview/receivers. |
| Reporting + platform: stats (14), formbuilder (13), security (8), theme (7), redirect (5), antispam (5), extension (16), system (28) | 96 | Stats is pure SQL aggregation. System's update family (update_core, finalize_update, …) is PHP-runtime-bound and should be *deleted*, not ported — see R1. |
| Small mop-ups: support (4), serviceapikey (4), cron (2), currency (2), widgets (2), seo (2), page/index/cookieconsent/activity (1 each) | 21 | Support's four are the KB/config toggles left deliberately unported in batch 4 (encrypted config). |

## 3. Workstreams

### R1 — API mop-up (351 → 0), in this order
1. Small mop-ups + stats + profile (auth/session/API keys).
   Profile first: login/logout/password flows are on the
   critical path for everything else.
2. Core admin CRUD (client/product/invoice/order/cart/staff).
   Each gets the batch treatment: capture corpus, TS
   implementation, parity script, regression gate.
3. Comms (email template groups, massmailer, notification).
4. Service provisioning per D7 (Hestia + Custom; one
   registrar). The remaining managers/registrars are
   *deleted* with their modules, not ported — that is the
   D7 decision, and it needs re-confirmation (D5-2 below)
   because it changes what the product can sell.
5. Delete, don't port: system update/cache/template
   machinery, theme selection/presets (replaced by R4),
   Extension activation/install/uninstall (replaced by R4),
   `currency update_rates` (needs a rate source decision).

### R2 — UI: the fork in the road
Two honest options, very different sizes:
- **(a) Next-native admin.** Keep the 20 routes, grow them
  into a complete admin (clients/orders/invoices/tickets
  detail + the CRUD surfaces from R1). No Twig parity; the
  admin UI becomes a new product surface. Estimated as a
  second Phase 1, not a mop-up.
- **(b) Twig parity.** Port all 276 templates' behavior to
  Next pages. This is the largest single block in Phase 5
  and the one most likely to double the schedule.
- The client area is already Next-native; only the admin
  theme is at stake. **Recommendation: (a)**, consistent
  with D2-internal (the product serves Axonwall's hosting
  customers, not the FOSSBilling theme ecosystem).

### R3 — Database migration (D3)
1. Swap `db.ts` from `node:sqlite` to a Postgres driver
   behind the same helper surface (all TS SQL is already
   centralized in `db.ts` + module-local queries; the
   migration is mechanical but touches every module's
   queries for placeholder/typing differences). Note this
   is a TS-side gap, not a PHP one: PHP fresh installs
   already support MySQL, PostgreSQL, and SQLite alike
   (schema from Doctrine metadata), and PHP upgrades stay
   in schema sync on every driver — only its historical
   *data* migrations are MySQL-only, which is the same
   class of problem the importer below must solve.
2. One-way MySQL importer: read a live 0.8.9 MySQL install
   (66 tables, 725 columns), map to the Postgres schema,
   verify row counts + money totals per table, and refuse
   to proceed on mismatch.
3. SQLite stays as the dev/test driver (the fixture gate
   depends on it); production runs Postgres.

### R4 — Extension + theme replacement (D5)
- In-tree TS module registry: modules register exactly as
  today's `register(role, module, method, handler)` — the
  registry already exists; what changes is that it becomes
  the *only* extension mechanism. No manifest loading, no
  PHP module code, no theme uploads.
- Theme system: deleted. One Next theme (the admin + client
  UI from R2). Custom CSS variables at most, if anyone
  asks.
- Encrypted config (extension_meta, email template vars):
  re-key or re-encrypt on import; the TS side must own a
  real secret store before cutover, because today it
  returns `{ext}` for any stored config it cannot decrypt.

### R5 — Runtime replacements
- Cron runner completion: the 8 missing jobs from §1,
  running in-process on a schedule (not a PHP cron.php
  call). Order matters: PHP's `runCrons` order is the spec.
- Email transport: real SMTP delivery for the queue
  (today: queued → `sending` → nowhere). Needs credentials
  management + bounce handling decisions.
- Rate limiting: PHP's file-based login limiter
  (`data/cache/rate_limit_*`) becomes a TS limiter with
  the same 10/hour/IP policy for `api_login`.
- Antispam/recaptcha: guest signup currently depends on a
  remote disposable-domain list (already flaky in the
  sandbox). Decide: vendor the list, drop the check, or
  keep the fetch with a fallback.
- Installer: TS installer replacing PHP's install flow
  (schema creation + seeder + admin account + config),
  targeting Postgres (R3) with SQLite for dev.

### R6 — Cutover
1. Per-module proxy removal: as each R1 batch lands and
   passes parity, its module leaves `FB_TS_MODULES`'s
   fallback — i.e. the proxy stops offering PHP for it.
   (Today the proxy falls back silently; cutover makes
   fallback an error so regressions surface immediately.)
2. Shadow run: TS serves 100% of API traffic with PHP
   still running read-only for comparison on money paths
   (the `FB_PARITY=1` double-execute harness, minus the
   double-execution caveat — compare reads, not writes).
3. PHP deletion: remove `src/` PHP, the proxy route, and
   the PHP runtime from the image. The repo becomes its
   own product; the upstream freeze (D8) ends.
4. Rollback: keep the last PHP-serving image tagged until
   one full billing cycle (invoices issued, paid, reminded,
   cron-swept) passes on TS alone. Rollback is
   re-pointing the proxy at that image, not re-building.

## 4. Decisions for Josh

- **D5-1 — Admin UI: (a) Next-native or (b) Twig parity?**
  **Recommend (a).** (b) is the schedule risk in the whole
  arc; (a) is consistent with D2-internal.
- **D5-2 — Provisioning scope: re-confirm D7?** Hestia +
  Custom + one registrar, deleting WHM/Plesk/DirectAdmin/
  CWP managers and the other registrars. **Recommend
  re-confirm** — this is a product-capability cut, not
  just code deletion.
- **D5-3 — Database: Postgres for new installs + MySQL
  importer (D3), SQLite dev-only?** **Recommend yes.**
- **D5-4 — Email transport: SMTP with stored credentials,
  or a transactional-email API?** Needs a provider call.
- **D5-5 — Extension registry: in-tree only, no uploads?**
  **Recommend yes** (follows D5).
- **D5-6 — Cutover posture: per-module proxy removal +
  one-cycle shadow (R6), or a single big flip?**
  **Recommend per-module removal + shadow** — the
  strangler's whole point is avoiding a big flip.

## 5. Risks carried into Phase 5

- Encrypted at-rest config (extension_meta, template vars)
  cannot be read by TS today; import must re-key it or
  those settings silently reset to defaults.
- Live gateway verification (Stripe API settlement,
  PayPal re-post) has never run outside the sandbox; the
  first live transaction on TS is a cutover risk, not a
  parity result.
- Session migration: PHP Symfony sessions in the
  `session` table are readable by TS today, but a
  Postgres move must preserve them or every user and
  staff member is logged out at cutover (acceptable if
  announced, bad if surprising).
- The upstream freeze (D8) means every upstream security
  fix since 0.8.9 needs manual backporting until R6
  completes; the longer Phase 5 runs, the larger that
  debt.
