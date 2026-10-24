#!/usr/bin/env python3
"""Phase 3 batch 3 capture corpus: Order module + transaction and
subscription CRUD (PHP oracle). Writes captures11/*.json."""
import json, pathlib, time, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures11"
OUT.mkdir(exist_ok=True)
manifest = []
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


def call(name, role, module, method, data=None):
    payload = flatten(dict(data or {}))
    if csrf():
        payload["CSRFToken"] = csrf()
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def main():
    opener.open(f"{BASE}/login", timeout=20).read()
    call("guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    call("admin_order_get_list", "admin", "order", "get_list")
    call("admin_order_get", "admin", "order", "get", {"id": 3})
    call("admin_order_get_missing", "admin", "order", "get", {"id": 99999})
    call("admin_order_get_statuses", "admin", "order", "get_statuses")
    call("admin_order_status_history", "admin", "order", "status_history_get_list", {"id": 3})
    # throwaway order lifecycle
    created = call("admin_order_create", "admin", "order", "create",
                   {"client_id": 1, "product_id": 3, "invoice_option": "no-invoice", "quantity": 1})
    oid = created.get("result")
    if isinstance(oid, int):
        call("admin_order_get_created", "admin", "order", "get", {"id": oid})
        call("admin_order_update", "admin", "order", "update", {"id": oid, "notes": "capture note"})
        call("admin_order_activate", "admin", "order", "activate", {"id": oid})
        call("admin_order_get_active", "admin", "order", "get", {"id": oid})
        call("admin_order_suspend", "admin", "order", "suspend", {"id": oid, "reason": "capture"})
        call("admin_order_get_suspended", "admin", "order", "get", {"id": oid})
        call("admin_order_unsuspend", "admin", "order", "unsuspend", {"id": oid})
        call("admin_order_cancel", "admin", "order", "cancel", {"id": oid})
        call("admin_order_uncancel", "admin", "order", "uncancel", {"id": oid})
        call("admin_order_delete", "admin", "order", "delete", {"id": oid})
        call("admin_order_get_deleted", "admin", "order", "get", {"id": oid})
    # transactions
    txn_id = f"CAP11-{int(time.time())}"
    tx = call("admin_transaction_create", "admin", "invoice", "transaction_create",
              {"invoice_id": 1, "gateway_id": 1, "amount": 5, "currency": "USD",
               "txn_id": txn_id, "status": "received"})
    txid = tx.get("result")
    call("admin_transaction_get_list", "admin", "invoice", "transaction_get_list")
    if isinstance(txid, int):
        call("admin_transaction_get", "admin", "invoice", "transaction_get", {"id": txid})
        call("admin_transaction_update", "admin", "invoice", "transaction_update",
             {"id": txid, "status": "approved", "amount": 6.5})
        call("admin_transaction_get_after_update", "admin", "invoice", "transaction_get", {"id": txid})
        call("admin_transaction_delete", "admin", "invoice", "transaction_delete", {"id": txid})
        call("admin_transaction_get_deleted", "admin", "invoice", "transaction_get", {"id": txid})
    call("admin_transaction_get_statuses", "admin", "invoice", "transaction_get_statuses")
    call("admin_transaction_types", "admin", "invoice", "transaction_types")
    # subscriptions
    sub = call("admin_subscription_create", "admin", "invoice", "subscription_create",
               {"client_id": 1, "gateway_id": 1, "currency": "USD", "sid": "sub-cap11",
                "status": "active", "period": "1M", "amount": 15})
    sid = sub.get("result")
    call("admin_subscription_get_list", "admin", "invoice", "subscription_get_list")
    if isinstance(sid, int):
        call("admin_subscription_get", "admin", "invoice", "subscription_get", {"id": sid})
        call("admin_subscription_update", "admin", "invoice", "subscription_update",
             {"id": sid, "amount": 20})
        call("admin_subscription_get_after_update", "admin", "invoice", "subscription_get", {"id": sid})
        call("admin_subscription_delete", "admin", "invoice", "subscription_delete", {"id": sid})
        call("admin_subscription_get_deleted", "admin", "invoice", "subscription_get", {"id": sid})
    # client views
    call("guest_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
    call("client_order_get_list", "client", "order", "get_list")
    call("client_order_get", "client", "order", "get", {"id": 3})
    call("client_order_get_missing", "client", "order", "get", {"id": 99999})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
