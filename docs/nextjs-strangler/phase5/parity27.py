#!/usr/bin/env python3
"""Phase 5 R2c parity: product + service-detail pages, compared live on
PHP (:8080) vs TS (:3001/api/fb).

Sections:
  A. API equivalence: admin/order/service for five crafted orders (one
     per service type), the existing active custom order 1, the
     no-service order 4, and an unknown order; admin/product/get +
     get_list for the reference products. Crafted rows are restored
     and re-crafted identically per stack so ids match; crafted values
     are fixed strings, so envelopes are compared EXACTLY (no
     timestamp scrubbing) — a format difference is a real diff.
  B. Page smoke (TS pages only, super-admin session): every new route
     returns 200 with the sidebar and markers proving real data
     rendered (product names, service identifiers matching the API
     response for the same record, not static chrome); missing-record
     cases render the API error box, not a crash; the order page links
     to its service only when one exists.
  C. Logged-out smoke: products list and one service detail render
     without the sidebar and show the staff sign-in link.
Only envelopes are compared, never HTTP status: TS error envelopes are
always HTTP 200 by seam convention while PHP answers 4xx with the same
envelope, documented not hidden.
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
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
FIXED_TS = "2026-10-27 12:00:00"

FAILURES = []
CHECKS = 0
STATUS_NOTES = []


def check(name, php_val, ts_val):
    global CHECKS
    CHECKS += 1
    if php_val != ts_val:
        FAILURES.append((name, php_val, ts_val))
        print("FAIL", name)
    else:
        print("ok  ", name)


def main():
    global CHECKS
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

    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
    token = m.group(1) if m else None

    def call(base, role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw, status = resp.read(), resp.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        try:
            parsed = json.loads(raw.decode())
        except Exception:
            parsed = {"_raw": raw[:200].decode("utf-8", "replace")}
        return parsed, status

    def login():
        payload = {"email": SUPER_EMAIL, "password": SUPER_PASS}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed: {parsed}"

    def craft():
        cur = d.cursor()
        cur.execute(
            """INSERT INTO service_hosting_server
            (name, hostname, ip, ns1, ns2, manager, username, password, accesshash,
             password_length, port, config, active, secure, max_accounts, assigned_ips,
             created_at, updated_at)
            VALUES ('R2c Test Server', 'r2c.example.com', '192.0.2.10',
             'ns1.r2c.example', 'ns2.r2c.example', 'Custom', 'r2cadmin', 'r2c-pw',
             'r2c-hash', 12, 2083, '{}', 1, 0, 100, '[]', ?, ?)""",
            (FIXED_TS, FIXED_TS))
        server_id = cur.lastrowid
        cur.execute(
            """INSERT INTO service_hosting_hp
            (name, quota, bandwidth, max_ftp, max_sql, max_pop, max_sub, max_park,
             max_addon, config, created_at, updated_at)
            VALUES ('R2c Plan', '10GB', '100GB', 5, 5, 10, 5, 5, 5, '{}', ?, ?)""",
            (FIXED_TS, FIXED_TS))
        hp_id = cur.lastrowid
        cur.execute(
            """INSERT INTO service_hosting
            (client_id, sld, tld, ip, username, pass, reseller,
             service_hosting_server_id, service_hosting_hp_id, created_at, updated_at)
            VALUES (1, 'r2csite', '.com', '192.0.2.11', 'r2cuser', 'x', 0, ?, ?, ?, ?)""",
            (server_id, hp_id, FIXED_TS, FIXED_TS))
        hosting_id = cur.lastrowid
        cur.execute(
            """INSERT INTO service_domain
            (client_id, sld, tld, ns1, ns2, period, privacy, locked, transfer_code,
             contact_first_name, contact_last_name, contact_email, contact_company,
             contact_address1, contact_city, contact_state, contact_postcode,
             contact_country, contact_phone_cc, contact_phone,
             registered_at, expires_at, synced_at, tld_registrar_id, created_at, updated_at)
            VALUES (1, 'r2cexample', '.com', 'ns1.r2c.example', 'ns2.r2c.example',
             '1Y', 1, 1, 'R2C-EPP-1', 'Rita', 'Example', 'rita@r2c.example', 'R2c Ltd',
             '1 Test Way', 'Testville', 'TS', '12345', 'US', '1', '5551234',
             '2026-01-01 00:00:00', '2027-01-01 00:00:00', ?, 1, ?, ?)""",
            (FIXED_TS, FIXED_TS, FIXED_TS))
        domain_id = cur.lastrowid
        cur.execute(
            """INSERT INTO service_license
            (client_id, license_key, validate_ip, validate_host, validate_path,
             validate_version, ips, hosts, paths, versions, plugin, pinged_at,
             created_at, updated_at)
            VALUES (1, 'R2C-LIC-001', 1, 1, 0, 1, '["10.0.2.1"]',
             '["app.r2c.example"]', '["/opt/app"]', '["2.0"]', 'r2c-plugin', ?, ?, ?)""",
            (FIXED_TS, FIXED_TS, FIXED_TS))
        license_id = cur.lastrowid
        cur.execute(
            "INSERT INTO service_downloadable (client_id, created_at, updated_at) VALUES (1, ?, ?)",
            (FIXED_TS, FIXED_TS))
        dl_id = cur.lastrowid
        cur.execute(
            """INSERT INTO service_downloadable_file
            (service_downloadable_id, label, filename, file_key, stored_filename,
             downloads, sort_order, created_at, updated_at)
            VALUES (?, 'User guide', 'r2c-guide.pdf', 'guide', ?, 3, 1, ?, ?)""",
            (dl_id, "a" * 64, FIXED_TS, FIXED_TS))
        cur.execute(
            """INSERT INTO service_downloadable_file
            (service_downloadable_id, label, filename, file_key, stored_filename,
             downloads, sort_order, created_at, updated_at)
            VALUES (?, 'Terms', 'r2c-terms.txt', 'terms', ?, 0, 2, ?, ?)""",
            (dl_id, "b" * 64, FIXED_TS, FIXED_TS))
        cur.execute(
            "INSERT INTO service_custom (client_id, plugin, config, created_at, updated_at)"
            " VALUES (1, 'r2c', ?, ?, ?)",
            ('{"plan":"r2c-pro"}', FIXED_TS, FIXED_TS))
        custom_id = cur.lastrowid
        ids = {}
        for key, svc_type, svc_id, product_id, title in [
                ("hosting", "hosting", hosting_id, 2, "R2c hosting order"),
                ("domain", "domain", domain_id, 1, "R2c domain order"),
                ("license", "license", license_id, 2, "R2c license order"),
                ("downloadable", "downloadable", dl_id, 2, "R2c downloadable order"),
                ("custom", "custom", custom_id, 2, "R2c custom order")]:
            cur.execute(
                """INSERT INTO client_order
                (client_id, product_id, title, currency, price, period, quantity,
                 status, service_type, service_id, config, created_at, updated_at)
                VALUES (1, ?, ?, 'USD', 10, '1M', 1, 'active', ?, ?, '{}', ?, ?)""",
                (product_id, title, svc_type, svc_id, FIXED_TS, FIXED_TS))
            ids[key] = cur.lastrowid
        d.commit()
        return ids

    try:
        login()
        # Snapshot AFTER login so the session row survives restores.
        for t in tables:
            cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
            snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
        seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()
        ids = craft()

        # ---- B. page smoke (on crafted state, before any restore) ----
        op_pages = urllib.request.build_opener()
        cookie_hdr = "; ".join(f"{c.name}={c.value}" for c in cj)

        def smoke(path, needles, aside=True, absent=()):
            global CHECKS
            CHECKS += 1
            req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
            req.add_header("Cookie", cookie_hdr)
            try:
                with op_pages.open(req, timeout=60) as resp:
                    body, status = resp.read().decode("utf-8", "replace"), resp.status
            except urllib.error.HTTPError as e:
                body, status = e.read().decode("utf-8", "replace"), e.code
            missing = [n for n in needles if n not in body]
            present_bad = [n for n in absent if n in body]
            has_aside = "<aside" in body
            if status != 200 or missing or present_bad or has_aside != aside:
                FAILURES.append((f"page_{path}", {"status": status, "missing": missing,
                                                  "present_bad": present_bad, "aside": has_aside},
                                 f"200+needles+aside={aside}"))
                print("FAIL", f"page_{path}", status, missing, present_bad, has_aside)
            else:
                print("ok  ", f"page_{path}")

        smoke("/admin/products", ["Products", "Phase0 Widget Hosting"])
        smoke("/admin/products/2", ["Phase0 Widget Hosting", "phase0-widget-hosting", "Pricing"])
        smoke("/admin/products/9", ["Phase3 Recurring Widget", "phase3-recurring-widget"])
        smoke("/admin/products/999999", ["Product not found"])
        smoke(f"/admin/services/{ids['hosting']}", ["r2csite.com", "r2cuser", "R2c Test Server", "R2c Plan"])
        smoke(f"/admin/services/{ids['domain']}", ["r2cexample.com", "ns1.r2c.example", "R2C-EPP-1"])
        smoke(f"/admin/services/{ids['license']}", ["R2C-LIC-001", "r2c-plugin", "10.0.2.1"])
        smoke(f"/admin/services/{ids['downloadable']}", ["r2c-guide.pdf", "r2c-terms.txt"])
        smoke(f"/admin/services/{ids['custom']}", ["r2c-pro"])
        smoke("/admin/services/4", ["does not have a provisioned service"])
        smoke("/admin/services/999999", ["Order Not Found"])
        smoke("/admin/orders/1", ["/admin/services/1"])
        smoke("/admin/orders/4", ["Phase0 Widget Hosting"], absent=["/admin/services/4"])

        # ---- C. logged-out smoke ----
        op_anon = urllib.request.build_opener()
        for path, needles in [("/admin/products", ["Sign in as staff"]),
                              (f"/admin/services/{ids['hosting']}", ["Sign in as staff"])]:
            CHECKS += 1
            req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
            with op_anon.open(req, timeout=60) as resp:
                body, status = resp.read().decode("utf-8", "replace"), resp.status
            missing = [n for n in needles if n not in body]
            if status != 200 or missing or "<aside" in body:
                FAILURES.append((f"page_anon_{path}", {"status": status, "missing": missing,
                                                       "aside": "<aside" in body}, "200+needles+no-aside"))
                print("FAIL", f"page_anon_{path}", status, missing, "<aside" in body)
            else:
                print("ok  ", f"page_anon_{path}")

        # ---- A. API equivalence ----
        def run_case(name, craft_fn, action):
            restore()
            cids = craft_fn() if craft_fn else {}
            p_env, p_status = call(PHP, *action(cids))
            restore()
            cids = craft_fn() if craft_fn else {}
            t_env, t_status = call(TS, *action(cids))
            if p_status != t_status:
                STATUS_NOTES.append((name, p_status, t_status))
            check(name, p_env, t_env)

        for key in ["hosting", "domain", "license", "downloadable", "custom"]:
            run_case(f"svc_{key}", craft,
                     lambda cids, k=key: ("admin", "order", "service", {"id": str(cids[k])}))
        run_case("svc_existing_custom", None,
                 lambda _: ("admin", "order", "service", {"id": "1"}))
        run_case("svc_no_service", None,
                 lambda _: ("admin", "order", "service", {"id": "4"}))
        run_case("svc_unknown_order", None,
                 lambda _: ("admin", "order", "service", {"id": "999999"}))
        run_case("prod_get_2", None,
                 lambda _: ("admin", "product", "get", {"id": "2"}))
        run_case("prod_get_9", None,
                 lambda _: ("admin", "product", "get", {"id": "9"}))
        run_case("prod_get_missing", None,
                 lambda _: ("admin", "product", "get", {"id": "999999"}))
        run_case("prod_list", None,
                 lambda _: ("admin", "product", "get_list", {"page": "1", "per_page": "50"}))
    finally:
        restore()
        print("reference DB restored")
    print(f"\nparity27: {CHECKS} checks, {len(FAILURES)} failures")
    if STATUS_NOTES:
        print("HTTP-status-only notes (envelopes compared, statuses differ by seam convention):")
        for name, ps, ts in STATUS_NOTES:
            print(f"  {name}: php={ps} ts={ts}")
    if FAILURES:
        for name, a, b in FAILURES:
            print("DIFF", name, "\n  php:", json.dumps(a)[:800], "\n  ts: ", json.dumps(b)[:800])
    else:
        print("parity27: ALL GREEN")


if __name__ == "__main__":
    main()
