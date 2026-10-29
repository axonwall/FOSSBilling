#!/usr/bin/env python3
"""R5c parity suite: PHP vs TS rendered output
for every {% set %} email template, via admin/email/template_send
(rendered subject+content land in email_queue). Snapshot-restored.

Run: python3 parity36.py  (exits non-zero on any failure)
Servers must be up: PHP :8080, Next :3001 (see findings-r5c §1).
"""
import hashlib
import re
import http.cookiejar
import json
import pathlib
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
OUT = None  # parity36 writes no capture files; it compares in-memory
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
        before_q = d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0]
        env = call("admin", "email", "template_send",
                   {"code": "r5c_strict_set", "to": "x@example.com", "from": "r5c@example.com"})
        after_q = d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0]
        rec["strict_set_missing"] = {"envelope": env, "queue_before": before_q, "queue_after": after_q}
        # Validation baseline over all templates.
        rec["validate_all"] = call("admin", "email", "template_validate_all", {})
        return rec

    def scrub(s):
        if not isinstance(s, str):
            return s
        # PHP embeds a per-template hash; TS emits the bare name
        # (documented R1d behavior). Normalize both to <hash>.
        s = re.sub(r"__string_template__[0-9a-f]+", "__string_template__<hash>", s)
        return s.replace('"__string_template__"', '"__string_template__<hash>"')

    def scrub_env(env):
        # Deep-scrub: hashes appear in validate_all result errors too.
        def walk(v):
            if isinstance(v, str):
                return scrub(v)
            if isinstance(v, list):
                return [walk(x) for x in v]
            if isinstance(v, dict):
                return {k: walk(x) for k, x in v.items()}
            return v
        return walk(json.loads(json.dumps(env)))

    CHECKS = [0]
    FAILURES = []

    def check(name, cond, detail=""):
        CHECKS[0] += 1
        if cond:
            print(f"PASS {name}")
        else:
            print(f"FAIL {name} :: {detail[:400]}")
            FAILURES.append(name)

    try:
        php = run_stack(PHP, "http://127.0.0.1:8080/login", "php")
        restore()
        ts = run_stack(TS, "http://127.0.0.1:3001/api/fb/__prime", "ts")
    finally:
        restore()

    # ---- A. Full rendered-body equality per send case.
    SEND_CASES = ["t6_guest", "t6_client", "t11_guest", "t11_client",
                  "t26_guest", "t26_client", "tclose_guest", "tclose_client",
                  "t2_present", "t2_absent", "t12_present", "t12_absent"]
    for key in SEND_CASES:
        pe, te = php[key]["envelope"], ts[key]["envelope"]
        check(f"A {key} envelopes no error", pe.get("error") is None and te.get("error") is None,
              f"php={pe.get('error')} ts={te.get('error')}")
        check(f"A {key} queue equal", php[key]["queue"] == ts[key]["queue"],
              f"php={php[key]['queue']} ts={ts[key]['queue']}")

    # ---- B. Branch-specific content, asserted exactly (on PHP, then
    # equality in A already proves TS matches; these name the branch).
    def body(stack, key):
        return (stack[key]["queue"] or {}).get("content", "")

    check("B t6_guest greeting", "Hello, Guest User." in body(php, "t6_guest"))
    check("B t6_guest hash link", "support/ticket/guesthash123" in body(php, "t6_guest"))
    check("B t6_guest no id link", "support/ticket/102" not in body(php, "t6_guest"))
    check("B t6_client no greeting", "Hello, Guest User." not in body(php, "t6_client"))
    check("B t6_client id link", "support/ticket/102" in body(php, "t6_client"))
    check("B t6_client no hash link", "support/ticket/clienthash456" not in body(php, "t6_client"))
    check("B t6 department", "General Support" in body(php, "t6_guest"))
    check("B t6 status title", "Status:</strong> Open" in body(php, "t6_guest"))
    check("B t11_client login block", "login?email=phase0.client%40example.com" in body(php, "t11_client"))
    check("B t11_client on_hold title", "Status:</strong> On_Hold" in body(php, "t11_client"))
    check("B t11_guest no login block", "login?email=" not in body(php, "t11_guest"))
    check("B t26_client first message", "Client first message here" in body(php, "t26_client"))
    check("B t26_guest first message", "Guest first message here" in body(php, "t26_guest"))
    check("B tclose_client id link", "support/ticket/102" in body(php, "tclose_client"))
    check("B tclose_guest hash link", "support/ticket/guesthash123" in body(php, "tclose_guest"))
    check("B t2_present title", "Widget Order" in body(php, "t2_present"))
    check("B t12_present date", "Oct 1, 2026" in body(php, "t12_present"))

    # ---- C. STRICTness: set RHS with a missing var 9999s both stacks,
    # no queue row written, and validation agrees.
    for stack, rec in (("php", php), ("ts", ts)):
        env = scrub_env(rec["strict_set_missing"]["envelope"])
        err = env.get("error") or {}
        check(f"C strict {stack} error", err.get("message") == 'Email template rendering error: Variable "nosuchvar" does not exist in "__string_template__<hash>" at line 1.'
              and err.get("code") == 9999, f"{stack}={env}")
        check(f"C strict {stack} no queue row",
              rec["strict_set_missing"]["queue_before"] == rec["strict_set_missing"]["queue_after"])
    check("C validate_all equal",
          scrub_env(php["validate_all"]) == scrub_env(ts["validate_all"]),
          f"php={php['validate_all'].get('result')} ts={ts['validate_all'].get('result')}")
    check("C validate_all strict invalid on both",
          php["validate_all"]["result"]["invalid"] == 1
          and ts["validate_all"]["result"]["invalid"] == 1,
          f"php={php['validate_all'].get('result')} ts={ts['validate_all'].get('result')}")

    # ---- D. Restore proof.
    inv = {
        "tld": d.execute("SELECT COUNT(*) FROM tld").fetchone()[0],
        "service_custom": d.execute("SELECT COUNT(*) FROM service_custom").fetchone()[0],
        "email_queue": d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0],
        "setting_rows": d.execute("SELECT COUNT(*) FROM setting").fetchone()[0],
        "invoice": d.execute("SELECT COUNT(*) FROM invoice").fetchone()[0],
        "client_order": d.execute("SELECT COUNT(*) FROM client_order").fetchone()[0],
        "support_ticket": d.execute("SELECT COUNT(*) FROM support_ticket").fetchone()[0],
        "client": d.execute("SELECT COUNT(*) FROM client").fetchone()[0],
        "admin": d.execute("SELECT COUNT(*) FROM admin").fetchone()[0],
        "admin_group": d.execute("SELECT COUNT(*) FROM admin_group").fetchone()[0],
        "admin_group_member": d.execute("SELECT COUNT(*) FROM admin_group_member").fetchone()[0],
        "currency": d.execute("SELECT COUNT(*) FROM currency").fetchone()[0],
        "extension": d.execute("SELECT COUNT(*) FROM extension").fetchone()[0],
        "extension_meta": d.execute("SELECT COUNT(*) FROM extension_meta").fetchone()[0],
    }
    check("D invariants after", inv == {
        "tld": 1, "service_custom": 17, "email_queue": 67, "setting_rows": 38, "invoice": 323,
        "client_order": 11, "support_ticket": 2, "client": 3, "admin": 2, "admin_group": 3,
        "admin_group_member": 1, "currency": 1, "extension": 6, "extension_meta": 3},
        f"got={inv}")
    check("D config hash after", hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)
    check("D sequences after", d.execute("SELECT name, seq FROM sqlite_sequence").fetchall() == seq)
    check("D crafted templates gone",
          d.execute("SELECT COUNT(*) FROM email_template WHERE action_code LIKE 'r5c%'").fetchone()[0] == 0)

    print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILURES:", FAILURES)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
