#!/usr/bin/env python3
"""Stripe webhook captures for Phase 4 batch 1 (run after capture13.py).
Inserts a test-mode Stripe gateway row into the reference DB, then
posts signed/unsigned webhook payloads to PHP's ipn.php."""
import hashlib, hmac, json, pathlib, sqlite3, time, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
DB = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
OUT = pathlib.Path(__file__).parent / "captures13"
OUT.mkdir(exist_ok=True)
SECRET = "<MASKED_SECRET_001>"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value


def call(name, role, module, method, data=None, as_json=False):
    if as_json:
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        if csrf():
            req.add_header("X-CSRF-TOKEN", csrf())
    else:
        payload = flatten(dict(data or {}))
        if csrf():
            payload["CSRFToken"] = csrf()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=25) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    print(name, "->", (parsed.get("error") or {}).get("message") or "OK")
    return parsed


def sign(body: str, secret: str, ts: int) -> str:
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def webhook(name, payload, secret=SECRET, bad_sig=False):
    body = json.dumps(payload)
    ts = int(time.time())
    sig = "t=1,v1=deadbeef" if bad_sig else sign(body, secret, ts)
    req = urllib.request.Request(f"{BASE}/ipn.php?gateway_id={GW_ID}",
                                 data=body.encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Stripe-Signature", sig)
    try:
        with opener.open(req, timeout=30) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body2 = e.read().decode()
        try:
            parsed = json.loads(body2)
        except Exception:
            parsed = {"raw": body2[:200], "status": e.code}
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    print(name, "->", json.dumps(parsed)[:160])
    return parsed


# --- seed the Stripe gateway (test mode) ---
db = sqlite3.connect(DB)
cur = db.execute("SELECT id FROM pay_gateway WHERE gateway = 'Stripe'")
row = cur.fetchone()
config = json.dumps({
    "pub_key": "pk_test_123", "api_key": "sk_test_123",
    "webhook_secret": "", "test_pub_key": "pk_test_123",
    "test_api_key": "sk_test_123", "test_webhook_secret": SECRET,
})
if row:
    GW_ID = row[0]
    db.execute("UPDATE pay_gateway SET enabled = 1, test_mode = 1, config = ? WHERE id = ?",
               (config, GW_ID))
else:
    cur = db.execute(
        "INSERT INTO pay_gateway (gateway, name, enabled, allow_single, allow_recurrent, test_mode, config, accepted_currencies) VALUES ('Stripe', 'Stripe', 1, 1, 1, 1, ?, '[\"USD\"]')",
        (config,))
    GW_ID = cur.lastrowid
db.commit()
print("stripe gateway id:", GW_ID)

opener.open(f"{BASE}/login", timeout=20).read()
call("guest_staff_login", "guest", "staff", "login",
     {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
# fresh unpaid invoice for the payment_intent event
def raw(role, module, method, data, as_json=False):
    if as_json:
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=json.dumps(data).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        if csrf():
            req.add_header("X-CSRF-TOKEN", csrf())
    else:
        payload = flatten(dict(data))
        if csrf():
            payload["CSRFToken"] = csrf()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())
iid = raw("admin", "invoice", "prepare", {"client_id": 1})["result"]
raw("admin", "invoice", "update",
    {"id": iid, "new_item": {"title": "Stripe line", "price": 40, "quantity": 1, "taxed": True}}, as_json=True)
raw("admin", "invoice", "issue", {"id": iid})
print("stripe target invoice:", iid)

# 1. bad signature
webhook("stripe_bad_signature", {"id": "evt_bad", "type": "payment_intent.succeeded",
        "data": {"object": {"id": "pi_bad"}}}, bad_sig=True)
# 2. valid signature, unhandled event type
webhook("stripe_unhandled_event", {"id": "evt_unhandled_1", "type": "payment_method.attached",
        "data": {"object": {"id": "pm_123"}}})
# 3. valid signature, payment_intent.succeeded for our invoice
webhook("stripe_pi_succeeded", {
    "id": "evt_pi_1", "type": "payment_intent.succeeded",
    "data": {"object": {
        "id": "pi_cap13", "amount_received": 4000, "currency": "usd",
        "metadata": {"invoice_id": str(iid)},
    }}})
call("stripe_invoice_after", "admin", "invoice", "get", {"id": iid})
lst = call("stripe_txn_list", "admin", "invoice", "transaction_get_list", {"invoice_id": iid})
print("txns for invoice:", json.dumps((lst.get("result") or {}).get("list"))[:240])
