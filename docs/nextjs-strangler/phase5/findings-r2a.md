# Phase 5 R2a findings — permission model + is_allowed + get_navigation + sidebar

Scope: `r2-scope.md` (D2-1..D2-5 at recommended defaults). Uncommitted
work on `feat/nextjs-phase5-r1` on top of `850c02a` (R1 close). No PHP
sources modified. No commit, no push.

## 1. What was ported

### Permission model — `apps/nextjs/src/server/permissions.ts` (new)

Port of PHP `Staff\Service::hasPermission` (`src/modules/Staff/Service.php`)
+ `AdminGroupMemberRepository` (`src/modules/Staff/Repository/AdminGroupMemberRepository.php`),
verified against source. Semantics, in order:

1. Cron admin (`admin.system_name = 'cron'`) → true.
2. Always-allowed modules (`index`, `dashboard`, `profile`) → true even
   for a keyed check.
3. Super administrator (member of the group whose `system_name` is
   `super_admin`) → true.
4. Modules whose Service declares `can_always_access` (`page`, `profile`
   only, from `Page/Service.php` and `Profile/Service.php`) skip the
   module `access` gate, but a keyed check still needs the key present
   and truthy.
5. Otherwise the module's `access` key must be truthy; a keyed check then
   needs that key present and truthy, with optional strict constraint
   comparison (unused by any Admin.php guard today).

Case-sensitive throughout, as in PHP. Missing admin row → false (safe
direction for corrupt state). Data: `admin_group_member` joins admin →
groups; each group's `permissions` column is JSON keyed by lowercase
module name, each value a map of permission key → boolean-ish.
Multi-group membership merges per key with OR.

Exports: `getAdminPermissions(adminId)`, `isSuperAdmin(adminId)`,
`hasPermission(adminId, module, key?, constraint?)`,
`requirePermission(ctx, mod, key?)`. The denial error mirrors PHP
`checkPermissionsAndThrowException` exactly:
`You need the "mod" permission to perform this action` or
`You need the "mod.key" permission to perform this action`, code 403.
`requirePermission` throws 201 `Authentication Failed` when there is
no admin session (matching PHP controller auth preceding the
dispatcher). DB helpers already existed and were reused: `findAdminFullById`
(includes `system_name`), `listAdminGroups`, `adminGroupIdsFor` in `db.ts`.

### Guard audit — `apps/nextjs/src/server/guards.ts` (new, generated)

Method: extracted every `checkPermissions(...)` call from all
`src/modules/*/Api/Admin.php` files with a method-span parser.
430 guarded PHP methods across 32 modules; all calls use literal args,
none uses a constraint argument. Joined against TS admin handlers:

- 398 TS admin handlers, all with a PHP Admin method; **386 with a PHP
  guard; 12 with a PHP method but NO guard** (cart `batch_expire`/`get`/
  `get_list`, extension `config_get`, page `get_pairs`, profile
  `change_password`/`destroy_sessions`/`generate_api_key`/`get`/`update`/
  `logout`, staff `is_super_administrator`) — these get NO guard,
  faithfully.
- **44 PHP-guarded methods have no TS handler** (still PHP-proxied, PHP
  enforces): extension 11 (activate/deactivate/get_extension_readme/
  get_latest/get_list/install/languages/locale_completion/
  toggle_language/uninstall/update), security 3 (ip_lookup/run_check/
  run_checks — R1-deferred), servicecustom `__call` (R4), system 21 (the
  R1-deleted + R1-deferred set), theme 7 (R4 replacements).

`ADMIN_GUARDS`: 386 entries, 396 guard pairs. Multi-guard methods:
unconditional ones fully in the table (cart `staff_basket_apply_promo`
order/manage + product/manage_promos; invoice `attach_order`,
`promo_add`, `promo_remove`; export_csv ×3 view + export; product
`promo_redemption_get_list` product/view + client/view + order/view +
invoice/view). Conditional ones split: unconditional prefix in the
table, conditional tail hand-placed in the handler (§1.1). Single-guard
methods were checked for conditionality: all effectively unconditional
except the late-guard set in §5.

Also found but NOT in the table: 2 `_getService` admin handlers
(servicehosting, servicelicense) — public PHP methods with no guard, so
unguarded; and the 19 system deletion handlers (registered via a
`REMOVED_SYSTEM_ADMIN` loop in system.ts) which throw the removal error
before any auth check by R1 design.

### 1.1 Conditional guards (hand-placed in handlers)

- `cart.ts` `staff_basket_checkout`: table has order/manage; handler
  adds `requirePermission(ctx, "invoice")` only when `mark_invoice_paid`
  is truthy, placed before `validateMarkPaidPreflight` (PHP checks it
  before `validateAdminMarkAsPaidRequest`).
- `invoice.ts` `mark_as_paid`: table has invoice/manage_invoices;
  handler adds `requirePermission(ctx, "client", "manage_balance")` when
  `isDepositInvoice(inv.id)` (existing helper: count of `invoice_item`
  rows with `type = 'deposit'`), placed right after `getInvoiceOrThrow`
  (PHP checks deposit before service status checks).
- `invoice.ts` `refund`: table has invoice/manage_invoices; handler adds
  the same manage_balance guard when `gateway_refund` (default true,
  normalized like PHP `Tools::normalizeBoolean` with default false for
  the param, true default when absent) AND deposit; placed right after
  `getInvoiceOrThrow`, before the status check.
- `invoice.ts` `reissue`: table has invoice/manage_invoices; handler
  adds `requirePermission(ctx, "order", "manage")` only when `order_id`/
  `product_id` params are non-empty per PHP `!empty` (`'0'` counts as
  empty), placed BEFORE `getInvoiceOrThrow` (PHP checks it before
  loading the invoice).
- `order.ts` `create`: table has order/manage; handler adds
  `requirePermission(ctx, "product", "manage_promos")` when promo_code
  non-blank or promo_id non-empty (`'0'` empty), and
  `requirePermission(ctx, "invoice")` when `mark_invoice_paid` truthy,
  placed after the client/product presence checks and before client
  lookup (PHP checks both before client lookup; note TS `create`
  ignores promo/mark_paid in its order logic otherwise — a pre-existing
  gap, not changed).

Imports added: `requirePermission` in cart.ts, invoice.ts, order.ts.

### is_allowed — `apps/nextjs/src/server/modules/system.ts`

Registered `admin/system/is_allowed`: `requireAdmin`, then
`requireParam(params, "mod", '"mod" key is missing')` (code 9999,
mirroring the PHP `RequiredParams` attribute), then
`hasPermission(adminId, mod, f ?? null)` where `f` is `params["f"]` or
null. No `checkPermissions` guard of its own (any logged-in admin may
ask). The old deferral comment was updated to note it landed in R2a;
the remaining deferral is instance_id → R5 (localization/error_reporting
already → R5).

Caveat: in PHP the dispatcher module-access gate (§2, code 725) fires
before the method body, so a staff member without `system` access gets
725 from `is_allowed`, not a boolean — the handler itself is correct;
the gate supplies that behavior.

### get_navigation — `apps/nextjs/src/server/modules/extension.ts`

Port of `Extension Service::getAdminNavigation` + all 19 modules'
`Controller/Admin::fetchNavigation()` declarations (Activity, Client,
Cookieconsent, Custompages, Email, Embed, Extension, Invoice,
Massmailer, News, Order, Product, Security, Servicedomain,
Servicehosting, Staff, Support, System, Widgets). Static declarations
(English labels, en_US install); module iteration mirrors PHP exactly:
core modules in `CORE_MODULES` order, then installed non-core modules
in extension-id order. A module contributes only if core-or-installed
AND the caller passes `hasPermission(admin, mod)` (key null). Subpages
attach to their location's group only when that group exists.

Groups (9, by index): client 200, order 300, invoice 400, products 401,
support 500, system 600, security 650, activity 700, extensions 1000.
Group uri = declaration uri, else first subpage uri after sorting
(Activity → System Activity; Support → Tickets `?status=open`;
Extensions → Overview). Active marking: subpage active when its uri path
equals the `url` param's path (query stripped, trailing `/` trimmed);
group active when any subpage is active; no `url` param → all false.

Support Knowledge Base subpage included iff `supportKbEnabled()`: reads
`extension_meta` row (extension `mod_support`, meta_key `config`),
decrypts via existing `crypt.ts` `decryptV2` (FB_INFO_SALT/
FB_CALLBACK_SALT), JSON-parses, `kb_enable` normalized per PHP
`normalizeBoolean` with default true. Reference install has NO
mod_support config row → KB present (confirmed in live PHP nav).

URIs are absolute against the PHP origin (`FOSSBILLING_URL` env,
default `http://127.0.0.1:8080`) + `/admin/...`, matching PHP
`Url::adminLink` output on the reference install (verified live:
`http://127.0.0.1:8080/admin/client`, Tickets
`http://127.0.0.1:8080/admin/support?status=open`).

Handler is a thin wrapper over exported `buildAdminNavigation(adminId, urlParam?)`.
Empty nav returns `[]` (PHP `json_encode([])` is `[]`, not `{}`).
`get_navigation` itself is unguarded in PHP (no `checkPermissions`
call) — but the dispatcher access gate (§2, 725) applies to it for
staff without `extension` access.

### Sidebar — `apps/nextjs/src/app/(admin)/layout.tsx` (rewritten) + `lib/fossbilling.ts`

Layout is now an async server component. It reads the session cookie via
`sessionOpts()`, resolves the admin via `readSession`, and calls
`buildAdminNavigation(adminId)` **in-process** (server components cannot
fetch the seam relatively, and their `fbCall` helper posts to the PHP
dispatcher directly — so the layout shares the endpoint's builder
function rather than duplicating the logic; documented in code).
Logged-out visitors (the login page lives under this layout) get the old
header-only chrome.

Filtering to existing pages happens IN THE COMPONENT, not the endpoint:
PHP admin path → Next route map is only `client → /admin/clients`,
`order → /admin/orders`, `invoice → /admin/invoices`,
`support → /admin/tickets`; everything else (client/logins, invoice
subpages, products, system, security, activity, extensions) is dropped;
groups with zero surviving subpages are dropped. A section with a single
surviving page links under the GROUP label ("Clients", not generic
"Overview"); multi-page sections keep subpage labels. Brand link
(`/admin`), Client area link, and `AdminLogoutButton` are kept in the
sidebar footer. No active-page highlighting in R2a (server components
have no pathname without a client component) — known gap, see §6.

`adminApi.getNavigation(params, opts)` was also added to
`lib/fossbilling.ts` for browser-side callers. Existing admin pages
were NOT changed; they render inside `<div className="min-w-0 flex-1">`
next to the `w-56` sidebar.

### Route wiring — `apps/nextjs/src/app/api/fb/[...path]/route.ts`

After `enforceCsrf`, the route now calls `enforceDispatcherGates`
(§2) before the handler, replacing the earlier `enforceAdminGuards`.
Route order is therefore: session read → CSRF → dispatcher gates
(201/715/725/403) → handler (which does `requireAdmin` + param checks +
logic). The route resolves handlers only when the module is in
`FB_TS_MODULES`; otherwise it proxies to PHP (PHP enforces everything).

## 2. Dispatcher gates — the R2a discovery (root cause of the first parity25 run's 128 failures)

PHP `Api\Dispatcher::dispatchWithArguments`
(`src/library/FOSSBilling/Api/Dispatcher.php`), verified by reading
source, enforces in this order (after controller auth, which gives 201
first):

1. Method format (710) / empty module (714) — irrelevant to the seam.
2. **Activation (715, every role):** `isExtensionActive('mod', $mod)` —
   core modules always active; otherwise the extension row must be
   installed. Message: `FOSSBilling module <mod> is not installed/activated`,
   code 715. On the reference install, non-core non-installed modules
   are exactly `seo`, `serviceapikey`, `cookieconsent` (TS
   seo/serviceapikey/cookieconsent handlers already throw 715
   unconditionally — hardcoded, pre-existing staleness if ever
   installed; see §6).
3. **Admin module access (725, admin role only, unless an update
   finalization is pending — reference install has none pending; the
   bypass is NOT modeled):** `hasPermission(identity, $mod)` with key
   null → `You do not have access to the <mod> module`, code 725. This
   fires BEFORE the method body, so it gates `is_allowed` (staff without
   `system` access get 725, not a boolean), `get_navigation` (staff
   without `extension` access get 725, not a filtered nav), every
   guarded endpoint (725 instead of the method's 403 when module access
   is missing), AND every unguarded endpoint (e.g. cart/get as nogroup
   → 725; profile/get as nogroup → passes because `profile` is
   always-allowed).
4. API class/method existence (740) — seam handles via `findHandler`
   (unregistered → proxy).
5. RequiredParams validation → param errors.
6. Method body → `checkPermissions` → 403.

`enforceDispatcherGates(ctx, role, module, method)` in guards.ts
implements, in PHP order: (a) identity 201 (admin: no admin session;
client: no client session — mirroring controller auth preceding the
dispatcher, so an unauthenticated caller gets 201 even for a
non-installed module); (b) activation 715 (core list =
`Module::CORE_MODULES` — api, activity, antispam, cart, client, cron,
currency, email, extension, index, invoice, order, page, product,
profile, security, servicecustom, servicedomain, servicedownloadable,
servicehosting, servicelicense, staff, stats, support, system, theme,
orderbutton, formbuilder, widgets — else DB check `extension` row type
`mod`, name = module, status `installed`); (c) admin access gate 725
via `hasPermission(adminId, module)`; (d) existing method-guard table
403.

**Deletion skip (required to preserve R1 design):**
`REMOVED_SYSTEM_ADMIN` in system.ts was changed from `const` to
`export const` (full list starts update_available, update_info,
recheck_update, update_core, update_finalization_status,
finalize_update, complete_update_finalization, manual_update,
is_behind_on_patches, cache_settings, update_cache_settings,
clear_cache, template_exists, env, get_interface_ips, set_interface_ip,
messages, cas_messages). The route skips ALL dispatcher gates when
`role === "admin" && module === "system" && REMOVED_SYSTEM_ADMIN.has(method)`,
so deleted endpoints still throw the removal error before any auth
check (parity24's deletion cases run as super-admin and are unaffected
either way, but non-super callers must still see removal, not 725).
Guest `system/template_exists` deletion needs no skip (guest has no
access/method gates; activation passes since system is core).

## 3. Verification

- `npx tsc --noEmit` clean; `npm run build` clean (exit code checked)
  before the parity run. Both servers re-verified 200 on the fresh
  build (`__prime` 200, PHP 200).
- **parity25: 203 checks, 0 failures, ALL GREEN.** Sections:
  A. is_allowed matrix — 8 staff (super, sysaccess, lead, staff,
  nogroup, orderonly, invoiceonly, cartorder) × 18 (mod, f) pairs +
  missing-mod as super (param error) and as nogroup (725 — gate
  precedes param validation).
  B. nav — super, sysaccess, lead, staff, nogroup + super with
  `url` = invoice and = support (active marking). Super nav is the
  full 9-group shape; sysaccess nav is exactly the support group
  (Tickets, Canned Responses, Knowledge Base — subpages are NOT
  per-subpage permission-filtered in PHP; a passing module contributes
  all its subpages), the system group, and the extensions group (it has
  all three module accesses); lead/staff/nogroup navs are 725.
  C. 30 denial picks as nogroup (one guarded endpoint per guarded TS
  module, generous params supplied so PHP RequiredParams passes and
  both stacks reach the guard): 725 per module except profile
  `api_key_reset` → 403 (always-allowed module, method guard fires)
  and seo `info` / serviceapikey `reset` → 715 (activation first).
  D. conditionals — reissue+order_id as invoiceonly (403 order/manage);
  order create+promo and +mark_paid as orderonly (403
  product/manage_promos, 403 invoice); cart checkout+mark_paid as
  cartorder (403 invoice — the group has cart + order access but no
  invoice access); mark_as_paid and refund on the crafted paid deposit
  invoice as invoiceonly (403 client/manage_balance); allow-directions:
  reissue without order_id on nonexistent invoice as invoiceonly,
  mark_as_paid on paid non-deposit invoice 1 as invoiceonly.
  E. sidebar smoke — TS pages `/admin`, `/admin/clients`,
  `/admin/orders`, `/admin/invoices`, `/admin/tickets` as super (200,
  `<aside>` present, sidebar labels Clients/Orders/Invoices/Support;
  tickets heading "Support tickets"); `/admin/login` without session
  (fallback chrome, no `<aside>`).
  F. method-key denials (403) — Support Staff → support `canned_delete`
  (403 support/manage_canned, `{id:1}`); orderonly → order `get`
  (403 order/view); invoiceonly → invoice `get` (403 invoice/view);
  Lead → staff `delete` with real id 2 (403 staff/delete_staff; see §5
  for why a nonexistent id would not test this).
  G. activation (715) — super: seo `info`, serviceapikey `reset`.
  HTTP-status-only notes (envelopes compared, statuses differ by seam
  convention — TS error envelopes are always HTTP 200, PHP answers
  403/725 with the same envelope): cart staff_basket_checkout,
  invoice get/mark_as_paid/refund/reissue, order create/get, profile
  api_key_reset, staff delete, support canned_delete.
- **capture28.py + captures28/ (140 files):** PHP-only corpus for the
  same case set, following the R1 pattern. Seeds (restored in finally,
  including `sqlite_sequence` and `data/uploads` cleanup): four custom
  groups (order-only, invoice-only, sysaccess `{system:{access},
  extension:{access}, support:{access,view,manage_tickets}}`, cartorder
  `{cart:{access}, order:{access,manage}}`), seven staff accounts (all
  password `R2a-Staff!42`, bcrypt `$2b$12$...` via node bcryptjs),
  plus one crafted paid deposit invoice (copy of invoice 1 with a
  freshly minted hash — the first parity25 run failed on
  `UNIQUE constraint failed: invoice.hash` before this fix — plus one
  `invoice_item` of type `deposit`). Logins go through PHP once
  (`GET /login` → CSRF token → `POST /api/guest/staff/login`); the
  session row lives in the shared DB, so the same cookies authenticate
  both stacks (TS reads the PHP-created row). The PHP login page's CSRF
  token stays valid after staff login (session id regenerates,
  attribute bag survives).
- Fixtures, parity21, invariants: see §7 (run after this doc's first
  draft; results recorded there).

## 4. Bugs found by parity25, fixed

1. **Nav two-phase bug.** The first implementation attached subpages
   during the module loop, dropping cross-group subpages whose group
   module comes later (invoice tax/gateways and hosting/domain pages
   target the system group, declared after them). Fixed to two phases
   exactly like PHP: phase 1 creates all groups and collects every
   subpage flat in module order; phase 2 attaches to groups (per-group
   `orig` = attach order within group), then stable-sorts by index.
   The nav_super diff had shown only `.system.subpages: php=dict
   ts=list` (type mismatch short-circuited deeper comparison, hiding
   the missing subpages).
2. **Dispatcher gates missing (715/725).** First implementation had
   only the method-guard table; PHP's activation and module-access
   gates fire first and change nearly every non-super answer. Fixed by
   `enforceDispatcherGates` + route wiring (§2).
3. **Parity-script needle errors (not code):** `/admin` dashboard has
   no "Tickets" word (sidebar link label is "Support", dashboard cards
   are Clients/Orders/Invoices only) and `/admin/tickets` heading uses
   lowercase "tickets" ("Support tickets") — both pages returned 200
   with `<aside>` present.

## 5. Known precedence divergences (TS route guard fires before the handler; PHP guards sit inside method bodies)

- **Params vs guard:** PHP validates RequiredParams between the access
  gate and the method body, so a call that is BOTH param-invalid AND
  method-denied gets the param error from PHP but the 403 from TS.
  Only that combined case differs; parity and matrix cases use valid
  params. (Pinned by `allowed_nogroup_missing_mod`: gate 725 precedes
  params on both stacks — that direction matches.)
- **Late guards (load/validation before guard).** A full audit of
  statements preceding each PHP guard found exactly three live cases
  (plus proxied/deleted system methods, irrelevant):
  - Staff `update` and `delete`: `getAdminById` loads BEFORE the guard.
    Denied staff + nonexistent id → PHP "Staff member not found"
    (9999), TS 403. Denied staff + real id → 403 both (parity25's
    `deny_key_lead_staff_delete` uses real id 2, the cron admin, which
    is never deleted because the guard fires after the load).
  - Staff `change_password`: password-match + strength validation and
    the load precede the guard. Denied staff + weak password → PHP
    password error, TS 403. Documented edge only.
- **Finalization bypass unmodeled:** PHP skips the 725 gate while an
  update finalization is pending; the reference install has none
  pending and TS does not model the bypass. If a finalization ever
  pends during verification, non-super answers will diverge until the
  bypass is modeled.

## 6. Standing divergences / gaps carried forward

- **JS integer-key serialization order:** PHP `json_encode` emits a
  group's subpages as a JSON object (not array) when the index-sorted
  keys are not 0..n-1 sequential — this affects the activity group
  (keys `0,2,3,1`) and system group (keys `4,5,3,2,1,0`) in the super
  nav. TS reproduces the key sets via `Object.fromEntries`; JS
  reorders integer-like keys numerically on stringify, so wire order
  differs from PHP while parsed key/value sets are identical. Parity
  compares parsed JSON, as in all prior batches.
- **seo/serviceapikey/cookieconsent handler 715 hardcoding:** TS
  handlers throw 715 unconditionally (pre-existing, from R1 sub-batch
  2); the route gate now also returns 715 for non-installed modules,
  so the answers agree on the reference install — but if those modules
  are ever installed, the handlers must be revisited (the active-path
  logic is unverified-live, as in R1).
- **Sidebar active highlighting:** not implemented (server components
  have no pathname without a client component). R2b may add a small
  client component if Josh wants it.
- **Nav entries for unbuilt pages:** hidden in the sidebar by the
  component filter, NOT by the endpoint (per scope: endpoint stays
  PHP-faithful). R2b–R2e pages will appear in the sidebar as they are
  built, by extending the component's route map.
- **TS `order create` ignores promo/mark_paid in its order logic**
  otherwise (pre-existing gap, not changed by the conditional guards).
- **TS error envelopes are always HTTP 200** (seam-wide convention);
  parity compares envelopes, and HTTP-status-only diffs vs PHP are
  documented, not hidden.

## 7. Remaining gates — all observed green (2026-10-27)

- Fixtures **13/13 on BOTH stacks** (`run-fixtures.py`; :3001 killed
  before the next-stack run; the surviving `next-server` child killed
  afterwards with the bracket pattern; the full 34-module Next server
  was restarted after fixtures for parity21).
- parity21 **194/203 with exactly the known 9 diffs, no new ones**:
  3 direct tld_delete + sd_reg_available (Enom) + 4 downstream
  (.cap24 survives on PHP: sd_guest_tlds, sd_guest_tlds_reg,
  sd_guest_tlds_trans, sh_guest_free_tlds_fallback) + the documented
  HTTP-status artifact (dl_admin_send_file_missing_stored: TS answers
  HTTP 200, PHP 404, byte-identical 113-byte envelope).
- DB invariants clean: tld 1, tld_registrar 3, service_domain 0,
  email_queue 67, servicedomain_last_sync 2026-10-26 03:24:56,
  invoice 323, client_order 11, admin 2, admin_group 3,
  admin_group_member 1.

## 8. Scope refinements (for r2-scope.md, none change the approved scope)

- The R2a verification standard's "≥1 guarded-endpoint denial per
  module touched" is satisfied at 30 modules as nogroup (725s) PLUS 4
  method-key 403s — the 725 cases pin the gate, the 403 cases pin the
  method table; neither alone would have caught both bug classes.
- The scope's "page smoke … reads only TS-served endpoints" holds for
  the five existing pages (clients/orders/invoices/tickets pages read
  TS-served endpoints; the sidebar itself is in-process, not a seam
  call — see §1).
