# Phase 5 R1 leftovers, sub-batch 1 — findings (r1g)

Port of the deferred cart (10) + staff (5) endpoints to the TypeScript
seam. Branch `feat/nextjs-phase5-r1`, tip `6f424f0`. **Nothing committed,
nothing pushed** — all work below is uncommitted, for review.

## Gates

- `tsc --noEmit`: clean.
- `next build`: clean.
- `parity22.py`: **136/136 envelopes, 16/16 DB dumps — ALL MATCH.**
  Same sequence on PHP (:8080) and the TS seam (:3001), full
  snapshot/restore between stacks so autoincrement sequences align.
  Openers are primed via the PHP `/login` page (the session row lives
  in the shared DB, so the TS seam reads it); the TS API base is
  `/api/fb`, PHP's is `/api`.
- Fixtures: **13/13 on PHP, 13/13 on Next** (`run-fixtures.py`,
  `fixtures-tax.json` + `fixtures-money.json`).
- `parity21.py` regression (D7 modules, shared files touched):
  **195/203, same 8 known diffs as the recorded eNom run**
  (`phase0/parity21-diffs.json`, identical key set): 3 `tld_delete`
  cases (upstream SQLite defect — PHP SQL-errors, TS implements the
  intended behavior), `sd_reg_available` (TS lists Enom, PHP 0.8.9
  lacks it — expected), and 4 guest/free-TLD list diffs that are
  downstream of the `tld_delete` defect (PHP's failed delete leaves
  the `.cap24` row behind, so later list calls include it). No new
  diffs from this batch.
- Reference DB invariants re-verified: tld 1, tld_registrar 3,
  service_domain 0, email_queue 67, setting `servicedomain_last_sync`
  `2026-10-26 03:24:56` — all unchanged.

## Per-endpoint results (all 15 ported, all parity-proven)

Cart admin — `get_list` (default, page/per_page variants incl. page 0,
per_page 0/501/`abc`, page `abc`, sort id ASC/DESC/lowercase-DESC,
unknown sort), `get` (missing/unknown/ok), `staff_basket_get`,
`staff_basket_add_item` (once/recurrent/disabled/override-0/override-
25.50/domain register+transfer+owndomain/addon-via-JSON/addon-via-
form-brackets, and every error: missing/unknown client/product,
addon-as-top-level, recurrent without/invalid period, negative and
non-numeric price, invalid addon, duplicate domain case-insensitive),
`staff_basket_remove_item` (missing line, parent+domain cascade),
`staff_basket_apply_promo` (unknown/expired/inactive/maxed/group/
bundle-unmet/bundle-met/freesetup/pct10, same-code, empty basket),
`staff_basket_remove_promo`, `staff_basket_discard`,
`staff_basket_checkout` (simple, promo, mark-paid Custom incl. txn
dedupe error, mark-paid Stripe, free, pct100, disabled product,
activate=0, override line, once-per-client 9874 at checkout),
`batch_expire` (×2; old guest carts removed, `staff:%` baskets survive).

Staff — admin `group_get_pairs`, admin `login_history_get`
(ok/missing/no-id), guest `login` (ok, wrongpass, unknown, inactive,
cron, bademail, noemail, nopass, nocsrf, bcrypt cost-10→12 rehash),
guest `passwordreset` (ok, unknown, inactive, bademail, noemail,
second-request replacement leaves exactly 1 row), guest
`update_password` (ok + newpass-works/oldpass-fails inversion,
expired, bad code, mismatch, weak, missing code).

## Bugs found by parity22 and fixed in this batch

1. **Admin `cart/get` + `get_list` must NOT resolve auto promos.**
   PHP calls `toApiArray($cart)` with no client, so a manual promo
   still prices in but auto promos never resolve. The first TS port
   passed the staff-basket client id and discounted the view.
   Fixed: both handlers now map with client null.
2. **PHP invoice hash is variable-length** (`bin2hex(random_bytes(
   random_int(15, 30)))` = 30–60 hex), not 48-hex as previously
   recorded. TS `money.ts` now generates the same distribution;
   the parity scrub uses one 30–64 hex rule.
3. **Twig newline rule missing from the TS renderer.** Real Twig
   strips exactly one newline following every `{% %}` tag (verified
   against the vendored Twig) and after `{# #}` comments, but never
   after `{{ }}`. The TS renderer kept those newlines, producing
   blank lines inside invoice `<ul>` loops and a doubled leading
   newline on activation emails. Fixed in `twig.ts` (strip on tag
   consume, incl. closing tags and skipped tags); comment tokens are
   now dropped instead of rendered literally.
4. **PHP staff login leaves the old session row in place.**
   Verified live: after login the primed anonymous row survives
   (until session GC) alongside the new admin row. TS `loginAsAdmin`
   deleted it — now it does not.
5. **`admin_password_reset.updated_at` was NULL on TS insert.**
   Fixed in `replaceAdminPasswordReset` (now = created_at).
6. **Unpaid-invoice `base_income`/`base_refund` were 0 on TS, NULL
   on PHP** (paid case: `base_income` matched, `base_refund` still
   0-vs-NULL). Staff checkout now NULLs both after `prepareInvoice`,
   following the existing `currency_rate` precedent — the shared
   `money.ts` helper is deliberately unchanged (see divergences).

## Divergences and deferred items (with reasons)

- **Shared `money.ts` `prepareInvoice` still freezes `currency_rate`
  and zeroes `base_income`/`base_refund` at creation** (PHP leaves
  all three NULL until payment). Staff checkout patches them back
  locally; other TS flows (e.g. client checkout) still carry the
  old values. Fixing the helper is a separate batch with its own
  regression run — not smuggled in here.
- **Client-checkout addon family fallback** still checks the addon's
  own id where PHP checks `parent_id`; staff checkout implements
  the PHP version. Pre-existing, unchanged.
- **Domain availability/transfer for non-Custom registrars or
  RDAP-enabled configs**: TS throws `Domain availability check
  requires the registrar adapter`. Needs a live registrar API;
  the reference `.com` TLD is Custom with NULL config, so parity
  is unaffected.
- **Domain/hosting service activation on checkout**: status-only
  (no `service_domain` row, no registrar call) — the standing D7
  limitation. No domain-line checkout case is in parity22.
- **Hosting `attachOrderConfig`/`validateOrderData`, custom-form
  validation**: not modeled — no hosting products and no
  form-bearing products exist in the reference catalog, so PHP
  skips those branches too.
- **Bundled-domain free pricing**: free flags are copied into the
  bundled config but do not zero the price — no reference product
  exercises that branch; PHP's application point was not traced.
- **Email template `vars` stamping**: PHP encrypts send vars onto
  the template row (random IV, non-deterministic); TS does not.
  Excluded from parity comparison.
- **Enabled-captcha resets, IP-allowlisted logins, rate limits,
  dummy-verify timing**: not modeled — reference install has rate
  limiters disabled, no mod_staff config, captcha unset, so PHP
  skips them there too.
- **Session-row count** drifted 125 → 131 across the batch's runs
  (sessions are ephemeral; parity restores snapshot state). Not an
  invariant; the five hard invariants above all hold.
- **Parity harness note**: session summaries are compared as
  multisets (ids are random hex, so row order is meaningless);
  invoice hashes are compared by shape only (variable length).

## Files changed (uncommitted)

- `apps/nextjs/src/server/modules/cart.ts` — staff baskets, promos,
  domain lines, checkout, admin reads/expiry.
- `apps/nextjs/src/server/modules/staff.ts` — group pairs, login
  history get, guest login/passwordreset/update_password.
- `apps/nextjs/src/server/db.ts` — cart/promo/admin-auth/reset/
  history/session/transaction helpers (additive only).
- `apps/nextjs/src/server/session.ts` — `loginAsAdmin`.
- `apps/nextjs/src/server/emailer.ts` — `adminId` passthrough for
  to_admin sends.
- `apps/nextjs/src/server/twig.ts` — `url` filter `area` fix (from
  capture work), Twig newline rule, comment dropping.
- `apps/nextjs/src/server/money.ts` — invoice hash length
  distribution only.
- `docs/nextjs-strangler/phase5/capture25.py` + `captures25/` —
  PHP-only capture corpus (re-run clean).
- `docs/nextjs-strangler/phase5/parity22.py` — the parity gate above.

Untouched per instructions: `docs/nextjs-strangler/phase4/ts_invoice1.pdf`.
