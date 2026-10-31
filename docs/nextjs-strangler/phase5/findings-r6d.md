# Findings — R6d: rollback artifact + cutover checklist

**Batch:** R6d, the LAST R6 batch (scope `r6-scope.md` §2 R6d,
decisions D6-1/D6-2/D6-5/D6-9). **DOCS-ONLY by necessity and
design:** no TypeScript code changed, no handler behavior
changed, no commit, no push, `~/MEMORY.md` untouched,
`runtime/` untouched (read-only greps/reads only — its
deletion is a SEPARATE later decision gated on D6-1's exit
criteria, which R6d states but does not execute).

**Central discipline (verify_against_real_output):** nothing in
this batch claims what the sandbox cannot do. The docker image
does NOT exist (no docker binary here — verified:
`command -v docker` empty). The staging drill did NOT run.
The live window did NOT run. R3c proof does NOT exist. Every
one of those is an INFRA-TAP item in `cutover-checklist.md`,
not a claimed fact. What R6d DOES prove, with real output,
is: the artifact's inputs are complete and correct (§1), the
forward-only data claims hold (§2), the checklist drops no
gate (§C of parity47), and the deployment notes are true
against live servers (§D of parity47).

## 1. Artifact-input verification (the batch's real proof work)

Verification worktree: `~/scratch/fossbilling/r6d-rollback-worktree/`
(created with `git worktree add … 51abaf1`; OUTSIDE /tmp, which
is a 512M tmpfs wiped by restarts; removed by parity47 §F after
verification — it is scratch, not a deliverable).

| Input | Result |
|---|---|
| Parent commit (first parent of R6c `208d7ca`) | `51abaf1`, full SHA `51abaf1ef5747e84a503a39d9f99e4b238c7eef6`; worktree HEAD verified equal; worktree clean |
| Parent Dockerfile stage list | php-base → composer-base → php-vendor / php-dev-vendor → frontend-assets → release-tree → release-artifact → runtime → test — EXACTLY the scope §0.7 list |
| `release-artifact` stage | `FROM scratch` + `COPY --from=release-tree /app/src /` — the PHP + Composer vendor + built frontend assets, as scoped |
| COPY context sources for the release-artifact chain (php-vendor + frontend-assets + release-tree) | ALL 18 EXIST in the parent tree: composer.json, composer.lock, src, src/library, src/modules, README.md, LICENSE, package.json, package-lock.json, tsconfig.json, src/themes/default/admin + client (dirs + package.json files), frontend — 0 missing |
| `src/vendor` in the parent tree | Correctly ABSENT — docker builds it in the php-vendor stage; its absence is not a gap |
| Parent tree contents | `src/` (16 entries, 40 modules), `composer.json`, `composer.lock`, `frontend/`, `tests/` all present — it IS the last pre-deletion commit |
| Base-image pinning | composer image pinned by digest (`composer:2@sha256:b6dcd7…`); php (`php:8.5-apache`) and node (`node:24-bookworm-slim`) version-pinned, NOT digest-pinned — recorded as a build-host note, not a failure |
| Current-tree root Dockerfile pointer | Matches the procedure in substance (worktree from parent, `--target release-artifact`, tag, one-cycle retention). REFINED in-batch (not a divergence fix): exact parent SHA `51abaf1` (was `<parent-of-R6c>`), durable `~/scratch` worktree path (was `/tmp`, which is wiped by restarts), SHA tag scheme, and an explicit NOTE that the image has not been built in the sandbox. Pointer and checklist now say the same thing — no drift. |

Build-host requirements found in the parent Dockerfile (not
assumed): network access — the release-tree stage downloads
translations from `TRANSLATIONS_URL` (default: GitHub
FOSSBilling/locale latest release zip) unless
`INSTALL_TRANSLATIONS=false`; `TRANSLATIONS_SHA256` is empty
by default, i.e. the download is UNVERIFIED unless the
operator pins it — the checklist says so explicitly.

Tag scheme: `fossbilling-php-rollback:51abaf1` (commit-SHA-based).
Justification: the name names the exact tree it was built from —
no floating `latest`, no ambiguity about which PHP tree a
rollback restores. The pushed image DIGEST is the true immutable
handle (registry tags are technically re-pointable) and must be
recorded in the checklist at build time (field left blank until
then — a blank field is honest; a filled-in guess would be a lie).

Retention (D5-6): ONE FULL BILLING CYCLE **from the cutover
date** (not from the build date). The cutover date is unknown
in the sandbox, so the checklist records the RULE + fill-in
fields (cutover date, expiry) rather than a fabricated date.

## 2. Forward-only data claims — proven, not restated

**(a) PHP ignores the TS limiter table — HOLDS, with a
precision the scope glossed over.** A naive grep for
`rate_limit_counter` over the frozen oracle's PHP tree returns
3 matches — all of them the PLURAL `rate_limit_counters`
(PHP's own Security-module admin display). The exact table
name with a word boundary (`rate_limit_counter\b`, which
excludes the plural) returns ZERO references in
`runtime/src`. PHP's own limiter is a different system:
Symfony `RateLimiterFactory` with `CacheStorage`
(`RateLimiter.php:281`, cache-backed), fed into the admin
display via `listIpCounters`. Consequences, stated in the
checklist: (i) the TS table survives a PHP rollback
harmlessly (SchemaSynchronizer additive-only, never drops);
(ii) limiter STATE does NOT carry across a rollback in
either direction — TS counters become orphaned rows, PHP
enforcement restarts cold from its own cache. Do not expect
pre-rollback throttling to persist.

**(b) TS config writer byte-identity (R5a proof) still stands
— R6c did NOT touch writer semantics.** `git diff 51abaf1
HEAD -- config-store.ts` has exactly 2 hunks: the header
comment and the `resolveConfigPath` third-fallback deletion.
`serializeConfig` and `writeConfigFile` bodies are
byte-identical between 51abaf1 and HEAD (direct function-body
diff, not just the hunk count). R6c changed config
RESOLUTION only, never serialization. The R5a proof is
therefore still the proof; R6d cites it, it does not
re-prove it.

**(c) Finalization state file is shared — HOLDS.** Present
at `runtime/src/data/update-finalization.json`: status
`complete`, version `0.0.1`, finalized + completed
2026-10-23T20:32:45Z. TS resolves
`<installRoot>/data/update-finalization.json`
(`update-finalization.ts:82`) — the same file PHP reads
(`PATH_DATA/update-finalization.json`). Same file, same
statuses, same lock filename with exclusive-create
semantics on the TS side (R5j port).

**(d) Session forced-logout-on-rollback (R3 D3-6 precedent) —
CONFIRMED, with the honest mechanism.** PHP reads sessions
from `db_table => 'session'` (`di.php:211`, SymfonySession
storage); the reference DB's `session` table holds 381 rows.
Session rows are PHP-format serialized on both stacks, and
TS-created sessions were once proven bidirectionally
readable — so sessions MIGHT technically survive a
rollback. The procedure forces logout ANYWAY, deliberately
and conservatively: the cookie/token contract differs
(R6a csrf-only `__prime`, 16-byte hex tokens, token-less
sessions, no HttpOnly/SameSite on the csrf cookie), so
continuity is assumed NOWHERE. Operator action: delete all
rows from the `session` table and have all users
re-authenticate. Do NOT rotate `info.salt` to force logout
(that would break payment callbacks). Sessions also expire
on their own per `security.session_lifespan` (default
7200s), but waiting for expiry is not a rollback procedure.

**Unproven-but-plausible (scope §0.7 caveat, kept visible):**
PHP has never served a DB containing TS's exact write
patterns at production volume (R5b NULL-until-populated
semantics, TS-only `setting` values). Nothing found says
PHP would crash on them; nothing proves it either. The
staging drill (checklist G8) is that proof — and it is
UNEXECUTED.

## 3. Checklist gates (cutover-checklist.md) — status + evidence/owner

| Gate | Status | Evidence / owner |
|---|---|---|
| G1 R6a–R6c green | MET | c1337f0 (parity44 77), 51abaf1 (parity45 171), 208d7ca (parity46 21/0/1 + full chains + accounting 548+31+0); parity47 green for R6d |
| G2 Shadow criteria | NOT-MET (pending infra) | Harness + criteria MET in sandbox; live window + one-cycle parallel run = INFRA-TAP (D6-4, Josh's infra). Cutover NOT approved on this gate until they complete. Abort rule: ANY money diff aborts, no tolerance |
| G3 D6-9 Postgres gate | CONDITIONAL | BLOCKER if production runs Postgres (R3c, needs Josh's endpoints — separate tap, standing); NOT a blocker if production runs SQLite. The repo never says which — Josh fills it in; do not assume |
| G4 Rollback artifact | INFRA-TAP (NOT built) | Exact commands + tag + retention in §1 above; runs on a docker host; verify by pull + inspect; digest field blank until build time |
| G5 D6-2 oracle retention | MET (retained); deletion NOT approved | runtime/ retained. Deletion gated on D6-1 exit criteria: R6c green MET, one clean full-chain run vs oracle MET, money goldens generated+reviewed NOT MET → deletion not approved |
| G6 Deployment notes | Mixed (see below) | FB_PUBLIC_URL: ACTION REQUIRED (fallback proven); FB_CONFIG_PATH: ACTION REQUIRED if nonstandard (both paths proven); FB_GEOIP_DB_DIR: NO-OP standard; gateway logo URLs: ACTION REQUIRED if applicable; TZ=UTC: OPEN DECISION; D6-6 external-consumer: OPEN; hosting command: INFRA-TAP; abort-threshold detail: OPEN DECISION |
| G7 Forward-only data note | STATED | §2 above; the operator must have read it before cutover |
| G8 Rollback drill | UNEXECUTED | No staging infra in sandbox; exact drill procedure documented for Josh's infra; explicitly NOT run against the reference DB (which would corrupt it) |
| G9 Standing live items | Listed, NOT gates | Stripe success, live eNom, live currency refresh, live provider verification, R3c (R3c is a gate only via G3) |
| G10 R6b triaged non-money diffs | NOT blockers | invoice_event shape, extra client_order_status row, order lifecycle emails, cron send-status transport diff, last_cron_exec NULL-vs-0 — each with findings-r6b.md §7 reference |

**G6 open item found by R6d (not hidden):** R6c verified NO
Next consumer of the PHP themes, but its survey did not
explicitly record an EXTERNAL-consumer check (a PHP-served
public page, a reverse-proxy path, an external link into PHP
theme pages). Themes are already deleted (R6c); if an
external consumer exists, it broke at R6c and needs a
migration note. The checklist marks this OPEN for Josh to
confirm-or-waive rather than claiming a confirmation R6c
never recorded. (Contrast: the R6c findings DO record the
in-repo side — no Next consumer — so this is a narrow gap,
not a missing survey.)

## 4. Rollback procedure (in the checklist, one place)

Build → push → verify by pull + inspect (§1). Rollback
steps (hosting-neutral): stop Next; start the rollback
image against the SAME DB + config.php (the image is `FROM
scratch` — only `/src`; the runtime wrapper — web server,
cron every 5 min running `cron.php`, data dirs — comes from
the deployment definition, whose shape the parent
Dockerfile's `runtime` stage shows); forced logout via
`session`-table clear; smoke set (login page, admin login,
guest company with production `url`, TS-written invoice
read, TS-written order read, client login); repoint
FB_PUBLIC_URL / config `url` back to the PHP origin.
Decision rule: post-cutover, ANY money diff is a rollback
TRIGGER (same threshold as the cutover abort); non-money
diffs are triaged, not triggers, unless triage shows one is
money-adjacent (then it escalates and Josh decides).
Post-rollback: everything TS wrote stays (reconcile by
hand — incl. the expected invoice_event shape difference
for TS-window invoices); limiter state restarts cold; the
artifact stays retained until G4 expiry (a rollback does
not consume it); re-cutover requires the trigger fixed AND
the G2 shadow gates re-run green on the fixed build.

## 5. parity47 (the batch's executable proof)

86 passed, 0 failed on the parent's re-run with full output
(`r5-logs/my-parity47-full2.log`). Sections: §A
parent-commit inputs (worktree HEAD == full SHA, stage
list, release-artifact shape, 18/18 COPY sources,
src/composer/frontend presence, vendor correctly absent,
composer digest pin, pointer match); §B forward-only
claims (exact table-name grep zero, PHP limiter
cache-backed, config diff exactly 2 hunks, writer bodies
identical, finalization shared); §C checklist
completeness (all 10 gates, all 4 statuses, all required
items incl. D6-5/D6-9/D6-2/D6-1, UNEXECUTED drill, TZ=UTC,
tag scheme, retention rule, R3c, live items, triaged
diffs; plus the negative check that the doc states the
image is NOT built); §D live deployment-note proofs
(reference :3001 SYSTEM_URL fallback :8080; disposable
:3021 with a scratch config whose `url` was rewritten to
:9999 returns :9999 — proving the explicit config path is
actually honored, not silently ignored; disposable :3022
with a nonexistent config path errors instead of falling
back to :8080); §E drill status (doc says UNEXECUTED +
invariants clean before/after); §F restore (worktree +
scratch removed, disposables down, :8081/:18025/:18026/
:3003 down, :8080 + :3001 answering, invariants + config
hash unchanged, counters 0); accounting exit 0,
548+31+0=579.

**Suite bugs found in parity47's own first run and fixed
in the suite (not the batch):** (1) the stray-suite
fail-fast matched the launching shell's command line
(it contains "parity47.py") — fixed to count only
processes whose executable is a python interpreter;
(2) the hunk counter matched trailing function names on
`@@` lines, undercounting the header-comment hunk (git
prints no function name for it) — fixed to count `@@ `
headers; (3) the retention-rule grep was case-sensitive
while the checklist writes it uppercase — fixed to
case-insensitive matching. First run: 84 passed, 2
failed (both suite bugs); re-run after fixes: 86/0.
No batch claim changed between the runs.

## 6. What is left for Josh's infra taps (not R6d's to fake)

1. Docker build + push of `fossbilling-php-rollback:51abaf1`
   on a docker host + digest recorded in the checklist
   (G4). Requires network (translations download) unless
   `INSTALL_TRANSLATIONS=false`; pin `TRANSLATIONS_SHA256`.
2. Live-traffic window (capture in harness format, no
   secrets; replay green on money) OR the explicit
   no-live-traffic statement (G2).
3. One-cycle parallel run against a production-snapshot
   scratch DB, `--out` retained the full cycle (G2).
4. R3c live-Postgres proof, IF production runs Postgres
   (G3) — needs Josh's Postgres+MySQL endpoints.
5. Staging rollback drill against a TS-written DB copy
   (G8) — procedure in the checklist.
6. TZ=UTC decision (keep or drop for production Next).
7. D6-6 external-consumer confirmation-or-waiver.
8. Shadow abort-threshold detail (non-billing-adjacent
   money diffs; who triages non-money diffs).
9. Registry + hosting answers (where the artifact lives,
   the hosting-specific rollback command).
10. Cutover date + sign-off fields in the checklist.

## 7. What is left for later (after R6d)

- Oracle deletion per D6-1 (blocked on money goldens
  generated + reviewed — G5).
- Money goldens generation + review (the D6-1 exit
  criterion that replaces the frozen oracle).
- The standing live items (G9) and the R6b triaged
  non-money diffs as later-batch candidates (G10) —
  notably order emails + invoice_event shape.
- Orphaned PHP configs left from R6c (phpunit.xml.dist,
  phpstan.neon, .php-cs-fixer.dist.php, rector.php,
  .ddev/) + dead workflows/scripts — inert, documented
  in findings-r6c.md; pruning is a cleanup follow-up,
  not R6d.
- R6d's own follow-up: the Next Dockerfile
  (`apps/nextjs/Dockerfile`, added in R6c) was never
  built here either — its `docker build` also needs a
  docker host (R6d/deployment).

## 8. Files changed (uncommitted, branch feat/nextjs-phase5-r1)

- NEW `docs/nextjs-strangler/phase5/cutover-checklist.md`
  (gates G1–G10 + rollback procedure + sign-off).
- NEW `docs/nextjs-strangler/phase5/parity47.py` (86 checks).
- NEW `docs/nextjs-strangler/phase5/findings-r6d.md` (this doc).
- MODIFIED `Dockerfile` (root pointer refined: exact parent
  SHA, durable worktree path, SHA tag scheme, explicit
  not-built note — no substance change to the procedure).
- NO source files touched (verified: `git status` shows
  only the 4 paths above plus the 3 pre-existing untracked
  byproducts, which are NOT staged). NO runtime/ changes
  (read-only access only). NO worktree left behind
  (parity47 §F removes it; `git worktree list` clean).
