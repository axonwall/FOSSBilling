#!/usr/bin/env python3
"""R5f parity39: full 13-job cron runner, PHP vs TS, post-fix.

Proves the R5f runner against the capture42 corpus (which is the
truth where it differs from the scope doc). Every section runs on
BOTH stacks with the same crafts, snapshot-restored in finally
(full-table restore, as capture42 does). Known divergences are
asserted PER-STACK (never faked into equality) and named in
findings-r5f.md:

- Gate response shape: PHP HTTP 503, TS HTTP 200 + envelope code 503
  (TS envelopes are always HTTP 200 by seam convention).
- Gate side effects: PHP bootstrap FINALIZES a pending state (and
  flips maintenance ON only for a missing state file); TS never
  finalizes and never flips maintenance (no TS patcher; R5j scope).
- Pay item execution: PHP tryPayWithCredits executes item tasks
  immediately; TS defers to activate_paid (10-min cutoff). Pay
  section asserts invoice status + balance rows only, NOT item
  execution or order-1 state.
- service_type-NULL activation: PHP fails the attempt (attempts 1 +
  note, stays pending_setup); TS activates. Asserted per-stack.
- cancel_unpaid enabled path: PHP DELETES, TS cancels. Only the
  config GATE is asserted (disabled -> no change on both).
- Live currency fetch, registrar domain sync, hosting-manager
  suspend calls, renew-task execution, domain repricing, renewal
  promos, reminder PDF attachment + hash-lifetime extension: PINNED
  GAPS, not asserted (see findings-r5f.md).

Mock SMTP (:18025) lifecycle is owned by this suite (kill leaked
listener at start, start our own, kill in finally); the :8081 prod
oracle is started only for the sendmail section and killed in
finally. NEVER point any section at a real SMTP host. The crafted
SMTP password is a DUMMY value, never printed/logged/stored.
mod_cron cron_hash values here are test-only strings.
"""
import datetime as dt
import glob
import hashlib
import http.cookiejar
import json
import pathlib
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PHP_DEV = "http://127.0.0.1:8080"
PHP_PROD = "http://127.0.0.1:8081"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
STATE = "/home/hatch/scratch/fossbilling/runtime/src/data/update-finalization.json"
MOCK = "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"
HERE = pathlib.Path(__file__).parent

SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"

CHECKS = 0
FAILURES = []


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(opener, base, email, password):
    resp = opener.open(base + "/login")
    page = resp.read().decode("utf-8", "replace")
    token = page.split('name="CSRFToken" value="')[1].split('"')[0]
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(base + "/api/guest/staff/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def call(opener, token, base, role, module, method, params=None, as_json=False):
    if as_json:
        payload = {"CSRFToken": token} if token else {}
        payload.update(params or {})
        body = json.dumps(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base in (PHP_DEV, PHP_PROD) else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    else:
        payload = dict(params or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base in (PHP_DEV, PHP_PROD) else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
    try:
        raw = opener.open(req, timeout=120).read()
        status = 200
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    return status, json.loads(raw)


def clear_php_app_cache():
    for pool in glob.glob("/home/hatch/scratch/fossbilling/runtime/src/data/cache/sf_cache_*"):
        shutil.rmtree(pool, ignore_errors=True)


def read_mock():
    try:
        return [json.loads(l) for l in pathlib.Path(MOCK).read_text().splitlines() if l.strip()]
    except FileNotFoundError:
        return []


def truncate_mock():
    pathlib.Path(MOCK).write_text("")


def q(sql, args=()):
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    rows = d.execute(sql, args).fetchall()
    d.close()
    return [dict(r) for r in rows]


def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def exec_sql(sql, args=()):
    d = sqlite3.connect(DBP)
    d.execute(sql, args)
    d.commit()
    d.close()


def setting(param):
    r = q1("SELECT value FROM setting WHERE param = ?", (param,))
    return r["value"] if r else None


def set_setting(param, value):
    d = sqlite3.connect(DBP)
    if q1("SELECT id FROM setting WHERE param = ?", (param,)):
        d.execute("UPDATE setting SET value = ? WHERE param = ?", (value, param))
    else:
        d.execute("INSERT INTO setting (param, value, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
                  (param, value))
    d.commit()
    d.close()
    clear_php_app_cache()


def maint_enabled():
    return "maintenance_mode' => [\n        'enabled' => true" in pathlib.Path(CFG).read_text()


def wait_php_up():
    for _ in range(12):
        try:
            if urllib.request.urlopen(PHP_DEV + "/login", timeout=5).status == 200:
                return True
        except Exception:
            time.sleep(1)
    return False


def fmt(dtobj):
    return dtobj.strftime("%Y-%m-%d %H:%M:%S")


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
    cfg_bytes = pathlib.Path(CFG).read_bytes()
    cfg_hash = hashlib.sha256(cfg_bytes).hexdigest()
    state_backup = pathlib.Path(STATE).read_bytes() if pathlib.Path(STATE).exists() else None
    d.close()

    op = make_opener()
    tok = login(op, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
    op_ts = make_opener()
    tok_ts = login(op_ts, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
    # Helpers that POST to PHP admin (config_save, mock-email setup)
    # must use the CURRENT php token: restore() wipes sessions, so a
    # token captured before an inner restore+relogin is dead (CSRF
    # invalid). relogin() refreshes this holder; helpers read it.
    cur_tok = {"php": tok, "ts": tok_ts}

    def relogin():
        t1 = login(op, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
        t2 = login(op_ts, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
        cur_tok["php"] = t1
        cur_tok["ts"] = t2
        return t1, t2

    def restore():
        import gc
        for _obj in gc.get_objects():
            if isinstance(_obj, sqlite3.Connection):
                try:
                    _obj.rollback()
                except Exception:
                    pass
                try:
                    _obj.close()
                except Exception:
                    pass
        dd = sqlite3.connect(DBP, timeout=30)
        for t in tables:
            rows, cols = snaps[t]
            dd.execute(f'DELETE FROM "{t}"')
            for r in rows:
                dd.execute(f'INSERT INTO "{t}" ({",".join(cols)}) VALUES ({",".join("?" * len(cols))})',
                           tuple(r[c] for c in cols))
        dd.execute("DELETE FROM sqlite_sequence")
        for r in seq:
            dd.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", tuple(r))
        dd.commit()
        dd.close()
        clear_php_app_cache()
        if state_backup is None:
            pathlib.Path(STATE).unlink(missing_ok=True)
        else:
            pathlib.Path(STATE).write_bytes(state_backup)
        pathlib.Path(CFG).write_bytes(cfg_bytes)
        clear_php_app_cache()

    def set_mock_email_config():
        mail_cfg = {"mailer": "smtp", "smtp_host": "127.0.0.1", "smtp_port": "18025",
                    "smtp_username": "", "smtp_password": "",
                    "log_enabled": "1", "queue_once": "0", "time_limit": "5", "cancel_after": "5",
                    "ext": "mod_email"}
        st, env = call(op, cur_tok["php"], PHP_DEV, "admin", "extension", "config_save", mail_cfg, as_json=True)
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()

    def set_mod_cron_config(guest_cron, cron_hash):
        st, env = call(op, cur_tok["php"], PHP_DEV, "admin", "extension", "config_save",
                       {"ext": "mod_cron", "guest_cron": guest_cron, "cron_hash": cron_hash})
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()

    def set_mod_config(ext, kv):
        payload = {"ext": ext}
        payload.update(kv)
        st, env = call(op, cur_tok["php"], PHP_DEV, "admin", "extension", "config_save", payload)
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()

    # ---- mock SMTP lifecycle (owned by this suite) ----
    subprocess.run(["fuser", "-k", "18025/tcp"], capture_output=True)
    for _ in range(50):
        probe = socket.socket()
        if probe.connect_ex(("127.0.0.1", 18025)) != 0:
            probe.close()
            break
        probe.close()
        time.sleep(0.1)
    mock_log = open("/home/hatch/scratch/fossbilling/r5-logs/smtp-mock-server.log", "ab")
    mock_proc = subprocess.Popen(["node", "smtp-mock-server.mjs", "18025",
                                  "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"],
                                 cwd=str(HERE), stdout=mock_log, stderr=subprocess.STDOUT)
    for _ in range(50):
        probe = socket.socket()
        if probe.connect_ex(("127.0.0.1", 18025)) == 0:
            probe.close()
            break
        probe.close()
        time.sleep(0.1)

    prod_proc = None

    def start_prod():
        nonlocal prod_proc
        subprocess.run(["fuser", "-k", "8081/tcp"], capture_output=True)
        time.sleep(1)
        import os as _os
        env = dict(_os.environ)
        env.pop("APP_ENV", None)
        env["PHP_CLI_SERVER_WORKERS"] = "4"
        prod_proc = subprocess.Popen(
            ["/home/hatch/scratch/bin/php", "-S", "127.0.0.1:8081"],
            cwd="/home/hatch/scratch/fossbilling/runtime/src",
            stdout=open("/home/hatch/scratch/fossbilling/r5-logs/php8081-r5f.log", "ab"),
            stderr=subprocess.STDOUT, env=env)
        for _ in range(30):
            try:
                if urllib.request.urlopen(PHP_PROD + "/login", timeout=5).status == 200:
                    return True
            except Exception:
                time.sleep(1)
        return False

    def stop_prod():
        nonlocal prod_proc
        if prod_proc is not None:
            prod_proc.terminate()
            try:
                prod_proc.wait(timeout=10)
            except Exception:
                prod_proc.kill()
            prod_proc = None
        subprocess.run(["fuser", "-k", "8081/tcp"], capture_output=True)

    try:
        # ================= §0 invariants =================
        check("0 invoice 323", q1("SELECT COUNT(*) c FROM invoice")["c"] == 323)
        check("0 client_order 11", q1("SELECT COUNT(*) c FROM client_order")["c"] == 11)
        check("0 email_queue 67 (5 pending + 62 sending)",
              q1("SELECT COUNT(*) c FROM email_queue")["c"] == 67 and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 5 and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'sending'")["c"] == 62)
        check("0 extension 6 / meta 3 / setting 38",
              q1("SELECT COUNT(*) c FROM extension")["c"] == 6 and
              q1("SELECT COUNT(*) c FROM extension_meta")["c"] == 3 and
              q1("SELECT COUNT(*) c FROM setting")["c"] == 38)
        check("0 invoice_event 776 / order_meta 0 / email_history 0",
              q1("SELECT COUNT(*) c FROM invoice_event")["c"] == 776 and
              q1("SELECT COUNT(*) c FROM client_order_meta")["c"] == 0 and
              q1("SELECT COUNT(*) c FROM activity_client_email")["c"] == 0)
        check("0 config hash stable", hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)

        # ================= §1 full runner, baseline =================
        # PHP dev: sendmail flips pending -> sending (no delivery).
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        pre_sync = setting("servicedomain_last_sync")
        pre_invoked = setting("invoice_overdue_invoked")
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        check("1 PHP full run true", env.get("result") is True, str(env)[:200])
        check("1 PHP last_cron_exec set", setting("last_cron_exec") is not None)
        check("1 PHP heal backfilled 60 events",
              q1("SELECT COUNT(*) c FROM invoice_event")["c"] - pre_ev == 60,
              f"{pre_ev} -> {q1('SELECT COUNT(*) c FROM invoice_event')['c']}")
        check("1 PHP seo NOT set (Seo inactive)", setting("mod_seo_last_sitemap_submit") is None)
        check("1 PHP domain sync untouched (gate closed)", setting("servicedomain_last_sync") == pre_sync)
        check("1 PHP invoked updated", setting("invoice_overdue_invoked") != pre_invoked)
        check("1 PHP dev sendmail flips pending->sending, no delivery",
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 0 and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'sending'")["c"] == 67)
        check("1 PHP invoice/order counts unchanged",
              q1("SELECT COUNT(*) c FROM invoice")["c"] == 323 and
              q1("SELECT COUNT(*) c FROM client_order")["c"] == 11)
        restore()
        tok, tok_ts = relogin()
        # TS: mock email config so sendmail delivers to the mock.
        set_mock_email_config()
        truncate_mock()
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        pre_sync = setting("servicedomain_last_sync")
        pre_invoked = setting("invoice_overdue_invoked")
        st, env = call(op_ts, tok_ts, TS, "admin", "cron", "run")
        msgs = [m for m in read_mock() if m.get("type") == "accepted"]
        check("1 TS full run true", env.get("result") is True, str(env)[:200])
        check("1 TS last_cron_exec set", setting("last_cron_exec") is not None)
        check("1 TS heal backfilled 60 events",
              q1("SELECT COUNT(*) c FROM invoice_event")["c"] - pre_ev == 60,
              f"{pre_ev} -> {q1('SELECT COUNT(*) c FROM invoice_event')['c']}")
        check("1 TS seo NOT set (Seo inactive)", setting("mod_seo_last_sitemap_submit") is None)
        check("1 TS domain sync untouched (gate closed)", setting("servicedomain_last_sync") == pre_sync)
        check("1 TS invoked updated", setting("invoice_overdue_invoked") != pre_invoked)
        check("1 TS sendmail delivered baseline pending to mock",
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 0 and
              len(msgs) == 5, f"mock accepted={len(msgs)}")
        check("1 TS queue total 62 (only pending deleted)",
              q1("SELECT COUNT(*) c FROM email_queue")["c"] == 62)
        check("1 TS invoice/order counts unchanged",
              q1("SELECT COUNT(*) c FROM invoice")["c"] == 323 and
              q1("SELECT COUNT(*) c FROM client_order")["c"] == 11)
        restore()
        tok, tok_ts = relogin()

        # ================= §2 finalization gate =================
        DISP_MSG = "FOSSBilling update finalization is pending. Complete finalization before using the admin API."
        RUN_MSG = "Update finalization is pending. Cron jobs are paused until finalization is completed."
        pending_state = {"status": "pending", "from_version": "0.0.1", "target_version": "0.0.1",
                         "branch": "release", "update_type": None, "source": "test",
                         "created_at": "2026-10-29T00:00:00+00:00", "finalized_at": None,
                         "completed_at": None,
                         "maintenance_mode": {"enabled": False, "allowed_urls": [], "allowed_ips": []}}

        def set_pending():
            pathlib.Path(STATE).write_text(json.dumps(pending_state))
            clear_php_app_cache()

        # TS admin pending: HTTP 200 + envelope 503 + dispatcher message;
        # state UNTOUCHED (TS never finalizes), no jobs, no events.
        set_pending()
        pre_last = setting("last_cron_exec")
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        pre_q = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        st, env = call(op_ts, tok_ts, TS, "admin", "cron", "run")
        check("2 TS admin pending -> HTTP 200 (seam envelope convention)", st == 200, f"http={st}")
        check("2 TS admin pending -> code 503 + dispatcher message",
              (env.get("error") or {}).get("code") == 503 and (env.get("error") or {}).get("message") == DISP_MSG,
              str(env)[:200])
        check("2 TS admin pending -> state UNCHANGED (no TS finalizer)",
              json.loads(pathlib.Path(STATE).read_text()).get("status") == "pending")
        check("2 TS admin pending -> no jobs (last untouched, queue untouched, events unchanged)",
              setting("last_cron_exec") == pre_last and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == pre_q and
              q1("SELECT COUNT(*) c FROM invoice_event")["c"] == pre_ev)
        check("2 TS admin pending -> maintenance NOT flipped", maint_enabled() is False)
        restore()
        tok, tok_ts = relogin()
        # TS admin missing file: same 503 shape, file stays missing.
        pathlib.Path(STATE).unlink(missing_ok=True)
        clear_php_app_cache()
        st, env = call(op_ts, tok_ts, TS, "admin", "cron", "run")
        check("2 TS admin missing -> 200 + 503 + dispatcher message",
              st == 200 and (env.get("error") or {}).get("code") == 503 and
              (env.get("error") or {}).get("message") == DISP_MSG, str(env)[:200])
        check("2 TS admin missing -> file STAYS missing (no TS ensure)",
              not pathlib.Path(STATE).exists())
        restore()
        tok, tok_ts = relogin()
        # TS guest pending: runner message (dispatcher gate is admin-only).
        # NOTE: config_save must come BEFORE set_pending — any PHP admin
        # call with a pending/finalized state 503s at the dispatcher.
        set_mod_cron_config("1", "testhash42")
        set_pending()
        set_setting("last_cron_exec", fmt(dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=3600)))
        st, env = call(op_ts, tok_ts, TS, "guest", "cron", "run", {"hash": "testhash42"})
        check("2 TS guest pending -> 200 + 503 + RUNNER message",
              st == 200 and (env.get("error") or {}).get("code") == 503 and
              (env.get("error") or {}).get("message") == RUN_MSG, str(env)[:200])
        check("2 TS guest pending -> state still pending",
              json.loads(pathlib.Path(STATE).read_text()).get("status") == "pending")
        restore()
        tok, tok_ts = relogin()
        # PHP admin pending: HTTP 503 + dispatcher message; bootstrap
        # FINALIZES the state in place (+60 backfill) but does NOT flip
        # maintenance; no cron jobs ran.
        set_pending()
        pre_last = setting("last_cron_exec")
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        pre_q = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        check("2 PHP admin pending -> HTTP 503", st == 503, f"http={st}")
        check("2 PHP admin pending -> dispatcher message + code 503",
              (env.get("error") or {}).get("code") == 503 and (env.get("error") or {}).get("message") == DISP_MSG,
              str(env)[:200])
        check("2 PHP admin pending -> bootstrap FINALIZED state",
              json.loads(pathlib.Path(STATE).read_text()).get("status") == "finalized")
        check("2 PHP admin pending -> finalize backfilled 60 events",
              q1("SELECT COUNT(*) c FROM invoice_event")["c"] - pre_ev == 60)
        check("2 PHP admin pending -> maintenance NOT flipped", maint_enabled() is False)
        check("2 PHP admin pending -> no cron jobs ran",
              setting("last_cron_exec") == pre_last and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == pre_q)
        restore()
        assert wait_php_up(), "PHP still 503 after gate restore"
        tok, tok_ts = relogin()
        # PHP admin missing: ensure() recreates pending, createPendingState
        # flips maintenance ON, bootstrap finalizes; the call still 503s.
        pathlib.Path(STATE).unlink(missing_ok=True)
        clear_php_app_cache()
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        recreated = json.loads(pathlib.Path(STATE).read_text()) if pathlib.Path(STATE).exists() else None
        check("2 PHP admin missing -> 503 + recreated finalized (missing-finalization-state)",
              st == 503 and (recreated or {}).get("status") == "finalized" and
              (recreated or {}).get("source") == "missing-finalization-state",
              f"http={st} recreated={recreated}")
        check("2 PHP admin missing -> maintenance flipped ON", maint_enabled() is True)
        restore()
        assert wait_php_up(), "PHP still 503 after missing-state restore"
        tok, tok_ts = relogin()
        # PHP guest pending: runner message; bootstrap may finalize first
        # (state pending or finalized both prove the gate, not the jobs).
        set_mod_cron_config("1", "testhash42")
        set_pending()
        set_setting("last_cron_exec", fmt(dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=3600)))
        pre_last = setting("last_cron_exec")
        st, env = call(op, tok, PHP_DEV, "guest", "cron", "run", {"hash": "testhash42"})
        check("2 PHP guest pending -> 503 + RUNNER message",
              st == 503 and (env.get("error") or {}).get("code") == 503 and
              (env.get("error") or {}).get("message") == RUN_MSG, str(env)[:200])
        check("2 PHP guest pending -> no jobs (last untouched)",
              setting("last_cron_exec") == pre_last)
        restore()
        assert wait_php_up(), "PHP still 503 after guest-gate restore"
        tok, tok_ts = relogin()

        # ================= §3 guest throttle + config source =================
        def guest_throttle_section(label, base, opener, token):
            set_mod_cron_config("1", "testhash42")

            def set_last(v):
                set_setting("last_cron_exec", v)
                st2, info2 = call(op, cur_tok["php"], PHP_DEV, "admin", "cron", "info")
                assert info2.get("result", {}).get("last_cron_exec") == v, str(info2)[:200]

            now = dt.datetime.now(dt.timezone.utc)
            set_last(fmt(now - dt.timedelta(seconds=30)))
            st, env = call(opener, token, base, "guest", "cron", "run", {"hash": "testhash42"})
            check(f"3 {label} throttled (30s) -> false, last untouched",
                  env.get("result") is False and setting("last_cron_exec") == fmt(now - dt.timedelta(seconds=30)),
                  str(env)[:200])
            # NOTE: no literal 60s check — a stored T-60 value ages past
            # 60.000s during the probe itself (PHP compares microsecond
            # DateTimes), so 30s/61s bracket the boundary instead.
            set_last(fmt(now - dt.timedelta(seconds=61)))
            st, env = call(opener, token, base, "guest", "cron", "run", {"hash": "testhash42"})
            check(f"3 {label} unthrottled (61s) -> true + last updated",
                  env.get("result") is True and setting("last_cron_exec") != fmt(now - dt.timedelta(seconds=61)),
                  str(env)[:200])
            restore()
            tok2, tok_ts2 = relogin()
            set_mod_cron_config("1", "testhash42")
            st, env = call(opener, tok2 if base == PHP_DEV else tok_ts2, base, "guest", "cron", "run", {"hash": "wronghash"})
            check(f"3 {label} wrong hash -> 403 permission",
                  (env.get("error") or {}).get("code") == 403 and
                  (env.get("error") or {}).get("message") == "You do not have permission to perform this action",
                  str(env)[:200])
            set_mod_cron_config("1", "")
            st, env = call(opener, tok2 if base == PHP_DEV else tok_ts2, base, "guest", "cron", "run", {"hash": "anything"})
            check(f"3 {label} enabled + empty hash -> DISTINCT 403",
                  (env.get("error") or {}).get("code") == 403 and
                  (env.get("error") or {}).get("message") == "Guest cron is enabled but no security hash has been configured",
                  str(env)[:200])
            set_mod_cron_config("0", "testhash42")
            st, env = call(opener, tok2 if base == PHP_DEV else tok_ts2, base, "guest", "cron", "run", {"hash": "testhash42"})
            check(f"3 {label} disabled -> 403 permission",
                  (env.get("error") or {}).get("code") == 403 and
                  (env.get("error") or {}).get("message") == "You do not have permission to perform this action",
                  str(env)[:200])
            set_mod_cron_config("1", "testhash42")
            exec_sql("DELETE FROM setting WHERE param = 'last_cron_exec'")
            clear_php_app_cache()
            st, env = call(opener, tok2 if base == PHP_DEV else tok_ts2, base, "guest", "cron", "run", {"hash": "testhash42"})
            check(f"3 {label} last null -> runs + last set",
                  env.get("result") is True and setting("last_cron_exec") is not None, str(env)[:200])
            return tok2, tok_ts2

        tok, tok_ts = guest_throttle_section("PHP", PHP_DEV, op, tok)
        restore()
        tok, tok_ts = relogin()
        tok, tok_ts = guest_throttle_section("TS", TS, op_ts, tok_ts)
        restore()
        tok, tok_ts = relogin()

        # ================= §4 clearOldSessions =================
        def sessions_section(label, base, opener, token, full_run):
            sess_cols = [r["name"] for r in q("PRAGMA table_info(session)")]
            live_row = q1("SELECT * FROM session ORDER BY rowid DESC LIMIT 1")

            def mk_session(sid, lifetime, created_at):
                row = dict(live_row)
                row["id"] = sid
                row["lifetime"] = lifetime
                row["created_at"] = created_at
                d2 = sqlite3.connect(DBP)
                d2.execute(f"INSERT INTO session ({','.join(sess_cols)}) VALUES ({','.join('?' * len(sess_cols))})",
                           tuple(row[c] for c in sess_cols))
                d2.commit()
                d2.close()

            now_ts = int(time.time())
            s1 = uuid.uuid4().hex
            s2 = uuid.uuid4().hex
            s3 = uuid.uuid4().hex
            mk_session(s1, now_ts - 100, now_ts - 100)
            mk_session(s2, now_ts + 3600, now_ts - 8000)
            mk_session(s3, now_ts + 3600, now_ts - 100)
            if full_run:
                set_mock_email_config()
            st, env = call(opener, token, base, "admin", "cron", "run")
            check(f"4 {label} expired-lifetime session deleted",
                  q1("SELECT COUNT(*) c FROM session WHERE id = ?", (s1,))["c"] == 0)
            check(f"4 {label} expired-created_at session deleted",
                  q1("SELECT COUNT(*) c FROM session WHERE id = ?", (s2,))["c"] == 0)
            check(f"4 {label} live session kept",
                  q1("SELECT COUNT(*) c FROM session WHERE id = ?", (s3,))["c"] == 1)
            st2, env2 = call(opener, token, base, "admin", "cron", "info")
            check(f"4 {label} login session survived purge (info still answers)",
                  env2.get("error") is None, str(env2)[:200])

        sessions_section("PHP", PHP_DEV, op, tok, False)
        restore()
        tok, tok_ts = relogin()
        sessions_section("TS", TS, op_ts, tok_ts, True)
        restore()
        tok, tok_ts = relogin()

        # ================= §5 generate =================
        def generate_section(label, base, opener, token):
            def mk_order(expires, price=25.0, option="issue-invoice", period="1M", product_id=6):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO client_order (client_id, product_id, title, status, invoice_option, period,"
                    " price, quantity, currency, expires_at, created_at, updated_at)"
                    " VALUES (1, ?, 'Crafted', 'active', ?, ?, ?, 1, 'USD', ?, datetime('now'), datetime('now'))",
                    (product_id, option, period, price, expires))
                oid = cur.lastrowid
                d2.commit()
                d2.close()
                return oid

            def mk_draft_invoice(issued=0):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate,"
                    " created_at, updated_at) VALUES (1, 'FOSS', NULL, ?, 'USD',"
                    " 'unpaid', ?, '0', datetime('now'), datetime('now'))",
                    ('crafted' + uuid.uuid4().hex, issued))
                iid = cur.lastrowid
                d2.commit()
                d2.close()
                return iid

            now = dt.datetime.now(dt.timezone.utc)
            f = lambda d: fmt(d)
            o_single = mk_order(f(now + dt.timedelta(days=5)))
            o_neg = mk_order(f(now + dt.timedelta(days=5)), price=-10.0)
            o_far = mk_order(f(now + dt.timedelta(days=30)))
            o_under = mk_order(f(now + dt.timedelta(days=5)), option="issue_invoice")
            o_cancelmeta = mk_order(f(now + dt.timedelta(days=5)))
            exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                     " VALUES (?, 'cancel_at_period_end', '1', datetime('now'), datetime('now'))", (o_cancelmeta,))
            o_m1 = mk_order(f(now + dt.timedelta(days=5)))
            o_m2 = mk_order(f(now + dt.timedelta(days=5)))
            for oid in (o_m1, o_m2):
                exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                         " VALUES (?, 'merge_renewals', '1', datetime('now'), datetime('now'))", (oid,))
            o_nm1 = mk_order(f(now + dt.timedelta(days=6)))
            o_nm2 = mk_order(f(now + dt.timedelta(days=6)))
            o_reuse = mk_order(f(now + dt.timedelta(days=5)))
            draft = mk_draft_invoice()
            exec_sql("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = ?", (draft, o_reuse))
            o_paidlink = mk_order(f(now + dt.timedelta(days=5)))
            paid_link_inv = mk_draft_invoice(issued=1)
            exec_sql("UPDATE invoice SET status = 'paid', paid_at = datetime('now') WHERE id = ?", (paid_link_inv,))
            exec_sql("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = ?", (paid_link_inv, o_paidlink))
            o_pend = mk_order(f(now + dt.timedelta(days=5)))
            paid_inv = mk_draft_invoice(issued=1)
            exec_sql("UPDATE invoice SET status = 'paid', paid_at = datetime('now') WHERE id = ?", (paid_inv,))
            exec_sql("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity,"
                     " price, taxed) VALUES (?, 'order', ?, 'renew', 'pending_payment', 'Renew', '1M', 1, 25.0, 1)",
                     (paid_inv, o_pend))
            pre_inv = q1("SELECT COUNT(*) c FROM invoice")["c"]
            st, env = call(opener, token, base, "admin", "invoice", "batch_generate")

            def inv_for_order(oid):
                r = q1("SELECT unpaid_invoice_id FROM client_order WHERE id = ?", (oid,))
                return r["unpaid_invoice_id"] if r else None

            def inv_row(iid):
                return q1("SELECT id, status, issued, nr, serie, due_at, currency FROM invoice WHERE id = ?", (iid,))

            single = inv_row(inv_for_order(o_single))
            merge_id = inv_for_order(o_m1)
            merge_lines = q("SELECT type, rel_id, task, status, price FROM invoice_item WHERE invoice_id = ? ORDER BY id",
                            (merge_id,)) if merge_id else []
            single_events = q("SELECT type, client_id FROM invoice_event WHERE invoice_id = ? ORDER BY id",
                              (single["id"],)) if single else []
            check(f"5 {label} generate true", env.get("result") is True, str(env)[:200])
            check(f"5 {label} invoice count +5 (single 1, merge 1, nonmerge 2, paidlink 1)",
                  q1("SELECT COUNT(*) c FROM invoice")["c"] - pre_inv == 5,
                  f"{pre_inv} -> {q1('SELECT COUNT(*) c FROM invoice')['c']}")
            check(f"5 {label} single issued+nr+due=expires+serie+currency",
                  single and single["issued"] == 1 and single["nr"] is not None and
                  single["due_at"] == f(now + dt.timedelta(days=5)) and single["serie"] == "FOSS" and
                  single["currency"] == "USD", str(single))
            single_lines = q("SELECT type, rel_id, task, status, price FROM invoice_item WHERE invoice_id = ?",
                             (single["id"],)) if single else []
            check(f"5 {label} single renew line exact",
                  len(single_lines) == 1 and single_lines[0]["type"] == "order" and
                  str(single_lines[0]["rel_id"]) == str(o_single) and single_lines[0]["task"] == "renew" and
                  single_lines[0]["status"] == "pending_payment" and float(single_lines[0]["price"]) == 25.0,
                  str(single_lines))
            check(f"5 {label} single CREATED+ISSUED journal events with client_id",
                  [e["type"] for e in single_events] == ["created", "issued"] and
                  all(e["client_id"] == 1 for e in single_events), str(single_events))
            check(f"5 {label} negative skipped", inv_for_order(o_neg) is None)
            check(f"5 {label} far excluded", inv_for_order(o_far) is None)
            check(f"5 {label} underscore option excluded", inv_for_order(o_under) is None)
            check(f"5 {label} cancel-meta excluded", inv_for_order(o_cancelmeta) is None)
            check(f"5 {label} merge pair one invoice, two lines",
                  merge_id is not None and inv_for_order(o_m2) == merge_id and len(merge_lines) == 2 and
                  sorted([str(l["rel_id"]) for l in merge_lines]) == sorted([str(o_m1), str(o_m2)]) and
                  all(l["task"] == "renew" for l in merge_lines), str(merge_lines))
            check(f"5 {label} nonmerge separate invoices",
                  inv_for_order(o_nm1) is not None and inv_for_order(o_nm2) is not None and
                  inv_for_order(o_nm1) != inv_for_order(o_nm2))
            draft_row = inv_row(draft)
            check(f"5 {label} unpaid-linked EXCLUDED, draft untouched",
                  inv_for_order(o_reuse) == draft and draft_row["issued"] == 0 and draft_row["nr"] is None,
                  str(draft_row))
            paidlink_row = inv_row(inv_for_order(o_paidlink)) if inv_for_order(o_paidlink) else None
            check(f"5 {label} paid-linked qualifies, NEW issued invoice stamped",
                  paidlink_row is not None and paidlink_row["id"] != paid_link_inv and paidlink_row["issued"] == 1,
                  str(paidlink_row))
            check(f"5 {label} pending paid-renew excluded", inv_for_order(o_pend) is None)

        generate_section("PHP", PHP_DEV, op, tok)
        restore()
        tok, tok_ts = relogin()
        generate_section("TS", TS, op_ts, tok_ts)
        restore()
        tok, tok_ts = relogin()

        # ================= §6 invoke-due + send-reminders fallback =================
        def invoke_section(label, base, opener, token):
            def mk_invoice(due, issued=1, status="unpaid", reminded_at=None):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate,"
                    " due_at, reminded_at, created_at, updated_at)"
                    " VALUES (1, 'FOSS', NULL, ?, 'USD', ?, ?, '0', ?, ?,"
                    " datetime('now'), datetime('now'))",
                    ('due' + uuid.uuid4().hex, status, issued, due, reminded_at))
                iid = cur.lastrowid
                d2.commit()
                d2.close()
                return iid

            def reminded(iid):
                r = q1("SELECT reminded_at FROM invoice WHERE id = ?", (iid,))
                return r["reminded_at"] if r else None

            def reminder_events(iid):
                return q("SELECT type, client_id FROM invoice_event WHERE invoice_id = ? AND type = 'reminder'", (iid,))

            now = dt.datetime.now(dt.timezone.utc)
            today = now.strftime("%Y-%m-%d")
            day = lambda n: fmt(now + dt.timedelta(days=n))
            set_setting("invoice_reminder_before_due_days", "7")
            set_setting("invoice_reminder_after_due_days", "5")
            set_setting("invoice_reminder_send_time", "")
            set_setting("invoice_overdue_invoked", "2026-10-24 05:31:25")
            d1 = mk_invoice(day(-5))
            d2i = mk_invoice(day(-3))
            d3 = mk_invoice(day(7))
            d4 = mk_invoice(day(3))
            d5 = mk_invoice(day(-5), reminded_at=today + " 01:00:00")
            d6 = mk_invoice(day(-5), status="paid")
            pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
            st, env = call(opener, token, base, "admin", "invoice", "batch_invoke_due_event")
            new_q = q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))
            # Before-list fires first, so the first new row is D3's
            # (payment reminder) and the second is D1's (due-after).
            new_q_subjects = [r["subject"] for r in
                              q("SELECT subject FROM email_queue WHERE id > ? ORDER BY id", (pre_qmax,))]
            gate_after_first = setting("invoice_overdue_invoked")
            check(f"6 {label} first invoke true", env.get("result") is True, str(env)[:200])
            check(f"6 {label} D1 (overdue 5d, AFTER path) sent + reminded, NO journal event",
                  reminded(d1) is not None and len(reminder_events(d1)) == 0, str(reminded(d1)))
            check(f"6 {label} D2 (overdue 3d) not sent", reminded(d2i) is None)
            check(f"6 {label} D3 (due +7d, BEFORE path) sent + reminded + REMINDER event",
                  reminded(d3) is not None and len(reminder_events(d3)) == 1 and
                  reminder_events(d3)[0]["client_id"] == 1, str(reminded(d3)))
            check(f"6 {label} before/after templates split (Payment Reminder, then Invoice Due)",
                  len(new_q_subjects) == 2 and "Payment Reminder" in (new_q_subjects[0] or "") and
                  "Invoice Due" in (new_q_subjects[1] or ""), str(new_q_subjects))
            check(f"6 {label} D4 (due +3d) not sent", reminded(d4) is None)
            check(f"6 {label} D5 (already claimed today) not re-sent", reminded(d5) == today + " 01:00:00")
            check(f"6 {label} D6 (paid) untouched",
                  q1("SELECT status FROM invoice WHERE id = ?", (d6,))["status"] == "paid" and reminded(d6) is None)
            check(f"6 {label} exactly 2 sends", len(new_q) == 2, f"new queue rows: {len(new_q)}")
            st, env = call(opener, token, base, "admin", "invoice", "batch_invoke_due_event")
            check(f"6 {label} second call same day -> false, gate unchanged, no new rows",
                  env.get("result") is False and setting("invoice_overdue_invoked") == gate_after_first and
                  len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))) == len(new_q),
                  str(env)[:200])
            # send_reminders fallback: gate already set -> fire WITHOUT
            # updating the gate.
            d7 = mk_invoice(day(-5))
            gate_before = setting("invoice_overdue_invoked")
            pre_qmax2 = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
            st, env = call(opener, token, base, "admin", "invoice", "batch_send_reminders")
            d7_subjects = [r["subject"] for r in
                           q("SELECT subject FROM email_queue WHERE id > ? ORDER BY id", (pre_qmax2,))]
            check(f"6 {label} send_reminders with gate set -> true, gate UNCHANGED, D7 sent (Invoice Due)",
                  env.get("result") is True and setting("invoice_overdue_invoked") == gate_before and
                  reminded(d7) is not None and
                  len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax2,))) == 1 and
                  len(d7_subjects) == 1 and "Invoice Due" in (d7_subjects[0] or ""),
                  str(env)[:200] + str(d7_subjects))
            # send-time deferral: future send_time -> run true, 0 sends,
            # 0 claims, gate STILL updated.
            future_hm = fmt(now + dt.timedelta(hours=2))[11:16]
            if future_hm < fmt(now)[11:16]:
                future_hm = "23:59"  # +2h wrapped past midnight; use end-of-day instead
            set_setting("invoice_overdue_invoked", "2026-10-24 05:31:25")
            set_setting("invoice_reminder_send_time", future_hm)
            d8 = mk_invoice(day(-5))
            pre_qmax3 = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
            st, env = call(opener, token, base, "admin", "invoice", "batch_invoke_due_event")
            check(f"6 {label} future send_time -> true, 0 sends, 0 claims, gate updated",
                  env.get("result") is True and
                  len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax3,))) == 0 and
                  reminded(d8) is None and setting("invoice_overdue_invoked") != "2026-10-24 05:31:25",
                  str(env)[:200])

        invoke_section("PHP", PHP_DEV, op, tok)
        restore()
        tok, tok_ts = relogin()
        invoke_section("TS", TS, op_ts, tok_ts)
        restore()
        tok, tok_ts = relogin()

        # ================= §7 suspension warnings =================
        def warnings_section(label, base, opener, token):
            def mk_active_order(expires, grace):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO client_order (client_id, product_id, title, status, invoice_option, period,"
                    " price, quantity, currency, expires_at, suspension_grace_days, created_at, updated_at)"
                    " VALUES (1, 6, 'Crafted', 'active', 'issue-invoice', '1M', 25.0, 1, 'USD', ?, ?,"
                    " datetime('now'), datetime('now'))", (expires, grace))
                oid = cur.lastrowid
                d2.commit()
                d2.close()
                return oid

            def mk_template(content):
                d2 = sqlite3.connect(DBP)
                d2.execute("INSERT INTO email_template (category, enabled, is_custom, is_overridden, subject,"
                           " content, action_code) VALUES ('staff', 1, 1, 0, 'Suspension warning',"
                           " ?, 'mod_order_suspension_warning')", (content,))
                d2.commit()
                d2.close()

            def meta_for(oid):
                r = q1("SELECT value FROM client_order_meta WHERE client_order_id = ? AND name = 'suspension_warning_for'",
                       (oid,))
                return r["value"] if r else None

            now = dt.datetime.now(dt.timezone.utc)
            w1_exp = fmt(now - dt.timedelta(hours=12))
            w1_susp = fmt(now + dt.timedelta(hours=12))
            w1 = mk_active_order(w1_exp, 1)
            w2 = mk_active_order(w1_exp, 1)
            exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                     " VALUES (?, 'suspension_warning_for', ?, datetime('now'), datetime('now'))", (w2, w1_susp))
            w3 = mk_active_order(fmt(now + dt.timedelta(days=5)), 1)
            w4 = mk_active_order(w1_exp, 0)
            mk_template("Order {{ order.id }} suspension {{ order.suspension_at }}")
            pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
            st, env = call(opener, token, base, "admin", "order", "batch_send_suspension_warnings")
            new_q = q("SELECT subject, content, recipient FROM email_queue WHERE id > ?", (pre_qmax,))
            check(f"7 {label} warnings true", env.get("result") is True, str(env)[:200])
            check(f"7 {label} W1 claim created", meta_for(w1) == w1_susp, str(meta_for(w1)))
            check(f"7 {label} W1 queued with rendered suspension_at",
                  len(new_q) == 1 and w1_susp in (new_q[0]["content"] or "") and
                  str(w1) in (new_q[0]["content"] or ""), str(new_q))
            check(f"7 {label} W2 already claimed skipped", meta_for(w2) == w1_susp and len(new_q) == 1)
            check(f"7 {label} W3/W4 not due, no claims", meta_for(w3) is None and meta_for(w4) is None)
            # Release case: broken template -> claim released, no queue.
            restore()
            tok2, tok_ts2 = relogin()
            w5 = mk_active_order(w1_exp, 1)
            mk_template("Order {{ order.id ")
            pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
            st, env = call(opener, tok2 if base == PHP_DEV else tok_ts2, base, "admin", "order",
                           "batch_send_suspension_warnings")
            check(f"7 {label} broken template -> task still true",
                  env.get("result") is True, str(env)[:200])
            check(f"7 {label} broken template -> claim RELEASED, no queue row",
                  meta_for(w5) is None and
                  len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))) == 0)
            return tok2, tok_ts2

        tok, tok_ts = warnings_section("PHP", PHP_DEV, op, tok)
        restore()
        tok, tok_ts = relogin()
        tok, tok_ts = warnings_section("TS", TS, op_ts, tok_ts)
        restore()
        tok, tok_ts = relogin()

        # ================= §8 pay_with_credits (full runner) =================
        # Item execution + order-1 state are NOT asserted here: PHP
        # tryPayWithCredits executes item tasks immediately while TS
        # defers to activate_paid (pinned divergence). Invoice status
        # + balance rows are the asserted surface.
        def pay_section(label, base, opener, token, full_run):
            def mk_pay_invoice(client_id, items, issued=1):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate,"
                    " created_at, updated_at) VALUES (?, 'FOSS', NULL, ?, 'USD',"
                    " 'unpaid', ?, '0', datetime('now'), datetime('now'))", (client_id, 'pay' + uuid.uuid4().hex, issued))
                iid = cur.lastrowid
                for typ, price in items:
                    d2.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period,"
                               " quantity, price, taxed) VALUES (?, ?, '1', 'activate', 'pending_payment', 'Item',"
                               " '1M', 1, ?, 0)", (iid, typ, price))
                d2.commit()
                d2.close()
                return iid

            def add_balance(client_id, amount):
                exec_sql("INSERT INTO client_balance (client_id, type, rel_id, amount, description, created_at,"
                         " updated_at) VALUES (?, 'funds', NULL, ?, 'crafted', datetime('now'), datetime('now'))",
                         (client_id, amount))

            def inv_status(iid):
                r = q1("SELECT status FROM invoice WHERE id = ?", (iid,))
                return r["status"] if r else "GONE"

            p1 = mk_pay_invoice(2, [("order", 50.0)])
            add_balance(2, 60.0)
            p2 = mk_pay_invoice(2, [("order", 40.0), ("order", 40.0)])
            p3 = mk_pay_invoice(2, [("order", 0.0)])
            p4 = mk_pay_invoice(2, [("order", 50.0)], issued=0)
            p5 = mk_pay_invoice(2, [("deposit", 50.0)])
            px = mk_pay_invoice(3, [("order", 50.0)])
            py = mk_pay_invoice(3, [("order", 50.0)])
            add_balance(3, 60.0)
            if full_run:
                set_mock_email_config()
            st, env = call(opener, token, base, "admin", "cron", "run")
            bal2 = [r["amount"] for r in q("SELECT amount FROM client_balance WHERE client_id = 2 ORDER BY id")]
            bal3 = [r["amount"] for r in q("SELECT amount FROM client_balance WHERE client_id = 3 ORDER BY id")]
            check(f"8 {label} full run true", env.get("result") is True, str(env)[:200])
            check(f"8 {label} P1 paid", inv_status(p1) == "paid", inv_status(p1))
            check(f"8 {label} P2 insufficient sum skipped", inv_status(p2) == "unpaid", inv_status(p2))
            check(f"8 {label} P3 zero paid", inv_status(p3) == "paid", inv_status(p3))
            check(f"8 {label} P4 unissued untouched", inv_status(p4) == "unpaid", inv_status(p4))
            check(f"8 {label} P5 deposit-only excluded", inv_status(p5) == "unpaid", inv_status(p5))
            check(f"8 {label} ASC order: lower id paid, higher skipped",
                  inv_status(px) == "paid" and inv_status(py) == "unpaid",
                  f"px={inv_status(px)} py={inv_status(py)}")
            check(f"8 {label} balance rows exact (60 then -50, no row for $0)",
                  bal2 == [60.0, -50.0] and bal3 == [60.0, -50.0], f"bal2={bal2} bal3={bal3}")

        pay_section("PHP", PHP_DEV, op, tok, False)
        restore()
        tok, tok_ts = relogin()
        pay_section("TS", TS, op_ts, tok_ts, True)
        restore()
        tok, tok_ts = relogin()

        # ================= §9 jobs: suspend / cancel / activate / cart / tickets / pw =================
        def mk_service_custom(client_id=1):
            d2 = sqlite3.connect(DBP)
            cur = d2.execute("INSERT INTO service_custom (client_id, config, created_at, updated_at)"
                             " VALUES (?, '{\"period\":\"1M\"}', datetime('now'), datetime('now'))", (client_id,))
            sid = cur.lastrowid
            d2.commit()
            d2.close()
            return sid

        def mk_job_order(status, expires=None, grace=None, service_type="custom", service_id=None,
                         suspended_at=None, created=None):
            d2 = sqlite3.connect(DBP)
            cur = d2.execute(
                "INSERT INTO client_order (client_id, product_id, title, status, invoice_option, period,"
                " price, quantity, currency, expires_at, suspension_grace_days, service_type, service_id,"
                " suspended_at, created_at, updated_at)"
                " VALUES (1, 6, 'Crafted', ?, 'issue-invoice', '1M', 25.0, 1, 'USD', ?, ?, ?, ?, ?, ?, datetime('now'))",
                (status, expires, grace, service_type, service_id, suspended_at,
                 created or fmt(dt.datetime.now(dt.timezone.utc))))
            oid = cur.lastrowid
            d2.commit()
            d2.close()
            return oid

        def order_row(oid):
            return q1("SELECT status, reason, suspended_at, canceled_at, expires_at FROM client_order WHERE id = ?", (oid,))

        def order_notes(oid):
            return q("SELECT status, notes FROM client_order_status WHERE client_order_id = ? ORDER BY id", (oid,))

        def jobs_section(label, base, opener, token):
            now = dt.datetime.now(dt.timezone.utc)
            # --- suspend_expired, with config reason ---
            set_mod_config("mod_order", {"batch_suspend_reason": "Test reason"})
            svc1 = mk_service_custom()
            svc2 = mk_service_custom()
            s1 = mk_job_order("active", expires=fmt(now - dt.timedelta(days=10)), service_id=svc1)
            s2 = mk_job_order("active", expires=fmt(now - dt.timedelta(days=2)), grace=5, service_id=svc2)
            st, env = call(opener, token, base, "admin", "order", "batch_suspend_expired")
            r1 = order_row(s1)
            check(f"9 {label} suspend: expired suspended with config reason",
                  r1["status"] == "suspended" and r1["reason"] == "Test reason" and r1["suspended_at"] is not None,
                  str(r1))
            check(f"9 {label} suspend: note format 'Order suspended for <reason>'",
                  any(n["notes"] == "Order suspended for Test reason" for n in order_notes(s1)), str(order_notes(s1)))
            check(f"9 {label} suspend: grace saves not-yet-due order",
                  order_row(s2)["status"] == "active")
            restore()
            tok2, tok_ts2 = relogin()
            # --- suspend_expired, default reason ---
            svc3 = mk_service_custom()
            s3 = mk_job_order("active", expires=fmt(now - dt.timedelta(days=10)), service_id=svc3)
            st, env = call(opener, tok2 if base == PHP_DEV else tok_ts2, base, "admin", "order", "batch_suspend_expired")
            r3 = order_row(s3)
            check(f"9 {label} suspend: default reason 'Non-payment'",
                  r3["status"] == "suspended" and r3["reason"] == "Non-payment", str(r3))
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # --- cancel_suspended GATE (no config) ---
            svc4 = mk_service_custom()
            c_gate = mk_job_order("suspended", suspended_at=fmt(now - dt.timedelta(days=30)), service_id=svc4)
            st, env = call(opener, t2, base, "admin", "order", "batch_cancel_suspended")
            check(f"9 {label} cancel_suspended gate: disabled -> false, no cancels",
                  env.get("result") is False and order_row(c_gate)["status"] == "suspended", str(env)[:200])
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # --- cancel_suspended ENABLED ---
            set_mod_config("mod_order", {"batch_cancel_suspended": "1",
                                         "batch_cancel_suspended_after_days": "7",
                                         "batch_cancel_suspended_reason": "Too long"})
            svc5 = mk_service_custom()
            svc6 = mk_service_custom()
            c1 = mk_job_order("suspended", suspended_at=fmt(now - dt.timedelta(days=10)), service_id=svc5)
            c2 = mk_job_order("suspended", suspended_at=fmt(now - dt.timedelta(days=2)), service_id=svc6)
            exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                     " VALUES (?, 'cancel_at_period_end', '1', datetime('now'), datetime('now'))", (c1,))
            st, env = call(opener, t2, base, "admin", "order", "batch_cancel_suspended")
            rc1 = order_row(c1)
            check(f"9 {label} cancel_suspended enabled -> true + old canceled fully",
                  env.get("result") is True and rc1["status"] == "canceled" and rc1["reason"] == "Too long" and
                  rc1["canceled_at"] is not None and rc1["expires_at"] is None and rc1["suspended_at"] is None,
                  str(rc1))
            check(f"9 {label} cancel_suspended: cancel_at_period_end meta deleted",
                  q1("SELECT COUNT(*) c FROM client_order_meta WHERE client_order_id = ? AND name = 'cancel_at_period_end'",
                     (c1,))["c"] == 0)
            check(f"9 {label} cancel_suspended: note 'Canceled order for <reason>'",
                  any(n["notes"] == "Canceled order for Too long" for n in order_notes(c1)), str(order_notes(c1)))
            check(f"9 {label} cancel_suspended: recent suspended kept",
                  order_row(c2)["status"] == "suspended")
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # --- cancel_unpaid GATE only (enabled path is a pinned divergence) ---
            u1 = mk_job_order("pending_setup", created=fmt(now - dt.timedelta(days=30)))
            st, env = call(opener, t2, base, "admin", "order", "batch_cancel_unpaid")
            check(f"9 {label} cancel_unpaid gate: disabled -> false, stale pending_setup untouched",
                  env.get("result") is False and order_row(u1)["status"] == "pending_setup", str(env)[:200])
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # --- cart_expire ---
            d2 = sqlite3.connect(DBP)
            cur = d2.execute("INSERT INTO cart (session_id, created_at, updated_at) VALUES ('guest:old', ?, ?)",
                             (fmt(now - dt.timedelta(days=10)), fmt(now - dt.timedelta(days=10))))
            cart_old = cur.lastrowid
            d2.execute("INSERT INTO cart_product (cart_id) VALUES (?)", (cart_old,))
            cur = d2.execute("INSERT INTO cart (session_id, created_at, updated_at) VALUES ('staff:abc', ?, ?)",
                             (fmt(now - dt.timedelta(days=10)), fmt(now - dt.timedelta(days=10))))
            cart_staff = cur.lastrowid
            cur = d2.execute("INSERT INTO cart (session_id, created_at, updated_at) VALUES ('guest:new', ?, ?)",
                             (fmt(now - dt.timedelta(days=1)), fmt(now - dt.timedelta(days=1))))
            cart_fresh = cur.lastrowid
            d2.commit()
            d2.close()
            st, env = call(opener, t2, base, "admin", "cart", "batch_expire")
            check(f"9 {label} cart: old non-staff deleted with products, staff+fresh kept",
                  env.get("result") is True and
                  q1("SELECT COUNT(*) c FROM cart WHERE id = ?", (cart_old,))["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM cart_product WHERE cart_id = ?", (cart_old,))["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM cart WHERE id = ?", (cart_staff,))["c"] == 1 and
                  q1("SELECT COUNT(*) c FROM cart WHERE id = ?", (cart_fresh,))["c"] == 1, str(env)[:200])
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # --- ticket auto_close ---
            d2 = sqlite3.connect(DBP)
            cur = d2.execute("INSERT INTO support_ticket (client_id, subject, status, support_helpdesk_id, created_at, updated_at)"
                             " VALUES (1, 'old hold', 'on_hold', 1, ?, ?)",
                             (fmt(now - dt.timedelta(hours=30)), fmt(now - dt.timedelta(hours=30))))
            tick_old = cur.lastrowid
            cur = d2.execute("INSERT INTO support_ticket (client_id, subject, status, support_helpdesk_id, created_at, updated_at)"
                             " VALUES (1, 'fresh hold', 'on_hold', 1, ?, ?)",
                             (fmt(now - dt.timedelta(hours=1)), fmt(now - dt.timedelta(hours=1))))
            tick_fresh = cur.lastrowid
            d2.commit()
            d2.close()
            st, env = call(opener, t2, base, "admin", "support", "batch_ticket_auto_close")
            check(f"9 {label} auto_close: expired on_hold closed (close_after 24), fresh kept",
                  env.get("result") is True and
                  q1("SELECT status FROM support_ticket WHERE id = ?", (tick_old,))["status"] == "closed" and
                  q1("SELECT status FROM support_ticket WHERE id = ?", (tick_fresh,))["status"] == "on_hold",
                  str(env)[:200])
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # --- expire_password_reminders (2h job) ---
            d2 = sqlite3.connect(DBP)
            d2.execute("INSERT INTO client_password_reset (client_id, hash, created_at, ip) VALUES (1, 'old3h', ?, '')",
                       (fmt(now - dt.timedelta(hours=3)),))
            d2.execute("INSERT INTO client_password_reset (client_id, hash, created_at, ip) VALUES (1, 'fresh30m', ?, '')",
                       (fmt(now - dt.timedelta(minutes=30)),))
            d2.commit()
            d2.close()
            st, env = call(opener, t2, base, "admin", "client", "batch_expire_password_reminders")
            check(f"9 {label} expire_pw: 3h deleted, 30min kept",
                  env.get("result") is True and
                  q1("SELECT COUNT(*) c FROM client_password_reset WHERE hash = 'old3h'")["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM client_password_reset WHERE hash = 'fresh30m'")["c"] == 1,
                  str(env)[:200])
            restore()
            tok2, tok_ts2 = relogin()
            return tok2, tok_ts2

        tok, tok_ts = jobs_section("PHP", PHP_DEV, op, tok)
        restore()
        tok, tok_ts = relogin()
        tok, tok_ts = jobs_section("TS", TS, op_ts, tok_ts)
        restore()
        tok, tok_ts = relogin()

        # ================= §9b activate (full runner; per-stack divergence for NULL service_type) =================
        def activate_section(label, base, opener, token, full_run):
            def mk_paid_activate(paid_ago_s, service_type="custom", service_id=None):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate, paid_at,"
                    " created_at, updated_at) VALUES (1, 'FOSS', NULL, ?, 'USD', 'paid', 1,"
                    " '0', datetime('now', ?), datetime('now'), datetime('now'))",
                    ('cutoff' + uuid.uuid4().hex, f"-{paid_ago_s} seconds"))
                iid = cur.lastrowid
                cur = d2.execute(
                    "INSERT INTO client_order (client_id, product_id, title, status, invoice_option, period, price,"
                    " quantity, currency, service_type, service_id, created_at, updated_at) VALUES (1, 6, 'Crafted',"
                    " 'pending_setup', 'issue-invoice', '1M', 25.0, 1, 'USD', ?, ?, datetime('now'), datetime('now'))",
                    (service_type, service_id))
                oid = cur.lastrowid
                d2.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity,"
                           " price, taxed) VALUES (?, 'order', ?, 'activate', 'pending_payment', 'Item', '1M', 1, 25.0, 0)",
                           (iid, oid))
                d2.execute("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = ?", (iid, oid))
                d2.commit()
                d2.close()
                return iid, oid

            def item_state(iid):
                r = q1("SELECT status, attempts FROM invoice_item WHERE invoice_id = ? AND task = 'activate'", (iid,))
                return (r["status"], r["attempts"]) if r else (None, None)

            svc_old = mk_service_custom()
            svc_fresh = mk_service_custom()
            old_inv, old_ord = mk_paid_activate(1200, service_id=svc_old)
            fresh_inv, fresh_ord = mk_paid_activate(60, service_id=svc_fresh)
            null_inv, null_ord = mk_paid_activate(1200, service_type=None, service_id=None)
            if full_run:
                set_mock_email_config()
            st, env = call(opener, token, base, "admin", "cron", "run")
            check(f"9b {label} full run true", env.get("result") is True, str(env)[:200])
            check(f"9b {label} old-paid custom ACTIVATED + item executed",
                  q1("SELECT status FROM client_order WHERE id = ?", (old_ord,))["status"] == "active" and
                  item_state(old_inv)[0] == "executed", str(item_state(old_inv)))
            check(f"9b {label} fresh-paid untouched (10-min cutoff)",
                  q1("SELECT status FROM client_order WHERE id = ?", (fresh_ord,))["status"] == "pending_setup" and
                  item_state(fresh_inv) == ("pending_payment", 0), str(item_state(fresh_inv)))
            if label == "PHP":
                notes = order_notes(null_ord)
                check("9b PHP NULL-service_type: attempt failed, stays pending_setup",
                      q1("SELECT status FROM client_order WHERE id = ?", (null_ord,))["status"] == "pending_setup" and
                      item_state(null_inv)[1] == 1, str(item_state(null_inv)))
                check("9b PHP NULL-service_type: note names the missing service class",
                      any("does not have a service class" in (n["notes"] or "") for n in notes), str(notes))
            else:
                check("9b TS NULL-service_type: DIVERGENCE, TS activates where PHP fails",
                      q1("SELECT status FROM client_order WHERE id = ?", (null_ord,))["status"] == "active" and
                      item_state(null_inv)[0] == "executed", str(item_state(null_inv)))

        activate_section("PHP", PHP_DEV, op, tok, False)
        restore()
        tok, tok_ts = relogin()
        activate_section("TS", TS, op_ts, tok_ts, True)
        restore()
        tok, tok_ts = relogin()

        # ================= §10 listeners (full runner) =================
        def listeners_section(label, base, opener, token, full_run):
            def clone_or_craft(table, created_at):
                cols = [r["name"] for r in q(f"PRAGMA table_info({table})")]
                info = q(f"PRAGMA table_info({table})")
                rows = q(f"SELECT * FROM {table} LIMIT 1")
                d2 = sqlite3.connect(DBP)
                if rows:
                    row = dict(rows[0])
                    row["created_at"] = created_at
                    if "id" in row:
                        row["id"] = None
                    cur = d2.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                                     tuple(row[c] for c in cols))
                else:
                    use_cols = []
                    vals = []
                    for c in info:
                        if c["name"] == "id":
                            continue
                        use_cols.append(c["name"])
                        if c["name"] == "created_at":
                            vals.append(created_at)
                        elif c["notnull"] and c["dflt_value"] is None:
                            vals.append(0 if c["type"].upper() in ("INTEGER", "BIGINT") else "")
                        else:
                            vals.append(None)
                    cur = d2.execute(f"INSERT INTO {table} ({','.join(use_cols)}) VALUES ({','.join('?' * len(use_cols))})",
                                     tuple(vals))
                nid = cur.lastrowid
                d2.commit()
                d2.close()
                return nid

            now = dt.datetime.now(dt.timezone.utc)
            old_dt = fmt(now - dt.timedelta(days=100))
            recent_dt = fmt(now - dt.timedelta(days=1))
            a_old = clone_or_craft("activity_admin_history", old_dt)
            a_new = clone_or_craft("activity_admin_history", recent_dt)
            c_old = clone_or_craft("activity_client_history", old_dt)
            s_old = clone_or_craft("activity_system", old_dt)
            e_old = clone_or_craft("activity_client_email", old_dt)
            d2 = sqlite3.connect(DBP)
            d2.execute("INSERT INTO client_password_reset (client_id, hash, created_at, ip) VALUES (1, 'oldreset', ?, '')",
                       (fmt(now - dt.timedelta(seconds=1000)),))
            d2.execute("INSERT INTO client_password_reset (client_id, hash, created_at, ip) VALUES (1, 'freshreset', ?, '')",
                       (fmt(now - dt.timedelta(seconds=100)),))
            d2.commit()
            d2.close()
            if full_run:
                set_mock_email_config()
            st, env = call(opener, token, base, "admin", "cron", "run")
            check(f"10 {label} activity defaults: old deleted, recent kept, email NOT pruned (max_age 0)",
                  env.get("result") is True and
                  q1("SELECT COUNT(*) c FROM activity_admin_history WHERE id = ?", (a_old,))["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM activity_admin_history WHERE id = ?", (a_new,))["c"] == 1 and
                  q1("SELECT COUNT(*) c FROM activity_client_history WHERE id = ?", (c_old,))["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM activity_system WHERE id = ?", (s_old,))["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM activity_client_email WHERE id = ?", (e_old,))["c"] == 1,
                  str(env)[:200])
            check(f"10 {label} 900s prune: old reset deleted, fresh kept (2h job would also delete old)",
                  q1("SELECT COUNT(*) c FROM client_password_reset WHERE hash = 'oldreset'")["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM client_password_reset WHERE hash = 'freshreset'")["c"] == 1)
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # email_max_age 30 prunes old email history
            e_old2 = clone_or_craft("activity_client_email", old_dt)
            set_mod_config("mod_activity", {"max_age": "90", "email_max_age": "30"})
            if full_run:
                set_mock_email_config()
            st, env = call(opener, t2, base, "admin", "cron", "run")
            check(f"10 {label} email_max_age 30 prunes old email history",
                  q1("SELECT COUNT(*) c FROM activity_client_email WHERE id = ?", (e_old2,))["c"] == 0)
            restore()
            tok2, tok_ts2 = relogin()
            t2 = tok2 if base == PHP_DEV else tok_ts2
            # domain sync stale + currency never-gate
            set_setting("servicedomain_last_sync", fmt(now - dt.timedelta(days=40)))
            d2 = sqlite3.connect(DBP)
            d2.execute("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code, created_at, updated_at)"
                       " VALUES (0, 0.9, 0, 'EUR', datetime('now'), datetime('now'))")
            d2.execute("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code, created_at, updated_at)"
                       " VALUES (0, 0.8, 1, 'GBP', datetime('now'), datetime('now'))")
            d2.commit()
            d2.close()
            set_mod_config("mod_currency", {"sync_rate": "never"})
            if full_run:
                set_mock_email_config()
            st, env = call(opener, t2, base, "admin", "cron", "run")
            check(f"10 {label} stale domain sync -> timestamp updated (0 domains)",
                  setting("servicedomain_last_sync") != fmt(now - dt.timedelta(days=40)))
            check(f"10 {label} currency never-gate: EUR/GBP rates untouched, USD still 1.0",
                  float(q1("SELECT conversion_rate FROM currency WHERE code = 'EUR'")["conversion_rate"]) == 0.9 and
                  float(q1("SELECT conversion_rate FROM currency WHERE code = 'GBP'")["conversion_rate"]) == 0.8 and
                  float(q1("SELECT conversion_rate FROM currency WHERE code = 'USD'")["conversion_rate"]) == 1.0)
            restore()
            tok2, tok_ts2 = relogin()
            return tok2, tok_ts2

        tok, tok_ts = listeners_section("PHP", PHP_DEV, op, tok, False)
        restore()
        tok, tok_ts = relogin()
        tok, tok_ts = listeners_section("TS", TS, op_ts, tok_ts, True)
        restore()
        tok, tok_ts = relogin()

        # ================= §11 sendmail via prod oracle + mock =================
        assert start_prod(), "prod oracle :8081 failed to start"
        try:
            set_mock_email_config()
            truncate_mock()
            st, env = call(op, tok, PHP_PROD, "admin", "cron", "run")
            msgs = [m for m in read_mock() if m.get("type") == "accepted"]
            check("11 PHP prod run true + pending 0 + mock delivered",
                  env.get("result") is True and
                  q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 0 and
                  len(msgs) >= 5, f"mock accepted={len(msgs)} env={str(env)[:200]}")
            check("11 PHP prod queue total 62 (only pending deleted)",
                  q1("SELECT COUNT(*) c FROM email_queue")["c"] == 62)
        finally:
            stop_prod()
        restore()
        tok, tok_ts = relogin()
        set_mock_email_config()
        truncate_mock()
        st, env = call(op_ts, tok_ts, TS, "admin", "cron", "run")
        msgs = [m for m in read_mock() if m.get("type") == "accepted"]
        check("11 TS run true + pending 0 + mock delivered",
              env.get("result") is True and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 0 and
              len(msgs) >= 5, f"mock accepted={len(msgs)} env={str(env)[:200]}")
        check("11 TS queue total 62 (only pending deleted)",
              q1("SELECT COUNT(*) c FROM email_queue")["c"] == 62)
        restore()
        tok, tok_ts = relogin()

        # ================= §12 expired-unpaid removal (full runner) =================
        def expired_unpaid_section(label, base, opener, token, full_run):
            def mk_inv(due, issued=1, status="unpaid"):
                d2 = sqlite3.connect(DBP)
                cur = d2.execute(
                    "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate,"
                    " due_at, created_at, updated_at) VALUES (1, 'FOSS', NULL, ?, 'USD', ?, ?, '0', ?,"
                    " datetime('now'), datetime('now'))",
                    ('exp' + uuid.uuid4().hex, status, issued, due))
                iid = cur.lastrowid
                d2.commit()
                d2.close()
                return iid

            now = dt.datetime.now(dt.timezone.utc)
            set_setting("remove_after_days", "30")
            v1 = mk_inv(fmt(now - dt.timedelta(days=40)))
            v2 = mk_inv(fmt(now - dt.timedelta(days=40)), issued=0)
            exec_sql("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity,"
                     " price, taxed) VALUES (?, 'order', '1', 'activate', 'pending_payment', 'Item', '1M', 1, 25.0, 0)",
                     (v2,))
            v3 = mk_inv(fmt(now - dt.timedelta(days=10)))
            v4 = mk_inv(fmt(now - dt.timedelta(days=40)), status="paid")
            if full_run:
                set_mock_email_config()
            st, env = call(opener, token, base, "admin", "cron", "run")
            v1_row = q1("SELECT status, notes FROM invoice WHERE id = ?", (v1,))
            check(f"12 {label} V1 issued old unpaid voided with both notes",
                  v1_row and v1_row["status"] == "canceled" and
                  "Invoice canceled (voided) without replacement." in (v1_row["notes"] or "") and
                  "Expired unpaid — automatically voided after 30 days." in (v1_row["notes"] or ""),
                  str(v1_row))
            check(f"12 {label} V1 CANCELED journal event with reason",
                  len(q("SELECT id FROM invoice_event WHERE invoice_id = ? AND type = 'canceled' AND snapshot LIKE '%Expired unpaid%'",
                        (v1,))) == 1)
            check(f"12 {label} V2 draft hard-deleted with items",
                  q1("SELECT COUNT(*) c FROM invoice WHERE id = ?", (v2,))["c"] == 0 and
                  q1("SELECT COUNT(*) c FROM invoice_item WHERE invoice_id = ?", (v2,))["c"] == 0)
            check(f"12 {label} V3 recent untouched",
                  (q1("SELECT status FROM invoice WHERE id = ?", (v3,)) or {}).get("status") == "unpaid")
            check(f"12 {label} V4 paid untouched",
                  (q1("SELECT status FROM invoice WHERE id = ?", (v4,)) or {}).get("status") == "paid")

        expired_unpaid_section("PHP", PHP_DEV, op, tok, False)
        restore()
        tok, tok_ts = relogin()
        expired_unpaid_section("TS", TS, op_ts, tok_ts, True)
        restore()
        tok, tok_ts = relogin()

        # ================= §13 final invariants =================
        check("13 invoice 323", q1("SELECT COUNT(*) c FROM invoice")["c"] == 323)
        check("13 client_order 11", q1("SELECT COUNT(*) c FROM client_order")["c"] == 11)
        check("13 email_queue 67 (5 pending + 62 sending)",
              q1("SELECT COUNT(*) c FROM email_queue")["c"] == 67 and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 5)
        check("13 extension 6 / meta 3 / setting 38",
              q1("SELECT COUNT(*) c FROM extension")["c"] == 6 and
              q1("SELECT COUNT(*) c FROM extension_meta")["c"] == 3 and
              q1("SELECT COUNT(*) c FROM setting")["c"] == 38)
        check("13 invoice_event 776 / order_meta 0 / email_history 0",
              q1("SELECT COUNT(*) c FROM invoice_event")["c"] == 776 and
              q1("SELECT COUNT(*) c FROM client_order_meta")["c"] == 0 and
              q1("SELECT COUNT(*) c FROM activity_client_email")["c"] == 0)
        check("13 last_cron_exec restored (absent)",
              setting("last_cron_exec") is None)
        check("13 invoice_overdue_invoked restored",
              setting("invoice_overdue_invoked") == "2026-10-24 05:31:25")
        check("13 config hash stable",
              hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)
        check("13 state file complete/0.0.1",
              json.loads(pathlib.Path(STATE).read_text()).get("status") == "complete")
    finally:
        restore()
        stop_prod()
        subprocess.run(["fuser", "-k", "18025/tcp"], capture_output=True)
        mock_proc.terminate()
        try:
            mock_proc.wait(timeout=10)
        except Exception:
            mock_proc.kill()
        # :8081 must be DOWN at batch end (fixture runner binds it).
        subprocess.run(["fuser", "-k", "8081/tcp"], capture_output=True)

    print(f"\n{CHECKS} checks, {len(FAILURES)} failures: {FAILURES}")


if __name__ == "__main__":
    main()
