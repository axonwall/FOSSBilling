# Findings — Phase 5 R4a: registry + extension API

Branch `feat/nextjs-phase5-r1`, uncommitted. R4 scope decisions D4-1..D4-8
at recommended defaults (see `r4-scope.md`). R4a only: registry +
extension API. NOT in this batch (unchanged): extension UI (R4b), theme
(R4c), servicecustom plugin runtime + salt re-key (R4d), per-module
proxy removal (R6), the proxy fallback itself (D4-7, untouched).

## 1. Survey answers (all measured live against the reference install)

### Q1. What does PHP `get_list` return?

`Extension/Service.php::getExtensionsList` (confirmed by reading it and by
probing all modes):

- It first prunes extension rows whose module files/manifests are gone
  (`removeNotExistingModules` — a WRITE on a read; the TS port
  deliberately does not prune, it only omits).
- Installed entities = extension rows with `status='installed'`, DB id
  order, each rendered as its manifest (defaults merged, `id` and
  `type='mod'` forced) + `version` overridden from the DB row +
  `status` from the row + `has_settings` from `hasSettingsPage()`
  (settings template exists) when TYPE_MOD and STATUS_INSTALLED.
- `active=1`: core modules FIRST (in `getCoreModules()` order) with
  `status='core'`, then installed rows. No available list.
- Neither `installed` nor `active`: installed rows + inactive modules
  = non-core on-disk modules with manifests (`_getAvailable()`,
  excludes core) minus installed ones, each with `status=null`,
  `has_settings=false`, `has_settings_routes=false`,
  `settings_routes=[]`.
- `installed=1` alone: installed rows only. `installed=1` + `active=1`:
  core + installed (the active branch wins; no available list).
- Filters, applied after merging: `has_settings` keeps only
  `has_settings=true` entries; `search` keeps entries whose manifest
  `name` contains the string (case-insensitive); `type` applies ONLY
  to the installed-rows query (core + available lists ignore it).
- `getManifest()` defaults (applied when the key is ABSENT from
  manifest.json — most manifests omit the author/license keys
  entirely; massmailer is a minimal manifest with only
  id/type/name/icon/description/version): `id`=module, `type`='mod',
  `name`=module, `description`=null,
  `homepage_url`='https://fossbilling.org/', `author`='FOSSBilling',
  `author_url`='https://extensions.fossbilling.org/', `license`='N/A',
  `version`='1.0', `icon_url`=null, `download_url`=null,
  `project_url`='https://extensions.fossbilling.org/',
  min/max versions null. A present manifest value wins verbatim —
  including antispam's `project_url`
  ('https://docs.fossbilling.org/admin-guide/anti-spam/').
- `icon_url`: manifest without one renders `'assets/icons/cog.svg'`;
  with one renders SYSTEM_URL + `'/modules/<Dir>/<icon>'` — the
  trailing-slash base plus the leading-slash path yields the live
  double slash (`'http://127.0.0.1:8080//modules/News/icon.svg'`),
  reproduced exactly. `icon_path` (`'mod_<Dir>_<basename>'`) is present
  ONLY when the icon file exists under the module dir — the key is
  absent otherwise, not null.
- Installed modules whose manifest fails to decode are SKIPPED
  (logged, `continue`) — this is the precedent for the TS port
  skipping non-registry rows.
- Reference rows (6, all `type='mod'`, `status='installed'`):
  branding (v0.0.1), redirect, custompages, massmailer, notification,
  news (all v1.0.0). Available non-core on-disk modules: cookieconsent,
  embed, seo, serviceapikey (alphabetical in the observed output).

### Q2. What does PHP `activate` do with no extension row?

`activateExistingExtension()`: RequiredParams `id`/`type` first
('Extension ID was not passed' / 'Extension type was not passed',
9999 — missing OR blank, per `Validate::checkRequiredParamsForArray`).
For `type='mod'` the manifest must load, else 5897: 'Cannot activate
the \<id\> module: its manifest file is missing or invalid. The
extension files may be incomplete, please reinstall the extension.'
(a template with the id substituted — NOT a literal ':mod' suffix).
No row → a row is created (transiently `STATUS_DEACTIVATED`), then
`activate()` sets `status='installed'` and version from the manifest;
on failure a newly-created row is removed and the exception rethrown.
Returns `{id, type, redirect: hasAdminController(),
has_settings: hasSettingsPage()}` — live probe: news →
`{id:'news', type:'mod', redirect:true, has_settings:false}`. The
extension table has only (id, type, name, status, version) columns, so
`redirect`/`has_settings` are computed in the result, never stored.
Non-mod types skip the manifest check (only TYPE_MOD is special-cased
in `activate()`); the row is created/re-installed with
redirect/has_settings false. That path is untestable on the reference
(zero non-mod rows) and is mirrored best-effort.

### Q3. Deactivated status value

**There is none.** `Extension/Service.php::deactivate()` deletes the
row (`$em->remove($ext)` + flush) and returns `true`. The R2a gate
passes only `status='installed'` rows, so deletion fails the gate —
which is exactly what makes activation toggling enforce. The parity
suite therefore compares extension rows as `(type, name, status,
version)` SETS, never ids: the probe's deactivate/reactivate round-trip
moved news from id 1 to id 7, and the same churn happens in parity30.
Api `deactivate` order (mirrored): RequiredParams → row lookup
('Extension not found', 9999, if no row) → core refusal ('Core modules
are an integral part of the FOSSBilling system and cannot be
deactivated.') → delete → `true`. The core refusal is nearly
unreachable via the API since core modules have no rows — a core
deactivate answers 'Extension not found' first (verified live for
client).

### Q4. Permission keys per endpoint

From the `checkPermissions` calls in `Extension/Api/Admin.php` (and the
absence of any in `Guest.php`):

| Endpoint | PHP guard | TS treatment |
|---|---|---|
| admin `get_list` | extension/view | static `ADMIN_GUARDS` entry |
| admin `activate` | extension/manage_extensions | static entry |
| admin `deactivate` | extension/manage_extensions | static entry |
| admin `config_get` | in-handler `hasManagePermission` | in-handler (see below) |
| admin `config_save` | in-handler `hasManagePermission` | in-handler |
| admin `install` | extension/manage_extensions | REMOVED — no entry; removal error before auth |
| admin `uninstall` | extension/uninstall_extensions | REMOVED — no entry |
| admin `update` | extension/manage_extensions | REMOVED — no entry |
| admin `get_latest` | extension/view | REMOVED — no entry |
| admin `get_extension_readme` | extension/view | REMOVED — no entry |
| admin `languages` | extension/view | REMOVED — no entry |
| admin `toggle_language` | extension/manage_extensions | REMOVED — no entry |
| admin `locale_completion` | extension/view | REMOVED — no entry |
| guest `is_on` | none (guest role) | faithfully unguarded |
| guest `settings` | none (guest role) | faithfully unguarded |
| guest `languages` | none (guest role) | REMOVED — no entry |
| admin `get_navigation` | none (filters internally) | unchanged (R2a) |

Removed endpoints need no guard entries by the same logic as R1's
system deletions: the route skips ALL gates for them, so the removal
error throws before any auth check.

`hasManagePermission(module)` exact rules (from
`Extension/Service.php`, verified live): strip a `mod_` prefix. If the
target is NOT active (not core, no `installed` row) → require
`extension/manage_extensions` (R2a denial, 403) and return. Else
require target-module access, else 403 'You do not have permission to
access the \<target\> module'. Then: if the target module's declared
permissions LACK a `manage_settings` key → 403 'You do not have
permission to perform this action' **regardless of identity** (this
throw does not consult identity). Else require target
`manage_settings` (R2a denial, 403). Modules declaring
`manage_settings` (19, from `getModulePermissions`): activity,
antispam, client, cookieconsent, cron, currency, email, extension,
formbuilder, invoice, massmailer, order, orderbutton, redirect, seo,
staff, support, system, theme. Live proof of the identity-independent
throw: super-admin `config_get` for `mod_news` (active; news does not
declare the key) → 403 'You do not have permission to perform this
action'. The TS `config_get` previously did `requireAdmin` only — it
was MISSING this check, and R4a adds it as part of the config model.
Parity29's only `config_get` call (super-admin, `mod_currency`, which
declares the key) still passes.

### Q5. `config_save` validation/encryption shape

Api: RequiredParams `ext` ('Parameter "ext" was not passed', 9999 —
note the quotes, unlike guest `settings`' 'Parameter ext is missing')
+ `hasManagePermission`. `setConfig($data)` stores
`json_encode($data)` — the FULL `$data` including the `ext` key —
v2-encrypted (AES-256-CBC, PBKDF2-SHA256, salt `'fossbilling_salt'`,
100k iterations, IV prepended, base64, `v2:` prefix; passphrase =
config.php `info.salt`) into `extension_meta` (`extension`=ext,
`meta_key`='config'), update-or-insert; returns `true`.
`config_get` returns decrypted config + `ext`; no row → `{ext}`;
undecryptable → `{ext}` (decrypt failure yields `[]` + `ext`).
**CSRFToken is stripped before dispatch** (probe-proven: a saved
throwaway config held only `{ext, r4a_test_flag}`, never the token),
so TS `config_save` strips `CSRFToken` from stored params. TS stores
`rawParams` (real types) when the body was JSON, else `params`
(strings) — mirroring PHP for both content types; PHP accepts JSON
posts for `config_save` too (verified by probe, both directions
round-trip). Stored JSON bytes differ by key order between stacks;
parity compares parsed configs, and the DB check asserts the `v2:`
prefix + absence of the plaintext flag, not byte equality.
`crypt.ts` already provided `readExtensionConfig`/`writeExtensionConfig`
(mirroring `setConfig` incl. `updated_at` bump); the Phase 4
`config_get` stub returned `{ext}` unconditionally and is now fixed
to actually decrypt — required for the round-trip proof to mean
anything. The two encrypted columns remain exactly
`extension_meta.meta_value` and `email_template.vars` (R3b survey).

Guest semantics (mirrored exactly, including the `mod_` strip):
`is_on`: `mod` non-empty → `isExtensionActive('mod', mod)`; else
`id`+`type` non-empty → `isExtensionActive(type, id)`; else `true`.
`isExtensionActive`: core ONLY for type `'mod'` → true, else an
`installed` row must exist (so `type='theme', id='theme'` → false).
`settings`: RequiredParams ext ('Parameter ext is missing', 9999);
strip `mod_`; module must be in core-or-installed (core modules +
installed mod names) else `[]`; else the config's `public` subset if
it is an array/object (PHP `is_array` covers both JSON arrays and
objects), else `[]`. The config row is looked up by the RAW ext
(prefix included), as in PHP's `getConfig($ext)`.

## 2. What was built

- `apps/nextjs/src/server/extension-registry.ts` (new): the 34 TS
  modules' metadata (id, dir, manifest name/description/homepage/
  author/author_url/license/version/icon, icon-file presence, settings
  -template presence, admin-controller presence) transcribed from the
  0.8.9 manifests + tree surveys, plus `MANAGE_SETTINGS_MODULES` (19).
  It replaces PHP manifest loading; it does not load code (modules
  stay statically imported by `modules/index.ts`).
- `apps/nextjs/src/server/modules/extension.ts`: `get_list` (registry ×
  DB status, PHP mode/filter logic), `activate`, `deactivate`,
  `config_save`, fixed `config_get` (decrypt + `hasManagePermission`),
  guest `is_on` + `settings`, and the 9 removal handlers. The old
  Phase 4 header comment (claiming decryption was a gap) is replaced.
- `apps/nextjs/src/server/guards.ts`: `CORE_MODULES` exported (single
  source shared with the registry) + 3 `ADMIN_GUARDS` entries
  (get_list/view, activate + deactivate/manage_extensions).
- `src/app/api/fb/[...path]/route.ts`: gate-skip extended to the 9
  removed extension methods (R1 pattern).

### Implemented (admin): `get_list`, `activate`, `deactivate`, `config_get` (fixed), `config_save`
### Implemented (guest): `is_on`, `settings`
### Removed (R1 pattern, never proxied, error before auth): admin `install`, `uninstall`, `update`, `get_latest`, `get_extension_readme`, `languages`, `toggle_language`, `locale_completion`; guest `languages`
### Removal rationale per endpoint

- `install`: downloads and extracts a remote package — abolished by
  the in-tree model (D5-5: no remote code, ever).
- `uninstall`: removes module files from disk — meaningless when
  modules are statically imported code, not installed files.
- `update`: re-downloads a newer remote package — same as install.
- `get_latest`: lists a remote extension directory — abolished.
- `get_extension_readme`: fetches a remote README — abolished.
- `languages`, `toggle_language`, `locale_completion`: manage
  translation files / locale catalogs — owned by R5 localization
  (the two localization deferrals land there), not by the extension
  model.

## 3. Deliberate differences from PHP (documented, not hidden)

1. **Registry scope.** PHP's `get_list` lists every on-disk module;
   TS lists registry modules only (the 34 TS modules). Per-module
   field equivalence holds for every registry module PHP lists. The
   PHP extras are enumerated by parity30, not hand-waved: default
   mode extras = branding + embed; active mode extras = api,
   orderbutton, theme + branding; installed mode extra = branding.
   Branding is an installed row with no TS module (skipped, mirroring
   PHP's skip-on-manifest-failure); embed is a PHP-only non-core
   module; api/orderbutton/theme are core modules with no TS module
   (theme is R4c's).
2. **Available order.** PHP's Finder order for the 4 available modules
   on the reference is alphabetical; TS sorts available registry
   modules alphabetically by id. Same observed order, deterministic.
3. **No pruning on read.** PHP's `get_list` deletes rows for vanished
   modules; TS never mutates the extension table on a read, it only
   omits non-registry rows from the listing.
4. **Non-mod rows.** PHP's list rendering is manifest-based (mod
   concept); TS skips non-mod installed rows (zero on the reference).
   Non-mod `activate` is mirrored best-effort (row create/re-install,
   redirect/has_settings false) and is unverified-live.
5. **PHP's 1h config cache.** `Extension/Service::getConfig` caches
   for 1 hour in the Symfony app pool, and a TS write or SQL delete
   does NOT invalidate it — so a PHP `config_get` after a TS
   `config_save` serves the stale pre-write value. This is a PHP
   caching artifact, not a TS divergence: TS reads the DB directly and
   is always fresh. Parity30 clears the app pool (regenerable;
   Doctrine pools untouched) before PHP config reads that follow TS
   writes, and in its finally, so no stale config survives the suite.
   Operators should know: after any out-of-band config change, PHP
   serves cached config for up to an hour unless the app pool is
   cleared (a PHP `config_save` invalidates its own key).
6. **Inherited seam conventions.** TS error envelopes are always HTTP
   200 (PHP answers 4xx with the same envelope — compared as
   envelopes, never status). R2a params-vs-guard precedence stands
   (a call both param-invalid AND method-denied gets the param error
   from PHP but the 403 from TS).

## 4. Verification

- `capture33.py` + `captures33/` (30 files): PHP reference corpus —
  get_list modes/filters, activate/deactivate error shapes, guest
  is_on/settings cases, no-row config_get cases, extension +
  extension_meta baselines. No secrets captured (config cases use
  no-row modules only; baselines record keys, not values).
- `parity30.py`: **179 checks, 0 failures** (final run; see §5 for the
  first run's 10 failures and their fixes). Covers: get_list
  equivalence per mode/filter with full per-entry dict equality and
  enumerated PHP extras; activate/deactivate error equivalence;
  news round-trip with gating proven both directions (deactivate →
  `admin/news/get_list` answers 715 on BOTH stacks and guest is_on
  false; reactivate → served again, is_on true, row restored);
  config_save round-trip urlencoded + JSON + nested types, read back
  via config_get on both stacks in both directions, direct DB check
  (`v2:` prefix, plaintext flag absent), guest-settings public-subset
  proof via a crafted public array; all 9 removal errors on TS only
  (including logged-out callers, proving the gate skip); permission
  cases with three non-super personas (support-only → 725s;
  extension-only → 403 method guard + 403 module-access from
  hasManagePermission; ext+news → identity-independent 403) plus the
  super-admin identity-independent 403 for news.
- Secret audit: recursive key scan (`password`, `passwd`, `api_token`,
  `secret`, `salt`, `private_key`, `webhook`, `smtp`, `captcha`) over
  every config envelope captured in parity30 → no hits. All config
  test values are benign flags (`parity30-benign`, `parity30-php`,
  nested `{a: 1, b: 'x'}`, `['r4a-public-test']`); no real config
  values are pasted in this document.
- Restore proof: full-DB snapshot restore in `finally`; invariants
  clean before AND after; extension rows verified restored as a set
  (6 rows, all `installed`); extension_meta keys back to baseline (3);
  PHP app cache cleared in finally.
- Gates: `npx tsc --noEmit` clean; `npm run build` clean (exit 0);
  new code confirmed in the production bundle by string-literal grep
  (function names are minified).
- Regression: (pending — chain running at write time; updated below).

## 5. Failures found and fixed during this batch (honest account)

First parity30 run: 169/179. The 10 failures had 5 root causes, all
fixed and re-verified at 179/179:

1. **Massmailer minimal manifest.** The survey's manifest dump
   misattributed custompages' author/license values to massmailer;
   the real manifest has only id/type/name/icon/description/version,
   so PHP renders all four author/license fields as defaults. The
   registry entry is now true nulls. Lesson: trust the file + the live
   diff, not a bulk dump's line alignment.
2. **Antispam `project_url`.** The registry had no `project_url`
   field at all (hardcoded default); antispam's manifest sets one.
   Added `projectUrl` to the registry + renderer; antispam is the only
   registry module with a manifest `project_url`.
3. **Activate message colon.** The survey note recorded the template
   as 'Cannot activate the:mod module'; the live message has NO colon
   ('Cannot activate the \<id\> module'). Fixed the TS string; the
   captured corpus (capture 11) confirms the exact wording.
4. **PHP 1h config cache staleness** (see §3.5). First-run
   `cfgsave_read_both` failed because PHP served the probe's cached
   value after the TS write. Fixed by clearing the app pool before
   PHP config reads following TS writes (and in finally).
5. **Urlencoded arrays stringify.** The public-subset craft posted
   `public=[...]` urlencoded, which arrives as a string, so both
   stacks correctly returned `[]`. The craft now goes through a JSON
   post (real array); both stacks return `['r4a-public-test']`.

## 6. Left unverified / standing items

- Non-mod `activate` path (no non-mod rows on the reference).
- Guest `settings` public-subset for an OBJECT public value (array
  proven; PHP `is_array` and TS `typeof object` cover objects by the
  same rule, but no object-valued public config exists on reference).
- Available-list order beyond the 4 observed modules (alphabetical
  assumed from the observed order; TS sorts alphabetically).
- No UI in R4a, so no browser click-through applies; R4b owns the
  extension UI.
- Live Postgres behavior of the new handlers (R3c's job; the handlers
  use the same `Db` interface as everything else).
- R4b/R4c/R4d remain, each with its own parity suite (31/32/33).

## 7. Regression results

All run against the fresh R4a build after parity30 went green:

- parity29: 62/62, 0 failures.
- parity28: 128/128, 0 failures.
- parity27: 27/27, 0 failures.
- parity26: 62/62, 0 failures.
- parity25: ALL GREEN (two `php=403 ts=200` lines in its log are
  HTTP-status-only notes, not failures — envelopes compared equal, per
  the seam's always-200 convention).
- Fixtures: 13/13 on PHP and 13/13 on Next, verified via the results
  JSON files (all entries PASS), not just the summary lines.
- parity21: 203 cases, 194 match, 9 diffs — and the diff names are
  exactly the known 9 (`sd_tld_delete`, `sd_tld_delete_used`,
  `sd_tld_delete_notfound`, `sd_reg_available`, `sd_guest_tlds`,
  `sd_guest_tlds_reg`, `sd_guest_tlds_trans`,
  `sh_guest_free_tlds_fallback`, `dl_admin_send_file_missing_stored`),
  no new ones.
- Final reference-DB state: invariants tuple exact (invoice 323,
  client_order 11, email_queue 67, servicedomain_last_sync
  2026-10-26 03:24:56, support_ticket 2, client 3, admin 2,
  admin_group 3, admin_group_member 1, service_downloadable 0);
  setting 38 rows, currency 1 USD, extension_meta 3 rows, extension 6
  rows all `installed` (news restored to its baseline id by the
  snapshot restore). Both servers left up (PHP :8080, Next :3001 on
  the fresh build). Nothing committed, nothing pushed.
