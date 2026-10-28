#!/usr/bin/env python3
"""Phase 5 R2c capture: PHP-only corpus for product + service-detail cases.

Crafts one order per service type (hosting, domain, license,
downloadable, custom) plus their service rows, calls admin/order/service
and admin/product/get + get_list on PHP (:8080), writes captures30/,
and restores the reference DB in a finally block. The TS side of the
same cases is compared live by parity27.py; this file is the committed
oracle corpus. Crafted values are fixed strings so PHP and TS outputs
can be compared exactly.
"""
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
OUT = pathlib.Path(__file__).parent / "captures30"
TS = "2026-10-27 12:00:00"


def craft(d):
    cur = d.cursor()
    cur.execute(
        """INSERT INTO service_hosting_server
        (name, hostname, ip, ns1, ns2, manager, username, password, accesshash,
         password_length, port, config, active, secure, max_accounts, assigned_ips,
         created_at, updated_at)
        VALUES ('R2c Test Server', 'r2c.example.com', '192.0.2.10',
         'ns1.r2c.example', 'ns2.r2c.example', 'Custom', 'r2cadmin', 'r2c-pw',
         'r2c-hash', 12, 2083, '{}', 1, 0, 100, '[]', ?, ?)""",
        (TS, TS))
    server_id = cur.lastrowid
    cur.execute(
        """INSERT INTO service_hosting_hp
        (name, quota, bandwidth, max_ftp, max_sql, max_pop, max_sub, max_park,
         max_addon, config, created_at, updated_at)
        VALUES ('R2c Plan', '10GB', '100GB', 5, 5, 10, 5, 5, 5, '{}', ?, ?)""",
        (TS, TS))
    hp_id = cur.lastrowid
    cur.execute(
        """INSERT INTO service_hosting
        (client_id, sld, tld, ip, username, pass, reseller,
         service_hosting_server_id, service_hosting_hp_id, created_at, updated_at)
        VALUES (1, 'r2csite', '.com', '192.0.2.11', 'r2cuser', 'x', 0, ?, ?, ?, ?)""",
        (server_id, hp_id, TS, TS))
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
        (TS, TS, TS))
    domain_id = cur.lastrowid
    cur.execute(
        """INSERT INTO service_license
        (client_id, license_key, validate_ip, validate_host, validate_path,
         validate_version, ips, hosts, paths, versions, plugin, pinged_at,
         created_at, updated_at)
        VALUES (1, 'R2C-LIC-001', 1, 1, 0, 1, '["10.0.2.1"]',
         '["app.r2c.example"]', '["/opt/app"]', '["2.0"]', 'r2c-plugin', ?, ?, ?)""",
        (TS, TS, TS))
    license_id = cur.lastrowid
    cur.execute(
        "INSERT INTO service_downloadable (client_id, created_at, updated_at) VALUES (1, ?, ?)",
        (TS, TS))
    dl_id = cur.lastrowid
    cur.execute(
        """INSERT INTO service_downloadable_file
        (service_downloadable_id, label, filename, file_key, stored_filename,
         downloads, sort_order, created_at, updated_at)
        VALUES (?, 'User guide', 'r2c-guide.pdf', 'guide', ?, 3, 1, ?, ?)""",
        (dl_id, "a" * 64, TS, TS))
    cur.execute(
        """INSERT INTO service_downloadable_file
        (service_downloadable_id, label, filename, file_key, stored_filename,
         downloads, sort_order, created_at, updated_at)
        VALUES (?, 'Terms', 'r2c-terms.txt', 'terms', ?, 0, 2, ?, ?)""",
        (dl_id, "b" * 64, TS, TS))
    cur.execute(
        "INSERT INTO service_custom (client_id, plugin, config, created_at, updated_at)"
        " VALUES (1, 'r2c', ?, ?, ?)",
        ('{"plan":"r2c-pro"}', TS, TS))
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
            (product_id, title, svc_type, svc_id, TS, TS))
        ids[key] = cur.lastrowid
    d.commit()
    return ids


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

    def call(role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            return json.loads(resp.read().decode())

    try:
        payload = {"email": SUPER_EMAIL, "password": SUPER_PASS}
        if token:
            payload["CSRFToken"] = token
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed: {parsed}"
        for t in tables:
            cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
            snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
        seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()
        ids = craft(d)
        OUT.mkdir(exist_ok=True)
        cases = {}
        for key, oid in ids.items():
            cases[f"svc_{key}"] = call("admin", "order", "service", {"id": str(oid)})
        cases["svc_existing_custom"] = call("admin", "order", "service", {"id": "1"})
        cases["svc_no_service"] = call("admin", "order", "service", {"id": "4"})
        cases["svc_unknown_order"] = call("admin", "order", "service", {"id": "999999"})
        cases["prod_get_2"] = call("admin", "product", "get", {"id": "2"})
        cases["prod_get_9"] = call("admin", "product", "get", {"id": "9"})
        cases["prod_get_missing"] = call("admin", "product", "get", {"id": "999999"})
        cases["prod_list"] = call("admin", "product", "get_list", {"page": "1", "per_page": "50"})
        for name, env in cases.items():
            (OUT / f"{name}.json").write_text(json.dumps(env, indent=2, sort_keys=True) + "\n")
        print(f"capture30: {len(cases)} cases -> {OUT}")
    finally:
        restore()
        print("reference DB restored")


if __name__ == "__main__":
    main()
