#!/usr/bin/env python3
"""Phase 4 batch 3 parity: deposit funds_invoice + balance credit,
and PayPalEmail IPN (web_accept) through the Next origin.
PHP oracles: captures15/. PayPal post-verification cases run with
FB_PAYPAL_SKIP_VERIFY=1 on the TS server (PHP's verification is
unreachable in the sandbox — it fails at the TLS layer — so those
cases are source-verified against PayPalEmail.php, not oracle runs).
The callback sig is computed from the reference install's own salt,
read from its config at runtime."""
import hashlib, hmac, json, pathlib, re, sqlite3, urllib.request, urllib.parse, http.cookiejar, sys

NEXT = "http://127.0.0.1:3001"
HERE = pathlib.Path(__file__).parent
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
results = []


def report(name, ok, detail=""):
    results.append((name, ok))
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


def salt():
    text = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/config.php").read_text()
    return re.search(r"'salt'\s*=>\s*'([^']+)'", text).group(1)


def sig(gateway_id, invoice_id):
    return hmac.new(salt().encode(), f"{gateway_id}|{invoice_id}".encode(), hashlib.sha256).hexdigest()


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def call(cj, role, module, method, data=None, raw_json=False):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    if raw_json:
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json",
                                              "X-CSRF-TOKEN": csrf or ""})
    else:
        payload = flatten(dict(data or {}))
        if csrf:
            payload["CSRFToken"] = csrf
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def login(role_user, password, module="client"):
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(cj, "guest", module, "login", {"email": role_user, "password": password})
    assert r.get("error") is None, r
    return cj


def ipn(gateway_id, invoice_id, post, extra_get=None):
    get = {"gateway_id": gateway_id, "invoice_id": invoice_id}
    if extra_get:
        get.update(extra_get)
    url = f"{NEXT}/ipn.php?" + urllib.parse.urlencode(get)
    req = urllib.request.Request(url, data=urllib.parse.urlencode(post).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def db():
    return sqlite3.connect(DBP)


def balance(client_id=1):
    return db().execute("SELECT COALESCE(SUM(amount), 0) FROM client_balance WHERE client_id = ?",
                        (client_id,)).fetchone()[0]


def main():
    cap = lambda n: json.loads((HERE / "captures15" / f"{n}.json").read_text())
    cj = login("phase0.client@example.com", "Phase0-Client!42")
    r = call(cj, "client", "invoice", "funds_invoice", {})
    report("funds_missing_amount", r == cap("client_funds_missing_amount"), json.dumps(r)[:150])
    r = call(cj, "client", "invoice", "funds_invoice", {"amount": "abc"})
    report("funds_non_numeric", r == cap("client_funds_non_numeric"), json.dumps(r)[:150])
    r = call(cj, "client", "invoice", "funds_invoice", {"amount": 25})
    funds_hash = r.get("result")
    d = db()
    inv = d.execute("SELECT id, status, issued, serie FROM invoice WHERE hash = ?", (funds_hash,)).fetchone()
    item = d.execute("SELECT type, title, price, quantity, taxed, charged, status FROM invoice_item WHERE invoice_id = ?", (inv[0],)).fetchone()
    report("funds_invoice_shape", inv[1] == "unpaid" and inv[2] == 1 and item == ("deposit", "Add funds to account", 25, 1, 0, 1, "pending_payment"),
           f"{inv} {item}")

    cja = login("admin@phase0.local", "Phase1-Admin!42", module="staff")
    r = call(cja, "admin", "invoice", "mark_as_paid", {"id": inv[0], "gateway_id": 1})
    report("mark_as_paid_requires_txn", r == cap("admin_funds_mark_as_paid_no_txn"), json.dumps(r)[:150])
    bal0 = balance()
    r = call(cja, "admin", "invoice", "mark_as_paid", {"id": inv[0], "gateway_id": 1, "transactionId": "TS-FUNDS-MARK-1"})
    brow = d.execute("SELECT type, rel_id, amount, description FROM client_balance WHERE client_id = 1 ORDER BY id DESC LIMIT 1").fetchone()
    report("mark_as_paid_credits_deposit",
           r.get("result") is True and balance() - bal0 == 25 and brow == ("invoice", str(inv[0]), 25, "Custom transaction No: TS-FUNDS-MARK-1"),
           f"{r} bal_delta={balance() - bal0} row={brow}")

    r = call(cj, "client", "invoice", "funds_invoice", {"amount": 40})
    inv2 = d.execute("SELECT id FROM invoice WHERE hash = ?", (r["result"],)).fetchone()[0]
    ipn(1, inv2, {})
    tx = d.execute("SELECT id FROM \"transaction\" WHERE invoice_id = ? ORDER BY id DESC LIMIT 1", (inv2,)).fetchone()
    bal1 = balance()
    if tx:
        call(cja, "admin", "invoice", "transaction_approve", {"id": tx[0]})
    brow2 = d.execute("SELECT type, rel_id, amount, description FROM client_balance WHERE client_id = 1 ORDER BY id DESC LIMIT 1").fetchone()
    report("approve_credits_deposit_gift",
           balance() - bal1 == 40 and brow2 == ("gift", None, 40, "Custom transaction No: "),
           f"bal_delta={balance() - bal1} row={brow2}")

    # PayPalEmail, skip-verify server
    prep = call(cja, "admin", "invoice", "prepare",
                {"client_id": 1, "items": [{"title": "PP line", "price": 60, "quantity": 1, "taxed": 0}]}, raw_json=True)
    pp_id = prep["result"] if isinstance(prep.get("result"), int) else (prep.get("result") or {}).get("id")
    call(cja, "admin", "invoice", "issue", {"id": pp_id})
    good = {"txn_type": "web_accept", "payment_status": "Completed", "mc_gross": "60.00",
            "mc_currency": "USD", "txn_id": "PP-TS-1", "receiver_email": "paypal@example.com",
            "payer_email": "phase0.client@example.com"}
    r = ipn(2, pp_id, {}, extra_get={"sig": sig(2, pp_id)})
    report("pp_missing_post_7021", (r.get("error") or {}).get("code") == 7021 and (r.get("error") or {}).get("message") == "PayPal payment data is missing.",
           json.dumps(r)[:150])
    r = ipn(2, pp_id, good)
    report("pp_bad_sig", (r.get("error") or {}).get("message") == "PayPal callback signature is invalid", json.dumps(r)[:150])
    r = ipn(2, pp_id, {**good, "mc_currency": "EUR", "txn_id": "PP-TS-2"}, extra_get={"sig": sig(2, pp_id)})
    report("pp_wrong_currency", (r.get("error") or {}).get("message") == "PayPal payment currency EUR does not match invoice currency USD",
           json.dumps(r)[:150])
    r = ipn(2, pp_id, {**good, "payment_status": "Pending", "txn_id": "PP-TS-3"}, extra_get={"sig": sig(2, pp_id)})
    trow = d.execute("SELECT status, error FROM \"transaction\" WHERE invoice_id = ? ORDER BY id DESC LIMIT 1", (pp_id,)).fetchone()
    report("pp_pending_stays_received",
           r.get("result") is not None and trow[0] == "received" and (trow[1] or "").startswith("PayPal payment not completed: Pending"),
           f"{r} row={trow}")
    bal2 = balance()
    r = ipn(2, pp_id, good, extra_get={"sig": sig(2, pp_id)})
    pp_tx = r.get("result")
    st = d.execute("SELECT status FROM invoice WHERE id = ?", (pp_id,)).fetchone()[0]
    trow2 = d.execute("SELECT status, amount, currency FROM \"transaction\" WHERE id = ?", (pp_tx,)).fetchone() if pp_tx else None
    pp_row = d.execute("SELECT type, amount FROM client_balance WHERE client_id = 1 AND description = 'PayPal transaction PP-TS-1'").fetchone()
    report("pp_completed_settles",
           st == "paid" and trow2 == ("processed", 60, "USD") and pp_row == ("PayPal", 60),
           f"st={st} tx={trow2} balrow={pp_row}")
    r2 = ipn(2, pp_id, good, extra_get={"sig": sig(2, pp_id)})
    report("pp_replay_idempotent", r2.get("result") == pp_tx and r2.get("error") is None, json.dumps(r2)[:150])

    # cleanup TS-created invoices/items/txns (balance history rows stay)
    for iid in (inv[0], inv2, pp_id):
        d.execute("DELETE FROM invoice_item WHERE invoice_id = ?", (iid,))
        d.execute("DELETE FROM invoice WHERE id = ?", (iid,))
        d.execute("DELETE FROM \"transaction\" WHERE invoice_id = ?", (iid,))
    d.commit()

    bad = [n for n, ok in results if not ok]
    print(f"\nparity Phase4-3: {len(results) - len(bad)}/{len(results)} match" + (f" — DIFFS: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
