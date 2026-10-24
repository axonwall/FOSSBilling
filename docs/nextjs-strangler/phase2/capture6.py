#!/usr/bin/env python3
"""Phase 2 batch 2 PHP reference capture: Profile gets, admin Client
reads, and the net-zero currency mutation sequence (create EUR -> update
-> set_default -> set_default back -> delete), incl. error cases.
The mutation sequence ends at the baseline state (USD only, default)."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures6"
OUT.mkdir(exist_ok=True)
manifest = []
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value

def call(name, role, module, method, data=None, save=True):
    payload = dict(data or {})
    if csrf():
        payload["CSRFToken"] = csrf()
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            text = resp.read().decode()
    except urllib.error.HTTPError as e:
        text = e.read().decode()
    parsed = json.loads(text)
    if save:
        (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = parsed.get("error") is None
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}", "params": data or {}, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message")})
    print(f"{'OK ' if ok else 'ERR'} {name} {(parsed.get('error') or {}).get('message') or ''}")
    return parsed

opener.open(f"{BASE}/login", timeout=20).read()
# Client session: profile get
call("guest_client_login", "guest", "client", "login", {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
call("client_profile_get", "client", "profile", "get")
call("client_profile_logout", "client", "profile", "logout")
# Staff session
call("guest_staff_login", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
call("admin_profile_get", "admin", "profile", "get")
call("admin_client_get_list", "admin", "client", "get_list", {"page": 1, "per_page": 25})
call("admin_client_get_list_search", "admin", "client", "get_list", {"search": "phase0"})
call("admin_client_get_list_status", "admin", "client", "get_list", {"status": "active"})
call("admin_client_get_1", "admin", "client", "get", {"id": 1})
call("admin_client_get_by_email", "admin", "client", "get", {"email": "phase0.client@example.com"})
call("admin_client_get_missing", "admin", "client", "get", {"id": 99999})
call("admin_client_get_noargs", "admin", "client", "get", {})
call("admin_client_get_pairs", "admin", "client", "get_pairs")
# Currency mutations (net-zero) + error cases
call("admin_currency_create_EUR", "admin", "currency", "create", {"code": "EUR", "conversion_rate": "0.92", "is_rate_manual": 1})
call("admin_currency_create_EUR_dup", "admin", "currency", "create", {"code": "EUR", "conversion_rate": "0.92", "is_rate_manual": 1})
call("admin_currency_create_invalid", "admin", "currency", "create", {"code": "ZZZ", "conversion_rate": "1", "is_rate_manual": 1})
call("admin_currency_create_manual_norate", "admin", "currency", "create", {"code": "GBP", "is_rate_manual": 1})
call("admin_currency_create_badrate", "admin", "currency", "create", {"code": "GBP", "conversion_rate": "-2", "is_rate_manual": 1})
call("admin_currency_get_EUR", "admin", "currency", "get", {"code": "EUR"})
call("admin_currency_update_EUR", "admin", "currency", "update", {"code": "EUR", "conversion_rate": "0.95"})
call("admin_currency_update_badrate", "admin", "currency", "update", {"code": "EUR", "conversion_rate": "0"})
call("admin_currency_update_pattern", "admin", "currency", "update", {"code": "EUR", "format_pattern": "{amount} EUR", "fraction_digits": "3"})
call("admin_currency_update_pattern_bad", "admin", "currency", "update", {"code": "EUR", "format_pattern": "no placeholder"})
call("admin_currency_update_digits_bad", "admin", "currency", "update", {"code": "EUR", "fraction_digits": "9"})
call("admin_currency_get_EUR_after", "admin", "currency", "get", {"code": "EUR"})
call("admin_currency_set_default_EUR", "admin", "currency", "set_default", {"code": "EUR"})
call("admin_currency_delete_default_EUR", "admin", "currency", "delete", {"code": "EUR"})
call("admin_currency_update_manual_default", "admin", "currency", "update", {"code": "EUR", "is_rate_manual": 1})
call("admin_currency_set_default_USD", "admin", "currency", "set_default", {"code": "USD"})
call("admin_currency_delete_EUR", "admin", "currency", "delete", {"code": "EUR"})
call("admin_currency_delete_missing", "admin", "currency", "delete", {"code": "EUR"})
call("admin_currency_get_list_final", "admin", "currency", "get_list")
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"\ncaptures6: {sum(1 for m in manifest if m['ok'])}/{len(manifest)} ok -> {OUT}")
