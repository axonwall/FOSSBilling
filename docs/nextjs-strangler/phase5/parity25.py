#!/usr/bin/env python3
"""Phase 5 R2a parity: permission model + is_allowed + get_navigation +
guard enforcement, compared live on PHP (:8080) vs TS (:3001/api/fb).

Sections:
  A. is_allowed matrix: super-admin / Support Lead / Support Staff /
     no-group staff / order-only custom group / invoice-only custom
     group x (mod, f) pairs, plus the missing-mod param error.
  B. get_navigation shape + permission filtering + url active marking.
  C. Guarded-endpoint denials: one guarded endpoint per guarded TS
     module (30), as no-group staff; generous params supplied so PHP's
     RequiredParams validation passes and both stacks reach the guard.
  D. Conditional guards: reissue+order_id, order create+promo,
     order create+mark_paid, cart checkout+mark_paid, mark_as_paid and
     refund on a crafted paid deposit invoice.
  E. Sidebar smoke: admin pages render 200 with the sidebar for a
     logged-in admin, and the login page renders the fallback chrome.
  F. Method-key denials (403): staff WITH module access but WITHOUT
     the method's key. G. Activation (715): non-installed modules
     answer 715 on both stacks even for super-admin.

Seeds (restored in finally): four custom admin groups (order-only,
invoice-only, sysaccess, cartorder), seven staff accounts (lead,
staff, nogroup, orderonly, invoiceonly, sysaccess, cartorder), one
crafted paid deposit invoice + deposit item.

Gate model (Api\Dispatcher, verified live): activation 715, then
admin module-access 725, then method guards 403. So is_allowed and
get_navigation answer 725 for staff without system/extension access;
only super-admin and sysaccess staff get real is_allowed/nav answers.
Logins go through PHP once; the session row lives in the shared DB,
so the same cookies authenticate both stacks (TS reads the PHP row).
Only envelopes are compared, never HTTP status: TS error envelopes
are always HTTP 200 by seam convention while PHP answers 403 for
denials — same envelope, different status, documented not hidden.
"""
import json
import pathlib
import re
import sqlite3
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
TS_PAGES = "http://127.0.0.1:3001"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
UPLOADS = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/data/uploads")

ADMIN_PASS = "R2a-Staff!42"
# bcrypt $2b$ cost 12 of ADMIN_PASS (node bcryptjs, apps/nextjs).
PASS_HASH = "$2b$12$EDk8uU38CUzztiThw9jM9enmE5idjJ9q2cGrWj8b.bLDG8F4OJqGq"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"

TABLES = ["admin", "admin_group", "admin_group_member", "invoice",
          "invoice_item", "session", "client_balance", "transaction",
          "client_order", "email_queue"]

FAILURES = []
CHECKS = 0
STATUS_NOTES = []


def scrub(v):
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    if isinstance(v, str):
        v = re.sub(r"\b[0-9a-f]{64}\b", "<hex64>", v)
        v = re.sub(r"\b[0-9a-f]{32}\b", "<hex32>", v)
        v = re.sub(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", "<ts>", v)
        return v
    return v


def check(name, php_val, ts_val):
    global CHECKS
    CHECKS += 1
    a, b = scrub(php_val), scrub(ts_val)
    if a != b:
        FAILURES.append((name, a, b))
        print("FAIL", name)
    else:
        print("ok  ", name)


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
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        token = m.group(1) if m else None
        payload = {"email": email, "password": password}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed for {email}: {parsed}"
        return op, cj, token

    def call(base, op, token, role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{base}/api/{role}/{module}/{method}" if base == PHP
                                     else f"{base}/{role}/{module}/{method}",
                                     data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            status = e.code
        try:
            parsed = json.loads(raw.decode())
        except Exception:
            parsed = {"_raw": raw[:200].decode("utf-8", "replace")}
        return parsed, status

    def both(op, token, role, module, method, data=None):
        p, p_status = call(PHP, op, token, role, module, method, data)
        t, t_status = call(TS, op, token, role, module, method, data)
        if p_status != t_status:
            STATUS_NOTES.append((f"{role}/{module}/{method}", p_status, t_status))
        return p, t

    try:
        # ---- seed ----
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
        staff = {}
        for key, email, name, groups in [
            ("lead", "r2a-lead@example.local", "R2a Lead", [2]),
            ("staff", "r2a-staff@example.local", "R2a Staff", [3]),
            ("nogroup", "r2a-nogroup@example.local", "R2a NoGroup", []),
            ("orderonly", "r2a-order@example.local", "R2a OrderOnly", [g_order]),
            ("invoiceonly", "r2a-invoice@example.local", "R2a InvoiceOnly", [g_invoice]),
            ("sysaccess", "r2a-sys@example.local", "R2a SysAccess", [g_sys]),
            ("cartorder", "r2a-cartorder@example.local", "R2a CartOrder", [g_cartorder]),
        ]:
            cur = d.execute(
                "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
                (email, PASS_HASH, name))
            aid = cur.lastrowid
            for gid in groups:
                d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                          (aid, gid))
            staff[key] = aid
        d.commit()
        # Crafted paid deposit invoice: copy of invoice 1 + deposit item.
        # Hash is UNIQUE, so it is excluded from the copy and re-minted.
        import secrets
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
        print(f"seeded groups {g_order}/{g_invoice}, deposit invoice {dep_id}")

        sessions = {}
        for key, email in [("super", SUPER_EMAIL), ("lead", "r2a-lead@example.local"),
                           ("staff", "r2a-staff@example.local"),
                           ("nogroup", "r2a-nogroup@example.local"),
                           ("orderonly", "r2a-order@example.local"),
                           ("invoiceonly", "r2a-invoice@example.local"),
                           ("sysaccess", "r2a-sys@example.local"),
                           ("cartorder", "r2a-cartorder@example.local")]:
            pw = SUPER_PASS if key == "super" else ADMIN_PASS
            sessions[key] = login(email, pw)

        # ---- A. is_allowed matrix ----
        pairs = [
            ("client", "view"), ("client", "manage_balance"), ("client", None),
            ("support", "manage_tickets"), ("support", "manage_canned"), ("support", None),
            ("staff", "manage_groups"), ("staff", None),
            ("invoice", "manage_invoices"), ("invoice", "view"),
            ("order", "manage"), ("product", "manage_promos"),
            ("system", "update_params"), ("profile", None), ("index", None),
            ("dashboard", None), ("foobar", None), ("support", "nonexistent_key"),
        ]
        for who in ("super", "sysaccess", "lead", "staff", "nogroup",
                    "orderonly", "invoiceonly", "cartorder"):
            op, cj, token = sessions[who]
            for mod, f in pairs:
                data = {"mod": mod}
                if f is not None:
                    data["f"] = f
                p, t = both(op, token, "admin", "system", "is_allowed", data)
                check(f"allowed_{who}_{mod}_{f}", p, t)
        op, cj, token = sessions["super"]
        p, t = both(op, token, "admin", "system", "is_allowed", {})
        check("allowed_super_missing_mod", p, t)
        # Gate precedes param validation: no-group staff gets 725 even
        # with the mod param missing.
        op, cj, token = sessions["nogroup"]
        p, t = both(op, token, "admin", "system", "is_allowed", {})
        check("allowed_nogroup_missing_mod", p, t)

        # ---- B. get_navigation ----
        for who in ("super", "sysaccess", "lead", "staff", "nogroup"):
            op, cj, token = sessions[who]
            p, t = both(op, token, "admin", "extension", "get_navigation", {})
            check(f"nav_{who}", p, t)
        op, cj, token = sessions["super"]
        p, t = both(op, token, "admin", "extension", "get_navigation",
                    {"url": "http://127.0.0.1:8080/admin/invoice"})
        check("nav_super_url_invoice", p, t)
        p, t = both(op, token, "admin", "extension", "get_navigation",
                    {"url": "http://127.0.0.1:8080/admin/support?status=open"})
        check("nav_super_url_support", p, t)

        # ---- C. guarded-endpoint denials (no-group staff) ----
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
        op, cj, token = sessions["nogroup"]
        for mod, meth in denials:
            p, t = both(op, token, "admin", mod, meth, GEN)
            check(f"deny_nogroup_{mod}_{meth}", p, t)

        # ---- D. conditional guards ----
        op, cj, token = sessions["invoiceonly"]
        p, t = both(op, token, "admin", "invoice", "reissue",
                    {"id": "1", "order_id": "1"})
        check("cond_reissue_order", p, t)
        op, cj, token = sessions["orderonly"]
        p, t = both(op, token, "admin", "order", "create",
                    {"client_id": "1", "product_id": "2", "promo_code": "SAVE10"})
        check("cond_order_create_promo", p, t)
        p, t = both(op, token, "admin", "order", "create",
                    {"client_id": "1", "product_id": "2", "mark_invoice_paid": "1"})
        check("cond_order_create_markpaid", p, t)
        # Cart checkout needs cart access too, or the module gate (725)
        # fires before the conditional invoice guard: cartorder group.
        op, cj, token = sessions["cartorder"]
        p, t = both(op, token, "admin", "cart", "staff_basket_checkout",
                    {"client_id": "1", "mark_invoice_paid": "1"})
        check("cond_cart_checkout_markpaid", p, t)
        op, cj, token = sessions["invoiceonly"]
        p, t = both(op, token, "admin", "invoice", "mark_as_paid", {"id": str(dep_id)})
        check("cond_markpaid_deposit", p, t)
        p, t = both(op, token, "admin", "invoice", "refund", {"id": str(dep_id)})
        check("cond_refund_deposit", p, t)
        # Guard-level allow directions (no mutation: nonexistent invoice
        # for reissue; paid non-deposit invoice 1 for mark_as_paid).
        p, t = both(op, token, "admin", "invoice", "reissue", {"id": "999999"})
        check("cond_reissue_noorder_missing", p, t)
        p, t = both(op, token, "admin", "invoice", "mark_as_paid", {"id": "1"})
        check("cond_markpaid_nondeposit_paid", p, t)

        # ---- F. method-key denials (403): module access passes, the
        # method's key does not. ----
        op, cj, token = sessions["staff"]
        p, t = both(op, token, "admin", "support", "canned_delete", {"id": "1"})
        check("deny_key_staff_canned_delete", p, t)
        op, cj, token = sessions["orderonly"]
        p, t = both(op, token, "admin", "order", "get", {"id": "1"})
        check("deny_key_orderonly_order_get", p, t)
        op, cj, token = sessions["invoiceonly"]
        p, t = both(op, token, "admin", "invoice", "get", {"id": "1"})
        check("deny_key_invoiceonly_invoice_get", p, t)
        op, cj, token = sessions["lead"]
        # Real id (cron admin, never deleted: the guard fires after the
        # load in PHP, so a nonexistent id would give not-found there
        # and 403 here — a late-guard precedence case, documented in
        # findings-r2a.md, not a guard miss).
        p, t = both(op, token, "admin", "staff", "delete", {"id": "2"})
        check("deny_key_lead_staff_delete", p, t)

        # ---- G. activation (715): non-installed modules, super-admin. ----
        op, cj, token = sessions["super"]
        p, t = both(op, token, "admin", "seo", "info", {})
        check("activate_super_seo_info", p, t)
        p, t = both(op, token, "admin", "serviceapikey", "reset", {})
        check("activate_super_serviceapikey_reset", p, t)

        # ---- E. sidebar smoke (TS pages only) ----
        _, cj, token = sessions["super"]
        op_pages = urllib.request.build_opener()
        for path, needles in [
            ("/admin", ["Clients", "Orders", "Invoices", "Support"]),
            ("/admin/clients", ["Clients"]),
            ("/admin/orders", ["Orders"]),
            ("/admin/invoices", ["Invoices"]),
            ("/admin/tickets", ["Support tickets"]),
        ]:
            req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
            # forward session cookies (plain opener: no cookie processor
            # to double-apply them)
            cookie_hdr = "; ".join(f"{c.name}={c.value}" for c in cj)
            req.add_header("Cookie", cookie_hdr)
            try:
                with op_pages.open(req, timeout=60) as resp:
                    body = resp.read().decode("utf-8", "replace")
                    status = resp.status
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                status = e.code
            global CHECKS
            CHECKS += 1
            missing = [n for n in needles if n not in body]
            has_aside = "<aside" in body
            if status != 200 or missing or not has_aside:
                FAILURES.append((f"page_{path}", {"status": status, "missing": missing,
                                                    "aside": has_aside}, "200+needles+aside"))
                print("FAIL", f"page_{path}", status, missing, has_aside)
            else:
                print("ok  ", f"page_{path}")
        # Login page: no session -> fallback chrome, no sidebar.
        cj2 = http.cookiejar.CookieJar()
        op2 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj2))
        req = urllib.request.Request(f"{TS_PAGES}/admin/login", method="GET")
        with op2.open(req, timeout=60) as resp:
            body = resp.read().decode("utf-8", "replace")
            status = resp.status
        CHECKS += 1
        if status != 200 or "<aside" in body:
            FAILURES.append(("page_/admin/login", {"status": status, "aside": "<aside" in body},
                             "200 without aside"))
            print("FAIL", "page_/admin/login", status, "<aside" in body)
        else:
            print("ok  ", "page_/admin/login")
    finally:
        restore()
        print("reference DB restored")

    print(f"\nparity25: {CHECKS} checks, {len(FAILURES)} failures")
    if STATUS_NOTES:
        print("HTTP-status-only notes (envelopes compared, statuses differ by seam convention):")
        for name, ps, ts in sorted(set(STATUS_NOTES)):
            print(f"  {name}: php={ps} ts={ts}")
    if FAILURES:
        for name, a, b in FAILURES:
            print("DIFF", name, "\n  php:", json.dumps(a)[:600], "\n  ts: ", json.dumps(b)[:600])
        raise SystemExit(1)
    print("parity25: ALL GREEN")


if __name__ == "__main__":
    main()
