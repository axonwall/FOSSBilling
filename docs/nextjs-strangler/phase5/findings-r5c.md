# R5c findings: Twig `{% set %}` evaluation (standalone, before transport)

**Scope:** make the TS subset renderer (`twig.ts`) evaluate
`{% set name = expr %}` so R5e's sends are correct from day one.
Transport, queuing, and cron are untouched. Nothing committed,
nothing pushed, no PHP source touched. Branch
`feat/nextjs-phase5-r1`, still at R5b tip `8f81fba` plus the
uncommitted files below.

**Result:** fix implemented, `tsc` + `next build` clean, parity36
51/51, full regression green (parity35–25, parity21 at exactly the
known 9 diffs, fixtures 13/13 both stacks, invariants clean before
and after). The fix is bigger than the scope doc's one paragraph:
the flagship Support renders needed four more renderer pieces
(`{% else %}`, `not`, `|title`, postfix-after-filter) plus a
comparison extension to `evalExpr` — each proven necessary by the
capture diffs, none speculative. §7 separates the set core from
the found-and-fixed divergences.

---

## 1. In-tree `{% set %}` inventory (surveyed, not assumed)

Renderer surface = everything `twig.ts` renders: email templates
(DB `email_template` rows, rendered via `template_send`/`_parse`
strict and via the forgiving `emailer.ts` queue path), massmailer
models, and the Custom payment-adapter template. Client/admin page
templates are React in Next, never rendered by `twig.ts` — their
sets are out of scope (see §8).

DB templates containing `{% set %}` (10 rows, 2 distinct RHS shapes):

| Shape | Templates |
|---|---|
| `{% set is_guest_ticket = ticket.author.role\|default('') == 'guest' %}` | 6 `mod_support_ticket_open`, 11 `mod_support_ticket_staff_reply`, 26 `mod_support_ticket_staff_open` |
| `{% set order = order\|default({}) %}` | 2 `mod_servicecustom_activated`, 12 `mod_staff_client_order`, 13 `mod_servicecustom_suspended`, 14 `mod_staff_order_suspended`, 15 `mod_servicecustom_unsuspended`, 16 `mod_servicecustom_canceled`, 17 `mod_servicecustom_renewed` |

Scope-doc correction: the scope says "4 Support templates". The
PHP email template FILES number 4 (open, staff_close, staff_open,
staff_reply) — but the reference DB seeds only 3 of them. DB row 8
`mod_staff_ticket_close` is a different, staff-facing template with
no set; the client-facing close template from
`src/modules/Support/templates/email/mod_support_ticket_staff_close.html.twig`
(a `{% block subject %}`/`{% block content %}` file) is NOT seeded.
Parity36 covers all 4: the 3 seeded rows plus a crafted row built
from the file's block inners (subject block inner + content block
inner), snapshot-restored.

A third shape exists in PHP email FILES but not in any DB row:
`{% set service = service|default({}) %}` (servicedomain /
servicehosting / servicelicense `*_activated`). Same shape class
as `order|default({})` (bare var + default filter) — no new
evaluator support needed, and no parity case (no seeded template
renders it).

Set-block (`{% set x %}...{% endset %}`) and multi-assign
(`{% set a, b = ... %}`): NONE in any email template file or DB
row (grep-verified). They stay unimplemented per R5-11; the
parser treats them as unknown tags (skipped), exactly as before.

Set consumers (branch, not just variable — what parity asserts):
- `is_guest_ticket` → greeting block (`{% if is_guest_ticket %}`
  in template 6), Reply link (`{% if %}hash link{% else %}id
  link{% endif %}` in all 4), login/profile block
  (`{% if not is_guest_ticket %}` in 11/26/close).
- `order` → only default-guarded reads (`order.title`,
  `order.client.first_name`, `order.created_at|format_date`,
  `order.id`, `order.reason`); the set is behavior-neutral for
  these templates (absent order renders blanks with or without
  the set). Parity36 still covers present + absent as regression
  proof that the set does not break guarded reads.

## 2. What `twig.ts` did before (pinned from code)

- Parser: unknown `{% %}` tags are SKIPPED (`consumeTag`). A set
  statement was therefore silently dropped: the name was never
  assigned, later references resolved via lookup to `undefined`
  → echo `""` / condition falsy. The strict pre-pass counted set
  names as defined, so validation passed while sends rendered the
  falsy branch — the R1d "strict-pass lie".
- `{% else %}` was NOT a parse stop: else content joined the if
  body (if true → both branches' text; if false → neither). No
  `{% elseif %}` exists in any email template.
- `{% if not X %}` fed "not X" to `lookup` as a single path and
  always evaluated falsy.
- `|title` was an unknown filter (passthrough): status rendered
  "open" where PHP renders "Open".
- Postfix after a filter (`|default({}).name`,
  `|default([])[0].content`) failed the filter regex and fell
  through as an unknown filter, rendering "[object Object]" for
  the Department/messages lines.
- `evalExpr` had NO comparison support: it split on `|` and
  treated `== 'guest'` as part of a filter name (see §3).

## 3. Semantics pinned (and one scope assumption corrected)

- Assignment scope: set mutates the passed ctx object. If-bodies
  render with the same object (a set inside an if escapes, Twig
  block scope); for-bodies render with spread copies (a set
  inside a for is contained, Twig for-scoping). The existing
  `renderNodes` structure already yields this; the fix only adds
  the set node.
- Evaluation order: template order. A set read later in the same
  template sees the computed value; a set read before its
  statement sees the pre-set value (no in-tree case reads before
  the set — all sets precede their uses).
- STRICTness: a set RHS referencing a missing var is a 9999 on
  PHP (`Variable "nosuchvar" does not exist`, proven by capture:
  PHP template_send errors, pre-fix TS sent the mail). The fix
  adds set RHS expressions to the strict pre-pass scan, with the
  existing default-guard exemption covering both in-tree RHS
  shapes. After evaluation, later references resolve to the
  computed value instead of `""` (the strict-pass lie, fixed).
- SCOPE CORRECTION: the scope doc says evaluation goes "via
  existing `evalExpr` (extended only if the two in-tree shapes
  are not already covered)". The `order|default({})` shape WAS
  covered. The guest shape was NOT: `evalExpr` had no comparison
  support, so `ticket.author.role|default('') == 'guest'` returned
  the role STRING ('guest' or 'client') — truthy for EVERY role.
  Guest renders passed pre-fix BY ACCIDENT (truthy string = right
  branch); client renders took the guest branch (proven by
  parity36's first run: all 4 client variants failed, all guest
  variants passed). The fix adds top-level comparison splitting
  to `evalExpr` (filter chains bind tighter than comparisons;
  `==`/`!=` use string equality, ordering uses numeric
  comparison — evalCondition's semantics). Chained comparisons
  (`a == b == c`) associate differently than Twig (first-op
  split); not in-tree, documented, not fixed.

## 4. Fix shape (`twig.ts` only, no call-site changes)

- Parser: `{% set name = expr %}` (single-target regex
  `^set\s+(\w+)\s*=\s*(.+)$`) becomes a `set` node; set-blocks
  and multi-assigns fail the regex and keep the unknown-tag skip.
  `{% else %}` is a parse stop for if-bodies (nested ifs consume
  their own else/endif by recursion); the `if` node gains
  `elseBody`. For-else is NOT implemented (no in-tree use).
- Render: `set` assigns `ctx[name] = evalExpr(expr, ctx)`;
  `if` renders `body` or `elseBody`.
- `evalCondition`: leading `not ` negates recursively (in-tree:
  `not is_guest_ticket` only; `and`/`or` are not in email-template
  conditions and stay unsupported).
- `evalExpr`: top-level comparison split (quote/depth-aware;
  `>=`/`<=`/`==`/`!=` checked before `>`/`<`), sides evaluated
  as filter chains. The old filter-chain body is now
  `evalFilterChain`, unchanged in behavior for comparison-free
  expressions (no in-tree echo contains a bare comparison).
- Filter parts: `parseFilter` now returns a trailing postfix
  (`.attr` / `[n]` segments after the filter call), applied to
  the filtered value by `applyPostfix`. Known limitation: filter
  args containing `)` inside string literals can mis-split the
  greedy args match — not present in-tree.
- `|title`: MB_CASE_TITLE semantics, proven against PHP's
  `mb_convert_case` (`open`→`Open`, `on_hold`→`On_Hold`,
  `in progress`→`In Progress`): uppercase a lowercase letter
  following the start or a non-letter.
- Strict pre-pass: set RHS added to the scanned expressions
  (4th alternative in `exprRe`); set names still count as defined.

## 5. Capture corpus (before the fix)

`capture39.py` + `captures39/php.json` + `captures39/ts.json`
(log `~/scratch/fossbilling/r5-logs/capture39.log`). All sends go
through `admin/email/template_send` (JSON, nested ticket/order
vars) and read the queued `email_queue` row — the same surface
parity20 used, and the surface R5e's transport will consume.
Pre-fix results: all 8 Support sends differ; defensive t2
present/absent EQUAL (behavior-neutral, as §1 predicts);
t12 present/absent differ for NON-set reasons (§7); strict set
errors on PHP (9999) and sends on TS; validate_all PHP 25/1
(the crafted strict template) vs TS 26/0.

## 6. Parity36 results — 51/51

`docs/nextjs-strangler/phase5/parity36.py`. Sections: A full
subject+content equality per send (12 cases: 4 Support templates
× guest/logged-in, 2 defensive templates × present/absent);
B branch-specific content asserted exactly (greeting, hash vs id
link, login block, Department, Status title, first-message line,
t12 date); C strict case (9999 both stacks, hash segment
scrubbed — PHP embeds a per-template hash, TS emits the bare
name, the documented R1d shape — plus no queue row written, and
validate_all equal at 25/1 on both); D restore proof
(invariants, config hash, sequences, crafted rows gone).

First run: 45/51. The 6 failures were (a) the 4 client-variant
body diffs — the evalExpr comparison bug (§3), fixed, not
masked; and (b) 2 strict-message mismatches — a TEST bug (the
scrub did not normalize TS's bare `__string_template__` name),
fixed in the suite. Second run: 51/51.

## 7. Found-and-fixed divergences (not hidden, not set-related)

The full-body gate exposed three pre-existing renderer bugs
outside the set core. All three are fixed in `twig.ts` in this
batch because parity36's full-body comparison cannot pass
without them; each is proven by capture, not assumed:

- `format_date` padding: PHP (twig/intl-extra, en_US medium)
  renders "Oct 1, 2026"; TS rendered "Oct 01, 2026"
  (`formatDateValue` hardcoded "M d, Y"). Fixed to "M j, Y".
  PHP's own PDF template uses `|format_date` for the same
  dates, so the fix is consistent for `pdf.ts` too (its only
  other `formatDateValue` caller; its inputs are always real
  dates).
- `format_date` on empty: PHP renders TODAY (Twig's date
  converter treats ''/null as now); TS rendered "". Fixed:
  empty/null → today in "M j, Y". Note for future runs: the
  t12_absent case compares a today-date on both stacks — a run
  straddling midnight would fail on that one line only, and the
  failure would be self-evidently environmental.
- `url` trailing slash: PHP `Url::link()` trims BOTH ends
  (`trim($uri, '/')`); TS stripped leading slashes only, leaving
  "order/manage/" for an empty interpolation. Fixed: trim both
  ends, including after the admin prefix (no in-tree empty-admin
  case, but the mirror is exact).

## 8. Left for a later batch (not hidden)

- Set-blocks and multi-assign: no in-tree use in email
  templates; parser still skips them. If a future template uses
  either, it needs a parser batch, not a silent fix.
- `and`/`or` in conditions, chained comparisons, ternary
  expressions: not in email-template use; unsupported.
- The client page template
  (`Support/templates/client/mod_support_ticket.html.twig`) has
  a chained set (`can_reply` depending on `is_guest_ticket`,
  with `or`/`and`/`not`) — but Next renders client pages as
  React, never through `twig.ts`, so it is out of this batch's
  surface. If that template is ever rendered by the subset
  renderer, it needs the `and`/`or` extension first.
- Stray `{% else %}` with no enclosing if: still skipped
  silently (unknown-tag behavior), where PHP would syntax-error.
  No in-tree case; the strict balance check does not catch it.
- `emailRenderCtx` hardcodes (`default_currency` "USD",
  `FOSSBillingVersion` "0.8.9") and `template_render`
  system-context-only: untouched — no set case depended on them
  (all parity36 sends agree without touching either).
- R5a N1 (JSON-null reminder stored value) and the
  `canUpdateParam` permission gap remain open, as before.

## 9. Regression results (exact counts)

- `tsc --noEmit` clean; `npm run build` exit 0; reference Next
  (:3001) restarted on the fresh build before parity36 (parity
  green is itself the freshness proof: a stale bundle still
  renders the guest branch for client authors).
- parity36: **51/51**.
- parity35: **210/210**; parity34: **164/164**; parity33:
  **77/77**; parity32: **65/65**; parity31: **63/63**;
  parity30: **179/179**; parity29: **62/62**; parity28:
  **128/128**; parity27: **27/27**; parity26: **62/62**;
  parity25: **ALL GREEN** (its `admin/support/canned_delete`
  php=403 / ts=200 note line is pre-existing suite output, not
  a failure).
- parity21: **194/203, exactly the known 9 diffs** (names
  re-confirmed from `parity21-diffs.json`).
- Fixtures: **13/13 both stacks**, verified via `results-php.json`
  / `results-next.json` (all entries PASS), not the summary lines.
- DB invariants clean before AND after: invoice 323, client_order
  11, email_queue 67, service_custom 17, extension 6,
  extension_meta 3, setting 38, admin 2, admin_group 3,
  admin_group_member 1, currency 1, client 3, support_ticket 2,
  tld 1; sequences setting 56 / extension_meta 41 / currency 8;
  reference `config.php` hash unchanged. Reference Next (:3001)
  restarted on the fresh build after the fixture run (fixture
  runner's own :3001 listener killed by explicit PID first, per
  the R5a trap); PHP:8080 untouched throughout the regression.
- Logs: `~/scratch/fossbilling/r5-logs/parity36.log` (first run,
  45/51), `parity36b.log` (51/51), `my-r5c-regress.log`
  (parity36–25 + parity21 tails + fixtures + invariants),
  `capture39.log` (pre-fix corpus summary).
- No old assertion needed updating: no prior suite asserted the
  dropped-set, uncapitalized-status, "[object Object]", or
  padded-date behavior — the divergences lived only in renders
  no suite had compared full-body before.
