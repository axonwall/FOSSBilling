#!/usr/bin/env python3
"""Review money goldens against PHP evidence (Phase 5 batch: goldens).

Reads harness TS-vs-PHP reports (shadow-harness.py --out
report.json files: one for golden-scenarios.json, one for the
fixture corpus) and fills each golden file's metadata-adjacent
`php_review` field (the generator leaves it null by design):

  - AGREES-WITH-PHP: envelope diffs 0, money_diff False, no DB
    diff tables at all.
  - TRIAGED-DIVERGENCE: envelope diffs 0, money_diff False, DB
    diff tables a subset of the triaged non-money set
    (invoice_event, client_order_status, email_queue, setting —
    findings-r6b.md §8, each with its reason there). The golden
    still records the TS output; the flag says the TS-vs-PHP gap
    is understood, non-money, and documented — not that the
    golden is "correct".
  - DIFFERS: anything else (an envelope diff, a money diff, or a
    DB diff outside the triaged set). The flag carries the full
    diff summary and the script exits 1: a DIFFERS golden is
    unresolved — it must be fixed in-batch with PHP evidence or
    flagged for Josh's decision, never silently recorded, never
    normalized away. The script writes the DIFFERS flag (so the
    state is visible) but refuses to call the set reviewed.

KNOWN-PHP-BUG is not a verdict this script assigns on its own:
it is a per-golden annotation in findings-goldens.md (with its
reference) for goldens whose recorded behavior is PHP-faithful
but itself a known PHP bug. This run's verdicts are AGREES /
TRIAGED-DIVERGENCE only; findings-goldens.md states explicitly
which known-bug items the set does and does not freeze.

Usage:
  python3 review-goldens.py --goldens DIR --reports R1.json R2.json
The reports are the harness --out/report.json files. Exit 0 only
when every golden has a review and none is DIFFERS.
"""

import argparse
import json
import pathlib
import sys

TRIAGED = {"invoice_event", "client_order_status", "email_queue",
           "setting"}
TRIAGED_REFS = {
    "invoice_event": "findings-r6b.md §8: PHP logs created+updated+issued+paid(+refunded) with full snapshots + actor ids; TS logs issued+paid(+refunded) minimal, NULL actors, unpadded serie_nr in snapshots. Audit-only, not a money table.",
    "client_order_status": "findings-r6b.md §8: TS writes an extra pending_setup/Order Created row at order create; PHP's first row is active/Order activated. Audit-only.",
    "email_queue": "findings-r6b.md §8: order-lifecycle + checkout notification gaps (PHP queues order Activated/Renewed/Canceled + New Order Placed; TS queues 0/1) and cron send-status transport (PHP sending vs TS failed, no SMTP on disposable TS). Row creation compared; send status triaged.",
    "setting": "findings-r6b.md §8: last_cron_exec typing (PHP public NULL vs TS 0 via upsertSetting default). Non-money typing.",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--goldens", required=True)
    ap.add_argument("--reports", nargs="+", required=True)
    args = ap.parse_args()
    goldens_dir = pathlib.Path(args.goldens)

    by_id = {}
    for rpath in args.reports:
        report = json.loads(pathlib.Path(rpath).read_text())
        for s in report["scenarios"]:
            by_id[s["id"]] = s

    n_ok = n_triaged = n_differs = n_missing = 0
    for gpath in sorted(goldens_dir.glob("*.json")):
        golden = json.loads(gpath.read_text())
        gid = golden["id"]
        rep = by_id.get(gid)
        if rep is None:
            print(f"  MISSING-PHP-EVIDENCE {gid} (no harness report entry)")
            n_missing += 1
            continue
        env = len(rep["envelope_diffs"])
        tables = sorted(rep["db_diffs"].keys())
        money = rep["money_diff"]
        if env == 0 and not money and not tables:
            verdict = "AGREES-WITH-PHP"
            n_ok += 1
        elif env == 0 and not money and set(tables) <= TRIAGED:
            verdict = "TRIAGED-DIVERGENCE"
            n_triaged += 1
        else:
            verdict = "DIFFERS"
            n_differs += 1
        golden["php_review"] = {
            "verdict": verdict,
            "envelope_diffs": env,
            "money_diff": money,
            "db_diff_tables": tables,
            "triaged_table_reasons": {
                t: TRIAGED_REFS[t] for t in tables if t in TRIAGED},
            "diff_fields": sorted({f for d in rep["envelope_diffs"]
                                    for f in d.get("diff_fields", [])}),
            "harness_reports": [str(pathlib.Path(r).name)
                                 for r in args.reports],
            "note": ("TS output recorded in this golden; the verdict "
                     "is the TS-vs-PHP comparison for the same steps. "
                     "TRIAGED-DIVERGENCE means the gap is understood, "
                     "non-money, and documented — not that the golden "
                     "is 'correct'."),
        }
        gpath.write_text(json.dumps(golden, indent=1))
        print(f"  {verdict} {gid} env={env} money={money} "
              f"tables={tables}")
    print(f"review: {n_ok} AGREES, {n_triaged} TRIAGED-DIVERGENCE, "
          f"{n_differs} DIFFERS, {n_missing} MISSING")
    if n_differs or n_missing:
        print("review FAILED: unresolved DIFFERS/MISSING goldens remain")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
