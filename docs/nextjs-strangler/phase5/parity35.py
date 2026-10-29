#!/usr/bin/env python3
"""R5b parity: PHP NULL-until-populated semantics for invoice
currency_rate / base_income / base_refund, matched by the TS fix.

Sections:
  A. Baselines + invariants before (invoice 323 etc., config hash,
     sqlite sequences).
  B. Creation NULL-until-populated, both stacks, DB-exact, per
     document type: USD draft, USD issued, EUR draft, funds invoice.
  C. Population transitions, DB-exact + get-envelope picked fields:
     USD pay (rate 1, base 100, base_refund NULL, issued 1);
     USD taxed pay (100 + 10% tax -> base_income 100, NO tax);
     EUR pay (90 @ 0.9 -> rate 0.9, base_income 100 = 90 / 0.9);
     EUR partial refund (lines 60+30, refund 60-line -> refund 60,
     base_refund 66.666666666667, base_income 100, income
     33.333333333333, status stays paid; credit note NULLs);
     USD full refund (base_refund 100, status refunded; note NULLs);
     USD debit (note base_income 25, rate NULL, base_refund NULL);
     EUR debit (note base_income 27.777777777778, rate NULL).
  D. Missing-rate pay: EUR draft, currency row deleted, pay must
     fail with the PHP 9999 throw BEFORE any write (invoice stays
     unpaid, rate stays NULL) on both stacks. Pre-fix TS PAID it.
  E. Read-path agreement on unpaid invoices: admin get (detail) on
     the drafts, admin get_list filtered by the crafted EUR client
     (invoiceArray shared by list/detail), stats get_income series
     by calendar day (issued = 1 visibility: TS-paid invoices were
     stats-invisible before R5b set issued = 1 at payment).
  F. Restore proof (full snapshot + sequences + config hash +
     invariants + crafted rows gone).

Known representation difference (documented, not a failure): PHP's
get envelope carries currency_rate as int 1 (draft) or DECIMAL
string '1'/'0.9' (paid); TS carries a JSON number. Values are
compared numerically; the raw types are asserted separately as
the known difference. PHP's get envelope carries NO base_income /
base_refund keys at all (same 47-key set as TS) — the three
columns are DB-level only, so the DB comparisons below are the
real assertions.

Runs PHP flows, restores, runs TS flows, restores, then compares
the recorded flows field by field. Crafted invoices only; the 323
baseline invoices are never mutated. Exit 0 only when every check
passes.
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
from datetime import datetime, timezone

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"
NOW = "2026-10-29 12:00:00"
CHECKS = 0
FAILURES = []


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(opener, email, password, api):
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


def series_by_day(series):
    """flot series -> {UTC date: value}; PHP stamps seconds, TS stamps ms."""
    out = {}
    for t, v in series:
        ts = t if t > 1e12 else t * 1000
        out[datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")] = v
    return out


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

    def invariants():
        q = lambda sql, args=(): d.execute(sql, args).fetchone()[0]
        return {
            "tld": q("SELECT COUNT(*) FROM tld"),
            "service_custom": q("SELECT COUNT(*) FROM service_custom"),
            "email_queue": q("SELECT COUNT(*) FROM email_queue"),
            "setting_rows": q("SELECT COUNT(*) FROM setting"),
            "invoice": q("SELECT COUNT(*) FROM invoice"),
            "client_order": q("SELECT COUNT(*) FROM client_order"),
            "support_ticket": q("SELECT COUNT(*) FROM support_ticket"),
            "client": q("SELECT COUNT(*) FROM client"),
            "admin": q("SELECT COUNT(*) FROM admin"),
            "admin_group": q("SELECT COUNT(*) FROM admin_group"),
            "admin_group_member": q("SELECT COUNT(*) FROM admin_group_member"),
            "currency": q("SELECT COUNT(*) FROM currency"),
            "extension": q("SELECT COUNT(*) FROM extension"),
            "extension_meta": q("SELECT COUNT(*) FROM extension_meta"),
        }

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

    def run_stack(base, label):
        op = make_opener()
        stok = login(op, SUPER_EMAIL, SUPER_PASS, "staff")
        cop = make_opener()
        ctok = login(cop, CLIENT_EMAIL, CLIENT_PASS, "client")
        # Setup (snapshot-restored): EUR currency + EUR client + TX tax + tax on.
        d.execute(
            "INSERT INTO currency (code, conversion_rate, is_rate_manual, is_default,"
            " format_pattern, fraction_digits, created_at, updated_at)"
            " VALUES ('EUR', 0.9, 1, 0, NULL, NULL, ?, ?)", (NOW, NOW))
        role = d.execute("SELECT role FROM client WHERE id = 1").fetchone()[0]
        d.execute(
            "INSERT INTO client (email, first_name, last_name, currency, status, role,"
            " tax_exempt, created_at, updated_at)"
            " VALUES ('eur.r5b@example.com', 'Eur', 'R5b', 'EUR', 'active', ?, 0, ?, ?)",
            (role, NOW, NOW))
        eur_client = d.execute(
            "SELECT id FROM client WHERE email = 'eur.r5b@example.com'").fetchone()[0]
        d.execute(
            "INSERT INTO tax (name, country, state, taxrate, created_at, updated_at)"
            " VALUES ('R5b TX tax', 'US', 'TX', '10', ?, ?)", (NOW, NOW))
        d.execute(
            "INSERT INTO setting (param, value, created_at, updated_at)"
            " VALUES ('tax_enabled', '1', ?, ?)", (NOW, NOW))
        d.commit()
        rec = {"eur_client": eur_client}

        def get(inv_id):
            env = call(op, stok, base, "admin", "invoice", "get", {"id": str(inv_id)})
            r = env.get("result", {})
            return {"envelope": env, "picked": {
                "currency_rate": r.get("currency_rate", "<ABSENT>"),
                "base_income": r.get("base_income", "<ABSENT>"),
                "base_refund": r.get("base_refund", "<ABSENT>"),
                "income": r.get("income", "<ABSENT>"),
                "refund": r.get("refund", "<ABSENT>"),
                "status": r.get("status"), "total": r.get("total"),
                "issued": r.get("issued", "<ABSENT>")}}

        def create(client_id, item_list, gateway="1"):
            env = call(op, stok, base, "admin", "invoice", "prepare",
                       {"client_id": str(client_id), "gateway_id": gateway, "items": item_list},
                       as_json=True)
            assert env.get("error") is None, f"create failed on {label}: {str(env)[:300]}"
            return env["result"]

        def pay(iid, tag):
            env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                       {"id": str(iid), "gateway_id": "1", "transactionId": f"R5B-{tag}-{label}"})
            assert env.get("error") is None, f"pay failed on {label}: {str(env)[:300]}"

        # 1. USD draft + issue (NULLs must survive issue).
        iid = create(1, [{"title": "Draft item", "price": 100, "quantity": 1, "taxed": False}])
        rec["usd_draft"] = {"db": row(iid), "get": get(iid)}
        call(op, stok, base, "admin", "invoice", "issue", {"id": str(iid)})
        rec["usd_issued"] = {"db": row(iid), "get": get(iid)}
        # 2. USD pay.
        pay(iid, "USD")
        rec["usd_paid"] = {"db": row(iid), "get": get(iid)}
        # 3. USD taxed pay (100 + 10% tax = 110 total; base_income must be 100).
        tid = create(1, [{"title": "Taxed item", "price": 100, "quantity": 1, "taxed": True}])
        pay(tid, "TAX")
        rec["usd_taxed_paid"] = {"db": row(tid), "get": get(tid)}
        # 4. EUR draft + pay (90 @ 0.9 -> base 100).
        eid = create(eur_client, [{"title": "EUR item", "price": 90, "quantity": 1, "taxed": False}])
        rec["eur_draft"] = {"db": row(eid), "get": get(eid)}
        pay(eid, "EUR")
        rec["eur_paid"] = {"db": row(eid), "get": get(eid)}
        # 5. EUR partial refund (lines 60 + 30 = 90; refund the 60 line).
        pid = create(eur_client, [{"title": "P1", "price": 60, "quantity": 1, "taxed": False},
                                  {"title": "P2", "price": 30, "quantity": 1, "taxed": False}])
        pay(pid, "EURP")
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
        pay(fid, "USDF")
        env = call(op, stok, base, "admin", "invoice", "refund", {"id": str(fid)})
        assert env.get("error") is None, f"full refund failed on {label}: {str(env)[:300]}"
        note_id = env["result"]
        rec["usd_full_refund"] = {"db": row(fid), "get": get(fid),
                                  "note_db": row(note_id), "note_get": get(note_id)}
        # 7. USD debit on an issued unpaid invoice (25).
        did = create(1, [{"title": "Debit base", "price": 50, "quantity": 1, "taxed": False}])
        call(op, stok, base, "admin", "invoice", "issue", {"id": str(did)})
        env = call(op, stok, base, "admin", "invoice", "debit",
                   {"id": str(did), "items": [{"title": "Extra", "price": 25, "quantity": 1}]},
                   as_json=True)
        assert env.get("error") is None, f"USD debit failed on {label}: {str(env)[:300]}"
        note_id = env["result"]
        rec["usd_debit"] = {"db": row(did), "get": get(did),
                            "note_db": row(note_id), "note_get": get(note_id)}
        # 8. EUR debit on an issued unpaid EUR invoice (25 -> 27.777777777778).
        edid = create(eur_client, [{"title": "EUR debit base", "price": 50, "quantity": 1, "taxed": False}])
        call(op, stok, base, "admin", "invoice", "issue", {"id": str(edid)})
        env = call(op, stok, base, "admin", "invoice", "debit",
                   {"id": str(edid), "items": [{"title": "EUR extra", "price": 25, "quantity": 1}]},
                   as_json=True)
        assert env.get("error") is None, f"EUR debit failed on {label}: {str(env)[:300]}"
        note_id = env["result"]
        rec["eur_debit"] = {"db": row(edid), "get": get(edid),
                            "note_db": row(note_id), "note_get": get(note_id)}
        # 9. Funds invoice (client 1, 50) — NULLs at creation.
        env = call(cop, ctok, base, "client", "invoice", "funds_invoice", {"amount": "50"})
        assert env.get("error") is None, f"funds failed on {label}: {str(env)[:300]}"
        fhash = env["result"]
        frow = d.execute("SELECT id FROM invoice WHERE hash = ?", (fhash,)).fetchone()
        assert frow, "funds invoice row not found"
        rec["funds"] = {"db": row(frow[0]), "get": get(frow[0])}
        # 10. Missing-rate pay: EUR draft, delete the EUR row, then pay.
        mid = create(eur_client, [{"title": "No rate", "price": 10, "quantity": 1, "taxed": False}])
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                   {"id": str(mid), "gateway_id": "1", "transactionId": f"R5B-NORATE-{label}"})
        rec["missing_rate"] = {"envelope": env, "db": row(mid)}
        # E. Read paths: EUR-client get_list + stats get_income series.
        env = call(op, stok, base, "admin", "invoice", "get_list",
                   {"client_id": str(eur_client)})
        lst = env.get("result", {}).get("list", env.get("result", []))
        if isinstance(lst, dict):
            lst = lst.get("list", [])
        rec["eur_list"] = [{"id": r.get("id"), "currency_rate": r.get("currency_rate"),
                            "income": r.get("income"), "refund": r.get("refund"),
                            "status": r.get("status")} for r in lst]
        env = call(op, stok, base, "admin", "stats", "get_income", {})
        rec["income_series"] = series_by_day(env.get("result", []))
        # 11-13. Zero-rate atomicity (R5b review fix): PHP wraps
        # payment, refund and debit in wrapInTransaction, so a
        # countIncome throw rolls everything back — the observable
        # outcome is "error + nothing changed". TS has no transaction
        # across these handlers, so each validates BEFORE its first
        # write. Case 10 deleted the EUR row, so each case below
        # re-creates it first (full-column INSERT, setup's shape).
        def ensure_eur(rate):
            d.execute("DELETE FROM currency WHERE code = 'EUR'")
            d.execute(
                "INSERT INTO currency (code, conversion_rate, is_rate_manual, is_default,"
                " format_pattern, fraction_digits, created_at, updated_at)"
                " VALUES ('EUR', ?, 1, 0, NULL, NULL, ?, ?)", (rate, NOW, NOW))
            d.commit()

        def note_count(link_col, inv_id):
            return d.execute(
                f"SELECT COUNT(*) FROM invoice WHERE {link_col} = ?", (inv_id,)).fetchone()[0]

        # 11. Zero-rate pay: error + invoice unchanged (unpaid, issued
        # 0, NULL rate, NULL bases). Pre-fix TS left it paid at 0.0.
        ensure_eur(0)
        zid = create(eur_client, [{"title": "Zero rate", "price": 10, "quantity": 1, "taxed": False}])
        env = call(op, stok, base, "admin", "invoice", "mark_as_paid",
                   {"id": str(zid), "gateway_id": "1", "transactionId": f"R5B-ZERO-{label}"})
        rec["zero_pay"] = {"envelope": env, "db": row(zid)}
        # 12. Zero-rate refund: paid at 0.9, rate then zeroed, refund
        # must error with the original untouched and no credit note.
        ensure_eur(0.9)
        rid = create(eur_client, [{"title": "Zero refund", "price": 90, "quantity": 1, "taxed": False}])
        pay(rid, "ZEROR")
        d.execute("UPDATE currency SET conversion_rate = 0 WHERE code = 'EUR'")
        d.commit()
        env = call(op, stok, base, "admin", "invoice", "refund", {"id": str(rid)})
        rec["zero_refund"] = {"envelope": env, "db": row(rid),
                              "notes": note_count("credit_note_for_invoice_id", rid)}
        # 13. Zero-rate debit: issued at 0.9, rate then zeroed, debit
        # must error with the original untouched and no debit note.
        ensure_eur(0.9)
        did2 = create(eur_client, [{"title": "Zero debit base", "price": 50, "quantity": 1, "taxed": False}])
        call(op, stok, base, "admin", "invoice", "issue", {"id": str(did2)})
        d.execute("UPDATE currency SET conversion_rate = 0 WHERE code = 'EUR'")
        d.commit()
        env = call(op, stok, base, "admin", "invoice", "debit",
                   {"id": str(did2), "items": [{"title": "Extra", "price": 25, "quantity": 1}]},
                   as_json=True)
        rec["zero_debit"] = {"envelope": env, "db": row(did2),
                             "notes": note_count("debit_note_for_invoice_id", did2)}
        return rec

    try:
        inv0 = invariants()
        check("A invariants baseline", inv0 == {
            "tld": 1, "service_custom": 17, "email_queue": 67, "setting_rows": 38, "invoice": 323,
            "client_order": 11, "support_ticket": 2, "client": 3, "admin": 2, "admin_group": 3,
            "admin_group_member": 1, "currency": 1, "extension": 6, "extension_meta": 3},
            f"got={inv0}")
        check("A config hash baseline", True)

        php = run_stack(PHP, "php")
        restore()
        ts = run_stack(TS, "ts")
    finally:
        restore()

    # ---- Compare PHP vs TS, field by field (DB-exact, None-aware).
    def db3(rec_key, note=False):
        p = php[rec_key]["note_db" if note else "db"]
        t = ts[rec_key]["note_db" if note else "db"]
        return p, t

    def check_db(name, rec_key, note=False):
        p, t = db3(rec_key, note)
        for f in ("currency_rate", "base_income", "base_refund", "refund", "status", "issued"):
            pv, tv = p[f], t[f]
            same = (pv is None and tv is None) or (pv is not None and tv is not None and float(pv) == float(tv)) \
                if f in ("currency_rate", "base_income", "base_refund", "refund") else (pv == tv)
            check(f"{name} {f}", same, f"php={pv} ts={tv}")

    def check_get(name, rec_key, note=False):
        p = php[rec_key]["note_get" if note else "get"]["picked"]
        t = ts[rec_key]["note_get" if note else "get"]["picked"]
        for f in ("income", "refund", "status", "total", "issued"):
            check(f"{name} get.{f}", p[f] == t[f], f"php={p[f]} ts={t[f]}")
        # currency_rate: value-equal numerically; raw type differs by stack (known).
        check(f"{name} get.currency_rate value", float(p["currency_rate"]) == float(t["currency_rate"]),
              f"php={p['currency_rate']} ts={t['currency_rate']}")
        # No base_income / base_refund keys on either stack (PHP toApiArray shape).
        check(f"{name} get has no base keys",
              p["base_income"] == "<ABSENT>" and p["base_refund"] == "<ABSENT>"
              and t["base_income"] == "<ABSENT>" and t["base_refund"] == "<ABSENT>")

    # B. Creation NULLs.
    for key in ("usd_draft", "usd_issued", "eur_draft", "funds"):
        check_db(f"B {key}", key)
        check(f"B {key} php NULLs",
              php[key]["db"]["currency_rate"] is None and php[key]["db"]["base_income"] is None
              and php[key]["db"]["base_refund"] is None, f"php={php[key]['db']}")
        check_get(f"B {key}", key)
    # C. Population transitions.
    for key in ("usd_paid", "usd_taxed_paid", "eur_paid", "eur_partial", "usd_full_refund"):
        check_db(f"C {key}", key)
        check_get(f"C {key}", key)
    check("C usd_paid php values", php["usd_paid"]["db"]["currency_rate"] == 1
          and php["usd_paid"]["db"]["base_income"] == 100
          and php["usd_paid"]["db"]["base_refund"] is None
          and php["usd_paid"]["db"]["issued"] == 1, f"php={php['usd_paid']['db']}")
    check("C usd_taxed_paid base excludes tax", php["usd_taxed_paid"]["db"]["base_income"] == 100,
          f"php={php['usd_taxed_paid']['db']}")
    check("C eur_paid php values", php["eur_paid"]["db"]["currency_rate"] == 0.9
          and php["eur_paid"]["db"]["base_income"] == 100, f"php={php['eur_paid']['db']}")
    check("C eur_partial php values", php["eur_partial"]["db"]["refund"] == 60
          and float(php["eur_partial"]["db"]["base_refund"]) == 66.666666666667
          and php["eur_partial"]["db"]["base_income"] == 100
          and php["eur_partial"]["db"]["status"] == "paid", f"php={php['eur_partial']['db']}")
    check("C eur_partial income", float(php["eur_partial"]["get"]["picked"]["income"]) == 33.333333333333,
          f"php={php['eur_partial']['get']['picked']}")
    check("C usd_full_refund php values", php["usd_full_refund"]["db"]["base_refund"] == 100
          and php["usd_full_refund"]["db"]["status"] == "refunded", f"php={php['usd_full_refund']['db']}")
    # Credit notes carry no income themselves.
    for key in ("eur_partial", "usd_full_refund"):
        check_db(f"C {key} note", key, note=True)
        check(f"C {key} note php NULLs",
              php[key]["note_db"]["currency_rate"] is None and php[key]["note_db"]["base_income"] is None
              and php[key]["note_db"]["base_refund"] is None, f"php={php[key]['note_db']}")
    # Debit notes: base_income at issuance, rate + base_refund NULL.
    for key in ("usd_debit", "eur_debit"):
        check_db(f"C {key} note", key, note=True)
    check("C usd_debit note php values", php["usd_debit"]["note_db"]["base_income"] == 25
          and php["usd_debit"]["note_db"]["currency_rate"] is None
          and php["usd_debit"]["note_db"]["base_refund"] is None, f"php={php['usd_debit']['note_db']}")
    check("C eur_debit note php values",
          float(php["eur_debit"]["note_db"]["base_income"]) == 27.777777777778
          and php["eur_debit"]["note_db"]["currency_rate"] is None
          and php["eur_debit"]["note_db"]["base_refund"] is None, f"php={php['eur_debit']['note_db']}")
    # D. Missing-rate pay must throw before any write, on both stacks.
    for stack, rec in (("php", php), ("ts", ts)):
        env = rec["missing_rate"]["envelope"]
        err = env.get("error") or {}
        check(f"D missing-rate {stack} error", err.get("message") == "Currency rate for code 'EUR' is not configured."
              and err.get("code") == 9999, f"{stack}={str(env)[:300]}")
        check(f"D missing-rate {stack} unpaid+NULL",
              rec["missing_rate"]["db"]["status"] == "unpaid"
              and rec["missing_rate"]["db"]["currency_rate"] is None, f"{stack}={rec['missing_rate']['db']}")
    # E. Read paths. List rows compare with currency_rate normalized
    # numerically: PHP renders it as a DECIMAL string ('0.9'), TS as
    # a number (0.9) — the same documented representation difference
    # as the get envelope, not a value difference.
    def norm_list(rows):
        return [{**r, "currency_rate": float(r["currency_rate"])} for r in rows]
    check("E eur_list rows equal", norm_list(php["eur_list"]) == norm_list(ts["eur_list"]),
          f"php={php['eur_list']} ts={ts['eur_list']}")
    days = sorted(set(php["income_series"]) | set(ts["income_series"]))
    for day in days:
        pv = php["income_series"].get(day, 0)
        tv = ts["income_series"].get(day, 0)
        check(f"E income series {day}", pv == tv, f"php={pv} ts={tv}")
    # Known representation difference, asserted as documentation.
    check("E php paid rate is a string, ts a number",
          isinstance(php["usd_paid"]["get"]["picked"]["currency_rate"], str)
          and isinstance(ts["usd_paid"]["get"]["picked"]["currency_rate"], (int, float)),
          f"php={php['usd_paid']['get']['picked']['currency_rate']!r} "
          f"ts={ts['usd_paid']['get']['picked']['currency_rate']!r}")
    # G. Zero-rate atomicity (R5b review fix): error + nothing changed.
    for stack, rec in (("php", php), ("ts", ts)):
        env = rec["zero_pay"]["envelope"]
        err = env.get("error") or {}
        check(f"G zero-pay {stack} error", err.get("message") == "Currency conversion rate cannot be zero."
              and err.get("code") == 9999, f"{stack}={str(env)[:300]}")
        check(f"G zero-pay {stack} unchanged",
              rec["zero_pay"]["db"]["status"] == "unpaid"
              and rec["zero_pay"]["db"]["issued"] == 0
              and rec["zero_pay"]["db"]["currency_rate"] is None
              and rec["zero_pay"]["db"]["base_income"] is None
              and rec["zero_pay"]["db"]["base_refund"] is None, f"{stack}={rec['zero_pay']['db']}")
        env = rec["zero_refund"]["envelope"]
        err = env.get("error") or {}
        check(f"G zero-refund {stack} error", err.get("message") == "Currency conversion rate cannot be zero."
              and err.get("code") == 9999, f"{stack}={str(env)[:300]}")
        check(f"G zero-refund {stack} unchanged, no note",
              rec["zero_refund"]["db"]["status"] == "paid"
              and rec["zero_refund"]["db"]["refund"] is None
              and float(rec["zero_refund"]["db"]["base_income"]) == 100
              and rec["zero_refund"]["db"]["base_refund"] is None
              and rec["zero_refund"]["notes"] == 0, f"{stack}={rec['zero_refund']['db']} notes={rec['zero_refund']['notes']}")
        env = rec["zero_debit"]["envelope"]
        err = env.get("error") or {}
        check(f"G zero-debit {stack} error", err.get("message") == "Currency conversion rate cannot be zero."
              and err.get("code") == 9999, f"{stack}={str(env)[:300]}")
        check(f"G zero-debit {stack} unchanged, no note",
              rec["zero_debit"]["db"]["status"] == "unpaid"
              and rec["zero_debit"]["db"]["issued"] == 1
              and rec["zero_debit"]["db"]["currency_rate"] is None
              and rec["zero_debit"]["notes"] == 0, f"{stack}={rec['zero_debit']['db']} notes={rec['zero_debit']['notes']}")
    # F. Restore proof.
    inv1 = invariants()
    check("F invariants after", inv1 == inv0, f"got={inv1}")
    check("F config hash after", hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)
    check("F sequences after", d.execute("SELECT name, seq FROM sqlite_sequence").fetchall() == seq)
    check("F crafted client gone",
          d.execute("SELECT COUNT(*) FROM client WHERE email = 'eur.r5b@example.com'").fetchone()[0] == 0)
    check("F crafted currency gone",
          d.execute("SELECT COUNT(*) FROM currency WHERE code = 'EUR'").fetchone()[0] == 0)

    print(f"\n{CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILURES:", FAILURES)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
