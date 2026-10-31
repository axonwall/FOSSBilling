# Findings — R6c: relocation + deletion (DRAFT, updated through the steps)

Branch `feat/nextjs-phase5-r1`, tip 51abaf1 (R6b). R6 scope approved
D6-1..D6-10. Safety order followed exactly: §1 survey → §2 relocate
→ §3 independence gate (WITHOUT deleting) → §4 delete → §5 prove
with src/ gone. This doc is written before any deletion and updated
through each step; it is the record if the batch is interrupted.

## 1. Step 1 inventory — EVERY consumer of fork src/ (survey, no deletions yet)

### 1.1 TS server code reads (apps/nextjs/src)

| Site | Reads | Behavior if src/ disappears (before R6c) |
|---|---|---|
| `server/geoip.ts:59-67` (`resolveGeoipDir`) | `FB_GEOIP_DB_DIR`, else `$FOSSBILLING_PHP_SRC/library/FOSSBilling/GeoIP/Databases/` | `ip_lookup` fails with the explicit missing-file error |
| `server/modules/security.ts:107-127` (`isPreviewVersion`) | `$FOSSBILLING_PHP_SRC/library/FOSSBilling/Version.php`, regex `VERSION = '…'` | Degraded-safe: unreadable → preview = true (conservative warn); `generalCheck` still runs. ONLY reader of Version.php in TS code. |
| `server/emailDefaults.ts:34` (`phpModulesDir`) | `FOSSBILLING_PHP_SRC`, else `join(process.cwd(), "..", "..", "src")` — i.e. defaults to the fork tree even with NO env var | Template defaults break silently: new templates fall back to a disabled custom record; built-in row sync stops syncing. Largest silent dependency. |
| `server/modules/page.ts:32-50` (`get_pairs`) | `FOSSBILLING_PHP_SRC` (or empty → no dirs): `themes/<theme>/html` + `modules/Page/templates/client`, `mod_page_*.html.twig` | Degraded: no env → dirs = [] → returns `{}` (empty pairs, no error) |
| `server/modules/servicelicense.ts:148` (`plugin_get_pairs`) | `FOSSBILLING_PHP_SRC/modules/Servicelicense/Plugin/*.php` | Degraded: missing dir caught → returns `[]` |
| `server/config-store.ts:79-85` (`resolveConfigPath`) | `FB_CONFIG_PATH` > `dirname(dirname(FB_DATABASE_PATH))/config.php` > `$FOSSBILLING_PHP_SRC/config.php` | Only breaks deployments relying on the third fallback |
| `server/modules/invoice.ts:1431,1433` | Builds URL strings `${www}public/gateways/custom/...` | NOT a filesystem read: the URL points at the web root's public dir. No Next filesystem consumer of src/public exists (verified by grep: no other `src/public` path reads in apps/nextjs/src). Deployment note (§2): custom logo URLs 404 unless the deployment serves the install's public dir — R6d note, not an R6c blocker. |

NOT consumers (checked): `FB_DATABASE_PATH`/`FB_DATABASE_URL`
(the database itself); cron finalization state (install-root data
dir); order/servicedownloadable uploads dirs (next to the DB file);
update-finalization state + lock files (install root);
`next.config.ts` (pure Next build — one comment mentioning
src/lib, no path read); `src/locale/` files (TS reads config locale
values, never locale files — verified by grep); `apps/nextjs/public`
does not exist (no static dir to confuse with src/public).

### 1.2 Installer + installer-test (apps/nextjs/scripts)

| Site | Reads | R6c disposition |
|---|---|---|
| `scripts/install.ts:219,245-247` (`defaultContentSqlPath`) | `FB_INSTALL_CONTENT_SQL`, else `$FOSSBILLING_PHP_SRC/install/sql/content.sql`; FAILS if neither | Repoint default at vendored content.sql (§2a); `FB_INSTALL_CONTENT_SQL` override kept; `FOSSBILLING_PHP_SRC` no longer consulted |
| `scripts/install.ts:253,412` (`defaultGeoipSource`, copy step) | `FOSSBILLING_PHP_SRC/library/FOSSBilling/GeoIP/Databases` as GeoIP source; `--geoip-source` override; warns, never fails | Repoint default source at vendored geoip dir (§2e); `--geoip-source` override kept; copy step + reported `FB_GEOIP_DB_DIR` value unchanged |
| `scripts/installer-test.mjs:41` (`PHP`) | `~/scratch/bin/php` (static build OUTSIDE the repo) | SURVIVES deletion unchanged — the php CLI cross-check does NOT need repo src/ |
| `scripts/installer-test.mjs:42,63` (`PHPSRC`) | `REPO/src`, passed as `FOSSBILLING_PHP_SRC` to installer runs | DROP the env (installer uses vendored default); the php CLI cross-check (B28) is KEPT (it proves TS↔PHP config agreement via the binary + a WORK-dir probe file + a WORK-dir config — no src/ dependence) |
| `scripts/installer-test.mjs:520` | Reads `PHPSRC/install/sql/content.sql` directly for the pg-mem seed test | REPOINT at vendored content.sql |

### 1.3 Harness, fixture runner, parity suites

| Tool | Repo-src/ dependence | R6c disposition |
|---|---|---|
| `shadow-harness.py:342` (R6b harness, disposable TS env) | Passes `FOSSBILLING_PHP_SRC = REPO/src` to the disposable TS instance. Its disposable PHP comes from `RUNTIME_SRC` (~/scratch/fossbilling/runtime/src), NOT repo src/ — verified (lines 116, 283-286). | DROP the env var (vendored defaults cover templates/geoip/pairs); prove parity45 still passes in the chain. No repoint at runtime/ needed — the TS instance never needed the PHP tree, only the vendored content. |
| `run-fixtures.py` (fixture runner) | Disposable PHP from `RUNTIME_SRC` (lines 28, 62-67). `start_next()` env (259-271) does NOT set `FOSSBILLING_PHP_SRC` — it inherits the shell env. The fixture next server reads repo src/ ONLY via emailDefaults' cwd default (`../../src`) when the var is unset. | NO runner change needed: after relocation, the vendored default makes fixture next servers PHP-tree-independent automatically. (The dead `FOSSBILLING_URL` var it passes is R6a-era noise, harmless.) |
| `parity36.py:128` | Reads a template file DIRECTLY from repo src/ (`.../Support/templates/email/mod_support_ticket_staff_close.html.twig`) | REPOINT at vendored template path |
| `parity42.py:247` (`real_db`) | Symlinks `CC0-Country.mmdb` DIRECTLY from repo src/ GeoIP dir into the country-only test dir | REPOINT at vendored geoip dir |
| `parity43.py:126` (installer-test env), `:196` (geoip probe env), `:C4` | Passes `FOSSBILLING_PHP_SRC` to installer-test; C4 asserts geoip default resolution == PHP-tree path | DROP the B env (installer uses vendored default); UPDATE C4 to assert the vendored default (old-assertion update WITH evidence: the relocation itself — the old assertion pins the old default, which R6c deliberately changes) |
| `parity37.py:245`, `parity40.py:202`, `parity41.py:289`, `parity42.py:148`, `parity44.py:259` | Pass `FOSSBILLING_PHP_SRC` to TS instances | LEFT as harmless dead vars (see §2 override rule: env override applies ONLY if the directory exists; a deleted path falls through to vendored defaults). The independence proof (fresh :3001 WITHOUT the var + parity46 fresh instance WITHOUT the var) is what proves independence, not scrubbing every legacy env. |
| Capture scripts (capture44-48) | Run against the :8080 oracle (runtime/) and read TS code; capture46's phpddl-data generation ran PHP against repo src/ | HISTORICAL records: outputs (captures) persist; the scripts are not rerunnable post-deletion except via `git show <parent>:src/...`. Noted, not fixed — captures are evidence, not tooling. |

### 1.4 Repo tree pieces (for the deletion list)

| Piece | Size / contents | Consumers | Fate (see §2 for reasoning) |
|---|---|---|---|
| `src/` (whole tree) | 28 MB: modules/ 11 MB (39 modules + index.html), library/ 17 MB (GeoIP DBs 15.3 MB + ~1 MB core/adapters), themes/ 548 KB, public/ 180 KB, install/ 184 KB, data/ 16 KB (runtime-dir structure), locale/ 8 KB, top-level entry points | §1.1–1.3 above; upstream CI; root Dockerfile | DELETE (with the vendored extractions of §2) |
| `tests/` (Pest suite) | 1.3 MB, 124 files, PHP-only, tests PHP code | None in TS product | DELETE (see §2i) |
| `tools/demo-seed/` | README + demo-seed.php + 2 fixture files; HTTP-only API client (APP_URL + TEST_API_KEY, no src/ reads — verified by grep) | None in TS product; usable against ANY API incl. TS | RETAIN (see §2j) |
| `frontend/` | Core browser assets + theme build tooling | Root package.json build scripts + Dockerfile frontend-assets stage + PHP themes — ALL deleted/dead post-cutover; NO Next consumer (verified: only static copy strings mention "frontend" in apps/nextjs) | DELETE (see §2j) |
| Root `package.json` / `tsconfig.json` | Theme-build workspace (workspaces: src/themes/default/{client,admin}; scripts build/build-core/build-themes/check/test:js/pw:*) | PHP theme build only | LEFT INTACT, scripts documented dead (see §2j — pruning root tooling is a follow-up, not R6c; the product is apps/nextjs with its own package.json) |
| `.github/workflows/` (12 files) | Upstream PHP CI (incl. playwright-tests.yml: root `npm ci` + `pw:tsc` + `build-admin_default`) | PHP product | LEFT INTACT, documented dead (see §2j — CI redefinition is R6d/deployment territory, not R6c) |
| Root `Dockerfile` | Stages: php-base, composer-base, php-vendor, php-dev-vendor, frontend-assets, release-tree, release-artifact (`FROM scratch` copy of /app/src), runtime | R6d rollback artifact (built from the PARENT commit — see §6) | PHP stages DELETED, replaced by a pointer to the Next deployment definition (§2k); the artifact procedure is documented in §6, not executed here |

### 1.5 What capture49 recorded (before any relocation/deletion)

- Manifest: 77 files (52 email templates + 9 Page client files +
  12 theme html files + Simple.php + content.sql + 2 .mmdb).
  Theme html `mod_page_*` count: **0** — the theme dir contributes
  NOTHING to get_pairs today; pairs come only from Page templates.
  (The theme tree is still vendored: 46 KB, faithful, and it keeps
  the code path working under a theme-setting change.)
- Live :3001 before-values: get_pairs = 7 keys (about-us, login,
  password-reset, preview_markdown, privacy-policy, signup, tos);
  plugin pairs = `{Simple: Simple}`; generalCheck = failed
  (reference: HTTPS fail + debug-installation + non-release warns);
  ip_lookup over the 8-shape R5i set recorded per IP.
- Disposable installer fingerprint (current code, PHP-tree
  content.sql): 64 tables, 86 rows, GeoIP copied = true.
- Template parsed blocks (TS regexes from emailDefaults.ts:78-79)
  for all 52 templates, recorded for block-for-block comparison.

## 2. Step 2 decisions (relocation + repoint, with reasoning)

### 2.0 Vendor layout + uniform override rule (applies to all of §2)

Vendored root: `apps/nextjs/vendor/` (inside the Next app so the
deployment copies it with the app; OUTSIDE `src/` so the bundler
never treats data files as code; NOT git-ignored —
apps/nextjs/.gitignore has no vendor/ rule, verified):

- `vendor/geoip/` — CC0-Country.mmdb + PDDL-ASN.mmdb (15.3 MB)
- `vendor/php-modules/` — IS the modules dir:
  `<Module>/templates/email/*.html.twig` (52 files),
  `Page/templates/client/*` (9 files),
  `Servicelicense/Plugin/Simple.php`
- `vendor/php-themes/default/client/html/` — full theme html tree
  (12 files incl. partials/; the scan reads top-level only)
- `vendor/content.sql` — the installer seed file
- `vendor/README.md` — provenance: copied from upstream 0.8.9
  src/ at R6c, byte-identical per captures49 manifest; do not
  hand-edit (regenerate from the parent commit if ever needed)

UNIFORM OVERRIDE RULE (implemented in every repointed resolver):
an explicit env override applies ONLY if the directory EXISTS
(`existsSync`); otherwise the vendored default applies. This keeps
operator customization working (custom template trees, custom GeoIP
dirs), makes legacy dead env vars harmless (a deleted path falls
through instead of breaking), and makes fresh installs work with no
env at all. The ONE exception is `FB_GEOIP_DB_DIR`: explicit config
errors loudly when set-but-missing (as today) — an operator who
sets it means it; silent fallback would hide a misconfiguration.
`FOSSBILLING_PHP_SRC` is RETAINED as the template/pairs override
name (not renamed: renaming would churn every operator doc and
suite for zero behavior gain; the name is legacy, the semantics are
documented in vendor/README.md + code comments).

### 2a. content.sql — VENDORED, installer default repointed

`vendor/content.sql`, byte-identical (parity46 verifies against
the captures49 manifest + `git show <parent>:src/install/sql/
content.sql`). Installer: `--content-sql` > `FB_INSTALL_CONTENT_SQL`
> vendored default (previously: `FOSSBILLING_PHP_SRC` tree, else
fail). `FOSSBILLING_PHP_SRC` is no longer consulted by the
installer at all.

### 2b. Email templates — VENDORED per D6-10, default repointed

`vendor/php-modules/<Module>/templates/email/*.html.twig`, exact
PHP parity, no transcription drift. `phpModulesDir()` default:
vendored php-modules dir (previously: `FOSSBILLING_PHP_SRC` else
`../../src` cwd default — the cwd default is GONE: it was the
silent fork-tree dependence).

### 2c. Servicelicense Plugin — VENDORED, default repointed

`vendor/php-modules/Servicelicense/Plugin/Simple.php`.
`plugin_get_pairs` dir: env override (if exists) else vendored
plugin dir (previously: env-or-empty → `[]`).

### 2d. Page templates — VENDORED, default repointed (no empty-pairs acceptance)

`vendor/php-modules/Page/templates/client/*` + `vendor/php-themes/
default/client/html/*`. `get_pairs` dirs: env-override theme dir
(if exists) else vendored theme dir, + env-override Page client
dir (if exists) else vendored Page client dir (previously: no env
→ no dirs → `{}`). Empty pairs was REJECTED as an option: the
pairs feed the admin page picker, and the vendored cost is 77 KB
total — there is no reason to accept a UX loss to save 77 KB.

### 2e. GeoIP DBs — VENDORED in the repo (decision, with trade-offs)

Options weighed: (i) vendor in repo (+15.3 MB to the tree);
(ii) operator-supplied (installer takes --geoip-source /
FB_GEOIP_DB_DIR, warns-or-refuses without it); (iii) download at
install time (upstream source + offline behavior).
DECISION: (i) vendor. Reasons: deletion removes the original, so
post-deletion there is NO duplication in the tree (the R5i
no-duplication concern evaporates the moment src/ is deleted);
net tree size still SHRINKS by ~13 MB (28 MB src/ out, 15.3 MB
vendor in, plus ~200 KB other vendored files); ip_lookup works out
of the box with no network, no license dance, no operator step;
the R5i decision deliberately deferred vendoring "until R6" — R6
is now. Rejected: (ii) breaks out-of-box ip_lookup for every fresh
install; (iii) the bundled DBs are redistributable (CC0/PDDL) but
a download step adds a network dependency + an upstream-URL
maintenance burden for zero benefit over vendoring.
Implementation: `vendor/geoip/`; `resolveGeoipDir()` =
FB_GEOIP_DB_DIR (explicit, errors loudly if missing) else vendored
dir (the FOSSBILLING_PHP_SRC fallback is DROPPED); installer
`defaultGeoipSource()` = vendored dir (`--geoip-source` override
kept; copy step + reported FB_GEOIP_DB_DIR value unchanged).

### 2f. Version fallback — LEFT as preview-default (no vendored constant)

`isPreviewVersion()` already returns true when Version.php is
unreadable — and the TS server has no version source of its own,
no release process tied to PHP versions, and no other reader of
Version.php. Vendoring a constant would add a file that must be
bumped in lockstep with nothing. generalCheck behaves identically
(preview = true at 0.0.1, same warns). One-paragraph justification,
as required: the preview-default IS the correct behavior for a
server whose version is "0.0.1-preview-equivalent" by construction.

### 2g. config-store third fallback — DELETED

`resolveConfigPath()` is now: `FB_CONFIG_PATH` >
`dirname(dirname(FB_DATABASE_PATH))/config.php` > throw. The
`$FOSSBILLING_PHP_SRC/config.php` fallback is deleted (config.php
resolution is install-layout, not content override — there is no
operator use case for pointing config resolution at a PHP tree).
Migration note (for the R6d checklist): deployments relying on the
third fallback must set `FB_CONFIG_PATH` or use the standard
install-root layout (data dir directly under the install root).

### 2h. installer-test php CLI cross-check — KEPT, repointed

The B28 cross-check survives deletion unchanged in shape: it needs
only the `~/scratch/bin/php` binary (outside the repo) + a WORK-dir
probe file + a WORK-dir config — no src/ dependence. KEPT (it still
proves TS↔PHP config agreement, which remains meaningful for the
frozen-oracle era: the TS-written config must still parse under
PHP's `require`). Repointed: `PHPSRC` usages (installer-run env +
line-520 direct content.sql read) now use the vendored copy.

### 2i. tests/ (Pest) — DELETE with src/

1.3 MB, 124 files, PHP-only, testing PHP code that will be gone.
Its value as behavior documentation is preserved in git history +
the parity suites (the real behavioral record). Keeping it would
mean shipping a test suite for deleted code that can never run
(it needs the PHP tree + Composer vendor + a PHP runtime against
src/ classes). DELETE.

### 2j. frontend/, tools/, root package.json, workflows — decided

- `frontend/`: DELETE with the themes. Its only consumers are the
  PHP theme build (root package.json scripts + Dockerfile
  frontend-assets stage) and the PHP themes themselves — all
  deleted/dead post-cutover. NO Next consumer (verified). What
  breaks if it goes: nothing in the TS product; root package.json
  theme scripts + the Dockerfile stage (already dead/deleted).
- `tools/demo-seed/`: RETAIN. It is an HTTP-only API client
  (APP_URL + TEST_API_KEY, no src/ reads — verified by grep) that
  works unchanged against the TS API. Deleting it gains nothing;
  it needs a php runtime to run, but that is host tooling, not a
  repo dependency.
- Root `package.json` / `tsconfig.json`: LEFT INTACT, theme-build
  scripts documented dead (they build deleted themes; workspaces
  point at deleted dirs). Pruning/redefining root tooling is a
  follow-up, not R6c — the product is apps/nextjs (own package.json
  + lockfile), and nothing in it references the root.
- `.github/workflows/`: LEFT INTACT, PHP jobs documented dead (CI
  redefinition is R6d/deployment territory; editing 12 workflow
  files in a deletion batch is scope creep, and the PHP CI is dead
  by design post-cutover).

### 2k. Next deployment definition — ADDED (minimal, real)

`apps/nextjs/Dockerfile` (multi-stage Node build: deps → build →
runtime; non-root user; env documented: FB_DATABASE_PATH/URL,
FB_PUBLIC_URL, FB_GEOIP_DB_DIR, FB_CALLBACK_SALT, APP_ENV=prod for
the limiter). Deliberately NOT gold-plated: no CI pipeline, no
compose stack, no hosting config — R6d/deployment taps own those.
The root Dockerfile's PHP stages are deleted; the Next definition
lives with the app it deploys (apps/nextjs/), not at the repo root
(the root Dockerfile was the PHP artifact's home).

## 3. Step 3 independence gate — PASSED (before any deletion)

Gate script: `~/scratch/fossbilling/r5-logs/gate3.py` (kept in
r5-logs, not the repo — it is a one-off gate, not a suite).
Comparisons are against `captures49/capture49.json` live_before
values (taken with the PHP tree still in place).

Run 1 — reference :3001 rebuilt from the repointed code and
restarted with FOSSBILLING_PHP_SRC UNSET (TZ=UTC, 35 modules,
reference DB/config): ALL PASS — get_pairs == captures49 (7 keys),
plugin pairs == captures49 ({Simple: Simple}), generalCheck
envelope == captures49 (failed, same 3 lines), all 8 ip_lookup
shapes == captures49, all 52 vendored template blocks parse
identically to the PHP originals.

Run 2 — disposable :3011 with FOSSBILLING_PHP_SRC pointed at an
EMPTY dir, disposable DB (sqlite backup of the reference) +
disposable config copy, deleted in finally: ALL PASS, identical
comparisons. The exists-check override rule is what makes this
work: a set-but-empty tree falls through to vendored defaults
instead of breaking.

Parity subset against the no-var :3001 (r5-logs/parity36-r6c.log,
parity42-r6c.log): parity36 51/51 PASS (vendored template repoint
proven live), parity42 73/73 PASS (vendored GeoIP repoint proven
live, incl. the country-only symlink test now pointing at
vendor/geoip). The subset ran before deletion; the full chain
re-proves after.

Nothing still reads repo src/ behaviorally: with the var unset AND
with the var pointed at an empty dir, every relocated behavior
answers identically to the PHP-tree baseline. Deletion was
authorized by this gate.

## 4. Step 4 deletion list (executed after the Step 3 gate passed)

Deleted (plain `rm`, unstaged — the parent stages the commit):
- `src/` — entire fork tree (28 MB: modules/, library/ incl. the
  GeoIP DBs now vendored, themes/, public/, install/, data/,
  locale/, top-level entry points)
- `tests/` — Pest suite (1.3 MB, 124 files)
- `frontend/` — core browser assets + theme build tooling (164 KB)
- `composer.json`, `composer.lock` — PHP dependency manifests
- Root `Dockerfile` PHP stages — the file itself is REPLACED (not
  removed) by a pointer: Next deployment = apps/nextjs/Dockerfile;
  PHP rollback artifact = built from the parent commit (§6)

NOT deleted (verified present after): `~/scratch/fossbilling/
runtime/` (frozen oracle: config.php + fossbilling.sqlite intact),
the R6b harness, all parity suites, the fixture runner, captures/
(incl. captures49), findings docs, all TS code, `tools/demo-seed/`
(retained per §2j), root package.json/tsconfig.json (dead scripts
documented, §2j), `.github/workflows/` (dead jobs documented, §2j).
Left as dead-but-present follow-ups (NOT in the R6c deletion set,
to avoid scope creep — same category as the root tooling above):
`phpunit.xml.dist`, `phpstan.neon`, `.php-cs-fixer.dist.php`,
`rector.php`, `.ddev/` (PHP dev-env config, docroot pointed at the
deleted src/).

## 5. Step 5 proofs (src/ actually gone)

parity46 (r5-logs/parity46-r6c.log): **21 passed, 0 failed,
1 skipped** (C6 pg-mem structural — covered by parity43 §B
installer-test F2 in-chain; R3c rides separately). Per section:
- §A relocation: all 77 vendored files byte-identical to the
  captures49 manifest AND to `git show HEAD:src/...` (parent commit
  51abaf1 still carries src/; the suite auto-detects manifest-only
  mode if run after the R6c commit lands).
- §B independence: fresh disposable :3011, var UNSET — get_pairs,
  plugin pairs, generalCheck, all 8 ip_lookup shapes == captures49.
- §C fresh-install smoke, NO PHP tree: scratch copy of apps/nextjs
  (real vendor/ copy, node_modules/.next symlinked, no repo src/
  sibling, var unset) — installer exit 0, 64 tables, 86 rows,
  GeoIP copied, booted fresh install serves + ip_lookup works
  (SQLite; fresh install's own admin creds — the first parity46
  run failed §C5 by logging in with the REFERENCE admin creds
  against the fresh install; fixed to use the fresh admin).
- §D build proof: repo src/ absent on disk; tsc --noEmit exit 0;
  npm run build exit 0 on the deleted tree; :3001 restarted from
  the fresh build answers.
- §E oracle proof: :8080 answers the PHP login page AND its php
  worker cwd (read from /proc) == runtime/src — the frozen oracle,
  provably not repo src/ (which does not exist on disk).
- §F restore: invariants + config hash unchanged; :8080 + :3001
  answering at end; all disposables deleted in finally.
Suite hardening found in this batch (kept in parity46.py):
`npx next start` orphans its next-server child on SIGTERM, so the
suite now kills the port listener too (stop_next); the suite
crashes loudly (not silently green) on unexpected exceptions.

Full regression chain: see §8 (counts per suite).

Chain lesson (new, R6c): killing a PHP built-in server by ONE pid
does not free its port — `PHP_CLI_SERVER_WORKERS=4` leaves 4–5
worker processes sharing the listener. Kill ALL pids on the port
line (`ss -ltnp | grep :<port> | grep -oP pid=\K[0-9]+ | xargs
kill`), not just the first. The chain script's single-pid kill
left :8081 up after parity38; fixed by hand (all 4 workers) with
:8080 untouched, before fixtures.

## 6. R6c/R6d boundary — rollback artifact procedure (for R6d)

After R6c lands, the root Dockerfile's PHP stages are GONE from the
tree — but R6d's rollback artifact (`release-artifact`, the `FROM
scratch` copy of /app/src: PHP + Composer vendor + built frontend
assets) is built from the PARENT commit, where the stages still
exist. Exact procedure for R6d:

1. `git worktree add /tmp/r6d-rollback <parent-commit-of-R6c>`
   (the commit BEFORE the R6c deletion commit — i.e. 51abaf1 if
   R6c lands directly on it, else the R6c commit's first parent).
2. In the worktree: `docker build --target release-artifact
   -t <registry>/fossbilling-php-rollback:<tag> .` (the worktree
   contains the full PHP Dockerfile stages + src/ + composer files
   + frontend/ needed by the frontend-assets stage).
3. Push the tag; retain it one full billing cycle (D5-6); record
   the tag + retention expiry in the R6d checklist.
4. Rollback = redeploy that image (deployment-tap detail: the exact
   command depends on Josh's hosting, which the repo never
   describes — R6d documents it, it does not invent it).

R6d checklist gates (from scope §2 R6d + D6-9): R6a–R6c green;
shadow criteria met or explicitly waived; R3c status acknowledged
(live-Postgres proof before flipping PRODUCTION traffic if
production runs Postgres); rollback artifact tagged + retention
confirmed; forward-only data note (PHP resumes from TS-written
state, does not rewind it); sessions: forced logout on rollback
(R3 D3-6 precedent) unless R6d says otherwise; deployment migration
notes applied (FB_CONFIG_PATH / standard layout, FB_PUBLIC_URL set
or config url updated, FB_GEOIP_DB_DIR set if not using the
vendored default — vendored default means this is a no-op for
standard installs).

## 8. Full regression chain (r5-logs/chain-r6c.sh, after deletion)

Reference :3001 throughout: TZ=UTC, 35 modules, WITHOUT
FOSSBILLING_PHP_SRC (verified absent from the server process env).
:8080 oracle = runtime/ throughout. All suites exit 0 except
parity43's first chain run (see note).

| Suite | Result |
|---|---|
| parity46 (this batch) | 21 passed, 0 failed, 1 skipped (C6 pg-mem, labeled) |
| parity45 | 171 passed, 0 failed |
| parity44 | 77/77 |
| parity43 | 16 PASS, 0 FAIL on RERUN (see note); installer-test 119 PASS, 0 FAIL, 2 SKIP |
| parity42 | 73/73 |
| parity41 | 130/130 |
| parity40 | 120/120 |
| parity39 | 212 checks, 0 failures |
| parity38 (external :8081 oracle) | 86 checks, 0 failures |
| parity37 | TOTAL 115 pass, 0 fail |
| parity36 | 51 checks, 0 failures |
| parity35 | 210 checks, 0 failures |
| parity34 | 164 checks, 0 failures |
| parity33 | 77 checks, 0 failures |
| parity32 | 65 checks, 0 failures |
| parity31 | 63 checks, 0 failures |
| parity30 | 179 checks, 0 failures |
| parity29 | 62 checks, 0 failures |
| parity28 | 128 checks, 0 failures |
| parity27 | ALL GREEN |
| parity26 | 62 checks, 0 failures |
| parity25 | ALL GREEN (php=403 ts=200 lines are its known documented divergences) |
| parity21 | 194/203, exactly the known 9 diffs (same names as every prior batch) |
| fixtures php | 13/13 (runner summary + results JSON status fields) |
| fixtures next | 13/13 (same; :3001 killed first per standing rule, orphan killed after, reference :3001 restarted) |
| accounting | exit 0: catalog 579, TS-resolving 548, removed 31, deferred 0, proxied 0, sum 579 — UNCHANGED |

Chain notes (all fixed in-batch, none hidden):
1. parity43 FIRST chain run failed with `NameError: name 'env'
   is not defined` — my own §B edit had removed the `env`
   assignment a later block builds on (`dict(env, ...)`). Fixed by
   restoring the assignment form (with the var stripped), rerun
   alone after the chain: 16/16, installer-test 119/119 + 2 SKIP.
   The chain's parity43 verdict is the rerun's.
2. The chain script's fixtures parser counted bare `"PASS"`
   strings; the runner writes `{status: "PASS", ...}` objects, so
   it printed 0/13 for both stacks. The runner's own summaries
   ("13/13 fixtures pass") + the status fields prove 13/13 both.
   Parser bug in my script only, not a fixture failure.
3. The chain script's single-pid :8081 kill left the oracle up
   (PHP workers share the listener — see the §5 lesson); killed
   all 4 workers by hand with :8080 untouched, before fixtures.
4. Cart sequence moved 327 → 329 across the chain (fixtures
   create/delete carts); cart COUNT stayed 283 and all other
   invariants + config hash 6e3c529673c1d089 are unchanged.
   Sequence is a high-water mark, never an exact invariant.
Final state: :8080 + :3001 answering; :8081, :18025, :18026,
:3003, :3004, :3011, :3012 all down; no leaked processes.

## 7. Left for later (unchanged from scope)

- R6d artifact + checklist (procedure in §6; execution is R6d).
- Live-traffic window + one-cycle parallel run execution (Josh's
  infra taps; harness + criteria delivered in R6b).
- R3c live-Postgres proof (separate tap; D6-9 production gate).
- Root tooling pruning (root package.json dead scripts) + CI
  redefinition (.github/workflows PHP jobs) — follow-ups, not R6c.
- Custom gateway logo static serving ({www}public/gateways/custom/
  URLs — deployment note in §1.1, R6d's deployment definition).
- apps/nextjs/Dockerfile BUILD verification: no docker binary exists
  in this sandbox, so the image was never built here. Syntax +
  COPY sources (package.json, package-lock.json, next.config.ts,
  vendor/) were reviewed and all exist; the actual `docker build`
  needs a docker host and belongs to R6d/deployment, not to a
  claim made here.
