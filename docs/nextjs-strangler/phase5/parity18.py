#!/usr/bin/env python3
"""Phase 5 core-CRUD parity 3: Invoice admin leftovers through TS,
checked against captures21/.

Reuses the capture's literals (all test artifacts were cleaned), so
only fresh ids, hashes, timestamps and serie numbers need scrubbing.
The client transaction invoice_hash filter is a KNOWN DIVERGENCE:
PHP dies with a DQL alias collision ('i' already defined) when the
forced client_id filter meets the invoice_hash filter; TS applies both
filters correctly and is checked against the DB-derived expectation.
"""
import hashlib, json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
CAP = pathlib.Path(__file__).parent / "captures21"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_PW = "Phase0-Client!42"
NOW = "2026-10-25 22:00:00"
results = []
divergences = []


def report(name, ok, detail=""):
    results.append(ok)
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


def diverge(name, detail):
    divergences.append(name)
    print("DIVERGE", name, detail)


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        elif isinstance(v, list):
            for i, item in enumerate(v):
                if isinstance(item, dict):
                    out.update(flatten(item, f"{key}[{i}]"))
                else:
                    out[f"{key}[{i}]"] = item
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


def scrub(obj, subs=None):
    """Scrub timestamps; subs maps exact values (ids, hashes) to '*'."""
    subs = subs or {}
    if isinstance(obj, dict):
        return {k: ("*ts*" if k in ("created_at", "updated_at", "hash_expires_at")
                    else scrub(v, subs)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(x, subs) for x in obj]
    if isinstance(obj, str) and obj in subs:
        return subs[obj]
    if isinstance(obj, int) and obj in subs:
        return subs[obj]
    return obj


def main():
    d = sqlite3.connect(DBP)
    d.execute("DELETE FROM promo WHERE code LIKE 'PAR21%'")
    d.commit()

    def call(op, cj, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def raw(op, cj, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                body = resp.read()
                return {"status": resp.status, "content_type": resp.headers.get("Content-Type"),
                        "length": len(body), "head": body[:8]}
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                return {"status": e.code, "body": json.loads(body.decode())}
            except Exception:
                return {"status": e.code, "length": len(body)}

    def oracle(name):
        return json.load(open(CAP / f"{name}.json"))

    def err(r):
        return (r.get("error") or {}).get("message") if isinstance(r, dict) else None

    def errcode(r):
        return (r.get("error") or {}).get("code") if isinstance(r, dict) else None

    def expect_err(name, r, capname, code=None):
        want = oracle(capname)
        ok = err(r) == err(want) and (code is None or errcode(r) == code)
        report(name, ok, f"got {err(r)!r}/{errcode(r)!r} want {err(want)!r}/{code!r}")

    def expect_val(name, r, capname, subs=None):
        want = oracle(capname)["result"]
        report(name, scrub(r.get("result"), subs) == scrub(want, subs),
               f"got {str(scrub(r.get('result'), subs))[:300]} want {str(scrub(want, subs))[:300]}")

    def expect_bool(name, r, capname):
        want = oracle(capname)["result"]
        report(name, r.get("result") == want and r.get("error") is None,
               f"got {r.get('result')!r} want {want!r}")

    op_a, cj_a = make_opener()
    op_a.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_a, cj_a, "guest", "staff", "login", {"email": "admin@phase0.local", "password": ADMIN_PW})
    assert r.get("error") is None, r

    # --- statuses + failed items ---
    r = call(op_a, cj_a, "admin", "invoice", "get_statuses")
    report("admin_get_statuses", r.get("result") == oracle("admin_get_statuses")["result"],
           f"got {r.get('result')} want {oracle('admin_get_statuses')['result']}")
    r = call(op_a, cj_a, "admin", "invoice", "get_failed_items")
    report("admin_get_failed_items_empty", r.get("result") == oracle("admin_get_failed_items_empty")["result"],
           f"got {r.get('result')}")
    expect_err("admin_item_requeue_missing",
               call(op_a, cj_a, "admin", "invoice", "item_requeue", {}),
               "admin_item_requeue_missing")
    expect_err("admin_item_requeue_missing_item",
               call(op_a, cj_a, "admin", "invoice", "item_requeue", {"id": 99999}),
               "admin_item_requeue_missing_item")
    first_item = d.execute("SELECT id FROM invoice_item WHERE invoice_id = 1 AND status != 'failed' LIMIT 1").fetchone()[0]
    expect_err("admin_item_requeue_not_failed",
               call(op_a, cj_a, "admin", "invoice", "item_requeue", {"id": first_item}),
               "admin_item_requeue_not_failed")
    d.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity, unit, price, charged, taxed, attempts, created_at, updated_at) VALUES (1, 'order', '1', 'create', 'failed', 'Cap21 failed', NULL, 1, 'product', 0, 0, 0, 3, ?, ?)", (NOW, NOW))
    d.commit()
    failed_id = d.execute("SELECT id FROM invoice_item WHERE title = 'Cap21 failed'").fetchone()[0]
    r = call(op_a, cj_a, "admin", "invoice", "get_failed_items")
    want = oracle("admin_get_failed_items_one")["result"]
    want[0]["id"] = failed_id
    report("admin_get_failed_items_one", r.get("result") == want,
           f"got {r.get('result')} want {want}")
    expect_bool("admin_item_requeue_ok",
                call(op_a, cj_a, "admin", "invoice", "item_requeue", {"id": failed_id}),
                "admin_item_requeue_ok")
    r = call(op_a, cj_a, "admin", "invoice", "get_failed_items")
    report("admin_get_failed_items_after", r.get("result") == oracle("admin_get_failed_items_after")["result"],
           f"got {r.get('result')}")
    row = d.execute("SELECT status, attempts FROM invoice_item WHERE id = ?", (failed_id,)).fetchone()
    report("requeued_row", row == ("pending_setup", 0), f"got {row}")
    d.execute("DELETE FROM invoice_item WHERE id = ?", (failed_id,))
    d.commit()

    # --- gateways: reads ---
    expect_val("admin_gateway_get_pairs", call(op_a, cj_a, "admin", "invoice", "gateway_get_pairs"),
               "admin_gateway_get_pairs")
    expect_val("admin_gateway_get_available_before", call(op_a, cj_a, "admin", "invoice", "gateway_get_available"),
               "admin_gateway_get_available_before")
    expect_val("admin_gateway_get_list", call(op_a, cj_a, "admin", "invoice", "gateway_get_list"),
               "admin_gateway_get_list")
    expect_val("admin_gateway_get_list_search", call(op_a, cj_a, "admin", "invoice", "gateway_get_list", {"search": "Stripe"}),
               "admin_gateway_get_list_search")
    expect_val("admin_gateway_get_list_enabled", call(op_a, cj_a, "admin", "invoice", "gateway_get_list", {"enabled": 1}),
               "admin_gateway_get_list_enabled")
    expect_val("admin_gateway_get_custom", call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": 1}),
               "admin_gateway_get_custom")
    expect_val("admin_gateway_get_stripe", call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": 3}),
               "admin_gateway_get_stripe")
    expect_val("admin_gateway_get_paypal", call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": 2}),
               "admin_gateway_get_paypal")
    expect_err("admin_gateway_get_missing", call(op_a, cj_a, "admin", "invoice", "gateway_get", {}),
               "admin_gateway_get_missing")
    expect_err("admin_gateway_get_notfound", call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": 99999}),
               "admin_gateway_get_notfound")
    expect_err("admin_gateway_install_missing", call(op_a, cj_a, "admin", "invoice", "gateway_install", {}),
               "admin_gateway_install_missing")
    expect_err("admin_gateway_install_taken", call(op_a, cj_a, "admin", "invoice", "gateway_install", {"code": "Stripe"}),
               "admin_gateway_install_taken")
    expect_err("admin_gateway_install_unknown", call(op_a, cj_a, "admin", "invoice", "gateway_install", {"code": "Nope"}),
               "admin_gateway_install_unknown")
    expect_err("admin_gateway_copy_missing", call(op_a, cj_a, "admin", "invoice", "gateway_copy", {}),
               "admin_gateway_copy_missing")
    expect_err("admin_gateway_copy_notfound", call(op_a, cj_a, "admin", "invoice", "gateway_copy", {"id": 99999}),
               "admin_gateway_copy_notfound")
    expect_err("admin_gateway_update_missing", call(op_a, cj_a, "admin", "invoice", "gateway_update", {}),
               "admin_gateway_update_missing")
    expect_err("admin_gateway_update_notfound", call(op_a, cj_a, "admin", "invoice", "gateway_update", {"id": 99999}),
               "admin_gateway_update_notfound")
    expect_err("admin_gateway_delete_missing", call(op_a, cj_a, "admin", "invoice", "gateway_delete", {}),
               "admin_gateway_delete_missing")
    expect_err("admin_gateway_delete_notfound", call(op_a, cj_a, "admin", "invoice", "gateway_delete", {"id": 99999}),
               "admin_gateway_delete_notfound")

    # --- install ClientBalance ---
    expect_bool("admin_gateway_install_cb",
                call(op_a, cj_a, "admin", "invoice", "gateway_install", {"code": "ClientBalance"}),
                "admin_gateway_install_cb")
    cb_id = d.execute("SELECT id FROM pay_gateway WHERE gateway = 'ClientBalance'").fetchone()[0]
    print("clientbalance id:", cb_id)
    oracle_cb = oracle("admin_gateway_get_cb")["result"]["id"]
    expect_val("admin_gateway_get_available_after", call(op_a, cj_a, "admin", "invoice", "gateway_get_available"),
               "admin_gateway_get_available_after")

    def gateway_subs(oracle_id):
        return {oracle_id: cb_id, f"gateway_id={oracle_id}": f"gateway_id={cb_id}"}

    r = call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": cb_id})
    want = oracle("admin_gateway_get_cb")["result"]
    want["id"] = cb_id
    want["callback"] = want["callback"].replace(f"gateway_id={oracle_cb}", f"gateway_id={cb_id}")
    report("admin_gateway_get_cb", r.get("result") == want,
           f"got {str(r.get('result'))[:300]} want {str(want)[:300]}")
    expect_bool("admin_gateway_update_cb",
                call(op_a, cj_a, "admin", "invoice", "gateway_update",
                     {"id": cb_id, "title": "ClientBalance Test", "enabled": 1, "test_mode": 1,
                      "allow_single": 0, "allow_recurrent": 0, "accepted_currencies": ["USD"],
                      "config": {"note": "cap21"}}),
                "admin_gateway_update_cb")
    r = call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": cb_id})
    want = oracle("admin_gateway_get_cb_after")["result"]
    want["id"] = cb_id
    want["callback"] = want["callback"].replace(f"gateway_id={oracle_cb}", f"gateway_id={cb_id}")
    report("admin_gateway_get_cb_after", r.get("result") == want,
           f"got {str(r.get('result'))[:300]} want {str(want)[:300]}")
    expect_bool("admin_gateway_update_cb_disable",
                call(op_a, cj_a, "admin", "invoice", "gateway_update", {"id": cb_id, "enabled": 0}),
                "admin_gateway_update_cb_disable")

    # --- client-jar payment pins ---
    op_c, cj_c = make_opener()
    op_c.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_c, cj_c, "guest", "client", "login", {"email": "phase0.client@example.com", "password": CLIENT_PW})
    assert r.get("error") is None, r
    inv75 = "6245cef75d7bb6d9dbdb513800837981338f1f976f967ded"
    inv1 = "473d69f8652dbf55ed837e4542776254"
    inv68 = "481f5472d53852cef87fd607ccf9243f72f87976f5efa8257e0241f7d58d"
    expect_err("client_payment_paid", call(op_c, cj_c, "guest", "invoice", "payment", {"hash": inv1, "gateway_id": 1}),
               "client_payment_paid", code=403)
    expect_err("client_payment_canceled", call(op_c, cj_c, "guest", "invoice", "payment", {"hash": inv68, "gateway_id": 1}),
               "client_payment_canceled", code=403)
    expect_err("client_payment_unknown_gateway", call(op_c, cj_c, "guest", "invoice", "payment", {"hash": inv75, "gateway_id": 99999}),
               "client_payment_unknown_gateway", code=813)
    expect_err("client_payment_disabled", call(op_c, cj_c, "guest", "invoice", "payment", {"hash": inv75, "gateway_id": cb_id}),
               "client_payment_disabled", code=814)

    # --- guest payment/pdf error pins ---
    op_g, cj_g = make_opener()
    op_g.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    expect_err("guest_payment_missing_hash", call(op_g, cj_g, "guest", "invoice", "payment", {}),
               "guest_payment_missing_hash", code=810)
    expect_err("guest_payment_bad_hash", call(op_g, cj_g, "guest", "invoice", "payment", {"hash": "xyz"}),
               "guest_payment_bad_hash", code=4001)
    expect_err("guest_payment_missing_gateway", call(op_g, cj_g, "guest", "invoice", "payment", {"hash": inv75}),
               "guest_payment_missing_gateway", code=811)
    expect_err("guest_payment_unknown_invoice", call(op_g, cj_g, "guest", "invoice", "payment", {"hash": "a" * 48, "gateway_id": 1}),
               "guest_payment_unknown_invoice", code=812)
    expect_err("guest_payment_no_permission", call(op_g, cj_g, "guest", "invoice", "payment", {"hash": inv75, "gateway_id": 1}),
               "guest_payment_no_permission", code=403)
    expect_val("guest_funds_enabled", call(op_g, cj_g, "guest", "invoice", "funds_enabled"), "guest_funds_enabled")
    expect_err("guest_pdf_no_permission", call(op_g, cj_g, "guest", "invoice", "pdf", {"hash": inv1}),
               "guest_pdf_no_permission", code=403)
    expect_err("guest_pdf_missing_hash", call(op_g, cj_g, "guest", "invoice", "pdf", {}),
               "guest_pdf_missing_hash")
    expect_err("guest_pdf_bad_hash", call(op_g, cj_g, "guest", "invoice", "pdf", {"hash": "xyz"}),
               "guest_pdf_bad_hash", code=4001)
    info = raw(op_c, cj_c, "guest", "invoice", "pdf", {"hash": inv1})
    want_pdf = oracle("client_pdf_invoice1")
    report("client_pdf_invoice1",
           info.get("status") == 200 and info.get("content_type") == "application/pdf"
           and info.get("length") == want_pdf["length"] and info.get("head") == bytes.fromhex("255044462d312e37"),
           f"got {info}")
    info = raw(op_a, cj_a, "admin", "invoice", "export_csv", {})
    report("admin_export_csv",
           info.get("status") == 200 and (info.get("content_type") or "").startswith("text/csv")
           and info.get("head")[:3] == b"id,",
           f"got {info}")

    # --- gateway copies + secret rotation ---
    r = call(op_a, cj_a, "admin", "invoice", "gateway_copy", {"id": 1})
    copy_custom = r["result"]
    report("admin_gateway_copy_custom", isinstance(copy_custom, int), f"got {copy_custom!r}")
    oracle_cc = oracle("admin_gateway_get_copy_custom")["result"]["id"]
    r = call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": copy_custom})
    want = oracle("admin_gateway_get_copy_custom")["result"]
    want["id"] = copy_custom
    want["callback"] = want["callback"].replace(f"gateway_id={oracle_cc}", f"gateway_id={copy_custom}")
    report("admin_gateway_get_copy_custom", r.get("result") == want,
           f"got {str(r.get('result'))[:200]} want {str(want)[:200]}")
    expect_bool("admin_gateway_update_copy",
                call(op_a, cj_a, "admin", "invoice", "gateway_update",
                     {"id": copy_custom, "title": "Custom Copy Renamed", "config": {"single": "pay here"}}),
                "admin_gateway_update_copy")
    r = call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": copy_custom})
    want = oracle("admin_gateway_get_copy_custom_after")["result"]
    want["id"] = copy_custom
    want["callback"] = want["callback"].replace(f"gateway_id={oracle_cc}", f"gateway_id={copy_custom}")
    report("admin_gateway_get_copy_custom_after", r.get("result") == want,
           f"got {str(r.get('result'))[:200]} want {str(want)[:200]}")
    expect_bool("admin_gateway_delete_copy_custom",
                call(op_a, cj_a, "admin", "invoice", "gateway_delete", {"id": copy_custom}),
                "admin_gateway_delete_copy_custom")
    expect_err("admin_gateway_get_copy_custom_gone",
               call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": copy_custom}),
               "admin_gateway_get_copy_custom_gone")
    r = call(op_a, cj_a, "admin", "invoice", "gateway_copy", {"id": 3})
    copy_stripe = r["result"]
    report("admin_gateway_copy_stripe", isinstance(copy_stripe, int), f"got {copy_stripe!r}")
    oracle_cs = oracle("admin_gateway_get_stripe_copy_rotated")["result"]["id"]
    expect_bool("admin_gateway_update_stripe_copy_rotate",
                call(op_a, cj_a, "admin", "invoice", "gateway_update",
                     {"id": copy_stripe, "config": {"test_api_key": "sk_test_NEW"}}),
                "admin_gateway_update_stripe_copy_rotate")
    r = call(op_a, cj_a, "admin", "invoice", "gateway_get", {"id": copy_stripe})
    want = oracle("admin_gateway_get_stripe_copy_rotated")["result"]
    want["id"] = copy_stripe
    want["callback"] = want["callback"].replace(f"gateway_id={oracle_cs}", f"gateway_id={copy_stripe}")
    report("admin_gateway_get_stripe_copy_rotated", r.get("result") == want,
           f"got {str(r.get('result'))[:300]} want {str(want)[:300]}")
    expect_bool("admin_gateway_update_stripe_copy_keep",
                call(op_a, cj_a, "admin", "invoice", "gateway_update",
                     {"id": copy_stripe, "config": {"test_api_key": "__KEEP__"}}),
                "admin_gateway_update_stripe_copy_keep")
    kept = d.execute("SELECT config FROM pay_gateway WHERE id = ?", (copy_stripe,)).fetchone()[0]
    report("stripe_copy_keep_sql", "sk_test_NEW" in (kept or ""), f"got {kept}")
    expect_bool("admin_gateway_delete_copy_stripe",
                call(op_a, cj_a, "admin", "invoice", "gateway_delete", {"id": copy_stripe}),
                "admin_gateway_delete_copy_stripe")
    expect_err("admin_gateway_delete_blocked_custom",
               call(op_a, cj_a, "admin", "invoice", "gateway_delete", {"id": 1}),
               "admin_gateway_delete_blocked_custom")
    expect_bool("admin_gateway_delete_cb",
                call(op_a, cj_a, "admin", "invoice", "gateway_delete", {"id": cb_id}),
                "admin_gateway_delete_cb")
    expect_val("admin_gateway_get_available_restored", call(op_a, cj_a, "admin", "invoice", "gateway_get_available"),
               "admin_gateway_get_available_restored")
    expect_val("admin_gateway_get_pairs_restored", call(op_a, cj_a, "admin", "invoice", "gateway_get_pairs"),
               "admin_gateway_get_pairs_restored")
    expect_val("admin_gateway_get_list_restored", call(op_a, cj_a, "admin", "invoice", "gateway_get_list"),
               "admin_gateway_get_list_restored")

    # --- batch deletes ---
    expect_err("admin_batch_delete_missing", call(op_a, cj_a, "admin", "invoice", "batch_delete", {}),
               "admin_batch_delete_missing")
    drafts = []
    for i in (1, 2):
        r = call(op_a, cj_a, "admin", "invoice", "prepare",
                 {"client_id": 1, "items": [{"title": f"Cap21 draft {i}", "price": 0, "quantity": 1}]})
        drafts.append(r["result"])
    print("drafts:", drafts)
    report("admin_prepare_drafts", all(isinstance(x, int) for x in drafts), f"got {drafts}")
    expect_bool("admin_batch_delete_ok",
                call(op_a, cj_a, "admin", "invoice", "batch_delete", {"ids": drafts}),
                "admin_batch_delete_ok")
    for i, did in enumerate(drafts, 1):
        expect_err(f"admin_get_draft{i}_gone", call(op_a, cj_a, "admin", "invoice", "get", {"id": did}),
                   f"admin_get_draft{i}_gone")
    expect_err("admin_batch_delete_subscription_missing",
               call(op_a, cj_a, "admin", "invoice", "batch_delete_subscription", {}),
               "admin_batch_delete_subscription_missing")
    subs = []
    for s in ("cap21a", "cap21b"):
        r = call(op_a, cj_a, "admin", "invoice", "subscription_create",
                 {"client_id": 1, "gateway_id": 1, "currency": "USD", "sid": s, "period": "1M", "amount": 10, "status": "active"})
        subs.append(r["result"])
    expect_bool("admin_batch_delete_subscription_ok",
                call(op_a, cj_a, "admin", "invoice", "batch_delete_subscription", {"ids": subs}),
                "admin_batch_delete_subscription_ok")
    for s, sid in zip(("cap21a", "cap21b"), subs):
        expect_err(f"admin_subscription_get_{s}_gone",
                   call(op_a, cj_a, "admin", "invoice", "subscription_get", {"id": sid}),
                   f"admin_subscription_get_{s}_gone")
    expect_err("admin_batch_delete_transaction_missing",
               call(op_a, cj_a, "admin", "invoice", "batch_delete_transaction", {}),
               "admin_batch_delete_transaction_missing")
    for t in ("cap21a", "cap21b"):
        call(op_a, cj_a, "admin", "invoice", "transaction_create",
             {"invoice_id": 1, "gateway_id": 1, "txn_id": t, "get": {"t": t}})
    txs = [row[0] for row in d.execute('SELECT id FROM "transaction" WHERE txn_id IN (\'cap21a\', \'cap21b\') ORDER BY id').fetchall()]
    print("created tx ids:", txs)
    report("admin_transaction_create_ids", len(txs) == 2, f"got {txs}")
    expect_bool("admin_batch_delete_transaction_ok",
                call(op_a, cj_a, "admin", "invoice", "batch_delete_transaction", {"ids": txs}),
                "admin_batch_delete_transaction_ok")
    for t, tid in zip(("cap21a", "cap21b"), txs):
        expect_err(f"admin_transaction_get_{t}_gone",
                   call(op_a, cj_a, "admin", "invoice", "transaction_get", {"id": tid}),
                   f"admin_transaction_get_{t}_gone")
    expect_err("admin_batch_delete_tax_missing",
               call(op_a, cj_a, "admin", "invoice", "batch_delete_tax", {}),
               "admin_batch_delete_tax_missing")
    taxes = []
    for t in ("Cap21 Tax A", "Cap21 Tax B"):
        r = call(op_a, cj_a, "admin", "invoice", "tax_create",
                 {"name": t, "taxrate": 5, "country": "US"})
        taxes.append(r["result"])
    expect_bool("admin_batch_delete_tax_ok",
                call(op_a, cj_a, "admin", "invoice", "batch_delete_tax", {"ids": taxes}),
                "admin_batch_delete_tax_ok")
    for i, tid in enumerate(taxes, 1):
        expect_err(f"admin_tax_get_gone{i}", call(op_a, cj_a, "admin", "invoice", "tax_get", {"id": tid}),
                   f"admin_tax_get_gone{i}")

    # --- client reads ---
    expect_val("client_get_tax_rate", call(op_c, cj_c, "client", "invoice", "get_tax_rate"), "client_get_tax_rate")
    expect_val("client_transaction_get_list", call(op_c, cj_c, "client", "invoice", "transaction_get_list"),
               "client_transaction_get_list")
    # KNOWN DIVERGENCE (PHP bug): invoice_hash + forced client_id collide
    # on the DQL alias 'i' in PHP; TS filters correctly. Check TS output
    # against the DB-derived expectation instead of the PHP error oracle.
    r = call(op_c, cj_c, "client", "invoice", "transaction_get_list", {"invoice_hash": inv1})
    expected_ids = [row[0] for row in d.execute(
        'SELECT t.id FROM "transaction" t JOIN invoice i ON i.id = t.invoice_id '
        'WHERE i.client_id = 1 AND t.status = \'processed\' AND i.hash = ? ORDER BY t.id DESC', (inv1,)).fetchall()]
    got_ids = [item["id"] for item in r.get("result", {}).get("list", [])]
    if r.get("error") is None and got_ids == expected_ids and r["result"]["total"] == len(expected_ids):
        diverge("client_transaction_get_list_hash",
                f"TS correct ({len(got_ids)} rows); PHP oracle errors with DQL alias collision")
    else:
        report("client_transaction_get_list_hash", False, f"got {r}")
    expect_val("client_transaction_get_list_gateway",
               call(op_c, cj_c, "client", "invoice", "transaction_get_list", {"gateway_id": 1}),
               "client_transaction_get_list_gateway")
    expect_val("client_transaction_get_list_currency",
               call(op_c, cj_c, "client", "invoice", "transaction_get_list", {"currency": "USD"}),
               "client_transaction_get_list_currency")
    expect_val("client_transaction_get_list_dates",
               call(op_c, cj_c, "client", "invoice", "transaction_get_list", {"date_from": "2026-10-23", "date_to": "2026-10-24"}),
               "client_transaction_get_list_dates")
    expect_err("client_renewal_missing_order",
               call(op_c, cj_c, "client", "invoice", "renewal_invoice", {}),
               "client_renewal_missing_order")
    expect_err("client_renewal_notfound",
               call(op_c, cj_c, "client", "invoice", "renewal_invoice", {"order_id": 99999}),
               "client_renewal_notfound")

    # --- promo add/remove ---
    order_before = d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone()
    r = call(op_a, cj_a, "admin", "invoice", "prepare",
             {"client_id": 1, "items": [{"title": "Cap21 filler", "price": 0, "quantity": 1}]})
    draft = r["result"]
    print("promo draft:", draft)
    report("admin_prepare_promo_draft", isinstance(draft, int), f"got {draft!r}")
    d.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity, unit, price, charged, taxed, attempts, created_at, updated_at) VALUES (?, 'order', '1', 'create', 'pending_payment', 'Phase0 Widget Hosting', '1M', 1, 'product', 10, 0, 0, 0, ?, ?)",
              (draft, NOW, NOW))
    d.commit()
    r = call(op_a, cj_a, "admin", "product", "promo_create",
             {"code": "PAR21SAVE", "type": "percentage", "value": 10, "products": [6], "active": 1, "maxuses": 0, "description": "cap21 promo"})
    prom = r["result"]
    print("promo id:", prom)
    report("admin_promo_create_cap21", isinstance(prom, int), f"got {prom!r}")
    expect_err("admin_promo_add_missing_id",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"promo_code": "PAR21SAVE"}),
               "admin_promo_add_missing_id")
    expect_err("admin_promo_add_bad_code",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"id": draft, "promo_code": "NOPE21"}),
               "admin_promo_add_bad_code")
    expect_err("admin_promo_add_paid",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"id": 1, "promo_code": "PAR21SAVE"}),
               "admin_promo_add_paid")
    expect_err("admin_promo_add_no_ref",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"id": draft}),
               "admin_promo_add_no_ref")
    expect_err("admin_promo_add_bad_id",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"id": draft, "promo_id": 99999}),
               "admin_promo_add_bad_id")

    def draft_get(name, capname):
        r = call(op_a, cj_a, "admin", "invoice", "get", {"id": draft})
        want = oracle(capname)["result"]
        subs = {want["id"]: draft, want["hash"]: r["result"]["hash"],
                want["serie_nr"]: r["result"]["serie_nr"]}
        for line in want["lines"]:
            line["id"] = "*"
        for line in r["result"]["lines"]:
            line["id"] = "*"
        for app in want.get("promo_applications", []):
            app["promo_id"] = prom
        for app in r["result"].get("promo_applications", []):
            app["promo_id"] = prom
        # due_at is now + invoice_due_days on both stacks: same date,
        # different run time-of-day. Scrub it like a timestamp.
        r["result"]["due_at"] = "*"
        want["due_at"] = "*"
        report(name, scrub(r["result"], subs) == scrub(want, subs),
               f"got {str(scrub(r['result'], subs))[:400]} want {str(scrub(want, subs))[:400]}")

    expect_val("admin_promo_add_ok",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"id": draft, "promo_code": "PAR21SAVE"}),
               "admin_promo_add_ok")
    draft_get("admin_get_draft_after_add", "admin_get_draft_after_add")
    r = call(op_a, cj_a, "admin", "product", "promo_get", {"id": prom})
    want = oracle("admin_promo_get_after_add")["result"]
    want["id"] = prom
    report("admin_promo_get_after_add", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:200]} want {str(scrub(want))[:200]}")
    row = d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone()
    report("order1_after_add", row == (1, prom, 1, 0), f"got {row}")
    expect_val("admin_promo_add_again",
               call(op_a, cj_a, "admin", "invoice", "promo_add", {"id": draft, "promo_code": "PAR21SAVE"}),
               "admin_promo_add_again")
    draft_get("admin_get_draft_after_add2", "admin_get_draft_after_add2")
    row = d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone()
    report("order1_after_add2", row == (2, prom, 1, 0), f"got {row}")
    expect_val("admin_promo_remove_ok",
               call(op_a, cj_a, "admin", "invoice", "promo_remove", {"id": draft, "promo_code": "PAR21SAVE"}),
               "admin_promo_remove_ok")
    draft_get("admin_get_draft_after_remove", "admin_get_draft_after_remove")
    r = call(op_a, cj_a, "admin", "product", "promo_get", {"id": prom})
    want = oracle("admin_promo_get_after_remove")["result"]
    want["id"] = prom
    report("admin_promo_get_after_remove", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:200]} want {str(scrub(want))[:200]}")
    row = d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone()
    report("order1_after_remove", row == (0, None, 0, 0), f"got {row}")
    expect_err("admin_promo_remove_again",
               call(op_a, cj_a, "admin", "invoice", "promo_remove", {"id": draft, "promo_code": "PAR21SAVE"}),
               "admin_promo_remove_again")
    expect_err("admin_promo_remove_paid",
               call(op_a, cj_a, "admin", "invoice", "promo_remove", {"id": 1, "promo_code": "PAR21SAVE"}),
               "admin_promo_remove_paid")
    expect_bool("admin_delete_promo_draft",
                call(op_a, cj_a, "admin", "invoice", "delete", {"id": draft}),
                "admin_delete_promo_draft")
    d.execute("DELETE FROM promo_redemption WHERE promo_id = ?", (prom,))
    d.execute("DELETE FROM promo WHERE id = ?", (prom,))
    d.commit()

    # --- client renewal success ---
    unpaid_before = d.execute("SELECT unpaid_invoice_id FROM client_order WHERE id = 1").fetchone()[0]
    r = call(op_c, cj_c, "client", "invoice", "renewal_invoice", {"order_id": 1})
    new_hash = r.get("result")
    ok_hash = isinstance(new_hash, str) and len(new_hash) == 48 and all(c in "0123456789abcdef" for c in new_hash)
    report("client_renewal_ok_hash", ok_hash, f"got {new_hash!r}")
    new_inv = d.execute("SELECT id, issued, status, client_id, hash, due_at FROM invoice WHERE hash = ?", (new_hash,)).fetchone() if ok_hash else None
    report("client_renewal_ok_row",
           new_inv is not None and new_inv[1] == 1 and new_inv[2] == "unpaid" and new_inv[3] == 1
           and new_inv[5] == "2026-11-23 20:40:16",
           f"got {new_inv}")
    if new_inv:
        # Renewal issues with use_credits: if the client balance covered
        # the total, tryPayWithCredits wrote a balance row and marked the
        # invoice paid. Deleting the invoice without its balance row
        # drifts client 1's balance (-10 per run) and makes later
        # renewals pay immediately instead of staying unpaid.
        d.execute("DELETE FROM client_balance WHERE rel_id = ? AND type = 'invoice'", (str(new_inv[0]),))
        d.execute("DELETE FROM invoice_item WHERE invoice_id = ?", (new_inv[0],))
        d.execute("DELETE FROM invoice WHERE id = ?", (new_inv[0],))
        d.execute("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = 1", (unpaid_before,))
        d.commit()

    print(f"\n{sum(1 for x in results if x)}/{len(results)} MATCH; {len(divergences)} known divergences: {divergences}")


if __name__ == "__main__":
    main()
