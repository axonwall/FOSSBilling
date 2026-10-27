# Phase 5 R2 — Next-native admin UI: scope (DRAFT)

Status: DRAFT for Josh's approval, 2026-10-27. Nothing here is built yet.
Approved constraint: D5-1 — Next-native admin, **not** Twig parity.
That decision already rules out porting the 141 admin Twig templates
(29 theme files + 112 module templates). The admin UI becomes a new
product surface, in the Phase 1 style: server components, Tailwind,
`adminApi` from `@/lib/fossbilling`, session-cookie auth.

## Current state (end of R1, commit 850c02a)

Admin UI: 9 pages under `apps/nextjs/src/app/(admin)/` — dashboard,
login, clients list + detail, invoices list (no detail), orders list +
detail, tickets list + detail (with staff reply). Header nav has 4
sections (Clients, Orders, Invoices, Tickets) and no sidebar.

API readiness is far ahead of UI: the TS seam serves the large majority
of the 449 admin endpoints (all R1 batches included), so R2 pages can
almost always read TS-served endpoints. The gaps are structural, not
per-endpoint:

1. **No permission model in TS.** PHP staff groups carry per-module
   permissions (`admin_group.permissions` JSON, via
   `admin_group_member`; `Staff::hasPermission` + `checkPermissions`
   403s non-permitted staff). TS `requireAdmin` checks only that a
   staff session exists. Consequence: through the TS seam today, any
   logged-in staff member (e.g. Support Staff) can call admin
   endpoints PHP would 403 for their group. `admin/system/is_allowed`
   is deferred to R2 for exactly this reason (see `system.ts`).
   Reference DB groups: Super Administrator, Support Lead, Support
   Staff — the matrix is testable as-is.
2. **No navigation endpoint in TS.** `admin/extension/get_navigation`
   is still PHP-served (proxied). PHP builds it from 19 modules'
   `fetchNavigation()` declarations, filtered by `hasPermission`,
   sorted by group/subpage index. A Next sidebar needs the TS
   equivalent (or a hand-declared nav — see D2-2 note).
3. **No shared admin chrome.** Pages are `max-w-4xl` single-column
   with a 4-link header. No sidebar, no shared table (pagination /
   sort / search), form, or detail-tab components — the PHP partials
   (`partial_pagination`, `partial_search`, `partial_admin_detail_tabs`,
   `partial_admin_form_card`, `partial_sortable_th`) are the behavior
   spec for these, not code to port.

## Proposed workstreams

### R2a — Permission model + navigation + sidebar (do first)

- Port `hasPermission` semantics to TS: always-allowed modules
  (`index`, `dashboard`, `profile`), cron bypass, super-admin bypass,
  group-permission lookup (`admin_group_member` → group's `permissions`
  JSON), module `access` gate + per-key checks with optional constraint.
- Port `admin/system/is_allowed` on top of it (closes the R1 deferral).
- Enforce in dispatch: a `requirePermission(mod, key?)` guard that
  handlers PHP guards with `checkPermissions` adopt, module by module.
  Auditing ~400 admin handlers for their PHP guard is the bulk of R2a;
  it batches cleanly per module and each batch re-runs the parity
  suites (a wrong guard breaks parity immediately, since parity runs
  as super-admin — plus new matrix cases as non-super staff).
- Port `admin/extension/get_navigation`: nav groups/subpages for the
  19 declaring modules, permission-filtered, index-sorted, with the
  active-page marking PHP does from the current URL.
- Sidebar layout replacing the 4-link header on all admin pages.

### R2b — Finish the four core sections

- Invoice detail page (the one missing detail view among the four).
- Create/edit/delete actions where the API already exists: client
  create/edit, order actions (activate/cancel/delete per API), ticket
  actions beyond reply. No new API work expected; this batch is pages
  + forms on existing endpoints.

### R2c — Products and services

- Product list + detail; service detail views for the D7 set
  (hosting, domain, license, downloadable, custom) reusing the R1
  endpoints. This is the largest page batch after R2a; it is also the
  one Axonwall's own hosting operation would actually live in.

### R2d — Staff and groups UI

- Staff list + detail, group list + editor (permissions matrix form).
  This makes the R2a model operable instead of API-only, and it is
  the natural home for the `manage_groups` / `create_and_edit_staff`
  permission keys.

### R2e — System settings UI (bounded)

- Settings pages for the config surface that already has TS endpoints
  (system settings, currency list/rates view, stats dashboards).
  Extension install/activate/config UI is **excluded** here and
  deferred to R4, since R4 replaces the extension mechanism itself;
  building UI on the PHP extension model now would be throwaway work.

## Explicitly out of R2

- Twig parity (rejected by D5-1); theme system (deleted in R4).
- Client-area changes (complete in Phase 1).
- New API endpoints except `is_allowed` and `get_navigation`
  (everything else R2 needs already exists in TS).
- Email transport (R5, D5-4 still TBD), Postgres/importer (R3),
  proxy removal (R6).

## Verification per batch

- `tsc` + `next build` clean; fixtures 13/13 both stacks; parity21
  and the batch parity suites stay green (no regressions).
- New API gates: permission matrix cases (Super Administrator vs
  Support Lead vs Support Staff) for `is_allowed`, `get_navigation`
  filtering, and at least one guarded endpoint per module touched.
- Page smoke: every new route returns 200 as admin, redirects to
  `/admin/login` when logged out, and reads only TS-served endpoints
  (a page whose data still proxies to PHP is not R2-done).
- No live-browser or screenshot gate: pages are verified by route
  smoke + data assertions, same standard as Phase 1.

## Decisions for Josh

- **D2-1 — Batch order.** Recommended: R2a → R2b → R2c → R2d → R2e.
  R2a first because it closes a real authorization gap, and every
  later page inherits the sidebar + guards for free.
- **D2-2 — Enforcement depth.** Recommended: full API enforcement
  (`requirePermission` in handlers), not nav-only gating. Nav-only
  would hide links while leaving the endpoints callable — cosmetic
  security. Cost is the per-module guard audit in R2a.
- **D2-3 — Staff/groups UI in R2.** Recommended: yes, as R2d. The
  alternative (API-only model, UI later) leaves the model unusable
  by anyone but API callers.
- **D2-4 — System settings in R2e, extension UI deferred to R4.**
  Recommended: yes. Extension UI built now would target a mechanism
  R4 deletes.
- **D2-5 — Styling.** Recommended: keep Phase 1 hand-rolled Tailwind
  + small shared components (table, form card, detail tabs). No new
  component library, no Tabler port. The admin UI is an internal
  operator surface, not a theme product.

## Open questions (not decisions, just unknowns)

- Whether Axonwall's operation wants any admin surface beyond the
  PHP set (e.g. a provisioning-oriented dashboard) — out of scope
  unless Josh says otherwise; R2 mirrors PHP's sections.
- The 19 `fetchNavigation` declarations include modules whose admin
  pages R2 may never build (e.g. Embed, Branding); nav entries for
  unbuilt pages point at PHP-served routes until their batch lands,
  or are hidden until built — R2a will hide unbuilt entries rather
  than link to dead pages.
