# Phase 5 R4d findings — servicecustom plugin runtime + salt re-key tool

R4d is the LAST R4 batch. R4 is complete when this batch commits.
Nothing here is committed or pushed; the parent re-verifies gates and
commits. R4d scope: r4-scope.md D4-1..D4-8 at recommended defaults.

## 1. Survey answers (all read from source + probed live 2026-10-28)

### callOnAdapter tail (Service.php:277–308)

The adapter method receives exactly three arguments, in this order:

1. `serviceData` = `toApiArray(service)` — the service's config JSON
   spread, plus `id`, `client_id`, `plugin`, `updated_at`, `created_at`
   (the spread fields are overridden by the row fields when they
   collide, because the row fields are set after the spread).
2. `orderData` = the Order Service's `toApiArray(order)`.
3. `params` = the full `$data` array (CSRFToken already stripped by
   the API controller).

`callOnAdapter` returns the adapter method's return value DIRECTLY
(no wrapper, no null coercion — a null return passes through as
null). Both callers surface it as the API `result` verbatim.

### Plugin name and config sources

- Plugin name = `service_custom.plugin` (set from the product's plugin
  at `action_create`). "Empty" is PHP `empty()`: null, `''`, or `'0'`
  all count as empty (and a missing key behaves like null). The TS
  registry mirrors this: `plugin == null || plugin === "" || plugin
  === "0"` → null, before any lookup.
- Adapter config = `service_custom.plugin_config`, JSON-decoded,
  `?? []` on invalid or empty input — i.e. invalid JSON yields an
  empty config, never an error. The adapter is constructed PER CALL
  with that config, so the TS registry holds FACTORIES
  `(config) => adapter`, not pre-built objects.

### Forbidden 7 (Service.php:214–227, probed live)

The check fires FIRST, before plugin resolution and before the
adapter-exists check, on BOTH paths (shared `customCall`). The
message is SUBSTITUTED, not a literal placeholder — the source
template is `Custom plugin method :method is forbidden` and PHP's
`__trans`/`strtr` replaces `:method`, so the live message is e.g.
`Custom plugin method delete is forbidden`, code 403. The seven, in
PHP order: delete, cancel, uncancel, suspend, unsuspend, renew,
activate. The check is case-SENSITIVE (`in_array` without the loose
flag semantics that would matter here — `'Delete'` is NOT forbidden);
method lookup on the adapter is case-INSENSITIVE (`method_exists`).

### Missing plugin file (Service.php:285–294)

Per-CALL file check (`Plugin/<name>/<name>.php` under PATH_LIBRARY
at call time, not at registration). Missing → an `InformationException`
3124 is constructed but only debug-logged when `DEBUG` is set, never
thrown; the call returns null. TS mirror: unregistered adapter name →
`console.debug('[servicecustom] No adapter registered for plugin:
<name>')` on the Next server log + null. (The log goes to the Next
server's stdout/stderr, i.e. the `next start` log, not to any file.)

### Unsupported action (Service.php:303)

Message template `Plugin :plugin does not support action :action`,
substituted live, code 3125 — e.g.
`Plugin Testplug does not support action nosuch`.

### Admin `__call` (Api/Admin.php)

`checkPermissions('servicecustom', 'manage')` FIRST (403 on denial,
725 when the caller has no servicecustom access at all — both via
the R2a dispatcher gates). Then `!isset($arguments[0])` → 7103
`API call is missing arguments`. Then `order_id` missing → `Order ID
is required`, code 9999. Then `getServiceCustomByOrderId(orderId)`
— admin path: orderId ONLY, no client scoping, NO status check, NO
expiry check. Then `customCall(model, name, data)` with the full
params. `__call` has NO RequiredParams attribute, so its order_id
check is isset-only: a BLANK order_id passes the check and fails
lookup (`Order not found`).

### 7103 CORRECTION (probed live, conflicts with the R4d brief)

7103 is UNREACHABLE via HTTP. PHP's dispatcher always wraps `[$data]`,
so `arguments[0]` is always set; empty params yield `Order ID is
required` (9999), never 7103 — proven by probe (empty POST →
`Order ID is required`). Faithful TS behavior: the HTTP handler never
throws 7103 (empty params → order_id error, matching PHP); the 7103
branch exists in `dispatchCustomCall` for callers passing no arguments
object at all and is proven at unit level only
(plugin-dispatch-test P6). parity33 asserts the PHP-equivalent
empty-params behavior on both stacks and documents this correction;
it does NOT force a 7103 on empty params (that would diverge from
live PHP).

### Client `call` (Api/Client.php)

`RequiredParams` order_id (`Order ID is required`) then method
(`Method is required`), both code 9999 (InformationException
default). Then ownership via `getServiceCustomByOrderId(orderId,
clientId)`: order not found for that client → `Order not found`
9999 (NOT 403). Then `assertOrderUsable`: `expires_at` non-null and
≤ now → `Subscription expired` 9999; status ≠ `active` →
`Order is not activated` 9999; service not a ServiceCustom →
`Order is not activated` 9999. No `checkPermissions` on the client
path. The forbidden-7 check DOES apply on the client path (shared
`customCall`). Client `call` HAS the RequiredParams attribute, so
blank order_id/method fail with the required messages (TS
`requireParam` mirrors RequiredParams: unset/blank/empty-non-numeric
→ error; `'0'` passes as numeric).

### `update` (already ported)

`update` does not touch the plugin path at all and is untouched by
R4d. Verified: no diff to the `update` handler.

### Reference data

`service_custom` = 17 rows (ids 1,2,3,6–19, all client 1, all plugin
EMPTY); `client_order` custom/active with service: orders 1,2,3
(service_id 1,2,3); orders 4–10 pending_setup with no service; order
167 active custom with no service. parity33 uses REAL rows for
empty-plugin cases; crafted rows (snapshot-restored) only for:
named-but-unregistered plugin, suspended-with-service (client →
`Order is not activated`, admin → null — the asymmetry case),
expired-active-with-service (client → `Subscription expired`, admin
→ null), and a crafted client for ownership rejection.

### Literal `__call` edge (probed live)

POST `admin/servicecustom/__call` → PHP 9998 ArgumentCountError
(`Too few arguments to function...Admin::__call(), 1 passed... and
exactly 2 expected`, message embeds the runtime server path). The TS
route therefore EXCLUDES method `__call` from the magic fallback so
it keeps proxying to PHP (exact fidelity, no invented message).

### Dispatcher order (Dispatcher.php)

Method must contain `_` (710, N/A — seam method names always
qualify); activation 715 (servicecustom is core, passes); admin
module access 725 (no core exemption); Api class exists;
method-existence check passes when `__call` exists (no 740 for
servicecustom unknowns); RequiredParams validation (reflection on
the called name throws → skipped for magic methods); then the call.
TS gates for R4d: `enforceDispatcherGates` does 201 → 715 → 725
(admin only) → `ADMIN_GUARDS` lookup; no `client/` keys exist in
`ADMIN_GUARDS`, so client `call` needs no guard entry.

## 2. What was built (Part 1 — plugin runtime)

- `apps/nextjs/src/server/servicecustom-plugin.ts` (new): the plugin
  registry, shipping EMPTY (D4-4). `registerPlugin(name, factory)`
  is the documented registration point for operators adding in-tree
  adapters; no built-in adapters exist and none was invented.
  Exports: `pluginRegistry`, `FORBIDDEN_PLUGIN_METHODS` (PHP order),
  `parsePluginConfig` (invalid/empty → `{}`), `customServiceApiArray`
  (config spread + row fields, same override order as PHP),
  `stripAdapterParams` (removes `CSRFToken`, does not mutate input),
  `dispatchCustomCall` (7103 → forbidden 403 → empty-plugin null →
  unregistered adapter debug-log + null → unsupported 3125 → adapter
  passthrough; case-insensitive adapter lookup, case-sensitive
  forbidden check; `'0'` plugin counts as empty per PHP `empty()`).
- `apps/nextjs/src/server/dispatch.ts`: `registerMagic` /
  `findMagicHandler` / `MagicHandler` type (separate map, so a literal
  `__call` handler never collides with the fallback).
- `apps/nextjs/src/server/modules/servicecustom.ts`: `adapterData`
  (JSON body → rawParams else params, CSRFToken stripped),
  `loadAdminService` (no status/expiry check), `loadClientService`
  (ownership → expiry → status → service check),
  `registerMagic("admin", "servicecustom", ...)` handler (isset-only
  order_id check), `register("client", "servicecustom", "call", ...)`
  (requireParam order_id then method). `update` untouched.
- `apps/nextjs/src/server/guards.ts`:
  `ADMIN_GUARDS["admin/servicecustom/__call"] = [["servicecustom",
  "manage"]]`.
- `apps/nextjs/src/app/api/fb/[...path]/route.ts`: magic fallback
  (exact handler missing + admin + servicecustom + method ≠
  `"__call"` → magic handler, `gateMethod = "__call"`); literal
  `__call` keeps proxying to PHP.
- `apps/nextjs/src/server/db.ts`: `DbSqlite` class now exported
  (one-word change, for operator scripts).

## 3. What was built (Part 2 — salt re-key tool, D4-5)

- `apps/nextjs/scripts/rekey-salt.ts` + `scripts/run-rekey-salt.mjs`
  (new): env-only salts `FB_REKEY_OLD_SALT` / `FB_REKEY_NEW_SALT`
  (refuse if missing or equal — NEVER reads the live `FB_INFO_SALT`
  implicitly as "old", because the operator may already have
  switched env). Target: `FB_DATABASE_URL` → own `pg` Pool + `DbPg`
  (ended at end) else `FB_DATABASE_PATH` → `DatabaseSync` +
  `DbSqlite`. Behavior: (1) scan BOTH encrypted columns
  (`extension_meta.meta_value`, `email_template.vars`) for
  `v2:`-prefixed values; count v2: rows, non-v2: rows, total rows per
  column. (2) Pre-scan: decrypt EVERY v2: value with OLD — ANY
  failure → REFUSE before any write (deliberately better than the
  importer's post-commit verification caveat). (3) Write: re-encrypt
  with NEW and update all v2: rows in ONE transaction. (4) Verify
  round-trip on EVERY rewritten row (re-read + decrypt with NEW
  inside the tx, compare to originals) BEFORE commit — mismatch →
  ROLLBACK + refusal. (5) Zero v2: rows → status VACUOUS, exit 2, no
  writes (the R2e lesson: a vacuous check proves nothing about salt
  correctness — the output says so). (6) Non-v2: rows left untouched,
  counted + reported. (7) NEVER prints decrypted values or salts —
  output contains counts + statuses only. `--dry-run` (report counts
  + decryptability, write nothing), `--help` (exit 0).
- crypt.ts survey result: `decryptV2` returns null for non-v2:
  input, undecryptable, or unkeyed, and TRIMS output; `encryptV2`
  returns null when unkeyed; passphrase = `FB_INFO_SALT ??
  FB_CALLBACK_SALT`. Rekey round-trip comparison uses `decryptV2`
  outputs on both sides, so the trim is consistent. Non-v2: rows are
  left untouched, counted + reported (R3b verbatim precedent).
- Full secret store (vault/KMS) is OUT of scope (D4-5); salt stays an
  operator-managed env secret.

## 4. Verification

### plugin-dispatch-test.mjs — 36/36 PASS

Compiles servicecustom-plugin.ts + dispatch.ts with the repo tsc,
registers TEST adapters in-process (test-only, never shipped),
proves: supported action → return passes through exactly (with exact
(service, order, params) args, factory-per-call, parsed config);
unsupported → 3125 exact message; forbidden beats dispatch (adapter
HAS delete, still 403, all seven); empty plugin null (null, `''`,
`'0'`, undefined); missing adapter → null + debug log; no arguments
→ 7103; case-insensitive method lookup (`DO_THING` → `do_thing`);
forbidden case-sensitive (`'Delete'` NOT forbidden, dispatches);
CSRFToken stripping (input not mutated); service api array shape;
config parsing (valid/invalid/empty/null).

### rekey-test.mjs — 29/29 PASS

Disposable SQLite DBs ONLY — the reference DB was never touched.
Cases: round-trip both columns (multiple rows, nested JSON) with
VERIFIED status, no salts/markers in output, non-v2: rows untouched,
old salt no longer recovers originals; wrong-old → REFUSED + DB
byte-identical; missing env var → refusal NAMING the var; old == new
→ refusal; zero-v2: → VACUOUS exit 2 + unchanged; dry-run writes
nothing; `--help` exit 0; no-target-env refusal; mid-write failure →
rollback PROVEN EMPIRICALLY (a trigger aborting the 2nd update
propagates and the 1st update rolls back with it — DB fully
unchanged). This closes the brief's "if you cannot force it"
caveat: it WAS forced, on SQLite. The pg rollback path is
code-path-shared (same `withTransaction`), not live-proven (R3c).

### parity33.py — 77 checks, 0 failures

Sections A–F (see the script header): baselines/invariants;
admin `__call` both stacks (empty params → order_id error,
forbidden-7 loop all seven, empty-plugin null on orders 1–3,
not-found, no-service on 4/167, literal `__call` → 9998 full
equality); client `call` both stacks (empty-plugin null, forbidden,
missing method, missing order_id, not-found, no-service, logged-out
201s); crafted rows (missing-plugin null both stacks,
suspended asymmetry, expired asymmetry, ownership rejection,
no-manage 403, support-only 725); secret scan over all captured
envelopes (clean); restore proof (invariants + extension rows +
meta keys + service_custom 17 + crafted rows gone).

Harness lessons recorded in the script: (1) admin `__call`
dispatches on the URL method, not on a params["method"] key — an
early draft of the suite called `probe_method` with
`method=delete` in params and got null instead of 403; (2) the PHP
logged-out call primes the shared cookie jar with an anonymous
session cookie, which makes the TS call fail CSRF instead of 201 —
logged-out checks use a fresh opener per stack; (3) PHP's CSRF
check reads form bodies, not JSON bodies — the suite posts
urlencoded; (4) the admin login page 404s under the PHP built-in
server in this runtime — staff login reuses the /login page token
(probe-sc pattern).

### capture36.py + captures36/ (11 files)

PHP reference corpus: admin empty-params, forbidden-delete (real
403), empty-plugin order 1, not-found, no-service 167, client
empty-plugin, forbidden, missing method, missing order, not-found,
service_custom baseline.

### Regressions — all green

- parity32 65/65, parity31 63/63, parity30 179/179, parity29 62/62,
  parity28 128/128, parity27 27/27, parity26 62/62, parity25 203/203.
- parity21: exactly the known 9 diffs, no new ones
  (sd_tld_delete, sd_tld_delete_used, sd_tld_delete_notfound,
  sd_reg_available, sd_guest_tlds, sd_guest_tlds_reg,
  sd_guest_tlds_trans, sh_guest_free_tlds_fallback,
  dl_admin_send_file_missing_stored).
- Fixtures 13/13 on BOTH stacks (verified via results JSON
  `status == "PASS"` for all 13 entries each, not just the summary
  line).
- tsc --noEmit clean; `npm run build` exit 0; new strings
  (`does not support action`, `No adapter registered`) confirmed in
  the production bundle.
- Reference DB invariants clean before AND after (invoice 323,
  client_order 11, email_queue 67, servicedomain_last_sync
  2026-10-26 03:24:56, support_ticket 2, client 3, admin 2,
  admin_group 3, admin_group_member 1, service_downloadable 0,
  setting 38, currency 1 USD, extension 6 installed, extension_meta
  3, service_custom 17).

## 5. Closing 579-endpoint accounting (RE-DERIVED, not copied)

`docs/nextjs-strangler/phase5/endpoint-accounting.py` (new, exit 0)
re-derives the accounting from `api-catalog.json` + literal
`register()` calls + removal lists + deferrals + magic-handler
presence. Do NOT copy R1's arithmetic — R2a moved is_allowed /
get_navigation after R1's count, and R1's "23 R4" figure predates
that.

- Pre-R4d: 537 resolving + 31 removed + 9 deferred + 2 proxied = 579.
- Post-R4d: **539 resolving + 31 removed + 9 deferred + 0 proxied
  = 579.** The books close exactly; no remainder.
- Bridge: R1 525 + R2a 2 (is_allowed, get_navigation) + R4a 6
  (get_list, activate, deactivate, config_save, guest is_on, guest
  settings) + R4c 4 (theme reads) = 537; + R4d 2 (admin `__call`
  magic + client `call`) = 539.
- Removed (31): system admin 18 + guest system template_exists 1 +
  extension admin 8 + guest extension languages 1 + theme 3. Removed
  wins over literal handlers (the two literal removal handlers are
  guest/extension/languages and guest/system/template_exists).
  Catalog modules (35) exactly equal the FB_TS_MODULES list.
- Deferred to R5 (9, all verified handler-free): system
  localization_settings, update_localization_settings,
  error_reporting_enabled, toggle_error_reporting,
  last_error_reporting_change, instance_id; security ip_lookup,
  run_check, run_checks.

## 6. Divergences and standing notes (carried, not hidden)

- Literal `__call` is proxied to PHP, not TS-served (PHP-faithful:
  PHP itself crashes on it with 9998).
- 7103 is HTTP-unreachable on both stacks (PHP-faithful; unit-proven
  only).
- TS lowercases path segments, so a mixed-case spelling of a
  forbidden method is refused by TS (403) while PHP would dispatch
  it case-insensitively to the adapter. Inherited seam property, not
  an R4d divergence for realistic (lowercase) usage.
- JSON-body vs form-body adapter params: with an empty registry the
  difference is unobservable via HTTP; the JSON path
  (`rawParams`) is unit-covered in shape only. A registered
  adapter's live HTTP dispatch is proven only when an operator
  registers one — not claimed here.
- Rekey tool against live Postgres, and its pg rollback path, are
  R3c items (code-path-shared with the sqlite-proven path).
- `decryptV2` trims output: rekey comparison uses decrypted outputs
  on both sides, so the trim is consistent; stored JSON configs are
  whitespace-insensitive.

## 7. Deliberately unproven

- Registered-adapter live HTTP dispatch (by design: no adapter
  ships; proven at unit level only).
- Rekey tool against a live Postgres database (R3c).
- Nothing else: mid-write rollback WAS forced empirically on
  SQLite (trigger test), so it is proven, not merely structural.

## 8. Next taps (all separate, none taken)

R4 is complete: push the stack, R3c (live Postgres/MySQL
verification), or R5 scoping. The parent commits R4d first.

## 9. Operator steps — salt re-key (R3b §9-style)

These steps are for the operator, not for the agent to run
unprompted. The tool is at `apps/nextjs/scripts/run-rekey-salt.mjs`
(run from `apps/nextjs`).

1. BACKUP FIRST. Take a full database backup and verify it restores
   before touching anything. The tool refuses on any pre-scan
   failure, but a backup is the only recovery from operator error
   (e.g. switching env to the wrong salt).
2. Set the explicit salts (do NOT rely on the live env salt):
   `FB_REKEY_OLD_SALT=<current salt>` and
   `FB_REKEY_NEW_SALT=<new salt>`. Refuse conditions: either var
   missing (the refusal names the var), or old == new.
3. Point at the target: `FB_DATABASE_URL=<postgres url>` for
   Postgres, or `FB_DATABASE_PATH=<sqlite file>` for SQLite. If
   neither is set, the tool refuses. For Postgres the tool opens
   its own Pool and ends it at the end (the `createPgDb` singleton
   cannot be ended from a script — do not substitute it).
4. DRY-RUN FIRST:
   `FB_REKEY_OLD_SALT=... FB_REKEY_NEW_SALT=... FB_DATABASE_PATH=...
   node scripts/run-rekey-salt.mjs --dry-run`
   Required output: per-column counts (`v2:`, non-v2:, total) and
   `status=DRY_RUN`. Dry-run writes nothing. If the pre-scan reports
   any undecryptable v2: value, STOP: the old salt is wrong or a
   row is corrupt — the tool refuses before any write, and so
   should you.
5. RUN (same command without `--dry-run`). Required output:
   `status=VERIFIED` (all rewritten rows re-read and decrypted with
   NEW inside the transaction before commit). Any other status
   means NO commit happened: `status=REFUSED` (pre-scan or
   verification failure, DB untouched) or `status=VACUOUS` (zero
   v2: rows — proves NOTHING about salt correctness; do not treat
   it as a successful re-key, and do not proceed to step 6 on a
   vacuous run).
6. THEN switch the env salt: set `FB_INFO_SALT` (or
   `FB_CALLBACK_SALT` if that is the configured source) to the NEW
   salt. Never switch before a VERIFIED run.
7. Restart the server.
8. Spot-check: `extension config_get` for a known encrypted config
   (e.g. mod_support) must return its values, and an email template
   with stored vars must render. If either fails, restore the backup
   and revert the env salt — the re-key did not take.
9. Full secret store (vault/KMS) is OUT of scope (D4-5). Salt stays
   an operator-managed env secret.
