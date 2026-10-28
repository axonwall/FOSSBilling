# Findings — Phase 5 R4b: extension UI

Branch `feat/nextjs-phase5-r1`, uncommitted. R4 scope decisions D4-1..D4-8
at recommended defaults (see `r4-scope.md`). R4b only: extension list +
detail/config pages + sidebar section. NOT in this batch (unchanged):
theme (R4c), servicecustom plugin runtime + salt re-key (R4d),
per-module proxy removal (R6). NO install/upload UI anywhere, by design
(D4-6) — asserted in parity31, not assumed.

## 1. What was built

- `apps/nextjs/src/app/(admin)/admin/extensions/page.tsx` — list page
  (server component): merged `get_list` reads (see §2), table of name
  (+ description), version, status (Core / Installed / Available),
  and per-row actions. Carries the in-tree-only note (see §2).
- `apps/nextjs/src/app/(admin)/admin/extensions/[id]/page.tsx` —
  detail page (server component): metadata (status, version, author,
  license, description), actions, and the config section. Unknown id
  renders an error box, never a crash. Logged-out visitors get the
  sign-in link box (R2e pattern) — this was a real bug caught during
  the build: the first draft gated the link on `!error`, which hid it
  exactly when logged out (the read fails with 201 first); fixed to
  show the link whenever there is no admin session.
- `ExtensionActions.tsx` (client component) — Activate / Deactivate
  buttons via `fbPost` (urlencoded id/type, the established mutation
  path). Buttons hide actions the page already knows are
  inapplicable: core modules get no Deactivate button (they have no
  extension row, so the seam would answer 'Extension not found'),
  available modules get Activate only, installed get Deactivate only.
  The seam (extension/manage_extensions) enforces regardless.
- `ConfigForm.tsx` (client component) — full-config JSON editor (see
  §3). `fbPostJson` added to `lib/browser.ts`: a JSON-body post with
  CSRF priming, the only correct shape for `config_save` (see §3).
- `lib/fossbilling.ts` — `adminApi.extensionGetList` +
  `extensionConfigGet` wrappers (fbCall to PHP, the page-read pattern).
- `app/(admin)/layout.tsx` — `extension: "/admin/extensions"` added
  to `NEXT_ROUTES` (route-map approach). The Extensions group's
  Overview subpage (path `extension`) maps here; the Languages subpage
  has no route, so the filter drops it (it is a removed endpoint
  anyway). The section renders only with extension module access:
  the nav builder skips modules the caller may not access, so the
  gating is the builder's own, fail-closed (R2d Staff-section pattern).
  Verified: super and extension-view-only personas see the link;
  support-only does not.

## 2. Read-path decision (explicit, as the brief required)

Pages read via `fbCall` to the PHP origin — the established R2 page-read
pattern, so PHP's guards apply on reads — then filter in-process to
the TS registry (`REGISTRY_BY_ID`). The filter is the hard constraint:
PHP's `get_list` includes modules the TS seam cannot manage (branding
installed; embed available; api/orderbutton/theme core), and the UI
manages in-tree modules ONLY (D4-6). Filtering on the page guarantees
no action button is ever offered for a PHP-only module. PHP-only
installed modules are not silently absent: the list page carries a
one-line note naming the situation ("Modules installed from PHP that
have no Next.js port (for example branding) are not shown here and
cannot be activated, deactivated, or configured from this page").

No single `get_list` mode covers all three states, so both pages merge
two calls: `active=1` (core + installed) then default (installed +
available), deduplicated by id. The detail page finds its entry in the
merged list; a missing entry is the unknown-id error box.

## 3. Config editor shape (the batch's main hazard)

`config_save` is FULL-REPLACE: PHP `setConfig` stores the entire
`$data` (R4a findings §Q5). A field-subset editor would DELETE every
unshown key on save — including nested values and any secret a module
stores in config. The editor is therefore a full-config JSON textarea:

- The textarea holds the complete config object (minus the `ext` row
  key, which is metadata: the detail page strips it for display, the
  save re-adds it, so the row key cannot drift if the user edits text).
- The save posts the parsed object as a JSON body via `fbPostJson`,
  reaching the seam as `rawParams` with real types. A urlencoded post
  would stringify numbers, booleans, nested objects and arrays and
  corrupt value types — this is why `fbPost` (urlencoded-only) could
  not be reused for the save.
- Invalid JSON is rejected in the browser and never posted. On the
  server side, an invalid JSON body fails the route's `JSON.parse`
  before dispatch, so the seam writes nothing — proven by parity31
  (rejected save leaves the stored config byte-identical in effect:
  `config_get` afterwards returns the crafted config unchanged).
- After a successful save the form keeps showing the saved text
  rather than re-reading: PHP's `getConfig` caches for up to an hour,
  so a re-read through PHP could show the pre-save value (R4a
  findings §3.5). The saved text IS the new value; re-reading would
  risk displaying stale data.
- The editor appears only for modules that declare a settings page
  (`has_settings` from PHP's render). Other modules get an explanatory
  note. This matches PHP's settings-page concept and avoids showing
  an editor that the seam would always reject (for example news,
  which declares no `manage_settings` key, gets the
  identity-independent 403 from `config_get` even for the super-admin
  — captured in captures34/04). A config read that fails for a
  settings module renders its message inline instead of the form, so
  seam enforcement stays visible rather than hidden.

## 4. Deliberate omissions

- NO install/upload UI anywhere: no button, link, or form for them on
  list or detail. Installing external code is abolished with remote
  installs (D4-6). The list page says so in its note. Parity31
  asserts: no `>Install<` / `>Upload<` button labels, no href
  containing install/upload. (The note itself contains the lowercase
  words "install"/"upload", so the assertions target affordances —
  button labels and hrefs — not the words.)
- No product-style create/edit flows: extensions are not created
  through the UI; activation of an available in-tree module IS its
  creation path (the seam inserts the row).
- No sidebar Services-style section invention: the Extensions section
  comes from PHP's real nav group 1000 via the route map.
- No browser click-through: forms are proven at the fbPost/fbPostJson
  → seam path + page rendering, as R2d/R2e were. Client-side
  invalid-JSON rejection (the browser half of the rejected-save proof)
  is therefore documented, not proven — the server half IS proven
  (parity31 section D).

## 5. Verification

- `capture34.py` + `captures34/` (5 files): PHP `get_list` active +
  default (the pages' merged reads), `config_get` for mod_support
  (no row → `{ext}`) and mod_news (identity-independent 403), and
  extension / extension_meta baselines. No secrets captured.
- `parity31.py`: **63 checks, 0 failures** (final run; see §6 for the
  first run's single failure, which was a wrong expectation in the
  test, not the code). Covers: list smoke (known rows + statuses,
  in-tree note, no branding/embed detail hrefs, no install/upload
  affordances, sidebar link); detail support (metadata + config form
  + save button + textarea, no Deactivate for core); detail news
  (no-settings note + Deactivate, no save button); unknown id error
  box; logged-out sign-in boxes (list + detail, no table/form);
  news deactivate/reactivate through the UI's fbPost path with gating
  proven both directions on both stacks (715 + is_on false, then
  served + is_on true); mod_support config round-trip through the
  page's JSON save path (nested objects + arrays + numbers/booleans,
  read back via config_get on BOTH stacks with parsed equality, DB
  check for the `v2:` prefix and absence of the plaintext flag);
  rejected-save proof (invalid JSON errors, stored config unchanged);
  view-only persona (reads list + detail, sidebar link present,
  inline 403 on support config, seam 403 on activate with
  manage_extensions and on config_save with the support-module
  message); support-only persona (725 boxes on list + detail, no
  rows, no sidebar Extensions link, seam 725 on direct get_list).
- Secret audit: recursive key scan (`password`, `passwd`, `api_token`,
  `secret`, `salt`, `private_key`, `webhook`, `smtp`, `captcha`) over
  every config envelope in parity31 → no hits. All config test values
  are benign flags (`parity31-benign`, nested `{n: 3, ok: true,
  tags: [a, b]}`, `nums: [1, 2.5]`); no real config values are pasted
  in this document.
- Restore proof: full-DB snapshot restore in `finally`; invariants
  clean before AND after; extension rows verified restored as a set
  (6 rows, all `installed`, baseline names); extension_meta keys back
  to baseline (3); PHP app cache cleared in finally.
- Gates: `npx tsc --noEmit` clean; `npm run build` clean (exit 0);
  new page strings confirmed in the production bundle by
  string-literal grep (page text is not minified away, verified
  anyway: the in-tree note and the no-settings note both land in the
  built page chunks).
- Regression: parity30 179/179, parity29 62/62, parity28 128/128,
  parity27 27/27, parity26 62/62, parity25 ALL GREEN; fixtures 13/13
  on PHP and 13/13 on Next, verified via the results JSON files (all
  entries PASS), not just the summary lines; parity21 203 cases, 194
  match, 9 diffs — and the diff names are exactly the known 9
  (`sd_tld_delete`, `sd_tld_delete_used`, `sd_tld_delete_notfound`,
  `sd_reg_available`, `sd_guest_tlds`, `sd_guest_tlds_reg`,
  `sd_guest_tlds_trans`, `sh_guest_free_tlds_fallback`,
  `dl_admin_send_file_missing_stored`), no new ones.
- Final reference-DB state: invariants tuple exact (invoice 323,
  client_order 11, email_queue 67, servicedomain_last_sync
  2026-10-26 03:24:56, support_ticket 2, client 3, admin 2,
  admin_group 3, admin_group_member 1, service_downloadable 0);
  setting 38 rows, currency 1 USD, extension_meta 3 rows, extension 6
  rows all `installed`. Both servers left up (PHP :8080, Next :3001
  on the fresh build). Nothing committed, nothing pushed.

## 6. Failures found and fixed during this batch (honest account)

1. **Detail-page sign-in link bug (real, fixed in the page).** The
   first draft showed the sign-in link only when `!session?.admin &&
   !error`. Logged out, the read fails with 201 first, so `error` is
   set and the link was hidden — exactly the case that needs it.
   Fixed to show the link whenever there is no admin session.
2. **parity31's Mass Mailer expectation (test bug, not code).** First
   run: 62/63, failing only `list-row-massmailer`. The page renders
   the manifest name "Mass Mail Tool"; the test expected "Mass
   Mailer". Fixed the expectation; re-run 63/63. Lesson from R4a
   holds: trust the manifest + live render, not the module id.
3. **Fixture-run discipline (my own, caught before it mattered).**
   The first fixture invocation in the R4a verification was a bare
   run (0 fixtures, vacuous); this batch ran both stacks with
   `--stack` + fixture files from the start and verified via the
   results JSONs, including waiting for the Next summary line before
   trusting the Next JSON (it is stale until the run finishes).

## 7. Left unverified / standing items

- Browser click-through of the new pages (no live browser in the
  worker): forms proven at the fbPost/fbPostJson → seam path + page
  rendering, as R2d/R2e were. Client-side invalid-JSON rejection is
  browser code; the server half of the rejected-save proof is proven.
- The detail page's config section for a settings module whose caller
  lacks `manage_settings` shows the seam error inline (proven for the
  view-only persona on support); no other settings module was
  exercised in the UI.
- Live Postgres behavior of the new pages (R3c's job; the pages read
  through the same seam + PHP origin as everything else).
- R4c/R4d remain, each with its own parity suite (32/33).
