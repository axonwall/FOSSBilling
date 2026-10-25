# Phase 5 R1 findings — Profile + small mop-ups

Branch: `feat/nextjs-phase5-r1`, stacked on the Phase 5 plan
commit `4aa1052`. 19 endpoints ported: admin/client profile
(update, change_password, logout, destroy_sessions,
generate_api_key/api_key_reset/api_key_get) plus support
(kb_category_get_pairs, kb_enabled, kb_suggestions_enabled,
public_tickets_enabled), cron (save_settings,
regenerate_cron_hash), currency (is_cron_enabled).
TS-served total rises from 228 to 247 of 579.

## Pinned semantics (capture17.py / captures17/)

- Password strength (PHP validator, exact): required, 8–256
  chars, at least one digit, one lowercase, one uppercase
  letter. No special-character requirement.
- Admin vs client change-password messages differ in PHP
  itself and are reproduced, not unified: admin "New
  password is required" / "Passwords do not match"; client
  "New password required" / "Passwords do not match.".
  Wrong current password: "Current password incorrect"
  (both). Missing-field order follows PHP's RequiredParams
  order (current, new, confirm).
- Bad timezone: "Invalid timezone: <value>" (both roles,
  via IANA validation; TS uses Intl.DateTimeFormat).
- Admin `generate_api_key` returns boolean true (not the
  key); admin `api_key_reset` (for a client id) and client
  `api_key_reset` return the new 32-char alphanumeric token
  string. Client `api_key_get` returns null when unset.
  Every key generation/reset invalidates that user's
  sessions — including the caller's own session.
- Session invalidation mirrors PHP's
  `invalidateSessions`: it walks the `session` table,
  decodes the Symfony attribute bag, and deletes rows
  whose `admin.id` (staff) or bare `client_id` (client)
  matches. Verified: a second live session dies while the
  caller re-logs in.
- Logout deletes the current session row and clears the
  cookie; the next call with that jar is 201.
- Client update: email uniqueness is client-email scoped —
  an admin's address is NOT a duplicate (a capture test
  that assumed otherwise changed client 1's email to the
  admin's and broke logins until restored; the corrected
  test uses client 2's address and pins "This email
  address is already registered."). An email change resets
  `email_approved` to NULL and revokes pending
  confirmations (extension_meta mod_client /
  confirm_email rows). The client self view omits custom_*
  fields (they are admin extras) — verified against the
  oracle's key set, not assumed.
- Support toggles on the reference install (no stored
  extension config): kb_enabled true, public_tickets
  (= guest tickets) true, kb_suggestions false for
  contact, ticket, and unknown areas. KB category pairs:
  {1: "Frequently asked questions", 2: "How to's"}.
- Cron save_settings returns true; regenerate returns
  {cron_hash: 64 hex}. Currency is_cron_enabled true.
- Admin profile get shape was already ported in Phase 2
  (client.ts) and matches exactly, including date-only
  created_at/updated_at.

## Documented gaps (carried, not hidden)

- PHP's profile password-change rate limiter is NOT
  mirrored (TS has no limiter yet; Phase 5 plan R5).
- Cron settings and the currency sync_rate live in PHP's
  encrypted extension config, which TS cannot read or
  write. TS stores cron settings in the settings table —
  the same store its own guest cron trigger reads — so
  the TS stack is self-consistent but divergent from
  PHP's store. Support toggles return no-stored-config
  defaults for the same reason.
- Fine-grained staff permissions remain approximated
  (Phase 2 gap): admin api_key_reset does not enforce
  the client/manage_api_keys permission.
- PHP dispatches profile domain events; TS does not
  (Phase 2 gap note).

## Gates (all foreground-verified)

- parity14.py: 44/44 MATCH.
- Fixtures: 13/13 both stacks.
- Regressions: parity13 47/47, parity12 12/12, parity11
  16/16, parity10 14/14, parity9 16/16, parity7 20/20.

## Harness notes

- The fixture gate failed 9/13 on the Next stack before
  the code was touched: parity12 re-runs during batch 4
  had left client-1 balance rows (ids >= 16, net +65)
  in the reference DB, and the runner re-snapshots that
  DB every run. Deleted the artifact rows (balance back
  to 0) and re-ran 13/13. Standing rule, repeated:
  capture/parity runs must clean balance rows too.
- A crashed parity run (KeyError on custom_1, fixed by
  correcting the check to the oracle's key set) left
  reference state unrestored; the next run's diffs were
  that leftover, not code. The runner's restore step now
  also runs before the client section's null-token check
  (admin api_key_reset sets a client token mid-run).
- The reference PHP server was down at the start of the
  batch (VM replacement) and a stale Next server held
  port 3001; both were restarted before the gate runs.
