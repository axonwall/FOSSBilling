#!/usr/bin/env python3
"""R5g parity40: TS rate limiter vs PHP (capture43 corpus), forced server.

TS side runs on a FORCED-ENFORCEMENT server (:3003,
FB_RATE_LIMIT_ENFORCE=1, same DB + PHP origin as :3001, sequential
use only, killed by explicit PID in finally). A limiter case on a
dev-default server proves nothing, so every trip section runs on
:3003. The dev-default :3001 section proves the bypass instead
(never trips, status enabled:false, no counter rows).

PHP side runs on a prod oracle (:8081, NO APP_ENV = production,
killed in finally) for the api_guest rendering equality only; the
full PHP boundary corpus is capture43 (re-tripping every PHP policy
here would burn the oracle's hourly budgets for no new information).
Per-stack assertions are used where PHP and TS legitimately differ:
- PHP 429 carries Cache-Control/Expires/Symfony headers TS does not
  set (TS envelopes never set them); only status + Retry-After +
  body are compared.
- Retry-After for fixed-window policies is timing-dependent (window
  end minus now); asserted as an int in (3000, 3600] for api_login,
  exact 60 for the api_guest bucket (deterministic 1-cycle math).
- Silent-return policies (password-reset requests) never 429 on
  either stack by design; their boundary is proven by counter rows
  + get_list limited-entries, not by a 429.
- invoice_*_hash policies are SHADOWED: PHP consumes the ip policy
  first (Invoice/Api/Guest.php: ip line precedes hash line), so the
  hash counter can never reach its trip while the ip policy trips
  first (invoice_get_hash 30 vs ip 10; payment/pdf hash 10 vs ip 10
  — the hash counter stalls at the ip limit). Counter-proven, with
  the shadowing named, on both stacks (same code order).
- guest_ticket_create: TS seam consumes BEFORE handler validation,
  PHP validates content length BEFORE consuming — so the TS trip
  uses short content (no ticket rows created) while PHP with short
  content would never trip. Order divergence, named, not hidden.
- Scope IPs: TS seam ip comes from X-Forwarded-For (pre-existing
  seam behavior, inherited by the limiter); PHP's ip is REMOTE_ADDR
  unless trusted proxies are configured. Isolation is proven on TS
  subjects; the keying mechanism (per-IP counters) is what matches.

Counter rows are read directly from rate_limit_counter (parity
introspection). reset_all between sections gives each section a
clean slate (the reset call's own consumes are deleted by its own
handler, which runs after the consumes).

Cleanup (finally): reset_all on :3003, delete email_queue rows
created by verification resends, restore confirm_email meta rows,
delete any cart rows created by checkout probes, kill :3003 (PID)
and :8081 (PID), assert rate_limit_counter empty.
"""
import glob
import hashlib
import http.cookiejar
import json
import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PHP_DEV = "http://127.0.0.1:8080"
PHP_PROD = "http://127.0.0.1:8081"
TS_DEV = "http://127.0.0.1:3001/api/fb"
TS_FORCED = "http://127.0.0.1:3003/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
SRC = "/home/hatch/scratch/fossbilling/runtime/src"
APP = "/home/hatch/scratch/fossbilling/repo/apps/nextjs"
MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,custompages,email,"
           "extension,formbuilder,index,invoice,massmailer,news,notification,order,page,product,"
           "profile,redirect,security,seo,serviceapikey,servicecustom,servicedomain,"
           "servicedownloadable,servicehosting,servicelicense,staff,stats,support,system,theme,widgets")

SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"

CHECKS = 0
FAILURES = []
forced_proc = None
oracle_proc = None


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


def raw_call(opener, url, params=None, method="POST", headers=None):
    body = urllib.parse.urlencode(params or {}).encode() if params is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
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


def login(opener, base, email, password, api="staff"):
    resp = opener.open(base + "/login")
    page = resp.read().decode("utf-8", "replace")
    token = page.split('name="CSRFToken" value="')[1].split('"')[0]
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(base + f"/api/guest/{api}/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:300]
    return token


def q(sql, args=()):
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    rows = d.execute(sql, args).fetchall()
    d.close()
    return [dict(r) for r in rows]


def counters():
    try:
        return q("SELECT policy, subject_hash, subject_display, count, tokens FROM rate_limit_counter")
    except sqlite3.OperationalError:
        return []


def counter_count(policy):
    rows = [r for r in counters() if r["policy"] == policy]
    return rows[0]["count"] if rows else 0


def counter_tokens(policy):
    # Token-bucket policies (api_guest, api_authenticated_*) track
    # `tokens`, not `count` (count stays 0 on those rows — run-3
    # lesson: counter_count() reads 0 for a bucket with 998 tokens
    # left). Fixed-window policies use `count`; buckets use `tokens`.
    rows = [r for r in counters() if r["policy"] == policy]
    return rows[0]["tokens"] if rows else 0


def invariants():
    out = {}
    for t in ("invoice", "client_order", "email_queue", "service_custom", "extension", "extension_meta",
              "setting", "admin", "currency", "client", "support_ticket", "tld", "activity_client_email",
              "invoice_event", "client_order_meta"):
        out[t] = q(f"SELECT COUNT(*) c FROM {t}")[0]["c"]
    out["config_hash"] = hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()[:12]
    return out


BASE_INV = {"invoice": 323, "client_order": 11, "email_queue": 67, "service_custom": 17, "extension": 6,
            "extension_meta": 3, "setting": 38, "admin": 2, "currency": 1, "client": 3, "support_ticket": 2,
            "tld": 1, "activity_client_email": 0, "invoice_event": 776, "client_order_meta": 0,
            "config_hash": "6e3c529673c1"}


def start_forced():
    global forced_proc
    salt = None
    import re
    salt = re.search(r"'salt' => '([^']+)'", pathlib.Path(CFG).read_text()).group(1)
    env = dict(os.environ)
    env.update({
        "TZ": "UTC", "FB_TS_MODULES": MODULES, "FB_DATABASE_PATH": DBP,
        "FOSSBILLING_URL": PHP_DEV, "FB_PAYPAL_SKIP_VERIFY": "1",
        "FB_CALLBACK_SALT": salt, "FOSSBILLING_PHP_SRC": "/home/hatch/scratch/fossbilling/repo/src",
        "FB_RATE_LIMIT_ENFORCE": "1",
    })
    forced_proc = subprocess.Popen(
        ["npx", "next", "start", "-p", "3003"], cwd=APP, env=env,
        stdout=open("/home/hatch/scratch/fossbilling/r5-logs/next-3003-r5g.log", "w"),
        stderr=subprocess.STDOUT)
    for _ in range(40):
        try:
            urllib.request.urlopen(TS_FORCED + "/__prime", timeout=3).read()
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("forced :3003 did not come up")


def start_oracle():
    global oracle_proc
    try:
        urllib.request.urlopen(PHP_PROD + "/login", timeout=3).read()
        raise SystemExit(":8081 already answers — refusing to start a second oracle")
    except SystemExit:
        raise
    except Exception:
        pass
    env = dict(os.environ)
    env.pop("APP_ENV", None)
    oracle_proc = subprocess.Popen(
        ["/home/hatch/scratch/bin/php", "-S", "127.0.0.1:8081"],
        cwd=SRC, env={**env, "PHP_CLI_SERVER_WORKERS": "4"},
        stdout=open("/home/hatch/scratch/fossbilling/r5-logs/php-8081-r5g-parity.log", "w"),
        stderr=subprocess.STDOUT)
    for _ in range(30):
        try:
            urllib.request.urlopen(PHP_PROD + "/login", timeout=3).read()
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("oracle :8081 did not come up")


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


def main():
    global forced_proc, oracle_proc
    # PHP client login creates a cart row for the new session (observed:
    # a login alone adds a row; checkout adds nothing further). Snapshot
    # cart state BEFORE any login so finally can restore it exactly.
    cart_ids_start = {r["id"] for r in q("SELECT id FROM cart")}
    cart_seq_start = q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"]
    inv_before = invariants()
    for k, v in BASE_INV.items():
        check(f"inv-before {k}", inv_before.get(k) == v, f"{inv_before.get(k)} != {v}")
    check("counters empty-or-absent before", counters() == [], str(counters()))

    # Sessions: PHP-dev logins reused as TS sessions (same session table).
    admin_op = make_opener()
    admin_tok = login(admin_op, PHP_DEV, SUPER_EMAIL, SUPER_PASS, "staff")
    client_op = make_opener()
    client_tok = login(client_op, PHP_DEV, CLIENT_EMAIL, CLIENT_PASS, "client")
    # NEVER share a jar between PHP and TS: PHP API responses set a
    # path=/ fossbilling_session cookie, and a TS call carrying it
    # without a CSRF token 403s before the limiter ever runs (the
    # R5g run-1 harness bug: every "first N pass" passed on 403s
    # while the trip call 403d instead of 429ing).
    ts_anon = make_opener()
    php_anon = make_opener()

    def ts_reset(base, opener, token):
        st, _, env = ts_call(opener, token, base, "admin", "security", "rate_limit_reset_all")
        assert env.get("error") is None, str(env)[:300]
        return env

    def ts_status(base, opener, token):
        _, _, env = ts_call(opener, token, base, "admin", "security", "rate_limit_status")
        return env

    def ts_list(base, opener, token, params=None):
        _, _, env = ts_call(opener, token, base, "admin", "security", "rate_limit_get_list", params)
        return env.get("result", [])

    # ---------- 0. dev bypass (before any forced trip) ----------
    env = ts_status(TS_DEV, admin_op, admin_tok)
    check("dev status enabled:false", env.get("result", {}).get("enabled") is False, str(env)[:200])
    check("dev get_list empty", ts_list(TS_DEV, admin_op, admin_tok) == [])
    for _ in range(15):
        st, _, body = ts_call(ts_anon, None, TS_DEV, "guest", "client", "login",
                              {"email": "nobody@example.invalid", "password": "Wrong1Pass!"})
        assert st == 200 and body.get("error", {}).get("code") != 429, (st, body)
    check("dev 15 failed logins never 429", True)
    check("dev hammer created no counters", counters() == [], str(counters()))

    start_forced()
    env = ts_status(TS_FORCED, admin_op, admin_tok)
    check("forced status enabled:true", env.get("result", {}).get("enabled") is True, str(env)[:200])
    ts_reset(TS_FORCED, admin_op, admin_tok)
    check("forced reset leaves counters empty", counters() == [], str(counters()))

    # ---------- 1. rendering equality: api_guest, PHP oracle vs TS forced ----------
    start_oracle()
    try:
        oracle_op = make_opener()
        oracle_tok = login(oracle_op, PHP_PROD, SUPER_EMAIL, SUPER_PASS, "staff")
        php_trip = None
        for i in range(1, 102):
            st, hdrs, raw = raw_call(php_anon, PHP_PROD + "/api/guest/system/company", method="GET")
            if i == 101:
                php_trip = (st, hdrs, jbody(raw))
        check("php api_guest 101st is 429", php_trip[0] == 429, str(php_trip[0]))
        check("php api_guest Retry-After 60", php_trip[1].get("Retry-After") == "60", str(php_trip[1].get("Retry-After")))
        check("php api_guest body exact", php_trip[2] == {"result": None, "error": {
            "message": "Rate limit exceeded. Please try again later.", "code": 429}}, str(php_trip[2])[:200])
        ts_trip = None
        for i in range(1, 102):
            st, hdrs, body = ts_call(ts_anon, None, TS_FORCED, "guest", "system", "company")
            if i == 101:
                ts_trip = (st, hdrs, body)
        check("ts api_guest 101st is 429", ts_trip[0] == 429, str(ts_trip[0]))
        check("ts api_guest Retry-After 60", ts_trip[1].get("retry-after") == "60", str(ts_trip[1].get("retry-after")))
        check("ts api_guest body exact", ts_trip[2] == {"result": None, "error": {
            "message": "Rate limit exceeded. Please try again later.", "code": 429}}, str(ts_trip[2])[:200])
        check("rendering status equal", php_trip[0] == ts_trip[0])
        check("rendering Retry-After equal", php_trip[1].get("Retry-After") == ts_trip[1].get("retry-after"))
        check("rendering body equal", php_trip[2] == ts_trip[2])
        php_call(oracle_op, oracle_tok, PHP_PROD, "admin", "security", "rate_limit_reset_all")
        ts_reset(TS_FORCED, admin_op, admin_tok)
    finally:
        kill_proc(oracle_proc)
        oracle_proc = None
        time.sleep(1)
        try:
            urllib.request.urlopen(PHP_PROD + "/login", timeout=2).read()
            check("oracle down after section 1", False, "still answers")
        except Exception:
            check("oracle down after section 1", True)

    # ---------- 2. boundaries, 429 policies ----------
    def expect_trip(label, calls):
        """calls: list of (status, body) — all but last must be a clean
        non-429 AND non-403 (a 403 pre-trip would mean the call never
        reached the limiter, e.g. a stray session cookie — the run-1
        harness bug — and must fail loudly, not pass as 'non-429')."""
        ok = all(c[0] == 200 and (c[1].get("error") or {}).get("code") not in (429, 403) for c in calls[:-1])
        check(f"{label} first N pass", ok, str(calls[-2:])[:300])
        last_st, last_body = calls[-1]
        check(f"{label} N+1 trips 429", last_st == 429 and last_body.get("error", {}).get("code") == 429,
              f"{last_st} {str(last_body)[:200]}")
        return calls[-1]

    # 2a api_login (failed auth counts: all attempts use wrong passwords)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "client", "login",
                     {"email": "nobody@example.invalid", "password": "Wrong1Pass!"}) for _ in range(11)]
    trip = expect_trip("api_login", [(s, b) for s, _, b in calls])
    _, hdrs, _ = calls[-1]
    ra = hdrs.get("retry-after")
    check("api_login Retry-After in (3000,3600]", ra is not None and 3000 < int(ra) <= 3600, str(ra))

    # 2b client_signup (mismatched passwords: handler error, seam consumed first)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "client", "create",
                     {"email": "new.r5g@example.com", "first_name": "R", "password": "Strong1Pass!",
                      "password_confirm": "Different2Pass!"}) for _ in range(6)]
    expect_trip("client_signup", [(s, b) for s, _, b in calls])
    check("client_signup first 5 are password-mismatch",
          all("Passwords do not match" in (c[2].get("error") or {}).get("message", "") for c in calls[:5]),
          str([c[2] for c in calls[:2]])[:200])

    # 2c guest_ticket_create (short content: TS seam consumes before validation)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "support", "ticket_create",
                     {"content": "x", "name": "T", "email": "t@example.com", "subject": "s"}) for _ in range(4)]
    expect_trip("guest_ticket_create", [(s, b) for s, _, b in calls])

    # 2d domain_lookup_ip (invalid SLD: handler error after consume)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "servicedomain", "check",
                     {"tld": ".com", "sld": "!!!"}) for _ in range(61)]
    expect_trip("domain_lookup_ip", [(s, b) for s, _, b in calls])

    # 2e cart_promo_apply_ip (bogus code)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "cart", "apply_promo",
                     {"promocode": "NOPE-R5G"}) for _ in range(11)]
    expect_trip("cart_promo_apply_ip", [(s, b) for s, _, b in calls])
    # endpoint isolation: a different endpoint's policy is unaffected
    st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "servicedomain", "check",
                          {"tld": ".com", "sld": "!!!"})
    check("endpoint isolation (promo tripped, domain passes)", st != 429, str(body)[:150])

    # 2f/2g/2h invoice ip+hash (bogus hash: handler error after consume)
    for method, ipp, hp in (("get", "invoice_get_ip", "invoice_get_hash"),
                            ("payment", "invoice_payment_ip", "invoice_payment_hash"),
                            ("pdf", "invoice_pdf_ip", "invoice_pdf_hash")):
        ts_reset(TS_FORCED, admin_op, admin_tok)
        calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "invoice", method,
                         {"hash": "0" * 40}) for _ in range(11)]
        expect_trip(f"invoice {method} ip", [(s, b) for s, _, b in calls])
        check(f"invoice {method} ip row 11 (debt)", counter_count(ipp) == 11, str(counter_count(ipp)))
        check(f"invoice {method} hash row 10 (shadowed)", counter_count(hp) == 10, str(counter_count(hp)))

    # 2i order_generation_ip (empty-cart checkout error after consume)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    cart_ids_before = {r["id"] for r in q("SELECT id FROM cart")}
    cart_seq_before = q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"]
    calls = [ts_call(client_op, client_tok, TS_FORCED, "client", "cart", "checkout", {}) for _ in range(16)]
    expect_trip("order_generation_ip", [(s, b) for s, _, b in calls])
    check("checkout first 15 are empty-cart errors",
          all("empty cart" in (c[2].get("error") or {}).get("message", "") for c in calls[:15]),
          str([c[2] for c in calls[:2]])[:200])
    new_carts = [cid for cid in {r["id"] for r in q("SELECT id FROM cart")} - cart_ids_before]
    if new_carts:
        d = sqlite3.connect(DBP)
        for cid in new_carts:
            d.execute("DELETE FROM cart WHERE id = ?", (cid,))
        d.execute("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cart'", (cart_seq_before,))
        d.commit()
        d.close()
    check("checkout probe cart rows cleaned", {r["id"] for r in q("SELECT id FROM cart")} == cart_ids_before)

    # 2j confirm_post policies (bogus hash/code: handler error after consume)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "client", "update_password",
                     {"hash": "0" * 64, "password": "Strong1Pass!", "password_confirm": "Strong1Pass!"})
             for _ in range(21)]
    expect_trip("client_password_reset_confirm_post_ip", [(s, b) for s, _, b in calls])
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "staff", "update_password",
                     {"code": "0" * 64, "password": "Strong1Pass!", "password_confirm": "Strong1Pass!"})
             for _ in range(21)]
    expect_trip("staff_password_reset_confirm_post_ip", [(s, b) for s, _, b in calls])

    # 2k profile_password_change account 5 + ip 30 (wrong current password)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(admin_op, admin_tok, TS_FORCED, "admin", "profile", "change_password",
                     {"current_password": "Wrong1Pass!", "new_password": "Strong1Pass!",
                      "confirm_password": "Strong1Pass!"}) for _ in range(6)]
    expect_trip("profile_password_change_account", [(s, b) for s, _, b in calls])
    check("profile ip row 6 after account trip", counter_count("profile_password_change_ip") == 6,
          str(counter_count("profile_password_change_ip")))
    for _ in range(25):  # calls 7..31: ip consumes, account trips
        ts_call(admin_op, admin_tok, TS_FORCED, "admin", "profile", "change_password",
                {"current_password": "Wrong1Pass!", "new_password": "Strong1Pass!",
                 "confirm_password": "Strong1Pass!"})
    check("profile ip row 31 after passthrough", counter_count("profile_password_change_ip") == 31,
          str(counter_count("profile_password_change_ip")))
    listed = ts_list(TS_FORCED, admin_op, admin_tok, {"ip": "127.0.0.1"})
    check("profile ip listed limited", any(
        e.get("policy") == "profile_password_change_ip" and e.get("limited") for e in listed), str(listed)[:300])
    # user isolation: reset only the ip policy, client account still passes
    st, _, env = ts_call(admin_op, admin_tok, TS_FORCED, "admin", "security", "rate_limit_reset_ip",
                         {"ip": "127.0.0.1", "policy": "profile_password_change_ip"})
    check("reset profile ip policy", env.get("result", {}).get("removed", 0) >= 1, str(env)[:200])
    st, _, body = ts_call(client_op, client_tok, TS_FORCED, "client", "profile", "change_password",
                          {"current_password": "Wrong1Pass!", "new_password": "Strong1Pass!",
                           "confirm_password": "Strong1Pass!"})
    check("user isolation (admin tripped, client passes)",
          st != 429 and "Current password incorrect" in (body.get("error") or {}).get("message", ""),
          f"{st} {str(body)[:200]}")

    # 2l client_email_resend account 5 + ip 30 (bogus history id: error after consume)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(client_op, client_tok, TS_FORCED, "client", "email", "resend", {"id": "999999"})
             for _ in range(6)]
    expect_trip("client_email_resend_account", [(s, b) for s, _, b in calls])
    for _ in range(25):  # calls 7..31
        ts_call(client_op, client_tok, TS_FORCED, "client", "email", "resend", {"id": "999999"})
    check("email resend ip row 31 after passthrough", counter_count("client_email_resend_ip") == 31,
          str(counter_count("client_email_resend_ip")))
    listed = ts_list(TS_FORCED, admin_op, admin_tok, {"ip": "127.0.0.1"})
    check("email resend ip listed limited", any(
        e.get("policy") == "client_email_resend_ip" and e.get("limited") for e in listed), str(listed)[:300])

    # 2m client_email_verification_resend account 3 + ip 30 (clients are NULL-approved: proceeds)
    ts_reset(TS_FORCED, admin_op, admin_tok)
    qmax_before = q("SELECT MAX(id) m FROM email_queue")[0]["m"] or 0
    qseq_before = q("SELECT seq FROM sqlite_sequence WHERE name = 'email_queue'")[0]["seq"]
    mseq_before = q("SELECT seq FROM sqlite_sequence WHERE name = 'extension_meta'")[0]["seq"]
    meta_before = q("SELECT * FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = 1")
    calls = [ts_call(client_op, client_tok, TS_FORCED, "client", "client", "resend_email_verification", {})
             for _ in range(4)]
    check("verification resend first 3 true",
          all(c[2].get("error") is None and c[2].get("result") is True for c in calls[:3]),
          str([c[2] for c in calls])[:300])
    check("verification resend 4th 429", calls[3][0] == 429, str(calls[3][2])[:200])
    for _ in range(27):  # calls 5..31
        ts_call(client_op, client_tok, TS_FORCED, "client", "client", "resend_email_verification", {})
    check("verification resend ip row 31", counter_count("client_email_verification_resend_ip") == 31,
          str(counter_count("client_email_verification_resend_ip")))
    listed = ts_list(TS_FORCED, admin_op, admin_tok, {"ip": "127.0.0.1"})
    check("verification resend ip listed limited", any(
        e.get("policy") == "client_email_verification_resend_ip" and e.get("limited") for e in listed),
        str(listed)[:300])
    d = sqlite3.connect(DBP)
    d.execute("DELETE FROM email_queue WHERE id > ?", (qmax_before,))
    d.execute("UPDATE sqlite_sequence SET seq = ? WHERE name = 'email_queue'", (qseq_before,))
    d.execute("DELETE FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = 1")
    for row in meta_before:
        cols = list(row.keys())
        d.execute(f"INSERT INTO extension_meta ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                  [row[c] for c in cols])
    d.execute("UPDATE sqlite_sequence SET seq = ? WHERE name = 'extension_meta'", (mseq_before,))
    d.commit()
    d.close()
    check("verification resend queue rows cleaned",
          q("SELECT COUNT(*) c FROM email_queue")[0]["c"] == 67)
    check("verification resend sequences restored",
          q("SELECT seq FROM sqlite_sequence WHERE name = 'email_queue'")[0]["seq"] == qseq_before
          and q("SELECT seq FROM sqlite_sequence WHERE name = 'extension_meta'")[0]["seq"] == mseq_before)

    # 2n silent client password-reset request: ip 10 + email 3, all return true
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "client", "reset_password",
                     {"email": "parity40.unknown@example.invalid"}) for _ in range(11)]
    check("client reset request all true (silent)",
          all(c[2].get("error") is None and c[2].get("result") is True for c in calls),
          str([c[2] for c in calls])[:300])
    check("client reset ip row 11", counter_count("client_password_reset_ip") == 11,
          str(counter_count("client_password_reset_ip")))
    check("client reset email row 10 (11th short-circuited)",
          counter_count("client_password_reset_email") == 10,
          str(counter_count("client_password_reset_email")))
    listed = ts_list(TS_FORCED, admin_op, admin_tok, {"ip": "127.0.0.1"})
    check("client reset ip listed limited", any(
        e.get("policy") == "client_password_reset_ip" and e.get("limited") for e in listed), str(listed)[:300])

    # 2o silent staff password-reset request: ip 5 + email 3, all return true
    ts_reset(TS_FORCED, admin_op, admin_tok)
    calls = [ts_call(ts_anon, None, TS_FORCED, "guest", "staff", "passwordreset",
                     {"email": "parity40.unknown@example.invalid"}) for _ in range(6)]
    check("staff reset request all true (silent)",
          all(c[2].get("error") is None and c[2].get("result") is True for c in calls),
          str([c[2] for c in calls])[:300])
    check("staff reset ip row 6", counter_count("staff_password_reset_ip") == 6,
          str(counter_count("staff_password_reset_ip")))
    check("staff reset email row 5 (6th short-circuited)",
          counter_count("staff_password_reset_email") == 5,
          str(counter_count("staff_password_reset_email")))

    # 2p signup-email probe gating (existing client email, wrong password).
    # The signup IP budget is 5, so 6 same-IP calls would trip the IP
    # policy on the 6th call before the handler ever probes (run-2
    # lesson). Instead each call spoofs a distinct XFF IP: the IP
    # budget stays fresh per call while the EMAIL quota accumulates —
    # which is exactly what the policy is for (spreading probes across
    # IPs must not help hammer one address, per PHP's comment).
    ts_reset(TS_FORCED, admin_op, admin_tok)
    for k in range(6):
        st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "create",
                              {"email": CLIENT_EMAIL, "first_name": "R", "password": "Wrong1Pass!",
                               "password_confirm": "Wrong1Pass!"},
                              headers={"X-Forwarded-For": f"203.0.113.{11 + k}"})
        assert body.get("error") is None and body.get("result") is True, str(body)[:200]
    check("signup email row stays 5 after probe-limited 6th",
          counter_count("client_signup_email") == 5, str(counter_count("client_signup_email")))

    # 2q authenticated policies: counter arithmetic (1000-trip impractical).
    # Both are TOKEN-BUCKET policies, so the proof reads `tokens`
    # (1000 - 5 = 995), not `count` — see counter_tokens().
    # PHP consumes BOTH for an authenticated call: pre-auth
    # api_authenticated_ip (IP subject) + post-auth
    # api_authenticated_account (account subject).
    ts_reset(TS_FORCED, admin_op, admin_tok)
    for _ in range(5):
        ts_status(TS_FORCED, admin_op, admin_tok)
    check("authenticated account tokens 995", counter_tokens("api_authenticated_account") == 995,
          str(counter_tokens("api_authenticated_account")))
    check("authenticated ip tokens 995", counter_tokens("api_authenticated_ip") == 995,
          str(counter_tokens("api_authenticated_ip")))
    # NOTE: the 1000 limits are counter-proven only (row arithmetic above
    # + the config value in ratelimit.ts DEFAULT_POLICIES); tripping
    # them live needs 1000 calls and is not attempted — see findings.

    # ---------- 3. window semantics (one shared wait) ----------
    ts_reset(TS_FORCED, admin_op, admin_tok)
    t0_fixed = time.time()
    for _ in range(21):
        st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "update_password",
                              {"hash": "0" * 64, "password": "Strong1Pass!", "password_confirm": "Strong1Pass!"})
    check("window: 21st confirm_post 429", st == 429, str(body)[:150])
    t0_bucket = time.time()
    for _ in range(101):
        st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "system", "company")
    check("window: 101st api_guest 429", st == 429, str(body)[:150])
    st, _, _ = ts_call(ts_anon, None, TS_FORCED, "guest", "system", "company")
    check("window: immediate bucket retry still 429 (wholesale refill)", st == 429, str(st))
    wait = max(t0_fixed, t0_bucket) + 62 - time.time()
    if wait > 0:
        print(f"window: waiting {wait:.1f}s to cross both first-call window edges")
        time.sleep(wait)
    st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "update_password",
                          {"hash": "0" * 64, "password": "Strong1Pass!", "password_confirm": "Strong1Pass!"})
    check("window: confirm_post passes after edge (fixed, not sliding)",
          st != 429 and (body.get("error") or {}).get("code") == 9999, f"{st} {str(body)[:200]}")
    st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "system", "company")
    check("window: api_guest passes after refill interval", st != 429, f"{st} {str(body)[:200]}")

    # ---------- 4. scope isolation: XFF IP ----------
    ts_reset(TS_FORCED, admin_op, admin_tok)
    xff = {"X-Forwarded-For": "203.0.113.7"}
    for _ in range(11):
        st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "login",
                              {"email": "nobody@example.invalid", "password": "Wrong1Pass!"}, headers=xff)
    check("isolation: XFF IP trips on 11th", st == 429, f"{st} {str(body)[:150]}")
    st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "login",
                          {"email": "nobody@example.invalid", "password": "Wrong1Pass!"})
    check("isolation: loopback IP unaffected (401, not 429)",
          st != 429 and (body.get("error") or {}).get("code") == 401, f"{st} {str(body)[:200]}")

    # ---------- 6. counter persistence across a forced-server restart ----------
    ts_reset(TS_FORCED, admin_op, admin_tok)
    for _ in range(11):
        st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "login",
                              {"email": "nobody@example.invalid", "password": "Wrong1Pass!"})
    check("persistence: tripped before restart", st == 429, f"{st}")
    kill_proc(forced_proc)
    forced_proc = None
    start_forced()
    st, _, body = ts_call(ts_anon, None, TS_FORCED, "guest", "client", "login",
                          {"email": "nobody@example.invalid", "password": "Wrong1Pass!"})
    check("persistence: still tripped after restart (DB-backed)", st == 429, f"{st} {str(body)[:150]}")

    # ---------- cleanup + invariants ----------
    try:
        ts_reset(TS_FORCED, admin_op, admin_tok)
    except Exception as e:
        print("final reset issue:", e)
    check("counters empty at end", counters() == [], str(counters()))
    # Login-created cart rows (see snapshot note at main() start).
    d = sqlite3.connect(DBP)
    for cid in {r["id"] for r in q("SELECT id FROM cart")} - cart_ids_start:
        d.execute("DELETE FROM cart WHERE id = ?", (cid,))
    d.execute("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cart'", (cart_seq_start,))
    d.commit()
    d.close()
    check("cart rows restored to start", {r["id"] for r in q("SELECT id FROM cart")} == cart_ids_start)
    inv_after = invariants()
    for k, v in BASE_INV.items():
        check(f"inv-after {k}", inv_after.get(k) == v, f"{inv_after.get(k)} != {v}")

    print(f"\nparity40: {CHECKS - len(FAILURES)}/{CHECKS} passed")
    if FAILURES:
        print("FAILURES:", FAILURES)
        raise SystemExit(1)
    print("PARITY40 OK")


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            kill_proc(forced_proc)
            forced_proc = None
        except Exception:
            pass
        try:
            kill_proc(oracle_proc)
            oracle_proc = None
        except Exception:
            pass
        # npx orphans its next-server child past a SIGTERM to npx, so
        # the PID kill alone leaks :3003 (run-1 lesson): kill by port,
        # with a retry loop — a single fuser pass demonstrably missed
        # the section-5 restarted server in run 3.
        for _ in range(3):
            try:
                subprocess.run(["/usr/bin/fuser", "-k", "3003/tcp"], capture_output=True, timeout=10)
                subprocess.run(["/usr/bin/fuser", "-k", "8081/tcp"], capture_output=True, timeout=10)
            except Exception as e:
                print("fuser issue:", e)
            time.sleep(2)
            down = True
            for port in (3003, 8081):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read()
                    down = False
                except Exception:
                    pass
            if down:
                break
        # Never leave a forced server or oracle behind; counters must not
        # throttle later suites — best-effort direct cleanup if the
        # script died before its own reset.
        try:
            d = sqlite3.connect(DBP)
            d.execute("DELETE FROM rate_limit_counter")
            d.commit()
            d.close()
        except Exception:
            pass
        for port in (3003, 8081):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2).read()
                print(f"WARNING: port {port} still answers after finally")
            except Exception:
                pass
