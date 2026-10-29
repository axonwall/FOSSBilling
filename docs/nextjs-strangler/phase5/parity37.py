#!/usr/bin/env python3
"""Phase 5 R5d parity: TS stats timezone resolution (env > config > UTC).

Sections:
  A. UTC parity (baseline): config UTC, PHP:8080 vs Next:3001 (TZ=UTC).
     Must pass exactly as before the fix.
  B. NON-UTC proof: config America/Chicago, PHP:8080 vs a TS instance
     on :3002 with TZ UNSET (so the config path drives it). Series
     x-values are zone-midnight instants — they differ between zones
     at ANY hour, so this is the fix proof (pre-fix TS matched UTC
     everywhere; see captures40/corpus.json).
  C. Env-override proof: capture the PHP oracle with config
     Pacific/Kiritimati, then set config back to Chicago and read the
     :3002 instance WITH TZ=Pacific/Kiritimati — its output must equal
     the Kiritimati oracle (env wins). Kiritimati's date differs from
     UTC's at most run hours (UTC+14), so this section ALSO proves
     live summary buckets move with the zone; if the run straddles a
     Kiritimati midnight (10:00 UTC) between oracle and TS reads, the
     two summary cases are reported SKIPPED (environmental), not
     failed, while the explicit-window series cases still compare.
  D. Fallback proof: config timezone key REMOVED + :3002 TZ unset ->
     TS must equal PHP (absent key -> PHP default UTC). Then config
     INVALID ('No/Such_Zone'): TS-only assertion — TS output must
     equal its own UTC-fallback output. PHP is NOT asserted here:
     an invalid zone makes PHP's load emit a Notice that breaks
     session headers in this dev setup (proven 2026-10-29); PHP's
     effective date behavior is still UTC, but the page is
     unmeasurable, so the suite documents it instead of asserting
     PHP equality.

Server choreography: :3001 is NEVER disturbed (its TZ=UTC env stays
for later suites). All TZ-case TS reads go through :3002, started
per case with controlled env, killed by port in finally, with :3001
prime re-verified at the end.

Config discipline: one config.php edit drives both stacks (PHP reads
the same shared config.php the TS store reads). After every edit:
sleep 6s past the OPcache window (revalidate_freq=2s per worker,
proven 2026-10-29), then POLL PHP until a TZ-sensitive read proves
the new zone (fall-window get_invoices first-x), before trusting any
oracle output. Crafted rows + config bytes are snapshot-restored in
finally; the config hash must equal the pre-suite baseline at the end.

Normalization (documented pre-existing difference, NOT fixed here):
PHP returns [] and TS returns {} for an empty keyValue map
(get_product_sales with no matching rows). Those two shapes compare
equal in this suite, with a NOTE line.

Midnight caveat (R5c t12 class): summary reads are back-to-back;
a run straddling a UTC midnight between the PHP and TS summary reads
would break today/yesterday equality for environmental reasons.
Crafted run-window rows are computed from the suite-start date, so
equality still holds across a midnight for both stacks equally —
only a PHP/TS read split across midnight would fail, and then only
on the two summary cases.

Run: python3 parity37.py  (nohup + log file; ~200s)
"""
import datetime as dt
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

PHP = "http://127.0.0.1:8080"
TS1 = "http://127.0.0.1:3001/api/fb"
TS2 = "http://127.0.0.1:3002/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/config.php")
LOGDIR = pathlib.Path("/home/hatch/scratch/fossbilling/r5-logs")
NEXTDIR = "/home/hatch/scratch/fossbilling/repo/apps/nextjs"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"

MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,"
           "custompages,email,extension,formbuilder,index,invoice,massmailer,"
           "news,notification,order,page,product,profile,redirect,security,"
           "seo,serviceapikey,servicecustom,servicedomain,servicedownloadable,"
           "servicehosting,servicelicense,staff,stats,support,system,theme,widgets")


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


def prime_ok(base):
    try:
        with urllib.request.urlopen(f"{base}/__prime" if "300" in base else base,
                                    timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def fall_first_x(zone_name):
    # Zone midnight of 2026-10-31 (first series day of the fall window)
    # in milliseconds — the OPcache gate probe value.
    t = dt.datetime(2026, 10, 31, 0, 0, tzinfo=ZoneInfo(zone_name))
    return int(t.timestamp() * 1000)


def normalize(v):
    # Empty keyValue map: PHP [] vs TS {} (pre-existing, not R5d).
    if v == [] or v == {}:
        return "EMPTY_MAP"
    return v


def norm_envelope(env):
    if isinstance(env, dict) and "result" in env:
        out = dict(env)
        out["result"] = normalize(env["result"])
        return out
    return env


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
    inv_before = {
        t: d.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        for t in ("invoice", "client", "client_order", "support_ticket",
                  "client_balance", "email_queue", "service_custom", "extension",
                  "extension_meta", "setting", "admin", "admin_group",
                  "admin_group_member", "currency", "tld")
    }
    salt = re.search(r"'salt'\s*=>\s*'([^']+)'", cfg_bytes.decode()).group(1)

    ts2_proc = None

    def restore():
        nonlocal ts2_proc
        stop_ts2()
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

    def set_config(op, token, zone):
        """zone: IANA name, None (remove key), or 'INVALID'."""
        txt = CFG.read_text()
        if zone is None:
            txt2, n = re.subn(r"\s*'timezone' => '[^']*',", "", txt, count=1)
            assert n == 1, "timezone line not found for removal"
        elif zone == "INVALID":
            txt2 = re.sub(r"'timezone' => '[^']*'", "'timezone' => 'No/Such_Zone'", txt, count=1)
            if "'timezone' => 'No/Such_Zone'" not in txt2:
                # Key was removed by an earlier step: insert it into i18n.
                txt2, n = re.subn(r"('i18n' => \[\n)",
                                  r"\1        'timezone' => 'No/Such_Zone',\n", txt, count=1)
                assert n == 1, "i18n block not found for insert"
        else:
            txt2 = re.sub(r"'timezone' => '[^']*'", f"'timezone' => '{zone}'", txt, count=1)
            assert f"'timezone' => '{zone}'" in txt2, "timezone line not found"
        CFG.write_text(txt2)
        # OPcache window: sleep past revalidate_freq, then poll PHP
        # until a TZ-sensitive read proves the new zone. INVALID skips
        # the PHP gate (PHP page breaks on the Notice in dev).
        time.sleep(6)
        if zone == "INVALID":
            return
        want = fall_first_x(zone if zone is not None else "UTC")
        for _ in range(20):
            got = call(op, token, PHP, "get_invoices",
                       {"date_from": "2026-10-30", "date_to": "2026-11-03"})
            try:
                first = got["result"][0][0]
            except Exception:
                first = None
            if first == want:
                return
            time.sleep(3)
        raise AssertionError(f"PHP did not flip to {zone}: last first-x={first}")

    def start_ts2(tz_env):
        """tz_env: None (unset TZ) or a zone string. Returns on prime."""
        nonlocal ts2_proc
        stop_ts2()
        env = dict(os.environ)
        env["FB_TS_MODULES"] = MODULES
        env["FB_DATABASE_PATH"] = DBP
        env["FOSSBILLING_URL"] = PHP
        env["FB_PAYPAL_SKIP_VERIFY"] = "1"
        env["FB_CALLBACK_SALT"] = salt
        env["FOSSBILLING_PHP_SRC"] = "/home/hatch/scratch/fossbilling/repo/src"
        if tz_env is None:
            env.pop("TZ", None)
        else:
            env["TZ"] = tz_env
        log = open(LOGDIR / "next3002-parity37.log", "ab")
        ts2_proc = subprocess.Popen(
            ["npx", "next", "start", "-p", "3002"], cwd=NEXTDIR, env=env,
            stdout=log, stderr=subprocess.STDOUT)
        for _ in range(60):
            if prime_ok(TS2):
                return
            time.sleep(2)
        raise AssertionError(":3002 did not come up")

    def stop_ts2():
        nonlocal ts2_proc
        if ts2_proc is not None:
            try:
                ts2_proc.terminate()
            except Exception:
                pass
            ts2_proc = None
        subprocess.run(["fuser", "-k", "3002/tcp"], capture_output=True)
        for _ in range(15):
            try:
                urllib.request.urlopen(TS2 + "/__prime", timeout=2)
            except Exception:
                return
            time.sleep(1)

    now_utc = dt.datetime.now(dt.timezone.utc)
    run_date = now_utc.date()
    fmt = lambda x: x.strftime("%Y-%m-%d %H:%M:%S")
    today_early = dt.datetime.combine(run_date, dt.time(2, 0), dt.timezone.utc)
    today_mid = dt.datetime.combine(run_date, dt.time(7, 0), dt.timezone.utc)
    yest_early = today_early - dt.timedelta(days=1)
    first_early = dt.datetime.combine(run_date.replace(day=1), dt.time(2, 0), dt.timezone.utc)
    prev_mid = today_early - dt.timedelta(days=15)
    dst_fall = ["2026-11-01 05:30:00", "2026-11-01 06:30:00",
                "2026-11-01 07:30:00", "2026-11-01 08:30:00"]
    dst_spring = ["2026-03-08 07:30:00", "2026-03-08 08:30:00"]

    def craft():
        def inv(paid_at):
            d.execute(
                "INSERT INTO invoice (client_id, serie, currency, status, issued,"
                " base_income, base_refund, paid_at, created_at, updated_at)"
                " VALUES (1, 'FOSS', 'USD', 'paid', 1, 100, NULL, ?, ?, ?)",
                (paid_at, paid_at, paid_at))
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
            for m in ("get_income", "get_refunds", "get_clients", "get_orders",
                      "get_invoices", "get_tickets", "get_product_sales"):
                out[f"{m}_{wname}"] = call(op, token, base, m, w)
        return out

    results = {}
    total_fail = 99

    def compare(section, a, b, skip_summary=False):
        passed, failed, skipped, fails = 0, 0, 0, []
        for key in a:
            if skip_summary and key in ("get_summary", "get_summary_income"):
                skipped += 1
                continue
            if norm_envelope(a[key]) == norm_envelope(b[key]):
                passed += 1
            else:
                failed += 1
                fails.append(key)
        results[section] = (passed, failed, skipped, fails)
        print(f"[{section}] {passed} pass, {failed} fail, {skipped} skipped"
              + (f" -- FAILS: {fails}" if fails else ""))

    try:
        assert prime_ok(TS1), ":3001 not answering at start"
        assert prime_ok(PHP), "PHP:8080 not answering at start"
        op = make_opener()
        token = login(op)
        craft()
        print(f"run_date={run_date.isoformat()} crafted rows in place")

        # --- A: UTC baseline (:3001, TZ=UTC) ---
        set_config(op, token, "UTC")
        php_a = read_stack(op, token, PHP)
        ts_a = read_stack(op, token, TS1)
        compare("A utc", php_a, ts_a)

        # --- B: Chicago config, :3002 TZ unset (config path) ---
        start_ts2(None)
        set_config(op, token, "America/Chicago")
        php_b = read_stack(op, token, PHP)
        ts_b = read_stack(op, token, TS2)
        compare("B chicago-config", php_b, ts_b)
        stop_ts2()

        # --- C: env override. Oracle first, then env instance. ---
        set_config(op, token, "Pacific/Kiritimati")
        kiri_date_oracle = dt.datetime.now(ZoneInfo("Pacific/Kiritimati")).date()
        php_c = read_stack(op, token, PHP)
        set_config(op, token, "America/Chicago")
        start_ts2("Pacific/Kiritimati")
        kiri_date_ts = dt.datetime.now(ZoneInfo("Pacific/Kiritimati")).date()
        ts_c = read_stack(op, token, TS2)
        skip_sum = kiri_date_oracle != kiri_date_ts
        if skip_sum:
            print("NOTE: Kiritimati date flipped between oracle and TS reads;"
                  " summary cases skipped as environmental")
        compare("C env-override", php_c, ts_c, skip_summary=skip_sum)
        stop_ts2()

        # --- D: fallback. Removed key -> UTC; invalid -> TS-only UTC. ---
        start_ts2(None)
        set_config(op, token, None)
        php_d = read_stack(op, token, PHP)
        ts_d = read_stack(op, token, TS2)
        compare("D removed-key", php_d, ts_d)
        set_config(op, token, "INVALID")
        ts_inv = read_stack(op, token, TS2)
        compare("D invalid-config-ts-only", ts_d, ts_inv)
        stop_ts2()

        total_pass = sum(v[0] for v in results.values())
        total_fail = sum(v[1] for v in results.values())
        total_skip = sum(v[2] for v in results.values())
        print(f"\nTOTAL {total_pass} pass, {total_fail} fail, {total_skip} skipped")
        print("NOTE: empty keyValue map PHP [] vs TS {} compares equal (pre-existing).")
    finally:
        restore()
        ok_hash = hashlib.sha256(CFG.read_bytes()).hexdigest() == cfg_hash
        inv_after = {
            t: d.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            for t in inv_before
        }
        inv_ok = inv_after == inv_before
        print(f"restored; config hash {'OK' if ok_hash else 'MISMATCH'}; "
              f"invariants {'OK' if inv_ok else 'MISMATCH: ' + str({k: (inv_before[k], inv_after[k]) for k in inv_before if inv_before[k] != inv_after[k]})}")
        print(f":3001 prime after: {'200' if prime_ok(TS1) else 'DOWN'}")
        if not ok_hash or not inv_ok:
            sys.exit(2)
    sys.exit(0 if total_fail == 0 else 1)


if __name__ == "__main__":
    main()
