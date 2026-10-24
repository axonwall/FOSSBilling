#!/usr/bin/env python3
"""Phase 2 batch 2 parity: replay the capture6 corpus against the Next
origin (TS modules system,currency,profile,client + FB_PARITY=1) and
deep-compare with the PHP reference captures. The currency mutation
sequence is net-zero, so the TS replay ends at the same DB baseline."""
import json, sys, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures6"
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
    req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            got = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        got = json.loads(e.read().decode())
    ref = json.loads((REF / f"{name}.json").read_text())
    ok = got == ref
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(ref)[:260]}")
        print(f"   ts:  {json.dumps(got)[:260]}")
    return ok

opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
r = []
r.append(call("guest_client_login", "guest", "client", "login", {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}))
r.append(call("client_profile_get", "client", "profile", "get"))
r.append(call("client_profile_logout", "client", "profile", "logout"))
r.append(call("guest_staff_login", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}))
r.append(call("admin_profile_get", "admin", "profile", "get"))
r.append(call("admin_client_get_list", "admin", "client", "get_list", {"page": 1, "per_page": 25}))
r.append(call("admin_client_get_list_search", "admin", "client", "get_list", {"search": "phase0"}))
r.append(call("admin_client_get_list_status", "admin", "client", "get_list", {"status": "active"}))
r.append(call("admin_client_get_1", "admin", "client", "get", {"id": 1}))
r.append(call("admin_client_get_by_email", "admin", "client", "get", {"email": "phase0.client@example.com"}))
r.append(call("admin_client_get_missing", "admin", "client", "get", {"id": 99999}))
r.append(call("admin_client_get_noargs", "admin", "client", "get", {}))
r.append(call("admin_client_get_pairs", "admin", "client", "get_pairs"))
r.append(call("admin_currency_create_EUR", "admin", "currency", "create", {"code": "EUR", "conversion_rate": "0.92", "is_rate_manual": 1}))
r.append(call("admin_currency_create_EUR_dup", "admin", "currency", "create", {"code": "EUR", "conversion_rate": "0.92", "is_rate_manual": 1}))
r.append(call("admin_currency_create_invalid", "admin", "currency", "create", {"code": "ZZZ", "conversion_rate": "1", "is_rate_manual": 1}))
r.append(call("admin_currency_create_manual_norate", "admin", "currency", "create", {"code": "GBP", "is_rate_manual": 1}))
r.append(call("admin_currency_create_badrate", "admin", "currency", "create", {"code": "GBP", "conversion_rate": "-2", "is_rate_manual": 1}))
r.append(call("admin_currency_get_EUR", "admin", "currency", "get", {"code": "EUR"}))
r.append(call("admin_currency_update_EUR", "admin", "currency", "update", {"code": "EUR", "conversion_rate": "0.95"}))
r.append(call("admin_currency_update_badrate", "admin", "currency", "update", {"code": "EUR", "conversion_rate": "0"}))
r.append(call("admin_currency_update_pattern", "admin", "currency", "update", {"code": "EUR", "format_pattern": "{amount} EUR", "fraction_digits": "3"}))
r.append(call("admin_currency_update_pattern_bad", "admin", "currency", "update", {"code": "EUR", "format_pattern": "no placeholder"}))
r.append(call("admin_currency_update_digits_bad", "admin", "currency", "update", {"code": "EUR", "fraction_digits": "9"}))
r.append(call("admin_currency_get_EUR_after", "admin", "currency", "get", {"code": "EUR"}))
r.append(call("admin_currency_set_default_EUR", "admin", "currency", "set_default", {"code": "EUR"}))
r.append(call("admin_currency_delete_default_EUR", "admin", "currency", "delete", {"code": "EUR"}))
r.append(call("admin_currency_update_manual_default", "admin", "currency", "update", {"code": "EUR", "is_rate_manual": 1}))
r.append(call("admin_currency_set_default_USD", "admin", "currency", "set_default", {"code": "USD"}))
r.append(call("admin_currency_delete_EUR", "admin", "currency", "delete", {"code": "EUR"}))
r.append(call("admin_currency_delete_missing", "admin", "currency", "delete", {"code": "EUR"}))
r.append(call("admin_currency_get_list_final", "admin", "currency", "get_list"))
print(f"\nparity batch2: {sum(r)}/{len(r)} match")
sys.exit(0 if all(r) else 1)
