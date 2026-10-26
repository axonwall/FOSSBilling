# Phase 5 R1 leftovers, sub-batch 2 — findings (r1h)

Date: 2026-10-26. Branch: `feat/nextjs-phase5-r1` (tip `d6d5966` at
start). **Nothing committed, nothing pushed.** New files below are
uncommitted; the untracked `docs/nextjs-strangler/phase4/ts_invoice1.pdf`
and `docs/nextjs-strangler/phase5/parity21-diffs.json` were left alone.

## Headline

44 endpoints in scope. Split honestly:

- **34 newly ported with full logic** (TS handlers, parity-proven):
  formbuilder 13, security 5 (`list_checks` + 4 `rate_limit_*`),
  redirect 5, antispam 5, widgets 2, page `get_pairs` 1,
  index `get_dashboard` 1, activity `log_email` 1, product `get_pairs` 1.
- **7 newly registered behind the module-active gate**: seo 2,
  serviceapikey 4, cookieconsent 1. On the reference install these
  modules are **not installed**, so both stacks answer 715
  (`FOSSBilling module <mod> is not installed/activated`). The real
  logic behind each gate is implemented in TS but **unverified-live**
  until those modules are installed (see §6).
- **3 deferred, left PHP-proxied by design**: security `ip_lookup`,
  `run_check`, `run_checks` (see §5).

Routes resolving in TS: 471 → **512/579** (34 full-logic + 7 gated).
The 3 deferred security endpoints stay proxied; everything else in
the 44 is served by the seam.

## Gates

- `tsc --noEmit`: clean.
- `next build`: clean; the built bundle (`.next/server/chunks/238.js`)
  was grepped for `formbuilder`, `get_dashboard`, `log_email`,
  `rate_limit_status`, `get_pairs`, `cookieconsent`, `serviceapikey`
  — all present. No parity run was done against a stale build.
- **parity23: 158/158 envelopes + 8/8 DB dumps match.**
  Breakdown: 130 batch-ported envelopes (incl. noauth 201 checks),
  2 setup logins, 12 proxied security envelopes, 14 gated envelopes.
  DB dumps: `login_db`, `fb_db`, `rd_db`, `as_db`, `act_db`,
  `changed_settings`, `fb_product2_after_delete`,
  `rd_nochange_check`.
- **Fixtures: 13/13 on PHP and 13/13 on Next**
  (`run-fixtures.py fixtures-tax.json fixtures-money.json`).
- **parity21 regression: 195/203, with the identical 8 known diffs**
  (verified by name on a re-run): 3 `tld_delete` cases
  (`sd_tld_delete_used`, `sd_tld_delete`, `sd_tld_delete_notfound`
  — the MySQL-only-TRIM upstream defect, PHP SQL-errors code 1
  while TS implements the intended 707/true/not-found behavior),
  1 expected Enom listing diff (`sd_reg_available` — TS lists Enom,
  PHP 0.8.9 lacks it), and 4 downstream guest/free-TLD list diffs
  (`sd_guest_tlds`, `sd_guest_tlds_reg`, `sd_guest_tlds_trans`,
  `sh_guest_free_tlds_fallback` — the `.cap24` row PHP fails to
  delete in the tld_delete cases).
- Reference DB invariants re-verified at the end: tld 1 row,
  tld_registrar 3 rows, service_domain 0 rows, email_queue 67,
  setting `servicedomain_last_sync` unchanged. (Session-row count is
  ephemeral, not an invariant.)

## Runtime requirement discovered this batch (important)

PHP's built-in server is single-threaded: `security/run_check`
`webserver` deadlocks on its self-fetch (the API request occupies
the server while the check fetches `SYSTEM_URL` URIs from the same
server). **All harness runs must start PHP with workers:**

```
cd ~/scratch/fossbilling/runtime/src && APP_ENV=dev \
PHP_CLI_SERVER_WORKERS=4 nohup ~/scratch/bin/php -S 127.0.0.1:8080 \
>/tmp/php8080.log 2>&1 &
```

With workers the webserver check completes in ~3 s, including
through the Next proxy.

## 1. Formbuilder (13 endpoints, all ported)

Source: `src/modules/Formbuilder/Api/{Admin,Guest}.php`,
`Service.php`, `ServiceForm.php`, `ServiceFormField.php`.

Pinned semantics (all proven by capture26 + parity23):

- `create_form`: type lowercased, must be in `[horizontal, default]`
  or 3657; stored style is JSON_FORCE_OBJECT `{type, show_title}`
  with show_title default `'0'` (string). `update_form_settings`
  requires type exactly `horizontal`/`default` (no lowercasing) or
  3207, show_title default `'1'`.
- `add_field`: label default `<TypeLabel> <N>` (text `Text Input`,
  url `URL Input`, select `Dropdown`, radio `Radio Select`,
  checkbox `Checkbox`, textarea `Text Area`); name default
  `new_<type>_<N>`; select/checkbox/radio **force** options to the
  literal `{"First option":"1", "Second option": "2", "Third option":"3"}`
  regardless of input; textarea defaults options to
  `{"height":"100", "width": "300"}` only when options unset; array
  default_value/options encode with JSON_FORCE_OBJECT
  (`{"0":"a","1":"b"}`); invalid type → 2684; non-unique option
  values → 3658.
- `get_form_fields` returns **raw rows** (options/default_value as
  stored strings, ints for booleans); `get_form` decodes: style
  fallback `{type: "default", show_title: "1"}` when unparseable,
  fields' options decoded (invalid/empty → `[]`), default_value
  decoded when non-empty (empty string or `"0"` → `""`). PHP
  assoc-decode turns objects with keys exactly `0..n-1` into JSON
  arrays (checkbox default_value `'{"0":"a","1":"b"}'` reads back as
  `["a","b"]`) — reproduced in TS as `phpJsonDecodeAssoc`, while
  `get_field` uses plain decode (objects stay objects) and leaves
  default_value raw.
- `update_field`: **slugify runs BEFORE the field lookup** (bad name
  beats unknown id); slugify = non-letter/digit runs → `_`, trim
  `_`, transliterate to ASCII, lowercase, strip non-`[-\w]`;
  leading digit → 1649, empty → 3502; duplicate name in form →
  7628; options non-unique → 3658; select/checkbox/radio require
  values+labels arrays (missing → PHP TypeError text with 9998),
  filtered to non-empty strings, dup values → 1597, dup labels →
  1598, count mismatch → `array_combine()` ValueError text with
  9998; textarea requires numeric textarea_size or 3510 (missing
  size/option → TypeError 9998 texts); **UPDATE overwrites every
  column with provided-or-NULL and never touches the type column**;
  options absent → `''`.
- `copy_form`: new form gets default style (horizontal/`'0'`) even
  if the source differed; copied select fields get options reset to
  the default string, copied textarea fields keep their options
  string; copying a nonexistent form still succeeds with zero
  fields (no existence check).
- `delete_form` returns true even for unknown ids and NULLs
  product/client_order form_id (verified: product 2 form_id → NULL).
  `delete_field` unknown id → `Field was not found`.
- `get_pairs` returns `[]` when empty, else an object keyed by id
  string. `get_forms` uses one LEFT JOIN query so product/order
  counts cross-multiply when both link — the TS port replicates
  the SQL, it does not fix it.
- Required-param semantics (applies batch-wide): a param is missing
  when unset, blank (string trims to empty), or empty-and-not-numeric
  (false, [], null). `'0'` and `0` pass. **Attribute checks (code
  9999) run before body checks**: `copy_form` missing form_id →
  9999 (not the body's 1822), `update_form_settings` missing
  form_id → 9999; body-only checks carry explicit codes: get_form
  id 2391, get_form_fields form_id 1822, get_field id 3547,
  delete_form id 9958, delete_field id 9959, update_field id 9958.
  TS helper: `requireParam()` in `dispatch.ts`.
- Error-envelope mapping: FOSSBilling exceptions with code 0 →
  9999; uncaught Throwables (e.g. PHP TypeError) → message verbatim
  with code 9998. Proof: `array_filter(): Argument #1 ($array) must
  be of type array, null given`, 9998.

Limitation: the TS `slugify` transliteration is NFD + diacritic-strip,
exact for ASCII/Latin-accented input; it may differ from PHP's
iconv TRANSLIT for other scripts.

## 2. Security (5 ported, 3 deferred)

Source: `src/modules/Security/Api/Admin.php`, `Service.php`.

Ported:

- `list_checks`: static metadata; captured order
  `dangerousFunctions, generalCheck, phpVersion, webserver`.
- `rate_limit_status` / `rate_limit_get_list` /
  `rate_limit_reset_ip` / `rate_limit_reset_all`: the TS seam runs
  no rate limiter, so these report the seam's own state — which is
  exactly what PHP returns on the reference install
  (APP_ENV=dev disables the limiter): status `{enabled: false}`,
  list `[]`, reset `{ip, policy, removed: 0}`, reset_all
  `{cleared: true}`. IP-format validation still applies (invalid
  IP → `The provided input was not a valid IP address.`, 9999, via
  Node `net.isIP`).

Deferred (proxied, §5):

- `ip_lookup`: needs a MaxMind MMDB reader. Private IPs return
  `country: [], asn: []`, but public IPs return real data (captured:
  `8.8.8.8` → country `{name: "United States", flag: "🇺🇸",
  currencies: ["USD","USN"]}`, asn `{asnNumber: 15169, asnOrg:
  "GOOGLE"}`). No JS MMDB reader exists in the seam's dependencies;
  adding one is out of scope for this batch.
- `run_check` / `run_checks`: they probe the PHP runtime itself
  (config.php flags, the PHP version via a php.watch fetch, PHP's
  disable_functions list). Registering them would hardcode the
  reference install's answers. They stay PHP-proxied (which works
  once PHP runs with workers).

Captured check results (for the record): generalCheck → `failed`
(`- Fail: HTTPS is not enforced.\n- Warning: Debug mode is
enabled...\n- Warning: You appear to be using a non-release version
of FOSSBilling.\n`); phpVersion → `failed` /
`Failed to lookup PHP version status.`; webserver → `failed`, all
three URLs (`config.php`, `data/log/php_error.log`,
`vendor/autoload.php`) returned HTTP 200; dangerousFunctions →
`warning`, listing exec, passthru, system, shell_exec, popen,
proc_open, pcntl_exec.

## 3. Redirect (5 ported)

Source: `src/modules/Redirect/Api/Admin.php`, `Service.php`.
Storage: `extension_meta`, extension `mod_redirect`, meta_key =
path, meta_value = target.

- Path trimmed of `/` both ends; empty or CR/LF-containing →
  `Invalid redirect path.`; `..` → `Redirect path must not contain
  path traversal sequences.`; target trimmed; empty/CR/LF →
  `Invalid redirect target.`; non-http(s) scheme → `Only HTTP and
  HTTPS redirect targets are allowed.`
- create/update/delete id missing → RequiredParams 9999
  (`Redirect path was not passed` / `Redirect target was not
  passed` also for empty strings — empty counts as missing);
  unknown id → `Redirect not found`.
- Update with no changes must not bump updated_at (Doctrine no-op
  flush) — proven by parity23's `rd_nochange_check` probe (before ==
  after within each run). Create/update set created_at/updated_at
  (captured: created `2026-10-26 14:39:25`, updated `14:39:27`
  after an update).

## 4. Antispam (5 ported)

Source: `src/modules/Antispam/Api/{Admin,Guest}.php`, `Service.php`.
Config lives in the encrypted `extension_meta` row
`mod_antispam`/`config` (crypt.ts v2 interop; encrypted `meta_value`s
are stored as `<encrypted>` in captures — random IV is
non-deterministic by design; plaintext is proven by get_config
envelopes).

- get_config defaults: block_ips false, blocked_ips `""`,
  captcha_enabled false, captcha_provider `recaptcha_v2`,
  recaptcha keys null, v3 threshold 0.5, turnstile/hcaptcha keys
  null, sfs false, check_temp_emails true, honeypot_enabled true,
  honeypot_field `bio`; guest recaptcha uses `captcha_version` for
  `version` (null when unset).
- block_ip: non-string/blank → `IP address is required`; bad IP →
  `Invalid IP address`; duplicate → `<ip> is already blocked.`;
  own IP (request IP, 127.0.0.1 in harness) → `You cannot block
  <ip> as it is the IP you are making requests from.`; success
  `{result: true, ip}` and stores `{block_ips, blocked_ips, ext}`
  (key order preserved on later writes).
- unblock_ip: unknown → `<ip> is not currently blocked.`;
  emptying the list sets block_ips false.
- get_blocked_ips splits on `\n`, trims, drops empties.
- Extension_meta timestamps: Doctrine sets created_at on insert and
  bumps updated_at on update (antispam config row: created
  `2026-10-26 14:39:30`, updated `14:39:33` after unblock).

## 5. Widgets (2 ported)

Source: `src/modules/Widgets/Api/Admin.php`, `Service.php`.

- list is a single slot — `{slot: "client.theme.footer.end",
  widgets: [{module: "branding", template: "mod_branding_footer",
  priority: 10}], count: 1}` (only Branding implements
  WidgetProviderInterface among core+active modules).
- Rebuild returns true; TS computes the fixed registry instead of
  caching, so there is no Symfony cache file to invalidate.
  Limitation (documented): a future widget-providing module must be
  added to the hardcoded registry list.

## 6. Gated modules (7 registered, 715 on this install)

Module-active gate rule (from `Api/Dispatcher.php` +
`Extension/Service.php` + `Module.php`): core modules are always
active; any other module is active iff an extension row exists with
type `mod`, name = module, status `installed`. Core list includes
formbuilder, security, redirect, antispam, widgets, page, index,
activity, product. The reference install's extension table holds
only branding, custompages, massmailer, news, notification,
redirect — so **seo, serviceapikey, cookieconsent are NOT installed**.
Auth (201) precedes the module gate: `seo_noauth` and
`sak_client_reset_noauth` both return 201, not 715.

Implemented behind each gate (TS code, **unverified-live**):

- **Seo** (`modules/seo.ts`): info uses `FOSSBILLING_URL` base +
  `/sitemap.xml`, last_exec from setting, engines
  `{google: {id, name, enabled: sitemap_google == "on"}}`;
  ping_all is forced, pings enabled engines best-effort with 10 s
  abort, stamps the setting. Note: live ping_all touches external
  search engines and would fail at the sandbox egress layer; the
  715 path is what parity proves here.
- **Serviceapikey** (`modules/serviceapikey.ts`): check/update/reset
  incl. `generateKey` — length default 32, split default true,
  interval 8, case upper default, mixed = per-char 50% upper, 10
  uniqueness attempts, unknown-case error text — and `isActive`
  via the apikey order row.
- **Cookieconsent** (`modules/cookieconsent.ts`): config message or
  the built-in default string.

## 7. Small bits (4 ported)

- **Page admin get_pairs** (`modules/page.ts`): 7 entries from the
  theme html dir (`mod_page_about-us` → `Mod Page About Us`,
  login, password-reset, preview_markdown, privacy-policy, signup,
  tos → `Mod Page Tos`); `mod_page_sitemap.xml` does NOT match the
  `mod_page_*.html.twig` pattern. Theme code comes from setting
  `theme` (reference: `default/client`, empty → `default/client`).
  Role-level auth applies despite no method-level permission check:
  noauth → 201. Approximation: TS scans the theme dir then
  `modules/Page/templates/client` and sorts filenames
  alphabetically — deterministic and matching the captured order;
  PHP's Finder readdir order is not guaranteed identical on other
  filesystems.
- **Index client get_dashboard** (`modules/indexmod.ts`, named to
  avoid collision with the registry bootstrap `modules/index.ts`):
  keys profile, tickets, invoices, orders, recent_orders,
  recent_tickets. **Profile is base client fields + balance only —
  NO billing_email** (getDashboardData passes no identity, so the
  self branch that adds billing_email never runs) and no group
  info; custom fields from mod_client config apply when active and
  non-empty (no mod_client config row exists on the reference
  install). Tickets `{total: 2, open: 0, on_hold: 0, closed: 2}`
  (unknown statuses count toward total only). Invoices
  `{total: 318, paid: 107, unpaid: 108}` over issued invoices (total
  ≠ paid+unpaid). Orders `{total: 10, active: 3, expiring: 0}` over
  group_master=1; expiring = active + issue-invoice + period +
  expires_at + no unpaid invoice + expires_at before start-of-day
  (invoice_issue_days_before_expire + 1) days from today (setting
  = 14). recent_orders (5, updated_at DESC) are raw client_order
  rows + decoded config + `total` = float price × int quantity +
  `title` + meta map (or `[]`) + open/on_hold ticket count + base
  client array. recent_tickets (2, updated_at DESC) are batch rows:
  full row minus support_helpdesk_id, client_id, priority,
  access_hash, rel_type, rel_id, rel_task, rel_new_value,
  rel_status (+ `hash` when access_hash set) + `replies` (count of
  ALL messages) + `first` message `{id, content, attachment,
  created_at, updated_at, author: {name, role}}` + non-admin
  helpdesk `{id, name, can_reopen}` + author/client summaries.
  Message author for client identity is `{name, role}` (no email;
  email is admin-identity-only). Expiring uses UTC-midnight today,
  matching the TZ=UTC harness; a config-driven TZ is an R5 item.
- **Activity admin log_email** (`modules/activity.ts`): missing
  subject → `false` (not an error); insert sets created_at only,
  attachment_* NULL, updated_at NULL (captured rows id 33 minimal,
  id 34 full).
- **Product admin get_pairs** (`modules/product.ts`): defaults
  products_only + active_only (both default true; `'0'` disables);
  optional type filter; empty result encodes as `[]` (not `{}`).
  Reference products: 1 `Domains registration and transfer`
  (non-custom type), 2–8 `Phase0 Widget Hosting`, 9 `Phase3
  Recurring Widget`. Unlike guest pairs, hidden products are NOT
  filtered here.

## 8. Divergences and documented gaps

1. **Session orphan on login (pre-existing, not this batch).**
   PHP's client login leaves the pre-login priming session row
   orphaned (5 new session rows for the parity23 login sequence);
   the TS client login (ported in an earlier batch) does not (4 new
   rows). API envelopes are identical. parity23 compares
   identity-carrying sessions only (admin session {id 1, email,
   name}, client session {client 1}, has_csrf flags all match);
   orphan priming rows are harness artifacts, not API behavior.
   TS behavior here is arguably cleaner; no change made.
2. **Deferred security endpoints** (§2): ip_lookup (needs MMDB
   reader), run_check/run_checks (probe the PHP runtime itself).
   All three stay PHP-proxied; parity23 covers them as
   `sec_*_proxy` cases (12 envelopes) proving the proxy path works
   with worker-enabled PHP.
3. **Gated-module logic unverified-live** (§6): seo, serviceapikey,
   cookieconsent behind-gate implementations exist in TS but have
   never run against a live install with those modules installed.
4. **Approximations**: formbuilder slugify transliteration
   (non-Latin scripts), page pairs file order, widgets hardcoded
   registry, dashboard expiring day boundary (UTC-midnight; harness
   runs TZ=UTC).
5. **TS has no rate limiter** — consistent with the reference
   install, where APP_ENV=dev disables PHP's limiters. A TS rate
   limiter is an R5 item.
6. **Secrets discipline**: no API keys, reset tokens, or password
   hashes were copied into captures, findings, or parity output;
   parity23 scrubs bcrypt values (cost compared instead), session
   ids, and encrypted config `meta_value`s.

## Files changed (all uncommitted)

New TS modules:

- `apps/nextjs/src/server/modules/formbuilder.ts` (13 endpoints)
- `apps/nextjs/src/server/modules/security.ts` (5 ported; 3
  deferrals documented in-file)
- `apps/nextjs/src/server/modules/redirect.ts` (5)
- `apps/nextjs/src/server/modules/antispam.ts` (5)
- `apps/nextjs/src/server/modules/widgets.ts` (2)
- `apps/nextjs/src/server/modules/seo.ts` (2, gated)
- `apps/nextjs/src/server/modules/serviceapikey.ts` (4, gated)
- `apps/nextjs/src/server/modules/cookieconsent.ts` (1, gated)
- `apps/nextjs/src/server/modules/page.ts` (get_pairs)
- `apps/nextjs/src/server/modules/indexmod.ts` (get_dashboard)

Extended:

- `apps/nextjs/src/server/modules/activity.ts` (+ log_email)
- `apps/nextjs/src/server/modules/product.ts` (+ admin get_pairs)
- `apps/nextjs/src/server/modules/index.ts` (+ 10 imports)
- `apps/nextjs/src/server/dispatch.ts` (+ `requireParam`)
- `apps/nextjs/src/server/db.ts` (+ `isModuleActive`, form
  helpers, extension_meta helpers, `insertActivityClientEmail`,
  `listProductPairs`)
- `apps/nextjs/src/server/crypt.ts` (+ `writeExtensionConfig`)

Harness + findings (uncommitted, `docs/nextjs-strangler/phase5/`):

- `capture26.py`, `captures26/` (155 files, live-PHP corpus)
- `parity23.py` (158 envelopes + 8 DB dumps, all match)
- `findings-r1h.md` (this file)
