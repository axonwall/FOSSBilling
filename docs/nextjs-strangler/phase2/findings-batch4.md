# Phase 2 batch 4 (leftovers): System completion + Staff mutations/groups

**Parity: 27/27** (`parity5.py` vs `capture8.py`), batches 1–3 unchanged
(16/16, 32/32, 21/21) — **96 parity checks green across Phase 2**.

## Ported

- **System (guest)**: `countries`, `phone_codes`, `timezones` (static
  Intl reference data vendored from PHP's own output, like the currency
  tables), `default_country`, `param` (public settings only; the exact
  "Parameter X does not exist" error otherwise), `locale`, and
  `get_pending_messages`.
- **Pending messages are the one place TS rewrites a PHP session:**
  they live in the session's attribute bag and reading clears them.
  The rewrite re-serializes only the attributes segment and preserves
  every other segment byte-for-byte — verified by a round-trip test on
  a real session row (inject key → remove key → byte-identical).
- **System (admin)**: `get_params` (full settings map) and
  `update_params` (settings writes through the same table).
- **Staff mutations**: `create` (bcrypt cost-12 hashes via bcryptjs —
  `$2b$` hashes, which PHP's `password_verify` accepts; duplicate
  email keeps PHP's code **788954**; PHP's full password-strength rules
  and messages), `update` (incl. status coercion and the
  cannot-deactivate-yourself guard), `delete` (cron-account guard),
  `change_password` (match + strength + hash).
- **Staff groups**: `group_create` (parent defaults to the super-admin
  group), `group_get`, `group_get_list`, `group_update`, `group_delete`
  (protected / has-members / has-children guards, exact messages),
  `group_member_add/remove/get_list`, `admin_group_get_list`, and
  `login_history_get_list` (shape-checked A/B; the history is
  append-only live data).
- **Leftovers from batch 3**: `news/batch_delete`,
  `custompages/batch_delete`, `activity/log` writes.

## Deliberately NOT ported (stay on PHP; runtime-bound, not data-bound)

- System `env`, `instance_id`, `messages`, `clear_cache`,
  error-reporting toggles, interface-IP setters, and the whole
  core-update family (`update_available`, `update_core`, …): these
  report on or mutate the **PHP runtime itself**. In the strangler
  model they remain PHP's until Phase 5 retirement planning decides
  their TS replacements.
- Guest System `current_url`, `template_exists`, `paginator`: bound to
  the PHP request/theme rendering context.

## Standing gaps (unchanged, already documented)

Fine-grained per-staff permissions (`checkPermissions` /
`assertCanManage*`) are approximated by identity + the super-admin
group checks that the group endpoints themselves enforce in PHP;
PHP domain events are not dispatched by TS; staff deactivation does
not yet invalidate the target's existing sessions the way PHP's
profile service does. All three are Phase 3 prerequisites to close
before TS serves money modules or real traffic.
