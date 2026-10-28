# Phase 5 R2b findings — four core admin sections

Scope: `r2-scope.md` R2b (finish the four core sections), on
`feat/nextjs-phase5-r1` on top of `34f2317` (R2a). No PHP sources
modified. No commit, no push. Builds on R2a's sidebar + permission
model; no new API endpoints were needed — every action below already
existed in TS.

## 1. What was built

### Invoice detail — `apps/nextjs/src/app/(admin)/admin/invoices/[id]/`

- Server page reads `admin/invoice/get` (new `adminApi.invoiceGet`
  wrapper in `lib/fossbilling.ts`) + `admin/invoice/transaction_get_list`
  (new `adminApi.invoiceTransactionList` wrapper) and renders serie_nr,
  status, total, client link, buyer, subtotal/tax/total, dates, the
  `lines` table, the transactions table (when any), notes, and a PDF
  link to the existing client route `/invoices/[hash]/pdf`.
- `InvoiceActions.tsx` (client component, `fbPost` pattern from
  `StaffReply`): Mark as paid (unless paid), Refund (when paid), Send
  reminder (when unpaid and not canceled), Cancel invoice (when
  unpaid), Delete (only when the payload's `deletable` flag is true).
  Buttons are presentation gating only; the API enforces. Delete
  confirms via `window.confirm` and routes back to the list on success.
- Invoices list now links each serie_nr to its detail page.

### Client create + edit

- `/admin/clients/new` + `NewClientForm.tsx`: email*, first_name*,
  last_name, company, address_1/2, city, state, postcode, country,
  phone_cc, phone, currency, status select, password (optional),
  send-welcome-email checkbox (default on). Only non-empty fields are
  posted; the API's own RequiredParams/validation errors surface.
  On success routes to `/admin/clients/<new id>` (create returns the id).
- `ClientEditForm.tsx` on `/admin/clients/[id]`, prefilled from
  `admin/client/get`: the `CLIENT_SIMPLE_FIELDS` set the update handler
  accepts (email, names, company fields, addresses, city/state/
  postcode/country, phone_cc/phone, currency, status, lang, timezone,
  notes). Only non-empty fields are posted — clearing a field through
  this form is not supported (documented limitation, not an API gap:
  posting empty strings would write them for most simple fields).
- Clients list gained a "New client" link. Client delete was NOT added
  (out of the R2b brief: create + edit only); the endpoint exists
  (`admin/client/delete`) for a later batch.

### Order actions — `OrderActions.tsx` on `/admin/orders/[id]`

Buttons by current status: pending/failed_setup → Activate; active →
Suspend, Renew, Cancel; suspended → Unsuspend, Cancel; canceled →
Uncancel; Delete always (with confirm, routes to the list on success).
Optional reason field feeds suspend/cancel. The API enforces the rest
(e.g. cancel on pending_setup errors "Cannot cancel pending_setup
order" — surfaced verbatim).

### Ticket actions — `TicketActions.tsx` on `/admin/tickets/[id]`

Close (unless closed), Reopen via `ticket_update` with status `open`
(statuses are open/on_hold/closed per `ticket_get_statuses`), Delete
(with confirm, routes to the list). Sits next to the existing
`StaffReply` component and reuses its mutation pattern exactly.

### Sidebar / layout

No change needed: the R2a route map already covers all four sections
(client/order/invoice/support → Clients/Orders/Invoices/Tickets), and
invoice detail sits under Invoices, client-new under Clients. The
`get_navigation` endpoint was not touched.

### Permissions

Per the R2b brief: pages follow the dashboard pattern (admin session
check; the invoice detail error box includes a login link when logged
out, other detail pages show the API error box). NO per-page permission
gating was added — R2a's seam guards enforce at the API, and page-level
permission UX is not in R2b scope. Sidebar active highlighting (R2a
known gap) was NOT added.

## 2. Bug found by parity26, fixed (pre-existing TS divergence)

`admin/invoice/mark_as_paid` without a gateway diverged: PHP answered
"Payment gateway is required when marking an invoice as paid." while
TS answered "Payment gateway not found". Root cause in the TS handler
(Phase 3 money code): it collapsed the missing-gateway and
unknown-gateway cases into one check and never checked the enabled
flag. Fixed in `invoice.ts` to mirror PHP
`validateAdminMarkAsPaidRequest` exactly, in order: non-empty
`gateway_id` wins (cast to int; non-numeric casts to 0), else the
invoice's gateway, else 0 → "required"; missing row → "not found";
disabled → "not enabled"; then the existing Custom transaction-ID
check. No earlier parity suite caught this: parity25 exercised
mark_as_paid only as a guard denial (invoiceonly → 403) and on the
already-paid invoice 1 (returns true before any gateway check).
parity26 now covers both the no-gateway error and the happy path
(gateway_id 1 Custom + transactionId).

## 3. Verification

- `npx tsc --noEmit` clean; `npm run build` clean (exit code checked);
  new routes `/admin/clients/new` and `/admin/invoices/[id]` in the
  build output; server restarted on the fresh build before parity.
- **parity26: 62 checks, 0 failures, ALL GREEN.** Sections: A. page
  smoke (8 routes as super-admin: invoice 1/2/missing, clients new/1,
  orders 1/4, tickets 1 — 200 + sidebar + section markers); B.
  logged-out smoke (invoice detail shows the login link without the
  sidebar; new-client form renders without the sidebar); C. action
  equivalence (25 cases × envelope + resulting state, PHP vs TS with
  a full-DB snapshot/restore between stacks, crafted rows re-crafted
  identically so created-row ids match). 26 action cases × envelope +
  state, plus 8 page smokes and 2 logged-out smokes = 62 checks.
- Action cases covered: invoice mark_as_paid (no-gateway error +
  happy path), refund, cancel, delete (crafted draft), send_reminder,
  get-missing; client create (ok + duplicate + missing-fields),
  update (ok + duplicate email + blocked currency change), order
  activate/suspend/unsuspend/cancel/uncancel/renew/delete/get-missing,
  ticket close/reopen/subject-update/delete/get-missing.
- **capture29.py + captures29/ (26 files):** PHP-only corpus for the
  same action cases. Page smoke has no PHP corpus: the admin pages
  are Next-only, so parity26 asserts page status/chrome/needles live
  on the TS stack only.
- Regression gates: (see §5).

## 4. Gaps and divergences carried forward

- Client edit cannot clear a field to empty through the form (only
  non-empty fields are posted, by design — see §1). API-level clearing
  still works via direct calls.
- Client delete UI not built (endpoint exists; later batch).
- Ticket internal notes: `note_create` exists but there is no
  note-listing endpoint, so a note form would write invisible data —
  deliberately not added. Notes display needs an API addition first.
- Invoice `update` (edit form) not built; R2b covers detail + actions
  only. The endpoint exists for a later batch.
- Page reads go through `fbCall` to the PHP origin (the established
  Phase 1 pattern: server components cannot fetch the seam
  relatively); page mutations go through `/api/fb` via `fbPost`.
  Page smoke therefore asserts status/chrome/markers, not data
  provenance — the data equivalence is proven by the action cases.
- TS error envelopes are always HTTP 200 (seam-wide convention);
  parity compares envelopes, and HTTP-status-only diffs vs PHP are
  documented, not hidden (none occurred in parity26's action cases
  beyond the convention itself).

## 5. Regression gates (all observed)

- parity25: **203 checks, 0 failures, ALL GREEN** (R2a guards untouched
  in behavior; the mark_as_paid fix in §2 does not affect parity25's
  guard-denial or already-paid cases).
- Fixtures **13/13 on BOTH stacks** (`run-fixtures.py`; :3001 killed
  before the next-stack run; the surviving `next-server` child killed
  afterwards with the bracket pattern).
- parity21: **194/203 with exactly the known 9 diffs, no new ones**
  (3 direct tld_delete + sd_reg_available (Enom) + 4 downstream
  + the documented HTTP-status artifact dl_admin_send_file_missing_stored).
- DB invariants clean after every run (invoice 323, client_order 11,
  email_queue 67, support_ticket 2, client 3, admin 2, admin_group 3,
  admin_group_member 1, servicedomain_last_sync 2026-10-26 03:24:56,
  service_domain 0, tld 1, tld_registrar 3).

### Incident: stranded parity25 seeds (cleaned, not a code issue)

The first parity25 regression attempt was killed by a tool timeout
mid-run, so its `finally` restore never ran: 7 r2a staff rows, 4 r2a
groups, and its crafted deposit invoice (copy of invoice 1 + deposit
item) stayed in the reference DB. The next parity25 attempt then died
on `UNIQUE constraint failed: admin.email` at seeding. Cleanup was
manual SQL (delete the r2a-* staff/groups/orphan members, the crafted
invoice + deposit item, reset the affected sqlite_sequence rows);
invariants were re-verified clean before the final parity25 run, which
passed and restored cleanly. Lesson for future runs: never run a
~200s parity script under a shorter tool timeout — background it with
nohup + a log file from the start, and check invariants before AND
after (the stranded rows were found by the admin count, not by the
invoice count, which had looked clean).
