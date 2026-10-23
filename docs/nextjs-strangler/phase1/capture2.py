#!/usr/bin/env python3
"""Phase 1 capture extension: client core flows (orders, invoice detail +
PDF, support ticket lifecycle, logout) against the running PHP instance.

Reuses the seeded client from capture.py (phase0.client@example.com).
Outputs into ./captures2/ with its own manifest.
"""
import base64, json, os, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = os.environ.get("FB_BASE", "http://127.0.0.1:8080")
OUT = pathlib.Path(__file__).parent / "captures2"
OUT.mkdir(exist_ok=True)
manifest = []

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return None

def call(name, role, module, method, data=None, use_csrf=True):
    url = f"{BASE}/api/{role}/{module}/{method}"
    payload = dict(data or {})
    if use_csrf and csrf():
        payload["CSRFToken"] = csrf()
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=20) as resp:
            text, status = resp.read().decode(), resp.status
    except urllib.error.HTTPError as e:
        text, status = e.read().decode(), e.code
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = {"raw": text[:2000]}
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}",
                     "http": status, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(f"{'OK ' if ok else 'ERR'} {name} {manifest[-1]['error'] or ''}")
    return parsed

# Prime + login
opener.open(f"{BASE}/login", timeout=20).read()
call("guest_client_login", "guest", "client", "login",
     {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})

# Orders
orders = call("client_order_get_list", "client", "order", "get_list", {"page": 1, "per_page": 25})
order_id = None
try:
    order_id = orders["result"]["list"][0]["id"]
except Exception:
    pass
if order_id:
    call("client_order_get", "client", "order", "get", {"id": order_id})
    call("client_order_service", "client", "order", "service", {"id": order_id})

# Invoice detail by hash + PDF download (web route, session cookie)
invs = call("client_invoice_get_list", "client", "invoice", "get_list", {"page": 1, "per_page": 25})
inv_hash = None
try:
    inv_hash = invs["result"]["list"][0]["hash"]
except Exception:
    pass
if inv_hash:
    call("client_invoice_get", "client", "invoice", "get", {"hash": inv_hash})
    req = urllib.request.Request(f"{BASE}/invoice/pdf/{inv_hash}")
    try:
        with opener.open(req, timeout=30) as resp:
            blob = resp.read()
            ctype = resp.headers.get("Content-Type")
            status = resp.status
    except urllib.error.HTTPError as e:
        blob, ctype, status = e.read(), e.headers.get("Content-Type"), e.code
    is_pdf = blob[:4] == b"%PDF"
    (OUT / "client_invoice_pdf.json").write_text(json.dumps(
        {"http": status, "content_type": ctype, "bytes": len(blob), "is_pdf": is_pdf}, indent=2))
    manifest.append({"name": "client_invoice_pdf", "route": f"/invoice/pdf/{inv_hash}",
                     "http": status, "ok": is_pdf, "error": None if is_pdf else "not a PDF"})
    print(f"{'OK ' if is_pdf else 'ERR'} client_invoice_pdf {len(blob)} bytes {ctype}")

# Support lifecycle
pairs = call("client_support_helpdesk_get_pairs", "client", "support", "helpdesk_get_pairs")
helpdesk_id = 1
try:
    keys = list((pairs.get("result") or {}).keys())
    if keys:
        helpdesk_id = int(keys[0])
except Exception:
    pass
t = call("client_support_ticket_create", "client", "support", "ticket_create",
         {"support_helpdesk_id": helpdesk_id, "subject": "Phase1 capture ticket",
          "content": "Hello from the Phase 1 capture corpus."})
ticket_id = t.get("result") if isinstance(t, dict) else None
call("client_support_ticket_get_list", "client", "support", "ticket_get_list", {"page": 1, "per_page": 25})
if ticket_id:
    call("client_support_ticket_get", "client", "support", "ticket_get", {"id": ticket_id})
    call("client_support_ticket_reply", "client", "support", "ticket_reply",
         {"id": ticket_id, "content": "A follow-up reply from the capture corpus."})
    call("client_support_ticket_get_after_reply", "client", "support", "ticket_get", {"id": ticket_id})
    call("client_support_ticket_close", "client", "support", "ticket_close", {"id": ticket_id})

# Logout last (kills the session)
call("client_profile_logout", "client", "profile", "logout")
call("client_profile_get_after_logout", "client", "profile", "get")

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"\ncaptures2: {sum(1 for m in manifest if m['ok'])}/{len(manifest)} ok -> {OUT}")
