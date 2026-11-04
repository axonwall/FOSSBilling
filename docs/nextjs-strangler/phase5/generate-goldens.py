#!/usr/bin/env python3
"""Generate FOSSBilling money goldens (Phase 5 batch: goldens).

Runs the golden set — the 9 golden scenarios (golden-scenarios.json)
plus the 10 included fixture translations (fixtures-money.json +
fixtures-tax.json, filtered to INCLUDED_FIXTURES) — against ONE
disposable TS (Next) instance on a scratch DB copy, and writes one
golden file per golden under goldens/ (default: next to this script).

A golden file contains, per golden:
  - metadata: generation date, TS commit (HEAD) + working-tree note
    (this batch is uncommitted by design, so the dirty files are
    listed — a golden generated against HEAD+fix is NOT bare HEAD),
    oracle version (runtime/ frozen oracle: no git, identified by
    the reference config hash at generation time), the normalization
    list applied, the generator version, and payload_sha256 (sha256
    of the canonical envelopes+deltas payload — parity48 verifies
    it, so a hand-edited golden fails loudly instead of silently
    passing; the review step may update metadata.php_review, which
    is OUTSIDE the hashed payload by design),
  - envelopes: the per-step response envelopes, NORMALIZED with the
    harness's normalize() (volatile keys -> "*", embedded hashes /
    datetimes scrubbed) — raw envelopes can never replay-match
    (random invoice hashes, wall-clock stamps), and the harness's
    PHP-vs-TS review is what proves the normalized shape is the
    PHP-agreeing shape, not the generator,
  - deltas: the post-baseline DB deltas on DIFF_TABLES (money +
    dependents), normalized the same way,
  - capture: the resolved request log (harness capture format), so
    any golden can be replayed with shadow-harness.py --replay,
  - php_review: null at generation time; filled by the review step
    (review-goldens.py logic, run after the harness TS-vs-PHP
    report exists) — never by the generator alone.

Safety (hard rules, asserted, not assumed):
  - The TS target MUST be disposable: its DB path must live under
    this run's work dir and must not be, or be inside, the reference
    data dir. A golden generated against the reference DB is invalid
    (it would bake reference state into the golden) and the script
    refuses to run if the assertion fails.
  - Never run two DB-mutating suites concurrently: the script fails
    fast if the harness TS port (:3012) is already up.
  - This script never touches the reference DB (read-only snapshot
    copy only) and never touches runtime/ except reading the
    reference DB/config for the snapshot.

Determinism: run this script twice into two --out dirs and diff
the compared payloads (envelopes + deltas + payload_sha256,
ignoring metadata.generated_at); identical payloads are
required. The stored `capture` is EXCLUDED from that comparison
by construction: it carries resolved run-specific values — the
invoice hash passed to get/payment steps — which are random per
run (the same reason hash is in VOLATILE_KEYS). A
non-deterministic compared payload is a finding, not a
commit — fix the normalization or drop the golden with a reason.

Usage:
  python3 generate-goldens.py [--out DIR]
Logs: run via nohup + log file under ~/scratch/fossbilling/r5-logs/.
"""

import hashlib
import importlib.util
import json
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import datetime

HERE = pathlib.Path(__file__).resolve().parent
LOGS = pathlib.Path.home() / "scratch" / "fossbilling" / "r5-logs"
FIXTURES_DIR = pathlib.Path.home() / "scratch" / "fossbilling" / "phase0"

# Fixture goldens: the fixtures whose money shapes add coverage
# beyond the 9 scenarios (see findings-goldens.md §1 for the
# per-fixture reasoning, including the 3 deliberate exclusions).
INCLUDED_FIXTURES = [
    # money fixtures with distinct money shapes
    "invoice-mixed-taxed-and-untaxed-lines",
    "invoice-quantity-and-rounding",
    "cart-promo-percentage",
    "cart-recurring-with-setup-checkout",
    # tax fixtures: rule-selection changes invoice totals (money)
    "tax-state-beats-country-and-global",
    "tax-country-rule-when-no-state-match",
    "tax-global-fallback",
    "tax-no-rule-means-zero",
    "tax-exempt-client-pays-none",
    "tax-disabled-globally",
]

GENERATOR_VERSION = "generate-goldens.py v1"


def load_harness():
    spec = importlib.util.spec_from_file_location(
        "shadow_harness", HERE / "shadow-harness.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def port_up(port):
    s = socket.socket()
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def normalize_delta(h, delta):
    """Normalize a harness delta the way replay comparison does:
    added/removed rows through normalize(); changed field pairs
    normalized on both sides (volatile keys become "*", so a
    wall-clock updated_at can never fail a replay)."""
    out = {}
    for t, dd in delta.items():
        entry = {}
        for kind in ("added", "removed"):
            if kind in dd:
                entry[kind] = {k: h.normalize(v, [])
                               for k, v in dd[kind].items()}
        if "changed" in dd:
            entry["changed"] = {
                k: {f: [h.normalize(v[0], []), h.normalize(v[1], [])]
                    for f, v in fields.items()}
                for k, fields in dd["changed"].items()}
        out[t] = entry
    return out


def payload_sha(envelopes, deltas):
    """Sha over the SERIALIZED payload: delta row keys are ints
    in-memory (sqlite ids) but strings after a JSON round-trip, and
    sort_keys orders ints numerically but strings lexicographically
    — hashing the pre-serialization form gives a hash no reader of
    the file can reproduce (cron-run proved it: its changed
    reference rows mix small and 3-digit ids). Round-trip first so
    the stored hash is verifiable from the file alone."""
    data = json.loads(json.dumps({"envelopes": envelopes,
                                  "deltas": deltas}))
    canon = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(HERE / "goldens"))
    args = ap.parse_args()
    outdir = pathlib.Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    h = load_harness()
    if port_up(h.TS_PORT):
        raise SystemExit(
            f"refusing: harness TS port :{h.TS_PORT} already up — "
            "another DB-mutating suite may be running")

    scenarios = []
    data = json.loads((HERE / "golden-scenarios.json").read_text())
    for sc in data["scenarios"]:
        scenarios.append((sc, "scenario"))
    for fname in ("fixtures-money.json", "fixtures-tax.json"):
        fdata = json.loads((FIXTURES_DIR / fname).read_text())
        for fx in fdata["fixtures"]:
            if fx["id"] in INCLUDED_FIXTURES:
                scenarios.append((h.translate_fixture(fx), "fixture"))
    missing = set(INCLUDED_FIXTURES) - {sc["id"] for sc, _ in scenarios}
    if missing:
        raise SystemExit(f"included fixtures not found: {sorted(missing)}")
    print(f"[goldens] {len(scenarios)} goldens "
          f"({sum(1 for _, k in scenarios if k == 'scenario')} scenarios + "
          f"{sum(1 for _, k in scenarios if k == 'fixture')} fixtures)")

    work = LOGS / f"goldens-gen-{__import__('os').getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    snapshot = work / "snapshot.sqlite"
    shutil.copy(h.REF_DB, snapshot)
    config_hash = hashlib.sha256(h.REF_CFG.read_bytes()).hexdigest()[:16]
    ts_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=h.REPO, capture_output=True,
        text=True, check=True).stdout.strip()
    dirty = subprocess.run(
        ["git", "status", "--short"], cwd=h.REPO, capture_output=True,
        text=True, check=True).stdout.strip().splitlines()

    proc, dbpath = h.setup_ts_disposable(work, snapshot)
    # Hard guardrail: the TS target must be disposable.
    assert str(dbpath).startswith(str(work)), dbpath
    assert str(h.REF_DB) not in str(dbpath), dbpath
    assert "runtime" not in str(dbpath), dbpath
    print(f"[goldens] disposable TS on :{h.TS_PORT} db={dbpath} "
          f"(reference DB untouched; snapshot={snapshot})")
    try:
        for sc, kind in scenarios:
            envs, delta, capture = h.run_scenario_on_stack(
                "ts", sc, snapshot, dbpath)
            n_envs = [h.normalize(e, []) for e in envs]
            n_delta = normalize_delta(h, delta)
            for i, e in enumerate(envs):
                if e.get("error"):
                    print(f"[goldens] NOTE {sc['id']} step {i} "
                          f"error envelope (expected for the IPN "
                          f"manual-approval park): {e['error']}")
            golden = {
                "id": sc["id"],
                "description": sc.get("description", ""),
                "source": kind,
                "metadata": {
                    "generator": GENERATOR_VERSION,
                    "generated_at": datetime.datetime.now(
                        datetime.timezone.utc).isoformat(),
                    "ts_commit": ts_commit,
                    "ts_worktree_dirty_files": dirty,
                    "ts_worktree_note": (
                        "Goldens generated against HEAD plus the "
                        "uncommitted working tree listed above "
                        "(this batch is uncommitted by design); "
                        "bare HEAD does not include those changes."),
                    "oracle_version": (
                        "runtime/ frozen oracle (no git) — reference "
                        "DB snapshot + config hash at generation"),
                    "oracle_config_hash": config_hash,
                    "normalization": sorted(h.VOLATILE_KEYS) + [
                        "any key ending in _at",
                        "embedded 30-60 hex invoice hashes -> *HASH*",
                        "embedded datetimes -> *TS*",
                        "transaction ipn column server sub-object -> *",
                    ],
                    "payload_sha256": payload_sha(n_envs, n_delta),
                },
                "envelopes": n_envs,
                "deltas": n_delta,
                "capture": capture,
                # The input scenario (steps + seeds) the golden was
                # recorded from: parity48 replays FROM this, not from
                # the capture — capture carries resolved run-specific
                # hashes that do not exist on a fresh disposable DB
                # (a get-by-old-hash step would error on replay while
                # the golden envelope is a success). The scenario
                # re-derives those hashes fresh on every replay.
                "scenario": {
                    "steps": sc["steps"],
                    "seed_sql": sc.get("seed_sql", []),
                    "seed_ops": sc.get("seed_ops", []),
                },
                "php_review": None,
            }
            (outdir / f"{sc['id']}.json").write_text(
                json.dumps(golden, indent=1, sort_keys=False))
            print(f"[goldens] wrote {sc['id']}.json "
                  f"({len(envs)} envelopes, "
                  f"{len(n_delta)} delta tables)")
    finally:
        proc.send_signal(signal.SIGTERM)
        h.kill_port(h.TS_PORT)
        shutil.rmtree(work, ignore_errors=True)
    print(f"[goldens] done -> {outdir}")


if __name__ == "__main__":
    main()
