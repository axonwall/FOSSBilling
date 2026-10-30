# R5j findings — standalone TS installer + update-finalization port

Phase 5 batch R5j (R5-6 + R5-12 at recommended defaults). The LAST R5
batch: after R5j, Phase 5 is complete (R5a–R5j). R6 (per-module proxy
removal + shadow + PHP deletion) is separate and untouched.

Deliverables (all uncommitted at handoff, per the batch constraints):

- `apps/nextjs/scripts/install.ts` + `scripts/run-install.mjs` — the
  installer CLI + R3b-convention launcher.
- `apps/nextjs/scripts/finalize-update.ts` +
  `scripts/run-finalize-update.mjs` — the finalization operator CLI.
- `apps/nextjs/src/server/install-schema.ts` (GENERATED — do not edit by
  hand) + `scripts/generate-install-schema.mjs` — the TS entity
  definitions, generated from the PHP capture corpus.
- `apps/nextjs/src/server/install-schema-ddl.ts` — DDL emitters
  reproducing Doctrine DBAL 4.5's per-platform output byte-for-byte.
- `apps/nextjs/src/server/install-seed.ts` — content.sql replay +
  seedAdmin + setDefaultCurrency + seedInstallNudge (InstallSeeder port).
- `apps/nextjs/src/server/install-config.ts` — getConfigOutput port
  (sample defaults + installer overrides, URL/port normalization).
- `apps/nextjs/src/server/update-finalization.ts` — finalization state
  machine + maintenance toggling + config patches + schema sync
  (UpdateFinalization + UpdatePatcher port, portable parts only).
- `apps/nextjs/scripts/installer-test.mjs` — the installer-test script
  (119 PASS, 0 FAIL, 2 SKIP — both SKIPs are the pg-mem sequence gap,
  labeled; see §7).
- `docs/nextjs-strangler/phase5/capture46.py` + `captures46/` — the PHP
  capture corpus (see §2 for method).
- `docs/nextjs-strangler/phase5/parity43.py` — parity43: 16 PASS, 0 FAIL
  (installer-test counts inside: 119/0/2).
- Small additive change to the shared Db layer: optional `Db.rawExec`
  (db.ts interface, DbSqlite + DbPg implementations) — see §6, item 5.

## 1. Survey — PHP's installer, exactly

Sources (all from code, with file:line): `src/install/install.php`
(700 lines), `src/install/sql/content.sql` (476 lines),
`src/library/FOSSBilling/Doctrine/SchemaInstaller.php` (58),
`InstallSeeder.php` (315), `ModuleEntityScope.php`,
`EntityManagerFactory.php`, `DriverManagerFactory.php`,
`src/library/FOSSBilling/Module.php` (CORE_MODULES lines 29-36),
`Tools.php` normalizePort (lines 236-251), `PasswordManager.php`,
`Version.php` (VERSION line 16, isPreviewVersion lines 73-75),
`UpdateFinalization.php`, `UpdatePatcher.php` (applyConfigPatches line
116, applyCorePatches line 205), `src/config-sample.php`.

### 1.1 Entry points and step order (install.php POST 'install' flow)

1. `isAlreadyInstalled()`: config.php EXISTS → throw `'FOSSBilling is
   already installed.'` (config-file existence, NOT DB emptiness).
2. Session values: error_reporting, normalized system_url (see §1.5),
   trusted_proxy enabled/proxies/headers, currency_code,
   database_driver validated against SUPPORTED_DRIVERS
   (`pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`) else `'Unsupported
   database driver.'`, DB params with port via `Tools::normalizePort`
   (invalid → `'Database port is invalid.'`).
3. `connectDatabase`: Postgres = admin PDO to dbname `postgres`,
   `CREATE DATABASE "quoted"` silently failing if exists, then
   DriverManager connection + `SELECT 1`; SQLite = path required else
   `'The SQLite database file path is required.'`, mkdir directory else
   `'Unable to create the SQLite database directory at...'`,
   connection + `SELECT 1`; MySQL = `CREATE DATABASE utf8mb4`
   silently failing if exists.
4. Admin session values + `validateAdmin` (exact rules/messages/order):
   email FILTER_VALIDATE_EMAIL → `'The admin email is not a valid
   address.'`; password length < 8 → `'Minimum admin password length
   is 8 characters.'`; no digit → `'Admin password must include at
   least one number.'`; no lowercase → `'Admin password must include
   at least one lowercase letter.'`; no uppercase → `'Admin password
   must include at least one uppercase letter.'`; empty admin_name →
   `'You must enter an Admin Name.'`
5. `install()`: `installPortable()` → theme config copy if missing +
   template exists → `.htaccess` fetch from GitHub (throws on failure)
   → `getConfigOutput` → dumpFile config.php (failure → the
   `'Configuration file is not writable...'` message, 101) →
   `UpdateFinalization()->writeCompleteState()` → true; then session
   destroy + `generateEmailTemplates` + result page + delete install.php
   if not debug.
6. `installPortable()`: `EntityManagerFactory::create(connection)` →
   `SchemaInstaller::createSchema` → read content.sql (fail →
   `'Could not read content.sql file'`) → now →
   `InstallSeeder::seedContent` → `PasswordManager::hashIt(password)` →
   `seedAdmin(name, email, hash, api_token [null unless testing], now)`
   → `setDefaultCurrency(currency_code)` →
   `seedInstallNudge(Version::VERSION, now)`.

### 1.2 Schema definition source — SchemaInstaller, not SQL files

`src/install/sql/structure.sql` is NO LONGER USED for any fresh install
(frozen definition the legacy MySQL-only patches assume). The schema is
`SchemaTool::createSchema` over filtered Doctrine entity metadata:
an entity is kept iff its module is null (non-`Box\Mod` entities) OR
`ModuleEntityScope::isEagerAtInstall(module)`. Eager = the 28
CORE_MODULES + `news`, `branding`, `redirect` (the fixed set
content.sql pre-seeds as installed). Everything else (`custom_pages`,
`mod_massmailer`, `service_apikey`, any future extension) gets its
table only on activation via that module's own `install()` hook +
`SchemaSynchronizer::syncEntities()`.

Measured: 66 metadata total → 63 filtered (the 3 excluded are exactly
`custom_pages`, `mod_massmailer`, `service_apikey`) → 63 tables.
Id/FK columns are `Types::BIGINT` almost everywhere. Fresh schemas DO
carry real FK constraints (30 tables) — the "never had real FK
constraints" note in AGENTS.md is about the synchronizer never ADDING
an FK to an already-existing table, not about fresh installs.

### 1.3 Seed rows — the 86-row derivation, VERIFIED from a real run

`InstallSeeder::seedContent` replays `install/sql/content.sql` with
rewrites: strip bookkeeping (comments, `/*!` directives, LOCK/UNLOCK
TABLES), remove backticks, replace `NOW()` with a literal seed-time
timestamp, per-statement unescape (`\n` → newline, `\"` → `"`; unescape
AFTER splitting so an escaped `;\n` inside data is never a statement
boundary), rewrite bare 0/1 literals to false/true ONLY in
boolean-mapped column positions (from the same entity metadata), then
`resyncPostgresSequences` for seeded tables (`pg_get_serial_sequence`
+ `setval` to MAX(id); no-op if no sequence; MySQL AUTO_INCREMENT and
SQLite rowid need nothing).

Per-table fresh state, from the captured PHP run
(`captures46/php-fresh-schema.json`):

| table | rows | table | rows |
|---|---|---|---|
| admin_group | 3 | setting | 35 (34 content + 1 nudge) |
| client_group | 1 | support_helpdesk | 1 |
| currency | 1 | support_kb_article | 3 |
| extension | 3 | support_kb_article_category | 2 |
| pay_gateway | 2 | support_pr | 17 |
| post | 3 | support_pr_category | 7 |
| product | 1 | tld | 1 |
| product_category | 1 | tld_registrar | 3 |
| admin | 1 (seedAdmin) | admin_group_member | 1 (seedAdmin) |

Total: 83 content + 2 seedAdmin + 1 nudge = **86**, everything else
empty. `seedAdmin` inserts the admin row (name, email, pass hash,
api_token, created/updated — status defaults to `'active'`) + one
`admin_group_member` row (admin_id, group 1, created_at) and returns
the admin id. `setDefaultCurrency` updates currency id 1's code.
`seedInstallNudge` inserts setting `last_error_reporting_nudge` =
version. Admin pass hash: bcrypt `$2y$`, length 60, cost 12
(`PASSWORD_DEFAULT` + `['cost' => 12]`).

### 1.4 Existing-target behavior — PHP vs TS (documented improvement)

PHP's guard is config-file existence ONLY. On a non-empty DB with no
config file, PHP would proceed and crash mid-schema-creation (the
CREATE TABLEs fail on existing tables). The TS installer
match-or-improves: it refuses on an existing config file (PHP's exact
message, exit 2) AND on a non-empty target DB (any user table present,
exit 2, zero writes proven by checksums/counts before+after). There is
no `--force` flag, by design (R3b precedent). Note the Postgres
ordering subtlety: CREATE DATABASE runs (silently-if-exists) before the
DB guard, so a refusal on a pre-existing non-empty DB writes nothing;
a refusal never creates tables or a config file.

### 1.5 Config keys — sample + getConfigOutput overrides

`getConfigOutput` starts from `config-sample.php` and overwrites:
`security.force_https` = systemUrl starts with https://;
`trusted_proxies` block only when enabled; `debug_and_monitoring.report_errors`
= (bool) diagnostics choice; `debug_and_monitoring.debug` = false on
fresh; `update_branch` = preview if `isPreviewVersion` else release
(0.0.1 IS preview → fresh installs get `'preview'`);
`info.instance_id` = fresh UUID v4; `url` = systemUrl stripped of
scheme; `path_data` = install-root data dir; `db` = sqlite
`{driver, path}` or `{driver, host, port normalized (pgsql 5432 /
mysql 3306), name, user, password}`; `twig.cache` = install-root
cache dir; `disable_auto_cron` = !preview && !dev (false on a fresh
preview install). `normalizeSystemUrl`: trim, prepend https:// if no
`://` anywhere, parse_url must yield http/https + host, normalized =
lowercase scheme + host VERBATIM (only the scheme is lowercased) +
optional port + '/' + trimmed path, trailing slash; userinfo, query
and fragment are dropped. The TS port mirrors all of this, including
parse_url's leniency (a host with spaces is accepted by PHP and by
TS — verified against the static binary, not assumed).

Salt: `bin2hex(random_bytes(16))` evaluated at require time — a FRESH
32 lowercase hex string per call. TS equivalent:
`crypto.randomBytes(16).toString('hex')`. Never `Math.random`, never
fixed, never logged/printed (installer-test asserts presence + 32-hex
shape + inequality across two installs, never the value; the
installer's own stdout is scanned to prove it never contains the salt).

Installer-owned inputs (scope): locale + auto_detect_locale
(defaults en_US/true), report_errors initial value (diagnostics
choice, default false), instance_id generation (never edited — R5a's
endpoint only reads it). `--salt` exists ONLY for import targets that
must preserve a source salt (e.g. R3b-imported DBs); default is fresh.

### 1.6 Update finalization — what R5f left, what R5j ports

R5f's cron gate only REFUSES while finalization is pending
(parity39 §2: "TS does NOT mirror the finalize side effects — no patch
application, no maintenance toggle. That work belongs to
update-finalization (R5j), not the cron runner"). PHP's machine
(`UpdateFinalization.php`):

- State file `PATH_DATA/update-finalization.json`, lock file
  `update-finalization.lock` with flock exclusive. Statuses pending →
  finalized → complete. Encoding: JSON_PRETTY_PRINT (4 spaces) |
  JSON_UNESCAPED_SLASHES + trailing newline.
- `createPendingState`: writes pending {status, from_version,
  target_version, branch (config update_branch or release),
  update_type (detectUpdateType or null), source, created_at DATE_ATOM,
  finalized_at null, completed_at null, maintenance_mode = current
  config maintenance_mode} THEN `enableMaintenanceMode()`. The pending
  write comes FIRST so a failed config write still leaves recoverable
  evidence. `createPendingState` returns the existing state when one
  already requires finalization (never overwrites it).
- `enableMaintenanceMode`: enabled=true, allowed_urls merged with
  `<adminPrefix>/staff/login` + `<adminPrefix>/system/update/finalize`
  (the ONLY maintenance flipper, per R5f). `finalizeUpdateLocked`
  does NOT touch maintenance mode.
- `finalizeUpdateLocked`: clearCache → `applyConfigPatches(force true)`
  → `applyCorePatches(force true)` → maybe remove install dir (only if
  production) → clearCache → state finalized + finalized_at. A patch
  failure propagates: state stays pending, maintenance stays ON.
- `completeFinalization`: null/already-complete → writeCompleteState;
  else requires finalized (else `'Update finalization must be run
  before it can be completed.'`); requires 0 pending patches; sets
  completed_at, `restoreMaintenanceMode` (the EXACT captured pre-update
  object, not just enabled=false), writeCompleteState, clearCache.
- `writeCompleteState`: {status complete, version VERSION,
  from_version (from state or null), target_version (from state or
  VERSION), finalized_at (from state or now), completed_at (from state
  or now)}.
- `ensureCurrentVersionFinalization`: complete-for-current → null;
  requires-finalization → keep; else create pending (from_version from
  state version or null, source version-state-mismatch or
  missing-finalization-state). `finalizePendingUpdate` (bootstrap):
  pending → finalize; finalized + patches > 0 → heal (finalize again);
  else `healSchemaDrift` (sync if out of sync, never throws).
- `finalizeAndComplete` (CLI path): finalize + complete ("CLI patching
  has no review screen, so it performs both web steps").
- `isCompleteForCurrentVersion`: complete AND version == 0.0.1 (NOT
  0.8.9). `stateRequiresFinalization`: pending/finalized. A `finalized`
  state still requires finalization. `detectUpdateType`: null when
  from is null/empty/preview or target is preview; else
  PATCH=0/MINOR=1/MAJOR=2 (pre-1.0: minor bump = MAJOR).
- `applyConfigPatches(force)`: no-op unless force. Fill-missing-keys +
  normalize, exactly: security.mode??=strict, force_https??=true,
  trusted_proxies {enabled??=false, proxies??=[], headers??=
  'x_forwarded'}, session_lifespan??= cookie_lifespan?? 7200,
  grace??=300, fingerprinting??=true, debug_fingerprint??=false,
  update_branch??=release, TOP-LEVEL log_stacktrace??=true and
  stacktrace_length??=25 (then debug_and_monitoring.debug??= legacy
  top-level debug?? false, log_stacktrace??= top-level,
  stacktrace_length??= top-level, report_errors??=false),
  maintenance_mode {enabled??=false, allowed_urls??=[],
  allowed_ips??=[]}, disable_auto_cron = !preview && !dev
  (UNCONDITIONAL), i18n locale??= legacy top-level locale?? en_US,
  auto_detect_locale??=true, timezone??= legacy timezone?? UTC,
  date_format medium, time_format short, db.driver??=pdo_mysql,
  **db.port = normalizePort(port, 3306) — UNCONDITIONAL, 3306 default
  even for pgsql (quirk, mirrored exactly)**, unset deprecated api keys
  (rate_span, rate_limit, throttle_delay, rate_span_login,
  rate_limit_login, rate_limit_whitelist), api.CSRFPrevention??=true,
  rate_limiter {enabled??=true, whitelist_ips??=[], policies??=[]},
  whitelist_ips merged with the ORIGINAL config's legacy
  api.rate_limit_whitelist (unique), info.instance_id??= UUID v4,
  info.salt??= legacy top-level salt, url scheme strip (both schemes,
  anywhere), remove deprecated keys (guzzle, locale,
  locale_date_format, locale_time_format, timezone, sef_urls, salt,
  path_logs, log_to_db) + subkeys (security.cookie_lifespan, db.type).
  No write when unchanged (PHP `===` comparison; TS compares
  JSON.stringify, key order preserved by append-at-end semantics).
- `applyCorePatches`: MySQL-only raw patch loop (skipped non-MySQL)
  + portable steps every platform: migrateThemePackageLayout,
  migrateDefaultBrandingAssetsToPublicDirectory, removeRetiredHookData,
  seedInvoiceNoteSettings, applyPortableInvoiceMigrations,
  syncPortableSchema (SchemaSynchronizer additive sync),
  backfillInvoiceJournal, checkInvoiceNumberCounter (warns only).

R5j ports: the state machine, maintenance toggling, config patches
(in full, including the 3306 quirk), and the portable schema sync.
Deliberately NOT ported (see §6): legacy MySQL patches (out by
definition — TS has no MySQL target; availablePatches() is 0),
theme/branding/retired-hook/invoice-note/invoice-migration/journal/
counter data steps (PHP-era data states), clearCache + install-dir
removal (no-ops: no PHP cache dir, no install/ dir in TS),
refreshComposerAutoloader (no composer autoloader in TS). The removed
admin API endpoints are NOT resurrected (settled R1 decision); the
tool is an operator script, and the R5f cron gate keeps working
unchanged (proven by parity39 in the regression set + module-level
gate predicates in installer-test §G).

Schema sync rules (mirroring SchemaSynchronizer): missing table →
full CREATE (with FKs, since the table is fresh); missing non-PK
column → ALTER TABLE ADD COLUMN; missing index → CREATE INDEX; NEVER
drop, NEVER alter an existing column's type/nullability/default
(mismatches are reported, never fixed), NEVER add an FK to an
existing table. A missing PK column ABORTS finalization (the table is
structurally not the defined table; refusing rather than altering a
PK — documented safety divergence from PHP's attempt-everything sync).

Lock difference (documented): PHP uses flock on
update-finalization.lock; the TS tool uses an exclusive-create lock
file removed in `finally` (same single-operator exclusion).

### 1.7 rate_limit_counter installer delta (R5g shape, exact)

From `ratelimit.ts:163-168` (lazy CREATE TABLE IF NOT EXISTS, made
eager by the installer):

```sql
CREATE TABLE IF NOT EXISTS rate_limit_counter (
  policy TEXT NOT NULL, subject_hash TEXT NOT NULL, subject_display TEXT,
  window_start_ms REAL NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0,
  tokens REAL NOT NULL DEFAULT 0, updated_ms REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (policy, subject_hash))
```

Same DDL on both targets (TEXT/REAL/INTEGER are valid on both). It is
a TS-only table: it does NOT appear in PHP's 63-table fresh schema
(verified: the PHP dump has no such table). A fresh install therefore
has 64 tables (63 + delta) and never needs the lazy path. The
installer-test asserts the shape on SQLite live and on pg-mem.

### 1.8 GeoIP / Version relocation (R5i's note, answered)

- GeoIP Databases: the installer COPIES both .mmdb files from the
  source tree (default
  `FOSSBILLING_PHP_SRC/library/FOSSBilling/GeoIP/Databases`,
  overridable with `--geoip-source`) into
  `<installRoot>/data/geoip/` and reports the exact
  `FB_GEOIP_DB_DIR=<dir>` value to set. A missing source WARNS, never
  fails the install (a non-core asset must not fail an install — the
  .htaccess-fetch lesson, inverted). `--no-geoip` skips the copy.
  parity43 §C proves end to end that the TS geoip module resolves
  `FB_GEOIP_DB_DIR` to exactly the copied dir, and that default
  resolution (PHP tree) still works. R6's execution item is therefore
  just setting the env var on the deployed server, not relocating files
  at R6 time.
- Version.php: NO action needed. TS reads the version from
  `FOSSBILLING_PHP_SRC/library/FOSSBilling/Version.php` (security.ts
  generalCheck) but falls back to preview=true when unreadable — and
  at 0.0.1 preview IS true, so a missing Version.php after R6 yields
  the identical outcome. If a future version is non-preview, the server
  must keep a readable Version.php — that is a version-change concern,
  not an R5j one.

## 2. Capture corpus (capture46.py + captures46/)

Method (PHP behavior OBSERVED, not assumed):

- `php-fresh-schema.json`: a REAL SchemaInstaller + InstallSeeder run
  against a disposable SQLite file, via the static PHP binary. Boots
  with the RUNTIME tree's vendor + src, which diff-verified IDENTICAL
  to the repo tree for every schema-relevant file (Doctrine/,
  modules/, Version, InstallSeeder); content.sql comes from the REPO
  (the runtime's install/ dir was removed post-install). Fixed seed
  timestamp (2026-01-01) so the capture is deterministic. The admin
  password hash is NEVER emitted (presence, `$2y$` prefix, length 60
  only). Result: 63 tables, 86 rows, sqlite_sequence values.
- `php-platform-ddl.json`: per-table CREATE/INDEX/ALTER SQL as
  Doctrine's DBAL 4.5 renders it for the SQLite and PostgreSQL
  platforms, from the SAME filtered metadata SchemaInstaller uses
  (`SchemaTool::getSchemaFromMetadata` + each platform's
  `getCreateTableSQL`). No live Postgres needed: the Schema object is
  platform-independent. (Lesson recorded: the filter MUST go through
  `ModuleEntityScope::moduleForEntityClass` — a raw namespace segment
  is CamelCase and `isEagerAtInstall` would reject everything,
  yielding 0 tables.)
- `php-config-sample.json`: config-sample.php EVALUATED by the static
  PHP binary (salt redacted to shape; path_data/twig.cache recorded as
  location-dependent).
- `php-install-overrides.json`: getConfigOutput overrides transcribed
  from install.php source (code-derived, not executed: install.php is
  a web endpoint and cannot run headless without a session — labeled
  as such, not presented as an executed observation).
- `php-finalization-reference.json`: the reference
  update-finalization.json verbatim (no secrets in it). READ-ONLY:
  capture46.py never mutates it.
- Gates: capture46.py exits non-zero unless the fresh state is exactly
  86 rows / 63 tables / 66→63 metadata — it fails loudly rather than
  blessing drift.

Platform DDL facts the TS code relies on (all from this corpus):
Postgres ids are `BIGINT GENERATED BY DEFAULT AS IDENTITY` (DBAL 4
renders identity, not BIGSERIAL); no standalone sequences; SQLite
renders EVERY autoincrement PK as `INTEGER PRIMARY KEY AUTOINCREMENT`
(rowid alias, even for bigint ids); CLOB→TEXT, BLOB→BYTEA,
DATETIME→TIMESTAMP(0) WITHOUT TIME ZONE, BOOLEAN defaults 0 (sqlite) /
false (pg), decimal defaults as quoted strings ('0.00', '1.000000');
a Doctrine `json` type exists in the schema (admin_group.permissions,
one more `snapshot` column: CLOB on sqlite, JSON on pg); FKs are
inline on sqlite (`... NOT DEFERRABLE INITIALLY IMMEDIATE`) and
trailing ALTERs on pg (`... NOT DEFERRABLE`); 9 tables have ON DELETE
CASCADE; index/FK names are identical across platforms; quoted
identifiers: `transaction` (both), `action` column (sqlite only);
only `session` uses a table-level PK; no composite FKs; no
composite PKs (generator asserts single-column PKs and fails loudly
otherwise).

## 3. TS design

- **Definitions, not hand-written DDL.**
  `scripts/generate-install-schema.mjs` parses the capture corpus
  (platform DDL + live structure), cross-verifies every fact across
  both sources (sqlite DDL vs pg DDL vs live PRAGMA: column sets,
  order, types, nullability, defaults, PK sets, index sets, FK sets —
  any disagreement fails the generator), and emits structured
  `install-schema.ts` (63 tables, 736 columns). Re-run after any
  entity change; the installer-test then proves the emitters still
  reproduce Doctrine's DDL byte-for-byte.
- **Emitters** (`install-schema-ddl.ts`): hand-written, verified
  byte-equal to Doctrine's DDL for all 63 tables × 2 platforms
  (installer-test §A). Postgres full-schema execution defers ALL FK
  ALTERs after ALL CREATEs: per-table emission is alphabetical
  (invoice before pay_gateway) and a FK ALTER fails on real Postgres
  when the referenced table does not exist yet. The final schema is
  identical; only execution order differs. (Whether Doctrine's own
  SchemaTool sorts or defers is unobservable from the per-table
  capture; the deferred order is the safe execution order.)
- **Seeds** (`install-seed.ts`): InstallSeeder port, same algorithm
  (bookkeeping strip → backtick strip → NOW() literal → `;\n` split →
  per-statement unescape → boolean rewrite by definition type →
  execute → Postgres sequence resync). One `now` for all seed writes,
  UTC `YYYY-MM-DD HH:MM:SS`.
- **Config** (`install-config.ts`): sample defaults transcribed
  verbatim + getConfigOutput overrides. Initial write via
  `serializeConfig` + temp + rename (NOT `writeConfigFile`: it backs
  the prior file up first and THROWS when no prior file exists —
  exactly the fresh-install state). All later updates go through
  `writeConfigFile` (backup + rename). The writer emits short `[...]`
  syntax where PHP's installer emits `var_export`'s `array (...)`
  syntax — PHP parses both and the TS parser handles both, so the
  installer-test asserts parse-back VALUE equality (TS parser AND PHP
  require cross-check), never byte equality with var_export output.
- **Finalization** (`update-finalization.ts`): see §1.6. The tool
  reads the DB connection from the install's own config.php (sqlite
  path, or Postgres host/port/name/user/password); MySQL targets are
  refused (TS has no MySQL target).
- **Guards order** (install.ts): config-exists refusal FIRST (PHP's
  isAlreadyInstalled runs before validation), then admin/URL/port
  validation, then DB connect + non-empty guard, then schema + seeds
  in ONE transaction (TS improvement over PHP's autocommit install;
  Postgres CREATE DATABASE stays outside it, as it must), then
  config, then complete state, then GeoIP copy.
- **Credentials**: admin password from `--admin-password` or
  `FB_INSTALL_ADMIN_PASSWORD` (env preferred — argv is ps-visible);
  never printed/logged/reported. Salt/instance_id never in output
  (presence booleans only).

## 4. Installer CLI (exact)

```
node apps/nextjs/scripts/run-install.mjs --install-root DIR --url URL
  --admin-name NAME --admin-email EMAIL
  [--admin-password PASS | FB_INSTALL_ADMIN_PASSWORD]
  [--db-driver pdo_sqlite|pdo_pgsql] [--db-path FILE]
  [--db-host H] [--db-port P] [--db-name N] [--db-user U] [--db-password P]
  [--currency USD] [--locale en_US] [--no-auto-detect-locale] [--report-errors]
  [--trusted-proxies a,b] [--trusted-proxy-headers x_forwarded]
  [--content-sql FILE] [--geoip-source DIR | --no-geoip]
  [--salt HEX] [--admin-api-token TOKEN] [--json]
```

Exit codes: 0 installed, 1 usage/validation/operational error,
2 refusal (existing config or non-empty target). Defaults: sqlite
driver; sqlite path `<root>/data/fossbilling.sqlite`; pg host
127.0.0.1, port 5432, name/user `fossbilling`; currency USD; locale
en_US, auto-detect on; report_errors off; content.sql from
`FOSSBILLING_PHP_SRC/install/sql/content.sql` (or
`FB_INSTALL_CONTENT_SQL`); GeoIP source from
`FOSSBILLING_PHP_SRC/.../GeoIP/Databases`. The report (`--json`)
contains no secrets: tables 64, seededRows 86, adminId, configPath,
dataDir, finalizationStatePath, normalizedUrl, saltPresent,
instanceIdPresent, rateLimitCounter, geoip {copied, dir, reason}.

Finalization CLI:

```
node apps/nextjs/scripts/run-finalize-update.mjs
  [status|finalize|complete|finalize-and-complete (default)]
  --install-root DIR [--config-path FILE] [--json]
```

## 5. Deviation table

| # | Area | PHP | TS | Reason |
|---|---|---|---|---|
| 1 | Non-empty DB guard | Config-exists only; crashes mid-schema on non-empty DB | Refuses (exit 2) on existing config AND on any user table | Documented match-or-improve; zero writes proven |
| 2 | Install atomicity | Autocommit per statement | Schema + seeds in ONE transaction (both drivers) | TS improvement; Postgres CREATE DATABASE stays outside it (must) |
| 3 | Config writer | `var_export` `array (...)` syntax | R5a `serializeConfig` short `[...]` syntax | Proven writer; PHP parses both; parse-back equality asserted, not bytes |
| 4 | Initial config write | dumpFile (creates parents) | serializeConfig + temp + rename, NO backup | `writeConfigFile` throws without a prior file to back up; nothing to back up on fresh install |
| 5 | .htaccess fetch | Throws on failure | DROPPED | Next routing does not use .htaccess; a fetch failure must not fail an install |
| 6 | Theme config copy | Copies if missing + template exists | DROPPED | No theme files in Next |
| 7 | generateEmailTemplates | Post-install sync into email_template rows | NOT in installer | TS email falls back to emailDefaults when no DB row exists; activation syncs rows in both stacks |
| 8 | install.php deletion | Deletes install.php if not debug | N/A | A standalone script has nothing to delete |
| 9 | Email validation | FILTER_VALIDATE_EMAIL | Conservative regex approximation | No filter_var port in Node; clearly-valid/invalid behave identically (asserted) |
| 10 | URL host case | parse_url keeps host verbatim | Same (only scheme lowercased) | Verified against static binary, incl. spaces-in-host leniency |
| 11 | Finalization lock | flock | Exclusive-create lock file, removed in finally | Same single-operator exclusion; documented |
| 12 | clearCache / install-dir removal | Runs (cache clear, prod-only dir removal) | No-ops | No PHP cache dir / install dir in TS |
| 13 | refreshComposerAutoloader | Runs in config patches | Skipped | No composer autoloader in TS |
| 14 | Core data patches (theme/branding/retired-hook/invoice-note/invoice-migration/journal/counter) | Run in applyCorePatches | NOT ported | PHP-era data states a TS-fresh install never has; see §8 |
| 15 | Legacy MySQL patches | Run (MySQL-only raw SQL) | availablePatches() = 0 | TS has no MySQL target, by definition |
| 16 | Schema sync, missing PK column | Synchronizer attempts it | ABORTS finalization | Safety: the table is structurally not the defined table |
| 17 | Postgres FK execution order | Per-table emission (order unobserved) | All CREATEs+indexes, then all FK ALTERs | Alphabetical per-table order fails on real Postgres (invoice→pay_gateway); final schema identical |
| 18 | content.sql on Postgres | Doctrine connection executes literally | Raw pool/client query (Db.rawExec), bypassing DbPg.translateSql | translateSql's INSERT parser is not string-aware and throws on multi-row literal INSERTs (see §6.5); literals are pre-portableized so translation is redundant |
| 19 | pg-mem NOT DEFERRABLE | N/A (real Postgres accepts) | Stripped for the pg-mem run ONLY | pg-mem parser gap; byte-equality proof (§A) covers the exact DDL |
| 20 | Version.php relocation | Read at runtime | No action (fallback = preview = 0.0.1 behavior) | See §1.8 |
| 21 | Seed timestamps | PHP server timezone | UTC | Matches sandbox PHP default; install-time stamps, never cross-compared |
| 22 | bcrypt variant | `$2y$` (PHP password_hash) | `$2b$` (bcryptjs), cost 12 | PHP password_verify accepts `$2b$`; verified by compare (installer-test B11–B12) |

## 6. Notable findings during the build

1. **Generator caught a real type**: a Doctrine `json` type in the
   schema (admin_group.permissions + one `snapshot` column: CLOB on
   sqlite, JSON on pg). The generator's type map failed loudly on the
   unknown CLOB/JSON pair instead of silently mistyping it.
2. **SQLite INTEGER-for-all-autoincrement rule**: Doctrine renders
   every autoincrement PK as `INTEGER PRIMARY KEY AUTOINCREMENT` on
   sqlite, even bigint ids (only INTEGER is a rowid alias). The first
   emitter version emitted BIGINT and failed byte-equality on all 63
   tables — the corpus caught it immediately.
3. **Postgres PKs are table-level clauses, identity is a GENERATED
   marker**: the generator's first parse assumed inline PKs and
   failed; the corrected parser compares PK SETS across platforms.
4. **The filter must use `moduleForEntityClass`**: a raw namespace
   segment is CamelCase (`Client`) and `isEagerAtInstall` expects
   lowercase (`client`) — a naive filter yields 0 tables.
5. **DbPg.translateSql cannot execute content.sql** (see deviation
   18): its INSERT branch parses VALUES tuples without string
   awareness and throws `column/item count mismatch` on the
   admin_group multi-row INSERT (JSON strings contain commas). Fix:
   additive optional `Db.rawExec` on the Db interface (DbPg:
   direct runner.query on the same connection — still inside the
   transaction on tx handles; DbSqlite: direct exec). No existing
   behavior changed: all app SQL still goes through translateSql.
   This ALSO matters for any future live-Postgres install (not just
   pg-mem): without rawExec, a real Postgres install would fail at
   the same statement.
6. **pg-mem gaps** (all labeled SKIP, never presented as live proof):
   (a) `NOT DEFERRABLE` on FK ALTERs — parser gap, stripped for the
   pg-mem run only; (b) `pg_get_serial_sequence` — catalog gap, so
   the sequence-resync proof and the nudge-after-resync proof are
   SKIP on pg-mem (the nudge INSERT then collides on setting_pkey,
   which itself proves the resync matters). Live-Postgres proof rides
   on R3c.
7. **URL normalization edge cases verified against PHP's parse_url**:
   uppercase host preserved, userinfo dropped, query/fragment
   dropped, port 0 kept, interior `//` preserved (only path ends are
   trimmed), non-numeric port rejected (the TS regex initially
   accepted `:abc` as path — fixed with a lookahead).
8. **PHP require cross-check subtlety**: deleting both info keys
   leaves PHP's info as `[]` (json_encode of an empty array) vs TS's
   `{}` — the test compares with placeholders, not deletion, so the
   comparison is exact rather than fooled by the encoding artifact.

## 7. Coverage table

| Area | PHP-observed | TS-proven | Code-only / labeled |
|---|---|---|---|
| Schema (63 tables, 736 cols) | Live dump + per-platform DDL | Emitter byte-equal 63×2; live installed schema diff 0 (cols/types/notnull/defaults/PK/indexes/FKs/rows); sqlite_sequence equal | — |
| Fresh state 86 rows | Live dump per table | SQLite live install per-table counts; pg-mem direct counts (content-only 83, adjusted for nudge/admin timing) | — |
| Config keys/values | Sample evaluated + overrides transcribed | TS parse-back + PHP require cross-check (modulo salt/instance_id); builder units (ports, proxies, locale, db shapes) | Override transcription is code-derived, not executed (install.php is a web endpoint) |
| Salt/instance_id | bin2hex(random_bytes(16)) / Uuid::v4 (code) | Presence + 32-hex/UUID-v4 shape + inequality across installs; stdout scanned for leakage | Values never printed anywhere |
| Admin validation | install.php rules (code) | All 6 messages + exit 1 via CLI | Email check is a regex approximation (documented) |
| Refusals | isAlreadyInstalled (code) | Exit 2 + exact messages + checksums/counts before+after (zero writes) | Non-empty-DB guard is a TS improvement (§5.1) |
| Finalization order | UpdateFinalization (code) + reference state file shape | pending→finalized→complete via CLI; maintenance untouched by finalize, exactly restored by complete; failure keeps pending | — |
| Config patches | UpdatePatcher (code) | Legacy-config fixture patched end to end (locale/timezone/salt inheritance, deprecated removals, whitelist merge, 3306 quirk, stacktrace keys) | — |
| Schema sync | SchemaSynchronizer rules (code + AGENTS.md) | Table/column/index restore; second sync no-op; FK-never-added; PK-missing refusal | — |
| rate_limit_counter | ratelimit.ts DDL (code) | Shape asserted on SQLite live + pg-mem | — |
| GeoIP relocation | geoip.ts resolution (code) | Copy + resolveGeoipDir() to the copied dir (parity43 §C); default resolution still works | — |
| Version.php | security.ts fallback (code) | No-op justified (fallback = 0.0.1 behavior) | — |
| Postgres live | — | — | NOT proven: no live Postgres in sandbox. pg-mem proves structure (DDL executes, 63 tables, seeds, admin/currency). Sequence resync + live pg behavior ride on R3c |
| Cron gate after R5j | R5f gate (code) | Module-level predicates (§G) + parity39 in regression (live gate proof) | — |

## 8. R5 completion statement

R5a–R5j are done. What R5 as a whole delivered: the config store
(single config.php, env > config, R5a), prepareInvoice NULL semantics
+ payment/refund atomicity (R5b), Twig `{% set %}` + companions
(R5c), config-driven timezone (R5d), SMTP via nodemailer + exact
queue state machine (R5e), the full 13-job cron runner + finalization
gate (R5f), the 31-policy rate limiter with DB counters (R5g),
antispam wired inline (R5h), ip_lookup + run_checks (R5i), and now
the standalone installer + finalization port (R5j). Accounting
re-verified by parity43 §E: catalog 579, TS-resolving 548, removed
31, deferred 0, sum 579, exit 0.

## 9. R5j / R6 boundary

R6 (per-module proxy removal + shadow + PHP deletion) is untouched.
The installer is the tool R6's fresh installs will use. R6's
execution items carried from R5j:

- Set `FB_GEOIP_DB_DIR=<installRoot>/data/geoip` on the deployed
  server (the installer already copies the files there; nothing to
  relocate at R6 time).
- Decide content.sql's post-PHP home: the installer reads it from
  `FOSSBILLING_PHP_SRC/install/sql/content.sql` (or
  `FB_INSTALL_CONTENT_SQL`). When PHP is deleted, R6 must either
  vendor content.sql into the TS tree or keep a relocated copy and
  point `FB_INSTALL_CONTENT_SQL` at it — otherwise fresh installs
  cannot seed. (Same relocation class as the GeoIP DBs, but unlike
  them the installer does NOT copy content.sql today.)
- If a future version is non-preview, the server needs a readable
  Version.php (see §1.8).

## 10. Left for later (needs Josh's infra or a separate decision)

- Live-Postgres proof of the installer (R3c endpoints: a real
  Postgres + the `PG_TEST_URL` driver-test path). What pg-mem could
  not prove: sequence resync via pg_get_serial_sequence/setval, and
  live-pg behavior of the DDL + seeds + sync. The installer-test
  labels these SKIP, never green.
- Live DB-refresh follow-up from R5i (updateDefaultDatabases 7-day
  refresh; stale DBs serve stale records identically on both stacks).
- Invoice journal backfill for DBs migrated from PHP: the
  finalization tool does NOT backfill journal rows for pre-existing
  invoices (a TS-fresh install has nothing to backfill — no invoices
  predate the journal feature). A PHP-migrated DB keeps its
  pre-existing state for that step. Porting backfillInvoiceJournal
  (or accepting the gap) is a separate decision, not an R5j silent
  drop.
- Email-template generation on fresh installs (see deviation 7): the
  TS email service falls back to emailDefaults, so this is a
  sync-timing question, not a breakage — but a fresh install has 0
  email_template rows where a PHP web install has the active modules'
  rows.
- The `send_now` string-bool PHP 9998 upstream fork-fix question
  (standing from R5e, Josh's call).
- All other standing R5 leftovers (canUpdateParam checks, N1
  JSON-null, formatDateValue TZ harmonization, empty keyValue map,
  staff basket checkout, R5b/R5e/R5f leftovers) are unchanged by R5j
  and remain as recorded in prior findings.

## 11. Regression (run 2026-10-30, after implementation)

- Typecheck: `npm run typecheck` (tsc --noEmit) exit 0.
- Production build: `npm run build` exit 0; reference :3001 restarted
  on the fresh build and answering after the suite.
- parity43: 16 PASS, 0 FAIL (installer-test inside: 119 PASS, 0 FAIL,
  2 SKIP — both SKIPs are the pg-mem sequence gap, labeled).
- parity42: 73/73. parity41: 130/130. parity40: 120/120. parity39:
  212 checks, 0 failures. parity38: 86/86 (externally started :8081
  prod oracle, killed before fixtures). parity37: 115 pass, 0 fail.
  parity36: 51 checks, 0 failures. parity35: 210 checks, 0 failures.
  parity34: 164 checks, 0 failures. parity33: 77 checks, 0 failures.
  parity32: 65 checks, 0 failures. parity31: 63 checks, 0 failures.
  parity30: 179 checks, 0 failures. parity29: 62 checks, 0 failures.
  parity28: 128 checks, 0 failures. parity27: 27 checks, 0 failures.
  parity26: 62 checks, 0 failures. parity25: 203 checks, 0 failures.
  parity21: 203 cases, 194 match, 9 diffs — exactly the known 9
  (sd_tld_delete, sd_tld_delete_used, sd_tld_delete_notfound,
  sd_reg_available, sd_guest_tlds, sd_guest_tlds_reg, sd_guest_tlds_trans,
  sh_guest_free_tlds_fallback, dl_admin_send_file_missing_stored).
- Fixtures: php 13/13; next 13/13 on the re-run (see incident below).
- Accounting: exit 0 — catalog 579, TS-resolving 548, removed 31,
  deferred 0, sum 579.
- Reference invariants clean before AND after: invoice 323,
  client_order 11, email_queue 67 (5 pending + 62 sending),
  service_custom 17, extension 6 / meta 3, setting 38, admin 2,
  admin_group 3, admin_group_member 1, currency 1, client 3,
  support_ticket 2, tld 1, activity_client_email 0, invoice_event
  776, client_order_meta 0, cart 283 / seq 305, rate_limit_counter 0,
  last_cron_exec absent, invoice_overdue_invoked 2026-10-24 05:31:25,
  config hash 6e3c529673c1d089.
- End state: :8081, :18025, :18026, :3003 all DOWN; :8080 dev and
  :3001 reference answering.

### Incident during this regression (disclosed, fixed, verified)

The first fixtures-next run scored 5/13 because the reference :3001
was left running: `run-fixtures.py::start_next()` only waits for port
3001 to accept a connection, so its own next-server died with
EADDRINUSE while all API calls hit the reference server — while seeds
went to the disposable copy. The 8 failures were exactly the
seed-dependent fixtures (fixture-created clients/tax rules/promo/
balance invisible to the reference API); fixtures using only
pre-existing reference data passed. The run wrote 10 invoices
(479-488), 12 invoice items, 3 orders + 3 order statuses, 11 invoice
events, 11 queue rows, 1 transaction, and advanced
invoice_starting_number to 368 and cart seq to 308 in the reference
DB. Cleanup was backup-first
(`r5-logs/reference-before-fixture-cleanup-2026-10-30.sqlite`):
deleted exactly those rows (by fixture id ranges / today's
timestamps), restored invoice_starting_number to 358 (the first
fixture invoice took nr 358) and cart seq to 305 (max cart id 305),
then verified every invariant above. The re-run with :3001 killed
first scored 13/13, and the post-run invariant check is clean — the
reference DB state after the incident is identical to before it on
every asserted count, sequence, and hash. Lesson re-confirmed: kill
:3001 before any `--stack next` fixture run, no exceptions.
