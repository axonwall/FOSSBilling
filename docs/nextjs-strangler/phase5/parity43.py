#!/usr/bin/env python3
"""R5j parity suite: the standalone TS installer + update-finalization tool.

Unlike earlier parity suites this one is SERVER-INDEPENDENT: it never
calls :8080/:3001 and never mutates the reference DB or config. It:
  A. snapshots the reference invariants + config hash BEFORE,
  B. runs scripts/installer-test.mjs (the installer/finalization proof:
     emitter byte-equality, SQLite live install, refusals, validation,
     URL/config units, finalization order + patches + sync, pg-mem
     structural Postgres, cron-gate predicates) and requires 0 FAILs,
  C. proves the R5i GeoIP relocation answer end to end: a fresh
     installer run copies the .mmdb files into the install root, and the
     TS geoip module resolves FB_GEOIP_DB_DIR to exactly that dir,
  D. re-checks the reference invariants + config hash AFTER (must be
     identical — the installer must never touch the reference),
  E. re-runs the endpoint accounting (R5j adds no API routes, so the
     R5 completion accounting must still read 548 + 31 + 0 = 579).

All installer-test targets live under a temp dir in r5-logs (deleted in
finally). Salt values are never printed anywhere in this suite or in
the installer-test output (presence/shape/inequality booleans only).

Usage: python3 parity43.py
Exit 0 iff every check passes.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys

REPO = "/home/hatch/scratch/fossbilling/repo"
APP = os.path.join(REPO, "apps", "nextjs")
PHASE5 = os.path.join(REPO, "docs", "nextjs-strangler", "phase5")
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
LOGS = "/home/hatch/scratch/fossbilling/r5-logs"
ACCT = os.path.join(PHASE5, "endpoint-accounting.py")

checks = []
failures = []


def check(name, ok, detail=""):
    checks.append(name)
    if ok:
        print(f"PASS {name}")
    else:
        failures.append(name)
        print(f"FAIL {name} :: {detail}")


INVARIANT_TABLES = [
    "invoice", "invoice_event", "client_order", "client_order_meta",
    "email_queue", "service_custom", "extension", "extension_meta",
    "admin", "admin_group", "admin_group_member", "currency", "client",
    "support_ticket", "tld", "activity_client_email", "cart",
    "rate_limit_counter", "setting",
]
EXPECTED = {
    "invoice": 323, "invoice_event": 776, "client_order": 11,
    "client_order_meta": 0, "email_queue": 67, "service_custom": 17,
    "extension": 6, "extension_meta": 3, "admin": 2, "admin_group": 3,
    "admin_group_member": 1, "currency": 1, "client": 3,
    "support_ticket": 2, "tld": 1, "activity_client_email": 0,
    "cart": 283, "rate_limit_counter": 0, "setting": 38,
}
CONFIG_HASH = "6e3c529673c1d089"


def invariants():
    db = sqlite3.connect(f"file:{DBP}?mode=ro", uri=True)
    out = {}
    for t in INVARIANT_TABLES:
        out[t] = db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    out["cart_seq"] = db.execute(
        "SELECT seq FROM sqlite_sequence WHERE name = 'cart'").fetchone()[0]
    out["queue_split"] = tuple(sorted(
        db.execute("SELECT status, COUNT(*) FROM email_queue GROUP BY status").fetchall()))
    out["extension_meta_rows"] = db.execute(
        "SELECT COUNT(*) FROM extension_meta").fetchone()[0]
    out["last_cron_exec"] = db.execute(
        "SELECT COUNT(*) FROM extension_meta WHERE meta_key = 'last_cron_exec'").fetchone()[0]
    # invoice_overdue_invoked lives in setting (parity39 pins its VALUE;
    # updated_at churns on restore, so only the value is invariant).
    out["invoice_overdue_invoked"] = db.execute(
        "SELECT value FROM setting WHERE param = 'invoice_overdue_invoked'").fetchone()
    db.close()
    with open(CFG, "rb") as f:
        out["config_hash"] = hashlib.sha256(f.read()).hexdigest()[:16]
    return out


def main():
    work = os.path.join(LOGS, "parity43-tmp")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    try:
        # ---- A: reference invariants BEFORE ----
        before = invariants()
        bad = [f"{k}={v} (want {EXPECTED[k]})" for k, v in EXPECTED.items()
               if before[k] != v]
        check("A1 reference invariants clean before", not bad, "; ".join(bad))
        # cart_seq is a high-water mark, not data: DELETE never rewinds
        # sqlite_sequence, so cleaned login-created cart rows
        # (capture47, parity44) legitimately advance it past the R5j
        # pin of 305. The invariant is the count (283, in A1); the
        # sequence must only never fall below its R5j floor.
        check("A2 cart sequence >= 305 (high-water mark)",
              before["cart_seq"] >= 305, str(before["cart_seq"]))
        check("A3 queue split 5 pending + 62 sending",
              before["queue_split"] == (("pending", 5), ("sending", 62)),
              str(before["queue_split"]))
        check("A4 config hash 6e3c529673c1d089", before["config_hash"] == CONFIG_HASH,
              before["config_hash"])
        check("A5 last_cron_exec absent", before["last_cron_exec"] == 0)
        check("A6 invoice_overdue_invoked pinned",
              before["invoice_overdue_invoked"] is not None
              and before["invoice_overdue_invoked"][0] == "2026-10-24 05:31:25",
              str(before["invoice_overdue_invoked"]))

        # ---- B: installer-test ----
        # R6c: no FOSSBILLING_PHP_SRC — the installer must prove its
        # vendored default in-chain (installer-test.mjs itself no
        # longer reads the var either). The assignment form is kept:
        # a later block builds on `env` (dict(env, ...)).
        env = {k: v for k, v in os.environ.items()
               if k != "FOSSBILLING_PHP_SRC"}
        r = subprocess.run(["node", "scripts/installer-test.mjs"],
                           cwd=APP, capture_output=True, text=True, env=env,
                           timeout=900)
        summary = [ln for ln in r.stdout.splitlines()
                   if ln.startswith("installer-test:")]
        check("B1 installer-test exits 0", r.returncode == 0,
              f"exit={r.returncode} tail={r.stdout[-500:]} {r.stderr[-500:]}")
        check("B2 installer-test summary present", len(summary) == 1, str(summary))
        if summary:
            parts = summary[0].replace("installer-test:", "").split(",")
            nums = {}
            for p in parts:
                n, _, label = p.strip().partition(" ")
                nums[label.strip()] = int(n)
            check("B3 installer-test 0 FAIL", nums.get("FAIL", -1) == 0, summary[0])
            print(f"installer-test counts: {summary[0]}")
        else:
            check("B3 installer-test 0 FAIL", False, "no summary line")

        # ---- C: GeoIP relocation end to end ----
        root = os.path.join(work, "geoip-root")
        r = subprocess.run(
            ["node", "scripts/run-install.mjs",
             "--install-root", root, "--url", "http://localhost:3101/",
             "--admin-name", "Geo Admin", "--admin-email", "geo@example.com",
             "--json"],
            cwd=APP, capture_output=True, text=True, env=dict(
                env, FB_INSTALL_ADMIN_PASSWORD="Geo-Admin!42"), timeout=300)
        check("C1 geoip fixture install exit 0", r.returncode == 0, r.stderr[-500:])
        geo_dir = os.path.join(root, "data", "geoip")
        check("C2 installer copied both .mmdb files",
              os.path.isfile(os.path.join(geo_dir, "CC0-Country.mmdb"))
              and os.path.getsize(os.path.join(geo_dir, "CC0-Country.mmdb")) > 0
              and os.path.isfile(os.path.join(geo_dir, "PDDL-ASN.mmdb"))
              and os.path.getsize(os.path.join(geo_dir, "PDDL-ASN.mmdb")) > 0)
        # Scratch dir inside apps/nextjs so bare imports (maxmind) resolve.
        tmp = os.path.join(APP, "scripts", ".tmp-parity43-geoip")
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp, exist_ok=True)
        subprocess.run(
            ["npx", "tsc", "src/server/geoip.ts", "src/server/geoip-currencies.ts",
             "--outDir", tmp, "--module", "esnext", "--target", "es2022",
             "--moduleResolution", "bundler", "--skipLibCheck",
             "--declaration", "false"],
            cwd=APP, capture_output=True, text=True, check=True, timeout=180)
        for fname in os.listdir(tmp):
            if fname.endswith(".js"):
                p = os.path.join(tmp, fname)
                with open(p) as f:
                    text = f.read()
                import re as _re
                text = _re.sub(r'from "(\.[^"]*)"',
                               lambda m: m.group(0) if m.group(1).endswith(".js")
                               else f'from "{m.group(1)}.js"', text)
                with open(p, "w") as f:
                    f.write(text)
        probe = os.path.join(work, "geoip-probe.mjs")
        with open(probe, "w") as f:
            f.write(
                "import { resolveGeoipDir } from %r;\n"
                "console.log(resolveGeoipDir() ?? '(null)');\n"
                % os.path.join(tmp, "geoip.js"))
        r = subprocess.run(["node", probe], capture_output=True, text=True,
                           env=dict(os.environ, FB_GEOIP_DB_DIR=geo_dir),
                           timeout=60)
        check("C3 geoip module resolves FB_GEOIP_DB_DIR to the copied dir",
              r.stdout.strip() == geo_dir, r.stdout.strip() + r.stderr[-300:])
        # R6c: the default is now the VENDORED dir. The probe must run
        # with cwd=APP (the default is cwd-relative by design, same as
        # emailDefaults' old cwd pattern) and WITHOUT FOSSBILLING_PHP_SRC
        # (explicitly stripped, not just unset — the var must not leak
        # in from the suite's inherited environment).
        probe_env = {k: v for k, v in os.environ.items()
                     if k != "FOSSBILLING_PHP_SRC"}
        r = subprocess.run(["node", probe], capture_output=True, text=True,
                           cwd=APP, env=probe_env, timeout=60)
        check("C4 geoip default resolution (vendored dir) works",
              r.stdout.strip() == os.path.join(APP, "vendor", "geoip"),
              r.stdout.strip() + r.stderr[-300:])

        # ---- D: reference invariants AFTER (must be identical) ----
        after = invariants()
        check("D1 reference invariants unchanged", after == before,
              "; ".join(f"{k}: {before[k]} -> {after[k]}"
                        for k in before if before[k] != after[k]))

        # ---- E: accounting (R5 completion: 548 + 31 + 0 = 579) ----
        r = subprocess.run([sys.executable, ACCT], cwd=PHASE5,
                           capture_output=True, text=True, timeout=300)
        check("E1 accounting exit 0", r.returncode == 0,
              r.stdout[-500:] + r.stderr[-500:])
        check("E2 accounting reads 548+31+0",
              "548" in r.stdout and "31" in r.stdout and "579" in r.stdout,
              r.stdout[-500:])
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(os.path.join(APP, "scripts", ".tmp-parity43-geoip"),
                      ignore_errors=True)

    print(f"\nparity43: {len(checks) - len(failures)} PASS, {len(failures)} FAIL")
    if failures:
        print(f"FAILURES: {failures}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
