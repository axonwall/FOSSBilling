# Findings — Phase 5 R4c: theme replacements (the intentional divergence)

Branch `feat/nextjs-phase5-r1`, uncommitted. R4 scope decisions D4-1..D4-8
at recommended defaults (see `r4-scope.md`). R4c only: theme endpoint
replacements. NOT in this batch (unchanged): servicecustom plugin
runtime + salt re-key (R4d), per-module proxy removal (R6), the proxy
fallback itself (D4-7, untouched). NO theme UI page in this batch, by
design — R4c is endpoint replacement, and no sidebar route exists
for theme (see §1.4).

## 0. Divergence note (explicit, unhidden — read this first)

**PHP returns N themes; TS returns one by design (D4-3). This is the
ONE intentional divergence in R4.** A consumer calling
`admin/theme/get_list` on PHP sees one entry per theme directory on
disk (the reference install: `default/client` + `default/admin` via
the two lists); on TS it sees exactly one entry, the built-in Next
theme (`code: "next"`), in both `get_list` and `get_admin_list`.
A consumer calling `admin/theme/get` with a PHP theme code
(`default/client`, `default/admin`) gets PHP's entry from PHP and a
9999 not-found from TS. The alternative — returning PHP's theme list
from static data — was rejected as fiction: TS has no theme files,
no presets, no settings system, and no CSS/JS regeneration behind
such a list, and claiming PHP theme names while rendering Tailwind
would be the same fiction for the name. What TS returns instead is
an honest description of what actually renders: the Next UI itself.

## 1. Survey answers (all measured live against the reference install)

### 1.1 The four read shapes

`Theme/Api/Admin.php` + `Theme/Service.php::buildThemeConfig`:

- `get_list` (theme/view): `{list: getThemes(true)}` — client-area
  themes. On the reference: exactly one entry, `default/client`.
- `get_admin_list` (theme/view): `{list: getThemes(false)}` — admin
  themes. On the reference: exactly one entry, `default/admin`.
- `get_current` (theme/view): `getThemeConfig(client, null)` — an
  OBJECT, not a name string. `client` defaults to true (no param →
  client theme); `client=0` → admin theme. Invalid `client` →
  9999 `Invalid "client" parameter.` (probed: `banana`, `2`,
  `maybe` all error; `""`, `1`/`0`, `true`/`false`, `on`/`off`,
  `yes`/`no` all valid per `filter_var` boolean spellings).
- `get` (theme/view, RequiredParams `code`): `loadTheme(code)` —
  the entry object. Missing code → 9999 `Theme code was not
  passed`. Unknown code → 9999 `Theme was not found in path
  <server themes path>/<code>` (probed: the full runtime path is
  embedded in PHP's message).
- A PHP theme entry has exactly 11 keys: `author`, `author_url`,
  `code`, `description`, `hasSettings`, `icon`, `markdown_attributes`,
  `name`, `paths`, `url`, `version`. Manifest keys pass through
  verbatim (client manifest: name `Default (Client Area)`, version
  `1.0.0`, icon `screenshot.jpg`, author `FOSSBilling`, plus a
  CommonMark `markdown_attributes` map); `url` is
  `SYSTEM_URL + "themes/<code>/"`; `paths` are absolute server
  filesystem paths (theme html dir + every installed module's
  templates dir for the area — 21 paths on the reference);
  `hasSettings` is true iff a `config` dir exists under the theme
  (client: true, admin: false — only the client theme ships one).
  One PHP quirk, recorded not mirrored: `get` calls `loadTheme`
  with the default `$client = true`, so even `get(default/admin)`
  carries *client* module template paths.
- Reference theme set: only the `default` package exists on disk
  (`admin`/`client`/`shared` tiers). Settings: `theme =
  default/client`; no `admin_theme` row exists, so PHP's admin
  reads fall back to `default/admin` via `getParamValue`'s default.

### 1.2 Permission keys + non-super outcomes

From `Theme/Api/Admin.php::checkPermissions`: all four reads →
`theme/view`; all three writes → `theme/manage`. Theme declares
`view`, `manage`, and an empty `manage_settings` key in
`getModulePermissions` (the empty key is inert here — no
`hasManagePermission` path exists for theme). Theme IS a core
module (`guards.ts` CORE_MODULES), so the dispatcher activation
gate (715) passes unconditionally — but the dispatcher 725
module-access gate applies to ALL admin modules including core
(`Dispatcher.php`: `hasPermission(identity, mod)` with no core
exemption; TS `enforceDispatcherGates` mirrors it). Measured
outcomes, both stacks agreeing (parity32 §C):
- Support-only persona (support access, no theme key) → 725 on
  every read (module-access gate fires before the method guard).
- Theme-access-no-view persona (`{"theme": {"access": true}}`,
  no `view` key) → passes 725, then 403 `You need the
  "theme.view" permission to perform this action` (method guard).
- Logged-out → 201 on reads (identity gate, before guards).
- Super-admin → the entries.

### 1.3 Write semantics (removal rationales, from the code)

- `select` (theme/manage, RequiredParams `code`, `client`
  required + validated, code must be available for the area):
  writes the system param `theme` (client) or `admin_theme`
  (admin) and clears the theme cache. Nothing to select with
  exactly one built-in theme, and the setting it would write no
  longer drives rendering (Next renders Tailwind, not Twig theme
  directories).
- `preset_delete` (theme/manage, RequiredParams `code` +
  `preset`): deletes a theme settings preset
  (`extension_meta`, extension `mod_theme`, scope `preset`).
- `preset_select` (theme/manage, same params): sets the current
  preset (same `extension_meta` scope). Presets belong to the
  theme settings system, which does not exist in Next.
- CSS/JS regeneration (`regenerateThemeCssAndJsFiles`,
  `regenerateThemeSettingsDataFile`) writes theme asset files
  from settings; in Next, styling is build-time Tailwind — there
  is nothing to regenerate at request time.
- Reads do NOT mutate: `getThemes`/`getThemeConfig`/`loadTheme`
  only read directories, manifests, and setting rows
  (`buildThemeConfig` calls `getCoreAndActiveModules`, a read).
  The one read-path write in the Theme service
  (`getCurrentThemePreset` persisting a default preset) is not
  reachable from any of the four reads. Parity32 §E proves
  no-mutation empirically (see §4).

### 1.4 Navigation: no theme entries exist to drop

`Theme/Controller/Admin.php` declares no `fetchNavigation()`, so
R2a's `get_navigation` emits no theme entries, and the sidebar
route map drops nothing for theme. (Contrast R4b's Languages
subpage, which existed in PHP nav and was dropped for having no
route.) No theme page is invented in R4c.

## 2. What was built

- `apps/nextjs/src/server/modules/theme.ts` (new): the four reads
  + the three removals, registered in `modules/index.ts`.
- `apps/nextjs/src/server/guards.ts`: four `ADMIN_GUARDS` entries
  (each read → `[["theme", "view"]]`).
- `src/app/api/fb/[...path]/route.ts`: gate-skip extended to the
  three removed theme methods (R1/R4a pattern).

### Implemented (admin): `get_list`, `get_admin_list`, `get_current`, `get`
### Removed (R1 pattern, never proxied, error before auth): `select`, `preset_delete`, `preset_select`

### Single-theme entry (every field; PHP-mirrored vs TS-defined)

The entry mirrors PHP's 11 field names with honest values:

| Field | Value | Source |
|---|---|---|
| `code` | `"next"` | TS-defined. Deliberately NOT `default/client` or `default/admin` (see §0). |
| `name` | `"Next"` | TS-defined. |
| `version` | `"0.1.0"` | From `apps/nextjs/package.json` (the app's version, not a theme file's). |
| `description` | `"Built-in Next.js theme"` | TS-defined. |
| `author` | `"FOSSBilling"` | PHP's manifest fallback default (the value PHP uses when a manifest omits author). |
| `author_url` | `"https://www.fossbilling.org/"` | PHP's manifest fallback default. |
| `icon` | `null` | TS-defined. No screenshot file exists for the built-in theme; claiming `screenshot.jpg` would be fiction. |
| `markdown_attributes` | `{}` | TS-defined. No CommonMark class mapping in the Next theme. |
| `url` | `"/"` | TS-defined. The Next app root serves the theme; no `/themes/<code>/` URL exists in Next. |
| `paths` | `[]` | TS-defined. No Twig template paths exist in Next, and PHP's absolute server paths must not be reproduced (they would leak server layout and point at Twig directories Next never renders). |
| `hasSettings` | `false` | TS-defined. No theme settings system exists in Next. |

### Collapses (documented, not hidden)

- `get_list` and `get_admin_list` both return the single entry:
  the Next app has one theme for admin + client alike, so the
  area distinction collapses.
- `get_current` returns the single entry object in PHP's return
  shape. The `client` param is validated exactly as PHP validates
  it (`isInvalidClientParameter` + `normalizeBoolean` semantics:
  null/bool/int/float valid; strings must be `filter_var` boolean
  spellings; arrays/objects invalid → 9999) but ignored for the
  result, since both areas share the one theme.
- `get("next")` returns the entry; any other code — including
  PHP's `default/client` and `default/admin` — returns 9999 with
  a message starting `Theme was not found in path `. PHP embeds
  its server themes path after that prefix; TS names the
  requested code instead (it has no themes dir to name). Parity32
  asserts code + prefix, and pins the TS message exactly.

## 3. Deliberate differences from PHP (documented, not hidden)

1. **One theme vs N** (§0) — the R4 divergence, by design.
2. **Not-found message suffix** (§2): prefix identical, suffix
   differs (server path vs requested code).
3. **Entry field values** (§2 table): same 11 field names, but
   `icon`/`markdown_attributes`/`paths`/`url`/`hasSettings` carry
   honest Next values instead of PHP's file-derived ones.
4. **Inherited seam conventions**: TS error envelopes are always
   HTTP 200 (PHP answers 4xx with the same envelope — compared
   as envelopes, never status). R2a params-vs-guard precedence
   stands (a call both param-invalid AND method-denied gets the
   param error from PHP but the 403 from TS; parity32's
   permission cases use valid params, as R2a's did).

## 4. Verification

- `capture35.py` + `captures35/` (10 files): PHP `get_list`,
  `get_admin_list`, `get_current` (client, admin, invalid),
  `get` (client, admin, unknown, missing), and baselines
  (theme/admin_theme rows, extension row set, extension_meta
  keys, invariants tuple). No PHP writes were captured — `select`
  / `preset_*` mutate and are never called on PHP.
- `parity32.py`: **65 checks, 0 failures** (final run; see §5 for
  the two first-run failures, both suite bugs, not code). Sections
  are structurally separated:
  - §B TS-SHAPE (TS only): exact dict equality of all four reads
    against the documented entry; both lists single-entry and
    identical; `get_current` across 10 urlencoded client spellings
    (none, 1, 0, true, false, on, off, yes, no, "") + 5 JSON-body
    client values (true, false, 1, 0, 2) + an invalid JSON array
    case. Exact equality IS the seam-serving proof: had the route
    proxied to PHP, these would return `default/*` entries.
  - §C PHP-EQUIVALENT (both stacks): missing code, invalid
    client (`banana`, `2`, `maybe`), unknown codes
    (`nosuchtheme`, `huraga`) by code + message prefix, the
    PHP-existing-code divergence cases (`default/client`,
    `default/admin`: PHP serves, TS 9999 — pinned, not hidden),
    support-only 725s, theme-access-no-view 403s, logged-out 201.
  - §D removals (TS only): all three writes as super-admin AND
    logged-out (proving the gate skip).
  - §E no-mutation proof: non-persona invariants, theme settings,
    and extension_meta keys unchanged after the read sections;
    admin tables differ by exactly the 2 crafted personas
    (2 staff + 2 groups + 2 memberships) and nothing else.
  - §F secret scan: recursive key scan (`password`, `passwd`,
    `api_token`, `secret`, `salt`, `private_key`, `webhook`,
    `smtp`, `captcha`) over captured envelopes → no hits.
  - §G restore proof: full-DB snapshot restore in `finally`;
    invariants, extension rows, meta keys, and theme settings
    identical to §A afterwards.
- Gates: `npx tsc --noEmit` clean; `npm run build` clean (exit
  0); new code confirmed in the production bundle by
  string-literal grep (theme description + preset method names
  in the built chunks; the removal message itself is a template
  literal, so the method names are the grep target).
- Regression: parity31 63/63, parity30 179/179, parity29 62/62,
  parity28 128/128, parity27 27/27, parity26 62/62, parity25
  203/203; fixtures 13/13 on PHP and 13/13 on Next, verified via
  the results JSON files (all entries PASS), not just the
  summary lines; parity21 203 cases, 194 match, 9 diffs — and
  the diff names are exactly the known 9 (`sd_tld_delete`,
  `sd_tld_delete_used`, `sd_tld_delete_notfound`,
  `sd_reg_available`, `sd_guest_tlds`, `sd_guest_tlds_reg`,
  `sd_guest_tlds_trans`, `sh_guest_free_tlds_fallback`,
  `dl_admin_send_file_missing_stored`), no new ones.
- Final reference-DB state: invariants tuple exact (invoice 323,
  client_order 11, email_queue 67, servicedomain_last_sync
  2026-10-26 03:24:56, support_ticket 2, client 3, admin 2,
  admin_group 3, admin_group_member 1, service_downloadable 0);
  setting 38 rows, currency 1 USD, extension_meta 3 rows,
  extension 6 rows all `installed`; `theme = default/client`,
  no `admin_theme` row (baseline). Both servers left up (PHP
  :8080, Next :3001 on the fresh build with the 35-module list).
  Nothing committed, nothing pushed.

## 5. Failures found and fixed during this batch (honest account)

Both first-run failures were suite bugs, not code bugs:

1. **PHP-existing codes in the unknown-code loop.** The first
   parity32 run crashed on `get(default/client)`: PHP *serves*
   that code, so its envelope has `error: null` and the
   unknown-code assertion dereferenced null. Fixed by splitting
   the loop: truly-unknown codes (`nosuchtheme`, `huraga`) keep
   the code + prefix equivalence; PHP-existing codes
   (`default/client`, `default/admin`) became explicit
   divergence cases (PHP serves, TS 9999). Lesson: an
   "unknown" set must be unknown on *both* stacks.
2. **Invariants tuple vs crafted personas.** The first full run
   failed only `nomutation-invariants`: admin/admin_group/
   admin_group_member counts differed by exactly the 2 crafted
   personas (4/5/3 vs baseline 2/3/1) — because §E runs before
   the finally-restore removes them. Fixed by comparing the 10
   non-persona elements plus an exact assertion that the persona
   tables differ by precisely the crafts. Lesson: a no-mutation
   check must carve out its own deliberate mutations.

## 6. Left unverified / standing items

- No UI in R4c, so no browser click-through applies.
- The `client` param's PHP `filter_var` edge (leading/trailing
  whitespace in a boolean spelling) is unprobed on PHP; TS does
  not trim, matching the no-trim reading of `filter_var` — a
  whitespace-padded spelling would need a live PHP probe to
  settle, and no parity case depends on it.
- Live Postgres behavior of the new handlers (R3c's job; the
  handlers touch no DB at all — the entry is a constant).
- R4d remains, with its own parity suite (33). Then the push of
  the stack — a separate tap, not taken.
