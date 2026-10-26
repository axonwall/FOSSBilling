#!/usr/bin/env python3
"""Phase 5 R1 leftovers sub-batch 1 capture: deferred cart (admin) +
staff (group pairs, login history get, guest login/password flows) vs PHP.

Runs against live PHP only (:8080). Everything is restored from
snapshots at the end (finally), including seeded promos/products,
sessions, queue rows and template rows created by the reset flows.
"""
import hashlib, json, pathlib, sqlite3, urllib.request, urllib.parse, urllib.error, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures25"
OUT.mkdir(exist_ok=True)
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
NOW = "2026-10-25 12:00:00"
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PASS = "Phase1-Admin!42"
CLIENT_ID = 1

TABLES = ["cart", "cart_product", "promo", "promo_redemption", "client_order",
          "client_order_status", "invoice", "invoice_item", "transaction",
          "email_queue", "email_template", "email_template_group",
          "admin_password_reset", "activity_admin_history", "session",
          "service_custom", "client_balance", "client", "product",
          "product_payment", "admin", "setting"]

DUMP_TABLES = ["cart", "cart_product", "promo", "promo_redemption",
               "client_order", "invoice", "invoice_item", "transaction",
               "email_queue", "email_template", "admin_password_reset",
               "activity_admin_history", "service_custom", "client_balance"]


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
    d.row_factory = sqlite3.Row
    snaps = {}
    for t in TABLES:
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(),
                    [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')])
    seq_tables = ", ".join("?" * len(TABLES))
    snap_seq = d.execute(
        f"SELECT name, seq FROM sqlite_sequence WHERE name IN ({seq_tables})", TABLES).fetchall()
    base_max = {}
    for t in DUMP_TABLES:
        try:
            base_max[t] = d.execute(f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
        except Exception:
            base_max[t] = 0

    def restore():
        d.execute(f"DELETE FROM sqlite_sequence WHERE name IN ({seq_tables})", TABLES)
        for name, seq in snap_seq:
            d.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (name, seq))
        for t in TABLES:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            col_list = ",".join(cols)
            placeholders = ",".join("?" * len(cols))
            d.executemany(f'INSERT INTO "{t}" (' + col_list + ") VALUES (" + placeholders + ")",
                          [tuple(r) for r in rows])
        d.commit()

    def dump_new():
        out = {}
        for t in DUMP_TABLES:
            cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
            rows = d.execute(f'SELECT * FROM "{t}" WHERE id > ?', (base_max[t],)).fetchall()
            if rows:
                out[t] = [dict(zip(cols, r)) for r in rows]
        return out

    def staff_opener():
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(f"{BASE}/login", timeout=20).read()
        return op, cj

    def csrf_of(cj):
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(op, cj, name, role, module, method, data=None, save=True, with_csrf=True):
        payload = flatten(dict(data or {}))
        if with_csrf and csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                parsed = json.loads(e.read().decode())
            except Exception:
                parsed = {"error": {"message": f"non-json HTTP {e.code}"}}
        if save:
            (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
        ok = isinstance(parsed, dict) and parsed.get("error") is None
        print(("OK " if ok else "ERR"), name,
              (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else "")
        return parsed

    def ins(sql, params=()):
        d.execute(sql, params)
        d.commit()
        return d.execute("SELECT last_insert_rowid()").fetchone()[0]

    def admin_login(op, cj):
        return call(op, cj, "tmp_staff_login", "guest", "staff", "login",
                    {"email": ADMIN_EMAIL, "password": ADMIN_PASS}, save=False)

    try:
        # ---------- seeds ----------
        # products first: the bundle promo requires the free product,
        # which must NOT be in the basket during the promo cases.
        prod_addon = ins("INSERT INTO product (title, slug, status, active, is_addon, setup, type,"
                         " product_payment_id, created_at, updated_at) VALUES ('Cap25 Addon',"
                         " 'cap25-addon', 'enabled', 1, 1, 'after_payment', 'custom', 1, ?, ?)",
                         (NOW, NOW))
        prod_disabled = ins("INSERT INTO product (title, slug, status, active, is_addon, setup, type,"
                            " product_payment_id, created_at, updated_at) VALUES ('Cap25 Disabled',"
                            " 'cap25-disabled', 'disabled', 1, 0, 'after_payment', 'custom', 1, ?, ?)",
                            (NOW, NOW))
        pay_free = ins("INSERT INTO product_payment (type, once_price, once_setup_price)"
                       " VALUES ('once', 0, 0)")
        prod_free = ins("INSERT INTO product (title, slug, status, active, is_addon, setup, type,"
                        " product_payment_id, created_at, updated_at) VALUES ('Cap25 Free',"
                        " 'cap25-free', 'enabled', 1, 0, 'after_payment', 'custom', ?, ?, ?)",
                        (pay_free, NOW, NOW))
        def promo(code, ptype, value, **kw):
            cols = ["code", "type", "value", "maxuses", "used", "freesetup", "once_per_client",
                    "recurring", "active", "products", "periods", "client_groups",
                    "requires_products", "start_at", "end_at", "auto_apply", "priority",
                    "stackable", "created_at", "updated_at"]
            vals = {"code": code, "type": ptype, "value": value, "maxuses": 0, "used": 0,
                    "freesetup": 0, "once_per_client": 0, "recurring": 0, "active": 1,
                    "products": "[]", "periods": "[]", "client_groups": "[]",
                    "requires_products": "[]", "start_at": "2020-01-01 00:00:00",
                    "end_at": "2030-01-01 00:00:00", "auto_apply": 0, "priority": 0,
                    "stackable": 0, "created_at": NOW, "updated_at": NOW}
            vals.update(kw)
            return ins(f"INSERT INTO promo ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                       tuple(vals[c] for c in cols))

        p_pct10 = promo("CAP25PCT10", "percentage", 10)
        p_abs5 = promo("CAP25ABS5", "absolute", 5)
        p_exp = promo("CAP25EXP", "percentage", 10, end_at="2020-06-01 00:00:00")
        p_inact = promo("CAP25INACT", "percentage", 10, active=0)
        p_maxed = promo("CAP25MAX", "percentage", 10, maxuses=2, used=2)
        p_once = promo("CAP25ONCE", "percentage", 10, once_per_client=1)
        p_group = promo("CAP25GRP", "percentage", 10, client_groups="[1]")
        p_bundle = promo("CAP25BUNDLE", "percentage", 10, requires_products=f"[{prod_free}]")
        p_auto15 = promo("CAP25AUTO15", "percentage", 15, auto_apply=1, priority=10)
        p_autoabs7 = promo("CAP25AUTOABS7", "absolute", 7, auto_apply=1, priority=20)
        p_pct100 = promo("CAP25PCT100", "percentage", 100)
        p_freesetup = promo("CAP25FREESETUP", "percentage", 10, freesetup=1)
        # once-per-client already consumed: a committed checkout redemption
        ins("INSERT INTO promo_redemption (promo_id, client_id, client_order_id, invoice_id,"
            " phase, status, discount_amount, currency, created_at, updated_at)"
            " VALUES (?, 1, NULL, NULL, 'checkout', 'committed', 1, 'USD', ?, ?)",
            (p_once, NOW, NOW))
        # inactive admin (same password hash as admin 1)
        admin1_pass = d.execute("SELECT pass FROM admin WHERE id = 1").fetchone()[0]
        admin_inactive = ins("INSERT INTO admin (email, pass, name, status, created_at, updated_at)"
                             " VALUES ('cap25.inactive@example.com', ?, 'Cap25 Inactive',"
                             " 'inactive', ?, ?)", (admin1_pass, NOW, NOW))
        # expired reset token for admin 1
        ins("INSERT INTO admin_password_reset (hash, ip, created_at, updated_at, admin_id)"
            " VALUES ('cap25expiredhash', '127.0.0.1', '2026-10-25 11:00:00', ?, 1)", (NOW,))
        # old carts for batch_expire (10 days ago) + one recent
        ins("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at)"
            " VALUES ('cap25old', 1, NULL, '2026-10-15 12:00:00', '2026-10-15 12:00:00')")
        ins("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at)"
            " VALUES ('staff:1:1', 1, NULL, '2026-10-15 12:00:00', '2026-10-15 12:00:00')")
        old_cart = ins("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at)"
                       " VALUES ('cap25old2', 1, NULL, '2026-10-15 12:00:00', '2026-10-15 12:00:00')")
        ins("INSERT INTO cart_product (product_id, config, cart_id) VALUES (2, '{\"quantity\":1}', ?)",
            (old_cart,))
        print("seeds:", {"p_pct10": p_pct10, "p_abs5": p_abs5, "prod_addon": prod_addon,
                         "prod_disabled": prod_disabled, "prod_free": prod_free,
                         "admin_inactive": admin_inactive})

        # ---------- cart admin cases ----------
        op_a, cj_a = staff_opener()
        admin_login(op_a, cj_a)
        op_n, cj_n = staff_opener()  # no login

        call(op_n, cj_n, "cart_get_list_noauth", "admin", "cart", "get_list")
        call(op_a, cj_a, "cart_get_list_default", "admin", "cart", "get_list")
        call(op_a, cj_a, "cart_get_list_page", "admin", "cart", "get_list",
             {"per_page": 2, "page": 2})
        call(op_a, cj_a, "cart_get_list_desc", "admin", "cart", "get_list",
             {"per_page": 3, "sort": "id", "direction": "DESC"})
        call(op_a, cj_a, "cart_get_list_badsort", "admin", "cart", "get_list",
             {"per_page": 3, "sort": "bogus", "direction": "DESC"})
        call(op_a, cj_a, "cart_get_list_page0", "admin", "cart", "get_list", {"page": 0})
        call(op_a, cj_a, "cart_get_list_perpage501", "admin", "cart", "get_list",
             {"per_page": 501})
        call(op_a, cj_a, "cart_get_list_perpage_abc", "admin", "cart", "get_list",
             {"per_page": "abc"})
        call(op_a, cj_a, "cart_get_missing", "admin", "cart", "get", {"id": 999999})
        call(op_a, cj_a, "cart_get_noid", "admin", "cart", "get")

        # staff basket: errors first
        call(op_a, cj_a, "sb_get_noclient", "admin", "cart", "staff_basket_get")
        call(op_a, cj_a, "sb_get_unknown_client", "admin", "cart", "staff_basket_get",
             {"client_id": 999})
        call(op_a, cj_a, "sb_get_empty", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_add_noclient", "admin", "cart", "staff_basket_add_item",
             {"id": 2})
        call(op_a, cj_a, "sb_add_noproduct", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_add_unknown_product", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 999})
        call(op_a, cj_a, "sb_add_addon", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": prod_addon})
        call(op_a, cj_a, "sb_add_recurrent_noperiod", "admin", "cart",
             "staff_basket_add_item", {"client_id": CLIENT_ID, "id": 9})
        call(op_a, cj_a, "sb_add_recurrent_badperiod", "admin", "cart",
             "staff_basket_add_item", {"client_id": CLIENT_ID, "id": 9, "period": "9Z"})
        call(op_a, cj_a, "sb_add_negprice", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "price": -1})
        call(op_a, cj_a, "sb_add_nanprice", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "price": "abc"})

        # staff basket: happy path, then views
        call(op_a, cj_a, "sb_add_once", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "quantity": 2})
        call(op_a, cj_a, "sb_get_after_once", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_add_disabled", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": prod_disabled})
        call(op_a, cj_a, "sb_add_override", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "price": 25.5})
        call(op_a, cj_a, "sb_add_override_zero", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "price": 0})
        call(op_a, cj_a, "sb_add_recurrent", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 9, "period": "1M", "quantity": 1})
        call(op_a, cj_a, "sb_get_full", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "cart_get_basket", "admin", "cart", "get",
             {"id": d.execute("SELECT id FROM cart WHERE session_id = 'staff:1:1'").fetchone()[0]})

        # promo flows on the full basket
        call(op_a, cj_a, "sb_promo_unknown", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "NOPE"})
        call(op_a, cj_a, "sb_promo_expired", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25EXP"})
        call(op_a, cj_a, "sb_promo_inactive", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25INACT"})
        call(op_a, cj_a, "sb_promo_maxed", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25MAX"})
        call(op_a, cj_a, "sb_promo_once_used", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25ONCE"})
        call(op_a, cj_a, "sb_promo_group", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25GRP"})
        call(op_a, cj_a, "sb_promo_pct10", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})
        call(op_a, cj_a, "sb_get_promo", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_promo_again", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})
        call(op_a, cj_a, "sb_remove_promo", "admin", "cart", "staff_basket_remove_promo",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_get_nopromo", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_promo_bundle_unmet", "admin", "cart",
             "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25BUNDLE"})
        call(op_a, cj_a, "sb_promo_freesetup", "admin", "cart",
             "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25FREESETUP"})
        call(op_a, cj_a, "sb_get_freesetup", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_remove_promo2", "admin", "cart", "staff_basket_remove_promo",
             {"client_id": CLIENT_ID})

        # auto promos: no manual code -> auto view (best_single default:
        # highest discount wins: 15% of basket vs $7 absolute)
        call(op_a, cj_a, "sb_get_auto", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})

        # remove-item cascade: seed lines directly, then remove the parent
        basket_id = d.execute("SELECT id FROM cart WHERE session_id = 'staff:1:1'").fetchone()[0]
        parent_line = ins("INSERT INTO cart_product (product_id, config, cart_id)"
                          " VALUES (2, ?, ?)",
                          ('{"quantity":1,"domain_name":"cap25.local"}', basket_id))
        ins("INSERT INTO cart_product (product_id, config, cart_id) VALUES (2, ?, ?)",
            ('{"quantity":1,"parent_id":2,"domain_name":"cap25.local"}', basket_id))
        ins("INSERT INTO cart_product (product_id, config, cart_id) VALUES (2, ?, ?)",
            ('{"quantity":1,"parent_id":2,"domain_name":"other.local"}', basket_id))
        call(op_a, cj_a, "sb_remove_missing", "admin", "cart", "staff_basket_remove_item",
             {"client_id": CLIENT_ID, "id": 999999})
        call(op_a, cj_a, "sb_remove_parent", "admin", "cart", "staff_basket_remove_item",
             {"client_id": CLIENT_ID, "id": parent_line})
        call(op_a, cj_a, "sb_get_after_remove", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_discard", "admin", "cart", "staff_basket_discard",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_get_after_discard", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})

        # promo on empty basket
        call(op_a, cj_a, "sb_promo_empty", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})

        # domain product add (TLD pricing path)
        call(op_a, cj_a, "sb_add_domain", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 1, "action": "register",
              "register_sld": "cap25domain", "register_tld": ".com", "register_years": 1})
        call(op_a, cj_a, "sb_get_domain", "admin", "cart", "staff_basket_get",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_add_domain_dup", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 1, "action": "register",
              "register_sld": "cap25domain", "register_tld": ".com", "register_years": 1})
        call(op_a, cj_a, "sb_discard2", "admin", "cart", "staff_basket_discard",
             {"client_id": CLIENT_ID})

        # checkout: empty, then simple, promo, mark-paid, stripe, free
        call(op_a, cj_a, "sb_checkout_empty", "admin", "cart", "staff_basket_checkout",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "sb_add_once2", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "quantity": 1})
        r = call(op_a, cj_a, "sb_checkout_simple", "admin", "cart", "staff_basket_checkout",
                 {"client_id": CLIENT_ID, "gateway_id": 1})
        (OUT / "sb_checkout_simple_db.json").write_text(
            json.dumps(dump_new(), indent=2))
        call(op_a, cj_a, "sb_add_promo_checkout", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2, "quantity": 1})
        call(op_a, cj_a, "sb_promo_checkout", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})
        r = call(op_a, cj_a, "sb_checkout_promo", "admin", "cart", "staff_basket_checkout",
                 {"client_id": CLIENT_ID, "gateway_id": 1})
        (OUT / "sb_checkout_promo_db.json").write_text(
            json.dumps(dump_new(), indent=2))
        call(op_a, cj_a, "sb_add_markpaid", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2})
        call(op_a, cj_a, "sb_checkout_markpaid_nogw", "admin", "cart",
             "staff_basket_checkout",
             {"client_id": CLIENT_ID, "mark_invoice_paid": 1})
        call(op_a, cj_a, "sb_checkout_markpaid_notx", "admin", "cart",
             "staff_basket_checkout",
             {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 1})
        r = call(op_a, cj_a, "sb_checkout_markpaid", "admin", "cart",
                 "staff_basket_checkout",
                 {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 1,
                  "transactionId": "CAP25TX1"})
        (OUT / "sb_checkout_markpaid_db.json").write_text(
            json.dumps(dump_new(), indent=2))
        call(op_a, cj_a, "sb_add_stripe", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2})
        r = call(op_a, cj_a, "sb_checkout_stripe_paid", "admin", "cart",
                 "staff_basket_checkout",
                 {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 3})
        (OUT / "sb_checkout_stripe_paid_db.json").write_text(
            json.dumps(dump_new(), indent=2))
        call(op_a, cj_a, "sb_add_free", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": prod_free})
        r = call(op_a, cj_a, "sb_checkout_free", "admin", "cart", "staff_basket_checkout",
                 {"client_id": CLIENT_ID, "gateway_id": 1})
        (OUT / "sb_checkout_free_db.json").write_text(
            json.dumps(dump_new(), indent=2))
        call(op_a, cj_a, "sb_add_pct100", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2})
        call(op_a, cj_a, "sb_promo_pct100", "admin", "cart", "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25PCT100"})
        r = call(op_a, cj_a, "sb_checkout_pct100", "admin", "cart", "staff_basket_checkout",
                 {"client_id": CLIENT_ID, "gateway_id": 1})
        (OUT / "sb_checkout_pct100_db.json").write_text(
            json.dumps(dump_new(), indent=2))

        call(op_a, cj_a, "sb_add_once_used", "admin", "cart", "staff_basket_add_item",
             {"client_id": CLIENT_ID, "id": 2})
        call(op_a, cj_a, "sb_promo_once_apply", "admin", "cart",
             "staff_basket_apply_promo",
             {"client_id": CLIENT_ID, "promocode": "CAP25ONCE"})
        call(op_a, cj_a, "sb_checkout_once_used", "admin", "cart",
             "staff_basket_checkout", {"client_id": CLIENT_ID, "gateway_id": 1})
        call(op_a, cj_a, "sb_discard3", "admin", "cart", "staff_basket_discard",
             {"client_id": CLIENT_ID})

        # batch_expire (staff basket survives even when old)
        call(op_a, cj_a, "cart_batch_expire", "admin", "cart", "batch_expire")
        call(op_a, cj_a, "cart_batch_expire2", "admin", "cart", "batch_expire")
        (OUT / "cart_batch_expire_db.json").write_text(
            json.dumps({"cart": [dict(zip(
                [r[1] for r in d.execute("PRAGMA table_info(cart)")],
                row)) for row in d.execute(
                    "SELECT * FROM cart WHERE session_id LIKE 'cap25%' OR session_id = 'staff:1:1'").fetchall()],
                "cart_product": [dict(zip(
                [r[1] for r in d.execute("PRAGMA table_info(cart_product)")],
                row)) for row in d.execute(
                    "SELECT * FROM cart_product WHERE cart_id IN"
                    " (SELECT id FROM cart WHERE session_id LIKE 'cap25%')").fetchall()]},
                indent=2))

        # ---------- staff admin cases ----------
        call(op_a, cj_a, "staff_group_get_pairs", "admin", "staff", "group_get_pairs")
        hist_id = d.execute("SELECT MAX(id) FROM activity_admin_history").fetchone()[0]
        call(op_a, cj_a, "staff_login_history_get", "admin", "staff", "login_history_get",
             {"id": hist_id})
        call(op_a, cj_a, "staff_login_history_get_missing", "admin", "staff",
             "login_history_get", {"id": 999999})
        call(op_a, cj_a, "staff_login_history_get_noid", "admin", "staff",
             "login_history_get")

        # ---------- staff guest: login ----------
        def guest_login_case(name, data, with_csrf=True):
            op_g, cj_g = staff_opener()
            r = call(op_g, cj_g, name, "guest", "staff", "login", data,
                     with_csrf=with_csrf)
            sess = [c.value for c in cj_g if c.name == "fossbilling_session"]
            return r, (sess[0] if sess else None)

        r, _ = guest_login_case("staff_login_ok",
                                {"email": ADMIN_EMAIL, "password": ADMIN_PASS})
        (OUT / "staff_login_ok_db.json").write_text(json.dumps(dump_new(), indent=2))
        guest_login_case("staff_login_wrongpass",
                         {"email": ADMIN_EMAIL, "password": "WrongPass!99"})
        guest_login_case("staff_login_unknown",
                         {"email": "nobody@example.com", "password": "Whatever!99"})
        guest_login_case("staff_login_inactive",
                         {"email": "cap25.inactive@example.com", "password": ADMIN_PASS})
        guest_login_case("staff_login_cron",
                         {"email": "hn11BSSd@PMgLWIl2.com", "password": "x"})
        guest_login_case("staff_login_bademail",
                         {"email": "not-an-email", "password": "Whatever!99"})
        guest_login_case("staff_login_noemail", {"password": "Whatever!99"})
        guest_login_case("staff_login_nopass", {"email": ADMIN_EMAIL})
        guest_login_case("staff_login_nocsrf",
                         {"email": ADMIN_EMAIL, "password": ADMIN_PASS},
                         with_csrf=False)

        # ---------- staff guest: password reset request ----------
        def guest_pwreset_case(name, data):
            op_g, cj_g = staff_opener()
            return call(op_g, cj_g, name, "guest", "staff", "passwordreset", data)

        r = guest_pwreset_case("staff_pwreset_ok", {"email": ADMIN_EMAIL})
        (OUT / "staff_pwreset_ok_db.json").write_text(json.dumps(dump_new(), indent=2))
        reset_hash = d.execute(
            "SELECT hash FROM admin_password_reset WHERE admin_id = 1"
            " ORDER BY id DESC LIMIT 1").fetchone()[0]
        guest_pwreset_case("staff_pwreset_again", {"email": ADMIN_EMAIL})
        n_resets = d.execute(
            "SELECT COUNT(*) FROM admin_password_reset WHERE admin_id = 1").fetchone()[0]
        print("resets after second request:", n_resets)
        # replaceReset rotates the token: re-read the live hash for confirm
        reset_hash = d.execute(
            "SELECT hash FROM admin_password_reset WHERE admin_id = 1"
            " ORDER BY id DESC LIMIT 1").fetchone()[0]
        guest_pwreset_case("staff_pwreset_unknown", {"email": "nobody@example.com"})
        guest_pwreset_case("staff_pwreset_inactive",
                           {"email": "cap25.inactive@example.com"})
        guest_pwreset_case("staff_pwreset_noemail", {})
        guest_pwreset_case("staff_pwreset_bademail", {"email": "not-an-email"})

        # ---------- staff guest: password reset confirm ----------
        def guest_pwupdate_case(name, data):
            op_g, cj_g = staff_opener()
            return call(op_g, cj_g, name, "guest", "staff", "update_password", data)

        guest_pwupdate_case("staff_pwupdate_mismatch",
                            {"code": reset_hash, "password": "Cap25-New!99",
                             "password_confirm": "Cap25-Other!99"})
        guest_pwupdate_case("staff_pwupdate_weak",
                            {"code": reset_hash, "password": "short",
                             "password_confirm": "short"})
        guest_pwupdate_case("staff_pwupdate_nocode",
                            {"password": "Cap25-New!99",
                             "password_confirm": "Cap25-New!99"})
        guest_pwupdate_case("staff_pwupdate_badcode",
                            {"code": "0" * 64, "password": "Cap25-New!99",
                             "password_confirm": "Cap25-New!99"})
        guest_pwupdate_case("staff_pwupdate_expired",
                            {"code": "cap25expiredhash", "password": "Cap25-New!99",
                             "password_confirm": "Cap25-New!99"})
        r = guest_pwupdate_case("staff_pwupdate_ok",
                                {"code": reset_hash, "password": "Cap25-New!99",
                                 "password_confirm": "Cap25-New!99"})
        (OUT / "staff_pwupdate_ok_db.json").write_text(json.dumps(dump_new(), indent=2))
        # new password works, old does not (fresh openers: sessions were invalidated)
        guest_login_case("staff_login_newpass",
                         {"email": ADMIN_EMAIL, "password": "Cap25-New!99"})
        guest_login_case("staff_login_oldpass",
                         {"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    finally:
        restore()
        print("reference DB restored")


if __name__ == "__main__":
    main()
