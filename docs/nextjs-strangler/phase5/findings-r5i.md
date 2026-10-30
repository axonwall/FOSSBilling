# Findings — R5i: security homes (R5-8, closes the last 3 deferred)

**Branch:** `feat/nextjs-phase5-r1` (above `a6b0f8c`, R5h antispam).
**Status:** built, verified, left uncommitted per the batch brief
(commit/push remain the parent's call). No PHP source modified,
`~/MEMORY.md` untouched.
**Result:** parity42 **73/73**; accounting re-derived **548 + 31 + 0
= 579** with exit 0; full chain green (parity41 130/130, parity40
120/120, parity39 212/212, parity38 86/86 with oracle, parity37
green, parity36 51/51, parity35 210/210, parity34 164/164, parity33
77/77, parity32 65/65, parity31 63/63, parity30 179/179, parity29
62/62, parity28 128/128, parity27 27/27, parity26 62/62, parity25
green, parity21 194/203 at the known 9 diffs, fixtures 13/13 both
stacks). Invariants clean after: queue 67 (5 pending + 62 sending),
client 3, admin 2, groups 3, members 1, cart 283/seq 305, counters 0,
config hash `6e3c529673c1d089`, extension_meta 3 (no mod_antispam
row), reference Next :3001 answering, :8081/:18025/:18026/:3003 all
down at batch end.

## 1. PHP survey (all from code; pinned by capture45.py + captures45/)

### 1.1 Endpoint identities

All three are `admin` role, `security` module
(`src/modules/Security/Api/Admin.php`):

- `ip_lookup` (Admin.php:19): `#[RequiredParams(['ip' =>
  'You must specify an IP address to lookup.'])]`, then
  `checkPermissions('security', 'view')`, then
  `Service::lookupIP($data['ip'])`. No service-layer re-check.
- `run_check` (Admin.php:43): `#[RequiredParams(['id' =>
  'You must specify a check ID to run.'])]`, then
  `checkPermissions('security', 'run_checks')`, then
  `Service::runCheck($data['id'])`. The service re-checks
  `run_checks` (`checkPermissionsAndThrowException`) — TS
  collapses both layers to the single seam guard entry
  (`guards.ts`: `admin/security/run_check` →
  `[["security", "run_checks"]]`), per the R5 scope.
- `run_checks` (Admin.php:49): `checkPermissions('security',
  'run_checks')`, then `Service::runAllChecks()` (which also
  re-checks). TS guard: `[["security", "run_checks"]]`.
- `ip_lookup` guard: `[["security", "view"]]`.
- `list_checks` (already ported, guard `security.view`) is the
  reference for the check metadata order/names; it is unchanged.

Permission denial shapes (proven by capture45 on crafted staff):
no `security.access` → dispatcher gate `You do not have access to
the security module`, code 725 (HTTP 200 envelope on PHP);
`access` without the key → `You need the "security.view"
permission to perform this action` / `You need the
"security.run_checks" permission to perform this action`, code
403 (PHP returns real HTTP 403; TS returns the HTTP-200 envelope
with code 403 — seam convention, envelopes compared, never HTTP
status, except the R5g 429). Unauthenticated admin call → 201
`Authentication Failed` on both stacks; a client-role session
calling the admin role → 201 on TS (gate 1).

### 1.2 ip_lookup semantics

`Service::lookupIP` (Service.php:146): `filter_var($ip,
FILTER_VALIDATE_IP)` fails → `\InvalidArgumentException('The
provided input was not a valid IP address.')` → envelope 9999.
Returns `{ip: {address, type IPv4|IPv6}, country, asn}` where
`type` is IPv4 iff `FILTER_VALIDATE_IP` with `FILTER_FLAG_IPV4`,
else IPv6 (so `::ffff:8.8.8.8` is IPv6). Country via
`di['geoip']->country($ip)` (`GeoIP/Reader.php` `country()`:
`$record['country'] ?? []` → `Country` object; missing
`iso_code` or unknown ISO code → `IncompleteRecord` → `[]`).
ASN via `Reader::getAsnDatabase()` + a fresh `Reader` per call
(`asn()`: `$record` → `ASN` object; either key missing →
`IncompleteRecord` → `[]`). Only `IncompleteRecord` is caught:
any other exception (e.g. a missing database file) propagates
and surfaces as the sanitized generic 9999 (see §3).

Country object (`GeoIP/Country.php` `jsonSerialize`): `{name,
flag, currencies}` — name is the CLDR region name in the config
locale (default `en_US` → English; ext-intl missing →
fallback to the ISO code), flag is the regional-indicator pair
computed from the ISO letters, currencies is the
`CountryAlpha2::getCurrenciesAlpha3()` list. NOTE: the CC0
country record itself carries ONLY `iso_code` (no names) — the
name/currencies come from the standards library, not the DB.
ASN object (`GeoIP/ASN.php`): `{asnNumber, asnOrg}`.

Database files (`GeoIP/Reader.php` `getCountryDatabase()` /
`getAsnDatabase()`): `PATH_LIBRARY/FOSSBilling/GeoIP/Databases/`
+ `CC0-Country.mmdb` (6,534,834 bytes, ~6.2 MiB) +
`PDDL-ASN.mmdb` (8,806,141 bytes, ~8.4 MiB) — 15.3 MB total,
auto-downloaded from HostByBelle IP-Geolocation-DB GitHub
releases when missing or over 7 days old
(`updateDefaultDatabases()`; download failure → logged
exception, not a lookup error). PHP reader library:
`MaxMind\Db\Reader` (maxmind-db/reader, Composer). No result
caching in PHP: the ASN reader is constructed per call, and
the country reader is per-request (each API call is one
request).

DB-decided behaviors (capture45 — never assume these):
- `127.0.0.1`, `10.0.0.5`, `::1` → country `[]`, asn `[]`.
- `192.168.1.1` → country Australia/AUD, asn `[]` (the country
  DB maps this private range; the ASN DB does not). Private IPs
  are NOT uniformly empty — the DB decides, and TS reads the
  same DB files, so it agrees exactly.
- `8.8.8.8` → United States / [USD, USN] / 15169 GOOGLE;
  `1.1.1.1` → Australia / [AUD] / 13335 CLOUDFLARENET;
  `2001:4860:4860::8888` → United States / [USD, USN] / 15169
  GOOGLE; `::ffff:8.8.8.8` → `[]` / `[]` (the reader does not
  normalize mapped addresses to a v4 hit).
- Missing param → `You must specify an IP address to lookup.`
  9999; empty-string param → the SAME message (RequiredParams
  treats `''` as missing); invalid input → `The provided input
  was not a valid IP address.` 9999.

### 1.3 The run_check / run_checks framework

Registry: `getAllChecks()` (Service.php:62) scans
`src/modules/Security/Checks/*.php` via Finder — exactly four
checks, confirmed from the directory listing (no fifth check
exists to port): `dangerousFunctions`, `generalCheck`,
`phpVersion`, `webserver`, each implementing
`SecurityCheckInterface` (`performCheck` / `getName` /
`getDescription`). Finder order is alphabetical, matching the
TS static registry order and the already-ported `list_checks`
order: dangerousFunctions, generalCheck, phpVersion, webserver.

Result shape (`SecurityCheckResult::jsonSerialize`):
`{result: 'passed'|'warning'|'failed', message}`.
`runCheck` (Service.php:116) JSON-round-trips the result and
attaches `id` ONLY (no `name`); `runAllChecks`
(Service.php:92) attaches `id` + `name`. Unknown id →
`InformationException('The check :checkName: does not exist.')`
with the input substituted (no quotes around it).
Non-implementing class → `'The check :checkName: does not
seem to be a valid check.'` (unreachable in practice: all
four implement the interface; TS has no equivalent path, and
none is fabricated). Case sensitivity: `run_check('GeneralCheck')`
→ `The check GeneralCheck does not exist.` — PHP class names
are case-insensitive in principle, but the Composer PSR-4
autoloader resolves `GeneralCheck` to `GeneralCheck.php`,
which does not exist (the file is `generalCheck.php`), so
lookup is effectively case-SENSITIVE. TS matches: exact-match
registry keys only.

Per-check logic (read line by line, not from names):

- **generalCheck** (`Checks/generalCheck.php`): seven config
  probes in order, status = max severity (okay 0 < warn 1 <
  fail 2), message lines `- <text>\n` in probe order, empty
  message → `No detected issues.`:
  1. `security.perform_session_fingerprinting` false → warn
     `Warning: Prevention against session hijacking is disabled.`
  2. `security.force_https` false → FAIL `Fail: HTTPS is not
     enforced.`
  3. `api.CSRFPrevention` false → warn `Warning: CSRF
     prevention is not enabled for the API.`
  4. `twig.debug` true → warn `Warning: Debug mode is enabled
     for the Twig templating engine.`
  5. `debug_and_monitoring.debug` true → warn `Warning: Debug
     mode is enabled for your FOSSBilling installation.`
  6. `update_branch !== 'release'` → warn `Warning:
     FOSSBilling is configured to update to non-release
     versions of FOSSBilling.`
  7. `Version::isPreviewVersion()` → warn `Warning: You appear
     to be using a non-release version of FOSSBilling.`
  `isPreviewVersion` (`Version.php:73`): preview =
  (`VERSION !== '0.0.1'` AND valid semver) ? false : true —
  i.e. the literal placeholder `VERSION = '0.0.1'` (present in
  BOTH the repo and runtime trees) IS preview. Reference
  result (capture45): `failed` with exactly three lines —
  Fail HTTPS + Warn debug-installation +
  Warn non-release, in that order.
- **webserver** (`Checks/webserver.php`): probe URIs
  `config.php`, `data/log/php_error.log`,
  `vendor/autoload.php`, each GET `SYSTEM_URL . uri`; a 200
  → FAIL with `:url: returned HTTP 200 when it shouldn't
  have.\n` per URI; empty → `All tested URLs were
  inaccessible.` + PASS. `SYSTEM_URL` (`src/load.php:365`) =
  scheme + config `url` with schemes stripped, where scheme =
  `https` iff `security.force_https` (load.php default TRUE)
  or the request is secure, else `http`. Reference result
  (capture45): `failed` with all three URIs returning 200
  (`http://127.0.0.1:8080/...`). Requires
  `PHP_CLI_SERVER_WORKERS=4` on the PHP side (single-threaded
  `php -S` deadlocks on the self-fetch).
- **phpVersion** (`Checks/phpVersion.php`): fetches
  `https://php.watch/api/v1/versions`, matches
  `PHP_MAJOR.MINOR` (8.3 on the reference): latest → PASS
  `PHP :version: is the latest version of PHP.`, secure →
  PASS `... isn't the latest, but is still supported.`,
  otherwise → FAIL `... is out of date and does not get
  security patches.`; ANY exception → FAIL `Failed to lookup
  PHP version status.` Reference result (capture45): the
  exception branch (sandbox TLS blocks php.watch).
- **dangerousFunctions** (`Checks/dangerousFunctions.php`):
  eight functions (`exec`, `passthru`, `system`,
  `shell_exec`, `` `` `` (backtick operator — `function_exists`
  is false for it, so it never lists), `popen`, `proc_open`,
  `pcntl_exec`), each WARN type. One found → `:function: is
  enabled, potentially being a security concern.\n` + WARN;
  otherwise the multi-line `The following PHP functions are
  enabled, potentially being a security concern:\n` + `- fn\n`
  per found function + WARN (the zero-found case builds that
  message too, then the PASS branch overrides it with `No
  potentially dangerous PHP functions were detected as
  enabled`). Reference result (capture45): `warning` listing
  seven functions (all but backtick), trailing `\n` included.

## 2. TS implementation (files changed, all under `apps/nextjs/`)

- `src/server/geoip.ts` (new): DB-dir resolution
  (`FB_GEOIP_DB_DIR`, else
  `$FOSSBILLING_PHP_SRC/library/FOSSBilling/GeoIP/Databases`),
  fresh `maxmind.open()` readers per lookup (no reader/result
  caching — matches PHP's per-call ASN reader + per-request
  country reader, including picking up a replaced DB file),
  country construction (iso_code only; unknown/missing iso →
  `[]`; name via `Intl.DisplayNames` with the config locale
  default `en_US`, falling back to the ISO code exactly as
  PHP does when ext-intl is unavailable; flag via regional
  indicators; currencies from `geoip-currencies.ts`),
  ASN construction (key-existence check mirroring PHP's
  `array_key_exists`), missing-file errors naming the file
  (country checked first, as in PHP's lookup order), corrupt
  DB → generic 9999 (mirroring PHP's uncaught
  `InvalidDatabaseException`).
- `src/server/geoip-currencies.ts` (new, generated): 246
  entries, ISO Alpha-2 → ISO Alpha-3 currency lists, DERIVED
  from the runtime vendor tree (PrinsFrank Standards
  `CountryAlpha2::getCurrenciesAlpha3()` match block resolved
  through both backed enums) by
  `~/scratch/fossbilling/r5-logs/extract-geoip-currencies.py`
  (asserts every case resolves; spot-checks US → [USD, USN],
  AU → [AUD]). No hand-written entries.
- `src/server/modules/security.ts`: trio registered with
  literal `register("admin", "security", ...)` calls (so the
  accounting script counts them); `list_checks` + rate_limit_*
  untouched; header comment updated (the old "NOT ported"
  claim removed). `generalCheck` reads config.php via the R5a
  config store with PHP-missing-key semantics (flag probes
  default falsy → branch fires, as PHP's direct array access
  with warning + null does; `update_branch` default `''` →
  warning, as `null !== 'release'` does); preview via
  `Version.php` `VERSION` parsed from the PHP tree (same
  constant PHP reads; unreadable → preview true, conservative
  warn). `webserver` uses SYSTEM_URL semantics (scheme from
  `security.force_https` with load.php's default TRUE — note
  this differs from generalCheck's missing-key-falsy rule, and
  each mirrors its own PHP code path; config `url` with
  schemes stripped; exactly one trailing slash ensured — a
  documented micro-normalization: the reference url already
  ends in `/`, so parity on the reference is exact, and the
  normalization only matters for a slash-less config url,
  where PHP would build a broken URL). Transport errors in
  the webserver fetch propagate as the generic 9999 (PHP's
  http_client throws; the check does not catch).
- `src/server/guards.ts`: three guard entries added
  (ip_lookup → security.view; run_check/run_checks →
  security.run_checks).
- `src/server/modules/system.ts`: one comment updated
  (R5i ported, no longer "belongs to R5i").
- `package.json` + `package-lock.json`: `maxmind@5.0.7`
  added (official MaxMind JS reader, same `.mmdb` format as
  PHP's `MaxMind\Db\Reader`; ships its own types). The
  `maxmind` package was NOT previously in the tree; `npm
  install maxmind@5.0.7` added 3 packages (maxmind + deps).
- `docs/nextjs-strangler/phase5/endpoint-accounting.py`:
  `DEFERRED` emptied to `set()` with an R5i comment; the
  script re-derives 548 + 31 + 0 = 579 with exit 0.

### 2.1 MaxMind decision (bundled vs runtime path)

DB sizes: CC0-Country.mmdb 6,534,834 bytes, PDDL-ASN.mmdb
8,806,141 bytes — 15.3 MB total. DECISION: read the PHP
tree's bundled DBs at runtime via `FOSSBILLING_PHP_SRC`
(overridable by `FB_GEOIP_DB_DIR` for tests and for R6
relocation), NOT vendored into git. Justification: (a) no
15.3 MB of binaries duplicated into git until R6 deletes PHP;
(b) single source of truth — TS and PHP read the SAME files,
so records agree byte-for-byte for every IP (proven by
parity42 across 14 IP shapes); (c) the missing-file error is
explicit either way. R6 CONSEQUENCE (recorded, not solved
here): when PHP is deleted, the `Databases/` directory must
be relocated (or vendored then) and `FB_GEOIP_DB_DIR`
pointed at it, or every ip_lookup fails with the
missing-file error. The same relocation note applies to
`Version.php` (generalCheck's preview read) — if the PHP
tree goes away, preview degrades to the conservative warn.

### 2.2 Retired-marker shapes (anti-fiction rule, R4c precedent)

Scope decides the form: `run_checks` still returns all four
entries, two retired-marked (omission was rejected — it
would break the admin security page contract that
`list_checks` already advertises). Shape: the normal
`{result, message, id}` / `{result, message, id, name}`
entries PLUS `retired: true`, with `result: 'failed'` (the
conservative non-pass — never a fabricated pass) and a
message starting `Retired:`:

- phpVersion: `Retired: PHP version checks have no meaning on
  the TypeScript server; there is no PHP runtime version to
  check.` (Returning PHP's 8.3.28, or Node's version
  relabeled as "phpVersion", would be fabricated — both
  rejected, as the scope's rejected alternative says.)
- dangerousFunctions: `Retired: PHP function availability has
  no meaning on the TypeScript server; there is no PHP
  function list to check.` (Mapping to Node's
  `child_process` APIs would be a reinterpretation, not a
  port — rejected.)

`run_check` on a retired name and `run_checks` agree (same
result/message/retired flag; `run_checks` adds `name`).
PHP's live values (phpVersion → failed-lookup on the
reference; dangerousFunctions → warning with seven
functions) are reference-only, never something TS claims.

## 3. Deviation table (TS vs PHP, as pinned)

| Case | PHP | TS | Note |
|---|---|---|---|
| phpVersion / dangerousFunctions | live values | retired-marked entries (`retired: true`, `result: 'failed'`, `Retired:` message) | Anti-fiction; scope-mandated form (§2.2) |
| ip_lookup missing DB file | constructor `InvalidArgumentException` propagates → sanitized generic 9999, filename hidden (proven by constructor probe: `The file "..." does not exist or is not readable.`) | explicit error naming the file: `GeoIP database file not found: <full path>` | R5-8 spec improvement, the one deliberate TS improvement over PHP |
| ip_lookup corrupt DB | `InvalidDatabaseException` propagates → generic 9999 | generic 9999 (reader open/get failures mapped) | Same observable outcome |
| Permission denial HTTP status | 403 → real HTTP 403; 725 → HTTP 200 envelope | HTTP-200 envelope, codes 403 / 725 | Seam convention; envelopes compared |
| webserver origin scheme edge | scheme = force_https OR request-is-secure | scheme = force_https only (TS has no request object in the check) | Diverges only when force_https=false behind a TLS proxy; reference (dev, http) agrees exactly |
| webserver trailing slash | raw concat (broken URL if config url lacks `/`) | exactly one trailing slash ensured | Micro-normalization; reference url ends in `/`, parity exact |
| Temp-list-style caching | per-request country reader, per-call ASN reader | fresh readers per lookup | Same observable behavior, incl. DB replacement pickup |
| Country name locale | ext-intl CLDR names, config locale | `Intl.DisplayNames` CLDR names, config locale | Same CLDR family; parity42 asserts the `en` path on the reference |
| All other ip_lookup / generalCheck / webserver values | — | match exactly | incl. DB-decided private-range records, exact messages, trailing newlines, case-sensitive check ids |

## 4. Capture corpus (capture45, 2026-10-30)

`capture45.py` + `captures45/` (37 captures + manifest).
Method: dev :8080 only (no prod oracle — no trio behavior
differs by environment; webserver probes the config url on
both stacks). Crafted staff (bcryptjs hashes, parity28
pattern) deleted in finally with their groups/memberships;
baseline admin 2 / groups 3 / members 1 verified at end. No
DB file renamed or deleted (missing-DB behavior proven by
the constructor probe + code, §3, never by touching the
reference DBs).

Observed on PHP (exact texts/codes): ip_lookup missing /
invalid / empty messages; loopback/private/public/v6/mapped
records (including the 192.168.1.1 → Australia surprise and
the mapped-address `[]`); run_check all four (generalCheck
FAIL + 3 lines; webserver FAIL + 3 URLs; phpVersion
failed-lookup; dangerousFunctions warning + 7 functions);
unknown-id + case-variant errors; run_checks full map order;
list_checks; permissions (nosec → 725, access-only → 403
view/run_checks, view-only → ip_lookup/list OK + run_* 403).

Code-only (NOT observable live; never faked): the
non-implementing-class error shape (all four checks
implement the interface); webserver transport-error
propagation (origin reachable on the reference); corrupt-DB
behavior (constructor probe + code, §3).

## 5. Parity42 (73 checks, all passing)

Sections: (i) ip_lookup parity per IP class (14 shapes +
two DB-decided spot assertions), TS vs PHP full-shape
equality; (ii) missing-DB errors via a suite-owned :3004
with `FB_GEOIP_DB_DIR` pointed at scratch dirs (empty dir →
names CC0-Country.mmdb; country-only dir via symlink →
names PDDL-ASN.mmdb); (iii) run_check per check (generalCheck
+ webserver exact-equal; retired shapes; unknown + case +
missing-id exact-equal); (iv) run_checks full-map parity
(order, names, generalCheck/webserver entries exact-equal,
retired entries present + marked); (v) permissions
(unauthenticated 201, client-role 201, crafted staff
nosec/access/view on BOTH stacks with exact envelopes);
(vi) accounting 548+31+0 exit 0; (vii) restore (all
invariants, config hash, ports down).

## 6. Incidents during the batch (stated plainly)

**TS URL bug in parity42 (suite bug, fixed, no product
impact).** The first parity42 run failed every TS call with
879 `Unknown API call api/admin/security/ip_lookup`: the
suite's `call()` unconditionally inserted `/api/` into the
URL, but the TS seam path is `{base}/{role}/{module}/{method}`
with base already ending in `/api/fb` (parity41's
`ts_call` convention). Fixed by splitting `call()` (PHP)
from `ts_call()` (TS); the re-run passed. The running :3001
was the fresh R5i build all along (pid start time + Ready
log confirmed) — the 879 was purely the doubled path.

**Client-login bug in parity42 (suite bug, fixed).** The
second run crashed at the client-role permission check:
`login failed ... 'Check your login details'` — the
suite's `login()` hardcoded the `staff` module, so the
client login attempted a staff login with a client email.
Fixed with an `api` parameter (`client` for the client
login); the re-run passed 73/73. No residue from either
aborted run (finally ran; admin 2 / cart 283/seq 305
verified before each re-run).

## 7. R5i/R5j boundary

R5i touches ONLY the security trio + guards + the GeoIP
reader + the accounting script. R5j (installer) is
untouched: the `rate_limit_counter` installer delta from
R5g remains R5j's, and R5j must additionally decide the
GeoIP/Version.php relocation (§2.1) when it writes the
installer — the installer must ship or reference the
`Databases/` files, or ip_lookup breaks on a fresh TS-only
install. No file, handler, or config key in this batch
overlaps R5j's installer work.

## 8. What is left

- Live DB freshness/updates: PHP's `updateDefaultDatabases`
  (7-day refresh from HostByBelle) is NOT ported — TS reads
  whatever DB files are present. A TS-side refresh (or an
  operator step) is a follow-up candidate; until then, stale
  DBs serve stale records on both stacks identically (same
  files).
- Live Postgres/MySQL (R3c): still a separate tap; R5i logic
  is driver-independent (config file + filesystem reads).
- The webserver scheme edge (§3: force_https=false behind a
  TLS proxy) and the trailing-slash normalization are
  documented micro-divergences, not open bugs.
- Batch-end state: reference Next (:3001, TZ=UTC)
  answering; :8081, :18025, :18026, :3003 all down; DB
  invariants clean; config hash unchanged; no mod_antispam
  row; no commit, no push (Josh's taps).
