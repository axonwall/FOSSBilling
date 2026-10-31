#!/usr/bin/env python3
"""Parity45 — R6b shadow harness proof.

Sections:
  A. Reference state before: invariants + config hash + :8080/:3001 answering.
  B. Harness proof: the 7 shadow scenarios run TS-vs-PHP on disposable
     stacks; per scenario, envelope diffs must be 0 and money_diff False,
     and every remaining DB table must be in the triaged non-money set.
  C. Fixture-corpus zero-diff reproduction: the 13 fixtures (7 money + 6 tax)
     translated through the harness, same assertions as B. "Reproduces"
     means exactly this: the SAME scenarios/steps/seeds the fixture runner
     uses, run through the harness and diffed by envelopes + DB deltas —
     NOT the fixtures' own expect blocks. The harness diff IS the check.
     (The runner's 13/13 proves fixtures pass fixed expectations; this
     proves TS and PHP produce the same envelopes + money rows.)
  D. Capture/replay mode proven: the staff-basket and cart captures from
     section B replayed through the harness reproduce the live run's diff
     signature exactly (same envelope-diff count, same money flag, same
     DB-table set) — or the gap is reported as a failure.
  E. Normalization honesty: every scenario report's normalized_fields must
     equal the documented 10-key list, and no money field may be normalized
     (VOLATILE_KEYS intersected with money field names must be empty, and
     the _at rule touches timestamp fields only).
  F. Restore: reference invariants + config hash clean after, :8080 + :3001
     answering at the end, all disposable targets deleted in finally,
     :8081/:18025/:18026/:3003/:18081/:3012 DOWN at batch end.

Reference touches are read-only (sqlite reads, config hash, curl). This
suite logs in NOWHERE against the reference; the harness's logins happen
on disposable stacks only. It must log in once via dev and reuse the
session where it touches the reference — it never needs to, so it does not.

Run: python3 parity45.py  (long: three harness runs + two replays, ~10 min)
Logs: run via nohup + log file under ~/scratch/fossbilling/r5-logs/.
"""

import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import subprocess
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
RUNTIME = pathlib.Path.home() / "scratch" / "fossbilling" / "runtime"
LOGS = pathlib.Path.home() / "scratch" / "fossbilling" / "r5-logs"
DB = RUNTIME / "src" / "data" / "fossbilling.sqlite"
CONFIG = RUNTIME / "src" / "config.php"
HARNESS = HERE / "shadow-harness.py"
SCENARIOS = HERE / "shadow-scenarios.json"
FIXTURES = [pathlib.Path.home() / "scratch" / "fossbilling" / "phase0" /
            "fixtures-money.json",
            pathlib.Path.home() / "scratch" / "fossbilling" / "phase0" /
            "fixtures-tax.json"]

EXPECTED_HASH = "6e3c529673c1d089"
MONEY_TABLES = {"invoice", "invoice_item", "transaction", "client_order",
                "client_order_meta", "cart", "cart_product", "client_balance",
                "subscription"}
# Triaged non-money tables: the ONLY tables allowed to differ after B/C,
# each with its reason in findings-r6b.md section 8.
TRIAGED = {"invoice_event", "client_order_status", "email_queue", "setting"}
DOCUMENTED_VOLATILE = sorted(["hash", "hash_expires_at", "created_at",
                              "updated_at", "due_at", "paid_at", "reminded_at",
                              "last_cron_exec", "group_id", "ipn_hash"])
MONEY_FIELDS = {"amount", "total", "subtotal", "tax", "price", "quantity",
                "status", "balance", "currency_rate", "base_income",
                "base_refund", "gateway_id", "invoice_id", "client_id",
                "order_id", "credit", "refund", "income"}

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def counts(table):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in table}
    finally:
        con.close()


def invariants_ok(label):
    print(f"[{label}] reference invariants")
    c = counts(["admin", "admin_group", "admin_group_member", "cart",
                "invoice", "client_order", "email_queue", "service_custom",
                "extension", "extension_meta", "setting", "currency",
                "client", "support_ticket", "tld", "activity_client_email",
                "invoice_event", "client_order_meta", "rate_limit_counter"])
    con0 = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        c["invoice_starting_number"] = con0.execute(
            "SELECT value FROM setting WHERE param='invoice_starting_number'"
        ).fetchone()[0]
    finally:
        con0.close()
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        qpend = con.execute(
            "SELECT COUNT(*) FROM email_queue WHERE status='pending'"
        ).fetchone()[0]
        qsend = con.execute(
            "SELECT COUNT(*) FROM email_queue WHERE status='sending'"
        ).fetchone()[0]
        cartseq = con.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='cart'").fetchone()
        overdue = con.execute(
            "SELECT value FROM setting WHERE param='invoice_overdue_invoked'"
        ).fetchone()
        cron = con.execute(
            "SELECT COUNT(*) FROM setting WHERE param='last_cron_exec'"
        ).fetchone()[0]
    finally:
        con.close()
    h = hashlib.sha256(CONFIG.read_bytes()).hexdigest()[:16]
    check("admin 2", c["admin"] == 2, str(c["admin"]))
    check("admin_group 3", c["admin_group"] == 3, str(c["admin_group"]))
    check("admin_group_member 1", c["admin_group_member"] == 1,
          str(c["admin_group_member"]))
    check("cart 283", c["cart"] == 283, str(c["cart"]))
    check("cart seq floor >=318", cartseq and cartseq[0] >= 318, str(cartseq))
    check("invoice 323", c["invoice"] == 323, str(c["invoice"]))
    check("client_order 11", c["client_order"] == 11, str(c["client_order"]))
    check("email_queue 67 = 5 pending + 62 sending",
          c["email_queue"] == 67 and qpend == 5 and qsend == 62,
          f"{c['email_queue']} {qpend} {qsend}")
    check("service_custom 17", c["service_custom"] == 17,
          str(c["service_custom"]))
    check("extension 6", c["extension"] == 6, str(c["extension"]))
    check("extension_meta 3", c["extension_meta"] == 3,
          str(c["extension_meta"]))
    check("setting 38", c["setting"] == 38, str(c["setting"]))
    check("currency 1", c["currency"] == 1, str(c["currency"]))
    check("client 3", c["client"] == 3, str(c["client"]))
    check("support_ticket 2", c["support_ticket"] == 2,
          str(c["support_ticket"]))
    check("tld 1", c["tld"] == 1, str(c["tld"]))
    check("activity_client_email 0", c["activity_client_email"] == 0,
          str(c["activity_client_email"]))
    check("invoice_event 776", c["invoice_event"] == 776,
          str(c["invoice_event"]))
    check("client_order_meta 0", c["client_order_meta"] == 0,
          str(c["client_order_meta"]))
    check("rate_limit_counter 0", c["rate_limit_counter"] == 0,
          str(c["rate_limit_counter"]))
    check("invoice_starting_number 358",
          str(c["invoice_starting_number"]) == "358",
          str(c["invoice_starting_number"]))
    check("invoice_overdue_invoked 2026-10-24 05:31:25",
          overdue and overdue[0] == "2026-10-24 05:31:25", str(overdue))
    check("last_cron_exec absent", cron == 0, str(cron))
    check("config hash 6e3c", h == EXPECTED_HASH, h)


def port_up(port):
    """TCP connect, parity44-style. :8080 must NOT be checked with HTTP
    200: PHP returns HTTP 404 (with a 740 JSON envelope body) for
    unknown API methods, so an HTTP-200 check fails on a healthy server
    — parity45's first run tripped on exactly this."""
    import socket
    s = socket.socket()
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def url_up(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def url_down(port, timeout=3):
    return not port_up(port)


def run_harness(args, outdir, logname):
    outdir.mkdir(parents=True, exist_ok=True)
    log = LOGS / logname
    cmd = [sys.executable, str(HARNESS)] + args + ["--out", str(outdir)]
    with open(log, "w") as lf:
        proc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT,
                              timeout=1800)
    # The harness exits 1 whenever ANY diff exists — including triaged
    # non-money diffs, which this suite EXPECTS (sections B/C assert on
    # the report's contents, not on harness cleanliness). So "ran
    # successfully" means a report was written, not exit 0; exit 1 with
    # no report would be a harness failure and raises below.
    print(f"  harness log -> {log} (exit {proc.returncode}; 1 = diffs "
          f"found, expected here)")
    check(f"harness report written ({logname})",
          (outdir / "report.json").exists())
    return json.loads((outdir / "report.json").read_text())


def assert_clean_report(report, label):
    """Per-scenario: env 0, money False, db tables triaged-only + no money."""
    for s in report["scenarios"]:
        sid = s["id"]
        env = len(s["envelope_diffs"])
        tables = sorted(s["db_diffs"].keys())
        check(f"{label} {sid} env 0", env == 0, str(env))
        check(f"{label} {sid} money False", s["money_diff"] is False,
              str(s["money_diff"]))
        check(f"{label} {sid} db tables triaged-only",
              set(tables) <= TRIAGED, str(tables))
        check(f"{label} {sid} no money-table diff",
              not (set(tables) & MONEY_TABLES), str(tables))
        print(f"    {sid}: env={env} money={s['money_diff']} tables={tables}")


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    print("[A] reference state before")
    invariants_ok("before")
    check(":8080 answering (TCP)", port_up(8080))
    check(":3001 answering (prime)",
          url_up("http://127.0.0.1:3001/api/fb/__prime"))
    if FAIL:
        print("ABORT: reference state or servers not clean before harness "
              "runs; fix first, do not launch.")
        print(f"parity45: {PASS} passed, {FAIL} failed")
        return 1
    run_dirs_before = set(LOGS.glob("shadow-run-*"))

    print("[B] harness proof: 7 shadow scenarios TS-vs-PHP")
    scen_out = LOGS / "parity45-scen"
    scen = run_harness(["--scenarios", str(SCENARIOS)], scen_out,
                       "parity45-scen.log")
    assert_clean_report(scen, "scen")
    live_sig = {s["id"]: (len(s["envelope_diffs"]), s["money_diff"],
                           sorted(s["db_diffs"].keys()))
                for s in scen["scenarios"]}

    print("[C] fixture-corpus zero-diff reproduction: 13 fixtures")
    fix_out = LOGS / "parity45-fixtures"
    fix = run_harness(["--fixtures"] + [str(f) for f in FIXTURES], fix_out,
                      "parity45-fixtures.log")
    check("13 fixtures translated", len(fix["scenarios"]) == 13,
          str(len(fix["scenarios"])))
    assert_clean_report(fix, "fixture")

    print("[D] capture/replay mode proven (staff basket + cart)")
    for cap_name, live_id in [("staff-basket-checkout.capture.jsonl",
                               "staff-basket-checkout"),
                              ("cart-checkout.capture.jsonl",
                               "cart-checkout")]:
        cap = scen_out / cap_name
        check(f"capture exists {cap_name}", cap.exists())
        rep_out = LOGS / f"parity45-replay-{live_id}"
        rep = run_harness(["--replay", str(cap)], rep_out,
                          f"parity45-replay-{live_id}.log")
        check("replay yields 1 scenario", len(rep["scenarios"]) == 1,
              str(len(rep["scenarios"])))
        if rep["scenarios"]:
            r = rep["scenarios"][0]
            sig = (len(r["envelope_diffs"]), r["money_diff"],
                   sorted(r["db_diffs"].keys()))
            check(f"replay signature == live ({live_id})",
                  sig == live_sig[live_id], f"replay={sig} live={live_sig[live_id]}")

    print("[E] normalization honesty")
    spec = importlib.util.spec_from_file_location("shadow_harness", HARNESS)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check("VOLATILE_KEYS == documented 10",
          sorted(mod.VOLATILE_KEYS) == DOCUMENTED_VOLATILE,
          str(sorted(mod.VOLATILE_KEYS)))
    check("no money field normalized",
          not (set(mod.VOLATILE_KEYS) & MONEY_FIELDS),
          str(set(mod.VOLATILE_KEYS) & MONEY_FIELDS))
    check("no money field ends in _at (the _at rule is timestamps-only)",
          not any(f.endswith("_at") for f in MONEY_FIELDS))
    for s in scen["scenarios"]:
        check(f"report normalized_fields documented ({s['id']})",
              sorted(s["normalized_fields"]) == DOCUMENTED_VOLATILE,
              str(s["normalized_fields"]))
        check(f"report normalized_fields contain no money field ({s['id']})",
              not (set(s["normalized_fields"]) & MONEY_FIELDS))

    print("[F] restore")
    invariants_ok("after")
    check(":8080 answering at end (TCP)", port_up(8080))
    check(":3001 answering at end (prime)",
          url_up("http://127.0.0.1:3001/api/fb/__prime"))
    for port, name in [(8081, ":8081 oracle"), (18025, ":18025 mock SMTP"),
                       (18026, ":18026 antispam mock"),
                       (3003, ":3003 forced"), (18081, ":18081 harness PHP"),
                       (3012, ":3012 harness TS")]:
        check(f"{name} DOWN at end", url_down(port))
    # Disposable targets: the harness deletes its shadow-run-* tmp dir in
    # finally unless --keep (never passed here); the --out reports persist
    # as evidence, which is intended.
    new_dirs = set(LOGS.glob("shadow-run-*")) - run_dirs_before
    check("no new shadow-run-* tmp dir left", not new_dirs,
          str(sorted(str(d) for d in new_dirs)))
    for rep, label in [(scen, "scen"), (fix, "fix")]:
        for key in ("php_db", "ts_db"):
            p = pathlib.Path(rep[key])
            check(f"disposable {label} {key} deleted", not p.exists(), str(p))

    print(f"parity45: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
