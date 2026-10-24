#!/usr/bin/env python3
"""Phase 4 batch 1 capture corpus: IPN intake (Custom), transaction
approve/process, Stripe webhook signature path. PHP oracle."""
import hashlib, hmac, json, pathlib, time, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures13"
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
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def raw_ipn(name, query, form=None, json_body=None, headers=None):
    url = f"{BASE}/ipn.php?{urllib.parse.urlencode(query)}"
    if json_body is not None:
        req = urllib.request.Request(url, data=json_body.encode(), method="POST")
        req.add_header("Content-Type", "application/json")
    else:
        req = urllib.request.Request(url, data=urllib.parse.urlencode(form or {}).encode(), method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with opener.open(req, timeout=25) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"raw_error": body[:200], "status": e.code}
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def issued_invoice(price=40):
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
        {"id": iid, "new_item": {"title": "IPN line", "price": price, "quantity": 1, "taxed": True}}, as_json=True)
    raw("admin", "invoice", "issue", {"id": iid})
    return iid


def main():
    opener.open(f"{BASE}/login", timeout=20).read()
    call("guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    # 1. Custom IPN for a fresh unpaid invoice
    inv = issued_invoice(40)
    txn_ref = f"IPN-CAP13-{int(time.time())}"
    ipn_res = raw_ipn("ipn_custom", {"gateway_id": 1, "invoice_id": inv},
                      form={"txn_id": txn_ref, "invoice_id": inv})
    tx_id = ipn_res.get("result")
    call("ipn_custom_invoice_after", "admin", "invoice", "get", {"id": inv})
    if not isinstance(tx_id, int):
        # createAndProcess persists an 'error' transaction for manual
        # gateways; find it through the list endpoint.
        lst = call("ipn_custom_txn_list", "admin", "invoice", "transaction_get_list",
                   {"invoice_id": inv})
        items = ((lst.get("result") or {}).get("list")) or []
        tx_id = items[0]["id"] if items else None
    if isinstance(tx_id, int):
        call("ipn_custom_txn_after", "admin", "invoice", "transaction_get", {"id": tx_id})
        # duplicate IPN (idempotency)
        raw_ipn("ipn_custom_duplicate", {"gateway_id": 1, "invoice_id": inv},
                form={"txn_id": txn_ref, "invoice_id": inv})
        # process on a manual-approval gateway -> pinned error
        call("admin_transaction_process_custom", "admin", "invoice", "transaction_process", {"id": tx_id})
        # approve -> settles
        call("admin_transaction_approve", "admin", "invoice", "transaction_approve", {"id": tx_id})
        call("ipn_invoice_after_approve", "admin", "invoice", "get", {"id": inv})
        call("ipn_txn_after_approve", "admin", "invoice", "transaction_get", {"id": tx_id})
    call("admin_client_balance_after", "admin", "client", "get", {"id": 1})
    # admin-created received txn -> approve settles it
    inv2 = issued_invoice(40)
    created = call("admin_transaction_create_received", "admin", "invoice", "transaction_create",
                   {"invoice_id": inv2, "gateway_id": 1, "txn_id": f"ADM-CAP13-{int(time.time())}",
                    "txn_status": "pending", "type": "payment", "status": "received"})
    tx2 = created.get("result")
    if isinstance(tx2, int):
        call("admin_transaction_approve_received", "admin", "invoice", "transaction_approve", {"id": tx2})
        call("approve_received_invoice_after", "admin", "invoice", "get", {"id": inv2})
        call("approve_received_txn_after", "admin", "invoice", "transaction_get", {"id": tx2})
        call("admin_client_balance_final", "admin", "client", "get", {"id": 1})
    # process_all with nothing pending
    call("admin_transaction_process_all", "admin", "invoice", "transaction_process_all")
    # claim_for_processing on the settled txn (harmless read of behavior)
    if isinstance(tx_id, int):
        call("admin_transaction_claim", "admin", "invoice", "transaction_claim_for_processing", {"id": tx_id})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
