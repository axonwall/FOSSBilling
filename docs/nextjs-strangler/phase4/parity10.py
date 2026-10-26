#!/usr/bin/env python3
"""Phase 4 batch 1 parity: replay capture13 flows against Next.

Note on the Stripe payment_intent case: in the sandbox PHP deletes
the transaction because it cannot verify event ownership against
the live Stripe API; the TS handler settles from the signed payload
instead (PHP's production outcome). That case is asserted on the
TS-intended outcome and documented in findings-batch1 (Phase 4)."""
import hashlib, hmac, json, sys, time, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures13"
SECRET = "<MASKED_SECRET_001>"
GW_STRIPE = 3
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def csrf_of():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def call(role, module, method, data=None, as_json=False):
    if as_json:
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        if csrf_of():
            req.add_header("X-CSRF-TOKEN", csrf_of())
    else:
        payload = flatten(dict(data or {}))
        if csrf_of():
            payload["CSRFToken"] = csrf_of()
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def ipn_form(query, form):
    url = f"{NEXT}/ipn.php?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def sign(body, secret, ts):
    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def webhook(payload, bad_sig=False):
    body = json.dumps(payload)
    ts = int(time.time())
    sig = "t=1,v1=deadbeef" if bad_sig else sign(body, SECRET, ts)
    req = urllib.request.Request(f"{NEXT}/ipn.php?gateway_id={GW_STRIPE}",
                                 data=body.encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Stripe-Signature", sig)
    try:
        with opener.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


results = []
def check(name, cond, detail=""):
    print(f"{'MATCH' if cond else 'DIFF '} {name} {detail}")
    results.append(bool(cond))


def issued_invoice(price=40):
    iid = call("admin", "invoice", "prepare", {"client_id": 1})["result"]
    call("admin", "invoice", "update",
         {"id": iid, "new_item": {"title": "IPN line", "price": price, "quantity": 1, "taxed": True}}, as_json=True)
    call("admin", "invoice", "issue", {"id": iid})
    return iid


opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
# --- Custom IPN ---
inv = issued_invoice(40)
txn_ref = f"IPN-P10-{int(time.time())}"
res = ipn_form({"gateway_id": 1, "invoice_id": inv}, {"txn_id": txn_ref, "invoice_id": inv})
check("ipn_custom_error_envelope",
      (res.get("error") or {}).get("message") == "Custom payments must be approved by an administrator."
      and (res.get("error") or {}).get("code") == 7002, json.dumps(res)[:110])
lst = call("admin", "invoice", "transaction_get_list", {"invoice_id": inv})
items = ((lst.get("result") or {}).get("list")) or []
tx = items[0] if items else {}
check("ipn_custom_txn_error_state", tx.get("status") == "error"
      and tx.get("error") == "Custom payments must be approved by an administrator.")
inv_now = call("admin", "invoice", "get", {"id": inv})["result"]
check("ipn_custom_invoice_unpaid", inv_now["status"] == "unpaid")
tx_id = tx.get("id")
proc = call("admin", "invoice", "transaction_process", {"id": tx_id})
check("transaction_process_custom_7002",
      (proc.get("error") or {}).get("code") == 7002)
appr = call("admin", "invoice", "transaction_approve", {"id": tx_id})
check("transaction_approve_true", appr.get("result") is True)
inv_now = call("admin", "invoice", "get", {"id": inv})["result"]
check("approve_settles_invoice", inv_now["status"] == "paid")
txn_now = call("admin", "invoice", "transaction_get", {"id": tx_id})["result"]
check("approve_txn_processed", txn_now["status"] == "processed"
      and float(txn_now["amount"]) == 40 and txn_now["currency"] == "USD")
# --- admin-created received txn -> approve ---
# NOTE (2026-10-25, CRUD-block regression): a bare admin create (no
# get/post payload) has a canonical IPN, so PHP's IPN-hash dedupe
# returns the FIRST such transaction ever created (verified live
# against PHP: two distinct txn_ids both returned id 95). The create
# below therefore carries a unique post payload so it mints a fresh
# row on both stacks; without it this case dedupes to a stale row.
inv2 = issued_invoice(40)
created = call("admin", "invoice", "transaction_create",
               {"invoice_id": inv2, "gateway_id": 1, "txn_id": f"ADM-P10-{int(time.time())}",
                "txn_status": "pending", "type": "payment", "status": "received",
                "post": {"probe": f"ADM-P10-{int(time.time())}"}})
tx2 = created.get("result")
call("admin", "invoice", "transaction_approve", {"id": tx2})
inv2_now = call("admin", "invoice", "get", {"id": inv2})["result"]
txn2_now = call("admin", "invoice", "transaction_get", {"id": tx2})["result"]
check("approve_received_settles", inv2_now["status"] == "paid"
      and txn2_now["status"] == "processed"
      and txn2_now["note"] == f"Custom transaction No: ADM-P10-{int(time.time())}" or
      (inv2_now["status"] == "paid" and txn2_now["status"] == "processed"
       and str(txn2_now["note"]).startswith("Custom transaction No: ADM-P10-")))
claim = call("admin", "invoice", "transaction_claim_for_processing", {"id": tx2})
check("claim_processed_false", claim.get("result") is False)
pa = call("admin", "invoice", "transaction_process_all")
check("process_all_true", pa.get("result") is True)
# --- Stripe webhooks ---
bad = webhook({"id": "evt_bad", "type": "payment_intent.succeeded", "data": {"object": {"id": "pi_bad"}}},
              bad_sig=True)
check("stripe_bad_signature", (bad.get("error") or {}).get("message") == "Invalid Stripe webhook signature")
unh = webhook({"id": "evt_unhandled_p10", "type": "payment_method.attached", "data": {"object": {"id": "pm_1"}}})
unh_id = unh.get("result")
gone = call("admin", "invoice", "transaction_get", {"id": unh_id}) if isinstance(unh_id, int) else {}
check("stripe_unhandled_deleted", isinstance(unh_id, int)
      and (gone.get("error") or {}).get("message") == "Transaction not found")
inv3 = issued_invoice(40)
pi = webhook({"id": "evt_pi_p10", "type": "payment_intent.succeeded",
              "data": {"object": {"id": "pi_p10", "amount_received": 4000, "currency": "usd",
                                  "metadata": {"invoice_id": str(inv3)}}}})
inv3_now = call("admin", "invoice", "get", {"id": inv3})["result"]
check("stripe_pi_settles_invoice", inv3_now["status"] == "paid", f"ipn result: {json.dumps(pi)[:90]}")
pi_txn = call("admin", "invoice", "transaction_get", {"id": pi.get("result")}) \
    if isinstance(pi.get("result"), int) else {}
check("stripe_pi_txn_processed", (pi_txn.get("result") or {}).get("status") == "processed")

print(f"\nparity Phase4-1: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
