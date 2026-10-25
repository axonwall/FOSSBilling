# Phase 5 R1 batch 2 findings — Stats

Branch: `feat/nextjs-phase5-r1`, stacked on R1 commit
`e19c6f1`. 14 endpoints ported: admin stats
get_summary, get_summary_income, get_orders_statuses,
get_product_summary, get_product_sales,
get_income_vs_refunds, get_refunds, get_income,
get_orders, get_clients, get_invoices, get_tickets,
client_countries, sales_countries.
TS-served total rises from 247 to 261 of 579.

## Pinned semantics (capture18.py / captures18/)

- Summary counts are server-local-midnight bucketed
  (today / yesterday / this month / last month) per
  table: client, client_order, invoice, support_ticket.
  Income summary: issued invoices in status paid or
  refunded, base_income minus base_refund, bucketed by
  paid_at. Reference values at capture: income total
  3971, this_month 3971, today 235, yesterday 3636;
  refunds 570 against income 4541.
- Order statuses = the order counter minus total, over
  group masters only: pending_setup 7, active 3, rest 0.
  (Fidelity fix folded in: `orderStatusCounts` in db.ts
  now filters `group_master = 1` like PHP's counter.
  On the reference DB every order is a master, so no
  parity result changed — but the query is now the
  faithful one for both order get_statuses and stats.)
- Product summary's RIGHT JOIN + `WHERE o.status =
  'active'` is the classic outer-join-killing WHERE:
  products without active orders are filtered out by
  the WHERE clause itself, so the result equals an
  inner join grouped by product. Only the three active
  orders surface (product ids 8, 7, 6 — three distinct
  products sharing the title "Phase0 Widget Hosting").
- Product sales and both country maps are PHP
  fetchAllKeyValue maps: later duplicate keys overwrite
  earlier ones (sales collapses to
  {"Phase0 Widget Hosting": 1}), and NULL country
  groups surface under the "" key (client countries:
  {"": 2, "US": 1}; sales countries: {"US": 75}).
- Flot series: days from+1 .. to-1 (PHP's do/while
  pushes then pops the == to entry). Default windows
  are strtotime('-1 month') / strtotime('+1 day') —
  NOW-based, preserving time-of-day — so default
  series timestamps vary by run time while the SQL
  bounds are calendar dates and stable. parity15
  compares default series by calendar day + value;
  dated series (midnight bounds) compare exactly.
  Default series length on the reference install: 30.
- Date params are Y-m-d local midnights; the SQL
  BETWEEN uses those date strings, so rows on the
  date_to day itself fall outside the window (string
  comparison against 'Y-m-d H:i:s' values) — mirrored
  exactly rather than "fixed".

## Gates (all foreground-verified)

- parity15.py: 20/20 MATCH (11 exact, 3 dated-series
  exact, 6 default-series by day).
- Fixtures: 13/13 both stacks.
- Regressions: parity14 44/44, parity13 47/47,
  parity12 12/12, parity11 16/16, parity10 14/14,
  parity9 16/16, parity7 20/20 (after the oracle
  refresh below).

## Harness notes

- parity7 initially came back 17/20 in this run — NOT
  a code regression. Its oracle (captures10, fixed
  since batch 4) covered invoice ids 81–189, while
  repeated parity12 runs had pushed the newest-100
  list page's floor past 189 (ids now reach 336, with
  gaps from deleted rows), leaving zero common
  entries for the intersection comparison. Refreshed
  the three list oracles from live PHP (new range
  200–336) and re-ran 20/20. Lesson: list oracles
  have a shelf life measured in parity12 runs; the
  intersection method fails closed (0 common) rather
  than silently passing, which is the right failure.
- Same stale-server-on-3001 dance as R1: a leftover
  fixture-runner Next server held the port and
  returned 500s until killed and restarted.
- parity12 balance rows cleaned again (ids >= 16);
  client-1 balance back to 0; order 3's
  unpaid_invoice_id cleared after parity9, as usual.
