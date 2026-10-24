# Phase 2 batch 3: Staff + Activity + News/Custompages

Continues on the batch 1/2 seam. **Parity: 21/21** (`parity4.py` vs the
`capture7.py` corpus; activity is shape-checked A/B — see below), with
batches 1–2 still at 16/16 and 32/32.

## Ported

- **Staff (admin reads)**: `get_list` (excludes system accounts like the
  cron user, as PHP does), `get` (API shape excludes `api_token` and
  embeds groups with computed path/depth/parent_name and decoded
  permissions), `get_pairs`, `is_super_administrator`.
- **Activity (admin)**: `log_get_list` over `activity_system` with the
  PHP default `min_priority=6`, the priority/user/ip/search filters,
  flat join columns plus the nested `staff`/`client` objects the PHP API
  assembles. The log is append-only live data — PHP-side activity
  (logins, mutations) shows up in TS reads immediately; that's the
  shared-DB model working as intended.
- **News**: guest `get_list` (active only) / `get`, admin `get_list` /
  `get` / `create` / `update` / `delete`. Post arrays mirror
  `Post::toApiArray` including the `<!--more-->` excerpt rule.
- **Custompages**: guest `get_list` / `get`, admin `get_list` /
  `get_page` / `create` / `update` / `delete`, with PHP's unique-slug
  generation (base, base-1, …) and its empty-string storage for omitted
  description/keywords.

## Findings

- **The Custompages module was not activated** in the reference install
  (calls fail with error **715** "module not installed/activated"). It
  was activated via the Extension API so the port is genuinely
  exercised. Activation state stays PHP-managed during the strangler
  phase; the TS port serves the module proper.
- **`admin/custompages/get_page` takes `page_id`** — not `id`/`slug`
  like its siblings — and returns `result: null` (no error) for a
  missing page. The port mirrors both quirks.
- **News list ordering is `created_at DESC`** (repository default), with
  same-second ties in id order — the seeded posts share a timestamp, so
  the list *looks* id-ascending until a newer post lands on top.
- **News `author` is list-blind in PHP:** single-get responses resolve
  the author summary ({name}); list responses always carry `author: []`
  because the pager never populates it. Mirrored faithfully.
- **Activity parity is shape-level by necessity**: the log grows with
  every call on both sides, so frozen-value comparison is meaningless;
  `parity4.py` instead compares envelope/item shapes back-to-back
  (PHP direct vs TS) on a filtered query.
- Deferred within these modules: Staff mutations and group management
  (they intersect the fine-grained permissions model, already a
  documented gap), Activity `log`/`log_email` writes, News/Custompages
  `batch_delete`, and the remaining System methods — later batches.
