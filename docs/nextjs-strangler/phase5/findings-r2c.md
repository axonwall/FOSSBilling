# Phase 5 R2c findings — products + service detail pages

Scope: `r2-scope.md` R2c (products + service detail views), on
`feat/nextjs-phase5-r1` on top of `ea0725a` (R2b). No PHP sources
modified. No commit, no push. Builds on R2a's sidebar + permission
model and R2b's order page.

## 1. What was built

### Product pages (view-only)

- `/admin/products` — list from `admin/product/get_list` (title link,
  type, status, starting price).
- `/admin/products/[id]` — detail from `admin/product/get`: slug,
  type, unit, status, hidden, setup, category, starting price, stock,
  suspension grace days, form, dates, description, pricing table
  (recurrent periods or once price/setup), configuration pairs,
  addons. A view-only note is rendered; product create/edit/delete UI
  was NOT built (later-batch option, named here, not a gap in R2c).
- New `adminApi` wrappers in `lib/fossbilling.ts`: `productList`,
  `productGet`, `orderService`.

### Service detail pages (view-only)

- `/admin/services/[id]` — where `id` is the ORDER id, not a
  service-row id. This is deliberate and matches PHP's own model:
  FOSSBilling renders service detail only via `admin/order/service`
  for an order (the admin order template's Service tab calls exactly
  that); service rows are meaningless without their order, and no
  service module has a get-by-service-id endpoint in PHP or TS.
  A `[type]/[serviceId]` scheme would have required inventing a
  lookup PHP does not have.
- The page reads `admin/order/get` (context: title, status, client,
  service type) + `admin/order/service` (service data) and renders
  type-specific sections: hosting (account, server, plan,
  domain_order_id), domain (domain, nameservers, period, privacy,
  locked, dates, registrar, transfer code, registrant contact),
  license (key, validate flags, allowed ip/host/path/version lists,
  pinged, plugin), downloadable (files table with downloads),
  custom (config pairs + plugin/dates).
- Order with no service renders PHP's own message ("This order does
  not have a provisioned service yet."); unknown order renders the
  API error box ("Order Not Found").
- The order detail page now links "View \<type\> service" to
  `/admin/services/[orderId]` when `service_id` is non-null (and
  renders no link otherwise — parity27 asserts both).
- Sidebar: `NEXT_ROUTES` gained `product → /admin/products`, so the
  Products section appears (the products group's "Products &
  Services" subpage). Service detail has NO sidebar section: it is
  order-addressed and has no PHP nav entry, so there is nothing for
  the nav-driven sidebar to map. Services are reached from order
  pages and direct URLs. This is the one place R2c deviates from the
  scope's "services under their sensible section" phrasing, with
  reason: inventing a sidebar Services section would mean inventing
  a services index page, which is not in R2c scope.

### Permissions / chrome

Per the R2b pattern: pages follow the dashboard pattern (admin
session check, error box with "Sign in as staff if you are not
logged in" — same wording as the invoice detail page). NO per-page
permission gating (R2a seam guards enforce at the API). Sidebar
active highlighting (R2a known gap) NOT added.

## 2. The API prerequisite R2c actually needed: order/service toApiArray

The brief assumed service get endpoints exist. They do not — in PHP
or TS. What exists is `admin/order/service`, and the TS port
returned `null` for every non-custom type ("documented gap" in
`order.ts`). Rendering real service data therefore required
completing the port in `order.ts` (`orderServiceData` now takes an
`isAdmin` flag; admin handler passes true, client false):

- hosting: row + server array + plan array + `domain_order_id`
  (order config `domain.action` register/transfer → related order
  with same `group_id` and service_type 'domain', lowest id, else
  null). Missing server/hp rows throw "Server not found" /
  "Hosting plan not found" exactly like PHP's `getExisting*`.
- domain: flat fields + contact block + admin-only `transfer_code`
  and `registrar` name (via `tld_registrar_id`, null when missing).
- license: flat fields, JSON-decoded ip/host/path/version lists,
  admin-only `plugin`.
- downloadable: files ordered by `sort_order, id`; admin-only
  `path` (uploads dir derived from `FB_DATABASE_PATH`'s directory
  + `/uploads`, which equals PHP's `PATH_UPLOADS` on the reference
  install — verified byte-for-byte in the corpus) and `downloads`.
- custom: unchanged (already ported).

Ported PHP semantics worth recording: server manager URLs (Custom →
  the upstream literal `google.com?q=cpanel/whm` placeholders;
  Hestia → `https://<hostname>:<normalizePort(port, 8083)>/` for
  both URLs, `[false, false]` when the hostname is empty);
  `normalizePort` (int/string in 1..65535, else default);
  secret fields (Custom → `[password, accesshash]`; Hestia → plus
  `username` from its secret form fields; values always null with
  `*_set` booleans from the stored columns); `assigned_ips` and
  server `config` JSON-decoded with `[]` fallback; hp `config`
  JSON-decoded with `null` fallback for empty input.

Documented divergences in the port (unreachable on the reference
install, which has zero servers):

- Managers other than Custom/Hestia return `[false, false]` for both
  URLs instead of calling the manager adapter, and get only the base
  `[password, accesshash]` secret list instead of that manager's
  extras. A server row with another manager would diverge from PHP
  on exactly those fields.

## 3. Bugs found by parity27, fixed

1. **PHP empty-object config encodes as `[]`, not `{}`.**
   `json_decode('{}', true)` is an empty PHP array, which encodes
   as `[]`. The first TS port returned `{}` for server/hp configs.
   Fixed in the shared `jsonObjectOr` helper (empty objects collapse
   to `[]`); caught before parity27 by inspecting the PHP corpus,
   not by a parity failure.
2. **Domain `period` is Doctrine `?int`.** PHP returned `1` for a
   stored `"1Y"` (integer cast on read); TS returned `"1Y"`.
   Fixed with a PHP-`(int)`-cast helper (leading digits, else 0;
   null stays null).
3. **Script bugs (not code):** `service_downloadable_file.file_key`
   is NOT NULL — the first capture failed on it (fixed: file_key
   values `'guide'`/`'terms'`); parity27's timestamp constant
   shadowed the TS base URL variable (renamed to `FIXED_TS`).

## 4. Crafting (parity27 / capture30, restored in finally)

The reference DB has zero service rows, so parity27 crafts one order
per type (all client 1, status active, price 10 USD, fixed timestamps
`2026-10-27 12:00:00`):

- hosting: server row (Custom manager, password + accesshash set,
  port 2083, config `'{}'`) + plan row + hosting row
  (`r2csite.com`, user `r2cuser`) + order.
- domain: domain row (`r2cexample.com`, registrar 1 Custom,
  transfer code `R2C-EPP-1`, full contact) + order.
- license: license row (key `R2C-LIC-001`, JSON lists, plugin
  `r2c-plugin`) + order.
- downloadable: downloadable row + 2 file rows (guide/terms,
  downloads 3/0, 64-hex stored names) + order.
- custom: custom row (config `{"plan":"r2c-pro"}`, plugin `r2c`) +
  order.
- Existing data reused, not crafted: custom order 1 (active,
  service 1), pending_setup order 4 (no service), products 2 and 9,
  unknown ids 999999.

No disk files are created for downloadable files (the API path is a
string join; existence is never checked). No uploads-dir cleanup is
needed. Crafted rows are removed by the full-DB snapshot/restore in
`finally`, including `sqlite_sequence`.

## 5. Verification

- `npx tsc --noEmit` clean; `npm run build` clean (exit code
  checked); new routes `/admin/products`, `/admin/products/[id]`,
  `/admin/services/[id]` in build output; server restarted on the
  fresh build before parity.
- **capture30.py + captures30/ (12 files):** PHP-only oracle corpus
  for the same cases parity27 compares live.
- **parity27: 27 checks, 0 failures, ALL GREEN.** Sections: A. API
  equivalence (5 crafted services + existing custom + no-service +
  unknown order + product get ×3 + product list, envelopes compared
  EXACTLY — crafted values are fixed, so no timestamp scrubbing;
  a format difference would be a real diff); B. page smoke (15
  routes as super-admin, 200 + sidebar + data markers matching the
  API response for the same record, plus the order-page service-link
  presence/absence cases); C. logged-out smoke (products list + one
  service detail: 200, no sidebar, sign-in link).
- Regressions, all observed: parity26 **62/62**, parity25 **203/203**
  (HTTP-status-only notes as before), fixtures **13/13 on BOTH
  stacks**, parity21 **194/203 with exactly the known 9 diffs, no
  new ones**.
- DB invariants clean after every run: tld 1, tld_registrar 3,
  service_domain 0, email_queue 67, servicedomain_last_sync
  `2026-10-26 03:24:56`, invoice 323, client_order 11, admin 2,
  admin_group 3, admin_group_member 1, support_ticket 2, client 3,
  service_downloadable 0.

## 6. Gaps carried forward

- Product create/edit/delete UI (later batch; endpoints exist).
- Service lifecycle actions (change plan/username/ip/domain/
  password, sync, lock/unlock, privacy, etc.) — NOT built; order
  status actions already exist on the order page, service-level
  actions are a later batch.
- Sidebar services section: none (see §1 — needs a services index
  page, not in R2c scope).
- Non-Custom/Hestia server-manager URL + secret-field extras (see
  §2 — unreachable on the reference install).
- Client-role `order/service` now also returns real service data
  for all five types (the port is shared with the admin handler,
  minus admin-only fields); the client service page is not in R2c
  scope and was not smoke-tested — the admin parity cases cover the
  shared code paths.
