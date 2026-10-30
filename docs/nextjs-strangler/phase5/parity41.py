#!/usr/bin/env python3
"""R5h parity41: TS antispam enforcement vs PHP (capture44 corpus).

TS sections run on the reference server (:3001, real provider URLs —
sandbox TLS fails, so TS fail-open is exercised for real) and on
mock-backed servers (:3004/:3005/:3006/:3007, env overrides pointing
at the :18026 mock — suite-owned: killed at suite start, started by
the suite, killed in finally; the mock OWNS its lifecycle the same
way). One fresh mock-TS port per temp phase: the temp cache is
process-local, and same-port restarts proved unreliable (run-1 drop
phase served a stale negative cache). PHP sections run
on dev (:8080, limiter bypassed, RFC-only email validation): prod
(:8081) signup/ticket observations are unconstructible in the sandbox
(DNS validation + 5/hour client_signup budget — capture44), while the
antispam code path is identical; capture44 pins the prod login /
profile / admin-update blocked results, which parity41 re-verifies on
dev. TS envelopes are HTTP 200 by seam convention — parity compares
envelopes (message + code), never HTTP status, EXCEPT the R5g limiter's
real 429 in section (vii). PHP blocked-IP errors are real HTTP 403;
that HTTP-status difference is the seam convention, not a failure.

Config rows are shared (one DB): every subsection sets its full config
via the stack it tests (TS admin config_save / PHP admin config_save —
both replace the whole row), so no subsection relies on a config
written only by the other stack. Crafted rows (par41* emails, par41*
ticket subjects) are deleted in finally; cart ids + seq are
snapshot-restored (id-SET restore, never an id-range delete — the R5h
probe lesson: cart ids are sparse up to seq 305).

Sections: (i) blocked-IP every gated endpoint + the two non-gated
counterproofs; (ii) honeypot; (iii) temp-email incl. cache/TTL/
negative-cache/transport/snapshot/exact-domain; (iv) SFS; (v) captcha
per provider incl. v3 threshold clamp + single-use reuse; (vi)
ordering; (vii) limiter interaction on forced :3003; (viii) restore.
"""
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PHP_DEV = "http://127.0.0.1:8080"
TS_DEV = "http://127.0.0.1:3001/api/fb"
TS_MOCK = "http://127.0.0.1:3004/api/fb"
TS_MOCK_B = "http://127.0.0.1:3005/api/fb"
TS_MOCK_C = "http://127.0.0.1:3006/api/fb"
TS_MOCK_O = "http://127.0.0.1:3007/api/fb"
TS_FORCED = "http://127.0.0.1:3003/api/fb"
MOCK = "http://127.0.0.1:18026"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
SRC = "/home/hatch/scratch/fossbilling/runtime/src"
APP = "/home/hatch/scratch/fossbilling/repo/apps/nextjs"
MOCKJS = "/home/hatch/scratch/fossbilling/repo/docs/nextjs-strangler/phase5/antispam-mock-server.mjs"
MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,custompages,email,extension,"
           "formbuilder,index,invoice,massmailer,news,notification,order,page,product,profile,"
           "redirect,security,seo,serviceapikey,servicecustom,servicedomain,servicedownloadable,"
           "servicehosting,servicelicense,staff,stats,support,system,theme,widgets")

SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"
PW = "Par41-Pass!42"
BLOCKED_XFF = "203.0.113.7"
SFS_XFF = "203.0.113.99"

BLOCK_MSG = "Your IP address ({}) is blocked. Please contact our support to lift your block."
BLOCK_MSG_XFF = BLOCK_MSG.format(BLOCKED_XFF)
BLOCK_MSG_PHP = BLOCK_MSG.format("127.0.0.1")
CAP_NOKEY = ("To use reCAPTCHA you must get an API key from "
             "<a href='https://www.google.com/recaptcha/admin/create'>here</a>")
GENERIC = "An unexpected error occurred. Please try again later."

CHECKS = 0
FAILURES = []
mock_proc = None
mock_ts_proc = None
mock_ts_procs = {}
forced_proc = None


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def make_opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def raw_call(opener, url, params=None, headers=None):
    body = urllib.parse.urlencode(params or {}).encode() if params is not None else None
    req = urllib.request.Request(url, data=body, method="POST", headers=headers or {})
    try:
        resp = opener.open(req, timeout=120)
        return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def jbody(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"_unparsed": raw[:300].decode("utf-8", "replace")}


def ts_call(opener, token, base, role, module, method, params=None, headers=None):
    payload = dict(params or {})
    if token:
        payload["CSRFToken"] = token
    st, hdrs, raw = raw_call(opener, f"{base}/{role}/{module}/{method}", payload, headers=headers)
    return st, hdrs, jbody(raw)


def php_call(opener, token, base, role, module, method, params=None):
    payload = dict(params or {})
    if token:
        payload["CSRFToken"] = token
    st, hdrs, raw = raw_call(opener, f"{base}/api/{role}/{module}/{method}", payload)
    return st, hdrs, jbody(raw)


def csrf_of(opener, base):
    # GET /login sets the fossbilling_csrf cookie; read it from the jar.
    opener.open(base + "/login", timeout=30).read()
    for handler in opener.handlers:
        if isinstance(handler, urllib.request.HTTPCookieProcessor):
            for c in handler.cookiejar:
                if c.name == "fossbilling_csrf":
                    return c.value
    return None


def login(opener, base, api, email, password):
    token = csrf_of(opener, base)
    payload = {"email": email, "password": password}
    if token:
        payload["CSRFToken"] = token
    req = urllib.request.Request(base + f"/api/guest/{api}/login",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        env = json.loads(opener.open(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        env = json.loads(e.read())
    assert env.get("error") is None, f"login failed for {email}: {env}"
    return token


def q(sql, args=()):
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    rows = d.execute(sql, args).fetchall()
    d.close()
    return [dict(r) for r in rows]


def exec_sql(sql, args=()):
    d = sqlite3.connect(DBP)
    d.execute(sql, args)
    d.commit()
    d.close()


def counters():
    try:
        return q("SELECT policy, subject_hash, subject_display, count, tokens FROM rate_limit_counter")
    except sqlite3.OperationalError:
        return []


def invariants():
    out = {}
    for t in ("invoice", "client_order", "email_queue", "service_custom", "extension", "extension_meta",
              "setting", "admin", "currency", "client", "support_ticket", "tld", "activity_client_email",
              "invoice_event", "client_order_meta"):
        out[t] = q(f"SELECT COUNT(*) c FROM {t}")[0]["c"]
    out["cart"] = q("SELECT COUNT(*) c FROM cart")[0]["c"]
    out["cart_seq"] = q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"]
    out["config_hash"] = hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()[:12]
    return out


BASE_INV = {"invoice": 323, "client_order": 11, "email_queue": 67, "service_custom": 17, "extension": 6,
            "extension_meta": 3, "setting": 38, "admin": 2, "currency": 1, "client": 3, "support_ticket": 2,
            "tld": 1, "activity_client_email": 0, "invoice_event": 776, "client_order_meta": 0,
            "cart": 283, "cart_seq": 305, "config_hash": "6e3c529673c1"}


def err(env):
    e = env.get("error") or {}
    return e.get("message"), e.get("code")


def is_err(env, message, code=None):
    m, c = err(env)
    return m == message and (code is None or c == code)


def ts_signup(base, email, extra=None, headers=None):
    op = make_opener()
    data = {"email": email, "first_name": "Par41", "password": PW, "password_confirm": PW}
    data.update(extra or {})
    return ts_call(op, None, base, "guest", "client", "create", data, headers=headers)


def ts_ticket(base, email, subject, extra=None, headers=None):
    op = make_opener()
    data = {"name": "Par41", "email": email, "subject": subject, "content": "par41 ticket body"}
    data.update(extra or {})
    return ts_call(op, None, base, "guest", "support", "ticket_create", data, headers=headers)


def php_signup(email, extra=None):
    op = make_opener()
    token = csrf_of(op, PHP_DEV)
    data = {"email": email, "first_name": "Par41", "password": PW, "password_confirm": PW}
    data.update(extra or {})
    return php_call(op, token, PHP_DEV, "guest", "client", "create", data)


def php_ticket(email, subject, extra=None):
    op = make_opener()
    token = csrf_of(op, PHP_DEV)
    data = {"name": "Par41", "email": email, "subject": subject, "content": "par41 ticket body"}
    data.update(extra or {})
    return php_call(op, token, PHP_DEV, "guest", "support", "ticket_create", data)


def mock_get(path):
    with urllib.request.urlopen(MOCK + path, timeout=10) as r:
        return json.loads(r.read())


def mock_post(path, payload):
    req = urllib.request.Request(MOCK + path, data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def mock_hits(key):
    return mock_get("/hits")["hits"][key]


def kill_proc(proc):
    if proc is None:
        return
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def fuser_kill(port):
    subprocess.run(["fuser", "-k", f"{port}/tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)


def ts_env(extra):
    salt = re.search(r"'salt' => '([^']+)'", pathlib.Path(CFG).read_text()).group(1)
    env = dict(os.environ)
    env.update({"TZ": "UTC", "FB_TS_MODULES": MODULES, "FB_DATABASE_PATH": DBP,
                "FOSSBILLING_URL": PHP_DEV, "FB_PAYPAL_SKIP_VERIFY": "1",
                "FB_CALLBACK_SALT": salt, "FOSSBILLING_PHP_SRC": "/home/hatch/scratch/fossbilling/repo/src"})
    env.update(extra)
    return env


def start_mock():
    global mock_proc
    fuser_kill(18026)
    mock_proc = subprocess.Popen(["node", MOCKJS],
                                 stdout=open("/home/hatch/scratch/fossbilling/r5-logs/mock-18026-parity41.log", "w"),
                                 stderr=subprocess.STDOUT)
    for _ in range(20):
        try:
            mock_get("/hits")
            return
        except Exception:
            time.sleep(0.5)
    raise SystemExit("mock :18026 did not come up")


def start_mock_ts(port=3004):
    """Start a mock-backed TS server on a FRESH port.

    Fresh ports per temp phase (3004/3005/3006/3007) are deliberate:
    the temp-list cache is process-local, so a fresh port guarantees a
    fresh cache. Restarting on the SAME port proved unreliable in the
    parity41 run-1 drop phase (a stale server with a 3600s negative
    entry kept serving, so drop-phase signups never refetched and the
    hit-count assertion read 0): liveness polling alone cannot tell a
    new server from a lingering old one on the same port.
    """
    global mock_ts_proc
    base = f"http://127.0.0.1:{port}/api/fb"
    old = mock_ts_procs.get(port)
    kill_proc(old)
    fuser_kill(port)
    proc = subprocess.Popen(
        ["npx", "next", "start", "-p", str(port)], cwd=APP,
        env=ts_env({"FB_ANTISPAM_TEMP_LIST_URL": MOCK + "/temp-list",
                    "FB_ANTISPAM_SFS_URL": MOCK + "/sfs",
                    "FB_ANTISPAM_RECAPTCHA_VERIFY_URL": MOCK + "/recaptcha",
                    "FB_ANTISPAM_TURNSTILE_VERIFY_URL": MOCK + "/turnstile",
                    "FB_ANTISPAM_HCAPTCHA_VERIFY_URL": MOCK + "/hcaptcha",
                    "FB_ANTISPAM_TEMP_LIST_TTL_SECONDS": "5"}),
        stdout=open(f"/home/hatch/scratch/fossbilling/r5-logs/next-{port}-parity41.log", "w"),
        stderr=subprocess.STDOUT)
    mock_ts_procs[port] = proc
    mock_ts_proc = proc
    for _ in range(40):
        if proc.poll() is not None:
            raise SystemExit(f"mock TS :{port} died during startup")
        try:
            st, _, env = ts_call(make_opener(), None, base, "guest", "antispam", "recaptcha")
            if st == 200:
                return base
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"mock TS :{port} did not come up")


def start_forced():
    global forced_proc
    fuser_kill(3003)
    forced_proc = subprocess.Popen(
        ["npx", "next", "start", "-p", "3003"], cwd=APP,
        env=ts_env({"FB_RATE_LIMIT_ENFORCE": "1"}),
        stdout=open("/home/hatch/scratch/fossbilling/r5-logs/next-3003-parity41.log", "w"),
        stderr=subprocess.STDOUT)
    for _ in range(40):
        try:
            st, _, env = ts_call(make_opener(), None, TS_FORCED, "guest", "antispam", "recaptcha")
            if st == 200:
                return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit("forced :3003 did not come up")


def main():
    global mock_proc, mock_ts_proc, forced_proc
    cart_ids_start = {r["id"] for r in q("SELECT id FROM cart")}
    cart_seq_start = q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"]
    # Set-based snapshots: crafted rows may use ANY email domain (mock
    # throwaway domains, seed domains, sfs-flag addresses), so cleanup
    # deletes by id-set difference, never by email pattern.
    client_ids_start = {r["id"] for r in q("SELECT id FROM client")}
    ticket_ids_start = {r["id"] for r in q("SELECT id FROM support_ticket")}
    queue_ids_start = {r["id"] for r in q("SELECT id FROM email_queue")}
    reset_ids_start = {r["id"] for r in q("SELECT id FROM client_password_reset")}
    inv_before = invariants()
    for k, v in BASE_INV.items():
        check(f"inv-before {k}", inv_before.get(k) == v, f"{inv_before.get(k)} != {v}")
    check("counters empty before", counters() == [], str(counters()))

    # Sessions: PHP-dev logins reused as TS sessions (same session table).
    # NOTE: logins run BEFORE the suite's try/finally (the try starts at
    # start_mock), so a login failure here must clean up after itself:
    # each successful client login already created a cart row, and
    # without this handler those rows strand (run-4 lesson: a blocked
    # admin login aborted the run with no finally at all).
    try:
        php_admin_op, php_client_op = make_opener(), make_opener()
        php_admin_tok = login(php_admin_op, PHP_DEV, "staff", SUPER_EMAIL, SUPER_PASS)
        php_client_tok = login(php_client_op, PHP_DEV, "client", CLIENT_EMAIL, CLIENT_PASS)
        ts_admin_op, ts_client_op = make_opener(), make_opener()
        ts_admin_tok = login(ts_admin_op, PHP_DEV, "staff", SUPER_EMAIL, SUPER_PASS)
        ts_client_tok = login(ts_client_op, PHP_DEV, "client", CLIENT_EMAIL, CLIENT_PASS)
        client_row = q("SELECT id, first_name FROM client WHERE email = ?", (CLIENT_EMAIL,))[0]
        admin_row = q("SELECT id, name FROM admin WHERE email = ?", (SUPER_EMAIL,))[0]
    except Exception:
        for cid in ({r["id"] for r in q("SELECT id FROM cart")} - cart_ids_start):
            exec_sql("DELETE FROM cart WHERE id = ?", (cid,))
        exec_sql("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cart'", (cart_seq_start,))
        raise

    def ts_config(base, opener, token, cfg):
        data = {"ext": "mod_antispam"}
        data.update(cfg)
        _, _, env = ts_call(opener, token, base, "admin", "extension", "config_save", data)
        assert env.get("error") is None, f"ts config_save failed: {env}"

    def php_config(cfg):
        data = {"ext": "mod_antispam"}
        data.update(cfg)
        _, _, env = php_call(php_admin_op, php_admin_tok, PHP_DEV, "admin", "extension", "config_save", data)
        assert env.get("error") is None, f"php config_save failed: {env}"

    def ts_login_blocked(base, api, email, password, headers):
        op = make_opener()
        return ts_call(op, None, base, "guest", api, "login",
                       {"email": email, "password": password}, headers=headers)

    try:
        start_mock()
        start_mock_ts()
        # ---------- (i) blocked-IP, TS ----------
        ts_config(TS_DEV, ts_admin_op, ts_admin_tok, {"block_ips": 1, "blocked_ips": BLOCKED_XFF})
        xff = {"X-Forwarded-For": BLOCKED_XFF}
        _, _, env = ts_signup(TS_DEV, "par41blocked@example.com", headers=xff)
        check("ts signup blocked msg+code", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        _, _, env = ts_ticket(TS_DEV, "par41blocked@example.com", "par41 blocked", headers=xff)
        check("ts ticket blocked msg+code", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        _, _, env = ts_login_blocked(TS_DEV, "client", CLIENT_EMAIL, CLIENT_PASS, xff)
        check("ts client login blocked", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        _, _, env = ts_login_blocked(TS_DEV, "staff", SUPER_EMAIL, SUPER_PASS, xff)
        check("ts staff login blocked", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        _, _, env = ts_call(ts_client_op, ts_client_tok, TS_DEV, "client", "profile", "update",
                            {"first_name": client_row["first_name"]}, headers=xff)
        check("ts client profile blocked", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        _, _, env = ts_call(ts_admin_op, ts_admin_tok, TS_DEV, "admin", "client", "update",
                            {"id": client_row["id"], "first_name": client_row["first_name"]}, headers=xff)
        check("ts admin client update blocked", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        _, _, env = ts_call(ts_admin_op, ts_admin_tok, TS_DEV, "admin", "profile", "update",
                            {"name": admin_row["name"]}, headers=xff)
        check("ts admin profile NOT gated", env.get("error") is None, str(env)[:200])
        _, _, env = ts_call(ts_admin_op, ts_admin_tok, TS_DEV, "admin", "client", "create",
                            {"email": "par41admincreated@example.com", "first_name": "Par41",
                             "password": PW, "send_welcome_email": 0}, headers=xff)
        check("ts admin client create NOT gated", env.get("error") is None, str(env)[:200])
        # Unblocked signup creates the existing-email persona for (vi).
        _, _, env = ts_signup(TS_DEV, "par41base@example.com")
        check("ts signup unblocked ok", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_DEV, "par41base@example.com", headers=xff)
        check("ts signup blocked+existing -> true", env.get("error") is None and env.get("result") is True,
              str(env)[:200])

        # ---------- (i) blocked-IP, PHP dev ----------
        php_config({"block_ips": 1, "blocked_ips": "127.0.0.1"})
        _, _, env = php_signup("par41phpblocked@example.com")
        check("php signup blocked msg+code", is_err(env, BLOCK_MSG_PHP, 403), str(env)[:200])
        _, _, env = php_ticket("par41phpblocked@example.com", "par41 php blocked")
        check("php ticket blocked msg+code", is_err(env, BLOCK_MSG_PHP, 403), str(env)[:200])
        op = make_opener()
        tok = csrf_of(op, PHP_DEV)
        _, _, env = php_call(op, tok, PHP_DEV, "guest", "client", "login",
                             {"email": CLIENT_EMAIL, "password": CLIENT_PASS})
        check("php client login blocked", is_err(env, BLOCK_MSG_PHP, 403), str(env)[:200])
        op = make_opener()
        tok = csrf_of(op, PHP_DEV)
        _, _, env = php_call(op, tok, PHP_DEV, "guest", "staff", "login",
                             {"email": SUPER_EMAIL, "password": SUPER_PASS})
        check("php staff login blocked", is_err(env, BLOCK_MSG_PHP, 403), str(env)[:200])
        _, _, env = php_call(php_client_op, php_client_tok, PHP_DEV, "client", "profile", "update",
                             {"first_name": client_row["first_name"]})
        check("php client profile blocked", is_err(env, BLOCK_MSG_PHP, 403), str(env)[:200])
        _, _, env = php_call(php_admin_op, php_admin_tok, PHP_DEV, "admin", "client", "update",
                             {"id": client_row["id"], "first_name": client_row["first_name"]})
        check("php admin client update blocked", is_err(env, BLOCK_MSG_PHP, 403), str(env)[:200])
        _, _, env = php_call(php_admin_op, php_admin_tok, PHP_DEV, "admin", "profile", "update",
                             {"name": admin_row["name"]})
        check("php admin profile NOT gated", env.get("error") is None, str(env)[:200])
        _, _, env = php_call(php_admin_op, php_admin_tok, PHP_DEV, "admin", "client", "create",
                             {"email": "par41phpadmincreated@example.com", "first_name": "Par41",
                              "password": PW, "send_welcome_email": 0})
        check("php admin client create NOT gated", env.get("error") is None, str(env)[:200])

        # ---------- (ii) honeypot ----------
        ts_config(TS_DEV, ts_admin_op, ts_admin_tok, {"check_temp_emails": 0})
        php_config({"check_temp_emails": 0})
        _, _, env = ts_signup(TS_DEV, "par41honey@example.com", {"bio": "spammy bot text"})
        check("ts honeypot filled", is_err(env, "Registration failed.", 9999), str(env)[:200])
        _, _, env = ts_signup(TS_DEV, "par41honey0@example.com", {"bio": "0"})
        check("ts honeypot '0' passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_DEV, "par41honeyabsent@example.com")
        check("ts honeypot absent passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_ticket(TS_DEV, "par41ticket@example.com", "par41 honeypot ticket",
                              {"bio": "spammy bot text"})
        check("ts ticket ignores honeypot field", env.get("error") is None, str(env)[:200])
        _, _, env = php_signup("par41phphoney@example.com", {"bio": "spammy bot text"})
        check("php honeypot filled", is_err(env, "Registration failed.", 9999), str(env)[:200])
        _, _, env = php_signup("par41phphoney0@example.com", {"bio": "0"})
        check("php honeypot '0' passes", env.get("error") is None, str(env)[:200])

        # ---------- (iii) temp-email, TS mock ----------
        start_mock_ts()  # fresh temp cache
        mock_post("/reset", {})
        ts_config(TS_MOCK, ts_admin_op, ts_admin_tok, {"check_temp_emails": 1})
        _, _, env = ts_signup(TS_MOCK, "user@mockthrow.test")
        check("ts temp mock-listed blocks", is_err(env, "Disposable email addresses are not allowed", 9999),
              str(env)[:200])
        check("ts temp fetch hit 1 after listed", mock_hits("temp") == 1, str(mock_hits("temp")))
        _, _, env = ts_signup(TS_MOCK, "par41tempok@example.com")
        check("ts temp unlisted passes", env.get("error") is None, str(env)[:200])
        check("ts temp second call cached (hits still 1)", mock_hits("temp") == 1, str(mock_hits("temp")))
        _, _, env = ts_signup(TS_MOCK, "user@sub.mockthrow.test")
        check("ts temp exact-domain only (subdomain passes)", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "user@sub.listed.test")
        check("ts temp listed subdomain blocks", is_err(env, "Disposable email addresses are not allowed", 9999),
              str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "user@UPPERCASE-TEST.test")
        check("ts temp case-insensitive domain blocks", is_err(env, "Disposable email addresses are not allowed", 9999),
              str(env)[:200])
        time.sleep(6)  # TTL is 5s on :3004
        _, _, env = ts_signup(TS_MOCK, "par41tempok2@example.com")
        check("ts temp TTL expiry refetches (hits 2)", mock_hits("temp") == 2 and env.get("error") is None,
              f"hits={mock_hits('temp')} env={str(env)[:200]}")
        # Negative cache: fresh TS on :3005 (fresh cache), 500 mode.
        start_mock_ts(3005)
        mock_post("/reset", {})
        mock_post("/control", {"service": "temp", "mode": "500"})
        ts_config(TS_MOCK_B, ts_admin_op, ts_admin_tok, {"check_temp_emails": 1})
        _, _, env = ts_signup(TS_MOCK_B, "user@mockthrow.test")
        check("ts temp non-200 unlisted-by-seed allows", env.get("error") is None, str(env)[:200])
        check("ts temp non-200 fetched once", mock_hits("temp") == 1, str(mock_hits("temp")))
        _, _, env = ts_signup(TS_MOCK_B, "user@mockthrow2.test")
        check("ts temp non-200 second call no refetch", mock_hits("temp") == 1 and env.get("error") is None,
              f"hits={mock_hits('temp')} env={str(env)[:200]}")
        # Transport drop + snapshot: fresh TS on :3006 (fresh cache), drop mode.
        # Emails MUST be fresh local parts: Phase B already created
        # user@mockthrow.test and user@mockthrow2.test (non-200 allows),
        # so reusing them here hits the existing-account early return
        # BEFORE the temp check and the mock records zero fetches —
        # that reuse, not a stale server, was the run-1/verifier
        # "refetches" failure (diagnosed 2026-10-30; the seed-block
        # check below passed precisely because mailinator.com WAS fresh).
        start_mock_ts(3006)
        mock_post("/reset", {})
        mock_post("/control", {"service": "temp", "mode": "drop"})
        ts_config(TS_MOCK_C, ts_admin_op, ts_admin_tok, {"check_temp_emails": 1})
        _, _, env = ts_signup(TS_MOCK_C, "par41drop1@mockthrow.test")
        check("ts temp transport-error allows (DEVIATION vs php)", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK_C, "par41drop2@mockthrow.test")
        check("ts temp transport-error refetches (not cached)", mock_hits("temp") == 2 and env.get("error") is None,
              f"hits={mock_hits('temp')} env={str(env)[:200]}")
        _, _, env = ts_signup(TS_MOCK_C, "user@mailinator.com")
        check("ts temp snapshot seed-listed blocks on drop", is_err(env, "Disposable email addresses are not allowed", 9999),
              str(env)[:200])
        _, _, env = ts_signup(TS_MOCK_C, "par41tempdrop@example.com")
        check("ts temp snapshot unlisted allows on drop", env.get("error") is None, str(env)[:200])
        mock_post("/control", {"service": "temp", "mode": "ok"})
        # PHP dev anchor: no config row = all defaults, fetch TLS-fails.
        exec_sql("DELETE FROM extension_meta WHERE extension = 'mod_antispam'")
        _, _, env = php_signup("par41phptemp@example.com")
        check("php temp transport-error generic failure", is_err(env, GENERIC, 9999), str(env)[:200])
        php_config({"check_temp_emails": 0})
        # TS real-URL fail-open on :3001 (no mock): default config, seed-unlisted passes.
        exec_sql("DELETE FROM extension_meta WHERE extension = 'mod_antispam'")
        _, _, env = ts_signup(TS_DEV, "par41realurl@example.com")
        check("ts real-URL transport-error allows unlisted", env.get("error") is None, str(env)[:200])

        # ---------- (iv) SFS, TS mock ----------
        start_mock_ts()
        mock_post("/reset", {})
        ts_config(TS_MOCK, ts_admin_op, ts_admin_tok, {"check_temp_emails": 0, "sfs": 1})
        _, _, env = ts_signup(TS_MOCK, "sfsflag@example.com")
        check("ts sfs flagged email blocks",
              is_err(env, "Your e-mail is blacklisted in the Stop Forum Spam database", 9999), str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41sfsip@example.com", headers={"X-Forwarded-For": SFS_XFF})
        check("ts sfs flagged ip blocks",
              is_err(env, "Your IP address is blacklisted in the Stop Forum Spam database", 9999), str(env)[:200])
        mock_post("/control", {"service": "sfs", "mode": "successfalse"})
        _, _, env = ts_signup(TS_MOCK, "sfsflag@example.com")
        check("ts sfs success=false allows", env.get("error") is None, str(env)[:200])
        mock_post("/control", {"service": "sfs", "mode": "drop"})
        _, _, env = ts_signup(TS_MOCK, "sfsflag@example.com")
        check("ts sfs transport-error allows (DEVIATION vs php)", env.get("error") is None, str(env)[:200])
        mock_post("/control", {"service": "sfs", "mode": "ok"})
        ts_config(TS_MOCK, ts_admin_op, ts_admin_tok, {"check_temp_emails": 0})
        _, _, env = ts_signup(TS_MOCK, "sfsflag@example.com")
        check("ts sfs disabled allows flagged", env.get("error") is None, str(env)[:200])
        php_config({"check_temp_emails": 0, "sfs": 1})
        _, _, env = php_signup("par41phpsfs@example.com")
        check("php sfs transport-error generic failure", is_err(env, GENERIC, 9999), str(env)[:200])
        php_config({"check_temp_emails": 0})

        # ---------- (v) captcha, TS mock ----------
        def ts_cap_config(provider, extra=None):
            cfg = {"check_temp_emails": 0, "captcha_enabled": 1, "captcha_provider": provider}
            cfg.update(extra or {})
            ts_config(TS_MOCK, ts_admin_op, ts_admin_tok, cfg)

        mock_post("/reset", {})
        ts_cap_config("recaptcha_v2", {"captcha_recaptcha_privatekey": "dummy-test-key"})
        _, _, env = ts_signup(TS_MOCK, "par41capok@example.com", {"g-recaptcha-response": "valid-token"})
        check("ts captcha v2 valid passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41capbad@example.com", {"g-recaptcha-response": "invalid-token"})
        check("ts captcha v2 invalid fails", is_err(env, "reCAPTCHA verification failed.", 9999), str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41capnotok@example.com")
        check("ts captcha v2 missing token", is_err(env, "You have to complete the CAPTCHA to continue", 9999),
              str(env)[:200])
        ts_cap_config("recaptcha_v2")
        _, _, env = ts_signup(TS_MOCK, "par41capnokey@example.com", {"g-recaptcha-response": "valid-token"})
        check("ts captcha v2 missing secret", is_err(env, CAP_NOKEY, 9999), str(env)[:200])
        ts_cap_config("recaptcha_v2", {"captcha_recaptcha_privatekey": "dummy-test-key"})
        mock_post("/control", {"service": "recaptcha", "mode": "drop"})
        _, _, env = ts_signup(TS_MOCK, "par41capdown@example.com", {"g-recaptcha-response": "valid-token"})
        check("ts captcha provider-down fails closed", is_err(env, "reCAPTCHA verification failed.", 9999),
              str(env)[:200])
        mock_post("/control", {"service": "recaptcha", "mode": "ok"})
        # v3
        ts_cap_config("recaptcha_v3", {"captcha_recaptcha_privatekey": "dummy-test-key",
                                       "captcha_recaptcha_v3_threshold": 0.5})
        _, _, env = ts_signup(TS_MOCK, "par41v3ok@example.com", {"g-recaptcha-response": "valid-token"})
        check("ts captcha v3 valid passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41v3low@example.com", {"g-recaptcha-response": "low-score-token"})
        check("ts captcha v3 low score fails", is_err(env, "reCAPTCHA verification failed.", 9999), str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41v3act@example.com", {"g-recaptcha-response": "wrong-action-token"})
        check("ts captcha v3 wrong action fails", is_err(env, "reCAPTCHA verification failed.", 9999),
              str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41v3noact@example.com", {"g-recaptcha-response": "valid-token"})
        check("ts captcha v3 missing action param passes (php ?? default)",
              env.get("error") is None, str(env)[:200])
        ts_cap_config("recaptcha_v3", {"captcha_recaptcha_privatekey": "dummy-test-key",
                                       "captcha_recaptcha_v3_threshold": 2})
        _, _, env = ts_signup(TS_MOCK, "par41v3clamp1@example.com", {"g-recaptcha-response": "valid-token"})
        check("ts captcha v3 threshold 2 clamps to 1 (0.9 fails)",
              is_err(env, "reCAPTCHA verification failed.", 9999), str(env)[:200])
        ts_cap_config("recaptcha_v3", {"captcha_recaptcha_privatekey": "dummy-test-key",
                                       "captcha_recaptcha_v3_threshold": -1})
        _, _, env = ts_signup(TS_MOCK, "par41v3clamp0@example.com", {"g-recaptcha-response": "low-score-token"})
        check("ts captcha v3 threshold -1 clamps to 0 (0.2 passes)", env.get("error") is None, str(env)[:200])
        # reuse (provider-side single-use, mock-marked)
        ts_cap_config("recaptcha_v2", {"captcha_recaptcha_privatekey": "dummy-test-key"})
        mock_post("/reset", {})
        _, _, env = ts_signup(TS_MOCK, "par41reuse1@example.com", {"g-recaptcha-response": "reuse-token"})
        check("ts captcha reuse first use passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41reuse2@example.com", {"g-recaptcha-response": "reuse-token"})
        check("ts captcha reuse second use fails", is_err(env, "reCAPTCHA verification failed.", 9999),
              str(env)[:200])
        # turnstile
        ts_cap_config("turnstile", {"turnstile_secret_key": "dummy-test-key"})
        _, _, env = ts_signup(TS_MOCK, "par41turnok@example.com", {"cf-turnstile-response": "valid-token"})
        check("ts turnstile valid passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41turnbad@example.com", {"cf-turnstile-response": "invalid-token"})
        check("ts turnstile invalid fails",
              is_err(env, "CAPTCHA verification failed. Please try again.", 9999), str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41turnnotok@example.com")
        check("ts turnstile missing token",
              is_err(env, "Please complete the CAPTCHA verification.", 9999), str(env)[:200])
        ts_cap_config("turnstile")
        _, _, env = ts_signup(TS_MOCK, "par41turnnosec@example.com", {"cf-turnstile-response": "valid-token"})
        check("ts turnstile missing secret",
              is_err(env, "Cloudflare Turnstile secret key is not configured.", 9999), str(env)[:200])
        # hcaptcha
        ts_cap_config("hcaptcha", {"hcaptcha_secret_key": "dummy-test-key"})
        _, _, env = ts_signup(TS_MOCK, "par41hcapok@example.com", {"h-captcha-response": "valid-token"})
        check("ts hcaptcha valid passes", env.get("error") is None, str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41hcapbad@example.com", {"h-captcha-response": "invalid-token"})
        check("ts hcaptcha invalid fails",
              is_err(env, "CAPTCHA verification failed. Please try again.", 9999), str(env)[:200])
        _, _, env = ts_signup(TS_MOCK, "par41hcapnotok@example.com")
        check("ts hcaptcha missing token",
              is_err(env, "Please complete the CAPTCHA verification.", 9999), str(env)[:200])
        ts_cap_config("hcaptcha")
        _, _, env = ts_signup(TS_MOCK, "par41hcapnosec@example.com", {"h-captcha-response": "valid-token"})
        check("ts hcaptcha missing secret",
              is_err(env, "hCaptcha secret key is not configured.", 9999), str(env)[:200])
        # disabled + reset-password captcha
        ts_config(TS_MOCK, ts_admin_op, ts_admin_tok, {"check_temp_emails": 0})
        _, _, env = ts_signup(TS_MOCK, "par41capdisabled@example.com")
        check("ts captcha disabled token-less passes", env.get("error") is None, str(env)[:200])
        ts_cap_config("recaptcha_v2", {"captcha_recaptcha_privatekey": "dummy-test-key"})
        _, _, env = ts_call(make_opener(), None, TS_MOCK, "guest", "client", "reset_password",
                            {"email": CLIENT_EMAIL})
        check("ts client reset_password captcha enforced",
              is_err(env, "You have to complete the CAPTCHA to continue", 9999), str(env)[:200])
        _, _, env = ts_call(make_opener(), None, TS_MOCK, "guest", "staff", "passwordreset",
                            {"email": SUPER_EMAIL})
        check("ts staff passwordreset captcha enforced",
              is_err(env, "You have to complete the CAPTCHA to continue", 9999), str(env)[:200])
        # PHP dev anchors (missing-key / missing-token / verify TLS)
        php_config({"check_temp_emails": 0, "captcha_enabled": 1, "captcha_provider": "recaptcha_v2"})
        _, _, env = php_signup("par41phpcapnokey@example.com", {"g-recaptcha-response": "valid-token"})
        check("php captcha missing secret", is_err(env, CAP_NOKEY, 9999), str(env)[:200])
        php_config({"check_temp_emails": 0, "captcha_enabled": 1, "captcha_provider": "recaptcha_v2",
                    "captcha_recaptcha_privatekey": "dummy-test-key"})
        _, _, env = php_signup("par41phpcapnotok@example.com")
        check("php captcha missing token",
              is_err(env, "You have to complete the CAPTCHA to continue", 9999), str(env)[:200])
        _, _, env = php_signup("par41phpcapverify@example.com", {"g-recaptcha-response": "dummy-test-token"})
        check("php captcha verify transport generic failure", is_err(env, GENERIC, 9999), str(env)[:200])
        php_config({"check_temp_emails": 0})

        # ---------- (vi) ordering, TS mock (fresh :3007) ----------
        start_mock_ts(3007)
        mock_post("/reset", {})
        ts_config(TS_MOCK_O, ts_admin_op, ts_admin_tok,
                  {"block_ips": 1, "blocked_ips": BLOCKED_XFF, "check_temp_emails": 1,
                   "captcha_enabled": 1, "captcha_provider": "recaptcha_v2",
                   "captcha_recaptcha_privatekey": "dummy-test-key"})
        _, _, env = ts_signup(TS_MOCK_O, "user@mockthrow.test",
                              {"g-recaptcha-response": "invalid-token"}, headers=xff)
        check("order signup captcha beats blocked+temp",
              is_err(env, "reCAPTCHA verification failed.", 9999), str(env)[:200])
        op = make_opener()
        _, _, env = ts_call(op, None, TS_MOCK_O, "guest", "client", "create",
                            {"email": "par41ord@example.com", "password": PW, "password_confirm": PW},
                            headers=xff)
        check("order signup validation beats blocked", is_err(env, "First name required", 9999),
              str(env)[:200])
        _, _, env = ts_ticket(TS_MOCK_O, "par41ord@example.com", "par41 order ticket",
                              {"g-recaptcha-response": "invalid-token"}, headers=xff)
        check("order ticket blocked beats captcha", is_err(env, BLOCK_MSG_XFF, 403), str(env)[:200])
        # PHP dev ordering: validation beats blocked.
        php_config({"block_ips": 1, "blocked_ips": "127.0.0.1", "check_temp_emails": 0})
        op = make_opener()
        tok = csrf_of(op, PHP_DEV)
        _, _, env = php_call(op, tok, PHP_DEV, "guest", "client", "create",
                             {"email": "par41phpord@example.com", "password": PW, "password_confirm": PW})
        check("php order validation beats blocked", is_err(env, "First name required", 9999),
              str(env)[:200])
        php_config({"check_temp_emails": 0})

        # ---------- (vii) limiter interaction, forced :3003 ----------
        start_forced()

        def ts_reset_forced():
            _, _, env = ts_call(ts_admin_op, ts_admin_tok, TS_FORCED, "admin", "security",
                                "rate_limit_reset_all")
            assert env.get("error") is None, str(env)[:300]

        ts_reset_forced()
        check("forced reset leaves counters empty", counters() == [], str(counters()))
        ts_config(TS_FORCED, ts_admin_op, ts_admin_tok, {"check_temp_emails": 0})
        for i in range(1, 6):
            _, _, env = ts_signup(TS_FORCED, f"par41lim{i}@example.com")
            assert env.get("error") is None, f"limiter warmup {i}: {env}"
        st, _, env = ts_signup(TS_FORCED, "par41lim6@example.com")
        check("limiter rate-limited signup is 429 not antispam",
              st == 429 and is_err(env, "Rate limit exceeded. Please try again later.", 429),
              f"st={st} env={str(env)[:200]}")
        ts_reset_forced()
        ts_config(TS_FORCED, ts_admin_op, ts_admin_tok,
                  {"block_ips": 1, "blocked_ips": BLOCKED_XFF, "check_temp_emails": 0})
        st, _, env = ts_signup(TS_FORCED, "par41limblocked@example.com", headers=xff)
        check("limiter antispam-blocked signup is 403 not 429",
              st == 200 and is_err(env, BLOCK_MSG_XFF, 403), f"st={st} env={str(env)[:200]}")
        rows = [r for r in counters() if r["policy"] == "client_signup"]
        check("limiter blocked signup consumed route quota",
              len(rows) >= 1 and rows[0]["count"] >= 1, str(rows))
        ts_reset_forced()
        results = []
        for i in range(1, 7):
            st, _, env = ts_signup(TS_FORCED, f"par41limb{i}@example.com", headers=xff)
            results.append((st, env))
        check("limiter blocked+rate-limited: first 5 are 403",
              all(s == 200 and is_err(e, BLOCK_MSG_XFF, 403) for s, e in results[:5]),
              str([(s, err(e)) for s, e in results]))
        check("limiter blocked+rate-limited: 6th is 429 (limiter first)",
              results[5][0] == 429 and is_err(results[5][1], "Rate limit exceeded. Please try again later.", 429),
              str(results[5]))
        ts_reset_forced()
    finally:
        # ---------- (viii) restore ----------
        try:
            if forced_proc is not None:
                try:
                    _, _, env = ts_call(ts_admin_op, ts_admin_tok, TS_FORCED, "admin", "security",
                                        "rate_limit_reset_all")
                except Exception:
                    pass
            exec_sql("DELETE FROM extension_meta WHERE extension = 'mod_antispam'")
            for cid in ({r["id"] for r in q("SELECT id FROM client")} - client_ids_start):
                exec_sql("DELETE FROM client WHERE id = ?", (cid,))
            new_tickets = {r["id"] for r in q("SELECT id FROM support_ticket")} - ticket_ids_start
            for tid in new_tickets:
                exec_sql("DELETE FROM support_ticket_message WHERE support_ticket_id = ?", (tid,))
                exec_sql("DELETE FROM support_ticket WHERE id = ?", (tid,))
            for rid in ({r["id"] for r in q("SELECT id FROM client_password_reset")} - reset_ids_start):
                exec_sql("DELETE FROM client_password_reset WHERE id = ?", (rid,))
            for qid in ({r["id"] for r in q("SELECT id FROM email_queue")} - queue_ids_start):
                exec_sql("DELETE FROM email_queue WHERE id = ?", (qid,))
            new_cart = {r["id"] for r in q("SELECT id FROM cart")} - cart_ids_start
            for cid in new_cart:
                exec_sql("DELETE FROM cart WHERE id = ?", (cid,))
            exec_sql("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cart'", (cart_seq_start,))
            exec_sql("UPDATE client SET first_name = ? WHERE id = ?",
                     (client_row["first_name"], client_row["id"]))
            exec_sql("UPDATE admin SET name = ? WHERE id = ?",
                     (admin_row["name"], admin_row["id"]))
        except Exception as e:
            print("RESTORE ERROR:", e)
        kill_proc(forced_proc)
        for _port, _proc in list(mock_ts_procs.items()):
            kill_proc(_proc)
        kill_proc(mock_proc)
        fuser_kill(3003)
        for _port in (3004, 3005, 3006, 3007):
            fuser_kill(_port)
        fuser_kill(18026)
        time.sleep(1)
        inv_after = invariants()
        for k, v in BASE_INV.items():
            check(f"inv-after {k}", inv_after.get(k) == v, f"{inv_after.get(k)} != {v}")
        check("counters empty after", counters() == [], str(counters()))
        for port, name in ((3001, "ts :3001"),):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/fb/guest/antispam/recaptcha",
                                       timeout=3).read()
                check(f"{name} still answers", True)
            except Exception as e:
                check(f"{name} still answers", False, str(e))
        for port, name in ((18026, "mock :18026"), (3003, "forced :3003"), (3004, "mock-ts :3004"),
                           (3005, "mock-ts :3005"), (3006, "mock-ts :3006"), (3007, "mock-ts :3007"),
                           (8081, "oracle :8081")):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read()
                check(f"{name} down", False, "still answers")
            except Exception:
                check(f"{name} down", True)
        print(f"\nparity41: {CHECKS - len(FAILURES)}/{CHECKS} passed")
        if FAILURES:
            print("FAILURES:", FAILURES)


if __name__ == "__main__":
    main()
