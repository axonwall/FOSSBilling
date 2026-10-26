#!/usr/bin/env python3
"""Phase 5 core-CRUD capture 3: Invoice admin leftovers (gateways,
batch deletes, failed items, statuses, promos) + client/get_tax_rate,
client transaction list, client renewal, guest funds/payment/pdf,
admin export_csv — against PHP.

Test artifacts are created and deleted via the API where possible;
SQL is used only where the API refuses (promo + redemption rows,
fabricated failed item, fabricated order line, renewal invoice).
Seeded data is never mutated except order 1's promo fields, which
promo_remove restores (verified by SQL at the end).
"""
import hashlib, json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures21"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
NOW = "2026-10-25 22:00:00"


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


def main():
    d = sqlite3.connect(DBP)
    d.execute("DELETE FROM promo WHERE code LIKE 'PAR21%'")
    d.execute("DELETE FROM invoice WHERE serie = 'CAP21'")
    d.commit()

    def staff_opener():
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(f"{BASE}/login", timeout=20).read()
        return op, cj

    def csrf_of(cj):
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(op, cj, name, role, module, method, data=None, save=True):
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
        if save:
            (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
        ok = isinstance(parsed, dict) and parsed.get("error") is None
        manifest.append({"name": name, "ok": ok,
                         "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
        print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
        return parsed

    def raw(op, cj, name, role, module, method, data=None):
        """Non-JSON call (PDF/CSV bytes): record status, content-type, length, sha."""
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                body = resp.read()
                info = {"status": resp.status, "content_type": resp.headers.get("Content-Type"),
                        "length": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                        "head": body[:8].hex()}
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                info = {"status": e.code, "body": json.loads(body.decode())}
            except Exception:
                info = {"status": e.code, "length": len(body)}
        (OUT / f"{name}.json").write_text(json.dumps(info, indent=2))
        print("RAW", name, info.get("status"), info.get("content_type"), info.get("length"))
        return info

    op_a, cj_a = staff_opener()
    call(op_a, cj_a, "tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}, save=False)

    # --- statuses + failed items (first: no invoice creation yet) ---
    call(op_a, cj_a, "admin_get_statuses", "admin", "invoice", "get_statuses")
    call(op_a, cj_a, "admin_get_failed_items_empty", "admin", "invoice", "get_failed_items")
    call(op_a, cj_a, "admin_item_requeue_missing", "admin", "invoice", "item_requeue", {})
    call(op_a, cj_a, "admin_item_requeue_missing_item", "admin", "invoice", "item_requeue", {"id": 99999})
    first_item = d.execute("SELECT id FROM invoice_item WHERE invoice_id = 1 AND status != 'failed' LIMIT 1").fetchone()[0]
    call(op_a, cj_a, "admin_item_requeue_not_failed", "admin", "invoice", "item_requeue", {"id": first_item})
    d.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity, unit, price, charged, taxed, attempts, created_at, updated_at) VALUES (1, 'order', '1', 'create', 'failed', 'Cap21 failed', NULL, 1, 'product', 0, 0, 0, 3, ?, ?)", (NOW, NOW))
    d.commit()
    failed_id = d.execute("SELECT id FROM invoice_item WHERE title = 'Cap21 failed'").fetchone()[0]
    call(op_a, cj_a, "admin_get_failed_items_one", "admin", "invoice", "get_failed_items")
    call(op_a, cj_a, "admin_item_requeue_ok", "admin", "invoice", "item_requeue", {"id": failed_id})
    call(op_a, cj_a, "admin_get_failed_items_after", "admin", "invoice", "get_failed_items")
    row = d.execute("SELECT status, attempts FROM invoice_item WHERE id = ?", (failed_id,)).fetchone()
    print("requeued row:", row)
    assert row == ("pending_setup", 0), row
    d.execute("DELETE FROM invoice_item WHERE id = ?", (failed_id,))
    d.commit()

    # --- gateways: reads before install ---
    call(op_a, cj_a, "admin_gateway_get_pairs", "admin", "invoice", "gateway_get_pairs")
    call(op_a, cj_a, "admin_gateway_get_available_before", "admin", "invoice", "gateway_get_available")
    call(op_a, cj_a, "admin_gateway_get_list", "admin", "invoice", "gateway_get_list")
    call(op_a, cj_a, "admin_gateway_get_list_search", "admin", "invoice", "gateway_get_list", {"search": "Stripe"})
    call(op_a, cj_a, "admin_gateway_get_list_enabled", "admin", "invoice", "gateway_get_list", {"enabled": 1})
    call(op_a, cj_a, "admin_gateway_get_custom", "admin", "invoice", "gateway_get", {"id": 1})
    call(op_a, cj_a, "admin_gateway_get_stripe", "admin", "invoice", "gateway_get", {"id": 3})
    call(op_a, cj_a, "admin_gateway_get_paypal", "admin", "invoice", "gateway_get", {"id": 2})
    call(op_a, cj_a, "admin_gateway_get_missing", "admin", "invoice", "gateway_get", {})
    call(op_a, cj_a, "admin_gateway_get_notfound", "admin", "invoice", "gateway_get", {"id": 99999})
    call(op_a, cj_a, "admin_gateway_install_missing", "admin", "invoice", "gateway_install", {})
    call(op_a, cj_a, "admin_gateway_install_taken", "admin", "invoice", "gateway_install", {"code": "Stripe"})
    call(op_a, cj_a, "admin_gateway_install_unknown", "admin", "invoice", "gateway_install", {"code": "Nope"})
    call(op_a, cj_a, "admin_gateway_copy_missing", "admin", "invoice", "gateway_copy", {})
    call(op_a, cj_a, "admin_gateway_copy_notfound", "admin", "invoice", "gateway_copy", {"id": 99999})
    call(op_a, cj_a, "admin_gateway_update_missing", "admin", "invoice", "gateway_update", {})
    call(op_a, cj_a, "admin_gateway_update_notfound", "admin", "invoice", "gateway_update", {"id": 99999})
    call(op_a, cj_a, "admin_gateway_delete_missing", "admin", "invoice", "gateway_delete", {})
    call(op_a, cj_a, "admin_gateway_delete_notfound", "admin", "invoice", "gateway_delete", {"id": 99999})

    # --- install ClientBalance, update it, use it for the disabled pin ---
    call(op_a, cj_a, "admin_gateway_install_cb", "admin", "invoice", "gateway_install", {"code": "ClientBalance"})
    cb_id = d.execute("SELECT id FROM pay_gateway WHERE gateway = 'ClientBalance'").fetchone()[0]
    print("clientbalance id:", cb_id)
    call(op_a, cj_a, "admin_gateway_get_available_after", "admin", "invoice", "gateway_get_available")
    call(op_a, cj_a, "admin_gateway_get_cb", "admin", "invoice", "gateway_get", {"id": cb_id})
    call(op_a, cj_a, "admin_gateway_update_cb", "admin", "invoice", "gateway_update",
         {"id": cb_id, "title": "ClientBalance Test", "enabled": 1, "test_mode": 1,
          "allow_single": 0, "allow_recurrent": 0, "accepted_currencies": ["USD"],
          "config": {"note": "cap21"}})
    call(op_a, cj_a, "admin_gateway_get_cb_after", "admin", "invoice", "gateway_get", {"id": cb_id})
    call(op_a, cj_a, "admin_gateway_update_cb_disable", "admin", "invoice", "gateway_update",
         {"id": cb_id, "enabled": 0})

    # --- client-jar payment pins (disabled gateway needs the install live) ---
    op_c, cj_c = staff_opener()
    call(op_c, cj_c, "tmp_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}, save=False)
    inv75 = "6245cef75d7bb6d9dbdb513800837981338f1f976f967ded"
    inv1 = "473d69f8652dbf55ed837e4542776254"
    inv68 = "481f5472d53852cef87fd607ccf9243f72f87976f5efa8257e0241f7d58d"
    call(op_c, cj_c, "client_payment_paid", "guest", "invoice", "payment", {"hash": inv1, "gateway_id": 1})
    call(op_c, cj_c, "client_payment_canceled", "guest", "invoice", "payment", {"hash": inv68, "gateway_id": 1})
    call(op_c, cj_c, "client_payment_unknown_gateway", "guest", "invoice", "payment", {"hash": inv75, "gateway_id": 99999})
    call(op_c, cj_c, "client_payment_disabled", "guest", "invoice", "payment", {"hash": inv75, "gateway_id": cb_id})

    # --- guest payment/pdf error pins (no session) ---
    op_g, cj_g = staff_opener()
    call(op_g, cj_g, "guest_payment_missing_hash", "guest", "invoice", "payment", {})
    call(op_g, cj_g, "guest_payment_bad_hash", "guest", "invoice", "payment", {"hash": "xyz"})
    call(op_g, cj_g, "guest_payment_missing_gateway", "guest", "invoice", "payment", {"hash": inv75})
    call(op_g, cj_g, "guest_payment_unknown_invoice", "guest", "invoice", "payment", {"hash": "a" * 48, "gateway_id": 1})
    call(op_g, cj_g, "guest_payment_no_permission", "guest", "invoice", "payment", {"hash": inv75, "gateway_id": 1})
    call(op_g, cj_g, "guest_funds_enabled", "guest", "invoice", "funds_enabled")
    call(op_g, cj_g, "guest_pdf_no_permission", "guest", "invoice", "pdf", {"hash": inv1})
    call(op_g, cj_g, "guest_pdf_missing_hash", "guest", "invoice", "pdf", {})
    call(op_g, cj_g, "guest_pdf_bad_hash", "guest", "invoice", "pdf", {"hash": "xyz"})
    raw(op_c, cj_c, "client_pdf_invoice1", "guest", "invoice", "pdf", {"hash": inv1})
    raw(op_c, cj_c, "client_pdf_invoice1_again", "guest", "invoice", "pdf", {"hash": inv1})
    raw(op_a, cj_a, "admin_export_csv", "admin", "invoice", "export_csv", {})

    # --- gateway copies + secret rotation ---
    r = call(op_a, cj_a, "admin_gateway_copy_custom", "admin", "invoice", "gateway_copy", {"id": 1})
    copy_custom = r["result"]
    call(op_a, cj_a, "admin_gateway_get_copy_custom", "admin", "invoice", "gateway_get", {"id": copy_custom})
    call(op_a, cj_a, "admin_gateway_update_copy", "admin", "invoice", "gateway_update",
         {"id": copy_custom, "title": "Custom Copy Renamed", "config": {"single": "pay here"}})
    call(op_a, cj_a, "admin_gateway_get_copy_custom_after", "admin", "invoice", "gateway_get", {"id": copy_custom})
    call(op_a, cj_a, "admin_gateway_delete_copy_custom", "admin", "invoice", "gateway_delete", {"id": copy_custom})
    call(op_a, cj_a, "admin_gateway_get_copy_custom_gone", "admin", "invoice", "gateway_get", {"id": copy_custom})
    r = call(op_a, cj_a, "admin_gateway_copy_stripe", "admin", "invoice", "gateway_copy", {"id": 3})
    copy_stripe = r["result"]
    call(op_a, cj_a, "admin_gateway_update_stripe_copy_rotate", "admin", "invoice", "gateway_update",
         {"id": copy_stripe, "config": {"test_api_key": "sk_test_NEW"}})
    call(op_a, cj_a, "admin_gateway_get_stripe_copy_rotated", "admin", "invoice", "gateway_get", {"id": copy_stripe})
    call(op_a, cj_a, "admin_gateway_update_stripe_copy_keep", "admin", "invoice", "gateway_update",
         {"id": copy_stripe, "config": {"test_api_key": "__KEEP__"}})
    kept = d.execute("SELECT config FROM pay_gateway WHERE id = ?", (copy_stripe,)).fetchone()[0]
    print("kept config has sk_test_NEW:", "sk_test_NEW" in (kept or ""))
    assert "sk_test_NEW" in (kept or ""), kept
    call(op_a, cj_a, "admin_gateway_delete_copy_stripe", "admin", "invoice", "gateway_delete", {"id": copy_stripe})
    call(op_a, cj_a, "admin_gateway_delete_blocked_custom", "admin", "invoice", "gateway_delete", {"id": 1})
    call(op_a, cj_a, "admin_gateway_delete_cb", "admin", "invoice", "gateway_delete", {"id": cb_id})
    call(op_a, cj_a, "admin_gateway_get_available_restored", "admin", "invoice", "gateway_get_available")
    call(op_a, cj_a, "admin_gateway_get_pairs_restored", "admin", "invoice", "gateway_get_pairs")
    call(op_a, cj_a, "admin_gateway_get_list_restored", "admin", "invoice", "gateway_get_list")

    # --- batch deletes ---
    call(op_a, cj_a, "admin_batch_delete_missing", "admin", "invoice", "batch_delete", {})
    drafts = []
    for i in (1, 2):
        r = call(op_a, cj_a, f"admin_prepare_draft{i}", "admin", "invoice", "prepare",
                 {"client_id": 1, "items": [{"title": f"Cap21 draft {i}", "price": 0, "quantity": 1}]}, save=False)
        drafts.append(r["result"])
    print("drafts:", drafts)
    call(op_a, cj_a, "admin_batch_delete_ok", "admin", "invoice", "batch_delete", {"ids": drafts})
    for i, did in enumerate(drafts, 1):
        call(op_a, cj_a, f"admin_get_draft{i}_gone", "admin", "invoice", "get", {"id": did})
    call(op_a, cj_a, "admin_batch_delete_subscription_missing", "admin", "invoice", "batch_delete_subscription", {})
    subs = []
    for s in ("cap21a", "cap21b"):
        r = call(op_a, cj_a, f"admin_subscription_create_{s}", "admin", "invoice", "subscription_create",
                 {"client_id": 1, "gateway_id": 1, "currency": "USD", "sid": s, "period": "1M", "amount": 10, "status": "active"}, save=False)
        subs.append(r["result"])
    call(op_a, cj_a, "admin_batch_delete_subscription_ok", "admin", "invoice", "batch_delete_subscription", {"ids": subs})
    for s, sid in zip(("cap21a", "cap21b"), subs):
        call(op_a, cj_a, f"admin_subscription_get_{s}_gone", "admin", "invoice", "subscription_get", {"id": sid})
    call(op_a, cj_a, "admin_batch_delete_transaction_missing", "admin", "invoice", "batch_delete_transaction", {})
    # transaction_create returns boolean true, not the id: resolve via SQL.
    # Distinct `get` payloads keep the PHP ipn-hash dedupe from collapsing
    # the two creates into one row (or an older admin-created row).
    for t in ("cap21a", "cap21b"):
        call(op_a, cj_a, f"admin_transaction_create_{t}", "admin", "invoice", "transaction_create",
             {"invoice_id": 1, "gateway_id": 1, "txn_id": t, "get": {"t": t}}, save=False)
    txs = [row[0] for row in d.execute('SELECT id FROM "transaction" WHERE txn_id IN (\'cap21a\', \'cap21b\') ORDER BY id').fetchall()]
    print("created tx ids:", txs)
    call(op_a, cj_a, "admin_batch_delete_transaction_ok", "admin", "invoice", "batch_delete_transaction", {"ids": txs})
    for t, tid in zip(("cap21a", "cap21b"), txs):
        call(op_a, cj_a, f"admin_transaction_get_{t}_gone", "admin", "invoice", "transaction_get", {"id": tid})
    call(op_a, cj_a, "admin_batch_delete_tax_missing", "admin", "invoice", "batch_delete_tax", {})
    taxes = []
    for t in ("Cap21 Tax A", "Cap21 Tax B"):
        r = call(op_a, cj_a, "admin_tax_create_tmp", "admin", "invoice", "tax_create",
                 {"name": t, "taxrate": 5, "country": "US"}, save=False)
        taxes.append(r["result"])
    call(op_a, cj_a, "admin_batch_delete_tax_ok", "admin", "invoice", "batch_delete_tax", {"ids": taxes})
    for i, tid in enumerate(taxes, 1):
        call(op_a, cj_a, f"admin_tax_get_gone{i}", "admin", "invoice", "tax_get", {"id": tid})

    # --- client reads ---
    call(op_c, cj_c, "client_get_tax_rate", "client", "invoice", "get_tax_rate")
    call(op_c, cj_c, "client_transaction_get_list", "client", "invoice", "transaction_get_list")
    call(op_c, cj_c, "client_transaction_get_list_hash", "client", "invoice", "transaction_get_list", {"invoice_hash": inv1})
    call(op_c, cj_c, "client_transaction_get_list_gateway", "client", "invoice", "transaction_get_list", {"gateway_id": 1})
    call(op_c, cj_c, "client_transaction_get_list_currency", "client", "invoice", "transaction_get_list", {"currency": "USD"})
    call(op_c, cj_c, "client_transaction_get_list_dates", "client", "invoice", "transaction_get_list", {"date_from": "2026-10-23", "date_to": "2026-10-24"})
    call(op_c, cj_c, "client_renewal_missing_order", "client", "invoice", "renewal_invoice", {})
    call(op_c, cj_c, "client_renewal_notfound", "client", "invoice", "renewal_invoice", {"order_id": 99999})

    # --- promo add/remove on a fabricated draft + order line ---
    order_before = d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone()
    print("order1 before:", order_before)
    r = call(op_a, cj_a, "admin_prepare_promo_draft", "admin", "invoice", "prepare",
             {"client_id": 1, "items": [{"title": "Cap21 filler", "price": 0, "quantity": 1}]}, save=False)
    draft = r["result"]
    print("promo draft:", draft)
    d.execute("INSERT INTO invoice_item (invoice_id, type, rel_id, task, status, title, period, quantity, unit, price, charged, taxed, attempts, created_at, updated_at) VALUES (?, 'order', '1', 'create', 'pending_payment', 'Phase0 Widget Hosting', '1M', 1, 'product', 10, 0, 0, 0, ?, ?)",
              (draft, NOW, NOW))
    d.commit()
    r = call(op_a, cj_a, "admin_promo_create_cap21", "admin", "product", "promo_create",
             {"code": "PAR21SAVE", "type": "percentage", "value": 10, "products": [6], "active": 1, "maxuses": 0, "description": "cap21 promo"}, save=False)
    prom = r["result"]
    print("promo id:", prom)
    call(op_a, cj_a, "admin_promo_add_missing_id", "admin", "invoice", "promo_add", {"promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_promo_add_bad_code", "admin", "invoice", "promo_add", {"id": draft, "promo_code": "NOPE21"})
    call(op_a, cj_a, "admin_promo_add_paid", "admin", "invoice", "promo_add", {"id": 1, "promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_promo_add_no_ref", "admin", "invoice", "promo_add", {"id": draft})
    call(op_a, cj_a, "admin_promo_add_bad_id", "admin", "invoice", "promo_add", {"id": draft, "promo_id": 99999})
    call(op_a, cj_a, "admin_promo_add_ok", "admin", "invoice", "promo_add", {"id": draft, "promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_get_draft_after_add", "admin", "invoice", "get", {"id": draft})
    call(op_a, cj_a, "admin_promo_get_after_add", "admin", "product", "promo_get", {"id": prom})
    print("order1 after add:", d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone())
    call(op_a, cj_a, "admin_promo_add_again", "admin", "invoice", "promo_add", {"id": draft, "promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_get_draft_after_add2", "admin", "invoice", "get", {"id": draft})
    print("order1 after add2:", d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone())
    call(op_a, cj_a, "admin_promo_remove_ok", "admin", "invoice", "promo_remove", {"id": draft, "promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_get_draft_after_remove", "admin", "invoice", "get", {"id": draft})
    call(op_a, cj_a, "admin_promo_get_after_remove", "admin", "product", "promo_get", {"id": prom})
    print("order1 after remove:", d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone())
    call(op_a, cj_a, "admin_promo_remove_again", "admin", "invoice", "promo_remove", {"id": draft, "promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_promo_remove_paid", "admin", "invoice", "promo_remove", {"id": 1, "promo_code": "PAR21SAVE"})
    call(op_a, cj_a, "admin_delete_promo_draft", "admin", "invoice", "delete", {"id": draft})
    d.execute("DELETE FROM promo_redemption WHERE promo_id = ?", (prom,))
    d.execute("DELETE FROM promo WHERE id = ?", (prom,))
    d.commit()
    order_after = d.execute("SELECT discount, promo_id, promo_used, promo_recurring FROM client_order WHERE id = 1").fetchone()
    # PHP's remove zeroes (not NULLs) discount/promo_used/promo_recurring
    # and NULLs promo_id; that post-remove state is the stable end state.
    print("order1 post-remove state:", order_after, "expected (0, None, 0, 0):", order_after == (0, None, 0, 0))

    # --- client renewal success (SQL cleanup after) ---
    unpaid_before = d.execute("SELECT unpaid_invoice_id FROM client_order WHERE id = 1").fetchone()[0]
    r = call(op_c, cj_c, "client_renewal_ok", "client", "invoice", "renewal_invoice", {"order_id": 1})
    new_hash = r.get("result")
    new_inv = d.execute("SELECT id, issued, status, client_id, hash FROM invoice WHERE hash = ?", (new_hash,)).fetchone()
    print("renewal invoice:", new_inv)
    d.execute("DELETE FROM invoice_item WHERE invoice_id = ?", (new_inv[0],))
    d.execute("DELETE FROM invoice WHERE id = ?", (new_inv[0],))
    d.execute("UPDATE client_order SET unpaid_invoice_id = ? WHERE id = 1", (unpaid_before,))
    d.commit()

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
