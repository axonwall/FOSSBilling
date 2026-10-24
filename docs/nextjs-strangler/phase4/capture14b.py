#!/usr/bin/env python3
"""Phase 4 batch 2 capture 14b: email error surfaces + template
render/create/update/delete round trip. PHP oracle."""
import json, pathlib, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures14b"
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
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "X-CSRF-TOKEN": csrf() or ""})
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


def main():
    opener.open(f"{BASE}/login", timeout=20).read()
    call("guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    call("admin_email_get_missing", "admin", "email", "email_get", {"id": 99999})
    call("admin_email_resend_missing", "admin", "email", "email_resend", {"id": 99999})
    call("admin_email_delete_missing", "admin", "email", "email_delete", {"id": 99999})
    call("admin_email_send_missing_name", "admin", "email", "send",
         {"to": "phase0.client@example.com", "subject": "x", "content": "y",
          "from": "admin@phase0.local", "from_name": "A"})
    import sqlite3
    db = sqlite3.connect("/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite")
    tpl_id = db.execute("SELECT id FROM email_template WHERE action_code = 'mod_invoice_payment_reminder'").fetchone()[0]
    call("admin_email_template_render", "admin", "email", "template_render", {"id": tpl_id})
    created = call("admin_email_template_create", "admin", "email", "template_create",
                   {"action_code": "capture14_test", "subject": "Hi {{ c.first_name }}",
                    "content": "Body {{ c.first_name }}", "enabled": 1, "category": "client"}, raw_json=True)
    new_id = created.get("result")
    if isinstance(new_id, int):
        call("admin_email_template_get_created", "admin", "email", "template_get", {"id": new_id})
        call("admin_email_template_update", "admin", "email", "template_update",
             {"id": new_id, "subject": "Updated subject"}, raw_json=True)
        call("admin_email_template_get_updated", "admin", "email", "template_get", {"id": new_id})
        call("admin_email_template_delete", "admin", "email", "template_delete", {"id": new_id})
        call("admin_email_template_get_deleted", "admin", "email", "template_get", {"id": new_id})
    call("admin_email_batch_sendmail", "admin", "email", "batch_sendmail")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
