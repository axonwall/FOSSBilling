#!/usr/bin/env python3
"""Phase 5 R6b capture: PHP baselines + normalization justification.

Runs the shadow harness in --php-only mode (each scenario on PHP
TWICE, from identical snapshots) over the harness scenarios AND the
13 fixture-corpus scenarios, then assembles captures48/capture48.json:
per-scenario PHP baselines (envelopes + DB deltas) and the php-vs-php
diffs.

A field is normalized ONLY if two identical PHP runs disagree on it.
Any php-vs-php diff OUTSIDE the volatile-key list is a harness bug
or genuine PHP nondeterminism (e.g. list ordering) — it is reported
as such in the summary, never silently added to the normalization
list. The harness's VOLATILE_KEYS list must be justified by THIS
capture: every normalized key must appear in some php-vs-php diff
(or be a wall-clock/random field of the same class, stated explicitly
in findings-r6b.md).

The harness's disposable PHP (port 18081) is used, never the
reference :8080 server and never the reference DB.
"""
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
OUT = HERE / "captures48"
FIXTURES = pathlib.Path.home() / "scratch" / "fossbilling" / "phase0"


def run_harness(args, outdir):
    cmd = [sys.executable, str(HERE / "shadow-harness.py"), "--php-only",
           "--out", str(outdir)] + args
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    print(proc.stdout[-2000:])
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
    report = json.loads((outdir / "report.json").read_text())
    return report


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sc = run_harness(["--scenarios", str(HERE / "shadow-scenarios.json")],
                     OUT / "scenarios-php-only")
    fx = run_harness(["--fixtures",
                      str(FIXTURES / "fixtures-money.json"),
                      str(FIXTURES / "fixtures-tax.json")],
                     OUT / "fixtures-php-only")
    summary = {}
    for report in (sc, fx):
        for s in report["scenarios"]:
            env_diffs = s.get("php_vs_php_envelope_diffs", [])
            db_diffs = s.get("php_vs_php_db_diffs", {})
            summary[s["id"]] = {
                "envelope_diffs": env_diffs,
                "db_diffs": db_diffs,
            }
    corpus = {"scenarios_php_only": sc, "fixtures_php_only": fx,
              "php_vs_php_summary": summary}
    (OUT / "capture48.json").write_text(json.dumps(corpus, indent=2))
    n_env = sum(len(v["envelope_diffs"]) for v in summary.values())
    n_db = sum(len(v["db_diffs"]) for v in summary.values())
    print(f"\ncapture48: {len(summary)} scenarios, php-vs-php "
          f"envelope diffs={n_env}, db tables with diffs={n_db}")
    for sid, v in summary.items():
        if v["envelope_diffs"] or v["db_diffs"]:
            print(f"  {sid}: env={json.dumps(v['envelope_diffs'])[:400]} "
                  f"db_tables={sorted(v['db_diffs'])}")


if __name__ == "__main__":
    main()
