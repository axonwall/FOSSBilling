#!/usr/bin/env python3
"""Phase 0 live capture: seeds a small dataset into the running PHP
FOSSBilling instance and snapshots real API responses (the parity corpus).

Usage: FB_BASE=http://127.0.0.1:8080 FB_ADMIN_TOKEN=... python3 capture.py
Outputs JSON files + manifest.json under ./captures/
"""
import base64, json, os, sys, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = os.environ.get("FB_BASE", "http://127.0.0.1:8080")
TOKEN = os.environ["FB_ADMIN_TOKEN"]
OUT = pathlib.Path(__file__).parent / "captures"
OUT.mkdir(exist_ok=True)
manifest = []

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf_from_jar():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return None

def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else str(k)
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out

def call(name, role, module, method, data=None, auth=None, use_csrf=False):
    url = f"{BASE}/api/{role}/{module}/{method}"
    payload = flatten(dict(data or {}))
    if use_csrf:
        tok = csrf_from_jar()
        if tok:
            payload["CSRFToken"] = tok
    body = urllib.parse.urlencode(payload).encode() if payload else b""
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if auth:
        raw = base64.b64encode(auth.encode()).decode()
        req.add_header("Authorization", f"Basic {raw}")
    try:
        with opener.open(req, timeout=20) as resp:
            text = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        status = e.code
    try:
        parsed = json.loads(text)
    except Exception:
        parsed = {"raw": text[:2000]}
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}",
                     "http": status, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(f"{'OK ' if ok else 'ERR'} {name} -> {status} {manifest[-1]['error'] or ''}")
    return parsed

# 1. Prime session + CSRF cookie via the PHP login page
try:
    with opener.open(f"{BASE}/login", timeout=20) as r:
        r.read()
    print("primed /login, csrf cookie:", "yes" if csrf_from_jar() else "NO")
except Exception as e:
    print("prime failed:", e)

ADMIN = f"admin:{TOKEN}"

# 2. Guest surface
call("guest_system_company", "guest", "system", "company", use_csrf=True)
call("guest_system_periods", "guest", "system", "periods", use_csrf=True)
call("guest_client_required", "guest", "client", "required", use_csrf=True)
call("guest_product_get_list", "guest", "product", "get_list", use_csrf=True)

# 3. Admin surface (token auth)
call("admin_currency_get_list", "admin", "currency", "get_list", auth=ADMIN)
call("admin_system_env", "admin", "system", "env", auth=ADMIN)

# 4. Seed: product (prepare + update with once pricing 10.00)
prod = call("admin_product_prepare", "admin", "product", "prepare",
            {"title": "Phase0 Widget Hosting", "type": "custom", "product_category_id": 1}, auth=ADMIN)
product_id = prod.get("result") if isinstance(prod, dict) else None
if product_id:
    call("admin_product_update", "admin", "product", "update",
         {"id": product_id, "status": "enabled",
          "pricing[type]": "once", "pricing[once][price]": 10, "pricing[once][setup]": 0}, auth=ADMIN)
    call("admin_product_get", "admin", "product", "get", {"id": product_id}, auth=ADMIN)

# 5. Seed: client signup (guest, guarded -> CSRF nonce)
client_pw = "Phase0-Client!42"
signup = call("guest_client_create", "guest", "client", "create",
              {"email": "phase0.client@example.com", "password": client_pw, "password_confirm": client_pw,
               "first_name": "Phase", "last_name": "Zero",
               "country": "US", "state": "Texas", "city": "Austin",
               "address_1": "1 Phase Way", "postcode": "78701", "phone": "5125550100"},
              use_csrf=True)

# 5b. Fallback seed: if guest signup is blocked (in this sandbox the
# Antispam disposable-list fetch to raw.githubusercontent.com fails TLS
# through the proxy), create the same client via the admin API instead.
clients_pre = call("admin_client_get_list_pre", "admin", "client", "get_list", auth=ADMIN)
have_client = False
try:
    have_client = any(c.get("email") == "phase0.client@example.com"
                      for c in clients_pre["result"]["list"])
except Exception:
    pass
if not have_client:
    call("admin_client_create_fallback", "admin", "client", "create",
         {"email": "phase0.client@example.com", "first_name": "Phase",
          "last_name": "Zero", "password": client_pw, "password_confirm": client_pw,
          "country": "US", "state": "Texas", "city": "Austin",
          "address_1": "1 Phase Way", "postcode": "78701", "phone_cc": 1,
          "phone": "5125550100", "status": "active"}, auth=ADMIN)

# 6. Client login + client surface (session cookies)
call("guest_client_login", "guest", "client", "login",
     {"email": "phase0.client@example.com", "password": client_pw}, use_csrf=True)
call("client_profile_get", "client", "profile", "get", use_csrf=True)
call("client_invoice_get_list", "client", "invoice", "get_list", {"page": 1, "per_page": 25}, use_csrf=True)
call("client_order_get_list", "client", "order", "get_list", {"page": 1, "per_page": 25}, use_csrf=True)

# 7. Admin: order for the seeded client, then invoice list
clients = call("admin_client_get_list", "admin", "client", "get_list", auth=ADMIN)
client_id = None
try:
    client_id = clients["result"]["list"][0]["id"]
except Exception:
    pass
if client_id and product_id:
    order = call("admin_order_create", "admin", "order", "create",
                 {"client_id": client_id, "product_id": product_id, "period": "1M",
                  "activate": 1, "invoice_option": "issue_invoice"}, auth=ADMIN)
    call("admin_invoice_get_list", "admin", "invoice", "get_list", auth=ADMIN)
    call("admin_order_get_list", "admin", "order", "get_list", auth=ADMIN)
    call("client_invoice_get_list_after_order", "client", "invoice", "get_list",
         {"page": 1, "per_page": 25}, use_csrf=True)

# 8. Money path: manual invoice 60 + 40 = 100 USD, issue, capture, pay
if client_id:
    prep = call("admin_invoice_prepare", "admin", "invoice", "prepare",
                {"client_id": client_id}, auth=ADMIN)
    inv_id = prep.get("result") if isinstance(prep, dict) else None
    if inv_id:
        for title, price in [("Phase0 line A", 60), ("Phase0 line B", 40)]:
            call("admin_invoice_update_add_item", "admin", "invoice", "update",
                 {"id": inv_id, "new_item": {"title": title, "price": price, "quantity": 1}},
                 auth=ADMIN)
        call("admin_invoice_issue", "admin", "invoice", "issue", {"id": inv_id}, auth=ADMIN)
        call("admin_invoice_get", "admin", "invoice", "get", {"id": inv_id}, auth=ADMIN)
        call("admin_invoice_mark_as_paid", "admin", "invoice", "mark_as_paid",
             {"id": inv_id, "gateway_id": 1, "transactionId": "phase0-txn-1"}, auth=ADMIN)
        call("admin_invoice_get_paid", "admin", "invoice", "get", {"id": inv_id}, auth=ADMIN)
        call("client_invoice_get_list_final", "client", "invoice", "get_list",
             {"page": 1, "per_page": 25}, use_csrf=True)

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
ok = sum(1 for m in manifest if m["ok"])
print(f"\ncaptures: {ok}/{len(manifest)} ok -> {OUT}")
