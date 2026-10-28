# Phase 5 R4 scope — in-tree TS module registry + theme deletion (DRAFT, awaiting approval)

R4 is the Phase 5 extension-system workstream (plan.md §R4, decision
D5-5): the in-tree TS module registry becomes the ONLY extension
mechanism. No manifest loading, no PHP module code, no theme uploads,
no remote downloads. It also closes the three endpoint groups R1
deferred here: theme 7, extension remainder, servicecustom call/__call
— plus the extension UI deferred from R2e. R4 changes the extension
MODEL (what an extension is, how it is listed, activated, and
configured). It does NOT change traffic routing: per-module proxy
removal is R6, and the proxy fallback stays untouched throughout R4.

## 0. Survey findings (measured 2026-10-28, before scoping)

Endpoint inventory (from `api-catalog.json`, 579 endpoints):

- **Theme: 7 admin endpoints, none ported** (no `theme.ts` in TS):
  `get_list`, `get_admin_list`, `get_current`, `get`, `select`,
  `preset_delete`, `preset_select`. PHP's Theme Service manages theme
  presets, theme settings, and CSS/JS regeneration for admin + client
  themes. TS has only incidental "theme" word matches (widgets, page,
  permission-catalog) — there is no TS theme code to delete; "theme
  deletion" is endpoint replacement, not a code sweep.
- **Extension: 17 endpoints, 15 remaining.** 14 admin + 3 guest. TS
  already serves `config_get` (Phase 4) and `get_navigation` (R2a).
  Remaining: admin `get_list`, `get_latest`, `get_extension_readme`,
  `languages`, `toggle_language`, `locale_completion`, `update`,
  `activate`, `deactivate`, `uninstall`, `install`, `config_save`
  (12) + guest `is_on`, `settings`, `languages` (3).
- **Servicecustom: 2 deferred** (admin `__call` magic, client `call`;
  `update` is already ported). PHP's plugin runtime (`Service.php`
  `customCall`/`callOnAdapter`): empty plugin → null; missing plugin
  file → log + null (3124 only in the debug log, never thrown);
  forbidden methods → 403 (`delete`, `cancel`, `uncancel`,
  `suspend`, `unsuspend`, `renew`, `activate`); adapter method
  missing → 3125 (`Plugin :plugin does not support action
  :action`); admin `__call` requires `manage` permission,
  arguments present (7103 if missing), `order_id` required;
  client `call` requires `order_id` + `method` and enforces
  ownership via `getServiceCustomByOrderId(orderId, clientId)`.
  No shipped servicecustom plugin adapters exist in-tree (plugins
  are operator-provided PHP files under `Plugin/`); Servicelicense's
  `Plugin/` directory is a different mechanism.
- **Activation already has teeth in TS.** The R2a dispatcher gate
  (`guards.ts` `isModuleActive`) passes CORE_MODULES unconditionally
  (theme is core) and otherwise requires an `extension` row with
  `type='mod'`, `name=<module>`, `status='installed'`. Reference DB
  holds 6 such rows (news, branding, redirect, custompages,
  massmailer, notification — all `installed`). So R4a's
  activate/deactivate toggle a value the existing gate already
  enforces; no gate change is needed.
- **PHP install is a remote download** (`downloadAndExtract`), and
  uninstall removes files from disk (core modules already refuse:
  "Core modules are an integral part of the FOSSBilling system and
  cannot be uninstalled"). Both operations are meaningless for
  in-tree code — this is why they become explicit errors, not
  ports (see D4-2).
- **PHP manifests exist per module** (`src/modules/*/manifest.json`).
  The TS registry's metadata (id, name, version, type, hasConfig)
  is derived from these + the TS module list during R4a.
- **Encrypted columns are exactly two** (R3b survey, verified):
  `extension_meta.meta_value` and `email_template.vars`, both
  decrypted with `info.salt` via `crypt.ts`. `config_get` today
  returns `{ext}` for any config it cannot decrypt (plan.md's
  "real secret store" gap).

## 1. Architecture

- **Registry:** a TS module declaring every in-tree module's
  metadata (id, name, version, type, hasConfig) — the single source
  for `get_list`, activation eligibility, guest `settings`
  (core-or-installed), and the R4b UI. It replaces PHP manifest
  loading; it does not load code (modules are statically imported
  by `modules/index.ts` exactly as today).
- **Activation model:** `extension.status` toggles between
  `'installed'` (gate passes) and PHP's deactivated value (gate
  fails) — R4a surveys the exact deactivated value from
  `Extension/Service.php::deactivate()` before implementing, since
  the gate keys on `'installed'`.
- **Config model:** `config_get` (exists) + `config_save` (R4a),
  encrypted at rest with `info.salt` via `crypt.ts`, `public`
  subset exposed via guest `settings` for core-or-installed
  modules, `[]` otherwise — mirroring PHP exactly.
- **Plugin model:** a TS plugin registry (name → adapter object
  with action methods), shipping EMPTY (D4-4). Operators register
  in-tree adapters; the dispatch + error semantics are PHP's.
- **Theme model:** one built-in theme (the Next UI itself). Reads
  describe it; writes that assumed a theme system return explicit
  errors (D4-3).

## 2. Batches (order R4a → R4b → R4c → R4d)

### R4a — Registry + extension API

- Registry module + `get_list` (registry × DB status), `activate`,
  `deactivate` (PHP permission + status semantics as surveyed,
  including core-module rules), `config_save` (encrypted, mirroring
  `config_get`), guest `is_on` + `settings`.
- Explicit removal errors (R1-deletion style, never proxied) for:
  `install`, `uninstall`, `update`, `get_latest`,
  `get_extension_readme`, `languages`, `toggle_language`,
  `locale_completion`, guest `languages` (9 endpoints). Rationale
  per endpoint in findings-r4a.md: remote downloads, file removal,
  remote directory listings, and translation-file management have
  no meaning without external code or an i18n system (localization
  is R5's).
- R4a survey-first items (facts, not decisions): exact deactivated
  status value; activate error shape for unknown names; permission
  keys per endpoint from PHP's `checkPermissions` calls;
  `config_save` validation/encryption shape.
- Deliverable: endpoints served + parity30 (endpoint equivalence,
  activation gating proven both directions — deactivate a module
  → its endpoints 715, reactivate → served again — config_save
  round-trip incl. encrypted values, guest is_on/settings).

### R4b — Extension UI (the R2e deferral)

- `/admin/extensions` list + detail/config pages (from `get_list` /
  `config_get` / `config_save`) + activate/deactivate actions.
  Sidebar extensions section via the route map (PHP nav group
  1000 exists; R2a's `get_navigation` already emits it).
- NO install/upload UI: installing external code is abolished
  with remote installs (D4-6). The UI manages in-tree modules
  only, and says so.
- Deliverable: pages + parity31 (page smoke: 200 as admin,
  login chrome logged out, activation actions through the
  page's mutation path, no install/upload affordance present).

### R4c — Theme replacements (the intentional divergence)

- Reads return the single built-in Next theme: `get_list`,
  `get_admin_list`, `get_current`, `get` all describe it
  (name/version from the app, not from theme files).
- Writes return explicit removal errors: `select`,
  `preset_delete`, `preset_select` (no theme system to select
  presets in).
- This is the ONE place R4 intentionally diverges from PHP
  (PHP returns N themes; TS returns one), documented as such —
  not hidden behind a parity comparison. parity32 asserts the
  documented single-theme shape + the removal errors, and names
  the divergence in findings.
- Deliverable: endpoints + parity32 + divergence note.

### R4d — Servicecustom plugin runtime + salt re-key tool

- Plugin registry + admin `__call` + client `call` with PHP's
  exact semantics: permission (`manage`) / ownership, 7103
  missing arguments, `order_id`/`method` required, forbidden 7 →
  403, empty/missing plugin → null (logged), unsupported action
  → 3125. Registry ships empty; a `servicecustom` product with a
  plugin field and no registered adapter gets null (PHP's
  missing-plugin behavior), documented.
- Salt re-key tool (script, importer precedent): decrypt both
  encrypted columns with the OLD salt, encrypt with the NEW salt,
  verify round-trip on a sample, refuse on any failure. Operator
  steps documented (backup first, run, verify, then switch the
  env salt). This closes the R3b-deferred re-key item; the full
  secret store (vault/KMS) is out of scope (D4-5).
- Deliverable: runtime + tool + parity33 (dispatch semantics incl.
  all 7 forbidden methods, missing-plugin null, 3125, ownership
  rejection; re-key proven both directions on crafted encrypted
  rows + refusal on wrong old salt).

## 3. Decisions (D4-1..D4-8, recommended defaults)

- **D4-1 — Batch order R4a → R4b → R4c → R4d.** Recommended
  default. Registry first (UI + plugin runtime build on registry
  concepts); theme and plugin runtime are independent of each
  other and follow.
- **D4-2 — Extension split: implement 6, explicitly remove 9.**
  Implement: `get_list`, `activate`, `deactivate`, `config_save`,
  guest `is_on`, guest `settings` (plus existing `config_get`,
  `get_navigation`). Remove with explicit errors: `install`,
  `uninstall`, `update`, `get_latest`, `get_extension_readme`,
  `languages`, `toggle_language`, `locale_completion`, guest
  `languages`. Recommended default. Rationale: the implemented
  six manage in-tree code and its config; the removed nine manage
  external code, remote directories, or translation files — all
  abolished by the in-tree model or owned by R5 (localization).
- **D4-3 — Theme: reads return the single Next theme, writes
  error.** Recommended default. The divergence from PHP is
  intentional and documented (see R4c). Alternative (return
  PHP's theme list from static data) rejected: it would be
  fiction — TS has no theme files, presets, or settings system
  behind it.
- **D4-4 — Plugin registry ships EMPTY.** Recommended default.
  No built-in adapters; operators register in-tree adapters at
  the documented point. Alternative (port a "default" adapter)
  rejected: no adapter ships in-tree today, and inventing one
  would change servicecustom product behavior.
- **D4-5 — Salt re-key tool in R4d; full secret store OUT.**
  Recommended default. The tool closes the R3b-deferred item
  with an operator-managed env salt as the documented model.
  Vault/KMS integration is a separate, larger decision — not
  smuggled into R4.
- **D4-6 — Extension UI manages in-tree modules only; no
  install/upload UI.** Recommended default, following D4-2.
- **D4-7 — Proxy fallback untouched.** Recommended default. R4
  changes the extension model, not routing. Per-module proxy
  removal and PHP deletion stay R6's; R4 must not remove the
  fallback early (that would strand the still-proxied modules).
- **D4-8 — Verification standard per batch (same discipline as
  R1–R3).** `tsc` + `next build` clean; new parity suite per
  batch (parity30/31/32/33); all prior suites green (parity25–29);
  parity21 at exactly the known 9; fixtures 13/13 both; DB
  invariants clean before AND after (incl. extension rows and
  the two encrypted columns' row counts). No PHP source changes;
  no commit/push without a separate tap.

## 4. Explicitly NOT in R4

- Per-module proxy removal / PHP deletion (R6).
- Full secret store, vault/KMS integration (out; env salt is the
  model — see D4-5).
- Localization / translation system (R5 installer owns locale;
  hence the language-endpoint removals in D4-2).
- R5 installer, cron completion, email transport, rate limiter.
- New plugin adapters beyond the empty registry (operators add
  their own in-tree adapters at the documented point).
- Non-0.8.9 sources; multi-tenant or sharded targets.
- Live gateway re-verification (unchanged standing items).

## 5. Verification standard (per batch, same discipline as R1–R3)

- `tsc` + `next build` clean; new code landed (grep string
  literals, not minified function names).
- R4a gate: parity30 green (endpoint equivalence + both
  directions of activation gating + config round-trip +
  guest cases); extension rows restored after gating cases
  (deactivate/reactivate in finally).
- R4b gate: parity31 page smoke green; no install/upload
  affordance in the rendered UI (asserted, not assumed).
- R4c gate: parity32 green on the documented single-theme
  shape + removal errors; divergence note in findings.
- R4d gate: parity33 green (all dispatch semantics + re-key
  both directions + wrong-salt refusal); crafted encrypted
  rows (a vacuous re-key check proves nothing — R2e lesson).
- Every batch: parity25–29 green, parity21 at the known 9,
  fixtures 13/13 both, invariants clean. No PHP changes.
