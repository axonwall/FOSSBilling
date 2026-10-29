#!/usr/bin/env python3
"""R4d PHP reference corpus for servicecustom (captures36/).

Probes the PHP stack only (empty registry semantics are observable on
both stacks, but this corpus documents the PHP side for the record):
admin __call param errors, forbidden-7 sample, empty-plugin null on
real orders 1-3, not-found / no-service errors, and client call
equivalents, plus service_custom baselines. Crafted-row cases live in
parity33.py (snapshot-restored), not here.

Writes captures36/*.json. Exit 0.
"""
import http.cookiejar
import json
import os
import re
import sqlite3
import subprocess
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "captures36")
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
PHP = "http://127.0.0.1:8080"
LOGIN = ("phase0.client@example.com", "Phase0-Client!42")
ADMIN_LOGIN = ("admin@phase0.local", "Phase1-Admin!42")


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(opener, email, password):
    resp = opener.open(PHP + "/login")
    token = re.search(rb'name="CSRFToken" value="([^"]+)"', resp.read()).group(1).decode()
    data = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password,
         "guest": json.dumps({"email": email, "password": password})}
    ).encode()
    req = urllib.request.Request(PHP + "/api/guest/client/login",
                                 data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def staff_login(opener, email, password):
    # The admin login page 404s under the PHP built-in server in this
    # runtime; the CSRF token is session-scoped, so /login's token
    # works for staff login too (probe-sc pattern).
    resp = opener.open(PHP + "/login")
    token = re.search(rb'name="CSRFToken" value="([^"]+)"', resp.read()).group(1).decode()
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(PHP + "/api/guest/staff/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def call(opener, token, role, module, method, params):
    # URLENCODED: PHP's CSRF check reads form bodies, not JSON bodies.
    payload = dict(params)
    if token:
        payload["CSRFToken"] = token
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST")
    try:
        raw = opener.open(req).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    return json.loads(raw)


def main():
    os.makedirs(OUT, exist_ok=True)
    out = {}
    op, _ = make_opener(), None
    stok = staff_login(op, *ADMIN_LOGIN)
    out["admin_empty_params"] = call(op, stok, "admin", "servicecustom", "probe_method", {})
    # __call dispatches on the URL method, not on a params["method"] key.
    out["admin_forbidden_delete"] = call(op, stok, "admin", "servicecustom", "delete",
                                         {"order_id": "1"})
    out["admin_empty_plugin_order1"] = call(op, stok, "admin", "servicecustom", "do_thing",
                                            {"order_id": "1"})
    out["admin_not_found"] = call(op, stok, "admin", "servicecustom", "probe_method",
                                  {"order_id": "999999", "method": "do_thing"})
    out["admin_no_service_167"] = call(op, stok, "admin", "servicecustom", "probe_method",
                                       {"order_id": "167", "method": "do_thing"})
    op2 = make_opener()
    ctok = login(op2, *LOGIN)
    out["client_empty_plugin"] = call(op2, ctok, "client", "servicecustom", "call",
                                      {"order_id": "1", "method": "do_thing"})
    out["client_forbidden"] = call(op2, ctok, "client", "servicecustom", "call",
                                   {"order_id": "1", "method": "cancel"})
    out["client_missing_method"] = call(op2, ctok, "client", "servicecustom", "call",
                                        {"order_id": "1"})
    out["client_missing_order"] = call(op2, ctok, "client", "servicecustom", "call",
                                       {"method": "do_thing"})
    out["client_not_found"] = call(op2, ctok, "client", "servicecustom", "call",
                                   {"order_id": "999999", "method": "do_thing"})
    d = sqlite3.connect(DBP)
    out["service_custom_baseline"] = {
        "count": d.execute("SELECT COUNT(*) FROM service_custom").fetchone()[0],
        "plugins": [r[0] for r in d.execute("SELECT DISTINCT plugin FROM service_custom")],
        "ids": [r[0] for r in d.execute("SELECT id FROM service_custom ORDER BY id")],
    }
    for name, env in out.items():
        if name == "service_custom_baseline":
            continue
        with open(os.path.join(OUT, name + ".json"), "w") as f:
            json.dump(env, f, indent=2, sort_keys=True)
    with open(os.path.join(OUT, "service_custom_baseline.json"), "w") as f:
        json.dump(out["service_custom_baseline"], f, indent=2, sort_keys=True)
    print(f"captured {len(out)} files into {OUT}")


if __name__ == "__main__":
    main()
