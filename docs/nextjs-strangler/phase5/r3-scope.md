# Phase 5 R3 scope — Postgres driver + MySQL importer (DRAFT, awaiting approval)

R3 is the Phase 5 database workstream (plan.md §R3, decision D5-3):
Postgres becomes the production driver behind `db.ts`, a one-way
importer moves existing 0.8.9 MySQL installs into Postgres, and SQLite
stays as the dev/test driver. R3 builds the driver and the importer;
it does not cut anything over — cutover is R6, and the TS installer
that will eventually own schema creation is R5.

## 0. Survey findings (measured 2026-10-28, before scoping)

These shape the batches below; R3 is bigger than plan.md's "mechanical"
suggests, in one specific way:

- **The seam is synchronous today, Postgres drivers are not.**
  `db.ts` (2513 lines) exports `getDb()` / `getDbWrite()` returning
  `node:sqlite` `DatabaseSync`. Counted call sites: 604
  `getDb()`/`getDbWrite()` uses across the server code, 468
  `.prepare(` calls in module files, 62 `lastInsertRowid`/`changes`
  uses, plus `BEGIN`/`COMMIT` transaction blocks in `db.ts`.
  There is no synchronous Postgres driver worth using (`pg-native`
  is unmaintained; a worker-thread `Atomics.wait` bridge is a hack).
  So R3a is an async conversion of the whole seam, not a driver swap.
- **The conversion surface is already async-compatible.**
  `dispatch.ts` types handlers as
  `(ctx) => unknown | Response | Promise<unknown | Response>`, and
  the `/api/fb` route already does `await handler(callCtx)`. No
  route or registry redesign is needed: handlers gain `async` and
  `await` at DB call sites, nothing else changes shape.
- **No driver deps yet, but they are obtainable.** `apps/nextjs`
  `package.json` has no `pg`/`mysql2` (only bcryptjs, next, react,
  zod). The npm registry is reachable from the sandbox
  (`pg@8.23.1` resolves), so `pg`, `mysql2`, and test tooling are
  installable.
- **No live servers in the sandbox.** No `psql`/`mysql` binaries,
  no Docker. A live Postgres+MySQL verification run cannot happen
  here; see D3-8 for how R3 verifies without one.
- **PHP can create the target schema — no hand-written DDL.**
  The sandbox's static PHP build carries `pdo_mysql` AND `pgsql`
  (plus `pdo_sqlite`, `intl`). Per the repo's own AGENTS.md, fresh
  installs generate schema from Doctrine entity metadata on every
  driver via `SchemaInstaller`, and `UpdatePatcher` keeps structure
  in sync additively. R3 therefore uses PHP's installer as a bridge
  to create the target Postgres schema; the importer is purely a
  data pump plus verification. The R5 TS installer later replaces
  this bridge.
- **Reference DB is 65 tables** (66th, `mod_massmailer`, appears
  only after that module activates). Importer scope is the 0.8.9
  table set, 725 columns per plan.md.
- **Standing quirks that interact with R3:**
  - node:sqlite's TEXT-affinity `"1.0"` storage quirk (R1) disappears
    on Postgres, which is strictly typed. R3a must audit binding
    types: call sites that today bind strings into numeric columns
    (the quirk workaround) need correct JS types under `pg`, or
    Postgres rejects them. The SQLite adapter keeps old behavior.
  - Encrypted extension configs decrypt with `info.salt`
    (`crypt.ts` proven in R1). The importer must handle them per
    D3-7, not silently copy undecryptable blobs.

## 1. Architecture

One async `Db` interface, two implementations, selected by env:

- `FB_DATABASE_URL` present → Postgres via `pg` `Pool`.
- Otherwise → SQLite via `FB_DATABASE_PATH`, an adapter wrapping
  the existing `node:sqlite` code with async wrappers (so the
  SQLite path keeps working for fixtures and dev).
- Placeholder conversion (`?` → `$1..$n`), type normalization,
  `RETURNING`-based inserts (replacing `lastInsertRowid`), and
  transactions (`BEGIN`/`COMMIT` via a checked-out client on `pg`,
  same block shape on SQLite) live inside the implementations, never
  at call sites. Call sites await one interface.
- Env naming is conventional (`FB_DATABASE_URL`); the SQLite path
  variable is unchanged.

## 2. Batches (order R3a → R3b → R3c)

### R3a — Async driver + seam conversion

- Introduce the async `Db` interface + SQLite adapter + `pg`
  implementation.
- Convert `db.ts` helpers and all module call sites to async/await.
  No behavior changes smuggled in: the conversion must be
  provably behavior-preserving (gate: full parity suites green
  against the SQLite adapter, unchanged results).
- Audit binding types at every converted call site (see §0 quirk).
- Driver tests against an in-process Postgres (PGlite — real
  Postgres compiled to WASM — or `pg-mem` if PGlite proves
  unsuitable): placeholder conversion, type round-trips
  (bigint, boolean, timestamp, text), transactions, `RETURNING`.
- Deliverable: seam runs on either driver; parity suites green on
  the SQLite adapter; driver tests green on in-process Postgres.

### R3b — One-way MySQL importer (standalone TS script)

- Script (not a server route): reads a live 0.8.9 MySQL install
  via `mysql2` with a read-only user, writes to the target
  Postgres (schema pre-created by PHP's `SchemaInstaller`, per
  D3-5), table by table in FK-safe order (FOSSBilling has no real
  FK constraints per AGENTS.md, but parent-before-child order is
  still kept for sanity and for any future constraints).
- Type mapping from MySQL `information_schema` column types plus a
  small override table derived from Doctrine metadata /
  `structure.sql` during the build (notably: Doctrine booleans
  stored as MySQL `tinyint(1)`, datetimes, and `bigint` ids — the
  AGENTS.md §id/FK note governs: ids/FKs are `BIGINT`, `?int`).
- Verification, per plan.md, non-negotiable: row counts per table
  AND money totals per money-carrying table (invoice, invoice
  items, client_balance, transaction, order totals — exact list
  specified in the R3b build), compared source vs target.
  **Refuse to proceed on any mismatch** (non-zero exit, report
  naming the table and the differing figure). No partial-import
  "close enough" mode.
- Rerun safety: refuse unless the target schema is fresh (created
  by the installer, zero data rows). No incremental, resume, or
  CDC mode in R3 — a failed import is re-run from a fresh target.
- Session table and encrypted configs per D3-6 / D3-7.
- Dry-run report mode: prints the counts/totals comparison without
  writing, so an operator can preview a migration.
- Deliverable: script + mapping tests + a deliberately-corrupted
  copy test proving refuse-on-mismatch actually fires.

### R3c — Live verification (separate tap, not part of R3a/R3b)

- Full parity suites against a Postgres-backed Next server, and a
  real MySQL→Postgres import of a non-trivial install, run where
  live servers exist. Needs Josh's endpoints or his infra (see
  D3-8). R3a/R3b ship sandbox-verified; R3c is the live proof, and
  its absence is disclosed, not papered over.

## 3. Decisions (D3-1..D3-8, recommended defaults)

- **D3-1 — One async `Db` interface, dual drivers (SQLite adapter
  + `pg`).** Recommended default. The alternative (sync bridge
  around an async driver) is rejected: unmaintained or hacky, and
  it would hide the async boundary the whole seam must eventually
  cross anyway.
- **D3-2 — Postgres driver package: `pg` (node-postgres).**
  Recommended default. Standard, `Pool` fits Next route handlers,
  best documented. (`postgres.js` is acceptable but not preferred.)
- **D3-3 — Importer host: standalone TS script in the Next app**
  (e.g. `apps/nextjs/scripts/import-mysql.ts`), sharing `crypt.ts`
  and money helpers. Recommended default. Alternative (PHP script,
  whose drivers are already present in sandbox PHP) is viable but
  rejected: the repo's future is TS, the importer shares the
  proven TS decryptor, and a PHP importer would be a second
  codebase to delete at R6.
- **D3-4 — MySQL source: live connection, read-only user, `mysql2`.**
  Recommended default, per plan.md ("read a live 0.8.9 MySQL
  install"). Alternative (mysqldump-file input) rejected: parsing
  dump SQL is fragile, and it answers a different question than
  the live migration operators will actually run.
- **D3-5 — Target schema: created by PHP's `SchemaInstaller`
  against the target Postgres.** Recommended default. No
  hand-written DDL in R3; the R5 TS installer replaces this bridge
  later. The importer verifies the target schema's table set
  matches the source's before copying.
- **D3-6 — Session table: NOT copied (forced logout on
  migration).** Recommended default. Sessions are ephemeral; a
  maintenance-window forced logout is standard, and it avoids
  carrying any compromised session across. Alternative (copy
  verbatim — the serialized format is DB-agnostic, so logins
  would survive) is available if Josh prefers continuity over
  the clean break.
- **D3-7 — Encrypted configs: copy verbatim, require the same
  salt, verify decryptability on a sample of encrypted rows,
  refuse on failure.** Recommended default. Re-keying during
  import is deferred to the R4/R5 secret store, which does not
  exist yet; silently copying undecryptable blobs is the failure
  mode this rule prevents.
- **D3-8 — Verification environment: build + sandbox-verify now,
  live run as a separate tap.** Recommended default. R3a/R3b
  verify in-sandbox (parity suites against the SQLite adapter
  proving zero behavior change, PGlite driver tests, importer
  mapping + refuse-on-mismatch tests); R3c runs when Josh
  provides a Postgres+MySQL pair or runs it on his infra.
  Alternative (block R3 until a live pair exists) is not
  recommended: it stalls most of R3 for its smallest part.

## 4. Explicitly NOT in R3

- SQLite removal (stays dev/test per D5-3; the fixture gate
  depends on it).
- R4 extension registry / theme deletion; R5 installer, cron
  completion, email transport, rate limiter (those workstreams
  only *use* the R3 driver).
- Session migration beyond the D3-6 call; secret re-keying (R4/R5).
- Incremental / resume / CDC import; non-0.8.9 sources; multi-
  tenant or sharded targets.
- Live gateway re-verification (unchanged standing items from R1).

## 5. Verification standard (per batch, same discipline as R1/R2)

- `tsc` + `next build` clean; new code landed (grep string
  literals, not minified function names).
- R3a gate: parity29/28/27/26/25 green against the SQLite adapter
  with results identical to the pre-conversion runs; parity21 at
  exactly the known 9; fixtures 13/13 both; driver tests green on
  in-process Postgres; DB invariants clean.
- R3b gate: mapping tests green; dry-run report format reviewed;
  refuse-on-mismatch proven by corrupted-copy test; fresh-target
  refusal proven; decryptability-sample check proven (including
  its failure path, with a wrong salt).
- No PHP source changes in R3a/R3b except invoking the existing
  `SchemaInstaller` as an operator step (documented, not committed
  as a code change). No commit/push without a separate tap.
