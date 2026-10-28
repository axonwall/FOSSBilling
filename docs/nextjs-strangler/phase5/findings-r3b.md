# Findings — Phase 5 R3b: one-way MySQL → Postgres importer

Branch: `feat/nextjs-phase5-r1` on top of `dc9726a` (R3a). **Uncommitted, unpushed.**
Scope: R3b only (r3-scope.md §R3b + §5). Live verification is R3c (separate tap).
No PHP sources touched. No server behavior changed: the batch adds two scripts
under `apps/nextjs/scripts/` + one devDependency; zero files under `src/` were
modified, and the production bundle contains no reference to `mysql2`
(verified by grep over `.next/server/` after a clean build).

## 0. What was built

- `apps/nextjs/scripts/import-mysql.ts` — the importer (pure TS, no framework).
  Run via `apps/nextjs/scripts/run-import-mysql.mjs`, which compiles it +
  its repo imports (`pg.ts`, `db.ts`, `crypt.ts`) with the repo tsc into a
  scratch dir and executes `main(argv)` (driver-test.mjs precedent).
- `apps/nextjs/scripts/import-test.mjs` — the test suite (see §7).
- `mysql2@3.24.6` in **devDependencies** (documented reason: the importer is
  an operator tool run from a checkout, never imported by app code; keeping
  it out of dependencies keeps the production install lean. The server
  bundle must never import it — verified, see above).

### Architecture (one Pool, two roles)

- Writes go through the R3a `Db` interface (`new DbPg(pool)` — the same
  implementation `createPgDb()` wraps; the singleton is not used because a
  script must be able to end its Pool, and `createPgDb()` exposes no end).
  Single-row INSERTs in one transaction (the R3a translator rejects
  multi-row VALUES by its column/item-count assertion, so batching would
  need translator work — a documented future optimization, not R3b scope).
- Verification reads go through the same Pool directly (raw `pool.query`),
  NOT through DbPg: DbPg normalizes numerics to Number, and money
  verification must compare exact decimal strings, never floats.
- Copy order is `TABLE_ORDER` (parents before children). FOSSBilling has no
  real FK constraints, so the order is advisory — it keeps reports readable
  and stays valid if constraints ever appear.

## 1. Type mapping (MySQL → Postgres, via the seam's JS values)

The importer does NOT map MySQL types to Postgres DDL (the target schema
comes from SchemaInstaller, §4). It maps MySQL *values* to the JS values the
R3a seam expects, driven by mysql2's driver config + per-column rules:

| Source (mysql2, configured) | JS value seen by the importer | Target write path |
|---|---|---|
| BIGINT (any) | string (bigNumberStrings: no 2^53 loss) | DbPg unknown-typed param → Postgres infers bigint from the column |
| DECIMAL | string (bigNumberStrings) | same → numeric; money math stays in strings (§3) |
| TINYINT/SMALLINT/INT | number | pass-through; boolean columns coerced by the R3a translator (boolean registry from Doctrine metadata) |
| DATETIME/DATE/TIMESTAMP | string `"YYYY-MM-DD HH:MM:SS"` (dateStrings: MySQL DATETIME is timezone-naive — converting through Date would silently shift values with the importer's local TZ) | string → timestamp |
| TEXT/VARCHAR/CHAR | string | pass-through |
| BLOB/VARBINARY | Buffer | pass-through ONLY for bytea columns (`activity_client_email.attachment_content`, `email_queue.attachment_content`); a Buffer for any other column throws ImportRefusal (fail-fast, never silently coerce) |
| MySQL JSON | parsed object/array | `JSON.stringify` (the seam stores JSON columns as strings) |
| NULL | null | pass-through |

Doctrine booleans stored as MySQL `tinyint(1)` need no importer-side rule:
the R3a translator already coerces 0/1 params for the 51 boolean columns
in its registry. RedBean tables need no rule either: the reference install's
65 tables are ALL Doctrine entities (verified: reference ⊆ entity dump, the
only entity table missing from the reference is the unactivated
`service_apikey`), so every copied table has Doctrine metadata behind it.
The R1 SQLite `"1.0"` TEXT-affinity quirk is irrelevant here: the importer
reads MySQL (declared types), never SQLite storage behavior.

Overrides (deviations from naive pass-through), all in `mapValueForInsert`:
- Objects/arrays → `JSON.stringify` (MySQL JSON columns).
- Date objects (defensive only; dateStrings should prevent them) → UTC
  `"YYYY-MM-DD HH:MM:SS"` string.
- Buffers for non-bytea columns → refusal (see table above).

## 2. Table order

`TABLE_ORDER` lists all 66 entity tables (asserted by test B1 against
`postgres-column-types.json` keys — set equality, not a count). Three
entries were initially written from memory and did not survive that check:
`coupon`, `invoice_setting`, and `client_order_service` do not exist in
the entity dump, in any PHP source, or in the reference DB (order-service
linkage is `client_order.service_id` + `service_type`, not a join table).
They were removed; a source containing any of them now refuses as an
unknown table (§5), which is the safe default.

## 3. Money totals (exact decimals, never floats)

Money totals are computed by reading the money columns (paged by id) on
each side and summing with exact BigInt-scaled decimal arithmetic in JS
(`normalizeDecimal`/`addDecimal`/`mulDecimal`/`sumDecimals`). SQL-side SUM
was deliberately NOT used: MySQL SUM(decimal) and Postgres SUM(numeric)
return different types, and pg-mem's SUM is unproven — JS summation from
raw column values is identical code on both sides and exact. Floats are
never involved (a float comparison with epsilon would be a "close enough"
mode, which the plan forbids).

| Table | Totals (labels) | Why |
|---|---|---|
| invoice | base_income, base_refund, credit, refund | Stored monetary accumulators. There is NO stored invoice total — totals are computed from items at read time (money.ts), so the total is covered via invoice_item below. |
| invoice_item | price, price_x_quantity | Line amounts; price×quantity is the computed-total input. |
| client_balance | amount | Client funds ledger. |
| transaction | amount | Gateway payment records (the actual payment table; `invoice_payment` does not exist in this install). |
| client_order | price, discount | Order value + discount applied. |
| subscription | amount | Recurring billing amounts. |
| promo_redemption | discount_amount | Promo value redeemed. |
| product_payment | once_price, once_setup_price | Catalog prices: static but monetary; catch decimal mapping errors. |
| product_payment_period | price, setup_price | Same. |
| tld | price_registration, price_renew, price_transfer | Same. |

19 totals across 10 tables. Deliberately EXCLUDED: `currency_rate` (a rate),
`taxrate` (a rate, and string-typed), `pay_gateway_product.external_price_id`
(an external string id, not an amount), invoice totals (computed, not stored).
Rates and ids are still covered by row counts + the type mapping; they are
not money. Totals are global sums (an integrity check, not a financial
report — cross-currency sums are meaningless as money but exact as figures).

## 4. Target schema: PHP's SchemaInstaller (D3-5, no hand-written DDL)

No CREATE TABLE statement exists in the importer. The target schema comes
from `SchemaInstaller::createSchema` (Doctrine metadata → SchemaTool), run
by the installer's `installPortable()` flow. Two corrections to the brief's
assumptions, both verified in the repo (not assumed):

- `src/install/sql/structure.sql` does NOT exist in this tree: it was
  removed at the cutover commit (SchemaInstaller's docblock says so; the
  file is absent from HEAD and only `content.sql` remains). The MySQL-type
  source for §1 is therefore the live `information_schema` at import time,
  not a frozen dump — which is strictly better (it describes the actual
  source install).
- The installer does NOT produce a schema-only target: `installPortable()`
  runs createSchema + `seedContent` (content.sql replayed portably) +
  `seedAdmin` + `setDefaultCurrency` + `seedInstallNudge`. Hence the
  seed-tolerant fresh rule in §5 — a schema-only target is not an
  installer-supported state, and requiring one would be operator-hostile.

## 5. Fresh-target rule (the design resolution)

**Rule: a target is fresh iff every table's row count is within its
installer allowance.** Allowances are the exact installer output:
content.sql counts (83 rows across 16 tables) + seedAdmin (admin 1,
admin_group_member 1) + seedInstallNudge (setting +1 → 35) = 86 rows.
`SEED_ALLOWANCE` in the script encodes this; every other table must be
EMPTY. The importer then truncates (DELETEs) every copied table inside the
copy transaction before copying, so allowed seed rows are replaced by
source rows — the check exists to refuse targets that look live, not to
bless partial seeds.

Refusal cases, all proven by tests (see §7):
- Any table above its allowance → refusal naming the table, its count,
  and the allowance.
- Any source table missing from the target → refusal naming it, with the
  hint for extension tables (e.g. `service_apikey`): activate the module
  on the target first (SchemaSynchronizer creates its table), then import.
- Any source table unknown to the importer (not in the 66 entity tables)
  → refusal naming it, rather than silently dropping data.
- Extra tables on the target are ignored (documented, harmless).

No `--force` exists. A refused run leaves the target untouched when the
refusal is pre-copy (fresh/unknown/missing/encrypted checks all run before
any write). A verification refusal AFTER the copy commits is different —
see §6.

## 6. Verification flow + the post-commit caveat (read this)

1. Pre-copy (target untouched on refusal): fresh check, unknown/missing
   table checks, encrypted-sample check (§8).
2. Dry-run mode (`--dry-run`): prints the plan + source totals vs current
   (seed-only) target totals, writes nothing (proven by before/after
   counts). Dry-run money rows render as "(planned)", never OK/MISMATCH —
   a mismatch in dry-run is EXPECTED (it is why the import exists).
3. Copy in ONE transaction: DELETE seeds + INSERTs + sequence resync.
4. Verification AFTER commit: row counts + all 19 money totals, exact
   decimal comparison. Any mismatch → non-zero exit + report naming the
   table and the differing figure(s).

**Caveat, stated plainly:** verification reads must see committed data,
so they run on a separate connection after the copy commits. A verification
refusal therefore leaves the target copied-but-UNVERIFIED. The report and
the CLI both say so, and the operator must restore a fresh target before
any re-run or cutover — an unverified target must never be cut over to.
The alternative (verifying inside the transaction through DbPg) would
force float money comparison (DbPg normalizes numerics to Number), which
would weaken the money check itself. Exactness was chosen over atomicity,
and the failure mode is explicit rather than hidden.

Sequence resync (after copy, inside the transaction): for each table,
`pg_get_serial_sequence` + `setval(seq, max(id))` so future inserts do not
collide with copied explicit ids. Guarded: null sequence skips the table;
an unsupported environment records a warning instead of failing the
import. Live-server behavior of this step is an R3c item (pg-mem has no
real sequences — the test asserts the warning path, not the effect).

## 7. Verification layers (a)–(d), with honest limits

No live MySQL or Postgres exists in the sandbox (no binaries, no Docker),
so no end-to-end import ran here. Nothing below pretends otherwise.

- (a) MySQL-read side: unit tests against a mock mysql2 connection
  (information_schema SQL shape + parsing, COUNT SQL, paged read SQL +
  params, mysql2 config flags). Proves the reader's logic, not a live read.
- (b) Full pipeline: fake in-memory source (money rows, booleans,
  datetimes, bytea-ish values, encrypted rows) → real mapper → real DbPg
  writer against pg-mem → real verifier (counts + all money totals +
  session skip + encrypted-verbatim). Proves mapper + writer + verifier
  end-to-end, with the source reader stubbed. Includes bytea round-trip
  through DbPg/pg-mem (passed, not skipped).
- (c) Refusals, each proven with a named failure: corrupted money value
  → refusal naming table + figure; deleted row → count refusal; business
  row / over-allowance target → fresh refusal; seed-exact target passes;
  right salt passes / wrong salt refuses / zero v2: rows is VACUOUS
  (explicitly not a pass) / missing salt with v2: rows refuses; dry-run
  leaves target counts unchanged; unknown source / missing target tables
  refuse; CLI `--help` exits 0, missing env exits non-zero naming the var.
- (d) R3c (live, separate tap): real MySQL→Postgres import of a
  non-trivial install; full parity suites against a Postgres-backed Next
  server; live pg binding behavior; sequence-resync effect on a real
  server; `pg_get_serial_sequence`/`setval` against real catalogs. Named
  here so (a)–(c) are never mistaken for it.

## 8. Encrypted columns survey (verified, not guessed)

Exactly two columns hold at-rest encrypted values (from TS decrypt call
sites + PHP Extension/Service.php:718/744):

- `extension_meta.meta_value` — extension configs (PHP encrypts on
  config_save, TS decrypts on config_get).
- `email_template.vars` — email template vars (TS emailDefaults.ts
  decrypts `row.vars` from `email_template`).

No other column is decrypted anywhere in the TS seam, and `pay_gateway`
config is stored as plaintext JSON (no decrypt call site). The sample
check (pre-copy, on SOURCE rows): up to 25 `v2:`-prefixed values per
column must decrypt with the configured salt (`FB_INFO_SALT`, falling
back to `FB_CALLBACK_SALT` exactly as `crypt.ts` resolves it). Non-`v2:`
values are counted and reported but NOT checked — they are either
plaintext or a legacy format, and verbatim copy preserves the seam's
behavior for them exactly. Zero `v2:` rows → status VACUOUS (the R2e
refresh lesson: a check with nothing to check proves nothing), never
"PASS". Test fixtures craft encrypted rows with `encryptV2` so both
directions are proven (right salt passes, wrong salt refuses) — a test
database with no encrypted rows would have made the check vacuous.

## 9. Operator steps (target creation + run)

1. Create an empty Postgres database + role. The import role needs
   SELECT/INSERT/DELETE/UPDATE on all tables and USAGE/UPDATE on
   sequences (setval); the installer run needs CREATE TABLE.
2. Run the PHP web installer against the Postgres database (choose the
   PostgreSQL driver, enter credentials, an admin account, and a
   currency). This runs `installPortable()`: SchemaInstaller schema +
   content.sql seeds + admin + default currency + install nudge = the
   fresh target (§5). The installer-created admin/currency are
   scaffolding — the import overwrites every copied table.
3. **Overwrite the target config.php's `info.salt` with the SOURCE
   install's salt.** Critical: the sample config generates a fresh random
   salt (`config-sample.php:62`, `bin2hex(random_bytes(16))`), so a
   fresh target's salt NEVER matches the source's. Skip this step and
   the encrypted-sample check refuses (the safety net working as
   designed) — and even with zero encrypted rows, a mismatched salt
   would break decryption after cutover.
4. Grant the MySQL user read-only access: `GRANT SELECT ON <source_db>.*`
   (information_schema visibility follows). Never use a write-capable
   MySQL user — the importer only SELECTs, and the grant should say so.
5. Export env (never in files): `FB_MYSQL_URL=mysql://<ro-user>:<pass>@<host>:<port>/<source_db>`,
   `FB_DATABASE_URL=postgres://...` (target), `FB_INFO_SALT=<source salt>`.
6. Dry-run first: `node apps/nextjs/scripts/run-import-mysql.mjs --dry-run`
   — review the plan and the "(planned)" money rows.
7. Run: `node apps/nextjs/scripts/run-import-mysql.mjs` — the report must
   end `verified: YES`. On `REFUSED`: do not cut over; restore a fresh
   target (re-run the installer into a clean database) and re-run.
8. Post-import (R3c, not R3b): parity suites against a Postgres-backed
   Next server before any cutover consideration (R6).

## 10. Gates (all observed, none claimed from backgrounded runs)

- `npx tsc --noEmit`: clean. `npm run build`: clean (exit code checked).
- Importer tests (`node apps/nextjs/scripts/import-test.mjs`):
  **55 passed, 0 failed, 0 skipped** (decimals, spec checks, pipeline,
  refusals, fresh rule, decrypt both directions + vacuous, dry-run,
  unknown/missing tables, mock-reader SQL, value mapping, bytea
  round-trip, CLI wiring).
- Regression (SQLite adapter, fresh build, seam untouched):
  parity29 **62/62 ALL GREEN**, parity25 **203/203 ALL GREEN**;
  fixtures **13/13 on BOTH stacks** (results JSON verified PASS).
- DB invariants clean before AND after every suite (setting 38 with
  id 52 = `2026-10-26 03:24:56`, currency 1 USD, extension_meta 3,
  invoice 323, email_queue 67, admin 2, groups 3, members 1).

## 11. Incident during verification (disclosed, repaired, verified)

Mid-verification, a runtime restart killed a parity29 run between its
interim settings restore and its `finally` full restore (the standing
lesson, re-learned the hard way: a killed run's finally never runs).
The reference DB was left with: setting rows intact as (param, value)
pairs but with reassigned ids (93+) and NULLed other columns; a stray
crafted EUR currency row (id 10); and a stray `mod_currency`
extension_meta row (id 40). All other invariants were untouched.
Repair (backup taken first, at `~/scratch/fossbilling/r3b-logs/
reference-before-r3b-repair-2026-10-28.sqlite`): the three affected
tables were restored exactly from the disposable snapshot
(`~/scratch/fossbilling/disposable/snapshot.sqlite`), whose setting
(param, value) set matched the damaged table exactly and whose
extension/extension_meta/currency rows matched minus the strays;
`sqlite_sequence` was restored to the snapshot values (setting 54,
currency 8, extension_meta 39) with duplicate sequence rows (an
INSERT-OR-REPLACE artifact — this build's sqlite_sequence tolerates
duplicate names) deduplicated to the latest row per name. Post-repair
invariants verified (see §10), then parity29/25 + fixtures re-ran green
on the repaired DB. Lesson recorded for future batches: parity logs go
under `~/scratch/` (persistent), not `/tmp` (wiped by restarts), and any
killed parity run must be followed by an invariants check + repair
before the next gate is trusted.

## 12. Left unverified / handoff to R3c and R3b-follow-ups

- **R3c (live, separate tap):** everything in §7(d). In particular the
  importer has never touched a real MySQL server (reader logic is
  mock-proven only) or a real Postgres server (writer is pg-mem-proven
  only, sequence resync is warning-path-proven only).
- R3b follow-ups (not blockers): multi-row INSERT batching (needs R3a
  translator support — single-row inserts are correct, just slower on
  very large tables); streaming reads (current reads page by id in
  1000-row pages, bounded memory — fine for realistic installs).
- Standing (unchanged): browser click-through of R2d/R2e forms; live
  eNom; Stripe live success; gated seo/serviceapikey/cookieconsent
  active paths; live currency refresh.
- Commit note for the parent: include `apps/nextjs/scripts/import-mysql.ts`,
  `apps/nextjs/scripts/run-import-mysql.mjs`,
  `apps/nextjs/scripts/import-test.mjs`, `apps/nextjs/package.json`,
  `apps/nextjs/package-lock.json`, and this file. EXCLUDE the never-commit
  byproducts `docs/nextjs-strangler/phase4/ts_invoice1.pdf` and
  `docs/nextjs-strangler/phase5/parity21-diffs.json`. Scratch logs from
  this batch live under `~/scratch/fossbilling/r3b-logs/` (not repo files).
