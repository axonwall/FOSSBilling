#!/usr/bin/env python3
"""Phase 4 batch 2 parity: Email module (history/templates/send),
invoice lifecycle email queueing, and the TS invoice PDF.
PHP oracles: captures14/, captures14b/."""
import hashlib, hmac, json, pathlib, sqlite3, subprocess, sys, time
import urllib.request, urllib.parse, http.cookiejar

PHP = "http://127.0.0.1:8080"
NEXT = "http://127.0.0.1:3001"
HERE = pathlib.Path(__file__).parent
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
results = []


def report(name, ok, detail=""):
    results.append((name, ok))
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def call(base, cj, role, module, method, data=None, raw_json=False):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    seg = "/api/fb" if base == NEXT else "/api"
    if raw_json:
        req = urllib.request.Request(f"{base}{seg}/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json",
                                              "X-CSRF-TOKEN": csrf or ""})
    else:
        payload = flatten(dict(data or {}))
        if csrf:
            payload["CSRFToken"] = csrf
        req = urllib.request.Request(f"{base}{seg}/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def login_next():
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(NEXT, cj, "guest", "staff", "login",
             {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    assert r.get("error") is None, r
    return cj


def db():
    return sqlite3.connect(DBP)


def main():
    cj = login_next()
    cap = lambda n: json.loads((HERE / "captures14" / f"{n}.json").read_text())
    capb = lambda n: json.loads((HERE / "captures14b" / f"{n}.json").read_text())

    r = call(NEXT, cj, "admin", "email", "email_get_list")
    report("email_history_list_empty", r == cap("admin_email_get_list"), json.dumps(r)[:160])

    for name, method in [("email_get_missing", "email_get"), ("email_resend_missing", "email_resend"),
                         ("email_delete_missing", "email_delete")]:
        r = call(NEXT, cj, "admin", "email", method, {"id": 99999})
        report(name, r == capb(f"admin_{name}"), json.dumps(r)[:160])

    r = call(NEXT, cj, "admin", "email", "send",
             {"to": "phase0.client@example.com", "subject": "x", "content": "y",
              "from": "admin@phase0.local", "from_name": "A"})
    report("send_missing_to_name", r == capb("admin_email_send_missing_name"), json.dumps(r)[:160])

    r = call(NEXT, cj, "admin", "email", "send",
             {"to": "phase0.client@example.com", "to_name": "Phase Zero",
              "subject": "Parity11 hello", "content": "Hello from parity11",
              "from": "admin@phase0.local", "from_name": "Phase Zero Admin"})
    d = db()
    row = d.execute("SELECT recipient, sender, subject, status FROM email_queue WHERE subject = 'Parity11 hello' ORDER BY id DESC LIMIT 1").fetchone()
    report("send_queues_pending", r.get("result") is True and row == ("phase0.client@example.com", "admin@phase0.local", "Parity11 hello", "pending"),
           f"{r} row={row}")

    r = call(NEXT, cj, "admin", "email", "template_get_list")
    # Live PHP total (the template set grows when built-ins regenerate;
    # the capture14 snapshot predates one regeneration).
    cj_php = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj_php))
    op.open(f"{PHP}/login", timeout=20).read()
    call(PHP, cj_php, "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    php_list = call(PHP, cj_php, "admin", "email", "template_get_list")["result"]
    ts_list = (r.get("result") or {})
    report("template_list_total", ts_list.get("total") == php_list["total"] and len(ts_list.get("list", [])) == len(php_list["list"]),
           f"ts={ts_list.get('total')} php={php_list['total']}")

    php_tpl = cap("admin_email_template_get")["result"]
    r = call(NEXT, cj, "admin", "email", "template_get", {"id": php_tpl["id"]})
    ts_tpl = r.get("result") or {}
    keys = ["id", "action_code", "category", "enabled", "subject", "description",
            "is_custom", "has_default", "is_overridden", "content", "subject_override", "content_override"]
    report("template_get_builtin", all(ts_tpl.get(k) == php_tpl.get(k) for k in keys),
           json.dumps({k: (ts_tpl.get(k), php_tpl.get(k)) for k in keys if ts_tpl.get(k) != php_tpl.get(k)})[:240])

    d = db()
    tpl_id = d.execute("SELECT id FROM email_template WHERE action_code = 'mod_invoice_payment_reminder'").fetchone()[0]
    r = call(NEXT, cj, "admin", "email", "template_render", {"id": tpl_id})
    php_render = str(capb("admin_email_template_render").get("result"))
    report("template_render_reminder",
           isinstance(r.get("result"), str) and "Invoice Payment Reminder" in r["result"] and "Invoice Payment Reminder" in php_render,
           str(r.get("result"))[:120])

    r = call(NEXT, cj, "admin", "email", "template_create",
             {"action_code": "parity11_test", "subject": "Hi {{ c.first_name }}", "content": "Body"}, raw_json=True)
    report("template_create_var_rejected",
           (r.get("error") or {}).get("message", "").startswith('Email template rendering error: Variable "c" does not exist'),
           json.dumps(r)[:160])

    r = call(NEXT, cj, "admin", "email", "template_create",
             {"action_code": "parity11_plain", "subject": "Plain subject", "content": "Plain body", "enabled": 1}, raw_json=True)
    new_id = r.get("result")
    ok = isinstance(new_id, int)
    if ok:
        g = call(NEXT, cj, "admin", "email", "template_get", {"id": new_id})
        ok = (g.get("result") or {}).get("subject") == "Plain subject" and (g.get("result") or {}).get("is_custom") is True
        u = call(NEXT, cj, "admin", "email", "template_update", {"id": new_id, "subject": "Updated subject"}, raw_json=True)
        g2 = call(NEXT, cj, "admin", "email", "template_get", {"id": new_id})
        ok = ok and u.get("result") is True and (g2.get("result") or {}).get("subject") == "Updated subject"
        call(NEXT, cj, "admin", "email", "template_delete", {"id": new_id})
        g3 = call(NEXT, cj, "admin", "email", "template_get", {"id": new_id})
        ok = ok and (g3.get("error") or {}).get("message") == "Email template not found"
    report("template_crud_roundtrip", ok, "")

    r = call(NEXT, cj, "admin", "email", "batch_sendmail")
    row2 = d.execute("SELECT status FROM email_queue WHERE subject = 'Parity11 hello' ORDER BY id DESC LIMIT 1").fetchone()
    report("batch_sendmail_flips_sending", r.get("result") is None and row2 == ("sending",), f"{r} {row2}")
    d.execute("DELETE FROM email_queue WHERE subject = 'Parity11 hello'")
    d.commit()

    # Reminder queueing (invoice 2 is unpaid/issued)
    call(NEXT, cj, "admin", "invoice", "send_reminder", {"id": 2})
    q = d.execute("SELECT recipient, subject, content FROM email_queue WHERE subject LIKE '%Payment Reminder' ORDER BY id DESC LIMIT 1").fetchone()
    ok = q is not None and q[0] == "phase0.client@example.com" and "FOSS00002" in (q[2] or "")
    report("reminder_queues_rendered_email", ok, str(q)[:160])
    if q:
        d.execute("DELETE FROM email_queue WHERE subject LIKE '%Payment Reminder' AND id = (SELECT MAX(id) FROM email_queue)")
        d.commit()

    # Lifecycle emails: issue + pay a fresh invoice via TS
    prep = call(NEXT, cj, "admin", "invoice", "prepare",
                {"client_id": 1, "items": [{"title": "Parity11 line", "price": 12, "quantity": 1, "taxed": 0}]}, raw_json=True)
    prep_result = prep.get("result")
    inv_id = prep_result if isinstance(prep_result, int) else (prep_result or {}).get("id")
    ok = inv_id is not None
    if ok:
        call(NEXT, cj, "admin", "invoice", "issue", {"id": inv_id})
        q1 = d.execute("SELECT COUNT(*) FROM email_queue WHERE subject LIKE '%Invoice Created' AND recipient = 'phase0.client@example.com'").fetchone()[0]
        call(NEXT, cj, "admin", "invoice", "mark_as_paid", {"id": inv_id, "gateway_id": 1})
        q2 = d.execute("SELECT COUNT(*) FROM email_queue WHERE subject LIKE '%Payment Received' AND recipient = 'phase0.client@example.com'").fetchone()[0]
        ok = q1 >= 1 and q2 >= 1
        d.execute("DELETE FROM email_queue WHERE recipient = 'phase0.client@example.com' AND (subject LIKE '%Invoice Created' OR subject LIKE '%Payment Received') AND id > (SELECT COALESCE(MAX(id),0) FROM email_queue) - 4")
        d.execute("DELETE FROM invoice WHERE id = ?", (inv_id,))
        d.execute("DELETE FROM invoice_item WHERE invoice_id = ?", (inv_id,))
        d.commit()
    report("lifecycle_emails_queued", ok, "")

    # PDF
    h = d.execute("SELECT hash FROM invoice WHERE id = 1").fetchone()[0]
    req = urllib.request.Request(f"{NEXT}/invoices/{h}/pdf")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read(); ctype = resp.headers.get("Content-Type")
    except urllib.error.HTTPError as e:
        data = b""; ctype = f"HTTP {e.code}"
    (HERE / "ts_invoice1.pdf").write_bytes(data)
    text = subprocess.run(["pdftotext", str(HERE / "ts_invoice1.pdf"), "-"],
                          capture_output=True, text=True).stdout
    need = ["FOSS00001", "Phase0 line A", "$60.00", "Phase0 line B", "$40.00", "$100.00", "Paid"]
    report("pdf_content", ctype == "application/pdf" and data.startswith(b"%PDF") and all(n in text for n in need),
           f"ctype={ctype} missing={[n for n in need if n not in text]}")
    req = urllib.request.Request(f"{NEXT}/invoices/deadbeefdeadbeef/pdf")
    try:
        urllib.request.urlopen(req, timeout=20)
        code = 200
    except urllib.error.HTTPError as e:
        code = e.code
    report("pdf_unknown_hash_404", code == 404, f"code={code}")

    bad = [n for n, ok in results if not ok]
    print(f"\nparity Phase4-2: {len(results) - len(bad)}/{len(results)} match" + (f" — DIFFS: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
