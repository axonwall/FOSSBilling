#!/usr/bin/env python3
"""Phase 4 batch 3 capture corpus: deposit funds_invoice + payment
credit, and PayPalEmail IPN (web_accept) against PHP. PHP oracle.
The PayPal callback sig is computed from the reference install's
own salt (read from its config at runtime, never hardcoded)."""
import hashlib, hmac, json, pathlib, re, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures15"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"


def salt():
    text = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/config.php").read_text()
    m = re.search(r"'salt'\s*=>\s*'([^']+)'", text)
    return m.group(1)


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


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def csrf_of(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value


def call(op, cj, name, role, module, method, data=None, raw_json=False):
    if raw_json:
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json",
                                              "X-CSRF-TOKEN": csrf_of(cj) or ""})
    else:
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=30) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def ipn(name, gateway_id, invoice_id, post, extra_get=None):
    get = {"gateway_id": gateway_id, "invoice_id": invoice_id}
    if extra_get:
        get.update(extra_get)
    url = f"{BASE}/ipn.php?" + urllib.parse.urlencode(get)
    req = urllib.request.Request(url, data=urllib.parse.urlencode(post).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def db():
    return sqlite3.connect(DBP)


def balance(client_id=1):
    d = db()
    row = d.execute("SELECT COALESCE(SUM(amount), 0) FROM client_balance WHERE client_id = ?", (client_id,)).fetchone()
    return row[0]


def main():
    op, cj = make_opener()
    op.open(f"{BASE}/login", timeout=20).read()
    # --- deposits: client role ---
    call(op, cj, "guest_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
    call(op, cj, "client_funds_missing_amount", "client", "invoice", "funds_invoice", {})
    call(op, cj, "client_funds_non_numeric", "client", "invoice", "funds_invoice", {"amount": "abc"})
    bal0 = balance()
    r = call(op, cj, "client_funds_invoice", "client", "invoice", "funds_invoice", {"amount": 25})
    funds_hash = r.get("result")
    d = db()
    inv = d.execute("SELECT id, status, issued, currency FROM invoice WHERE hash = ?", (funds_hash,)).fetchone()
    item = d.execute("SELECT type, title, price, quantity, taxed, charged, status FROM invoice_item WHERE invoice_id = ?", (inv[0],)).fetchone()
    print("funds invoice:", inv, "item:", item)
    (OUT / "funds_invoice_meta.json").write_text(json.dumps({"invoice": inv, "item": item, "balance_before": bal0}))
    # admin pays it via Custom mark_as_paid
    op2, cj2 = make_opener()
    op2.open(f"{BASE}/login", timeout=20).read()
    call(op2, cj2, "guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    call(op2, cj2, "admin_funds_mark_as_paid_no_txn", "admin", "invoice", "mark_as_paid",
         {"id": inv[0], "gateway_id": 1})
    call(op2, cj2, "admin_funds_mark_as_paid", "admin", "invoice", "mark_as_paid",
         {"id": inv[0], "gateway_id": 1, "transactionId": "FUNDS-MARK-1"})
    bal1 = balance()
    brow = d.execute("SELECT type, rel_id, amount, description FROM client_balance WHERE client_id = 1 ORDER BY id DESC LIMIT 1").fetchone()
    print("balance after mark_as_paid:", bal0, "->", bal1, "row:", brow)
    (OUT / "funds_credit_row.json").write_text(json.dumps({"balance_before": bal0, "balance_after": bal1, "row": brow}))

    # second funds invoice, paid via Custom IPN error + approve
    r2 = call(op, cj, "client_funds_invoice_2", "client", "invoice", "funds_invoice", {"amount": 40})
    inv2 = d.execute("SELECT id FROM invoice WHERE hash = ?", (r2["result"],)).fetchone()[0]
    ipn("ipn_custom_funds", 1, inv2, {})
    call(op2, cj2, "admin_transaction_get_list_funds", "admin", "invoice", "transaction_get_list",
         {"invoice_id": inv2})
    tx = d.execute("SELECT id FROM \"transaction\" WHERE invoice_id = ? ORDER BY id DESC LIMIT 1", (inv2,)).fetchone()
    if tx:
        call(op2, cj2, "admin_funds_approve", "admin", "invoice", "transaction_approve", {"id": tx[0]})
    bal2 = balance()
    brow2 = d.execute("SELECT type, rel_id, amount, description FROM client_balance WHERE client_id = 1 ORDER BY id DESC LIMIT 1").fetchone()
    print("balance after approve:", bal1, "->", bal2, "row:", brow2)
    (OUT / "funds_approve_credit_row.json").write_text(json.dumps({"balance_before": bal1, "balance_after": bal2, "row": brow2}))

    # --- PayPalEmail IPN ---
    d.execute("UPDATE pay_gateway SET enabled = 1, config = ? WHERE id = 2",
              (json.dumps({"email": "paypal@example.com"}),))
    d.commit()
    gw = d.execute("SELECT config FROM pay_gateway WHERE id = 2").fetchone()[0]
    print("paypal config:", (gw or "")[:160])
    # fresh unpaid manual invoice 60 USD for the PayPal cases
    prep = call(op2, cj2, "admin_invoice_prepare_pp", "admin", "invoice", "prepare",
                {"client_id": 1, "items": [{"title": "PP line", "price": 60, "quantity": 1, "taxed": 0}]}, raw_json=True)
    pp_id = prep["result"] if isinstance(prep.get("result"), int) else (prep.get("result") or {}).get("id")
    call(op2, cj2, "admin_invoice_issue_pp", "admin", "invoice", "issue", {"id": pp_id})
    good = {"txn_type": "web_accept", "payment_status": "Completed", "mc_gross": "60.00",
            "mc_currency": "USD", "txn_id": "PP-CAPTURE-1", "receiver_email": "paypal@example.com",
            "payer_email": "phase0.client@example.com"}
    ipn("ipn_pp_missing_post", 2, pp_id, {}, extra_get={"sig": sig(2, pp_id)})
    ipn("ipn_pp_bad_sig", 2, pp_id, good)
    ipn("ipn_pp_wrong_currency", 2, pp_id, {**good, "mc_currency": "EUR", "txn_id": "PP-CAPTURE-2"},
        extra_get={"sig": sig(2, pp_id)})
    ipn("ipn_pp_pending", 2, pp_id, {**good, "payment_status": "Pending", "txn_id": "PP-CAPTURE-3"},
        extra_get={"sig": sig(2, pp_id)})
    r_pp = ipn("ipn_pp_completed", 2, pp_id, good, extra_get={"sig": sig(2, pp_id)})
    pp_tx = r_pp.get("result")
    st = d.execute("SELECT status FROM invoice WHERE id = ?", (pp_id,)).fetchone()
    brow3 = d.execute("SELECT type, rel_id, amount, description FROM client_balance WHERE client_id = 1 AND description LIKE 'PayPal%' ORDER BY id DESC LIMIT 1").fetchone()
    print("pp invoice status:", st, "txn:", pp_tx, "balance row:", brow3, "balance:", balance())
    if pp_tx:
        call(op2, cj2, "admin_pp_transaction_get", "admin", "invoice", "transaction_get", {"id": pp_tx})
    ipn("ipn_pp_replay", 2, pp_id, good, extra_get={"sig": sig(2, pp_id)})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
