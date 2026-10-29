#!/usr/bin/env python3
"""R5b capture: PHP vs TS invoice currency_rate / base_income / base_refund
shapes at every stage (creation, issue, payment, partial/full refund,
credit note, debit note, funds invoice, missing-rate payment error).

Runs each flow on PHP first, records, restores the full DB snapshot,
then runs the same flow on TS (current, pre-fix code) and records.
Captures contain envelopes + DB rows only — never tokens or secrets.

Usage: python3 capture38.py  (writes captures38/*.json)
Exit 0 only when every flow records on both stacks.
"""
import hashlib
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
OUT = pathlib.Path(__file__).parent / "captures38"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"
NOW = "2026-10-29 12:00:00"


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(opener, url, email, password, api):
    resp = opener.open(PHP + "/login")
    page = resp.read().decode("utf-8", "replace")
    token = re.search(r'name="CSRFToken" value="([^"]+)"', page).group(1)
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(PHP + f"/api/guest/{api}/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def call(opener, token, base, role, module, method, params=None, as_json=False):
    if as_json:
        payload = {"CSRFToken": token} if token else {}
        payload.update(params or {})
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}",
            data=body, method="POST", headers={"Content-Type": "application/json"})
    else:
        payload = dict(params or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
    try:
        raw = opener.open(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    return json.loads(raw)


def main():
    OUT.mkdir(exist_ok=True)
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    snaps = {}
    for t in tables:
        cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
    seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()

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

    def row(inv_id):
        r = d.execute(
            "SELECT id, client_id, serie, nr, currency, currency_rate, base_income, base_refund,"
            " refund, credit, status, issued, taxrate FROM invoice WHERE id = ?", (inv_id,)).fetchone()
        return dict(r) if r else None

    def items(inv_id):
        return [dict(r) for r in d.execute(
            "SELECT id, title, price, quantity, taxed, status FROM invoice_item"
            " WHERE invoice_id = ? ORDER BY id", (inv_id,))]

    def setup():
        # EUR currency (conversion_rate 0.9, non-default) + EUR client + tax rule + tax on.
        d.execute(
            "INSERT INTO currency (code, conversion_rate, is_rate_manual, is_default,"
            " format_pattern, fraction_digits, created_at, updated_at)"
            " VALUES ('EUR', 0.9, 1, 0, NULL, NULL, ?, ?)", (NOW, NOW))
        role = d.execute("SELECT role FROM client WHERE id = 1").fetchone()[0]
        d.execute(
            "INSERT INTO client (email, first_name, last_name, currency, status, role,"
            " tax_exempt, created_at, updated_at)"
            " VALUES ('eur.capture@example.com', 'Eur', 'Capture', 'EUR', 'active', ?, 0, ?, ?)",
            (role, NOW, NOW))
        eur_client = d.execute(
            "SELECT id FROM client WHERE email = 'eur.capture@example.com'").fetchone()[0]
        d.execute(
            "INSERT INTO tax (name, country, state, taxrate, created_at, updated_at)"
            " VALUES ('Capture TX tax', 'US', 'TX', '10', ?, ?)", (NOW, NOW))
        d.execute(
            "INSERT INTO setting (param, value, created_at, updated_at)"
            " VALUES ('tax_enabled', '1', ?, ?)", (NOW, NOW))
        d.commit()
        return eur_client

    def run_stack(base, label):
        op = make_opener()
        stok = login(op, PHP, SUPER_EMAIL, SUPER_PASS, "staff")
        cop = make_opener()
        ctok = login(cop, PHP, CLIENT_EMAIL, CLIENT_PASS, "client")
        eur_client = setup()
        rec = {}

        def get(inv_id):
            env = call(op, stok, base, "admin", "invoice", "get", {"id": str(inv_id)})
            r = env.get("result", {})
            return {"envelope": env, "picked": {
                "currency_rate": r.get("currency_rate", "<ABSENT>"),
                "base_income": r.get("base_income", "<ABSENT>"),
                "base_refund": r.get("base_refund", "<ABSENT>"),
                "income": r.get("income", "<ABSENT>"),
                "refund": r.get("refund", "<ABSENT>"),
                "status": r.get("status"), "total": r.get("total")}}

        def create(client_id, item_list, gateway="1"):
            env = call(op, stok, base, "admin", "invoice", "prepare",
                       {"client_id": str(client_id), "gateway_id": gateway, "items": item_list},
                       as_json=True)
            assert env.get("error") is None, f"create failed on {label}: {str(env)[:300]}"
            return env["result"]

        # 1. USD draft (untaxed 100) + issue.
        iid = create(1, [{"title": "Capture item", "price": 100, "quantity": 1, "taxed": False}])
        rec["usd_draft"] = {"db": row(iid), "get": get(iid)}
        call(op, stok, base, "admin", "invoice", "issue", {"id": str(iid)})
        rec["usd_issued"] = {"db": row(iid), "get": get(iid)}
        # 2. USD pay (Custom).
        env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                   {"id": str(iid), "gateway_id": "1", "transactionId": f"R5B-USD-{label}"})
        assert env.get("error") is None, f"pay failed on {label}: {str(env)[:300]}"
        rec["usd_paid"] = {"db": row(iid), "get": get(iid)}
        # 3. USD taxed pay (100 + 10% tax = 110 total; base_income must be 100 on PHP).
        tid = create(1, [{"title": "Taxed item", "price": 100, "quantity": 1, "taxed": True}])
        env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                   {"id": str(tid), "gateway_id": "1", "transactionId": f"R5B-TAX-{label}"})
        assert env.get("error") is None, f"taxed pay failed on {label}: {str(env)[:300]}"
        rec["usd_taxed_paid"] = {"db": row(tid), "get": get(tid)}
        # 4. EUR pay (90 @ 0.9 -> base 100 exactly).
        eid = create(eur_client, [{"title": "EUR item", "price": 90, "quantity": 1, "taxed": False}])
        rec["eur_draft"] = {"db": row(eid), "get": get(eid)}
        env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                   {"id": str(eid), "gateway_id": "1", "transactionId": f"R5B-EUR-{label}"})
        assert env.get("error") is None, f"EUR pay failed on {label}: {str(env)[:300]}"
        rec["eur_paid"] = {"db": row(eid), "get": get(eid)}
        # 5. EUR partial refund (lines 60 + 30 = 90; refund the 60 line -> 66.67).
        pid = create(eur_client, [{"title": "P1", "price": 60, "quantity": 1, "taxed": False},
                                  {"title": "P2", "price": 30, "quantity": 1, "taxed": False}])
        call(op, stok, base, "admin", "invoice", "mark_as_paid",
             {"id": str(pid), "gateway_id": "1", "transactionId": f"R5B-EURP-{label}"})
        plines = items(pid)
        if base == PHP:
            env = call(op, stok, base, "admin", "invoice", "refund",
                       {"id": str(pid), "items": {str(plines[0]["id"]): 1}}, as_json=True)
        else:
            env = call(op, stok, base, "admin", "invoice", "refund",
                       {"id": str(pid), "items": [{"id": plines[0]["id"]}]}, as_json=True)
        assert env.get("error") is None, f"partial refund failed on {label}: {str(env)[:300]}"
        note_id = env["result"]
        rec["eur_partial"] = {"db": row(pid), "get": get(pid),
                              "note_db": row(note_id), "note_get": get(note_id)}
        # 6. USD full refund.
        fid = create(1, [{"title": "Full item", "price": 100, "quantity": 1, "taxed": False}])
        call(op, stok, base, "admin", "invoice", "mark_as_paid",
             {"id": str(fid), "gateway_id": "1", "transactionId": f"R5B-USDF-{label}"})
        env = call(op, stok, base, "admin", "invoice", "refund", {"id": str(fid)})
        assert env.get("error") is None, f"full refund failed on {label}: {str(env)[:300]}"
        note_id = env["result"]
        rec["usd_full_refund"] = {"db": row(fid), "get": get(fid),
                                  "note_db": row(note_id), "note_get": get(note_id)}
        # 7. Debit on an issued unpaid invoice (25 USD).
        did = create(1, [{"title": "Debit base", "price": 50, "quantity": 1, "taxed": False}])
        call(op, stok, base, "admin", "invoice", "issue", {"id": str(did)})
        env = call(op, stok, base, "admin", "invoice", "debit",
                   {"id": str(did), "items": [{"title": "Extra", "price": 25, "quantity": 1}]},
                   as_json=True)
        assert env.get("error") is None, f"debit failed on {label}: {str(env)[:300]}"
        note_id = env["result"]
        rec["usd_debit"] = {"db": row(did), "get": get(did),
                            "note_db": row(note_id), "note_get": get(note_id)}
        # 8. Funds invoice (client 1, 50).
        env = call(cop, ctok, base, "client", "invoice", "funds_invoice",
                   {"amount": "50"})
        assert env.get("error") is None, f"funds failed on {label}: {str(env)[:300]}"
        fhash = env["result"]
        frow = d.execute("SELECT id FROM invoice WHERE hash = ?", (fhash,)).fetchone()
        assert frow, "funds invoice row not found"
        rec["funds"] = {"db": row(frow[0]), "get": get(frow[0])}
        # 9. Missing-rate pay: EUR draft, then delete the EUR row, then pay.
        mid = create(eur_client, [{"title": "No rate", "price": 10, "quantity": 1, "taxed": False}])
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                   {"id": str(mid), "gateway_id": "1", "transactionId": f"R5B-NORATE-{label}"})
        rec["missing_rate"] = {"envelope": env, "db": row(mid)}
        return rec

    try:
        php = run_stack(PHP, "php")
        (OUT / "php.json").write_text(json.dumps(php, indent=2, default=str))
        print("php flows recorded")
        restore()
        ts = run_stack(TS, "ts")
        (OUT / "ts.json").write_text(json.dumps(ts, indent=2, default=str))
        print("ts flows recorded")
    finally:
        restore()
        print("restored")


if __name__ == "__main__":
    main()
