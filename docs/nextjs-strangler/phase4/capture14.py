#!/usr/bin/env python3
"""Phase 4 batch 2 capture corpus: email queue + templates + send,
invoice reminder queueing, and the PHP invoice PDF. PHP oracle."""
import json, pathlib, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures14"
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
    lst = call("admin_email_get_list", "admin", "email", "email_get_list")
    items = ((lst.get("result") or {}).get("list")) or []
    if items:
        call("admin_email_get", "admin", "email", "email_get", {"id": items[0]["id"]})
    sent = call("admin_email_send", "admin", "email", "send",
                {"to": "phase0.client@example.com", "to_name": "Phase Zero",
                 "subject": "Capture14 hello",
                 "content": "Hello from capture14", "from": "admin@phase0.local",
                 "from_name": "Phase Zero Admin"})
    lst2 = call("admin_email_get_list_after", "admin", "email", "email_get_list")
    items2 = ((lst2.get("result") or {}).get("list")) or []
    mine = [i for i in items2 if i.get("subject") == "Capture14 hello"]
    if mine:
        eid = mine[0]["id"]
        call("admin_email_get_sent", "admin", "email", "email_get", {"id": eid})
        call("admin_email_resend", "admin", "email", "email_resend", {"id": eid})
        call("admin_email_delete", "admin", "email", "email_delete", {"id": eid})
    templates = call("admin_email_template_get_list", "admin", "email", "template_get_list")
    titems = ((templates.get("result") or {}).get("list")) or []
    codes = [t.get("code") for t in titems]
    print("template codes:", codes[:12])
    if titems:
        call("admin_email_template_get", "admin", "email", "template_get", {"id": titems[0]["id"]})
    # invoice reminder on an UNPAID issued invoice: queue effect?
    before = {i["id"] for i in items2}
    import json as _json
    unpaid_id = None
    lst_u = call("tmp", "admin", "invoice", "get_list", {"status": "unpaid"}) if False else None
    call("admin_invoice_send_reminder", "admin", "invoice", "send_reminder", {"id": 2})
    lst3 = call("admin_email_get_list_reminder", "admin", "email", "email_get_list")
    items3 = ((lst3.get("result") or {}).get("list")) or []
    new_rows = [i for i in items3 if i["id"] not in before]
    print("reminder queued rows:", json.dumps(new_rows)[:240])
    (OUT / "reminder_new_rows.json").write_text(json.dumps(new_rows, indent=2))
    # PDF for invoice 1 (hash from the invoice record)
    inv = call("tmp", "admin", "invoice", "get", {"id": 1}) if False else None
    import sqlite3
    db = sqlite3.connect("/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite")
    h = db.execute("SELECT hash FROM invoice WHERE id = 1").fetchone()[0]
    req = urllib.request.Request(f"{BASE}/invoice/pdf/{h}")
    try:
        with opener.open(req, timeout=30) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type")
    except urllib.error.HTTPError as e:
        data = e.read(); ctype = f"HTTP {e.code}"
    (OUT / "invoice1.pdf").write_bytes(data)
    print("pdf bytes:", len(data), "content-type:", ctype)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
