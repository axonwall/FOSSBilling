# Phase 5 R2d findings — staff + groups UI

Batch: R2d (fourth R2 batch, approved scope `r2-scope.md` D2-1..D2-5).
Branch: `feat/nextjs-phase5-r1` (base `c421025`, R2c). No commit yet;
this doc, `parity28.py`, `capture31.py`, `captures31/`, and
`extract-perms.py` are the batch deliverables alongside the code.

## What was built

Next-native admin pages (server components, Tailwind, Phase 1 style).
Reads go through `adminApi` (fbCall to the PHP origin, so PHP guards
apply on reads); mutations go through `fbPost` to `/api/fb` (so TS
seam guards apply on writes). No per-page permission gating beyond
the dashboard pattern; the API enforces.

- `/admin/staff` — list (name link, email, status, groups, since;
  links to New staff + Groups). `admin/staff/page.tsx`.
- `/admin/staff/new` + `NewStaffForm` — email\*/name\*/password\*/group
  select/status (default active)/signature/timezone. Note: the form
  defaults status to active while the API defaults to inactive.
- `/admin/staff/[id]` + `StaffEditForm` (email/name/signature/timezone/
  status; all fields posted explicitly, blank timezone omitted so it
  leaves the value unchanged), `StaffPasswordForm`, `StaffGroupsForm`
  (current groups + remove, add select), `StaffDeleteButton`
  (rendered except for cron, id 2; the API enforces the rest).
  Also shows login history (`StaffLoginHistory` via
  `staffLoginHistory`).
- `/admin/staff/groups` — list (name link, path, parent, protected,
  created). `admin/staff/groups/page.tsx`.
- `/admin/staff/groups/new` + `NewGroupForm` — name\*, parent select;
  empty parent omitted so the API defaults to the super-admin group.
- `/admin/staff/groups/[id]` + `GroupDetailsForm` (name + parent
  select excluding self + descendants via path-prefix
  `selfPath + " / "`, empty parent posts as null),
  `GroupPermissionsForm` (matrix: per-module access checkbox + key
  checkboxes; submits ONLY checked entries, mirroring the PHP form;
  preserves non-matrix modules' entries verbatim so saving never
  drops data), `GroupMembersForm` (list + remove + add select;
  `readOnly` variant for protected groups), `GroupDeleteButton`.
- Sidebar (`(admin)/layout.tsx`): static Staff section. PHP nav has
  NO staff-management entry (the Staff module only declares "Staff
  Login History" under activity), so `NEXT_ROUTES` alone cannot
  surface Staff. The section is added in the component, filtered with
  nav-equivalent semantics via in-process `hasPermission`: Staff link
  requires staff module access; Groups link additionally requires the
  `manage_groups` key. Fail closed (no section if the lookup throws).
  The `get_navigation` endpoint is unchanged.
- `lib/fossbilling.ts` additions: `staffList`, `staffGet`,
  `staffPairs`, `staffIsSuperAdmin`, `staffGroupList`, `staffGroupGet`,
  `staffGroupMembers`, `staffGroupPairs`, `staffLoginHistory`.
- `lib/permission-catalog.ts` (new): `PERMISSION_CATALOG` (32 visible
  modules) + `MATRIX_MODULES`, extracted from all 37
  `src/modules/*/Service.php::getModulePermissions()` via
  `extract-perms.py`. All 119 keys are bool at 0.8.9 (no select-type
  keys exist). Hidden modules excluded per the PHP template filter:
  api, branding, cart, page, profile (page/profile are also
  `can_always_access`). Documented superset note: keys posted for an
  inactive module are inert (dispatcher 715-gates inactive modules)
  and apply if the module later activates.

## The significant R2d discovery: missing hierarchy guards in the TS seam

PHP `Staff\Service` staff mutations enforce hierarchy rules the TS
port was missing: a Lead holding `create_and_edit_staff` could mint
super-admin accounts through the TS seam. Implemented in
`server/modules/staff.ts`, mirroring PHP exactly:

- `actorBypassesHierarchy`: cron actor or super-admin bypasses;
  otherwise a target group must be a STRICT descendant of one of the
  actor's groups (a group is not its own descendant), and a target
  staff member's groups must ALL be strict descendants of the actor's
  groups.
- `assertCanManageGroup` → "You can only manage lower staff groups";
  `assertCanManageAdmin` → "You cannot manage your own staff account
  here" (self), "You can only manage staff accounts in lower groups"
  (cron target, group-less target, or non-descendant groups);
  `assertCanRemoveActiveSuperAdministrator` → "Cannot remove the
  last active super administrator".
- Wired into: `create` (after group lookup, before dup check),
  `update` (after field computation, before write), `delete` (after
  cron check), `change_password` (after load),
  `group_member_add`/`group_member_remove` (after loads; remove
  returns true early when not a member, before the super-admin check,
  matching PHP).
- Also fixed in the same handlers: deactivation clears `api_token`
  (whenever resulting status is inactive, matching PHP) and
  invalidates sessions on active→inactive transition; `delete` now
  also deletes password resets (memberships were already deleted by
  `deleteAdminRow`); `change_password` now invalidates sessions.
  `invalidateAdminSessions` is a hoisted function declaration in the
  same file, so calling it from earlier handlers is safe.
- `server/db.ts`: added `api_token: string | null` to
  `updateAdminRow`'s field type.

## The second R2d seam fix: bracket-encoded group permissions

parity28's matrix case exposed that TS `group_update` silently
ignored PHP's native nested-form permissions shape
(`permissions[mod][key]=1` arrives as flat keys because the route
does not expand brackets), while PHP requires an array and rejects a
JSON string. Fixed in `staff.ts` `group_update`: bracket keys
matching `^permissions\[([^\]]+)\]\[([^\]]+)\]$` are expanded and
stored VERBATIM as JSON (PHP stores the array as-is, strings
included, minus `_submitted`, which never matches the two-level
pattern — so seam and PHP read-backs match exactly). A bracket
payload wins over a plain `permissions` param when both are present
(a request never mixes them). The JSON-string branch is kept: the
group editor form posts JSON to the seam (its own mutation path),
and TS guards use truthiness, so `"1"` and `true` behave alike.

## Group-editor access rule (mirrors the PHP template)

The group editor page reads group/members via fbCall, then checks
`isSuperAdmin(adminId)` in-process. Non-super viewers get ONLY the
notice box "Only super administrators can manage staff groups" — no
editor, no matrix, no group data rendered — even when the read
succeeded (a Lead holds `manage_groups`, so the read passes but the
mutation would 403). Protected groups render read-only for
super-admins (name/path/parent/protected note + members, no forms),
since the API refuses all modifications to them.

## Verification: parity28 — 128 checks, 0 failures

`parity28.py` (PHP outputs recorded, full restore + reseed, replayed
on TS so ids match; timestamp fields scrubbed; envelopes compared,
never HTTP status). Sections:

- A. Page smoke (super-admin): all 8 new routes 200 with sidebar
  Staff section + real-data markers; missing staff/group ids render
  the API error box ("Staff member not found" / "Group not found"),
  not a crash.
- B. Logged-out smoke: staff list + group editor render the fallback
  header chrome (no `<aside>` sidebar) with the R2c-style "Sign in
  as staff" link on the error box. (R2d error boxes gained that link
  during this batch — R2b list pages lacked it; R2c products had it.)
- C. Secret audit: staff get/get_list/group_get/group_get_list
  envelopes on both stacks contain no `pass`/`api_token`/`password`
  keys at any depth (recursive scan). Clean on both stacks.
  `staffArray` excludes `api_token` and password hashes by
  construction; group payloads carry no secrets.
- D. Staff CRUD equivalence (super, crafted rows): create (incl. dup
  788954, unknown group "Group not found"), update (incl. dup email),
  deactivate (status inactive + `api_token` NULL in DB + the exact
  session row gone), change_password (new-password login works, old
  fails), delete (row + memberships + password resets gone).
- E. Group matrix round-trip: nested-form create → update SET1 →
  read-back exactly → update SET2 → read-back exactly → delete →
  group_get "Group not found"; plus the page's JSON path (TS posts
  JSON, PHP posts nested form; truthiness-normalized read-backs
  equal). Guards: protected update/delete, children block,
  members block, reparent (parent_id + path) — all equal.
- F. Hierarchy cases (Lead + Staff personas): Lead create into group
  3 (descendant, allowed) vs group 2 (own) and group 1 (super) —
  "You can only manage lower staff groups" both; Lead update of a
  group-3 member (allowed), own account (self error), super-admin
  (lower-groups error); Lead delete descendant (allowed) vs
  super-admin (lower-groups error); Lead change_password descendant
  (allowed, new login works) vs self (self error); member
  add/remove descendant (allowed) vs add to group 1 (lower-groups
  error); Lead group_update → 403 "Only super administrators can
  manage staff groups" both; Staff group_get / group_create →
  method-guard 403s both; last-active-super-admin refusals (delete,
  deactivate-other, remove-from-super-group as super-admin —
  refusal-only, rows asserted still active/member afterwards);
  self-deactivation → "You cannot deactivate your own staff account"
  both; Lead group list ok, Staff group list denied.
- G. Non-super viewer behavior on group pages (TS pages): Lead group
  editor shows ONLY the notice box (no matrix, no "Support Lead"
  data); Staff group editor/list and staff list show the dispatcher
  725 error box "You do not have access to the staff module"
  (Dispatcher.php:69 — the module-access gate fires before
  AppAdmin's 403 message; the initial smoke expectation used the
  AppAdmin text and was corrected); Lead staff list renders;
  sidebar filtering verified on the dashboard (no staff links in
  main content): Lead sees the Groups link, Staff sees no Staff
  section at all.

## Regression gates (all green)

- parity27: 27/27. parity26: 62/62. parity25: 203/203 (the two
  `php=403 ts=200` lines in its log are the documented status-only
  seam convention, not failures).
- Fixtures: 13/13 on BOTH stacks (`run-fixtures.py`).
- parity21: 194/203 — exactly the known 9 diffs, no new ones (3
  tld_delete + sd_reg_available + 4 .cap24 downstream +
  dl_admin_send_file_missing_stored).
- DB invariants clean before and after every run (admin 2,
  admin_group 3, admin_group_member 1, invoice 323, client_order 11,
  support_ticket 2, client 3, tld 1, tld_registrar 3, service_domain
  0, email_queue 67, servicedomain_last_sync 2026-10-26 03:24:56,
  service_downloadable 0).
- `npx tsc --noEmit` clean; `npm run build` exit 0 with all new
  routes in build output; Next restarted on the fresh build before
  all page-smoke runs.

## Known divergences (documented, not forced)

- TS error envelopes are always HTTP 200 while PHP answers 4xx with
  the same envelope (seam-wide convention; parity compares envelopes).
- TS staff create presence messages ("Email was not passed") vs PHP
  RequiredParams ("Email address was not passed").
- Pre-existing, same class as the R2a params-vs-guard divergence: TS
  `update` email-clash check runs before the hierarchy check (PHP
  reports dup at flush, after hierarchy) — parity uses non-clashing
  emails for hierarchy cases. TS `group_update`/`group_delete` check
  super-admin before group load (PHP loads first) — nonexistent-group
  + non-super differs; parity uses real ids.
- PHP stores nested-form permission values as `"1"` strings; the
  page's JSON path stores booleans. Read-backs differ in leaf type
  across write paths but are truthiness-equal; guards and the editor
  form treat both correctly.

## Harness notes (for the next batch)

- parity28's first two runs crashed on a harness bug, not product
  code: `c()` returns a single envelope dict, but run() unpacked it
  as `env, _ = c(...)` — unpacking a dict yields its keys, so `env`
  became the string `"result"`. Fixed by dropping the unpacking at
  every call site (and `c(...)[0]` in the secret-audit section).
- A debug leftover (repro admin deleted without its membership) once
  made invariants-before fail; the fix was deleting the orphan
  membership, not touching restore() — restore itself is sound.
- The Staff persona (group 3) holds support permissions ONLY — no
  staff module access at all. Any smoke expecting Staff to see staff
  pages is wrong; it must expect the 725 error box.

## Not built / left unverified

- No per-page permission gating beyond the dashboard pattern (by
  design — R2a seam guards + PHP guards enforce at the API).
  Sidebar active highlighting remains the R2a known gap, out of
  scope.
- Browser form submissions were not exercised (no live browser in
  this subagent): forms were verified at their API path (fbPost →
  seam for mutations, fbCall → PHP origin for reads) and by page
  rendering; a click-through of each form in a real browser is still
  open.
- The pages are local-only (uncommitted, unpushed, undeployed), like
  the rest of the R1/R2 stack.
- PHP sources untouched; `~/MEMORY.md` untouched.
