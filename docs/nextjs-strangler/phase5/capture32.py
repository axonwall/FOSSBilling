#!/usr/bin/env python3
"""Phase 5 R2e capture: PHP-only oracle corpus for the system settings,
currency, and stats pages. Mirrors the parity29 case set on the PHP
stack (:8080) only. Full-DB snapshot/restore in a finally block, so
the reference DB is untouched afterwards (including the settings
table and any currency/extension rows the cases create).
"""
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
OUT = pathlib.Path(__file__).parent / "captures32"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"


def main():
    OUT.mkdir(exist_ok=True)
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

    def save(name, val):
        (OUT / f"{name}.json").write_text(json.dumps(val, indent=2, default=str))
        print("saved", name)

    try:
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^\"]+)"', page)
        token = m.group(1) if m else None
        payload = {"email": SUPER_EMAIL, "password": SUPER_PASS}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed: {parsed}"

        def call(role, module, method, data=None):
            payload = dict(data or {})
            if token:
                payload["CSRFToken"] = token
            body = urllib.parse.urlencode(payload).encode()
            req = urllib.request.Request(
                f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST")
            try:
                with op.open(req, timeout=60) as resp:
                    raw = resp.read()
            except urllib.error.HTTPError as e:
                raw = e.read()
            return json.loads(raw.decode())

        save("settings_get", call("admin", "system", "get_params"))
        save("currency_list", call("admin", "currency", "get_list", {"per_page": 100}))
        save("currency_default", call("admin", "currency", "get_default"))
        for method in ("get_summary_income", "get_income_vs_refunds", "get_product_summary",
                        "get_product_sales", "get_income", "get_refunds", "get_orders",
                        "get_clients", "get_invoices", "get_tickets",
                        "client_countries", "sales_countries"):
            params = {"limit": 10} if method.endswith("countries") else {}
            save(f"stats_{method}", call("admin", "stats", method, params))
        # Manual-only refresh: craft EUR manual, refresh, record rates.
        d.execute("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code)"
                  " VALUES (0, 0.9, 1, 'EUR')")
        d.commit()
        save("refresh_manual_before",
             call("admin", "currency", "get_list", {"per_page": 100}))
        save("refresh_manual_result", call("admin", "currency", "update_rates"))
        save("refresh_manual_after",
             call("admin", "currency", "get_list", {"per_page": 100}))
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # Keyed-provider-no-key refresh error. A non-manual currency
        # MUST be present or update_rates never fetches (default is
        # pinned, manual is skipped) and the case is vacuous.
        d.execute("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code)"
                  " VALUES (0, 1, 0, 'EUR')")
        d.commit()
        save("refresh_cfg_set", call("admin", "extension", "config_save",
                                     {"ext": "mod_currency", "provider": "currency_data_api"}))
        save("refresh_dataapi_nokey", call("admin", "currency", "update_rates"))
        save("refresh_cfg_clear", call("admin", "extension", "config_save",
                                       {"ext": "mod_currency"}))
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # Settings write + read-back.
        save("settings_write", call("admin", "system", "update_params",
                                    {"company_name": "R2e Test Co", "hide_company_public": "0"}))
        save("settings_write_readback", call("admin", "system", "get_params"))
    finally:
        restore()
        print("reference DB restored")


if __name__ == "__main__":
    main()
