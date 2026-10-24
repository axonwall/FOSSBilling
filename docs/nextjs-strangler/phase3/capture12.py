#!/usr/bin/env python3
"""Phase 3 batch 4 capture corpus: invoice corrections (refund/debit/
cancel/reissue), renewal invoices, journal, attach_order, batch jobs,
cron info. PHP oracle. Writes captures12/*.json."""
import json, pathlib, time, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures12"
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


def call(name, role, module, method, data=None, raw_json=False):
    if raw_json:
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(f"{BASE}/api/{module}/{method}" if False else f"{BASE}/api/{role}/{module}/{method}",
                                     data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        tok = csrf()
        if tok:
            req.add_header("X-CSRF-TOKEN", tok)
    else:
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


def paid_invoice(price=30, title="Batch4 line"):
    inv = call(None or "tmp", "admin", "invoice", "prepare", {"client_id": 1}) if False else None
    # inline sequence without manifest noise
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
        {"id": iid, "new_item": {"title": title, "price": price, "quantity": 1, "taxed": True}}, as_json=True)
    raw("admin", "invoice", "issue", {"id": iid})
    raw("admin", "invoice", "mark_as_paid",
        {"id": iid, "gateway_id": 1, "transactionId": f"CAP12-{int(time.time())}-{iid}"})
    return iid


def issued_invoice(price=30, title="Batch4 line"):
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
        {"id": iid, "new_item": {"title": title, "price": price, "quantity": 1, "taxed": True}}, as_json=True)
    raw("admin", "invoice", "issue", {"id": iid})
    return iid


def main():
    opener.open(f"{BASE}/login", timeout=20).read()
    call("guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    # refund flow
    inv1 = paid_invoice(30)
    refunded = call("admin_invoice_refund", "admin", "invoice", "refund", {"id": inv1})
    note_id = refunded.get("result")
    call("admin_invoice_get_after_refund", "admin", "invoice", "get", {"id": inv1})
    if isinstance(note_id, int):
        call("admin_invoice_get_credit_note", "admin", "invoice", "get", {"id": note_id})
    call("admin_invoice_refund_unpaid", "admin", "invoice", "refund", {"id": 1})
    # debit flow
    inv2 = paid_invoice(30)
    debit = call("admin_invoice_debit", "admin", "invoice", "debit",
                 {"id": inv2, "items": [{"title": "Extra charge", "price": 7.5, "quantity": 2, "taxed": False}]},
                 raw_json=True)
    debit_id = debit.get("result")
    call("admin_invoice_get_after_debit", "admin", "invoice", "get", {"id": inv2})
    if isinstance(debit_id, int):
        call("admin_invoice_get_debit_note", "admin", "invoice", "get", {"id": debit_id})
    # cancel flow (issued unpaid)
    inv3 = issued_invoice(25)
    call("admin_invoice_cancel", "admin", "invoice", "cancel", {"id": inv3})
    call("admin_invoice_get_after_cancel", "admin", "invoice", "get", {"id": inv3})
    # reissue flow (issued unpaid)
    inv4 = issued_invoice(25)
    re = call("admin_invoice_reissue", "admin", "invoice", "reissue", {"id": inv4})
    new_id = re.get("result")
    call("admin_invoice_get_after_reissue_old", "admin", "invoice", "get", {"id": inv4})
    if isinstance(new_id, int):
        call("admin_invoice_get_reissued_new", "admin", "invoice", "get", {"id": new_id})
    # journal + attach
    call("admin_invoice_journal", "admin", "invoice", "journal", {"id": 1})
    draft = call("tmp", "admin", "invoice", "prepare", {"client_id": 1}) if False else None
    # renewal invoice for active order 3
    call("admin_invoice_renewal", "admin", "invoice", "renewal_invoice", {"id": 3})
    # batch jobs + cron
    call("admin_invoice_batch_generate", "admin", "invoice", "batch_generate")
    call("admin_invoice_batch_activate_paid", "admin", "invoice", "batch_activate_paid")
    call("admin_invoice_batch_send_reminders", "admin", "invoice", "batch_send_reminders")
    call("admin_order_batch_suspend_expired", "admin", "order", "batch_suspend_expired")
    call("admin_order_batch_cancel_unpaid", "admin", "order", "batch_cancel_unpaid")
    call("admin_order_batch_cancel_suspended", "admin", "order", "batch_cancel_suspended")
    call("admin_cron_info", "admin", "cron", "info")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
