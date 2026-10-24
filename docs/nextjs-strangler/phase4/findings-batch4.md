# Phase 4 batch 4 — Support + Extension leftovers

Oracle: `capture16.py` + `captures16/` (53/60 OK; the 7 non-OK are
intended error pins). Parity: `parity13.py` **47/47**.

## What was ported (TS `modules/support.ts`)

- Tickets, all three roles. Admin: get_list/get/update/delete,
  reply, close, create, message_update, message_history_get_list,
  batch_delete, batch_ticket_auto_close, ticket_get_statuses
  (counter + titles forms), task_complete. Client: get_list/get,
  create, reply, close, helpdesk_get_pairs. Guest: create/get/
  reply/close by access hash, guest_tickets_enabled,
  helpdesk_get_pairs.
- Helpdesks: admin get_list/get_pairs/get/create/update/delete.
- Canned replies + categories: admin get_list/pairs/get/create/
  update/delete and category pairs/get/create/update/delete.
- Notes: admin note_create/delete (surfaced in the admin ticket
  array only).
- Knowledge base: admin article/category get_list/get/create/
  update/delete; guest article/category get_list/get.

## Pinned semantics

- Status transitions: an admin reply moves a ticket to
  `on_hold`; a client or guest reply moves it to `open`.
  Admin close is idempotent (already-closed returns true);
  client close sets closed directly.
- Reopen rule: only the *client* reply path checks
  `canBeReopened`. A closed ticket reopens only if its helpdesk
  has `can_reopen`; the reference helpdesk ("General") has
  `can_reopen = 0`, so the refusal ("Ticket cannot be
  reopened.") is pinned, not a bug. Admin and guest replies
  have no such check.
- Ticket arrays are identity-shaped: the client/guest array
  strips support_helpdesk_id, client_id, priority, access_hash
  and all rel_* fields, and omits `rel`/`priority`/`notes`
  (admin-only); the guest array adds `hash`. First message,
  replies count, helpdesk `{id, name, can_reopen}`, author and
  client blocks are always present.
- Message edit is admin-only: editing a client message throws
  "Only admin replies can be edited". A successful edit writes
  one history row with the previous content. The history
  endpoint returns a **bare list, not a pager**.
- Defaults: new tickets are `open` with priority 100 and
  `rel_status` `complete` (`pending` when a rel_task is set).
  Guest tickets get a random 30–60-hex access hash (same
  generator family as invoice hashes); client tickets carry
  `access_hash: null`.
- Auto-close closes `on_hold` tickets where
  `updated_at + helpdesk.close_after hours < now` (per-helpdesk
  window; reference: 24h).
- KB guest get increments `views` by exactly 1 (verified
  0 -> 1); the admin list omits `content`, the get includes
  it. KB category arrays carry `articles: []` on plain
  list/get (population under search is unverified).
- `canned_pairs` is grouped by category title (category id
  ASC, then title ASC), not a flat id->title map.

## Extension: deliberately partial (`modules/extension.ts`)

Only `config_get` is ported. Stored extension config is
encrypted at rest with the install salt, which the TS side
cannot decrypt — so config_get returns `{ext}` plus stored
config only when no encrypted row exists (the common case;
support returns exactly `{ext: 'support'}`). A present
encrypted row is a documented gap, not a fabricated value.
Everything else stays on the PHP proxy by design:
`get_list`/`get_navigation` read module manifests from disk,
`languages`/`locale_completion` read translation catalogs, and
`activate`/`deactivate`/`install`/`uninstall`/`update`/
`config_save`/`toggle_language` execute PHP module code or
write encrypted config.

## Documented gaps

- Message-history rows omit `content_html`: PHP renders the
  previous content through its Markdown renderer, and the TS
  side has no Markdown renderer. Omitting beats fabricating.
- Support-module config (guest-ticket disable flag, KB
  toggles, wait_hours) lives in the same encrypted store, so
  TS defaults to guest tickets enabled and KB views enabled,
  matching the reference install. The wait_hours throttle on
  client ticket creation is not enforced.
- Ticket creation does not send the PHP autoresponder canned
  reply (event-driven in PHP) and does not dispatch PHP domain
  events, per the Phase 2 gap note.

## Harness lessons

- A long-lived staff session's later Extension calls
  spuriously reported their RequiredParams as missing; a
  fresh staff login fixed it. Harness quirk, not product
  behavior — the capture re-logs in before the Extension
  section.
- `next start` serves the last build: the history-shape bug
  (pager vs bare list) was initially masked by a stale build
  serving PHP. Rebuild after source changes before parity.
