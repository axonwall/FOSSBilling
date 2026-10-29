#!/usr/bin/env python3
"""R5c capture corpus (BEFORE the fix): PHP vs pre-fix TS rendered output
for every {% set %} email template, via admin/email/template_send
(rendered subject+content land in email_queue). Snapshot-restored.

Run: python3 capture39.py  (writes captures39/php.json + captures39/ts.json)
Servers must be up: PHP :8080, Next :3001 (see findings-r5c §1).
"""
import hashlib
import http.cookiejar
import json
import pathlib
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = HERE / "captures39"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
PHP = "http://127.0.0.1:8080/api"
TS = "http://127.0.0.1:3001/api/fb"
NOW = "2026-10-29 12:00:00"

GUEST_TICKET = {
    "id": 101, "hash": "guesthash123", "subject": "Guest help needed",
    "status": "open",
    "author": {"name": "Guest User", "role": "guest"},
    "helpdesk": {"name": "General Support"},
    "messages": [{"content": "Guest first message here"}],
}
CLIENT_TICKET = {
    "id": 102, "hash": "clienthash456", "subject": "Client issue",
    "status": "open",
    "author": {"name": "Phase Zero", "role": "client"},
    "helpdesk": {"name": "General Support"},
    "messages": [{"content": "Client first message here"}],
}
CLIENT_TICKET_HOLD = dict(CLIENT_TICKET)
CLIENT_TICKET_HOLD["status"] = "on_hold"
CLIENT = {"email": "phase0.client@example.com", "first_name": "Phase", "last_name": "Zero"}
STAFF = {"name": "Staff Name"}
ORDER = {
    "id": 5, "title": "Widget Order", "created_at": "2026-10-01 10:00:00",
    "activated_at": "2026-10-02 10:00:00",
    "client": {"first_name": "Phase", "last_name": "Zero"},
}


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    snaps = {}
    for t in tables:
        cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
    seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()
    cfg_hash = hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()

    def restore():
        for t in tables:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            d.executemany(
                f'INSERT INTO "{t}" (' + ",".join(cols) + ") VALUES (" + ",".join("?" * len(cols)) + ")",
                [tuple(r) for r in rows])
        d.execute("DELETE FROM sqlite_sequence")
        d.executemany("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", seq)
        d.commit()

    def run_stack(base, prime_url, label):
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(prime_url, timeout=20).read()

        def csrf():
            for c in cj:
                if c.name == "fossbilling_csrf":
                    return c.value
            return None

        def call(role, module, method, data=None):
            payload = dict(data or {})
            if csrf():
                payload["CSRFToken"] = csrf()
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                f"{base}/{role}/{module}/{method}", data=body, method="POST",
                headers={"Content-Type": "application/json"})
            try:
                with op.open(req, timeout=30) as resp:
                    return json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                return json.loads(e.read().decode())

        def send(code, to, vars_dict):
            # Crafted templates are inserted by the caller before send.
            data = {"code": code, "to": to, "from": "r5c@example.com"}
            data.update(vars_dict)
            env = call("admin", "email", "template_send", data)
            row = d.execute(
                "SELECT recipient, subject, content FROM email_queue ORDER BY id DESC LIMIT 1").fetchone()
            return {"envelope": env,
                    "queue": dict(row) if row else None}

        call("guest", "staff", "login",
             {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
        rec = {}
        # Seeded Support templates, guest + logged-in variants.
        rec["t6_guest"] = send("mod_support_ticket_open", "guest@example.com",
                               {"ticket": GUEST_TICKET})
        rec["t6_client"] = send("mod_support_ticket_open", "client@example.com",
                                {"ticket": CLIENT_TICKET, "c": CLIENT})
        rec["t11_guest"] = send("mod_support_ticket_staff_reply", "guest@example.com",
                                {"ticket": GUEST_TICKET})
        rec["t11_client"] = send("mod_support_ticket_staff_reply", "client@example.com",
                                 {"ticket": CLIENT_TICKET_HOLD, "c": CLIENT})
        rec["t26_guest"] = send("mod_support_ticket_staff_open", "guest@example.com",
                                {"ticket": GUEST_TICKET})
        rec["t26_client"] = send("mod_support_ticket_staff_open", "client@example.com",
                                 {"ticket": CLIENT_TICKET, "c": CLIENT})
        # Crafted staff_close from the PHP block file (subject + content
        # block inners; the file itself is not a seeded DB template).
        src = pathlib.Path("/home/hatch/scratch/fossbilling/repo/src/modules/Support/templates/email/mod_support_ticket_staff_close.html.twig").read_text()
        subj = src.split("{% block subject %}")[1].split("{% endblock %}")[0]
        content = src.split("{% block content %}")[1].rsplit("{% endblock %}", 1)[0]
        d.execute(
            "INSERT INTO email_template (category, enabled, is_custom, is_overridden, subject, content, description, vars, action_code)"
            " VALUES ('support', 1, 1, 0, ?, ?, NULL, NULL, 'r5c_support_ticket_staff_close')",
            (subj, content))
        d.commit()
        rec["tclose_guest"] = send("r5c_support_ticket_staff_close", "guest@example.com",
                                   {"ticket": GUEST_TICKET})
        rec["tclose_client"] = send("r5c_support_ticket_staff_close", "client@example.com",
                                    {"ticket": CLIENT_TICKET, "c": CLIENT})
        # Defensive-default templates, var present + absent.
        rec["t2_present"] = send("mod_servicecustom_activated", "client@example.com",
                                 {"order": ORDER, "c": CLIENT})
        rec["t2_absent"] = send("mod_servicecustom_activated", "client@example.com",
                                {"c": CLIENT})
        rec["t12_present"] = send("mod_staff_client_order", "staff@example.com",
                                  {"order": ORDER, "staff": STAFF})
        rec["t12_absent"] = send("mod_staff_client_order", "staff@example.com",
                                 {"staff": STAFF})
        # STRICT case: set RHS referencing a missing var.
        d.execute(
            "INSERT INTO email_template (category, enabled, is_custom, is_overridden, subject, content, description, vars, action_code)"
            " VALUES ('r5c', 1, 1, 0, 'Strict set', '{% set x = nosuchvar %}Hello.', NULL, NULL, 'r5c_strict_set')")
        d.commit()
        rec["strict_set_missing"] = send("r5c_strict_set", "x@example.com", {})
        # Validation baseline over all templates.
        rec["validate_all"] = call("admin", "email", "template_validate_all", {})
        return rec

    try:
        php = run_stack(PHP, "http://127.0.0.1:8080/login", "php")
        restore()
        ts = run_stack(TS, "http://127.0.0.1:3001/api/fb/__prime", "ts")
    finally:
        restore()
    OUT.mkdir(exist_ok=True)
    (OUT / "php.json").write_text(json.dumps(php, indent=2, sort_keys=True))
    (OUT / "ts.json").write_text(json.dumps(ts, indent=2, sort_keys=True))
    print("php cases:", len(php), "ts cases:", len(ts))
    for key in php:
        if key == "validate_all":
            print(key, "php:", php[key].get("result"), "ts:", ts[key].get("result"))
            continue
        pe, te = php[key]["envelope"], ts[key]["envelope"]
        pq, tq = php[key]["queue"], ts[key]["queue"]
        same = (pq == tq)
        print(f"{key}: php_err={pe.get('error')} ts_err={te.get('error')} bodies_equal={same}")


if __name__ == "__main__":
    main()
