# Findings — Bug-hunt K1 fix batch (map-shaped partial refunds)

Branch `fix/bughunt-k1`, off `8e9039d` (Tier 1, pushed). K1 was the known
gap left by Tier 1: PHP's native partial-refund `items` input is an
id→qty MAP, and the TS refund handler only handled an ARRAY, so a map
silently full-refunded. Hunt evidence: slice-A K1 section,
`~/scratch/fossbilling/bughunt-20261104/slice-A.md`;
findings-bughunt-tier1.md §5; W1 map probes
`~/scratch/fossbilling/tier1/w1-probes/out-phpmap-w1/report.json`
(p06-map-partial-twice, p08-map-partial-then-full).

Scope is EXACTLY K1 plus one defect the K1 edge probes caught in the
same function (credit-note `charged`, §2.5) — a one-line fix in
`refundInvoiceCore`'s note-line creation, without which the edge
probes report a real money diff. Nothing else changed; no golden file
touched, no parity suite modified.

## §1 — The fix (one file: `apps/nextjs/src/server/modules/invoice.ts`)

### Map parsing (admin `invoice/refund` handler)

`ctx.rawParams["items"]` is now resolved into `onlyLines:
Set<number> | Map<number, unknown> | null`:

- Absent/null → null (full refund of the remaining amount, unchanged).
- Array → Set of ids, exactly as before (list path untouched).
- Plain object → Map of id→qty. Keys are coerced with a PHP `(int)`
  cast (`phpIntCastKey`: leading whitespace, optional sign, leading
  digits; no digits → 0 — so `"abc"` becomes id 0, matching PHP).
  Values stay raw (string or number) for the core to validate.
- Anything else (string, number, boolean) → `FbError("Refund lines
  are invalid")`, mirroring PHP `Admin::refund`'s guard
  (`$items !== null && (!is_array($items) || $items === [])`).
- Present-but-empty array or object → same "Refund lines are
  invalid". This also corrects the empty-list case, which TS
  previously answered "No invoice lines selected for refund" while
  PHP throws "Refund lines are invalid" (no parity suite covered it;
  the chain in §3 confirms nothing else depended on the old text).

Form posts arrive with string values (`items[490]=1` → `{"490": "1"}`
via the seam's bracket expansion, which leaves id-keyed maps as
objects); JSON bodies arrive with number values. Both are coerced
with `Number()` in the core after a PHP `is_numeric` check.

### Map branch in `refundInvoiceCore`

The core's second parameter changed from `Set<number> | null` to
`Set<number> | Map<number, unknown> | null`. The list path keeps the
Set (full line quantities — the handler cannot know line quantities
without a second query, and the s07 list proof stays exactly as
verified). The Map branch mirrors PHP
`Invoice\Service::resolveRefundLines` step for step, in the same
order per entry:

1. Unknown line → `Invoice line #${id} was not found`.
2. Non-numeric qty → `Refund quantity must be a valid number.`
   (`isPhpNumeric`: finite numbers, or strings matching PHP's
   numeric grammar — sign, digits, optional fraction/exponent,
   optional surrounding whitespace; hex/empty/NaN/INF/booleans are
   not numeric.)
3. qty <= 0 → entry skipped silently (PHP `continue`).
4. Zero-price line → `Only charge lines can be refunded`.
5. `validateRefundQuantity` (PHP `PriceValidator::validateQuantity`):
   integers pass through, fractional quantities truncate toward zero
   with a floor of 1 (`"1.5"` → 1, `0.5` → 1), non-finite or
   >= PHP_INT_MAX → `Quantity must be a valid number.`
6. qty > remaining → `Refund quantity exceeds the remaining
   refundable quantity of ${left}`.

No lines surviving the skips → `No invoice lines selected for
refund`. The stored-refund rule (credit note's own total WITH tax),
the full-after-partial remaining-lines behavior, and the status rule
(`refunded` only when `round2(total - newRefundTotal) <= 0.005`,
otherwise the invoice stays `paid`) are unchanged — the status rule
is what keeps a partially-refunded invoice `paid` so a second map
refund reaches the quantity guard instead of the status guard.

### Credit-note `charged` (caught by e02, same function)

PHP `createRefundDocument` calls `$pi->setCharged(1)` on every
credit-note line — `charged` is a boolean flag (`InvoiceItem::$charged`
is `?bool`), NOT the refunded quantity. TS wrote `charged = qty`.
With qty 1 the values coincide, which is why p06/p08 and the s07 list
probe never caught it; a qty-2 refund proved it (PHP 1, TS 2).
Fixed to a constant 1. `refundedQuantities` sums `quantity`, not
`charged` (exactly like PHP's `getCreditedQuantities`), so the fix
cannot affect the remaining-quantity guard. The debit path already
writes `charged: 0`, matching PHP's `setCharged(0)` — untouched.

## §2 — Probe results (disposable PHP :8101 + disposable TS :3101)

Harness: `~/scratch/fossbilling/tier1/k1-probes/shadow-harness-k1.py`
(W1's `shadow-harness-w1.py` repointed at the real repo so the
disposable TS serves the fixed build), scenarios
`../w1-probes/scenarios-phpmap.json` and
`scenarios-k1-edge.json` (8 new edge scenarios). Logs:
`~/scratch/fossbilling/r5-logs/my-k1-phpmap.log`,
`my-k1-phpmap2.log`, `my-k1-edge.log`, `my-k1-edge2.log`,
`my-k1-edge3.log`, `my-k1-proof.log`, `my-k1-edge-proof.log`.
Reports: `out-k1-phpmap/report.json`, `out-k1-phpmap2/report.json`,
`out-k1-edge/report.json`, `out-k1-edge2/report.json`,
`out-k1-edge3/report.json`.

### §2.1 — p06/p08 map probes: 0 envelope diffs, money_diff False

| Scenario | env_diffs | db_diffs | money_diff |
|---|---|---|---|
| p06-map-partial-twice | 0 | 1 (invoice_event only) | False |
| p08-map-partial-then-full | 0 | 1 (invoice_event only) | False |

(Baseline before the fix: p06 env 3 / db 4 / money True; p08 env 2 /
db 5 / money True.) The single remaining DB table is the KNOWN
invoice_event shape gap — PHP writes rich created/updated/issued/
paid/refunded snapshots, TS writes minimal ones. It is the same
triaged divergence recorded in the goldens review (every invoice
flow carries it); no money table differs.

### §2.2 — The three A-F4 map proofs (all three HOLD, exact values)

From `k1-proof.py` (`my-k1-proof.log`), PHP vs TS identical on every
line:

- **A-F4a — tax-inclusive stored refund.** p06 step 7 (invoice get
  after `{"490": 1}`): `refund: "55"`, `refunded_total: 55`,
  `remaining_refundable: 55`, status `paid`, both stacks. Step 8
  (credit note 490): one line, Line A qty 1 price -50 taxed 1,
  subtotal -50, tax -5, total -55, serie `CN-00003`, both stacks.
  The stored refund 55 is the note's own total WITH tax.
- **A-F4b — quantity guard on the second map refund.** p06 step 9
  (refund `{"490": 1}` again): both throw code 9999,
  `Refund quantity exceeds the remaining refundable quantity of 0`.
  The status guard no longer fires first — the invoice stayed `paid`
  after the partial refund.
- **A-F4c — full-after-partial mints only the remaining lines.**
  p08 step 7 (full refund after the partial): both mint note 491.
  Step 8 (note 491): single line, Line B qty 1 price -50 taxed 0,
  subtotal -50, tax 0, total -50, serie `CN-00004`, both stacks.

### §2.3 — Edge scenarios e01–e08: 0 envelope diffs, money_diff False

All 8 scenarios, full re-run (`out-k1-edge3/report.json`): env 0,
db 1 (invoice_event only), money False. Exact PHP/TS messages and
values from `my-k1-edge-proof.log` (every pair identical):

| Scenario | Probe | PHP = TS (code 9999 unless noted) |
|---|---|---|
| e01-qty-zero | `{"490": 0}` | `No invoice lines selected for refund` |
| e01-qty-zero | `{"490": 0, "491": 1}` | note 490 (Line B only, -55); invoice refund 55, status `paid`, A remaining 2 |
| e02-qty-over-line | `{"490": 3}` (line qty 2) | `Refund quantity exceeds the remaining refundable quantity of 2` |
| e02-qty-over-line | `{"490": 2}` | note 490; invoice refund 110, A remaining 0 |
| e03-qty-over-remaining | `{"490": 1}` then `{"490": 2}` | second: `…remaining refundable quantity of 1`; then `{"490": 1}` → note 491; bare full refund → note 492 (Line B only, -55) |
| e04-unknown-line | `{"99999": 1}` | `Invoice line #99999 was not found` |
| e04-unknown-line | `{"abc": 1}` | `Invoice line #0 was not found` (PHP `(int)"abc"` = 0) |
| e05-empty-and-scalar | `{}` / `[]` / `"x"` | all three: `Refund lines are invalid` |
| e06-fractional-and-nonnumeric | `{"490": "abc"}` | `Refund quantity must be a valid number.` |
| e06-fractional-and-nonnumeric | `{"490": "1.5"}` | truncates to 1 → note 490, refund 55 |
| e06-fractional-and-nonnumeric | `{"490": 0.5}` | floors to 1 → note 491, refund 110 total |
| e07-form-post-map | form `items[490]=1` (string value) | note 490 (-55, tax -5); second form refund → quantity guard `…of 0` |
| e08-multi-entry-map | `{"490": 1, "491": 1}` | note 490, both lines, subtotal -100 tax -10 total -110; then `{"490": 1}` → note 491, invoice status `refunded`, refund 165 |

Every throw above leaves state unchanged — the follow-up valid
refund in e04/e05 succeeds with the same note id on both stacks.

### §2.4 — Edge-run flake (environmental, not code)

The first post-`charged`-fix edge run (`my-k1-edge2.log`) died
mid-run at e06: the disposable TS on :3101 refused connections
(`URLError: Connection refused` on prime) with NO crash output in
`shadow-next-3101.log` (clean `Ready`, nothing after). e01–e05 in
that run were already env 0 / money False, including e02 proving
the `charged` fix. A clean re-run (`my-k1-edge3.log`) completed all
8 scenarios. No server-side change between the two runs except the
already-verified `charged` constant; treated as sandbox flake
(memory was tight: 222 MB free at the time).

### §2.5 — The e02 `charged` catch (before/after)

First edge run (before the fix): e02 db_diffs 2
(`invoice_event` + `invoice_item`), money_diff True — credit-note
line 492: PHP `charged: 1`, TS `charged: 2`. After the one-line fix
and rebuild: e02 db_diffs 1 (invoice_event only), money_diff False
(`my-k1-edge2.log` e01–e05 + `my-k1-edge3.log` full run).

## §3 — Verification chain

Chain script `~/scratch/fossbilling/r5-logs/my-k1-chain.sh` (copy of
the Tier 1 chain script with the parity48-B log repointed to
`my-parity48-k1-B.log`), log `my-k1-chain.log`. Reference servers
restarted before the chain and verified 200/200; invariants clean
before and after (invoice 323, invoice_event 776, email_queue 67,
setting 38, extension_meta 3, cart 283, client 3, config hash
`6e3c529673c1d089`).

- parity47 86/86; parity46 21/0/2 skips; parity45 171/171; parity44
  77/77; parity43 16/16; parity42 73/73; parity41 130/130; parity40
  120/120; **parity39 212 checks, 0 failures** (see the note below);
  parity37 115 pass, 0 fail, 0 skipped (standalone full-output
  re-run, `my-k1-parity37.log` — the chain log keeps only its
  restore/prime tail, as in Tier 1); parity36 51/51; parity35
  211/211; parity34 164/164; parity33 77/77; parity32 65/65;
  parity31 63/63; parity30 179/179; parity29 62/62; parity28
  128/128; parity27 27/27; parity26 62/62; parity25 ALL GREEN;
  installer-test 119/119 + 2 SKIP; parity38 86/86; parity21 194/203
  with exactly the known 9 diffs; fixtures 13/13 BOTH stacks;
  accounting 548+31+0; parity48 (chain's second run,
  `my-parity48-k1-B.log`) 19/19 MATCH, 201/0.
- Sequences before→after: email_queue 552→555, client 637→666,
  invoice 488 (unchanged — no chain suite creates invoices), cart
  342→344 (count still 283); config hash unchanged.
- parity48 negative control (`my-parity48-k1-negctl.log`): 4/4 PASS.
  Cron-money control (`my-parity48-k1-cronctl.log`): PASS.
- No golden file changed, none regenerated (`git status` proves it:
  only `invoice.ts` modified).

### parity39 note — the 6 expected failures did NOT occur

The standing standard said parity39 carries 6 known date-window
failures (§1 sendmail + §6 reminder counts, both stacks agreeing),
recorded in the Tier 1 chain. This chain's parity39 is **212
checks, 0 failures**. The Tier 1 chain log (`my-tier1-chain.log`,
mtime 2026-11-05 14:15 UTC) shows the 6 were:

- `1 PHP dev sendmail flips pending->sending, no delivery`
- `1 TS sendmail delivered baseline pending to mock`
- `6 PHP before/after templates split (Payment Reminder, then Invoice Due)`
- `6 PHP exactly 2 sends`
- `6 TS before/after templates split (Payment Reminder, then Invoice Due)`
- `6 TS exactly 2 sends`

i.e. the failures were recorded on Nov 5, six days before this run.
A standalone full-output re-run after the chain
(`my-k1-parity39.log`) reproduces **212 checks, 0 failures: []**
independently, so this is not a chain-order artifact. The
date-window set has cleared with time passing; parity39.py was NOT
modified (re-pin decision now moot for this run — the suite passes
as written). The K1 change touches only refund paths, which
parity39's §1/§6 (sendmail + invoke-due/reminders) do not exercise,
so the clearance is a property of when the suite ran, not of this
fix — recorded here so the next batch does not misread 0 failures
as a forced-green.

## §4 — Residuals

- **JS integer-key ordering vs PHP insertion order.** PHP iterates a
  map in JSON insertion order; JS orders integer-like keys
  numerically ascending. With several bad entries, which error
  throws first can differ if the JSON order is not ascending. No
  probe covers it (all multi-entry probes use ascending keys).
- **Duplicate ids after the `(int)` cast collapse.** `{"490": 1,
  "0490": 1}` becomes one Map entry (last wins) in TS; PHP keeps
  two entries and emits two note lines for the same item, each
  passing the guard (it checks remaining against the DB, not against
  lines already built in the same call). Pathological input, no
  probe; the Map shape was the prescribed fix shape.
- **qty >= PHP_INT_MAX guard** uses a JS number comparison
  (`q >= 9223372036854775807`); values near 2^63 behave the same in
  practice, but the boundary is not probe-proven.
- **invoice_event shape gap** (pre-existing, triaged): the only DB
  diff left in every refund probe. Out of scope for K1.
- **Live-PG execution unproven** (no Postgres server in the
  sandbox); the fix is driver-agnostic SQL/TS, same as the rest of
  the refund core.
- **Empty-list message change** (deliberate, §1): `items: []` now
  throws `Refund lines are invalid` (PHP) instead of TS's old
  `No invoice lines selected for refund`. No parity suite covered
  the old text; the chain (§3) is the check that nothing depended
  on it.
