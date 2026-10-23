#!/usr/bin/env python3
"""Phase 2 parity check: replay the capture5 corpus against the Next
origin (TS modules enabled + FB_PARITY=1 on the server) and deep-compare
each response with the PHP reference captures in captures5/."""
import json, sys, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures5"
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
        print(f"   php: {json.dumps(ref)[:220]}")
        print(f"   ts:  {json.dumps(got)[:220]}")
    return ok

# Prime cookies through the Next proxy (PHP login page relay)
opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()

results = []
results.append(call("guest_system_company", "guest", "system", "company"))
results.append(call("guest_system_periods", "guest", "system", "periods"))
results.append(call("guest_system_period_title_1M", "guest", "system", "period_title", {"code": "1M"}))
results.append(call("guest_system_period_title_empty", "guest", "system", "period_title", {"code": ""}))
results.append(call("guest_system_period_title_custom", "guest", "system", "period_title", {"code": "2M"}))
results.append(call("guest_currency_get_pairs", "guest", "currency", "get_pairs"))
results.append(call("guest_currency_get_default", "guest", "currency", "get"))
results.append(call("guest_currency_get_USD", "guest", "currency", "get", {"code": "USD"}))
results.append(call("guest_currency_get_missing", "guest", "currency", "get", {"code": "XXX"}))
results.append(call("guest_currency_format_100", "guest", "currency", "format", {"price": 100}))
results.append(call("guest_currency_format_noconvert", "guest", "currency", "format", {"price": 100, "convert": 0}))
results.append(call("guest_currency_format_number_only", "guest", "currency", "format", {"price": 100, "without_currency": 1}))
# staff login itself is PHP-served; admin currency calls are TS-served
opener.open(f"{NEXT}/api/fb/guest/staff/login", data=urllib.parse.urlencode(
    {"email": "admin@phase0.local", "password": "Phase1-Admin!42", "CSRFToken": csrf() or ""}).encode(), timeout=25).read()
results.append(call("admin_currency_get_list", "admin", "currency", "get_list"))
results.append(call("admin_currency_get_pairs", "admin", "currency", "get_pairs"))
results.append(call("admin_currency_get_default", "admin", "currency", "get_default"))
results.append(call("admin_currency_get_by_code", "admin", "currency", "get", {"code": "USD"}))
print(f"\nparity: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
