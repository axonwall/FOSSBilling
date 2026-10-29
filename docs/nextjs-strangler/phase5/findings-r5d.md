# R5d findings — Config-driven timezone for stats (2026-10-29)

Batch: R5d of the approved R5 scope (`r5-scope.md` §2 R5d, decision R5-7).
Branch `feat/nextjs-phase5-r1`, on top of R5c (`82f9d56`). **Uncommitted.**
No PHP source touched. No commit, no push (parent commits).

## 1. Short version

TS stats now resolves its timezone as **env `TZ` > config `i18n.timezone` >
UTC**, resolved fresh per request through the R5a config store, and every
day-sensitive stats computation buckets in that zone. `parity37` proves it
live: **115/115** across UTC parity, America/Chicago config proof,
Pacific/Kiritimati env-override proof, and removed/invalid-config
fallback proof — including series x-values across both 2026 DST
transitions. The tz unit test is **29/29**. Full regression status:
see §7 (updated when the regression log lands — no count is claimed
before its run completes).

Two corrections to the brief's mental model, both proven from code and
live runs and both load-bearing for the suite design:

1. **PHP does not read config.php fresh per request in practice.**
   `Config::getConfig()` (`src/library/FOSSBilling/Config.php:25`) uses
   `include PATH_CONFIG`, so OPcache applies. The dev PHP server runs
   OPcache ON, revalidate_freq=2s, validate_timestamps=On. A config.php
   edit is NOT visible to all PHP workers immediately — reads right
   after an edit return stale values, and different workers flip at
   different times (proven: an America/Chicago edit still served the
   UTC series x-value immediately, and the Chicago x-value after 6s).
   Every config-flipping suite from here on must sleep past the window
   AND poll PHP until a TZ-sensitive read proves the new zone.
   (This fully explains capture40's contaminated first run, §6.1.)
2. **Summary counts are zone-sensitive only when the zone dates differ.**
   PHP summary boundaries are zone-midnight *strings* compared against
   stored wall-clock strings, so at 14:00 UTC — when UTC and Chicago
   share the calendar date Oct 29 — PHP-Chicago summary counts are
   IDENTICAL to PHP-UTC counts, correctly. The live TZ proof for
   summaries comes from the Kiritimati section (UTC+14: different date
   at most run hours) and from the tz unit test at fixed overnight /
   month-boundary instants. Series x-values, by contrast, differ
   between zones at ANY hour, and are the always-on live proof.

No PHP SQL-UTC vs PHP-TZ inconsistency was found: once OPcache
staleness is accounted for, PHP buckets by config TZ everywhere in
the stats service (see §2.3).

## 2. PHP TZ chain (code-read, then proven live)

### 2.1 Where the zone is set and read

- `src/load.php:343`: `date_default_timezone_set(Config::getProperty('i18n.timezone', 'UTC'))`
  on every request. This is the only load-time read site; all PHP date
  functions in the request then use the configured zone.
- `src/library/FOSSBilling/Config.php:53` `getProperty()`: missing key
  → default (`'UTC'` here); present-but-null → returns null
  (array_key_exists true). A null value would fatal PHP at load
  (TypeError on `date_default_timezone_set`) — TS falls back to UTC
  instead (§4; the dev page breakage is deliberately not mirrored).
- `src/library/FOSSBilling/i18n.php:233` `getTimezoneList()`:
  `DateTimeZone::listIdentifiers()`, sorted. `i18n.php:246`
  `validateTimezone()`: null/empty → null; non-empty unknown →
  InformationException (`Invalid timezone::tz`). Validation runs at
  settings validation, NOT at load — load uses the raw value.
- Reference config (`runtime/src/config.php` lines 43–50): `'i18n' =>
  ['locale' => 'en_US', 'auto_detect_locale' => true, 'timezone' =>
  'UTC', ...]`. Baseline config hash (sha256 first 16):
  `d6345cae63632b94`, asserted restored at the end of every suite.

### 2.2 Invalid / empty config value (proven empirically)

`date_default_timezone_set` with an invalid ID (tested `'No/Such_Zone'`)
or an empty string returns false with a Notice and leaves the default
(UTC) in place — the runtime's default TZ is UTC (verified via CLI:
`date_default_timezone_get()` = `"UTC"`). So PHP's *effective date
behavior* for a bad value is UTC. Side effect in this dev setup: the
Notice output breaks session start (headers already sent →
RuntimeException in the HTML), so PHP API calls fail here — in
production (display_errors off) PHP would return valid UTC stats. TS
therefore falls back to UTC for invalid/empty/non-string config, and
the suite asserts TS-invalid == TS-UTC rather than PHP equality there
(PHP is unmeasurable in dev for this case — documented, not hidden).

### 2.3 Stats service: day-sensitive vs TZ-insensitive

Read from `src/modules/Stats/Service.php` + `Api/Admin.php` (API layer
passes `$data` straight through for all stats endpoints):

- `getDayBoundaries()` (line 51): `new DateTimeImmutable('today')` in
  PHP-process TZ → `"Y-m-d H:i:s"` strings. `getSummary()` (68) and
  `getSummaryIncome()` (152) use `column >=:start AND column <:end`
  string bounds against stored `"Y-m-d H:i:s"` values. Stored values
  are config-TZ wall clocks (PHP writes `new DateTime()` in process
  TZ); TS writes `nowTimestamp()` = `toISOString()` = UTC — a WRITE-side
  TZ difference, surveyed but OUT of R5d scope (stats reads bucket
  stored strings; the suite crafts identical stored strings, so read
  parity holds regardless).
- `_getDateInterval()` (359): `strtotime('-1 month')` /
  `strtotime('+1 day')` in process TZ, preserving time-of-day; explicit
  `date_from`/`date_to` via `strtotime` (Y-m-d → process-TZ midnight;
  garbage → false → `date('Y-m-d', false)` = `1970-01-01`).
  `getRefunds()` (252) and `getIncome()` (289) use INLINE strtotime
  (not the helper); `getTableStats()` (375) and `getProductSales()`
  (210) use the helper.
- SQL bounds are `date('Y-m-d', $time)` calendar-date strings; `BETWEEN`
  on date-only strings is a string comparison, so rows on the end date
  itself never match (e.g. `'2026-11-03 00:00:00' > '2026-11-03'`). TS
  mirrors this exactly (same bounds). SQL grouping truncates to the
  date-string prefix (`substr(col,1,10)`) — TZ-independent; only the
  flot series days and x-values are zone-sensitive.
- Flot series (`_genFlotArrayInt` 416 / `_genFlotArrayFloat` 432):
  do/while pushes then pops the final (== to) entry, so the series
  covers from+1..to-1; x-values are `$time * 1000` where stepping is
  `strtotime('+1 day')` = zone-CALENDAR stepping preserving wall time
  (NOT +24h epoch stepping — a naive +24h step drifts a day across a
  DST transition). TS mirrors this with zone-calendar stepping.
- TZ-insensitive endpoints (pure aggregates, no date math):
  `get_orders_statuses`, `get_product_summary`,
  `get_income_vs_refunds`, `client_countries`, `sales_countries`.
- Day-sensitive: `get_summary`, `get_summary_income` (boundaries),
  `get_product_sales`, `get_refunds`, `get_income`, `get_orders` /
  `get_clients` / `get_invoices` / `get_tickets` (tableStats windows +
  flot series).

## 3. TS day-sensitive inventory (old mechanisms, all replaced)

`apps/nextjs/src/server/modules/stats.ts` (278 lines, pre-fix) derived
every day boundary from process-local time:

- `midnightToday()` (`setHours(0,0,0,0)`), `dayBoundaries()` (today /
  yesterday / this_month / last_month via local midnights) — used by
  `get_summary`, `get_summary_income`.
- `parseTime()` (Y-m-d via `new Date(y, m-1, d)` local midnight; garbage
  → epoch 0), `dateInterval()` (default from = now−1month, to =
  now+1day, preserving time-of-day) — used by all series endpoints.
- `flotInt` / `flotFloat` (step `addDays` = local setDate, keys `fmtDate`
  local, x = local-midnight epoch).

The old header comment claimed "Day boundaries are server-local
midnights, matching PHP's `new DateTimeImmutable('today')` in the same
sandbox TZ" — true only while the process ran TZ=UTC, which is why
regression servers ran TZ=UTC. Post-fix, process TZ no longer affects
stats at all (except as the env override, by design — §4).

Non-stats audit (surveyed, NOT changed — scope is stats-only per
r5-scope §2 R5d; see §8 for the follow-up list):

- `modules/indexmod.ts:305-307`: uses `setUTCHours(0,0,0,0)` + epoch
  `+ (days+1)*86400000` — UTC-anchored duration math, NOT process-local
  calendar math; no change needed.
- UTC-anchored (toISOString, process-independent, no change):
  `cart.ts:346`, `invoice.ts:803/1596/1736`, `order.ts:428/442/455/495/
  508/522/556`, `product.ts:317`, `seo.ts:64`, `db.ts:228`
  `nowTimestamp()`; `cart.ts:1912-1915` cart_expire (UTC-midnight
  cutoff); `invoice.ts:2887/2891` date-range filter (`T00:00:00Z` /
  `T23:59:59Z`); `order.ts:152/163`, `indexmod.ts:70` fmtTs.
- Process-local calendar getters, OUT of scope (follow-ups):
  `twig.ts` `formatDateValue` (R5c's `format_date` uses process-local
  getMonth/getDate — email/PDF dates render in process TZ, not config
  TZ); `client.ts:373/603` birthday formatting via toISOString (UTC
  date slice — process-independent, noted).

## 4. Resolution precedence + env name + fix shape

### 4.1 Precedence and env name

The scope (R5-7) says "env override" but names no variable. **Chosen:
`TZ`** — the process standard, which Node's Intl already honors, and
the container convention behind the scope's "env override exists for
container-pinned processes" rationale. No TS code read any TZ env
before this batch. R5a's env>config precedent covers deployment
values; a timezone is a deployment value in exactly that sense.

Precedence, resolved PER CALL (per stats request), never cached —
this satisfies scope §1's "resolved once per process/request" read as
per-request, and is required for the suite's no-restart config flips
(the config store itself reads fresh every call, R5a):

**env `TZ` (if valid IANA) > config `i18n.timezone` (if string,
non-empty, valid IANA) > UTC.**

An invalid TZ env value falls through to config (treated as unset,
not a hard error); only IANA names are honored (PHP's `getTimezoneList`
= `DateTimeZone::listIdentifiers()`; Node validation via the
`Intl.DateTimeFormat` constructor throwing RangeError for unknown
zones).

Consequence worth stating plainly: the reference Next (:3001) runs
with `TZ=UTC`, so post-fix its stats resolve to UTC even if config
flips to Chicago — env wins by design. The config path is proven by
the TZ-unset :3002 instance. Later batches may choose to run :3001
without TZ so config drives it; :3001 is left exactly as it was
(TZ=UTC) by this batch.

### 4.2 New module `apps/nextjs/src/server/tz.ts`

- `isValidZone()` — Intl constructor probe.
- `resolveZone()` — the precedence above, via R5a's
  `getConfigProperty<string>("i18n.timezone", "UTC")` (fresh read).
- `zoneParts(tz, ms)` — formatToParts, hourCycle h23.
- `zoneOffsetMs()` — wall-as-UTC minus instant.
- `zonedTimeToUtcMs()` — offset iteration, max 4 rounds; converges
  except across a spring-forward gap, where guesses oscillate — taking
  the LATEST guess matches PHP's forward normalization; fall-back
  ambiguous times converge on the FIRST occurrence, matching PHP's
  strtotime. Gap-time caveat: in-suite inputs are midnights, current
  time-of-day, or explicit Y-m-d dates — never gap wall times — except
  a default-window run landing exactly in a spring-forward gap hour,
  which cannot happen for the October run dates.
- `zoneMidnightMs()`, `zoneMonthStartMs()`, `addZoneDays()` (calendar
  days via Date.UTC normalization, wall time preserved — NOT +24h
  epoch steps, so DST transitions step correctly), `addZoneMonths()`
  (JS Date.UTC overflow semantics, same as the old setMonth code;
  stats uses day-1 anchors where no overflow can occur),
  `formatZoneDate()` / `formatZoneDateTime()`, `parseZoneDateTime()`
  (Y-m-d → zone midnight; Y-m-d H:i:s or T separator → that wall time
  in zone; else null → caller falls back to Date.parse / epoch 0).
- Old process-local helpers (`pad`/`fmtDate`/`fmtDateTime`/
  `midnightToday`/`addDays`/`addMonths`) removed; no dead helpers left
  (grep-verified: no remaining references in stats.ts).

### 4.3 stats.ts conversion

Header comment rewritten (zone math, DST calendar stepping); imports
from `../tz`; `dayBoundaries(zone)` rewritten (zone midnight, zone
month start, zone addDays/addMonths); `parseTime(value, fallbackMs,
zone)` (zone parse, garbage → epoch 0, matching PHP's
false→1970-01-01 path — verified: Chicago zone-stepping from epoch 0
gives 1970-01-01 18:00 CST, matching PHP `strtotime('+1 day', 0)` in
Chicago); `dateInterval(ctx, zone)`; `flotInt`/`flotFloat(rows, from,
to, zone)`; every handler resolves the zone per request
(`get_summary`/`get_summary_income` via `dayBoundaries(zone)`; series
endpoints via `dateInterval` + zone flot; `get_product_sales` bounds
via `formatZoneDate`). SQL strings are byte-identical — only bound
VALUES change (zone-calendar strings).

### 4.4 DST dates (America/Chicago, 2026)

Spring forward Mar 8, 2026 (02:00→03:00 CST→CDT); fall back Nov 1, 2026
(02:00→01:00 CDT→CST, 25-hour day). Fall-window first-x values: UTC
1793404800000 (= 2026-10-31 00:00 UTC), Chicago 1793422800000 (=
2026-10-31 00:00 CDT), Kiritimati 1793354400s (= 2026-10-31 00:00 +14).
Chicago Nov 2 midnight CST is 25h after Nov 1 midnight CDT — the
calendar-stepping proof, asserted in the tz unit test.

## 5. Capture corpus (pre-fix)

`capture40.py` + `captures40/corpus.json` (clean re-run
`r5-logs/capture40b.log`; the first run was contaminated — §6.1).
Crafted rows (snapshot-restored): 11 invoices (paid, issued=1,
base_income=100; paid_at/created_at at run-date-relative straddles +
fixed DST times), 2 clients, 1 order, 1 ticket. Straddles (run date
2026-10-29): today_early 02:00 UTC (= Oct 28 21:00 Chicago — the key
straddle), today_mid 07:00 UTC (= 02:00 Chicago same day, control),
yest_early Oct 28 02:00 UTC, first_early Oct 1 02:00 UTC (month
straddle), prev_mid Oct 14 02:00 UTC; DST fall Nov 1 05:30/06:30/07:30/
08:30 UTC (= 00:30 CDT, 01:30 CDT first, 01:30 CST second, 02:30 CST);
DST spring Mar 8 07:30/08:30 UTC (= 01:30 CST, 03:30 CDT — 02:30 does
not exist).

Clean-corpus result: Chicago PHP-vs-TS (pre-fix) differ on ALL series
keys (run + DST fall + DST spring) — the divergence made visible —
while UTC PHP-vs-TS differ only on the pre-existing empty-map shape
(§6.3). Summary keys do NOT differ Chicago-vs-UTC on either stack,
correctly per §1 item 2 (same calendar date at capture hour).

## 6. Divergences and incidents (pinned, not hidden)

### 6.1 OPcache staleness — the batch's hard lesson (see §1 item 1)

First capture40 run: early calls in the Chicago run (get_summary,
get_summary_income, get_income/get_refunds fall-window) were stale-UTC
reads, later calls (get_invoices/get_tickets fall, everything spring)
were fresh-Chicago reads — now fully explained by per-worker OPcache
revalidation, not by PHP behavior. Fix applied to capture40.py and
parity37.py: sleep 6s after every config edit, then poll PHP
`get_invoices` fall-window until the first-x equals the expected zone
value (20 polls × 3s, else AssertionError). Suite rule going forward:
for R5d and any later config-flipping suite, never trust an oracle
read until the probe proves the zone. The brief's "PHP reads config.php
per request" is CORRECTED: per request SUBJECT TO OPcache revalidation
(≤2s staleness per worker + worker spread).

### 6.2 Summary same-date behavior (§1 item 2)

Not a bug on either stack: PHP-Chicago summary == PHP-UTC summary at
capture hour because both zones share the date. The suite proves live
summary movement only where dates actually differ (Kiritimati
section) and proves boundary computation at overnight/month-boundary
instants in the tz unit test. Any future reader confused by "summary
didn't move under Chicago" should read this section first.

### 6.3 Empty keyValue map: PHP `[]` vs TS `{}`

Pre-existing, NOT TZ-related, differs under UTC too (visible in the
clean corpus: UTC PHP-vs-TS differing keys are exactly the two
get_product_sales DST windows, both empty-map cases). parity37
normalizes [] vs {} for empty maps with a comment, and does NOT fix
it — changing TS keyValue's empty shape would alter all keyValue
endpoints and is out of R5d scope.

### 6.4 PHP invalid-config Notice + UTC-effective behavior (§2.2)

Documented, not mirrored: TS falls back to UTC; PHP's page breaks in
dev (headers-sent) while its date behavior is still UTC. parity37
section D asserts TS-invalid == TS-UTC, not PHP equality.

### 6.5 Env-wins consequence for :3001 (§4.1)

By design (R5-7 precedence), a TZ=UTC :3001 keeps UTC stats even when
config flips. This is not a divergence to fix; it is the override
working. The config path is proven by the TZ-unset :3002 instance.

### 6.6 parity37 first-run suite bug (not a product bug)

The first parity37 run passed sections A–D(removed) 23/23 each, then
crashed on the INVALID sub-section: after the removed-key step deleted
the timezone line, the INVALID replace was a no-op and tripped its
assert. Fixed in the suite (INVALID inserts the line into the i18n
block when absent). The crashed run's finally-restore still worked
(config hash OK, invariants OK, :3001 prime 200). Full re-run:
115/115 (§7).

### 6.7 No SQL-UTC vs PHP-TZ inconsistency found

The brief's worry — PHP stats SQL using SQLite `date(column)` (UTC)
while PHP's "today" window comes from configured TZ — does not
materialize: the service's SQL grouping truncates stored strings
(TZ-independent) and all bounds/windows come from PHP-process-TZ date
functions. Once OPcache is accounted for, PHP buckets by config TZ
everywhere. TS mirrors the actual behavior, not the idealized one.

## 7. parity37 results + regression

### parity37 (115 cases; each read_stack = 2 summary + 7 endpoints × 3 windows = 23)

- A utc (config UTC, PHP vs :3001 TZ=UTC): **23 pass, 0 fail**.
- B chicago-config (config Chicago, PHP vs :3002 TZ unset): **23 pass,
  0 fail** — THE fix proof (pre-fix TS matched UTC everywhere).
- C env-override (PHP-Kiritimati oracle vs :3002 TZ=Kiritimati with
  config Chicago): **23 pass, 0 fail** — env wins, incl. live summary
  buckets (Kiritimati date differs from UTC's at run hour). No
  Kiritimati-midnight straddle occurred (0 skipped).
- D removed-key (config key removed, PHP vs :3002 TZ unset): **23
  pass, 0 fail** — absent key → UTC on both stacks.
- D invalid-config-ts-only (TS invalid config vs TS removed-key):
  **23 pass, 0 fail** — invalid → UTC fallback.
- **TOTAL 115 pass, 0 fail, 0 skipped.** Config hash restored to
  baseline, invariants clean, :3001 prime 200 after. Log:
  `r5-logs/parity37b.log` (first run `parity37.log`: A–D(removed)
  23/23 each, then the §6.6 suite bug).

### tz unit test

`apps/nextjs/scripts/tz-test.ts` + `run-tz-test.mjs` (driver-test
precedent): **29 checks, 0 failures** — overnight + month-boundary +
DST fall/spring stepping (25h/23h gaps), Kiritimati date, parse
shapes, and all seven resolveZone precedence cases (P1–P7).

### Build / bundle proof

`npx tsc --noEmit` clean; `npm run build` exit 0; new code proven in
the production bundle by the distinctive string literal
`Invalid timezone:` (tz.ts runtime string) in
`.next/server/chunks/8268.js` (function names are minified).

### Full regression (parity37 ran FIRST; this ran after, :3001 restored)

Confirmed from `r5-logs/regress-r5d.log` (FAIL STAGES: 0):

- parity36 51/51, parity35 210/210, parity34 164/164, parity33 77/77,
  parity32 65/65, parity31 63/63, parity30 179/179, parity29 62/62,
  parity28 128/128, parity27 27/27, parity26 62/62, parity25 203/203
  (all exit 0).
- parity21 exit 0 at 194/203 with exactly the known 9 diffs by name
  (its tail shows the MATCH lines; the 9-diff standing result is
  unchanged).
- Fixtures 13/13 PHP, 13/13 Next (verified via results JSON files,
  not just summary lines).
- DB invariants clean (all 14 counts at baseline); config hash
  restored to baseline `d6345cae63632b94`.
- No old assertion needed updating: UTC results did not move
  (env TZ=UTC + config UTC → identical output), as the brief's
  expected-risk note required checking.
- Post-regression incident (environmental, fixed in-batch): the
  regress script's :3001 restart printed prime:500 because the
  fixture runner's orphaned next-server (PID 12974) still held :3001
  — the new instance died with EADDRINUSE (see
  `next3001-r5d-after.log`). Fixed by killing PID 12974 explicitly,
  verifying the port clear, and restarting the standard :3001, which
  now answers prime 200 (`next3001-r5d-final.log`, PID 13117). The
  regress script's restart step should kill orphans by PID before
  starting, if reused.

## 8. Left for later

- Non-stats TZ sites (§3): `twig.ts` `formatDateValue` (email/PDF
  dates in process TZ, not config TZ) is the real follow-up; write-side
  stored-timestamp TZ (PHP config-TZ wall clocks vs TS UTC
  toISOString) is a separate, larger question — reads are parity-proven
  here, writes are not harmonized.
- Per-user timezone columns (client/admin) are a rendering concern for
  client/admin pages, NOT for the admin stats queries in scope —
  documented boundary, not expanded into.
- Empty keyValue map PHP `[]` vs TS `{}` (§6.3) — a keyValue-wide
  shape decision for a later batch, not R5d.
- :3001 launch env: whether it keeps `TZ=UTC` (pinning stats to UTC
  regardless of config) or drops TZ (letting config drive stats) is a
  deployment decision for the parent — this batch leaves it untouched.
- Standing unverified-live items from prior batches are unchanged by
  R5d (gated seo/serviceapikey/cookieconsent active paths, Stripe
  success path, live eNom, R3c live Postgres/MySQL).

## Files changed (uncommitted)

- `apps/nextjs/src/server/tz.ts` (new, ~200 lines) — zone resolution
  + zone-calendar math.
- `apps/nextjs/src/server/modules/stats.ts` (rewritten day math;
  handlers resolve the zone per request; SQL strings unchanged).
- `apps/nextjs/scripts/tz-test.ts` (new) + `scripts/run-tz-test.mjs`
  (new) — 29-check unit test.
- `docs/nextjs-strangler/phase5/parity37.py` (new) — 115-case suite,
  four sections + :3002 choreography + OPcache gate.
- `docs/nextjs-strangler/phase5/findings-r5d.md` (this file).
- `docs/nextjs-strangler/phase5/capture40.py` + `captures40/corpus.json`
  (new) — pre-fix corpus (clean re-run).
