# FOSSBilling — Next.js strangler frontend

Scope B (strangler) conversion of FOSSBilling to Next.js, per
`fossbilling-nextjs-conversion-plan-2026-10-23.md` (decisions D1–D8 taken with
recommended defaults unless Josh directs otherwise).

- **Phase 0 (done, 2026-10-23):** contract capture against a live PHP 0.8.9
  reference instance. Artifacts live in `docs/nextjs-strangler/phase0/` of
  this repo: the full API catalog (579 endpoints: 449 admin / 54 client /
  76 guest), the Doctrine schema map (66 entities / 66 tables, 725 columns,
  43 relations, 35 FK constraints on fresh installs), auth &
  password-portability findings (bcrypt `$2y$` cost 12 for both clients and
  staff — existing passwords carry over), the cron inventory, and a live
  capture corpus (guest → signup → login → order → invoice → paid).
- **Phase 1 (this app):** Next.js 15 / React 19 / TypeScript frontend that
  owns no billing state. All data flows through the typed dispatcher client
  in `src/lib/fossbilling.ts` (server-side) or the same-origin proxy in
  `src/app/api/fb/[...path]/route.ts` (browser), both targeting the PHP API
  at `FOSSBILLING_URL` (default `http://127.0.0.1:8080`).
- **Phase 2 (started):** backend modules are being ported to TypeScript
  behind the same dispatcher contract, sharing the PHP database. The seam
  lives in `src/server/` (dispatcher, DB layer, PHP-session auth); the
  proxy serves a call from TS only when its module is enabled via
  `FB_TS_MODULES` (comma list) and falls back to PHP otherwise. Ported so
  far: `system` (guest reads), `currency` (guest + admin reads and admin
  mutations), `profile` (client + admin get), `client` (admin
  get/get_list/get_pairs), `staff` (admin reads, mutations, and group
  management), `activity` (admin log list + log writes), `news` and
  `custompages` (guest/admin reads + admin mutations), and the System
  data/settings methods (countries, timezones, params, settings) —
  verified at 16/16 + 32/32 + 21/21 + 27/27 parity against PHP (96
  checks). Runtime-bound System endpoints (env, updater, cache) stay
  on PHP by design; see `docs/nextjs-strangler/phase2/`.
  (`FB_PARITY=1` deep-compares TS vs PHP responses; see
  `docs/nextjs-strangler/phase2/`). TS modules need
  `FB_DATABASE_PATH` pointing at the install's SQLite file in the
  reference setup.

## Run

```bash
# 1. Run FOSSBilling PHP (existing install) on :8080
# 2. Then:
npm install
FOSSBILLING_URL=http://127.0.0.1:8080 npm run dev   # http://localhost:3001
```

## Pages

- `/` — client area home; renders `guest/system/company` live (smoke test
  for the seam).
- `/login` — client sign-in via the proxy to `guest/client/login`
  (CSRF: `fossbilling_csrf` cookie → `CSRFToken` field).
- `/signup` — client signup via `guest/client/create` (auto-login on
  success).
- `/dashboard` — profile + order/invoice/ticket counts.
- `/orders`, `/orders/[id]` — order list and detail (`client/order/*`).
- `/invoices` — client invoice list (`client/invoice/get_list`, session
  cookie forwarded server-side).
- `/invoices/[hash]` — invoice detail (client-role access is by hash).
- `/invoices/[hash]/pdf` — streams the PHP web route
  `GET /invoice/pdf/<hash>` through this origin.
- `/support`, `/support/new`, `/support/[id]` — ticket list, create, and
  detail with reply/close (`client/support/*`).
- `/admin` — staff dashboard (`admin/stats/get_summary` +
  `get_orders_statuses`); `/admin/login` staff sign-in
  (`guest/staff/login`); `/admin/clients[/id]`, `/admin/orders[/id]`,
  `/admin/invoices`, `/admin/tickets[/id]` (with staff reply) — the admin
  theme's top surfaces, ported in Phase 1 batch 2. Deeper admin modules
  remain on the PHP theme until later phases.
- `/api/fb/__prime` — cookie priming: the `fossbilling_csrf` cookie is set
  only by PHP **web pages**, never by API responses (verified live,
  Phase 1), so this proxy route relays the PHP login page's cookies and
  `fbPost` calls it before the browser's first POST. See
  `docs/nextjs-strangler/phase1/findings.md`.

## Auth facts (verified live, Phase 0)

- Token login: HTTP Basic with username literally `admin` or `client` and
  the API token as the password (NOT `email:token`).
- Sessions are server-side rows in the `session` table; user passwords are
  bcrypt `$2y$` cost 12 and verify in Node with the `$2y$`→`$2b$` prefix swap
  (or any `$2y$`-capable verifier).
