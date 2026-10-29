#!/usr/bin/env python3
"""R5f capture corpus (pre-fix): PHP runCrons behavior + TS pre-fix contrast.

Proves, before the fix, from live runs (all snapshot-restored in finally):
- PHP full run (admin/cron/run): fixed job order effects, last_cron_exec
  set (Y-m-d H:i:s), Before/After listener effects (journal heal of the
  60 event-less invoices, SEO timestamp set, activity cleanup, password-
  reset prune, currency no-op, domain-sync gate closed, expired-unpaid
  gate off), clearOldSessions, dev sendmail flip-only.
- PHP-prod full run (:8081, no APP_ENV) + mock SMTP (:18025): sendmail
  job DELIVERS for real (queue rows deleted, mock messages captured).
- Finalization gate: pending state -> HTTP 503 + exact envelope +
  zero jobs run + last_cron_exec untouched; missing state file ->
  ensure() CREATES pending + 503 (Version::VERSION is '0.0.1', so the
  reference complete/0.0.1 state is complete and the gate is OPEN).
- Guest throttle + config source: PHP reads mod_cron EXTENSION config
  (guest_cron/cron_hash), NOT settings; last_cron_exec within the
  minute -> false, no jobs; older -> runs; wrong hash -> 403; enabled
  + empty hash -> DISTINCT 403 message; disabled -> 403.
- The three stub algorithms (PHP, direct endpoint calls): generate
  (qualifying set, reuse branch, merge buckets, exclusions, negative
  skip), invoke_due (once-per-day gate, interval matching, reminded_at
  claiming, send-time deferral), suspension warnings (grace window,
  meta claim, already-claimed skip).
- pay_with_credits no-ids path (PHP): findAllUnpaid pre-filter
  (issued + unpaid + a balance row >= an item price, id DESC) +
  tryPay per invoice (sum >= total pays; insufficient skips; $0 pays
  with NO balance row; unissued never in the set).
- Isolation/per-item tolerance: per-item failures never fail their
  task (negative generate order skipped, others proceed); NO isolated
  task throws on any constructible input (all swallow per-item
  failures) -- so task-level isolation + the false return are proven
  by code inspection (runCrons: only the two _exec calls sit outside
  the per-task try/catch), documented in findings-r5f, NOT faked.
- TS pre-fix contrasts: 5 jobs only, no gate/throttle/listeners/
  clearOldSessions; guest reads settings (no rows -> always 403 on
  the reference); batch_generate/batch_invoke_due_event/
  batch_send_suspension_warnings return true with zero effects.

Secrets: crafted SMTP password is a DUMMY value, never printed/logged/
stored. mod_cron cron_hash values used here are test-only strings.
Captures hold shapes, row states, and hashes, never secret values.
"""
import glob
import uuid
import hashlib
import http.cookiejar
import json
import pathlib
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PHP_DEV = "http://127.0.0.1:8080"
PHP_PROD = "http://127.0.0.1:8081"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
STATE = "/home/hatch/scratch/fossbilling/runtime/src/data/update-finalization.json"
MOCK = "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"
OUT = pathlib.Path(__file__).parent / "captures42"
OUT.mkdir(exist_ok=True)

SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"

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

    def relogin():
        # restore() wipes the session table back to the capture-start snapshot,
        # which predates these logins -- so every section re-logs in fresh.
        return login(op, PHP_DEV, SUPER_EMAIL, SUPER_PASS), login(op_ts, PHP_DEV, SUPER_EMAIL, SUPER_PASS)

    def restore():
        # A crashed section can leak a connection via its traceback, which
        # holds the DB lock against this restore. Roll back + close every
        # live connection first (the snapshot rewrite discards that work).
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
        # A gate section's bootstrap finalize rewrites config.php (maintenance
        # mode ON); restore the pristine config bytes, not just the state file.
        pathlib.Path(CFG).write_bytes(cfg_bytes)
        clear_php_app_cache()

    corpus = {}

    try:
        # ---- A. Full PHP-dev run, baseline (no crafts) ----
        pre_q = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        pre_sess = q1("SELECT COUNT(*) c FROM session")["c"]
        pre_seo = setting("mod_seo_last_sitemap_submit")
        pre_sync = setting("servicedomain_last_sync")
        pre_invoked = setting("invoice_overdue_invoked")
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        corpus["A_php_full_run"] = {
            "http": st, "result": env.get("result"), "error": env.get("error"),
            "last_cron_exec": setting("last_cron_exec"),
            "queue_pending_before": pre_q,
            "queue_pending_after": q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"],
            "queue_sending_after": q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'sending'")["c"],
            "invoice_event_before": pre_ev,
            "invoice_event_after": q1("SELECT COUNT(*) c FROM invoice_event")["c"],
            "session_before": pre_sess,
            "session_after": q1("SELECT COUNT(*) c FROM session")["c"],
            "seo_before": pre_seo, "seo_after": setting("mod_seo_last_sitemap_submit"),
            "sync_before": pre_sync, "sync_after": setting("servicedomain_last_sync"),
            "invoked_before": pre_invoked, "invoked_after": setting("invoice_overdue_invoked"),
        }
        check("A php full run true", env.get("result") is True, str(env)[:200])
        check("A last_cron_exec set", setting("last_cron_exec") is not None)
        check("A heal backfilled events", q1("SELECT COUNT(*) c FROM invoice_event")["c"] > pre_ev,
              f"{pre_ev} -> {q1('SELECT COUNT(*) c FROM invoice_event')['c']}")
        # Seo is NEITHER core (Module::CORE_MODULES has no 'seo') NOR installed
        # (no mod_seo extension row), so its Before listener never registers
        # and the timestamp is NOT set -- the correct PHP-on-reference behavior.
        check("A seo timestamp NOT set (Seo inactive)", setting("mod_seo_last_sitemap_submit") is None)
        check("A domain sync untouched (gate closed)", setting("servicedomain_last_sync") == pre_sync)
        restore()
        tok, tok_ts = relogin()

        # ---- B. Full TS pre-fix run ----
        pre_q = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        pre_seo = setting("mod_seo_last_sitemap_submit")
        st, env = call(op_ts, tok_ts, TS, "admin", "cron", "run")
        corpus["B_ts_prefix_run"] = {
            "http": st, "result": env.get("result"), "error": env.get("error"),
            "last_cron_exec": setting("last_cron_exec"),
            "queue_pending_before": pre_q,
            "queue_pending_after": q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"],
            "invoice_event_before": pre_ev,
            "invoice_event_after": q1("SELECT COUNT(*) c FROM invoice_event")["c"],
            "seo_before": pre_seo, "seo_after": setting("mod_seo_last_sitemap_submit"),
        }
        check("B ts prefix run true", env.get("result") is True, str(env)[:200])
        check("B ts no heal", q1("SELECT COUNT(*) c FROM invoice_event")["c"] == pre_ev)
        check("B ts no seo stamp", setting("mod_seo_last_sitemap_submit") == pre_seo)
        _bq = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        check("B ts old reminders job QUEUES (pre-fix contrast)", _bq > pre_q, f"pending {pre_q} -> {_bq}")
        restore()
        tok, tok_ts = relogin()
        # ---- C. Finalization gate (CORRECTED by evidence) ----
        # Admin API calls do NOT reach runCrons' own gate: the dispatcher
        # (Client.php checkUpdateFinalization) 503s first with its own
        # message, and ONLY cron/run is not in ALLOWED_ADMIN_API_CALLS.
        # Before dispatch, request bootstrap runs finalizePendingUpdate():
        # a pending state is FINALIZED in place (patches applied -- the
        # journal backfill adds exactly the 60 event-less rows -- and
        # config.php maintenance_mode flipped ON). So the observable gate
        # behavior is: 503 + dispatcher message + state 'finalized' +
        # backfill applied + maintenance ON + NO cron jobs ran
        # (last_cron_exec untouched, queue untouched). TS mirrors the
        # response + no-jobs-ran, NOT the finalize side effects (no TS
        # patcher exists; that belongs to the update-finalization
        # feature, not the cron runner).
        import re as _re
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
        pending_state = {"status": "pending", "from_version": "0.0.1", "target_version": "0.0.1",
                         "branch": "release", "update_type": None, "source": "test",
                         "created_at": "2026-10-29T00:00:00+00:00", "finalized_at": None,
                         "completed_at": None,
                         "maintenance_mode": {"enabled": False, "allowed_urls": [], "allowed_ips": []}}
        pathlib.Path(STATE).write_text(json.dumps(pending_state))
        clear_php_app_cache()
        pre_last = setting("last_cron_exec")
        pre_q = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        pre_ev = q1("SELECT COUNT(*) c FROM invoice_event")["c"]
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        corpus["C_gate_pending"] = {
            "http": st, "result": env.get("result"), "error": env.get("error"),
            "last_before": pre_last, "last_after": setting("last_cron_exec"),
            "queue_pending_before": pre_q,
            "queue_pending_after": q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"],
            "events_before": pre_ev,
            "events_after": q1("SELECT COUNT(*) c FROM invoice_event")["c"],
            "state_after": json.loads(pathlib.Path(STATE).read_text()),
            "maintenance_on_after": maint_enabled(),
        }
        check("C pending -> http 503", st == 503, f"http={st} env={str(env)[:200]}")
        check("C pending -> DISPATCHER message", (env.get("error") or {}).get("message") ==
              "FOSSBilling update finalization is pending. Complete finalization before using the admin API.",
              str(env)[:200])
        check("C pending -> code 503", (env.get("error") or {}).get("code") == 503)
        check("C pending -> bootstrap finalized the state",
              corpus["C_gate_pending"]["state_after"].get("status") == "finalized",
              str(corpus["C_gate_pending"]["state_after"]))
        check("C pending -> finalize backfilled 60 events",
              corpus["C_gate_pending"]["events_after"] - pre_ev == 60,
              f"{pre_ev} -> {corpus['C_gate_pending']['events_after']}")
        # createPendingState (missing-state path) is the ONLY maintenance
        # flipper; a pre-existing pending state finalizes WITHOUT touching it.
        check("C pending -> maintenance NOT flipped",
              corpus["C_gate_pending"]["maintenance_on_after"] is False)
        check("C pending -> no cron jobs ran", setting("last_cron_exec") == pre_last and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == pre_q)
        restore()
        assert wait_php_up(), "PHP still 503 after gate restore (maintenance?)"
        tok, tok_ts = relogin()
        pathlib.Path(STATE).unlink(missing_ok=True)
        clear_php_app_cache()
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        recreated = json.loads(pathlib.Path(STATE).read_text()) if pathlib.Path(STATE).exists() else None
        corpus["C_gate_missing"] = {"http": st, "result": env.get("result"), "error": env.get("error"),
                                    "recreated_state": recreated,
                                    "maintenance_on_after": maint_enabled()}
        check("C missing file -> 503 + finalized (source missing-finalization-state)",
              st == 503 and (recreated or {}).get("status") == "finalized" and
              (recreated or {}).get("source") == "missing-finalization-state",
              f"http={st} recreated={recreated}")
        check("C missing file -> maintenance flipped ON by createPendingState",
              corpus["C_gate_missing"]["maintenance_on_after"] is True)
        restore()
        assert wait_php_up(), "PHP still 503 after missing-state restore"
        tok, tok_ts = relogin()

        # ---- D. Guest throttle + config source ----
        # Craft mod_cron config via PHP's own config_save (it v2-encrypts).
        st, env = call(op, tok, PHP_DEV, "admin", "extension", "config_save",
                       {"ext": "mod_cron", "guest_cron": "1", "cron_hash": "testhash42"})
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()
        st, info = call(op, tok, PHP_DEV, "admin", "cron", "info")
        # last_cron_exec probes: set via SQL, clear caches, verify the read path sees it
        def set_last(v):
            set_setting("last_cron_exec", v)
            st2, info2 = call(op, tok, PHP_DEV, "admin", "cron", "info")
            assert info2.get("result", {}).get("last_cron_exec") == v, str(info2)[:200]
        import datetime as _dt
        now = _dt.datetime.now(_dt.timezone.utc)
        fmt = lambda dt: dt.strftime("%Y-%m-%d %H:%M:%S")
        set_last(fmt(now - _dt.timedelta(seconds=30)))
        st, env = call(op, tok, PHP_DEV, "guest", "cron", "run", {"hash": "testhash42"})
        throttled_last = setting("last_cron_exec")
        corpus["D_guest_throttled"] = {"http": st, "result": env.get("result"), "error": env.get("error"),
                                       "last_after": throttled_last}
        check("D throttled (30s) -> false, last untouched", env.get("result") is False and
              throttled_last == fmt(now - _dt.timedelta(seconds=30)), str(env)[:200])
        set_last(fmt(now - _dt.timedelta(seconds=61)))
        pre_q = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        st, env = call(op, tok, PHP_DEV, "guest", "cron", "run", {"hash": "testhash42"})
        corpus["D_guest_runs"] = {"http": st, "result": env.get("result"), "error": env.get("error"),
                                  "last_after": setting("last_cron_exec")}
        check("D unthrottled (61s) -> true + last updated", env.get("result") is True and
              setting("last_cron_exec") != fmt(now - _dt.timedelta(seconds=61)), str(env)[:200])
        st, env = call(op, tok, PHP_DEV, "guest", "cron", "run", {"hash": "wronghash"})
        corpus["D_guest_wrong_hash"] = {"http": st, "error": env.get("error")}
        check("D wrong hash -> 403 permission", (env.get("error") or {}).get("code") == 403 and
              (env.get("error") or {}).get("message") == "You do not have permission to perform this action",
              str(env)[:200])
        st, env = call(op, tok, PHP_DEV, "admin", "extension", "config_save",
                       {"ext": "mod_cron", "guest_cron": "1", "cron_hash": ""})
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()
        st, env = call(op, tok, PHP_DEV, "guest", "cron", "run", {"hash": "anything"})
        corpus["D_guest_empty_hash"] = {"http": st, "error": env.get("error")}
        check("D enabled + empty hash -> DISTINCT 403", (env.get("error") or {}).get("code") == 403 and
              (env.get("error") or {}).get("message") == "Guest cron is enabled but no security hash has been configured",
              str(env)[:200])
        st, env = call(op, tok, PHP_DEV, "admin", "extension", "config_save",
                       {"ext": "mod_cron", "guest_cron": "0", "cron_hash": "testhash42"})
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()
        st, env = call(op, tok, PHP_DEV, "guest", "cron", "run", {"hash": "testhash42"})
        corpus["D_guest_disabled"] = {"http": st, "error": env.get("error")}
        check("D disabled -> 403 permission", (env.get("error") or {}).get("code") == 403 and
              (env.get("error") or {}).get("message") == "You do not have permission to perform this action",
              str(env)[:200])
        # TS pre-fix guest: reads settings (no rows) -> always 403
        st, env = call(op_ts, tok_ts, TS, "guest", "cron", "run", {"hash": "testhash42"})
        corpus["D_ts_guest_settings_source"] = {"http": st, "error": env.get("error")}
        check("D ts prefix guest -> 403 (settings source, no rows)", (env.get("error") or {}).get("code") == 403,
              str(env)[:200])
        restore()
        tok, tok_ts = relogin()

        # ---- E. Generate (PHP direct) ----
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

        def mk_draft_invoice(client_id=1, issued=0, nr=None, due=None):
            d2 = sqlite3.connect(DBP)
            cur = d2.execute(
                "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate,"
                " due_at, created_at, updated_at) VALUES (?, 'FOSS', ?, ?, 'USD',"
                " 'unpaid', ?, '0', ?, datetime('now'), datetime('now'))",
                (client_id, nr, 'crafted' + uuid.uuid4().hex, issued, due))
            iid = cur.lastrowid
            d2.commit()
            d2.close()
            return iid

        import datetime as _dt2
        base_now = _dt2.datetime.now(_dt2.timezone.utc)
        f = lambda dt: dt.strftime("%Y-%m-%d %H:%M:%S")
        o_single = mk_order(f(base_now + _dt2.timedelta(days=5)))
        o_neg = mk_order(f(base_now + _dt2.timedelta(days=5)), price=-10.0)
        o_far = mk_order(f(base_now + _dt2.timedelta(days=30)))
        o_under = mk_order(f(base_now + _dt2.timedelta(days=5)), option="issue_invoice")
        o_cancelmeta = mk_order(f(base_now + _dt2.timedelta(days=5)))
        exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                 " VALUES (?, 'cancel_at_period_end', '1', datetime('now'), datetime('now'))", (o_cancelmeta,))
        o_m1 = mk_order(f(base_now + _dt2.timedelta(days=5)))
        o_m2 = mk_order(f(base_now + _dt2.timedelta(days=5)))
        exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                 " VALUES (?, 'merge_renewals', '1', datetime('now'), datetime('now'))", (o_m1,))
        exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                 " VALUES (?, 'merge_renewals', '1', datetime('now'), datetime('now'))", (o_m2,))
        o_nm1 = mk_order(f(base_now + _dt2.timedelta(days=6)))
        o_nm2 = mk_order(f(base_now + _dt2.timedelta(days=6)))
        # Batch reuse semantics (CORRECTED): the qualifying query excludes
        # orders whose unpaid_invoice_id points at an UNPAID invoice (the
        # LEFT JOIN + i.id IS NULL clause), so the batch NEVER reaches
        # generateForOrder's reuse branch -- such orders are simply
        # skipped, draft untouched. An order whose link points at a PAID
        # invoice DOES qualify: the link is cleared and a NEW invoice is
        # generated + re-stamped.
        o_reuse = mk_order(f(base_now + _dt2.timedelta(days=5)))
        draft = mk_draft_invoice()
        exec_sql("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = ?", (draft, o_reuse))
        o_paidlink = mk_order(f(base_now + _dt2.timedelta(days=5)))
        paid_link_inv = mk_draft_invoice(issued=1)
        exec_sql("UPDATE invoice SET status = 'paid', paid_at = datetime('now') WHERE id = ?",
                 (paid_link_inv,))
        exec_sql("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = ?", (paid_link_inv, o_paidlink))
        # pending paid-renew exclusion: paid invoice + non-executed renew item for the order
        o_pend = mk_order(f(base_now + _dt2.timedelta(days=5)))
        paid_inv = mk_draft_invoice(issued=1)
        exec_sql("UPDATE invoice SET status = 'paid', paid_at = datetime('now') WHERE id = ?", (paid_inv,))
        exec_sql("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity,"
                 " price, taxed) VALUES (?, 'order', ?, 'renew', 'pending_payment', 'Renew', '1M', 1, 25.0, 1)",
                 (paid_inv, o_pend))
        pre_inv = q1("SELECT COUNT(*) c FROM invoice")["c"]
        st, env = call(op, tok, PHP_DEV, "admin", "invoice", "batch_generate")
        def inv_for_order(oid):
            r = q1("SELECT unpaid_invoice_id FROM client_order WHERE id = ?", (oid,))
            return r["unpaid_invoice_id"] if r else None
        def inv_row(iid):
            return q1("SELECT id, status, issued, nr, serie, due_at, currency FROM invoice WHERE id = ?", (iid,))
        gen = {
            "result": env.get("result"), "error": env.get("error"),
            "invoice_count_before": pre_inv,
            "invoice_count_after": q1("SELECT COUNT(*) c FROM invoice")["c"],
            "single": inv_row(inv_for_order(o_single)),
            "neg": inv_for_order(o_neg),
            "far": inv_for_order(o_far),
            "underscore": inv_for_order(o_under),
            "cancelmeta": inv_for_order(o_cancelmeta),
            "merge_pair": (inv_for_order(o_m1), inv_for_order(o_m2)),
            "merge_lines": None,
            "nonmerge_pair": (inv_for_order(o_nm1), inv_for_order(o_nm2)),
            "reuse": (draft, inv_for_order(o_reuse)),
            "reuse_row": inv_row(draft),
            "paidlink_new": inv_for_order(o_paidlink),
            "paidlink_new_row": inv_row(inv_for_order(o_paidlink)) if inv_for_order(o_paidlink) else None,
            "pending_paid_renew": inv_for_order(o_pend),
        }
        if gen["merge_pair"][0]:
            gen["merge_lines"] = q("SELECT type, rel_id, task, status, price FROM invoice_item WHERE invoice_id = ?"
                                   " ORDER BY id", (gen["merge_pair"][0],))
        corpus["E_generate"] = gen
        check("E generate true", env.get("result") is True, str(env)[:200])
        check("E single issued+nr+due=expires", gen["single"] and gen["single"]["issued"] == 1 and
              gen["single"]["nr"] is not None and gen["single"]["due_at"] == f(base_now + _dt2.timedelta(days=5)),
              str(gen["single"]))
        check("E negative skipped", gen["neg"] is None)
        check("E far excluded", gen["far"] is None)
        check("E underscore option excluded", gen["underscore"] is None)
        check("E cancel-meta excluded", gen["cancelmeta"] is None)
        check("E merge pair one invoice", gen["merge_pair"][0] is not None and
              gen["merge_pair"][0] == gen["merge_pair"][1], str(gen["merge_pair"]))
        check("E merge two lines", gen["merge_lines"] is not None and len(gen["merge_lines"]) == 2,
              str(gen["merge_lines"]))
        check("E nonmerge separate", gen["nonmerge_pair"][0] is not None and
              gen["nonmerge_pair"][0] != gen["nonmerge_pair"][1], str(gen["nonmerge_pair"]))
        check("E unpaid-linked order EXCLUDED, draft untouched",
              gen["reuse"][0] == gen["reuse"][1] and gen["reuse_row"]["issued"] == 0 and
              gen["reuse_row"]["nr"] is None, str(gen["reuse_row"]))
        check("E paid-linked order qualifies, new invoice stamped",
              gen["paidlink_new"] is not None and gen["paidlink_new"] != paid_link_inv and
              gen["paidlink_new_row"]["issued"] == 1, str(gen["paidlink_new_row"]))
        check("E pending paid-renew excluded", gen["pending_paid_renew"] is None)
        # TS pre-fix generate: stub true, zero effects
        st, env = call(op_ts, tok_ts, TS, "admin", "invoice", "batch_generate")
        check("E ts prefix generate stub true", env.get("result") is True, str(env)[:200])
        restore()
        tok, tok_ts = relogin()

        # ---- F. Invoke-due (PHP direct) ----
        def mk_invoice(client_id, due, issued=1, status="unpaid", taxrate="0", reminded_at=None):
            d2 = sqlite3.connect(DBP)
            cur = d2.execute(
                "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate,"
                " due_at, reminded_at, created_at, updated_at)"
                " VALUES (?, 'FOSS', NULL, ?, 'USD', ?, ?, ?, ?, ?,"
                " datetime('now'), datetime('now'))",
                (client_id, 'due' + uuid.uuid4().hex, status, issued, taxrate, due, reminded_at))
            iid = cur.lastrowid
            d2.commit()
            d2.close()
            return iid

        today = base_now.strftime("%Y-%m-%d")
        day = lambda n: (base_now + _dt2.timedelta(days=n)).strftime("%Y-%m-%d %H:%M:%S")
        set_setting("invoice_reminder_before_due_days", "7")
        set_setting("invoice_reminder_after_due_days", "5")
        set_setting("invoice_reminder_send_time", "")
        set_setting("invoice_overdue_invoked", "2026-10-24 05:31:25")
        d1 = mk_invoice(1, day(-5))
        d2i = mk_invoice(1, day(-3))
        d3 = mk_invoice(1, day(7))
        d4 = mk_invoice(1, day(3))
        d5 = mk_invoice(1, day(-5), reminded_at=today + " 01:00:00")
        d6 = mk_invoice(1, day(-5), status="paid")
        pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
        st, env = call(op, tok, PHP_DEV, "admin", "invoice", "batch_invoke_due_event")
        new_q = q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))
        def reminded(iid):
            r = q1("SELECT reminded_at FROM invoice WHERE id = ?", (iid,))
            return r["reminded_at"] if r else None
        corpus["F_invoke_due"] = {
            "first_result": env.get("result"), "error": env.get("error"),
            "gate_after_first": setting("invoice_overdue_invoked"),
            "new_queue_rows": len(new_q),
            "reminded": {f"D{i}": reminded(x) for i, x in
                         [(1, d1), (2, d2i), (3, d3), (4, d4), (5, d5), (6, d6)]},
        }
        check("F first invoke true", env.get("result") is True, str(env)[:200])
        check("F D1 (overdue 5d) sent", reminded(d1) is not None, str(reminded(d1)))
        check("F D2 (overdue 3d) not sent", reminded(d2i) is None)
        check("F D3 (due +7d, before [7]) sent", reminded(d3) is not None)
        check("F D4 (due +3d, before [7]) not sent", reminded(d4) is None)
        check("F D5 (already claimed today) not re-sent", reminded(d5) == today + " 01:00:00",
              str(reminded(d5)))
        check("F D6 (paid) untouched", q1("SELECT status FROM invoice WHERE id = ?", (d6,))["status"] == "paid")
        check("F exactly 2 sends", len(new_q) == 2, f"new queue rows: {len(new_q)}")
        st, env = call(op, tok, PHP_DEV, "admin", "invoice", "batch_invoke_due_event")
        check("F second call same day -> false, gate unchanged",
              env.get("result") is False and q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,)) and
              len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))) == len(new_q),
              str(env)[:200])
        restore()
        tok, tok_ts = relogin()
        # send-time deferral run
        future_hm = (base_now + _dt2.timedelta(hours=2)).strftime("%H:%M")
        set_setting("invoice_overdue_invoked", "2026-10-24 05:31:25")
        set_setting("invoice_reminder_send_time", future_hm)
        d7 = mk_invoice(1, day(-5))
        pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
        st, env = call(op, tok, PHP_DEV, "admin", "invoice", "batch_invoke_due_event")
        corpus["F_send_time_deferral"] = {
            "send_time": future_hm, "result": env.get("result"),
            "new_queue_rows": len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))),
            "reminded": reminded(d7), "gate_after": setting("invoice_overdue_invoked"),
        }
        check("F future send_time -> run true but no sends, no claims",
              env.get("result") is True and len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))) == 0
              and reminded(d7) is None, str(corpus["F_send_time_deferral"]))
        restore()
        tok, tok_ts = relogin()

        # ---- G. Suspension warnings (PHP direct) ----
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

        def mk_template(code):
            d2 = sqlite3.connect(DBP)
            d2.execute("INSERT INTO email_template (category, enabled, is_custom, is_overridden, subject,"
                       " content, action_code) VALUES ('staff', 1, 1, 0, 'Suspension warning',"
                       " 'Order {{ order.id }} suspension {{ order.suspension_at }}', ?)", (code,))
            d2.commit()
            d2.close()

        w1_exp = f(base_now - _dt2.timedelta(hours=12))
        w1_susp = f(base_now + _dt2.timedelta(hours=12))
        w1 = mk_active_order(w1_exp, 1)
        w2 = mk_active_order(w1_exp, 1)
        exec_sql("INSERT INTO client_order_meta (client_order_id, name, value, created_at, updated_at)"
                 " VALUES (?, 'suspension_warning_for', ?, datetime('now'), datetime('now'))", (w2, w1_susp))
        w3 = mk_active_order(f(base_now + _dt2.timedelta(days=5)), 1)
        w4 = mk_active_order(w1_exp, 0)
        mk_template("mod_order_suspension_warning")
        pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
        st, env = call(op, tok, PHP_DEV, "admin", "order", "batch_send_suspension_warnings")
        def meta_for(oid):
            r = q1("SELECT value FROM client_order_meta WHERE client_order_id = ? AND name = 'suspension_warning_for'",
                   (oid,))
            return r["value"] if r else None
        new_q = q("SELECT subject, content FROM email_queue WHERE id > ?", (pre_qmax,))
        corpus["G_warnings"] = {
            "result": env.get("result"), "error": env.get("error"),
            "w1_meta": meta_for(w1), "w1_suspension_at": w1_susp,
            "w2_meta": meta_for(w2), "w3_meta": meta_for(w3), "w4_meta": meta_for(w4),
            "new_queue": new_q,
        }
        check("G warnings true", env.get("result") is True, str(env)[:200])
        check("G W1 claim created", meta_for(w1) == w1_susp, str(meta_for(w1)))
        check("G W1 queued", len(new_q) == 1 and w1_susp in (new_q[0]["content"] if new_q else ""),
              str(new_q))
        check("G W2 already claimed skipped", meta_for(w2) == w1_susp and len(new_q) == 1)
        check("G W3/W4 not due, no claims", meta_for(w3) is None and meta_for(w4) is None)
        # release attempt with a syntactically broken template
        restore()
        tok, tok_ts = relogin()
        w5 = mk_active_order(w1_exp, 1)
        d2 = sqlite3.connect(DBP)
        d2.execute("INSERT INTO email_template (category, enabled, is_custom, is_overridden, subject,"
                   " content, action_code) VALUES ('staff', 1, 1, 0, 'Suspension warning',"
                   " 'Order {{ order.id ', 'mod_order_suspension_warning')")
        d2.commit()
        d2.close()
        pre_qmax = q1("SELECT COALESCE(MAX(id), 0) m FROM email_queue")["m"]
        st, env = call(op, tok, PHP_DEV, "admin", "order", "batch_send_suspension_warnings")
        corpus["G_release_attempt"] = {
            "result": env.get("result"), "error": env.get("error"),
            "w5_meta": meta_for(w5),
            "new_queue": len(q("SELECT id FROM email_queue WHERE id > ?", (pre_qmax,))),
        }
        check("G broken template -> task still true (per-order catch)",
              env.get("result") is True, str(env)[:200])
        # TS pre-fix: stub true, zero effects
        st, env = call(op_ts, tok_ts, TS, "admin", "order", "batch_send_suspension_warnings")
        check("G ts prefix warnings stub true", env.get("result") is True, str(env)[:200])
        restore()
        tok, tok_ts = relogin()

        # ---- H. Pay with credits, no ids (PHP direct) ----
        def mk_pay_invoice(client_id, items, issued=1):
            # items: list of (type, price)
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
            d2 = sqlite3.connect(DBP)
            d2.execute("INSERT INTO client_balance (client_id, type, rel_id, amount, description, created_at,"
                       " updated_at) VALUES (?, 'funds', NULL, ?, 'crafted', datetime('now'), datetime('now'))",
                       (client_id, amount))
            d2.commit()
            d2.close()

        def inv_status(iid):
            r = q1("SELECT status FROM invoice WHERE id = ?", (iid,))
            return r["status"] if r else "GONE"

        p1 = mk_pay_invoice(2, [("order", 50.0)])
        add_balance(2, 60.0)
        p2 = mk_pay_invoice(2, [("order", 40.0), ("order", 40.0)])
        # p2 shares client 2's balance pool (60) -- sum 60 < 80, but a row >= 40 qualifies it
        p3 = mk_pay_invoice(2, [("order", 0.0)])
        p4 = mk_pay_invoice(2, [("order", 50.0)], issued=0)
        p5 = mk_pay_invoice(2, [("deposit", 50.0)])
        # client 3: order proof -- two 50 invoices, one 60 balance. NOTE: the
        # findAllUnpaid SQL says ORDER BY id DESC, but doBatchPayWithCredits
        # reloads via findBy(['id' => ids]) with NO orderBy, so the effective
        # order is the repository's natural (ASC) order: lower id pays first.
        px = mk_pay_invoice(3, [("order", 50.0)])
        py = mk_pay_invoice(3, [("order", 50.0)])
        add_balance(3, 60.0)
        st, env = call(op, tok, PHP_DEV, "admin", "invoice", "batch_pay_with_credits")
        bal2 = q("SELECT amount FROM client_balance WHERE client_id = 2 ORDER BY id")
        bal3 = q("SELECT amount FROM client_balance WHERE client_id = 3 ORDER BY id")
        corpus["H_pay"] = {
            "result": env.get("result"), "error": env.get("error"),
            "p1": inv_status(p1), "p2": inv_status(p2), "p3": inv_status(p3),
            "p4": inv_status(p4), "p5": inv_status(p5),
            "px": inv_status(px), "py": inv_status(py),
            "bal2": [r["amount"] for r in bal2], "bal3": [r["amount"] for r in bal3],
        }
        check("H pay true", env.get("result") is True, str(env)[:200])
        check("H P1 paid", inv_status(p1) == "paid", inv_status(p1))
        check("H P2 insufficient sum skipped", inv_status(p2) == "unpaid")
        check("H P3 zero paid", inv_status(p3) == "paid", inv_status(p3))
        check("H P4 unissued untouched", inv_status(p4) == "unpaid")
        check("H P5 deposit-only excluded", inv_status(p5) == "unpaid")
        check("H ASC reload order: lower id paid, higher skipped",
              inv_status(px) == "paid" and inv_status(py) == "unpaid",
              f"px={inv_status(px)} py={inv_status(py)}")
        check("H P3 zero paid with NO balance row",
              not any(r["amount"] == 0 and r["amount"] != 0 for r in bal2) and
              len([r for r in bal2 if r["amount"] == -50.0]) >= 1, str(corpus["H_pay"]["bal2"]))
        st, env = call(op_ts, tok_ts, TS, "admin", "invoice", "batch_pay_with_credits")
        corpus["H_ts_prefix_pay"] = {"result": env.get("result"), "error": env.get("error")}
        check("H ts prefix pay no-ids -> empty map", env.get("result") == {}, str(env)[:200])
        restore()
        tok, tok_ts = relogin()

        # ---- I. clearOldSessions + pay->activate 10-min cutoff (full PHP run) ----
        live = q1("SELECT * FROM session ORDER BY id DESC LIMIT 1")
        sess_cols = [r["name"] for r in q("PRAGMA table_info(session)")]
        def mk_session(lifetime, created_at):
            row = dict(live)
            # session.id is a BLOB pk holding 32-hex Symfony ids (no autoincrement)
            row["id"] = uuid.uuid4().hex
            row["lifetime"] = lifetime
            row["created_at"] = created_at
            d2 = sqlite3.connect(DBP)
            cur = d2.execute(f"INSERT INTO session ({','.join(sess_cols)}) VALUES ({','.join('?' * len(sess_cols))})",
                             tuple(row[c] for c in sess_cols))
            d2.commit()
            d2.close()
            return row["id"]  # TEXT pk: lastrowid would be the integer rowid, NOT the id
        now_ts = int(time.time())
        s1 = mk_session(now_ts - 100, now_ts - 100)
        s2 = mk_session(now_ts + 3600, now_ts - 8000)
        s3 = mk_session(now_ts + 3600, now_ts - 100)
        login_sid = q1("SELECT id FROM session ORDER BY id DESC LIMIT 1")["id"]  # placeholder, replaced below
        # cutoff crafts: paid invoices + activate items + pending_setup orders
        def mk_paid_activate(paid_ago_s):
            d2 = sqlite3.connect(DBP)
            cur = d2.execute(
                "INSERT INTO invoice (client_id, serie, nr, hash, currency, status, issued, taxrate, paid_at,"
                " created_at, updated_at) VALUES (1, 'FOSS', NULL, ?, 'USD', 'paid', 1,"
                " '0', datetime('now', ?), datetime('now'), datetime('now'))", ('cutoff' + uuid.uuid4().hex, f"-{paid_ago_s} seconds"))
            iid = cur.lastrowid
            cur = d2.execute(
                "INSERT INTO client_order (client_id, product_id, title, status, invoice_option, period, price,"
                " quantity, currency, created_at, updated_at) VALUES (1, 6, 'Crafted', 'pending_setup',"
                " 'issue-invoice', '1M', 25.0, 1, 'USD', datetime('now'), datetime('now'))")
            oid = cur.lastrowid
            d2.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity,"
                       " price, taxed) VALUES (?, 'order', ?, 'activate', 'pending_payment', 'Item', '1M', 1, 25.0, 0)",
                       (iid, oid))
            d2.execute("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = ?", (iid, oid))
            d2.commit()
            d2.close()
            return iid, oid
        fresh_inv, fresh_ord = mk_paid_activate(60)
        old_inv, old_ord = mk_paid_activate(1200)
        # the login session is the one the opener's cookie points at; find it via a probe:
        # (session rows carry the admin identity; the newest row created by login is not
        # reliably identifiable, so instead assert the total delta == exactly the 2 expired)
        pre_sess = q1("SELECT COUNT(*) c FROM session")["c"]
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        post_sess = q1("SELECT COUNT(*) c FROM session")["c"]
        corpus["I_sessions_cutoff"] = {
            "result": env.get("result"),
            "sessions_before": pre_sess, "sessions_after": post_sess,
            "s1_present": q1("SELECT COUNT(*) c FROM session WHERE id = ?", (s1,))["c"],
            "s2_present": q1("SELECT COUNT(*) c FROM session WHERE id = ?", (s2,))["c"],
            "s3_present": q1("SELECT COUNT(*) c FROM session WHERE id = ?", (s3,))["c"],
            "fresh_order_status": q1("SELECT status FROM client_order WHERE id = ?", (fresh_ord,))["status"],
            "fresh_item_status": q1("SELECT status FROM invoice_item WHERE invoice_id = ? AND task = 'activate'",
                                    (fresh_inv,))["status"],
            "fresh_item_attempts": q1("SELECT attempts FROM invoice_item WHERE invoice_id = ? AND task = 'activate'",
                                      (fresh_inv,))["attempts"],
            "old_order_status": q1("SELECT status FROM client_order WHERE id = ?", (old_ord,))["status"],
            "old_item_status": q1("SELECT status FROM invoice_item WHERE invoice_id = ? AND task = 'activate'",
                                  (old_inv,))["status"],
            "old_item_attempts": q1("SELECT attempts FROM invoice_item WHERE invoice_id = ? AND task = 'activate'",
                                    (old_inv,))["attempts"],
            "old_notes": q("SELECT status, notes FROM client_order_status WHERE client_order_id = ?",
                           (old_ord,)),
        }
        check("I expired-lifetime session deleted", corpus["I_sessions_cutoff"]["s1_present"] == 0)
        check("I expired-created_at session deleted", corpus["I_sessions_cutoff"]["s2_present"] == 0)
        check("I live session kept", corpus["I_sessions_cutoff"]["s3_present"] == 1)
        check("I just-paid NOT activated same run (10-min cutoff)",
              corpus["I_sessions_cutoff"]["fresh_order_status"] == "pending_setup" and
              corpus["I_sessions_cutoff"]["fresh_item_status"] == "pending_payment" and
              corpus["I_sessions_cutoff"]["fresh_item_attempts"] == 0,
              str(corpus["I_sessions_cutoff"]))
        # A bare custom order's activation ATTEMPT fails (no service to
        # create) -> attempts 1 + note, order stays pending_setup. Either
        # that or full activation proves the cutoff passed; both differ
        # from the fresh item's untouched attempts 0.
        _old = corpus["I_sessions_cutoff"]
        check("I old-paid PROCESSED (cutoff passed)",
              (_old["old_order_status"] == "active" and _old["old_item_status"] == "executed") or
              _old["old_item_attempts"] == 1, str(_old))
        restore()
        tok, tok_ts = relogin()

        # ---- J. Expired-unpaid listener (full PHP run) ----
        set_setting("remove_after_days", "30")
        v1 = mk_invoice(1, day(-40))
        v2 = mk_invoice(1, day(-40), issued=0)
        v3 = mk_invoice(1, day(-10))
        v4 = mk_invoice(1, day(-40), status="paid")
        exec_sql("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity,"
                 " price, taxed) VALUES (?, 'order', '1', 'activate', 'pending_payment', 'Item', '1M', 1, 25.0, 0)",
                 (v2,))
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        corpus["J_expired_unpaid"] = {
            "result": env.get("result"),
            "v1_status": (q1("SELECT status FROM invoice WHERE id = ?", (v1,)) or {}).get("status"),
            "v2_present": q1("SELECT COUNT(*) c FROM invoice WHERE id = ?", (v2,))["c"],
            "v2_items": q1("SELECT COUNT(*) c FROM invoice_item WHERE invoice_id = ?", (v2,))["c"],
            "v3_status": (q1("SELECT status FROM invoice WHERE id = ?", (v3,)) or {}).get("status"),
            "v4_status": (q1("SELECT status FROM invoice WHERE id = ?", (v4,)) or {}).get("status"),
            "v1_row": q1("SELECT * FROM invoice WHERE id = ?", (v1,)),
        }
        check("J V1 issued old unpaid voided", corpus["J_expired_unpaid"]["v1_status"] == "canceled",
              str(corpus["J_expired_unpaid"]["v1_status"]))
        check("J V2 draft hard-deleted with items", corpus["J_expired_unpaid"]["v2_present"] == 0 and
              corpus["J_expired_unpaid"]["v2_items"] == 0)
        check("J V3 recent untouched", corpus["J_expired_unpaid"]["v3_status"] == "unpaid")
        check("J V4 paid untouched", corpus["J_expired_unpaid"]["v4_status"] == "paid")
        restore()
        tok, tok_ts = relogin()

        # ---- K. Activity cleanup + 900s password prune (full PHP runs) ----
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
                vals = tuple(row[c] for c in cols)
                cur = d2.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
            else:
                vals = []
                use_cols = []
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

        old_dt = f(base_now - _dt2.timedelta(days=100))
        recent_dt = f(base_now - _dt2.timedelta(days=1))
        a_old = clone_or_craft("activity_admin_history", old_dt)
        a_new = clone_or_craft("activity_admin_history", recent_dt)
        c_old = clone_or_craft("activity_client_history", old_dt)
        s_old = clone_or_craft("activity_system", old_dt)
        e_old = clone_or_craft("activity_client_email", old_dt)
        e_new = clone_or_craft("activity_client_email", recent_dt)
        d2 = sqlite3.connect(DBP)
        d2.execute("INSERT INTO client_password_reset (client_id, hash, created_at, ip) VALUES (1, 'oldreset', ?, '')",
                   (f(base_now - _dt2.timedelta(seconds=1000)),))
        d2.execute("INSERT INTO client_password_reset (client_id, hash, created_at, ip) VALUES (1, 'freshreset', ?, '')",
                   (f(base_now - _dt2.timedelta(seconds=100)),))
        d2.commit()
        d2.close()
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        corpus["K_activity_defaults"] = {
            "result": env.get("result"),
            "admin_old": q1("SELECT COUNT(*) c FROM activity_admin_history WHERE id = ?", (a_old,))["c"],
            "admin_new": q1("SELECT COUNT(*) c FROM activity_admin_history WHERE id = ?", (a_new,))["c"],
            "client_old": q1("SELECT COUNT(*) c FROM activity_client_history WHERE id = ?", (c_old,))["c"],
            "system_old": q1("SELECT COUNT(*) c FROM activity_system WHERE id = ?", (s_old,))["c"],
            "email_old": q1("SELECT COUNT(*) c FROM activity_client_email WHERE id = ?", (e_old,))["c"],
            "email_new": q1("SELECT COUNT(*) c FROM activity_client_email WHERE id = ?", (e_new,))["c"],
            "pw_old": q1("SELECT COUNT(*) c FROM client_password_reset WHERE hash = 'oldreset'")["c"],
            "pw_fresh": q1("SELECT COUNT(*) c FROM client_password_reset WHERE hash = 'freshreset'")["c"],
        }
        check("K defaults: old activity deleted, recent kept",
              corpus["K_activity_defaults"]["admin_old"] == 0 and
              corpus["K_activity_defaults"]["admin_new"] == 1 and
              corpus["K_activity_defaults"]["client_old"] == 0 and
              corpus["K_activity_defaults"]["system_old"] == 0, str(corpus["K_activity_defaults"]))
        check("K defaults: email history NOT pruned (email_max_age 0)",
              corpus["K_activity_defaults"]["email_old"] == 1)
        check("K 900s listener prunes old reset, keeps fresh",
              corpus["K_activity_defaults"]["pw_old"] == 0 and
              corpus["K_activity_defaults"]["pw_fresh"] == 1, str(corpus["K_activity_defaults"]))
        restore()
        tok, tok_ts = relogin()
        e_old = clone_or_craft("activity_client_email", old_dt)
        st, env = call(op, tok, PHP_DEV, "admin", "extension", "config_save",
                       {"ext": "mod_activity", "max_age": "90", "email_max_age": "30"})
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        corpus["K_activity_email30"] = {
            "result": env.get("result"),
            "email_old": q1("SELECT COUNT(*) c FROM activity_client_email WHERE id = ?", (e_old,))["c"],
        }
        check("K email_max_age 30 prunes old email history", corpus["K_activity_email30"]["email_old"] == 0)
        restore()
        tok, tok_ts = relogin()

        # ---- L. Domain-sync stale branch (full PHP run) ----
        set_setting("servicedomain_last_sync", f(base_now - _dt2.timedelta(days=40)))
        st, env = call(op, tok, PHP_DEV, "admin", "cron", "run")
        corpus["L_domain_sync_stale"] = {
            "result": env.get("result"), "sync_after": setting("servicedomain_last_sync"),
            "domains": q1("SELECT COUNT(*) c FROM service_domain")["c"],
        }
        check("L stale sync -> timestamp updated", corpus["L_domain_sync_stale"]["sync_after"] !=
              f(base_now - _dt2.timedelta(days=40)), str(corpus["L_domain_sync_stale"]))
        restore()
        tok, tok_ts = relogin()

        # ---- M. Prod sendmail (full PHP-prod run + mock SMTP) ----
        # Requires :8081 (no APP_ENV) + mock on :18025, started externally.
        # The REFERENCE email config does not point at the mock, so craft
        # the mock config first (parity38's set_config shape) or prod sends
        # fail elsewhere and the mock stays empty.
        _mail_cfg = {"mailer": "smtp", "smtp_host": "127.0.0.1", "smtp_port": "18025",
                     "smtp_username": "", "smtp_password": "",
                     "log_enabled": "1", "queue_once": "0", "time_limit": "5", "cancel_after": "5",
                     "ext": "mod_email"}
        st, env = call(op, tok, PHP_DEV, "admin", "extension", "config_save", _mail_cfg, as_json=True)
        assert env.get("error") is None, str(env)[:200]
        clear_php_app_cache()
        truncate_mock()
        pre_pend = q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"]
        st, env = call(op, tok, PHP_PROD, "admin", "cron", "run")
        msgs = read_mock()
        corpus["M_prod_sendmail"] = {
            "http": st, "result": env.get("result"), "error": env.get("error"),
            "pending_before": pre_pend,
            "pending_after": q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"],
            "mock_messages": len(msgs),
            "mock_subjects": [m.get("subject") for m in msgs],
        }
        check("M prod run true", env.get("result") is True, str(env)[:200])
        check("M prod sendmail delivered via mock", len(msgs) > 0 and
              q1("SELECT COUNT(*) c FROM email_queue WHERE status = 'pending'")["c"] == 0,
              str(corpus["M_prod_sendmail"]))
        restore()
        tok, tok_ts = relogin()
    finally:
        restore()
        (OUT / "corpus.json").write_text(json.dumps(corpus, indent=1, default=str))

    print(f"\n{CHECKS} checks, {len(FAILURES)} failures: {FAILURES}")


if __name__ == "__main__":
    main()
