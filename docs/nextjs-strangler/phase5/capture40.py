#!/usr/bin/env python3
"""Phase 5 R5d capture: PHP vs pre-fix TS stats outputs under UTC and
America/Chicago configs, with boundary-straddling crafted rows.

Pre-fix TS runs on :3001 with TZ=UTC, so its output cannot move with
config — the Chicago PHP-vs-TS diffs below ARE the divergence R5d
fixes. PHP reads config.php fresh per request (proven here: Chicago
PHP output differs from UTC PHP output with no restart).

Crafted rows are snapshot-restored in finally; config.php bytes are
restored in finally and the hash asserted equal to baseline.
Run: python3 capture40.py  (writes captures40/*.json)
"""
import datetime as dt
import hashlib
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/config.php")
OUT = pathlib.Path(__file__).parent / "captures40"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(op):
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
    token = m.group(1) if m else None
    payload = {"email": SUPER_EMAIL, "password": SUPER_PASS}
    if token:
        payload["CSRFToken"] = token
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
    with op.open(req, timeout=60) as resp:
        parsed = json.loads(resp.read().decode())
    assert parsed.get("error") is None, f"login failed: {parsed}"
    return token


def call(op, token, base, method, data=None):
    payload = dict(data or {})
    if token:
        payload["CSRFToken"] = token
    body = urllib.parse.urlencode(payload).encode()
    url = f"{base}/api/admin/stats/{method}" if base == PHP else f"{base}/admin/stats/{method}"
    req = urllib.request.Request(url, data=body, method="POST")
    try:
        with op.open(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    try:
        return json.loads(raw.decode())
    except Exception:
        return {"_raw": raw[:300].decode("utf-8", "replace")}


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    snaps = {}
    for t in tables:
        cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
    seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()
    cfg_bytes = CFG.read_bytes()
    cfg_hash = hashlib.sha256(cfg_bytes).hexdigest()
    assert b"'timezone' => 'UTC'" in cfg_bytes, "baseline config is not UTC"

    def restore():
        for t in tables:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            d.executemany(
                f'INSERT INTO "{t}" (' + ",".join(cols) + ") VALUES (" + ",".join("?" * len(cols)) + ")",
                [tuple(r) for r in rows])
        d.execute("DELETE FROM sqlite_sequence")
        d.executemany("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", seq)
        d.commit()
        CFG.write_bytes(cfg_bytes)

    # OPcache lesson (proven 2026-10-29): Config::getConfig() uses
    # `include PATH_CONFIG`, and the PHP server runs OPcache with
    # revalidate_freq=2s per worker. A config edit is NOT visible to
    # all PHP workers immediately — reads right after an edit return
    # STALE values, and different workers flip at different times.
    # So after every edit: sleep past the window, then POLL PHP until
    # a TZ-sensitive read proves the new zone, before trusting any
    # oracle output. Without this, early calls in a run are silently
    # stale (the first capture40 run's mixed results).
    EXPECTED_FIRST_X = {"UTC": 1793404800000, "America/Chicago": 1793422800000}

    def set_config_tz(op, token, zone):
        txt = CFG.read_text()
        txt2 = re.sub(r"'timezone' => '[^']*'", f"'timezone' => '{zone}'", txt, count=1)
        assert f"'timezone' => '{zone}'" in txt2, "timezone line not found"
        CFG.write_text(txt2)
        import time as _time
        _time.sleep(6)
        want = EXPECTED_FIRST_X[zone]
        for _ in range(20):
            got = call(op, token, PHP, "get_invoices",
                       {"date_from": "2026-10-30", "date_to": "2026-11-03"})
            try:
                first = got["result"][0][0]
            except Exception:
                first = None
            if first == want:
                return
            _time.sleep(3)
        raise AssertionError(f"PHP did not flip to {zone}: last first-x={first}")

    now_utc = dt.datetime.now(dt.timezone.utc)
    run_date = now_utc.date()
    fmt = lambda x: x.strftime("%Y-%m-%d %H:%M:%S")
    # Run-date-relative straddles (robust to run date):
    # 02:00 UTC on a day = 21:00 previous day in Chicago (UTC-5).
    today_early = dt.datetime.combine(run_date, dt.time(2, 0), dt.timezone.utc)
    today_mid = dt.datetime.combine(run_date, dt.time(7, 0), dt.timezone.utc)
    yest_early = today_early - dt.timedelta(days=1)
    first_early = dt.datetime.combine(run_date.replace(day=1), dt.time(2, 0), dt.timezone.utc)
    prev_mid = today_early - dt.timedelta(days=15)
    # Fixed DST windows (explicit date params, run-date independent).
    dst_fall = [("2026-11-01 05:30:00"), ("2026-11-01 06:30:00"),
                ("2026-11-01 07:30:00"), ("2026-11-01 08:30:00")]
    dst_spring = [("2026-03-08 07:30:00"), ("2026-03-08 08:30:00")]

    def craft():
        inv_ids = []

        def inv(paid_at, created_at=None):
            cur = d.execute(
                "INSERT INTO invoice (client_id, serie, currency, status, issued,"
                " base_income, base_refund, paid_at, created_at, updated_at)"
                " VALUES (1, 'FOSS', 'USD', 'paid', 1, 100, NULL, ?, ?, ?)",
                (paid_at, created_at or paid_at, paid_at))
            inv_ids.append(cur.lastrowid)

        for ts in (fmt(today_early), fmt(today_mid), fmt(yest_early),
                   fmt(first_early), fmt(prev_mid)):
            inv(ts)
        for ts in dst_fall + dst_spring:
            inv(ts)
        d.execute(
            "INSERT INTO client (email, first_name, last_name, currency, status, role,"
            " tax_exempt, created_at, updated_at) VALUES"
            " ('r5d-a@example.com', 'R5d', 'A', 'USD', 'active', 'client', 0, ?, ?)",
            (fmt(today_early), fmt(today_early)))
        d.execute(
            "INSERT INTO client (email, first_name, last_name, currency, status, role,"
            " tax_exempt, created_at, updated_at) VALUES"
            " ('r5d-b@example.com', 'R5d', 'B', 'USD', 'active', 'client', 0, ?, ?)",
            (fmt(yest_early), fmt(yest_early)))
        d.execute(
            "INSERT INTO client_order (client_id, product_id, status, created_at, updated_at)"
            " VALUES (1, 9, 'active', ?, ?)", (fmt(today_early), fmt(today_early)))
        d.execute(
            "INSERT INTO support_ticket (client_id, subject, status, created_at, updated_at)"
            " VALUES (1, 'r5d', 'open', ?, ?)", (fmt(today_early), fmt(today_early)))
        d.commit()
        return inv_ids

    windows = {
        "run": {"date_from": (run_date - dt.timedelta(days=2)).isoformat(),
                "date_to": (run_date + dt.timedelta(days=1)).isoformat()},
        "dst_fall": {"date_from": "2026-10-30", "date_to": "2026-11-03"},
        "dst_spring": {"date_from": "2026-03-06", "date_to": "2026-03-10"},
    }

    def read_stack(op, token, base):
        out = {}
        out["get_summary"] = call(op, token, base, "get_summary")
        out["get_summary_income"] = call(op, token, base, "get_summary_income")
        for wname, w in windows.items():
            out[f"get_income_{wname}"] = call(op, token, base, "get_income", w)
            out[f"get_refunds_{wname}"] = call(op, token, base, "get_refunds", w)
            out[f"get_clients_{wname}"] = call(op, token, base, "get_clients", w)
            out[f"get_orders_{wname}"] = call(op, token, base, "get_orders", w)
            out[f"get_invoices_{wname}"] = call(op, token, base, "get_invoices", w)
            out[f"get_tickets_{wname}"] = call(op, token, base, "get_tickets", w)
            out[f"get_product_sales_{wname}"] = call(op, token, base, "get_product_sales", w)
        return out

    try:
        op = make_opener()
        token = login(op)
        craft()
        corpus = {"run_date": run_date.isoformat(), "crafted": {
            "today_early_utc": fmt(today_early), "today_mid_utc": fmt(today_mid),
            "yest_early_utc": fmt(yest_early), "first_early_utc": fmt(first_early),
            "prev_mid_utc": fmt(prev_mid), "dst_fall_utc": dst_fall,
            "dst_spring_utc": dst_spring}}
        for zone, fname in (("UTC", "utc"), ("America/Chicago", "chicago")):
            set_config_tz(op, token, zone)
            corpus[f"php_{fname}"] = read_stack(op, token, PHP)
            corpus[f"ts_{fname}"] = read_stack(op, token, TS)
            print(f"captured {zone}")
        OUT.mkdir(exist_ok=True)
        (OUT / "corpus.json").write_text(json.dumps(corpus, indent=2, default=str))
        # Visible-failure summary: which keys differ Chicago PHP vs TS.
        diffs = []
        for key in corpus["php_chicago"]:
            if corpus["php_chicago"][key] != corpus["ts_chicago"][key]:
                diffs.append(key)
        print("Chicago PHP-vs-TS differing keys:", diffs)
        print("UTC PHP-vs-TS differing keys:",
              [k for k in corpus["php_utc"] if corpus["php_utc"][k] != corpus["ts_utc"][k]])
        print("PHP UTC-vs-Chicago differing keys:",
              [k for k in corpus["php_utc"] if corpus["php_utc"][k] != corpus["php_chicago"][k]])
    finally:
        restore()
        assert hashlib.sha256(CFG.read_bytes()).hexdigest() == cfg_hash, "config hash NOT restored"
        print("restored; config hash OK")


if __name__ == "__main__":
    main()
