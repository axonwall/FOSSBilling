#!/usr/bin/env python3
"""Phase 3 batch 2 capture corpus: Invoice reads + lifecycle + tax CRUD
(PHP oracle). Writes captures10/*.json; parity7.py replays via Next.
Invoice hashes/timestamps in captures are state data — parity7
normalizes volatile fields and refers to invoices by the ids it
creates itself where the flow is a mutation sequence."""
import json, pathlib, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures10"
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
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if csrf():
            req.add_header("X-CSRF-TOKEN", csrf())
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
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}", "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def main():
    opener.open(f"{BASE}/login", timeout=20).read()
    call("guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    call("admin_invoice_get_list", "admin", "invoice", "get_list")
    call("admin_invoice_get_list_summary", "admin", "invoice", "get_list", {"summary": 1})
    one = call("admin_invoice_get", "admin", "invoice", "get", {"id": 1})
    hash1 = (one.get("result") or {}).get("hash")
    call("admin_invoice_get_missing", "admin", "invoice", "get", {"id": 99999})
    # lifecycle: prepare -> add item (JSON) -> get draft -> issue -> get
    prep = call("admin_invoice_prepare", "admin", "invoice", "prepare", {"client_id": 1})
    inv = prep.get("result")
    call("admin_invoice_update_new_item", "admin", "invoice", "update",
         {"id": inv, "new_item": {"title": "Capture line", "price": 42.5, "quantity": 2, "taxed": True}}, as_json=True)
    call("admin_invoice_get_draft", "admin", "invoice", "get", {"id": inv})
    call("admin_invoice_issue", "admin", "invoice", "issue", {"id": inv})
    got = call("admin_invoice_get_issued", "admin", "invoice", "get", {"id": inv})
    inv_hash = (got.get("result") or {}).get("hash")
    call("admin_invoice_mark_as_paid", "admin", "invoice", "mark_as_paid",
         {"id": inv, "gateway_id": 1, "transactionId": "CAP10-" + str(int(__import__("time").time()))})
    call("admin_invoice_get_paid", "admin", "invoice", "get", {"id": inv})
    # throwaway for delete
    prep2 = call("admin_invoice_prepare_throwaway", "admin", "invoice", "prepare", {"client_id": 1})
    inv2 = prep2.get("result")
    call("admin_invoice_delete", "admin", "invoice", "delete", {"id": inv2})
    call("admin_invoice_get_deleted", "admin", "invoice", "get", {"id": inv2})
    # tax CRUD
    tc = call("admin_tax_create", "admin", "invoice", "tax_create",
              {"name": "Capture Tax", "country": "ZZ", "taxrate": "7.5"})
    tax_id = tc.get("result")
    call("admin_tax_get_list", "admin", "invoice", "tax_get_list")
    call("admin_tax_get", "admin", "invoice", "tax_get", {"id": tax_id})
    call("admin_tax_update_partial", "admin", "invoice", "tax_update", {"id": tax_id, "taxrate": "8.25"})
    call("admin_tax_update", "admin", "invoice", "tax_update",
         {"id": tax_id, "name": "Capture Tax", "country": "ZZ", "taxrate": "8.25"})
    call("admin_tax_get_after_update", "admin", "invoice", "tax_get", {"id": tax_id})
    call("admin_tax_delete", "admin", "invoice", "tax_delete", {"id": tax_id})
    call("admin_tax_get_deleted", "admin", "invoice", "tax_get", {"id": tax_id})
    # client + guest views of the seeded paid invoice 1
    call("guest_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
    call("client_invoice_get_list", "client", "invoice", "get_list")
    call("client_invoice_get", "client", "invoice", "get", {"id": 1})
    if hash1:
        call("client_invoice_get_hash", "client", "invoice", "get", {"hash": hash1})
    call("client_invoice_get_missing", "client", "invoice", "get", {"hash": "deadbeefdeadbeef"})
    if inv_hash:
        call("guest_invoice_get", "guest", "invoice", "get", {"hash": inv_hash})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
