# Findings — Phase 5 R3a: async `Db` interface + Postgres driver + seam conversion

Branch: `feat/nextjs-phase5-r1` on top of `da8b666` (R2e). **Uncommitted, unpushed.**
Scope: R3a only (r3-scope.md §1–§5). The importer is R3b; live Postgres+MySQL
verification is R3c (separate tap). No PHP sources touched. No behavior changes
smuggled in: every fix below is either a conversion artifact (code that was
correct sync and would have been wrong async) or a defect in the new R3a code
itself found by its own driver tests. No pre-existing behavior bug was found
that required the document-and-leave rule — had one been found, it would be
listed here with the code unchanged.

## 1. The `Db` interface (old call → new call)

`apps/nextjs/src/server/db.ts` now exports:

```ts
interface DbStatement {
  get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<{ changes: number }>;
}
interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): Promise<void>;
  insertAndGetId(sql: string, ...params: unknown[]): Promise<number>;
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
getDb(): Db; getDbWrite(): Db;   // selectors, still synchronous accessors
```

Driver selection (unchanged env contract): `FB_DATABASE_URL` present →
Postgres via `pg` `Pool` (`createPgDb()` in `pg.ts`); otherwise SQLite via
`FB_DATABASE_PATH` (`DbSqlite`, an async wrapper over the existing
`node:sqlite` code, stamp logic preserved exactly: read conn readOnly +
5 s timeout, write conn 5 s timeout, write conn NOT closed on read-stamp
change, `getDbWrite()` calls read first).

Mapping (mechanical unless noted):

| Old (sync) | New (async) |
|---|---|
| `getDb().prepare(s).get(...a)` | `await getDb().prepare(s).get(...a)` |
| `getDb().prepare(s).all(...a)` | `await getDb().prepare(s).all(...a)` |
| `getDbWrite().prepare(s).run(...a)` | `await getDbWrite().prepare(s).run(...a)` |
| `const info = getDbWrite().prepare(s).run(...a); Number(info.lastInsertRowid)` | `const info = await getDbWrite().insertAndGetId(s, ...a)` (then `Number(info)` kept as identity where present) |
| `getDb().exec(s)` / `getDbWrite().exec(s)` | `await … .exec(s)` |
| `BEGIN` / `COMMIT` blocks (3 sites, all in db.ts) | `withTransaction(async (tx) => …)` using ONLY `tx` inside |
| `findXById(…)` etc. db.ts helpers | same names, now `async`, awaited at call sites |
| `readSession / hasPermission / isSuperAdmin / buildAdminNavigation` (server helpers used by .tsx pages) | same names, now `async`, awaited in the 5 .tsx files that call them |

Counted surface converted: 47 `.ts` files by codemod + hand fixes (54 files
changed total incl. 5 `.tsx` pages, `package.json`, `package-lock.json`),
~604 `getDb()`/`getDbWrite()` uses, ~468 `.prepare(` calls, all 48
`lastInsertRowid` sites (via `insertAndGetId`), all 3 transaction sites.
`dispatch.ts` needed no change: `Handler` already allows Promise returns and
the `/api/fb` route already awaits. Route/dispatch surface untouched in shape.

Transactions: `pg` path checks out a `PoolClient`, issues BEGIN, runs fn on a
`DbPg` bound to that client, then COMMIT / ROLLBACK + release. Already-in-a-
transaction calls run fn inline (guard only; the seam has no nested sites).
SQLite path issues BEGIN/COMMIT/ROLLBACK on the write connection, same block
shape. Nesting is unsupported by design.

## 2. The Postgres implementation (`pg.ts`)

`translateSql(sql, params)` → `{ text, values }`: a segment scanner (code vs
string-literal / quoted-ident / comment / dollar-quoted) converts `?` → `$n`
in code segments only; rewrites LIKE → ILIKE and NOT LIKE → NOT ILIKE
(preserves SQLite's ASCII case-insensitive semantics); rewrites the two known
`datetime()` shapes (`datetime('now')` → `now()`; `datetime(X, '+' || Y ||
' hours')` → `(X + (Y || ' hours')::interval)`) and throws fail-fast on any
other `datetime(` shape or unterminated `datetime(`; asserts placeholder
count == params length. Boolean/bytea handling is by column context (table
alias map from FROM/JOIN; INSERT column-list → VALUES position mapping with
single-row and column/item-count assertions; UPDATE SET pairs; qualified and
unqualified comparisons):

- Boolean columns (registry from `postgres-column-types.json`, 51 columns /
  20 entity tables): literal `= 1` / `= 0` → `= TRUE` / `= FALSE` (SET,
  WHERE, VALUES); params coerced (`1`/`"1"`/`true`/`"true"` → true,
  `0`/`"0"`/`false`/`"false"` → false, null/undefined pass through).
- Bytea columns (`session[id, content]`, `activity_client_email[attachment_content]`,
  `email_queue[attachment_content]`): string params → `Buffer.from(str,
  "utf8")` (PHP stores the string's bytes, NOT hex-decoded); Uint8Array →
  Buffer. Reads come back as Buffer, which the seam already handles
  (`findSession` TextDecoder-decodes non-string content).
- Unresolvable columns (RedBean tables, no Doctrine metadata) are left alone:
  fail-fast via the Postgres error, never silently mistranslated.
- Boolean column names have NO non-boolean collisions anywhere in the entity
  schema (verified from the metadata dump), so name-based resolution is sound
  when every table in the query is an entity table; otherwise pass-through.

`normalizePgRow(fields, row)` maps by pg field OID: bool 16 → 0/1; int8 20 /
int2 21 / int4 23 / float4 700 / float8 701 / numeric 1700 → Number (idempotent
for already-numbers); timestamp 1114 / timestamptz 1184 → UTC
`"YYYY-MM-DD HH:MM:SS"` (Date or string input); date 1082 → `"YYYY-MM-DD"`;
json 114 / jsonb 3802 → stringify non-strings (TS code `JSON.parse`s both
`admin_group[permissions]` and `invoice_event[snapshot]`); bytea 17 and all
else pass through; null/undefined pass through. This is what makes pg rows
shape-identical to node:sqlite rows for the seam.

`insertAndGetId` asserts a plain single-row INSERT with a column list and no
existing RETURNING, trims a trailing semicolon, appends ` RETURNING id`,
throws if no id comes back.

## 3. Binding-type audit — conclusion: NO call site changed its binding type

This was the highest-risk part, so it was audited, not assumed. The audit
found that no call-site change is needed, for three measured reasons:

1. **SQLite adapter path is byte-identical.** `DbSqlite` passes the same JS
   values to the same `node:sqlite` statements. The R1 TEXT-affinity `"1.0"`
   quirk workaround (bind strings into TEXT columns) is preserved untouched
   on this path — every parity suite below runs against it and is green.
2. **pg infers from column context.** Installed `pg@8.23.1` (`lib/utils.js`
   `prepareValue`) stringifies values and sends them as unknown-typed params,
   so Postgres infers types from the column: strings into integer columns and
   numbers into text columns both work. The hard failures are literal `= 1` /
   `= 0` on boolean columns (`boolean = integer` has no operator) and bytea
   bindings — both handled inside the translator (§2), never at call sites.
3. **The only binding-shaped changes are inside the translator**, not at call
   sites: boolean literal rewrites, boolean param coercion, bytea Buffer
   coercion. Every seam SQL statement was covered by the translator's
   analysis (no `?` inside string literals in TS SQL; no comma FROM joins;
   no `!=`/`<>` on 1/0; `IN (${...})` lists are still plain `?`s).

Residual risk (honest): pg-path binding behavior is proven by the driver
tests (§5) plus this analysis, NOT by a live server. Live pg binding
verification is R3c. If R3c finds a binding divergence, the fix belongs in
the translator registries, not in a sweep of call sites.

## 4. Conversion artifacts found and fixed (all would have been silent runtime bugs)

The codemod (`/tmp/codemod-r3a.mjs`, TypeScript AST) awaited statement calls
and propagated `async` to a fixpoint, but four classes need a human eye —
tsc cannot see three of them:

1. **`.map(async …)` returning Promise arrays (35 sites).** Fixed with
   `await Promise.all(…)` at every site: cart (239, 374, 1021, 1205, 1214,
   1899), email (137), emailer (137), invoice (409, 778, 1102, 2902),
   news (58, 72), order (179, 616, 1091, 1210), product (170, 225, 245, 257,
   274, 720, 934, 942, 950, 1163, 1192), servicedomain (851, 1125),
   servicehosting (733, 1003), support (155, 162, 234, 593, 676, 805).
   Includes named-function references tsc cannot see: `summaryArray`
   (invoice 407), `priceStartingFrom` (product 255, 718), `clientListArray`
   (client 169), `subscriptionArray` (invoice 1507), `gatewayRowToApiArray`
   (invoice 2205), `messageToApi` (massmailer 236), `staffArray` (staff 109),
   `cannedArray` (support 474). Verified sync and left alone: `taxArray`,
   `failedItemArray`, `historyToApi`, `queueToApi`, `pageArray`,
   `currencyToApi`, `decodeFieldRowForForm`, `metaToApi`, `registrarToApi`,
   `hpToApi`, `helpdeskArray`, `kbCategoryArray`, `toApiArray`, `Number`,
   `String`, `Boolean`, `sortedJson`, `csvCell`, `phpJsonEncode`,
   `assocConvert`, `isNumeric`.
2. **`.filter(async …)` — always truthy (4 sites, all would have kept every
   row).** Restructured, preserving short-circuit evaluation and throw
   behavior: cart 1612 (promo eligibility → async map to p|null + non-null
   filter); invoice 2853 (transaction ownership → sequential loop);
   staff 229 (last-super-admin count → counting loop; the async version
   would have counted ALL admins, so the guard could never fire);
   staff 466 (group members → sequential loop + `Promise.all(map)`).
3. **Vacuous `await f()!` (7 sites).** `await f()!` parses as `await (f()!)`,
   asserting the *Promise* is non-null, not the resolved value — so
   `findProductById(…)!`, `findInvoiceById(…)!`, `findOrderById(…)!`,
   `findPromo(…)!` stayed possibly-undefined. Repaired to `(await f())!`
   (`/tmp/repair-bang.mjs`; runtime-neutral, `!` is erased).
4. **Stale `ReturnType<typeof …>` annotations (2 sites).** `resolveStaffBasket`
   (`NonNullable<ReturnType<typeof findClientById>>` — every staff-basket
   destructure inherited a Promise type) and email's `customer`
   (`ReturnType<typeof clientAdminArray>`) now use `Awaited<…>`.
5. **`.tsx` pages (5 files).** The codemod's file set was `*.ts` only, so
   pages calling newly-async helpers were missed: `readSession` awaited in
   staff groups `[id]`, system, currencies, stats pages and the admin
   layout; `isSuperAdmin` in groups `[id]`; `buildAdminNavigation` and two
   `hasPermission` calls in the layout. No other `.tsx` file imports a
   server helper (verified by grep).
6. **Wrapper callback types (5 sites).** `getService` params in
   servicedomain (4 wrappers) and servicehosting (1) widened to
   `| Promise<[…]>` and awaited at the call.
7. **Interface default row type.** Untyped `.get()` calls narrowed `unknown`
   to `{}` after truthiness guards (support kb_category_update). The
   `DbStatement` default is now `Record<string, unknown>` (matching
   node:sqlite's record shape); `SqliteStatement` casts params to
   `SQLInputValue[]` at the boundary.

Codemod bugs fixed during the run (in `/tmp/codemod-r3a.mjs`, not in repo
code): `async export function` (insertion before `export` instead of the
FunctionKeyword); `.prepare.insertAndGetId` (receiver vs PropertyAccess);
`await` pileups on chained calls (now parenthesized `(await foo()).bar`).

## 5. Defect in the new R3a code, found by its own driver tests, fixed in-batch

`pg.ts` `translateSql` INSERT and UPDATE blocks used regex group indices off
by one (INSERT regex has groups 1/2/3, code read 2/3/4; UPDATE regex has
groups 1/2, code read 2/3): any UPDATE through `DbPg` crashed
(`setBody.matchAll` on undefined) and any INSERT mis-mapped columns. Fixed
(groups corrected; both regexes now use the `/d` flag so VALUES/SET body
positions come from `m.indices`, not `indexOf` — `indexOf` misfires when the
body text appears earlier in the statement, e.g. a digit in a table name).
This defect never reached a parity run (parity uses the SQLite adapter) and
is exactly what the driver tests exist to catch. No other translator defect
was found: all 41 driver tests pass after the fix.

## 6. Driver tests (`apps/nextjs/scripts/driver-test.mjs`)

`node scripts/driver-test.mjs` — self-contained, exit non-zero on failure.
Compiles `pg.ts` + `db.ts` with the repo tsc to a scratch dir (removed in
`finally`), runs against `pg-mem`'s pg-compatible Pool, plus a real
node:sqlite file for the SQLite adapter. Result: **41 passed, 0 failed,
1 skipped.**

- §A translateSql unit tests (19): placeholders, `?` in string literals,
  count-mismatch throws, LIKE→ILIKE / NOT LIKE→NOT ILIKE, both datetime
  shapes + throw on unknown shape, boolean literal rewrites (single-table,
  qualified, UPDATE SET, INSERT VALUES), non-boolean literal untouched,
  boolean param coercion, bytea Buffer coercion, unknown-table pass-through.
- §B normalizePgRow synthetic-field tests (11): bool, int8, numeric,
  timestamp, date, json, jsonb, bytea passthrough, null, unknown OID.
- §C DbPg via pg-mem (5 + 1 skip): exec, `insertAndGetId` (RETURNING),
  get/all/run through `?` placeholders, ILIKE end-to-end (case-insensitive
  match proven: `ada%` matches both `ada lovelace` and `ADAM`), bool param.
  C6 (live pg) SKIPPED — `PG_TEST_URL` unset; the test accepts it for R3c
  reuse.
- §D withTransaction control flow (4): recording pool wrapper proves
  BEGIN…COMMIT…RELEASE on success and BEGIN…ROLLBACK…RELEASE + rethrow on
  failure (see limits below — this proves the sequence, not ACID effects).
- §E SQLite adapter transactions (2, real node:sqlite): commit persists,
  throw rolls back.

**What in-process Postgres proves and does NOT prove (read this before R3c):**

- PROVES: the translator's SQL rewriting, the normalizer's OID mapping
  logic, the DbPg query path (`?` → `$n` → pg Pool → rows), `RETURNING`
  inserts, transaction control-flow sequencing, SQLite adapter semantics.
- DOES NOT PROVE: real Postgres dialect behavior (pg-mem accepts a subset;
  e.g. its `::interval` handling was not exercised end-to-end — the interval
  rewrite is proven at unit level only); OID normalization through a real
  server (pg-mem returns `fields: []`, so §B uses synthetic fields);
  transaction ACID effects (pg-mem's Pool adapter accepts BEGIN but does
  NOT roll back — verified by probe: a rolled-back row stayed visible;
  hence §D asserts sequences, §E asserts real rollback on SQLite only);
  bigint precision past 2^53 (pg-mem returns JS numbers; real pg returns
  strings that `normalizePgRow` converts with `Number()` — lossy past 2^53
  on BOTH drivers, same as node:sqlite today, not a regression);
  any live-server behavior at all (auth, TLS, extensions, real planner).
- PGlite was NOT used: it cannot drive the `pg` Pool path (no pg-wire Pool
  adapter), so it cannot exercise the implementation under test. pg-mem was
  chosen because it can. A PGlite smoke would test PGlite, not this driver.

## 7. Gates (all against the SQLite adapter, fresh build, exit codes checked)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean (0 errors) |
| `npm run build` | clean (exit 0) |
| Driver tests | 41 passed, 0 failed, 1 skipped (live pg → R3c) |
| parity29 (R2e) | 62 checks, 0 failures, ALL GREEN (invariants-after ok, settings-final-restored ok) |
| parity28 (R2d) | 128 checks, 0 failures |
| parity27 (R2c) | 27 checks, 0 failures, ALL GREEN |
| parity26 (R2b) | 62 checks, 0 failures, ALL GREEN |
| parity25 (R2a) | 203 checks, 0 failures, ALL GREEN |
| Fixtures, PHP stack | 13/13 PASS (results-php.json, zero non-PASS) |
| Fixtures, Next stack | 13/13 PASS (results-next.json, zero non-PASS) |
| parity21 | 203 cases, 194 match, 9 diff — **the exact known 9**, verified by name (see §8) |
| DB invariants | clean before AND after (invoice 323, client_order 11, email_queue 67, support_ticket 2, client 3, admin 2, admin_group 3, admin_group_member 1, service_downloadable 0, setting 38, servicedomain_last_sync 2026-10-26 03:24:56) |

Servers during gates: PHP (`PHP_CLI_SERVER_WORKERS=4`, :8080, 200) and Next
(fresh build, :3001, TZ=UTC, 34-module list, `FB_CALLBACK_SALT` read from
runtime config at restart time, `__prime` 200). The fixture runner's
surviving `next-server` child was killed by PID after the Next run (PID
40686); the main Next was restarted before parity21. TS unauthenticated
smoke: `admin/client/get_list` without a session returns the 201
`Authentication Failed` envelope from the fresh build.

## 8. Divergences — none new

- parity21's 9 diffs are byte-identical in NAME to the pre-conversion known
  9: `sd_tld_delete`, `sd_tld_delete_used`, `sd_tld_delete_notfound`,
  `sd_reg_available`, `sd_guest_tlds`, `sd_guest_tlds_reg`,
  `sd_guest_tlds_trans`, `sh_guest_free_tlds_fallback`,
  `dl_admin_send_file_missing_stored`. No new diff appeared, none disappeared.
- parity25's tail shows `php=403 ts=200` lines: HTTP-status-only artifacts
  of the seam-wide convention (TS envelopes are always HTTP 200); parity
  compares envelopes, and the suite verdict is ALL GREEN.
- Standing divergences from R1/R2 (money.ts prepareInvoice NULL semantics,
  R2a guard precedence, nav JSON key order, R2d message wording, `{% set %}`
  unevaluated, invoice_starting_number server validation) are untouched.

## 9. Dependencies

- `pg@8.23.1` (dependencies — the production driver).
- `pg-mem@3.0.14` + `@types/pg@8.23.1` (devDependencies — driver tests and
  types only; pg-mem was moved out of dependencies after install).
- `package.json` is single-line in this repo (npm preserved its format);
  the lockfile change is the expected install output.

## 10. Left unverified / handoff to R3b and R3c

- **R3c (live, separate tap):** full parity suites against Postgres-backed
  Next (needs a live Postgres + `PG_TEST_URL` for the driver test's §C6);
  real MySQL→Postgres import run; live pg binding behavior (§3 residual);
  transaction ACID effects on a real server; `::interval` rewrite against
  real Postgres; bytea round-trip against real Postgres.
- **R3b (next build):** standalone importer script (live MySQL read-only
  user + `mysql2`, target schema from PHP `SchemaInstaller`, type mapping
  from `postgres-column-types.json`, refuse-on-mismatch, dry-run mode,
  session table skipped per D3-6, encrypted configs verbatim + same salt +
  decryptability sample per D3-7).
- Standing (unchanged): browser click-through of R2d/R2e forms; live eNom;
  Stripe live success; gated seo/serviceapikey/cookieconsent active paths;
  live currency refresh.
- Commit note for the parent: include `pg.ts`, `scripts/driver-test.mjs`,
  `postgres-column-types.json`, `r3-scope.md`, and this file. EXCLUDE the
  never-commit byproducts `docs/nextjs-strangler/phase4/ts_invoice1.pdf`
  and `docs/nextjs-strangler/phase5/parity21-diffs.json`. The diff is large
  (54 files, +4030/−3556, mostly `await`/`async` keywords plus the §4
  restructures).
- Scratch tools (not repo files, in /tmp): `/tmp/codemod-r3a.mjs`,
  `/tmp/apply-db-head.py`, `/tmp/repair-bang.mjs`, `/tmp/fix-callbacks.py`,
  `/tmp/fix-callbacks2.py`, `/tmp/dump-pg-schema.php`.
