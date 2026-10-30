#!/usr/bin/env python3
"""R6a capture corpus: PHP behavior OBSERVED live, before any R6a code change.

Captures (all against the live PHP dev oracle :8080 unless noted):
  A. PHP /login Set-Cookie headers (what the current __prime relays).
  B. PHP dispatcher error shapes: 740 unknown method per role, 715
     unknown/inactive module (proves 740 loses to 715), removed
     endpoints (proves removal error preempts 740), literal
     admin/servicecustom/__call (PHP's 9998, NOT 740), non-3-segment
     paths (what PHP's router does — TS must NOT proxy these after R6a).
  C. PHP URL-construction outputs: navigation links, extension
     get_list icon_url shape, guest system company www, gateway
     callback field.
  D. UI page baselines via :3001 with PHP UP (fbCall -> PHP): admin
     clients page + client dashboard markers, for parity44's PHP-down
     renders to compare against.
  E. TS pre-R6a probes via :3001 (proxy path): the same 740 probes,
     proving today's seam returns PHP's shapes THROUGH the proxy.

Login-created session/cart rows are snapshotted by id SET and deleted
in finally (R5h lesson: never id-range deletes). No other reference
mutation. Exit 0 iff captures were written (captures are data, not
assertions — parity44 asserts against them).
"""

import http.client
import json
import os
import sqlite3
import sys
import urllib.request
import urllib.parse
import http.cookiejar

REPO = "/home/hatch/scratch/fossbilling/repo"
PHASE5 = os.path.join(REPO, "docs", "nextjs-strangler", "phase5")
OUT = os.path.join(PHASE5, "captures47")
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001"
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PW = "Phase0-Client!42"

os.makedirs(OUT, exist_ok=True)
captures = {}


def snapshot_ids():
    db = sqlite3.connect(f"file:{DBP}?mode=ro", uri=True)
    s = set(r[0] for r in db.execute("SELECT id FROM session").fetchall())
    c = set(r[0] for r in db.execute("SELECT id FROM cart").fetchall())
    db.close()
    return s, c


def cleanup_login_rows(s_before, c_before):
    db = sqlite3.connect(DBP)
    s_now = set(r[0] for r in db.execute("SELECT id FROM session").fetchall())
    c_now = set(r[0] for r in db.execute("SELECT id FROM cart").fetchall())
    for sid in sorted(s_now - s_before):
        db.execute("DELETE FROM session WHERE id = ?", (sid,))
    for cid in sorted(c_now - c_before):
        db.execute("DELETE FROM cart WHERE id = ?", (cid,))
    db.commit()
    db.close()
    return {"sessions_removed": sorted(s_now - s_before),
            "carts_removed": sorted(c_now - c_before)}


class Api:
    def __init__(self, base, prefix="/api"):
        self.base = base
        self.prefix = prefix
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj))

    def csrf(self):
        for c in self.cj:
            if c.name == "fossbilling_csrf":
                return c.value
        return None

    def call(self, role, module, method, data=None, raw=False):
        payload = dict(data or {})
        tok = self.csrf()
        if tok:
            payload["CSRFToken"] = tok
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(
            f"{self.base}{self.prefix}/{role}/{module}/{method}", data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            with self.op.open(req, timeout=30) as r:
                text = r.read().decode("utf-8", "replace")
                return r.status, (text if raw else json.loads(text))
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(text)
            except Exception:
                return e.code, {"_raw": text[:500]}

    def get(self, path):
        req = urllib.request.Request(f"{self.base}{path}")
        try:
            with self.op.open(req, timeout=30) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")[:500]


def login(api, role_api, email, pw):
    # Prime FIRST (parity42's fresh() pattern): PHP login REQUIRES a
    # primed session — GET /login seeds session + csrf cookies, and the
    # login POST must present that csrf token. An unprimed login POST
    # 403s ("CSRF token invalid") even on a fresh jar, because PHP
    # auto-creates a session for the request and then enforces its
    # token. (TS login does not need priming — its CSRF check passes
    # with no session — but priming via __prime is harmless there and
    # keeps the helper identical for both stacks.)
    prime = f"{api.base}/login" if ":8080" in api.base else f"{api.base}/api/fb/__prime"
    try:
        api.op.open(prime, timeout=30).read()
    except Exception:
        pass
    st, env = api.call("guest", role_api, "login",
                       {"email": email, "password": pw})
    assert env.get("error") is None, f"login failed: {env}"
    return env


def main():
    s_before, c_before = snapshot_ids()
    try:
        # ---- A: PHP /login Set-Cookie headers (raw) ----
        conn = http.client.HTTPConnection("127.0.0.1", 8080, timeout=30)
        conn.request("GET", "/login", headers={"Accept": "text/html"})
        resp = conn.getresponse()
        body = resp.read()
        set_cookies = [v for k, v in resp.getheaders()
                       if k.lower() == "set-cookie"]
        captures["A_login_cookies"] = {
            "status": resp.status,
            "set_cookie": set_cookies,
            "body_snippet": body[:200].decode("utf-8", "replace"),
        }
        print("A login:", resp.status, set_cookies)
        conn.close()

        php = Api(PHP)
        # ---- B: dispatcher shapes ----
        # NOTE: login FIRST on a fresh jar. An anonymous PHP API call
        # before login leaves a pre-session fossbilling_csrf cookie in
        # the jar, and presenting it at login time 403s ("CSRF token
        # invalid") — PHP auto-starts sessions on API calls, so the
        # anonymous token does not survive login's session regeneration.
        # (TS has no such trap: it creates sessions only at login.)

        # Admin session on PHP.
        login(php, "staff", ADMIN_EMAIL, ADMIN_PW)
        st, env = php.call("guest", "system", "company")
        captures["B0_guest_company_baseline"] = {"http": st, "env": env}
        admin_csrf = php.csrf()
        st, env = php.call("admin", "invoice", "zzz_nope")
        captures["B1_740_admin_unknown_method"] = {"http": st, "env": env}
        print("B1:", st, env)
        st, env = php.call("admin", "nosuchmod", "get_list")
        captures["B2_715_admin_unknown_module"] = {"http": st, "env": env}
        print("B2:", st, env)
        st, env = php.call("admin", "embed", "get_list")
        captures["B3_715_admin_inactive_module"] = {"http": st, "env": env}
        print("B3:", st, env)
        st, env = php.call("admin", "invoice", "foo")
        captures["B4_740_admin_bare_method"] = {"http": st, "env": env}
        print("B4:", st, env)
        # NOTE (B5–B7): these call PHP DIRECTLY, and PHP still
        # implements all three — removal exists only on the TS side.
        # They prove removal is a TS-side concept, NOT a PHP error:
        # the removal-preempts-740 proof is TS-side (F3 + parity44),
        # where the route hoist + registered removal handlers return
        # the removal error before any handler resolution.
        st, env = php.call("admin", "system", "update_available")
        captures["B5_php_still_implements_removed_system"] = {"http": st, "env": env}
        print("B5:", st, env)
        st, env = php.call("admin", "extension", "install")
        captures["B6_php_still_implements_removed_extension"] = {"http": st, "env": env}
        print("B6:", st, env)
        st, env = php.call("guest", "system", "template_exists")
        captures["B7_php_still_implements_removed_guest"] = {"http": st, "env": env}
        print("B7:", st, env)
        st, env = php.call("admin", "servicecustom", "__call")
        captures["B8_literal_call_admin_servicecustom"] = {"http": st, "env": env}
        print("B8:", st, env)
        st, env = php.call("admin", "servicecustom", "zzz_nope")
        captures["B9_magic_admin_servicecustom"] = {"http": st, "env": env}
        print("B9:", st, env)
        st, env = php.call("guest", "system", "zzz_nope")
        captures["B10_740_guest_unknown_method"] = {"http": st, "env": env}
        print("B10:", st, env)

        # Client session on PHP.
        php_c = Api(PHP)
        login(php_c, "client", CLIENT_EMAIL, CLIENT_PW)
        st, env = php_c.call("client", "invoice", "zzz_nope")
        captures["B11_740_client_unknown_method"] = {"http": st, "env": env}
        print("B11:", st, env)
        st, env = php_c.call("admin", "invoice", "get_list")
        captures["B12_client_calling_admin_role"] = {"http": st, "env": env}
        print("B12:", st, env)

        # Non-3-segment paths against PHP's router.
        for name, path in [("C1_two_segment", "/api/admin/invoice"),
                           ("C2_four_segment", "/api/admin/invoice/get_list/extra"),
                           ("C3_one_segment", "/api/unknown")]:
            st, text = php.get(path)
            captures[name] = {"http": st, "body": text}
            print(name, st, text[:200].replace("\n", " "))

        # ---- C: URL-construction outputs (PHP) ----
        st, env = php.call("admin", "extension", "get_navigation")
        nav = env.get("result") if isinstance(env, dict) else None
        captures["D1_php_navigation"] = {"http": st, "result": nav}
        st, env = php.call("admin", "extension", "get_list")
        res = env.get("result") if isinstance(env, dict) else None
        lst = res if isinstance(res, list) else (res or {}).get("list", [])
        captures["D2_php_extension_list_sample"] = {
            "http": st,
            "result_shape": "list" if isinstance(res, list) else "dict",
            "icon_urls": [e.get("icon_url") for e in lst[:5]],
        }
        print("D2:", st, captures["D2_php_extension_list_sample"])
        st, env = php.call("guest", "system", "company")
        captures["D3_php_company"] = {"http": st, "env": env}
        st, env = php.call("admin", "invoice", "gateway_get", {"id": 1})
        captures["D4_php_gateway_get"] = {"http": st, "env": env}
        print("D4:", st, str(env)[:300])

        # ---- D: UI page baselines via :3001 (PHP UP, fbCall -> PHP) ----
        ts_admin = Api(TS)
        login(ts_admin, "staff", ADMIN_EMAIL, ADMIN_PW)
        cookie_hdr = "; ".join(f"{c.name}={c.value}" for c in ts_admin.cj)
        for name, path in [("E1_admin_clients", "/admin/clients"),
                           ("E2_admin_dashboard", "/admin"),
                           ("E3_admin_invoices", "/admin/invoices")]:
            req = urllib.request.Request(
                f"{TS}{path}", headers={"Cookie": cookie_hdr})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    html = r.read().decode("utf-8", "replace")
                    captures[name] = {"http": r.status, "len": len(html),
                                      "markers": [m for m in
                                                  ("Clients", "Invoices", "Dashboard",
                                                   CLIENT_EMAIL, "Phase0")
                                                  if m in html]}
            except urllib.error.HTTPError as e:
                captures[name] = {"http": e.code, "len": 0, "markers": []}
            print(name, captures[name])
        ts_client = Api(TS)
        login(ts_client, "client", CLIENT_EMAIL, CLIENT_PW)
        cookie_hdr_c = "; ".join(f"{c.name}={c.value}" for c in ts_client.cj)
        req = urllib.request.Request(
            f"{TS}/dashboard", headers={"Cookie": cookie_hdr_c})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                html = r.read().decode("utf-8", "replace")
                captures["E4_client_dashboard"] = {
                    "http": r.status, "len": len(html),
                    "markers": [m for m in ("Dashboard", "Invoices", "Orders")
                                if m in html]}
        except urllib.error.HTTPError as e:
            captures["E4_client_dashboard"] = {"http": e.code, "len": 0,
                                               "markers": []}
        print("E4", captures["E4_client_dashboard"])

        # ---- E: TS pre-R6a probes (proxy path) ----
        # NOTE: the TS seam lives under /api/fb, not /api — the first
        # run of this section used /api and got Next 404 HTML.
        ts = Api(TS, prefix="/api/fb")
        login(ts, "staff", ADMIN_EMAIL, ADMIN_PW)
        st, env = ts.call("admin", "invoice", "zzz_nope")
        captures["F1_ts_preR6a_740_admin"] = {"http": st, "env": env}
        print("F1:", st, env)
        st, env = ts.call("admin", "nosuchmod", "get_list")
        captures["F2_ts_preR6a_unknown_module"] = {"http": st, "env": env}
        print("F2:", st, env)
        st, env = ts.call("admin", "system", "update_available")
        captures["F3_ts_preR6a_removed"] = {"http": st, "env": env}
        print("F3:", st, env)
        st, env = ts.call("admin", "servicecustom", "__call")
        captures["F4_ts_preR6a_literal_call"] = {"http": st, "env": env}
        print("F4:", st, env)
    finally:
        captures["Z_cleanup"] = cleanup_login_rows(s_before, c_before)
        print("Z cleanup:", captures["Z_cleanup"])

    with open(os.path.join(OUT, "capture47.json"), "w") as f:
        json.dump(captures, f, indent=2, default=str)
    print(f"wrote {os.path.join(OUT, 'capture47.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
