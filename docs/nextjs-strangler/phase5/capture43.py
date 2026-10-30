#!/usr/bin/env python3
"""R5g capture43: PHP rate limiter behavior OBSERVED on the :8081 prod oracle.

The reference install runs PHP with APP_ENV=dev (limiter bypassed), so
the oracle runs the same src WITHOUT APP_ENV (= production per
Environment::getCurrentEnvironment: unset resolves to prod) on :8081.
The oracle shares the reference DB but PHP counters live in
data/cache/rate_limit_* files, NOT the DB, so tripping the oracle
cannot pollute reference DB rows. The oracle is killed in finally and
its counters are reset (admin reset_all) before shutdown.

Trip budget (api_login 10/hour, fixed window):
- 1 consume: the admin login itself (guest/staff/login -> api_login).
- 9 failed client logins: consumes 2..10, all credential errors.
- 1 failed client login: consume 11 -> 429 (the rendering proof).
- reset_all, then 1 failed login proves the reset (consume 1 again).
- reset_all again in finally so no trip survives into later suites.

Sections:
 A. status on oracle (expect enabled:true) vs dev :8080 (enabled:false)
    and TS dev-default :3001 (enabled:false).
 B. 60s fixed-window policy (client_password_reset_confirm_post_ip,
    20/60s) via guest/client/update_password with a bogus hash:
    20 credential-ish errors, 21st -> 429; wait past the first call's
    window edge (t0+62s) -> passes again. Pass-after-wait proves the
    window is anchored at the FIRST call (fixed), not sliding: under a
    sliding window the t0..t0+3s calls would still be inside 60s at
    t0+62s... (checked: at t0+62 the earliest calls are 59-62s old;
    a sliding 60s window would still count the t0+3s ones, so a pass
    at t0+62 rules sliding out only together with the trip at 21 —
    recorded honestly as fixed-window-consistent, not a proof of the
    internal timer field).
 C. api_guest token bucket (100/60s) via guest/system/company:
    100 passes, 101st -> 429 with Retry-After header; immediate retry
    still 429 (wholesale refill: nothing refills before a full 60s).
 D. api_login boundary + rendering (see budget above) + failed-auth
    counting (all 11 attempts used WRONG passwords — the trip proves
    failed logins consume, since the post-auth check precedes the
    credential validation in Client.php _apiCall).
 E. admin surfaces on the oracle: get_list entry shape after a trip,
    search filter, reset_ip shape, reset_all shape.
"""
import glob
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PHP_DEV = "http://127.0.0.1:8080"
PHP_PROD = "http://127.0.0.1:8081"
TS = "http://127.0.0.1:3001/api/fb"
SRC = "/home/hatch/scratch/fossbilling/runtime/src"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "captures43"
OUT.mkdir(exist_ok=True)

SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"

oracle = None


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


def php_call(opener, token, base, role, module, method, params=None):
    payload = dict(params or {})
    if token:
        payload["CSRFToken"] = token
    st, hdrs, raw = raw_call(opener, f"{base}/api/{role}/{module}/{method}", payload)
    return st, hdrs, jbody(raw)


def ts_call(opener, token, role, module, method, params=None):
    payload = dict(params or {})
    if token:
        payload["CSRFToken"] = token
    st, hdrs, raw = raw_call(opener, f"{TS}/{role}/{module}/{method}", payload)
    return st, hdrs, jbody(raw)


def login(opener, base, email, password):
    resp = opener.open(base + "/login")
    page = resp.read().decode("utf-8", "replace")
    token = page.split('name="CSRFToken" value="')[1].split('"')[0]
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(base + "/api/guest/staff/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:300]
    return token


def save(name, obj):
    (OUT / name).write_text(json.dumps(obj, indent=2, default=str))
    print(f"saved captures43/{name}")


def main():
    global oracle
    # :8081 must be free; never steal another process's oracle.
    try:
        urllib.request.urlopen(PHP_PROD + "/login", timeout=3).read()
        raise SystemExit(":8081 already answers — refusing to start a second oracle")
    except SystemExit:
        raise
    except Exception:
        pass
    env = dict(os.environ)
    env.pop("APP_ENV", None)  # production: unset resolves to prod
    oracle = subprocess.Popen(
        ["/home/hatch/scratch/bin/php", "-S", "127.0.0.1:8081"],
        cwd=SRC, env={**env, "PHP_CLI_SERVER_WORKERS": "4"},
        stdout=open("/home/hatch/scratch/fossbilling/r5-logs/php-8081-r5g.log", "w"),
        stderr=subprocess.STDOUT)
    try:
        for _ in range(30):
            try:
                urllib.request.urlopen(PHP_PROD + "/login", timeout=3).read()
                break
            except Exception:
                time.sleep(1)
        else:
            raise SystemExit("oracle :8081 did not come up")

        op = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(op))
        anon = urllib.request.build_opener()

        # ---- A. status across stacks ----
        token = login(opener, PHP_PROD, SUPER_EMAIL, SUPER_PASS)
        st, hdrs, status_prod = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_status")
        dev_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        dev_token = login(dev_opener, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
        st, hdrs, status_dev = php_call(dev_opener, dev_token, PHP_DEV, "admin", "security", "rate_limit_status")
        ts_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        st, hdrs, status_ts = ts_call(ts_opener, None, "admin", "security", "rate_limit_status")
        save("a_status.json", {"oracle_prod": status_prod, "dev_php": status_dev,
                               "ts_dev_default_unauth": status_ts,
                               "note": "TS status without a session is the 201 envelope, not enabled:false; "
                                       "the dev-default enabled:false shape is proven by parity40's admin "
                                       "session call instead (see findings)."})
        print("A status prod:", status_prod, "dev:", status_dev)
        assert status_prod.get("result", {}).get("enabled") is True, status_prod
        assert status_dev.get("result", {}).get("enabled") is False, status_dev

        # ---- B. 60s fixed-window policy ----
        t0 = time.time()
        results = []
        for i in range(1, 22):
            st, hdrs, env_body = php_call(
                anon, None, PHP_PROD, "guest", "client", "update_password",
                {"hash": "0" * 64, "password": "Strong1Pass!", "password_confirm": "Strong1Pass!"})
            # Guest update_password is not in the guest-auth CSRF list
            # (only login/create/staff_login + cart ops are), so no token needed.
            results.append({"n": i, "status": st, "retry_after": hdrs.get("Retry-After"),
                            "error": (env_body.get("error") or {})})
        save("b_confirm_post_60s.json", {"t0": t0, "calls": results})
        for r in results:
            print("B", r["n"], r["status"], (r["error"] or {}).get("code"), "retry:", r["retry_after"])
        assert results[19]["status"] != 429, results[19]
        assert results[20]["status"] == 429, results[20]
        assert results[20]["error"].get("code") == 429
        assert results[20]["error"].get("message") == "Rate limit exceeded. Please try again later."
        wait = 62 - (time.time() - t0)
        if wait > 0:
            print(f"B waiting {wait:.1f}s to cross the first call's window edge")
            time.sleep(wait)
        st, hdrs, env_body = php_call(
            anon, None, PHP_PROD, "guest", "client", "update_password",
            {"hash": "0" * 64, "password": "Strong1Pass!", "password_confirm": "Strong1Pass!"})
        save("b_after_window.json", {"status": st, "retry_after": hdrs.get("Retry-After"),
                                     "error": env_body.get("error"), "elapsed_since_t0": time.time() - t0})
        print("B after window:", st, env_body.get("error"))
        assert st != 429, env_body

        # Reset everything before the next trip (admin session on oracle).
        st, hdrs, reset = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_reset_all")
        print("B reset_all:", reset)
        assert reset.get("result", {}).get("cleared") is True

        # ---- C. api_guest token bucket ----
        guest_results = []
        for i in range(1, 103):
            st, hdrs, raw = raw_call(anon, PHP_PROD + "/api/guest/system/company", method="GET")
            guest_results.append({"n": i, "status": st, "retry_after": hdrs.get("Retry-After"),
                                  "error": (jbody(raw).get("error") or {})})
        save("c_api_guest.json", {"calls": guest_results})
        for r in guest_results:
            if r["n"] >= 99:
                print("C", r["n"], r["status"], (r["error"] or {}).get("code"), "retry:", r["retry_after"])
        assert guest_results[99]["status"] != 429
        assert guest_results[100]["status"] == 429, guest_results[100]
        assert guest_results[100]["retry_after"] is not None
        st, hdrs, raw = raw_call(anon, PHP_PROD + "/api/guest/system/company", method="GET")
        print("C immediate retry:", st, hdrs.get("Retry-After"))
        assert st == 429
        save("c_api_guest_retry.json", {"status": st, "retry_after": hdrs.get("Retry-After"),
                                        "error": jbody(raw).get("error")})

        # ---- E (before login trip): get_list + search + reset_ip shapes ----
        st, hdrs, lst = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_get_list")
        st2, hdrs2, lst_search = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_get_list",
                                          {"search": "api_guest"})
        st3, hdrs3, lst_ip = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_get_list",
                                      {"ip": "127.0.0.1"})
        save("e_get_list.json", {"all": lst, "search_api_guest": lst_search, "ip_127": lst_ip})
        print("E get_list entries:", len(lst.get("result", [])), "search:", len(lst_search.get("result", [])))
        assert any(e.get("policy") == "api_guest" for e in lst.get("result", [])), lst
        st, hdrs, reset_ip = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_reset_ip",
                                      {"ip": "127.0.0.1", "policy": "api_guest"})
        save("e_reset_ip.json", {"reset_ip": reset_ip})
        print("E reset_ip:", reset_ip)
        st, hdrs, lst_after = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_get_list")
        assert not any(e.get("policy") == "api_guest" for e in lst_after.get("result", [])), lst_after
        # Reset the rest (api_guest trip also consumed nothing else, but be thorough).
        php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_reset_all")

        # ---- D. api_login boundary (budget: section B's reset_all wiped
        # the admin login's consume, so these 11 attempts ARE consumes
        # 1..11: 10 credential errors, 11th -> 429) ----
        # Guest login requires a session CSRF token (checkGuestAuthentication),
        # and the api_login check precedes it — so use a session-backed
        # opener with a valid token: the first 10 attempts then fail at
        # CREDENTIAL validation (proving failed logins consume), not at CSRF.
        login_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        login_page = login_opener.open(PHP_PROD + "/login").read().decode("utf-8", "replace")
        login_token = login_page.split('name="CSRFToken" value="')[1].split('"')[0]
        login_results = []
        for i in range(1, 12):
            st, hdrs, raw = raw_call(
                login_opener, PHP_PROD + "/api/guest/client/login",
                {"CSRFToken": login_token, "email": "nobody@example.invalid", "password": "Wrong1Pass!"})
            login_results.append({"n": i, "status": st, "retry_after": hdrs.get("Retry-After"),
                                  "error": (jbody(raw).get("error") or {})})
        save("d_api_login.json", {"calls": login_results,
                                  "note": "section B reset_all cleared the admin login's consume, so "
                                          "these are consumes 1..11"})
        for r in login_results:
            print("D", r["n"], r["status"], (r["error"] or {}).get("code"), "retry:", r["retry_after"])
        # consumes 1..10 pass (credential errors), consume 11 trips.
        assert login_results[9]["status"] != 429, login_results[9]   # consume 10
        assert login_results[10]["status"] == 429, login_results[10]  # consume 11
        assert login_results[10]["error"].get("code") == 429
        # Full rendering capture for the 429 (headers + body).
        st, hdrs, raw = raw_call(
            login_opener, PHP_PROD + "/api/guest/client/login",
            {"CSRFToken": login_token, "email": "nobody@example.invalid", "password": "Wrong1Pass!"})
        save("d_api_login_429_rendering.json", {
            "status": st, "headers": {k: v for k, v in hdrs.items()},
            "body": jbody(raw)})
        print("D rendering:", st, {k: v for k, v in hdrs.items() if k.lower() in ("retry-after", "cache-control", "content-type")})
        st, hdrs, reset2 = php_call(opener, token, PHP_PROD, "admin", "security", "rate_limit_reset_all")
        st, hdrs, raw = raw_call(
            login_opener, PHP_PROD + "/api/guest/client/login",
            {"CSRFToken": login_token, "email": "nobody@example.invalid", "password": "Wrong1Pass!"})
        save("d_after_reset.json", {"status": st, "error": jbody(raw).get("error")})
        assert st != 429
        print("CAPTURE43 OK")
    finally:
        if oracle is not None:
            try:
                # Best-effort final reset via a fresh admin login is NOT
                # attempted here (it would consume api_login again); the
                # file counters are removed directly instead — the oracle
                # is disposable and its cache dir is not the dev server's
                # enforcement state (dev bypasses the limiter).
                oracle.send_signal(signal.SIGTERM)
                oracle.wait(timeout=10)
            except Exception as e:
                print("oracle kill issue:", e)
                try:
                    oracle.kill()
                except Exception:
                    pass
        # Remove oracle rate-limit cache files so no trip survives.
        for f in glob.glob(SRC + "/data/cache/rate_limit_*"):
            try:
                if os.path.isdir(f):
                    shutil.rmtree(f, ignore_errors=True)
                else:
                    os.remove(f)
            except Exception as e:
                print("cache cleanup issue:", f, e)
        print("oracle down; rate_limit cache files removed")


if __name__ == "__main__":
    main()
