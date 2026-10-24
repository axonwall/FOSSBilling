# Phase 4 batch 2 findings — email queue/delivery + invoice PDF

Second Phase 4 commit on `feat/nextjs-phase4-gateways`. The Email
module is ported, invoice lifecycle emails are queued by the TS
money flows, and the invoice PDF is generated in TS.

## Gates

- **Parity: parity11 checks 16/16** against the capture14/14b PHP
  oracle. Regression: parity7 20/20; fixtures **13/13 on both
  stacks**. tsc clean, build PASS.
- PDF gate is content-level (pdftotext): the TS document for
  invoice 1 carries the number, both lines, prices, total, and
  status that PHP's mPDF document carries. Layout is a clean-room
  approximation, not a pixel clone.

## What the captures pinned

- **The queue is not the history.** `email_get_list`/`email_get`/
  `email_resend`/`email_delete` read `activity_client_email`
  (delivered mail — empty on the reference install), while sends
  accumulate in `email_queue`. Missing history rows answer
  `Email not found`; missing templates answer
  `Email template not found`.
- **Delivery never completes in the sandbox.** PHP's
  `batch_sendmail` flips every pending row to `sending` and stops
  (no transport); TS mirrors exactly that and returns null.
- **Lifecycle emails are real queue writes.** PHP's queue held
  'Invoice Created' ×19 and 'Payment Received' ×9 accumulated from
  earlier flows. TS now queues `mod_invoice_created` on issue,
  `mod_invoice_paid` on payment, `mod_invoice_refunded` /
  `mod_invoice_debited` on corrections, and
  `mod_invoice_payment_reminder` from send_reminder and the
  reminder batch job — rendered from the DB templates.
- **Templates render through a Twig subset** (`src/server/twig.ts`):
  dotted paths, `#{...}` interpolation, `default`, `format_date`,
  `format_currency` (currency `format_pattern` from the DB),
  `daysleft`, `length`, `url(area:/query:)`, `{% if %}`/`{% for %}`.
  Template sample `vars` are **encrypted at rest** (`v2:` prefix) —
  TS does not decrypt them, so `template_render` previews render
  with system context only (documented gap; real sends use real
  data and are unaffected).
- **Template create validates strictly.** PHP renders the new
  template with an empty context: any variable reference fails with
  `Email template rendering error: Variable "c" does not exist…`.
  TS mirrors the rejection (Twig's internal template-name hash is
  not reproducible and is omitted). Built-in templates store their
  override in the row itself; the API's `subject_override` /
  `content_override` echo the row for built-ins and are null for
  custom templates.
- Caught in verification: the first reminder parity "match" was a
  false positive against a stale PHP queue row — the TS context
  builder queried a non-existent `invoice_item.order_id` (the link
  is `rel_id` on `type='order'` rows). Fixed; the passing run
  creates, content-checks, and deletes a fresh row.
- Correction (post-commit): the fixture gate initially FAILED
  10/13 on the Next stack — the same context builder queried a
  non-existent `"order"` table (it is `client_order`), and because
  `queueInvoiceEmail` was not failure-isolated, the throw killed
  cart checkout. The batch-2 delivery message claimed 13/13 from a
  run that had not finished; the completed run is what counts.
  Fixed in the follow-up commit (table name + a try/catch around
  the whole queue path); re-verified 13/13 on both stacks.

## Implementation notes

- `src/server/emailer.ts` owns queue inserts and template
  rendering contexts; `queueInvoiceEmail` never throws into the
  money flow (PHP dispatches these via event listeners).
- `src/server/pdf.ts` is a dependency-free PDF writer (core
  Helvetica, flowed lines, simple pagination). The
  `/invoices/[hash]/pdf` route now generates instead of proxying
  PHP; unknown hashes answer 404.
- `send_test` queues a plain test email (approximation of PHP's
  immediate send).
