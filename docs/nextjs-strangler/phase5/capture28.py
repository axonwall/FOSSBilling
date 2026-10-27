#!/usr/bin/env python3
"""Phase 5 R2a capture: PHP-only corpus for the permission model.

Records PHP's answers for the parity25 case set (is_allowed matrix,
get_navigation shape + filtering + url marking, module-access 725s,
method-key 403s, activation 715s, conditional guards) so the TS
implementation has a committed oracle. Same seeds as parity25
(custom groups + staff + crafted paid deposit invoice), same
snapshot/restore discipline (reference DB + uploads restored in a
finally, including sqlite_sequence).

Runs against live PHP only (:8080). Logins go through the PHP login
page; staff passwords are the parity25 seed hash.
"""
import json
import pathlib
import re
import secrets
import sqlite3
import urllib.request
import urllib.parse
import http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures28"
OUT.mkdir(exist_ok=True)
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
UPLOADS = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/data/uploads")

ADMIN_PASS = "R2a-Staff!42"
PASS_HASH = "$2b$12$EDk8uU38CUzztiThw9jM9enmE5idjJ9q2cGrWj8b.bLDG8F4OJqGq"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"

TABLES = ["admin", "admin_group", "admin_group_member", "invoice",
          "invoice_item", "session", "client_balance", "transaction",
          "client_order", "email_queue"]


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    snaps = {}
    for t in TABLES:
        try:
            snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(),
                        [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')])
        except Exception:
            snaps[t] = ([], [])
    seq_q = ", ".join("?" * len(TABLES))
    snap_seq = d.execute(
        f"SELECT name, seq FROM sqlite_sequence WHERE name IN ({seq_q})", TABLES).fetchall()
    uploads_before = set(p.name for p in UPLOADS.iterdir()) if UPLOADS.exists() else set()

    def restore():
        for name in list(UPLOADS.iterdir()) if UPLOADS.exists() else []:
            if name.name not in uploads_before:
                name.unlink()
        d.execute(f"DELETE FROM sqlite_sequence WHERE name IN ({seq_q})", TABLES)
        for name, seq in snap_seq:
            d.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (name, seq))
        for t in TABLES:
            rows, cols = snaps[t]
            if not cols:
                continue
            d.execute(f'DELETE FROM "{t}"')
            col_list = ",".join(cols)
            placeholders = ",".join("?" * len(cols))
            d.executemany(f'INSERT INTO "{t}" (' + col_list + ") VALUES (" + placeholders + ")",
                          [tuple(r) for r in rows])
        d.commit()

    def login(email, password):
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        page = op.open(f"{BASE}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        token = m.group(1) if m else None
        payload = {"email": email, "password": password}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{BASE}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed for {email}: {parsed}"
        return op, token

    def call(op, token, role, module, method, data=None, save=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
        parsed = json.loads(raw.decode())
        if save:
            (OUT / f"{save}.json").write_text(json.dumps(parsed, indent=2))
        err = parsed.get("error") if isinstance(parsed, dict) else None
        print(("OK " if err is None else "ERR"), save or f"{module}/{method}",
              (err or {}).get("message", "") if err else "")
        return parsed

    try:
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R2a Order Only", json.dumps({"order": {"access": True, "manage": True}})))
        g_order = cur.lastrowid
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R2a Invoice Only", json.dumps({"invoice": {"access": True, "manage_invoices": True}})))
        g_invoice = cur.lastrowid
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R2a SysAccess", json.dumps({
                "system": {"access": True},
                "extension": {"access": True},
                "support": {"access": True, "view": True, "manage_tickets": True}})))
        g_sys = cur.lastrowid
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R2a CartOrder", json.dumps({
                "cart": {"access": True},
                "order": {"access": True, "manage": True}})))
        g_cartorder = cur.lastrowid
        for email, name, groups in [
            ("r2a-lead@example.local", "R2a Lead", [2]),
            ("r2a-staff@example.local", "R2a Staff", [3]),
            ("r2a-nogroup@example.local", "R2a NoGroup", []),
            ("r2a-order@example.local", "R2a OrderOnly", [g_order]),
            ("r2a-invoice@example.local", "R2a InvoiceOnly", [g_invoice]),
            ("r2a-sys@example.local", "R2a SysAccess", [g_sys]),
            ("r2a-cartorder@example.local", "R2a CartOrder", [g_cartorder]),
        ]:
            cur = d.execute(
                "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
                (email, PASS_HASH, name))
            for gid in groups:
                d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                          (cur.lastrowid, gid))
        d.commit()
        cols = [r[1] for r in d.execute("PRAGMA table_info(invoice)")
                if r[1] not in ("id", "hash")]
        col_list = ",".join(cols)
        d.execute(f"INSERT INTO invoice ({col_list}, hash) "
                  f"SELECT {col_list}, ? FROM invoice WHERE id = 1",
                  (secrets.token_hex(24),))
        dep_id = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("UPDATE invoice SET status = 'paid' WHERE id = ?", (dep_id,))
        d.execute(
            "INSERT INTO invoice_item (type, title, quantity, price, taxed, invoice_id) "
            "VALUES ('deposit', 'R2a deposit', 1, 10.00, 0, ?)", (dep_id,))
        d.commit()
        print(f"seeded deposit invoice {dep_id}")

        sessions = {}
        for key, email, pw in [("super", SUPER_EMAIL, SUPER_PASS),
                               ("lead", "r2a-lead@example.local", ADMIN_PASS),
                               ("staff", "r2a-staff@example.local", ADMIN_PASS),
                               ("nogroup", "r2a-nogroup@example.local", ADMIN_PASS),
                               ("orderonly", "r2a-order@example.local", ADMIN_PASS),
                               ("invoiceonly", "r2a-invoice@example.local", ADMIN_PASS),
                               ("sysaccess", "r2a-sys@example.local", ADMIN_PASS),
                               ("cartorder", "r2a-cartorder@example.local", ADMIN_PASS)]:
            sessions[key] = login(email, pw)

        pairs = [
            ("client", "view"), ("client", "manage_balance"), ("client", None),
            ("support", "manage_tickets"), ("support", "manage_canned"), ("support", None),
            ("staff", "manage_groups"), ("staff", None),
            ("invoice", "manage_invoices"), ("invoice", "view"),
            ("order", "manage"), ("product", "manage_promos"),
            ("system", "update_params"), ("profile", None), ("index", None),
            ("dashboard", None), ("foobar", None), ("support", "nonexistent_key"),
        ]
        for who in ("super", "sysaccess", "lead", "staff", "nogroup"):
            op, token = sessions[who]
            for mod, f in pairs:
                data = {"mod": mod}
                if f is not None:
                    data["f"] = f
                call(op, token, "admin", "system", "is_allowed", data,
                     save=f"allowed_{who}_{mod}_{f}")
        op, token = sessions["super"]
        call(op, token, "admin", "system", "is_allowed", {},
             save="allowed_super_missing_mod")

        for who in ("super", "sysaccess", "lead", "staff", "nogroup"):
            op, token = sessions[who]
            call(op, token, "admin", "extension", "get_navigation", {},
                 save=f"nav_{who}")
        op, token = sessions["super"]
        call(op, token, "admin", "extension", "get_navigation",
             {"url": "http://127.0.0.1:8080/admin/invoice"}, save="nav_super_url_invoice")
        call(op, token, "admin", "extension", "get_navigation",
             {"url": "http://127.0.0.1:8080/admin/support?status=open"},
             save="nav_super_url_support")

        GEN = {"id": "1", "client_id": "1", "order_id": "1", "product_id": "1"}
        denials = [
            ("activity", "log_get_list"), ("antispam", "get_blocked_ips"),
            ("cart", "staff_basket_get"), ("client", "get"), ("cron", "info"),
            ("currency", "get_list"), ("custompages", "get_page"),
            ("email", "get_queue"), ("formbuilder", "get_form"),
            ("invoice", "get_list"), ("massmailer", "get"), ("news", "get"),
            ("notification", "get"), ("order", "get"), ("product", "get"),
            ("profile", "api_key_reset"), ("redirect", "get"),
            ("security", "rate_limit_get_list"), ("seo", "info"),
            ("serviceapikey", "reset"), ("servicecustom", "update"),
            ("servicedomain", "registrar_get_available"),
            ("servicedownloadable", "config_save"),
            ("servicehosting", "account_get_list"),
            ("servicelicense", "plugin_get_pairs"), ("staff", "get_pairs"),
            ("stats", "get_clients"), ("support", "canned_get_list"),
            ("system", "update_params"), ("widgets", "list"),
        ]
        op, token = sessions["nogroup"]
        for mod, meth in denials:
            call(op, token, "admin", mod, meth, GEN, save=f"deny_nogroup_{mod}_{meth}")

        op, token = sessions["staff"]
        call(op, token, "admin", "support", "canned_delete", {"id": "1"},
             save="deny_key_staff_canned_delete")
        op, token = sessions["orderonly"]
        call(op, token, "admin", "order", "get", {"id": "1"},
             save="deny_key_orderonly_order_get")
        op, token = sessions["invoiceonly"]
        call(op, token, "admin", "invoice", "get", {"id": "1"},
             save="deny_key_invoiceonly_invoice_get")
        op, token = sessions["lead"]
        call(op, token, "admin", "staff", "delete", {"id": "2"},
             save="deny_key_lead_staff_delete")
        op, token = sessions["super"]
        call(op, token, "admin", "seo", "info", {}, save="activate_super_seo_info")
        call(op, token, "admin", "serviceapikey", "reset", {},
             save="activate_super_serviceapikey_reset")

        op, token = sessions["invoiceonly"]
        call(op, token, "admin", "invoice", "reissue", {"id": "1", "order_id": "1"},
             save="cond_reissue_order")
        op, token = sessions["orderonly"]
        call(op, token, "admin", "order", "create",
             {"client_id": "1", "product_id": "2", "promo_code": "SAVE10"},
             save="cond_order_create_promo")
        call(op, token, "admin", "order", "create",
             {"client_id": "1", "product_id": "2", "mark_invoice_paid": "1"},
             save="cond_order_create_markpaid")
        op, token = sessions["cartorder"]
        call(op, token, "admin", "cart", "staff_basket_checkout",
             {"client_id": "1", "mark_invoice_paid": "1"},
             save="cond_cart_checkout_markpaid")
        op, token = sessions["invoiceonly"]
        call(op, token, "admin", "invoice", "mark_as_paid", {"id": str(dep_id)},
             save="cond_markpaid_deposit")
        call(op, token, "admin", "invoice", "refund", {"id": str(dep_id)},
             save="cond_refund_deposit")
        print("capture28: done")
    finally:
        restore()
        print("reference DB restored")


if __name__ == "__main__":
    main()
