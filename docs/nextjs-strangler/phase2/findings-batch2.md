# Phase 2 batch 2: currency mutations + Profile/Client reads

Continues batch 1 on the same seam. **Parity: 32/32 responses identical
to PHP** (`parity3.py` vs the `capture6.py` reference corpus), and batch
1's corpus still passes 16/16.

## What was ported

- **Currency mutations** (`admin/currency`): `create`, `update`,
  `delete`, `set_default` — the first TS **writes** to the shared DB
  (lazy write connection in `src/server/db.ts`; timestamps in Doctrine's
  `Y-m-d H:i:s` format). The full error surface is mirrored and covered
  by the corpus: duplicate create, invalid code, manual-without-rate,
  non-positive rate (create wording vs update wording differ in PHP —
  both preserved), the update invalid-rate **code 151**, format-pattern
  and fraction-digit validation, delete-the-default refusal,
  manual-override-on-default refusal. The mutation parity sequence is
  net-zero (create EUR → update → set EUR default → set USD back →
  delete EUR), so PHP and TS replays are directly comparable.
- **Profile reads**: `client/profile/get` (self array + balance) and
  `admin/profile/get` (identity array — note PHP includes the admin's
  own `api_token` in this response; the port preserves that behavior
  for the authenticated admin, it does not widen it).
- **Client reads** (`admin/client`): `get` (by id or email, incl. the
  admin extras, group titles, balance, and `api_token`),
  `get_list` (filters: id/name/email/company/status/search; PHP's
  newest-first ordering), `get_pairs`.

## Findings

- **Session identity encoding is asymmetric in PHP itself:** staff
  login stores an `admin` array ({id, email, name}) in the session,
  while the client API login stores a bare `client_id` integer (the PHP
  API layer hydrates the client per request). The TS session reader now
  accepts both forms for both roles.
- **Parity mode double-executes mutations** by design (it replays the
  call against PHP to compare), so `[parity] MISMATCH` lines for
  create/delete during `FB_PARITY=1` are expected artifacts — the
  response the client received still matched PHP's first-execution
  response in all 32 corpus steps. Parity mode is exact for reads; for
  mutations, treat the corpus comparison as authoritative.
- **Known divergences / gaps (documented, not silent):**
  - `currency/create` without an explicit rate: PHP first calls its
    external rate provider and falls back to 1.0 on failure; TS uses
    1.0 directly. Passing an explicit rate (the normal admin flow) is
    identical.
  - PHP fires domain events around currency delete / set-default; TS
    does not dispatch them yet. No listeners in the reference install
    alter the API result, but an event system port is required before
    TS serves installs that rely on module event hooks.
  - PHP's per-staff fine-grained permissions (`checkPermissions`) are
    not yet modeled in TS; handlers require the admin/client identity.
    Superadmin behavior matches; restricted-staff behavior is a gap to
    close before TS modules serve real traffic.
  - `update_rates` / `is_cron_enabled` are not ported (external rate
    provider + settings); they still proxy to PHP.
