# Cutover checklist — Phase 5 batch R6d (rollback artifact + go/no-go gates)

**Scope:** R6d, the LAST R6 batch (scope `r6-scope.md` §2 R6d, decisions
D6-1/D6-2/D6-5/D6-9). R6d is DOCS-ONLY by necessity and design: it
changes NO TypeScript code and NO handler behavior. The rollback
artifact itself (a docker image) CANNOT be built in the sandbox —
no docker binary exists there — and the registry, hosting, live
window, staging drill, and Postgres endpoints are Josh's infra
taps. **Nothing in this document claims the image exists, the
drill ran, or the live window ran.** Every gate below carries a
status field; a gate whose status is INFRA-TAP or NOT-MET is not
approved, and cutover is NOT approved until every gate is MET or
explicitly WAIVED-WITH-REASON by Josh.

**Commits cited:** R6a `c1337f0` (seam cutover), R6b `51abaf1`
(shadow harness + criteria), R6c `208d7ca` (relocation + deletion).
Accounting at every gate: 548 TS-served + 31 removed + 0 deferred
= 579 (`endpoint-accounting.py` exit 0). Reference config hash:
`6e3c529673c1d089` (sha256 first 16).

**Status values:** MET | NOT-MET | WAIVED-WITH-REASON | INFRA-TAP
(a deployment action on Josh's infra, not done in the sandbox).

---

## G1 — R6a–R6c green

**Status: MET**

- R6a: parity44 77/77, full chain green (commit `c1337f0`).
- R6b: parity45 171/171, full chain green (commit `51abaf1`).
- R6c: parity46 21 passed / 0 failed / 1 labeled skip (C6 pg-mem
  structural proof, covered by parity43 §B installer-test F2
  in-chain), full chain green, installer-test 119/119 + 2 SKIP
  (commit `208d7ca`).
- R6d (this batch): parity47 green — it re-proves the artifact
  inputs, the forward-only claims, and the deployment notes
  (see `findings-r6d.md`). R6d changes no code, so no full-chain
  re-run is required; the R6c chain stands as the code verdict.

## G2 — Shadow criteria met (R6b harness + criteria; live window + one-cycle parallel run)

**Status: NOT-MET (pending INFRA-TAP items below — cutover is NOT
approved on this gate until they complete)**

- MET: the harness (`shadow-harness.py`, 7 scenarios) + criteria
  (`shadow-criteria.md`) exist and are green on money in the
  sandbox (envelope diffs 0, money flags False, parity45 §B–§D).
- INFRA-TAP (D6-4, Josh's infra): (a) live-traffic capture in the
  harness's capture format (request log with persona + resolved
  params, recorded WITHOUT secrets — session tokens, passwords,
  and gateway secrets must NOT enter capture files; replay
  re-authenticates with its own logins) and replay green on
  money; OR the explicit statement that no live traffic exists
  to replay, in which case the cutover case rests on fixture
  shadow + the one-cycle parallel run. (b) One-cycle parallel
  run: a TS instance pointed at a scratch DB fed from a
  production snapshot (never the production DB — no shared-DB
  shadow mode is offered), run for ONE FULL BILLING CYCLE
  (D5-6), with each run's `--out` dir retained for the full
  cycle. Criterion: no money diffs (any money diff aborts per
  §G2-abort below, or is waived by Josh with the diff
  attached); all non-money diffs triaged.
- G2-abort rule (R6b criteria §4, unchanged): ANY money diff
  aborts cutover (no tolerance). Non-money diffs get exactly
  three dispositions: FIXED / FLAGGED for Josh / TRIAGED-KNOWN
  with proof. Cart-lifecycle-only deltas with proven end-state
  equivalence reclassify to TRIAGED-KNOWN, not auto-abort.

## G3 — D6-9 Postgres gate (R3c live-Postgres proof)

**Status: CONDITIONAL — read the branch that applies, do not
assume one**

- IF production runs Postgres: **BLOCKER.** Live-Postgres proof
  (R3c: real MySQL→Postgres import, parity suites vs
  Postgres-backed Next, driver-test §C6 with `PG_TEST_URL`,
  live-pg behavior of R3a/R4/R5 handlers, R5j Postgres
  schema-equality proof + sequence resync, rekey vs live
  Postgres) is a go/no-go gate BEFORE flipping production
  traffic. R3c needs Josh's Postgres+MySQL endpoints — a
  separate tap, still standing. Sandbox proof is pg-mem only
  until then, and pg-mem proof is NOT live-Postgres proof.
- IF production runs SQLite: **NOT a blocker.** The entire
  R5/R6 verification story ran against SQLite; nothing in R6
  waits for R3c in that case.
- The checklist does NOT state which branch applies — the repo
  never says what production runs. Josh fills this in at
  cutover time; flipping Postgres production traffic with this
  gate unmet is not approved.

## G4 — Rollback artifact built, pushed, tagged, retention confirmed

**Status: INFRA-TAP (NOT built — no docker binary exists in the
sandbox; the exact commands below run on a docker host)**

- Artifact: the root Dockerfile's `release-artifact` stage
  (`FROM scratch` copy of `/app/src`: PHP + Composer vendor +
  built frontend assets) built from the LAST PRE-DELETION
  commit. Verified inputs (parity47 §A, findings-r6d.md §1):
  parent commit `51abaf1` (full SHA
  `51abaf1ef5747e84a503a39d9f99e4b238c7eef6`, first parent of
  R6c `208d7ca`); stage list php-base → composer-base →
  php-vendor / php-dev-vendor → frontend-assets → release-tree
  → release-artifact → runtime → test; every COPY context
  source for the release-artifact chain EXISTS in the parent
  tree (18 paths checked, 0 missing; `src/vendor` is correctly
  absent — docker builds it in the php-vendor stage).
- Build (on a docker host, from a worktree — NOT from the
  current tree, whose PHP stages are gone):
  ```
  git worktree add ~/scratch/fossbilling/r6d-rollback-worktree 51abaf1
  cd ~/scratch/fossbilling/r6d-rollback-worktree
  docker build --target release-artifact \
    -t <registry>/fossbilling-php-rollback:51abaf1 .
  docker push <registry>/fossbilling-php-rollback:51abaf1
  ```
  (The R6c root-Dockerfile pointer carries the same procedure
  with the exact SHA; a `/tmp` worktree path is equivalent for
  a throwaway build, but a durable path is recommended so a
  failed build can be inspected after a restart.)
- Tag scheme: commit-SHA-based, `fossbilling-php-rollback:51abaf1`.
  Justification: immutable-by-convention (the name names the
  exact tree it was built from — no floating `latest`, no
  ambiguity about which PHP tree a rollback restores). Record
  the pushed image DIGEST alongside the tag in this checklist
  at build time — the digest is the true immutable handle,
  since registry tags are technically re-pointable.
  Digest: ____________________ (fill in at build time)
- Build-host requirements (found in the parent Dockerfile, not
  assumed): network access (the release-tree stage downloads
  translations from `TRANSLATIONS_URL`, default
  `https://github.com/FOSSBilling/locale/releases/latest/download/translations.zip`,
  unless `INSTALL_TRANSLATIONS=false`); set
  `TRANSLATIONS_SHA256` to pin the download (empty by default
  = unverified download — do not ship an unverified artifact
  without noting it). Base images are version-pinned, not
  digest-pinned, except the composer image
  (`composer:2@sha256:b6dcd7…`); record the resolved base
  digests at build time if reproducibility matters.
- Retention (D5-6): ONE FULL BILLING CYCLE **from the cutover
  date** (not from the build date). Cutover date: __________
  Retention expiry: __________ (cutover date + one cycle;
  fill in at cutover time). Do not delete the tag before
  expiry; deletion after expiry is a separate decision.
- Verify after push (on the docker host): `docker pull` the
  tag, `docker image inspect` it (confirm the digest matches
  the pushed digest), and confirm the image contains `/src`
  (PHP tree) — e.g. `docker run --rm --entrypoint sh <image>
  -c 'ls / | head'`. A pulled-and-inspected image is the
  gate; a pushed-but-never-pulled tag is not.

## G5 — D6-2 oracle retention (runtime/ frozen oracle)

**Status: MET (retained) — with the deletion gate explicitly NOT met**

- `runtime/` (the frozen oracle: PHP install at the last
  PHP-serving commit) is RETAINED. R6d does NOT delete it.
- Deletion is a SEPARATE later decision, gated on D6-1's exit
  criteria: (1) R6c green — MET; (2) one clean full-chain run
  against the frozen oracle — MET (the R6c chain); (3) the
  money-path goldens generated AND reviewed — NOT MET
  (goldens do not exist yet). Until (3) is met, oracle
  deletion is NOT approved, and no batch may delete
  `runtime/` as a side effect.
- Note for that later decision: once goldens exist, the
  parity suites' PHP side must be repointed at goldens
  (or retired) BEFORE `runtime/` is deleted — deleting the
  oracle first would orphan every suite's PHP comparison.

## G6 — Deployment migration notes (each verified against reality)

- **FB_PUBLIC_URL must be set OR config `url` updated.**
  Status: ACTION REQUIRED at deployment. Proof: parity44 §5
  + parity47 §D — with FB_PUBLIC_URL unset, the TS server
  falls back to SYSTEM_URL semantics from config `url`
  (reference: `http://127.0.0.1:8080/`). On the reference
  install that fallback points at the PHP oracle, NOT at
  Next. Deployment MUST set FB_PUBLIC_URL to the Next
  origin, or update config `url` to the Next origin, or
  every generated URL (company www, email links, invoice
  links) points at the wrong origin.
- **FB_CONFIG_PATH or standard install-root layout.**
  Status: ACTION REQUIRED if nonstandard. Proof: R6c
  deleted the config-store third fallback
  (`FOSSBILLING_PHP_SRC/config.php`); parity47 §D proves
  both paths live — an explicit FB_CONFIG_PATH to a
  nonstandard config is honored (distinguishing probe:
  scratch config with a rewritten `url` is actually read),
  and a nonexistent FB_CONFIG_PATH throws instead of
  silently falling back to a wrong file. Deployments that
  relied on the old third fallback MUST set FB_CONFIG_PATH
  or use the standard layout (config.php next to the data
  dir's parent).
- **FB_GEOIP_DB_DIR.** Status: NO-OP for standard installs.
  The vendored default (`apps/nextjs/vendor/geoip`) serves
  ip_lookup out of the box (parity46 §B–§C). Set
  FB_GEOIP_DB_DIR only for a nonstandard DB location; a
  set-but-missing directory errors loudly (as before).
- **Gateway logo URLs (old src/public path).** Status:
  ACTION REQUIRED if applicable. R6c deleted `src/public`
  with `src/`; no Next filesystem consumer reads it, but
  gateway logo URLs that pointed at the old PHP public
  path now 404 unless deployment serves that path. If any
  gateway configuration references the old path, serve it
  from deployment or update the gateway config.
- **TZ=UTC (production Next keeps it or drops it).**
  Status: OPEN DECISION (Josh's call — R5d decision,
  unresolved). The reference server runs TZ=UTC; R5d made
  stats timezone config-driven with env TZ overriding
  config and UTC fallback. The checklist does NOT silently
  pick one: keeping TZ=UTC preserves the verified behavior;
  dropping it changes every config-TZ-dependent timestamp
  surface. Decide before cutover, record the decision here:
  __________.
- **D6-6 PHP-themes external-consumer confirmation.**
  Status: OPEN (Josh to confirm-or-waive). R6c verified NO
  Next consumer of the PHP themes — but the survey did not
  explicitly record an EXTERNAL-consumer check (e.g. a
  PHP-served public page, a reverse-proxy path, an external
  link into PHP theme pages). Themes are already deleted
  (R6c); if an external consumer exists, it broke at R6c
  and needs a migration note, not a silent assumption.
  Confirmation: __________ (or WAIVED with reason).
- **Hosting / topology / rollback command.**
  Status: INFRA-TAP. The repo never describes hosting
  (no reverse proxy, no orchestrator, no deploy docs
  beyond the Dockerfiles), so the exact rollback command
  (re-point a proxy? redeploy? restart a container?) is
  Josh's infra answer. The rollback procedure below
  gives the steps in hosting-neutral form; the
  hosting-specific command is filled in at deployment
  time, not invented here.
- **Shadow abort-threshold detail (scope §6 Q4).**
  Status: OPEN DECISION (Josh's call). The default stands
  ("any money diff aborts"); what remains a business risk
  call is whether a money diff in a non-billing-adjacent
  field still aborts, and who triages non-money diffs.
  Per the R6b escalation rule, non-money diffs flagged for
  Josh are triaged by Josh. Record the decision here:
  __________.

## G7 — Forward-only data note (read before any rollback)

**Status: STATED (this note is the gate — the operator must
have read it before cutover)**

- Rollback is FORWARD-ONLY for data, not a true DB rollback.
  PHP resumes from TS-written state; it does not rewind it.
  Rollback cannot un-send emails, un-charge cards, or
  un-generate invoices. Anything TS wrote during the Next
  window (invoices, transactions, orders, queue rows) stays
  written, and PHP serves that state going forward.
- Schema compatibility (proven, findings-r6d.md §2):
  TS writes nothing PHP cannot read, with one exception
  class — the TS-only table `rate_limit_counter`, which PHP
  ignores (exact table-name grep over the frozen oracle's
  PHP tree returns ZERO references; PHP's own limiter is
  Symfony RateLimiter with cache storage, a different
  system — see below). PHP's SchemaSynchronizer is
  additive-only and never drops tables, so the TS table
  survives a PHP rollback harmlessly. The TS config writer
  is byte-identical to PHP's pretty-printer (R5a proof;
  R6c changed config resolution only — writer bodies
  identical 51abaf1→208d7ca, proven by diff). The
  finalization state file is the same file on both stacks
  (`<installRoot>/data/update-finalization.json`, status
  `complete`, version `0.0.1` on the reference).
- Limiter-state caveat (proven, not assumed): TS limiter
  counters live in `rate_limit_counter`; PHP limiter state
  lives in PHP's rate-limit cache. The two systems do NOT
  share state. On rollback, TS counters are orphaned rows
  (harmless) and PHP enforcement restarts from its own
  cache state (cold). Rate-limit state does NOT carry
  across a rollback in either direction — do not expect
  pre-rollback throttling to persist.
- Session caveat (R3 D3-6 precedent, confirmed by R6d):
  FORCED LOGOUT on rollback. Session rows are PHP-format
  serialized on both stacks and TS-created sessions were
  once proven bidirectionally readable — so sessions MIGHT
  technically survive — but the cookie/token contract
  differs (R6a: csrf-only `__prime`, 16-byte hex tokens,
  token-less sessions, no HttpOnly/SameSite on the csrf
  cookie), so the procedure forces logout rather than
  assuming continuity. Operator action: delete all rows
  from the `session` table (PHP reads sessions from
  `db_table => 'session'`) and have all users
  re-authenticate. Do NOT rotate `info.salt` to force
  logout — that would break payment callbacks.
  (Sessions expire on their own per
  `security.session_lifespan`, default 7200s, but waiting
  for expiry is not a rollback procedure.)
- Unproven-but-plausible (scope §0.7 caveat, stated not
  hidden): PHP has never served a DB containing TS's exact
  write patterns at production volume (e.g. R5b
  NULL-until-populated semantics, TS-only `setting`
  values). Nothing found says PHP would crash on them,
  but nothing proves it either — the staging drill (G8)
  is the proof, and it is unexecuted.

## G8 — Rollback drill in staging

**Status: UNEXECUTED (no staging infra exists in the sandbox;
the exact procedure below is for Josh's infra — it was NOT
run, and it was NOT faked against the reference DB, which
would have corrupted it)**

Drill procedure (staging, against a COPY of a TS-written DB
— never the production or reference DB):
1. Snapshot a TS-written DB (production snapshot or a
   fixture-built TS-written DB) to a staging copy.
2. Start the G4 rollback image against the staging copy
   (same DB path layout + config.php as production, with
   staging-appropriate `url`).
3. Smoke set (each must pass): PHP login page answers;
   admin login succeeds; guest company endpoint answers
   with the staging `url`; an existing invoice reads
   (TS-written invoice, incl. one with R5b NULL semantics);
   an existing order reads; a client login succeeds.
   On any failure: STOP, record the failure with the
   endpoint + response, and do NOT approve cutover on an
   unproven rollback.
4. Forced logout: clear the staging `session` table,
   confirm a pre-drill session cookie no longer
   authenticates, confirm fresh login works.
5. Record: drill date, image digest, DB snapshot source,
   smoke results. Success looks like: all smoke checks
   pass + forced logout verified + no PHP errors on
   TS-written rows.
6. Tear down staging (delete the staging DB copy and any
   staging config); the drill must leave no residue in
   production or the reference install.

## G9 — Standing live items (NOT cutover gates, listed so the checklist doesn't drop them)

- Stripe success path (sandbox-unverified; test-mode only).
- Live eNom (adapter only; live verification needs Josh's
  credentials + IP whitelist).
- Live currency refresh (TS fetches; PHP sandbox-TLS-blocked).
- Live provider verification (real recaptcha/turnstile/
  hcaptcha, live SFS, live fakefilter fetch — mock-proven
  only; sandbox TLS blocks all).
- R3c (see G3) — the only one of these that IS a gate, and
  only for Postgres production.

## G10 — R6b triaged non-money diffs (NOT blockers)

Per the R6b escalation rule, non-money diffs triaged-known
do NOT block cutover. Each is recorded here with its
findings reference so a future reader doesn't re-discover
it as a "new" diff:

- invoice_event shape (PHP logs created+updated+issued+
  paid+refunded with full snapshots + actor ids; TS logs
  issued+paid+refunded, minimal snapshots, NULL actors;
  serie_nr padding FOSS00358 vs FOSS358) —
  findings-r6b.md §7 triage.
- Extra `client_order_status` pending_setup row on TS —
  findings-r6b.md §7 triage.
- Order lifecycle emails (3) + checkout "New Order Placed"
  email missing on TS — findings-r6b.md §7 triage.
- Cron send-status transport diff (TS no-SMTP `failed` vs
  PHP mail() `sending` — row creation compared, status
  triaged) — findings-r6b.md §7 triage.
- `last_cron_exec` public NULL vs 0 typing —
  findings-r6b.md §7 triage.

---

## Rollback procedure (hosting-neutral; fill in the hosting-specific command at deployment)

**When to roll back (decision rule, tied to the R6b abort
rule):** post-cutover, ANY money diff observed in the
shadow window or in production behavior is a rollback
TRIGGER (same threshold as the cutover abort: any money
diff, no tolerance). Non-money diffs are triaged, not
triggers — unless triage shows a non-money diff is
actually money-adjacent, in which case it escalates to a
trigger and Josh decides. A rollback is also triggered by
a Next outage that cannot be fixed faster than a redeploy
(Josh's call on the timing — the checklist does not invent
a number).

**Steps:**
1. Stop the Next deployment (hosting-specific command:
   __________).
2. Start the G4 rollback image against the SAME DB +
   config.php production uses (the image is `FROM scratch`
   — it carries only `/src`; the runtime wrapper (web
   server, cron, data dirs, config) comes from the
   deployment definition around it, which is Josh's infra
   answer — the `runtime` stage in the parent Dockerfile
   shows the shape: web root `/var/www/html`, cron every
   5 minutes running `cron.php`, data dirs
   `data/cache data/log data/uploads`).
3. Forced logout: delete all rows from the `session`
   table; verify a pre-rollback session cookie no longer
   authenticates; announce re-login to all users.
4. Smoke set (same as G8 §3, against production now):
   login page, admin login, guest company with the
   production `url`, a TS-written invoice read, a
   TS-written order read, a client login. Any failure:
   escalate to Josh with the endpoint + response — do
   not "fix forward" on production without a decision.
5. Confirm FB_PUBLIC_URL / config `url` now point at the
   PHP origin (they were repointed to Next at cutover —
   repoint them back, or the PHP deployment serves Next
   URLs).
6. Record: rollback date/time, trigger (which money diff
   or outage), image digest used, smoke results.

**Post-rollback state (forward-only — what the operator
must reconcile by hand):**
- Everything TS wrote during the Next window stays:
  invoices (incl. any generated by TS cron), transactions
  (incl. charges), orders, queue rows, sent emails. PHP
  resumes from that state; nothing is rewound.
- Reconcile by hand: any invoice/charge/order created by
  TS that PHP displays differently (e.g. the R6b triaged
  invoice_event shape diff means the event history for
  TS-window invoices looks different in PHP — expected,
  not corruption); any TS-only `setting` values PHP
  doesn't recognize (ignored, not deleted — verify none
  is load-bearing before deleting any).
- Rate-limit state restarts cold (G7 limiter caveat).
- The rollback image stays tagged + retained until the
  G4 retention expiry even AFTER a rollback (a rollback
  does not consume the artifact — a second rollback
  must still be possible).
- After a rollback, cutover is re-attempted only after
  the trigger is fixed AND the G2 shadow gates re-run
  green on the fixed build. A rollback is not a
  "try again tomorrow with the same build" outcome.

---

## Sign-off (fill in at cutover time)

- Cutover date: __________
- G2 live window + parallel run complete (or waived with
  reason + diff attached): __________
- G3 branch (SQLite / Postgres + R3c proof): __________
- G4 image digest + retention expiry: __________
- G6 open decisions (TZ, D6-6 external consumer, abort
  detail, hosting command): __________
- G8 drill date + results (or UNEXECUTED with reason):
  __________
- Approved by (Josh): __________
