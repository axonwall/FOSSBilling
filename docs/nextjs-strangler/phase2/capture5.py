#!/usr/bin/env python3
"""Phase 2 reference capture: PHP responses for the first TS-ported
modules (System guest reads, Currency guest+admin reads). These files are
the parity oracle for the TS implementations."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures5"
OUT.mkdir(exist_ok=True)
manifest = []
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value

def call(name, role, module, method, data=None):
    payload = dict(data or {})
    if csrf():
        payload["CSRFToken"] = csrf()
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            text, status = resp.read().decode(), resp.status
    except urllib.error.HTTPError as e:
        text, status = e.read().decode(), e.code
    parsed = json.loads(text)
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = parsed.get("error") is None
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}",
                     "params": data or {}, "http": status, "ok": ok})
    print(f"{'OK ' if ok else 'ERR'} {name}")
    return parsed

opener.open(f"{BASE}/login", timeout=20).read()
call("guest_system_company", "guest", "system", "company")
call("guest_system_periods", "guest", "system", "periods")
call("guest_system_period_title_1M", "guest", "system", "period_title", {"code": "1M"})
call("guest_system_period_title_empty", "guest", "system", "period_title", {"code": ""})
call("guest_currency_get_pairs", "guest", "currency", "get_pairs")
call("guest_currency_get_default", "guest", "currency", "get")
call("guest_currency_get_USD", "guest", "currency", "get", {"code": "USD"})
call("guest_currency_get_missing", "guest", "currency", "get", {"code": "XXX"})
call("guest_currency_format_100", "guest", "currency", "format", {"price": 100})
call("guest_currency_format_noconvert", "guest", "currency", "format", {"price": 100, "convert": 0})
call("guest_currency_format_number_only", "guest", "currency", "format", {"price": 100, "without_currency": 1})
call("guest_staff_login", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
call("admin_currency_get_list", "admin", "currency", "get_list")
call("admin_currency_get_pairs", "admin", "currency", "get_pairs")
call("admin_currency_get_default", "admin", "currency", "get_default")
call("admin_currency_get_1", "admin", "currency", "get", {"id": 1})
call("admin_profile_logout", "admin", "profile", "logout")
call("admin_currency_get_list_after_logout", "admin", "currency", "get_list")
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"\ncaptures5: {sum(1 for m in manifest if m['ok'])}/{len(manifest)} ok -> {OUT}")
