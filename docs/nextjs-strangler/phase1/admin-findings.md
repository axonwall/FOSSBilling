# Phase 1 batch 2 — admin top surfaces: notes

Companion captures: `capture3.py` + `captures3` entries in `captures/`
(13/14 OK; the one error is the expected post-logout auth failure).

- Staff auth is `guest/staff/login` (email + password), a separate identity
  in the **same** PHP session as the client identity — the Next app keeps
  the two areas side by side on one cookie jar, exactly like PHP does.
- The admin dashboard numbers come from `admin/stats/get_summary` and
  `admin/stats/get_orders_statuses`; there is no single "dashboard"
  endpoint.
- Admin list endpoints return the same paginated envelope as client lists
  (`{pages, page, per_page, total, list}`), with related records embedded
  (`client` on orders/invoices/tickets), so the admin tables need no
  per-row lookups.
- Setup note for the reference instance: the install-time `FB_ADMIN_PW`
  was not retained after Phase 0, so the throwaway admin password was
  reset in the runtime copy only (`diag-admin-reset.php`, local scratch —
  not part of this repo). The seeded staff account is otherwise untouched.
