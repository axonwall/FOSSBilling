#!/usr/bin/env python3
"""Phase 1 batch 2 capture: admin top surfaces (staff login, stats,
clients, orders, invoices, tickets) against the running PHP instance."""
import json, os, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = os.environ.get("FB_BASE", "http://127.0.0.1:8080")
OUT = pathlib.Path(__file__).parent / "captures3"
OUT.mkdir(exist_ok=True)
manifest = []
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return None

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
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = {"raw": text[:2000]}
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}", "http": status, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(f"{'OK ' if ok else 'ERR'} {name} {manifest[-1]['error'] or ''}")
    return parsed

opener.open(f"{BASE}/login", timeout=20).read()  # seed CSRF cookie (web page)
call("guest_staff_login", "guest", "staff", "login",
     {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
call("admin_profile_get", "admin", "profile", "get")
call("admin_stats_get_summary", "admin", "stats", "get_summary")
call("admin_stats_get_orders_statuses", "admin", "stats", "get_orders_statuses")
clients = call("admin_client_get_list", "admin", "client", "get_list", {"page": 1, "per_page": 25})
cid = None
try: cid = clients["result"]["list"][0]["id"]
except Exception: pass
if cid: call("admin_client_get", "admin", "client", "get", {"id": cid})
orders = call("admin_order_get_list", "admin", "order", "get_list", {"page": 1, "per_page": 25})
oid = None
try: oid = orders["result"]["list"][0]["id"]
except Exception: pass
if oid: call("admin_order_get", "admin", "order", "get", {"id": oid})
call("admin_invoice_get_list", "admin", "invoice", "get_list", {"page": 1, "per_page": 25})
tickets = call("admin_support_ticket_get_list", "admin", "support", "ticket_get_list", {"page": 1, "per_page": 25})
tid = None
try: tid = tickets["result"]["list"][0]["id"]
except Exception: pass
if tid:
    call("admin_support_ticket_get", "admin", "support", "ticket_get", {"id": tid})
    call("admin_support_ticket_reply", "admin", "support", "ticket_reply",
         {"id": tid, "content": "Staff reply from the Phase 1 batch-2 capture corpus."})
call("admin_profile_logout", "admin", "profile", "logout")
call("admin_profile_get_after_logout", "admin", "profile", "get")
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"\ncaptures3: {sum(1 for m in manifest if m['ok'])}/{len(manifest)} ok -> {OUT}")
