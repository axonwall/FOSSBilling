#!/usr/bin/env python3
"""Phase 5 R1 decisions batch capture: PHP-only corpus for D1-D3.

D1 currency update_rates (provider switch, manual skip, default pin).
D2 system guest paginator + current_url, deleted-endpoint live answers,
   deferred-endpoint reads (writes stay proxied, so only reads captured).
D3 binary/download endpoints: export_csv x3 (bytes + headers),
   guest invoice payment (adapter forms) + pdf (bytes + headers),
   servicedownloadable upload/update/send_file x3 (bytes + headers).

Runs against live PHP only (:8080). The reference DB is snapshotted
up front and restored in a finally, including sqlite_sequence, and any
files created under data/uploads are removed afterwards. PHP runs with
workers enabled (PHP_CLI_SERVER_WORKERS=4) so security self-fetch
checks do not deadlock; this script does not call the security
run_check endpoints (deferred, covered by parity23's proxy cases).
"""
import json
import pathlib
import re
import sqlite3
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures27"
OUT.mkdir(exist_ok=True)
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
UPLOADS = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/data/uploads")
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"

TABLES = ["currency", "extension_meta", "setting", "session", "invoice",
          "invoice_item", "client", "client_order", "product",
          "service_downloadable", "service_downloadable_file", "pay_gateway",
          "email_queue", "admin", "transaction", "client_balance"]


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

    def opener():
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        page = op.open(f"{BASE}/login", timeout=20).read().decode("utf-8", "replace")
        return op, cj, page

    def csrf_token(cj, page):
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        if m:
            return m.group(1)
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value
        return None

    def flatten(obj, prefix=""):
        out = {}
        if isinstance(obj, dict):
            for k, v in obj.items():
                key = f"{prefix}[{k}]" if prefix else str(k)
                out.update(flatten(v, key))
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                out.update(flatten(item, f"{prefix}[{i}]"))
        else:
            out[prefix] = obj
        return out

    def call(op, cj, page, name, role, module, method, data=None, save=True):
        payload = flatten(dict(data or {}))
        token = csrf_token(cj, page)
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
                headers = dict(resp.headers.items())
        except urllib.error.HTTPError as e:
            raw = e.read()
            headers = dict(e.headers.items())
        try:
            parsed = json.loads(raw.decode())
            is_json = True
        except Exception:
            parsed = None
            is_json = False
        if save:
            if is_json:
                (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
            else:
                (OUT / f"{name}.bin").write_bytes(raw)
                (OUT / f"{name}.headers.json").write_text(json.dumps(headers, indent=2))
        if is_json:
            err = parsed.get("error") if isinstance(parsed, dict) else None
            print(("OK " if err is None else "ERR"), name, (err or {}).get("message", "") if err else "")
        else:
            print("BIN", name, len(raw), "bytes", headers.get("Content-Type"), headers.get("Content-Disposition"))
        return parsed, raw, headers

    def call_raw(op, cj, page, name, role, module, method, body, content_type):
        token = csrf_token(cj, page)
        if token and isinstance(body, dict):
            body = dict(body)
            body["CSRFToken"] = token
        if isinstance(body, dict):
            payload = urllib.parse.urlencode(flatten(body)).encode()
        else:
            payload = body
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=payload, method="POST")
        req.add_header("Content-Type", content_type)
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
                headers = dict(resp.headers.items())
        except urllib.error.HTTPError as e:
            raw = e.read()
            headers = dict(e.headers.items())
        try:
            parsed = json.loads(raw.decode())
            (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
            err = parsed.get("error") if isinstance(parsed, dict) else None
            print(("OK " if err is None else "ERR"), name, (err or {}).get("message", "") if err else "")
            return parsed, raw, headers
        except Exception:
            (OUT / f"{name}.bin").write_bytes(raw)
            (OUT / f"{name}.headers.json").write_text(json.dumps(headers, indent=2))
            print("BIN", name, len(raw), "bytes", headers.get("Content-Type"), headers.get("Content-Disposition"))
            return None, raw, headers

    def ins(sql, params=()):
        d.execute(sql, params)
        d.commit()
        return d.execute("SELECT last_insert_rowid()").fetchone()[0]

    def save_dump(name, rows, cols):
        out = [dict(zip(cols, r)) for r in rows]
        for row in out:
            if row.get("meta_key") == "config":
                row["meta_value"] = "<encrypted>"
        (OUT / f"{name}.json").write_text(json.dumps(out, indent=2, default=str))

    def cols_of(table):
        return [r[1] for r in d.execute(f'PRAGMA table_info("{table}")')]

    def login(op, cj, page, role_email, role_pass, module):
        return call(op, cj, page, f"tmp_login_{module}", "guest", module, "login",
                    {"email": role_email, "password": role_pass}, save=False)

    try:
        op_a, cj_a, page_a = opener()
        login(op_a, cj_a, page_a, ADMIN_EMAIL, ADMIN_PASS, "staff")
        op_c, cj_c, page_c = opener()
        login(op_c, cj_c, page_c, CLIENT_EMAIL, CLIENT_PASS, "client")
        op_n, cj_n, page_n = opener()

        # ---------- D1: currency update_rates ---------- #
        call(op_a, cj_a, page_a, "cur_rates_baseline", "admin", "currency", "update_rates")
        save_dump("cur_baseline_db", d.execute("SELECT * FROM currency ORDER BY id").fetchall(), cols_of("currency"))
        # EUR non-manual: exercises the live provider fetch (open er-api).
        ins("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code) VALUES (0, 1, 0, 'EUR')")
        call(op_a, cj_a, page_a, "cur_rates_eur_live", "admin", "currency", "update_rates")
        save_dump("cur_eur_live_db", d.execute("SELECT * FROM currency ORDER BY id").fetchall(), cols_of("currency"))
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # EUR manual: skipped, rate untouched.
        ins("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code) VALUES (0, 5.5, 1, 'EUR')")
        call(op_a, cj_a, page_a, "cur_rates_eur_manual", "admin", "currency", "update_rates")
        save_dump("cur_eur_manual_db", d.execute("SELECT * FROM currency ORDER BY id").fetchall(), cols_of("currency"))
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # Provider errors via the extension config API (encrypts + writes).
        # Sequential overwrites: no reset needed between cases, and no
        # mid-run snapshot restore (that would invalidate live sessions).
        # NOTE: a non-default, non-manual currency must exist or getRate is
        # never called and update_rates returns true vacuously.
        call(op_a, cj_a, page_a, "cur_cfg_set_layer", "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "currencylayer"})
        ins("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code) VALUES (0, 1, 0, 'EUR')")
        call(op_a, cj_a, page_a, "cur_rates_layer_nokey", "admin", "currency", "update_rates")
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        call(op_a, cj_a, page_a, "cur_cfg_set_dataapi", "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "currency_data_api"})
        ins("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code) VALUES (0, 1, 0, 'EUR')")
        call(op_a, cj_a, page_a, "cur_rates_dataapi_nokey", "admin", "currency", "update_rates")
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        call(op_a, cj_a, page_a, "cur_cfg_set_bogus", "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "bogus_provider"})
        ins("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code) VALUES (0, 1, 0, 'EUR')")
        call(op_a, cj_a, page_a, "cur_rates_bogus_provider", "admin", "currency", "update_rates")
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # Clear the currency config again so later cases see a clean slate.
        call(op_a, cj_a, page_a, "cur_cfg_clear", "admin", "extension", "config_save",
             {"ext": "mod_currency"})
        # No default currency at all.
        d.execute("UPDATE currency SET is_default = 0")
        d.commit()
        call(op_a, cj_a, page_a, "cur_rates_nodefault", "admin", "currency", "update_rates")
        d.execute("UPDATE currency SET is_default = 1 WHERE code = 'USD'")
        d.commit()
        call(op_n, cj_n, page_n, "cur_rates_noauth", "admin", "currency", "update_rates")

        # ---------- D2: system guest ports + reads ---------- #
        call(op_n, cj_n, page_n, "sys_pag_default", "guest", "system", "paginator")
        call(op_n, cj_n, page_n, "sys_pag_1", "guest", "system", "paginator",
             {"total": 100, "page": 1, "per_page": 20})
        call(op_n, cj_n, page_n, "sys_pag_2", "guest", "system", "paginator",
             {"total": 95, "page": 5, "per_page": 10})
        call(op_n, cj_n, page_n, "sys_pag_zero", "guest", "system", "paginator",
             {"total": 0, "page": 1, "per_page": 10})
        call(op_n, cj_n, page_n, "sys_pag_page0", "guest", "system", "paginator",
             {"total": 50, "page": 0, "per_page": 10})
        call(op_n, cj_n, page_n, "sys_pag_perpage0", "guest", "system", "paginator",
             {"total": 50, "page": 1, "per_page": 0})
        call(op_n, cj_n, page_n, "sys_pag_customparam", "guest", "system", "paginator",
             {"total": 100, "p": 3, "per_page": 10, "page_param": "p"})
        call(op_n, cj_n, page_n, "sys_pag_overflow", "guest", "system", "paginator",
             {"total": 30, "page": 99, "per_page": 10})

        def call_nocsrf(op, name, role, module, method, query=""):
            req = urllib.request.Request(
                f"{BASE}/api/{role}/{module}/{method}{query}", data=b"", method="POST")
            try:
                with op.open(req, timeout=60) as resp:
                    raw = resp.read()
            except urllib.error.HTTPError as e:
                raw = e.read()
            try:
                parsed = json.loads(raw.decode())
                (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
                print("OK", name, json.dumps(parsed)[:200])
            except Exception:
                (OUT / f"{name}.bin").write_bytes(raw)
                print("BIN", name, len(raw))

        call_nocsrf(op_n, "sys_url_plain", "guest", "system", "current_url")
        call_nocsrf(op_n, "sys_url_query", "guest", "system", "current_url", "?foo=bar&baz=2")
        call_nocsrf(op_n, "sys_url_admin", "guest", "system", "current_url")

        # Deleted endpoints: live PHP answers, for divergence documentation.
        # update_core / finalize / complete_finalization / manual_update are
        # NEVER called live: they mutate or download the install. Their
        # behavior is documented from source in findings-r1i.md.
        call(op_a, cj_a, page_a, "sys_del_update_available", "admin", "system", "update_available")
        call(op_a, cj_a, page_a, "sys_del_update_info", "admin", "system", "update_info")
        call(op_a, cj_a, page_a, "sys_del_recheck_update", "admin", "system", "recheck_update")
        call(op_a, cj_a, page_a, "sys_del_update_finalization_status", "admin", "system", "update_finalization_status")
        call(op_a, cj_a, page_a, "sys_del_is_behind", "admin", "system", "is_behind_on_patches")
        call(op_a, cj_a, page_a, "sys_del_cache_settings", "admin", "system", "cache_settings")
        call(op_a, cj_a, page_a, "sys_del_update_cache_bad_driver", "admin", "system", "update_cache_settings",
             {"driver": "bogus_driver_xyz"})
        call(op_a, cj_a, page_a, "sys_del_update_cache_filesystem", "admin", "system", "update_cache_settings",
             {"driver": "filesystem"})
        call(op_a, cj_a, page_a, "sys_del_clear_cache", "admin", "system", "clear_cache")
        call(op_a, cj_a, page_a, "sys_del_tpl_admin_ok", "admin", "system", "template_exists",
             {"file": "mod_index_dashboard.twig"})
        call(op_a, cj_a, page_a, "sys_del_tpl_admin_missing", "admin", "system", "template_exists",
             {"file": "no_such_template_xyz.twig"})
        call(op_n, cj_n, page_n, "sys_del_tpl_guest_ok", "guest", "system", "template_exists",
             {"file": "mod_index_login.twig"})
        call(op_n, cj_n, page_n, "sys_del_tpl_guest_missing", "guest", "system", "template_exists",
             {"file": "no_such_template_xyz.twig"})
        call(op_a, cj_a, page_a, "sys_del_env", "admin", "system", "env", {"ip": False})
        call(op_a, cj_a, page_a, "sys_del_env_ip", "admin", "system", "env", {"ip": True})
        call(op_a, cj_a, page_a, "sys_del_iface_ips", "admin", "system", "get_interface_ips")
        call(op_a, cj_a, page_a, "sys_del_messages", "admin", "system", "messages")
        call(op_a, cj_a, page_a, "sys_del_cas_messages", "admin", "system", "cas_messages")
        # Deferred-endpoint reads (writes stay proxied; reads prove the proxy path).
        call(op_a, cj_a, page_a, "sys_def_localization", "admin", "system", "localization_settings")
        call(op_a, cj_a, page_a, "sys_def_err_enabled", "admin", "system", "error_reporting_enabled")
        call(op_a, cj_a, page_a, "sys_def_err_last", "admin", "system", "last_error_reporting_change")
        call(op_a, cj_a, page_a, "sys_def_instance", "admin", "system", "instance_id")
        call(op_a, cj_a, page_a, "sys_def_is_allowed", "admin", "system", "is_allowed",
             {"mod": "system", "f": "env"})
        call(op_a, cj_a, page_a, "sys_def_is_allowed_staff", "admin", "system", "is_allowed",
             {"mod": "staff", "f": "get_list"})

        # ---------- D3: export_csv x3 (bytes + headers) ---------- #
        call(op_a, cj_a, page_a, "csv_client_default", "admin", "client", "export_csv")
        call(op_a, cj_a, page_a, "csv_client_subset", "admin", "client", "export_csv",
             {"headers": ["id", "email", "first_name"]})
        call(op_a, cj_a, page_a, "csv_client_sensitive", "admin", "client", "export_csv",
             {"headers": ["id", "pass", "salt", "api_token", "email"]})
        call(op_a, cj_a, page_a, "csv_client_nosuch", "admin", "client", "export_csv",
             {"headers": ["nosuchcol"]})
        call(op_a, cj_a, page_a, "csv_invoice_default", "admin", "invoice", "export_csv")
        call(op_a, cj_a, page_a, "csv_invoice_subset", "admin", "invoice", "export_csv",
             {"headers": ["id", "nr", "status"]})
        call(op_a, cj_a, page_a, "csv_invoice_sensitive", "admin", "invoice", "export_csv",
             {"headers": ["id", "hash", "config", "nr"]})
        call(op_a, cj_a, page_a, "csv_order_default", "admin", "order", "export_csv")
        call(op_a, cj_a, page_a, "csv_order_subset", "admin", "order", "export_csv",
             {"headers": ["id", "title", "status"]})
        call(op_a, cj_a, page_a, "csv_order_sensitive", "admin", "order", "export_csv",
             {"headers": ["id", "config", "title"]})

        # ---------- D3: guest invoice payment + pdf ---------- #
        def clone_row(table, src_id, overrides):
            row = d.execute(f'SELECT * FROM "{table}" WHERE id = ?', (src_id,)).fetchone()
            cols = cols_of(table)
            data = dict(zip(cols, row))
            data.pop("id", None)
            data.update(overrides)
            keys = list(data.keys())
            d.execute(f'INSERT INTO "{table}" (' + ",".join(keys) + ") VALUES (" + ",".join("?" * len(keys)) + ")",
                      [data[k] for k in keys])
            d.commit()
            return d.execute("SELECT last_insert_rowid()").fetchone()[0]

        inv1 = dict(zip(cols_of("invoice"), d.execute("SELECT * FROM invoice WHERE id = 1").fetchone()))
        item1 = dict(zip(cols_of("invoice_item"),
                         d.execute("SELECT * FROM invoice_item WHERE invoice_id = 1 ORDER BY id LIMIT 1").fetchone()))
        HEX40 = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"
        HEX41 = "cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34"

        def make_invoice(nr, hashv, status, expires, gateway=None):
            inv_id = clone_row("invoice", 1, {"serie": "FOSS", "nr": nr, "hash": hashv,
                                              "hash_expires_at": expires, "status": status,
                                              "gateway_id": gateway, "paid_at": None,
                                              "created_at": "2026-10-26 12:00:00",
                                              "updated_at": "2026-10-26 12:00:00"})
            clone_row("invoice_item", item1["id"], {"invoice_id": inv_id, "title": "Capture Widget",
                                                    "price": 25, "quantity": 1, "period": None,
                                                    "taxed": 0})
            return inv_id

        def make_sub_invoice(nr, hashv):
            inv_id = clone_row("invoice", 1, {"serie": "FOSS", "nr": nr, "hash": hashv,
                                              "hash_expires_at": "2030-01-01 00:00:00", "status": "unpaid",
                                              "gateway_id": None, "paid_at": None,
                                              "created_at": "2026-10-26 12:00:00",
                                              "updated_at": "2026-10-26 12:00:00"})
            clone_row("invoice_item", item1["id"], {"invoice_id": inv_id, "title": "Capture Recurring",
                                                    "price": 15, "quantity": 1, "period": "1M",
                                                    "taxed": 0})
            return inv_id

        unpaid_hash = HEX40
        make_invoice(9001, unpaid_hash, "unpaid", "2030-01-01 00:00:00")
        canceled_hash = HEX41
        make_invoice(9002, canceled_hash, "canceled", "2030-01-01 00:00:00")
        expired_hash = "ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56"
        make_invoice(9003, expired_hash, "unpaid", "2020-01-01 00:00:00")
        sub_hash = "12ab34cd56ef12ab34cd56ef12ab34cd56ef12ab"
        make_sub_invoice(9004, sub_hash)
        disabled_gw = ins("INSERT INTO pay_gateway (gateway, name, enabled, test_mode, allow_single, allow_recurrent, config) VALUES ('Custom', 'Disabled GW', 0, 0, 1, 1, '{}')")
        single_off_gw = ins("INSERT INTO pay_gateway (gateway, name, enabled, test_mode, allow_single, allow_recurrent, config) VALUES ('Custom', 'Single Off GW', 1, 0, 0, 1, '{}')")

        call(op_n, cj_n, page_n, "pay_nohash", "guest", "invoice", "payment")
        call(op_n, cj_n, page_n, "pay_badhash", "guest", "invoice", "payment",
             {"hash": "xyz", "gateway_id": 1})
        call(op_n, cj_n, page_n, "pay_nogateway", "guest", "invoice", "payment",
             {"hash": unpaid_hash})
        call(op_n, cj_n, page_n, "pay_unknown_invoice", "guest", "invoice", "payment",
             {"hash": "e" * 40, "gateway_id": 1})
        # Deeper checks (canceled/paid/gateway) run AFTER checkInvoiceAuth,
        # so they need the owner (client) session, not the guest opener.
        call(op_c, cj_c, page_c, "pay_canceled", "guest", "invoice", "payment",
             {"hash": canceled_hash, "gateway_id": 1})
        call(op_c, cj_c, page_c, "pay_paid", "guest", "invoice", "payment",
             {"hash": inv1["hash"], "gateway_id": 1})
        call(op_c, cj_c, page_c, "pay_unknown_gw", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": 999})
        call(op_c, cj_c, page_c, "pay_disabled_gw", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": disabled_gw})
        call(op_c, cj_c, page_c, "pay_single_off", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": single_off_gw})
        call(op_n, cj_n, page_n, "pay_guest_perm", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": 1})
        call(op_n, cj_n, page_n, "pay_expired", "guest", "invoice", "payment",
             {"hash": expired_hash, "gateway_id": 1})
        call(op_c, cj_c, page_c, "pay_custom", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": 1})
        call(op_c, cj_c, page_c, "pay_paypal", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": 2})
        call(op_c, cj_c, page_c, "pay_stripe", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": 3})
        call(op_c, cj_c, page_c, "pay_sub_custom", "guest", "invoice", "payment",
             {"hash": sub_hash, "gateway_id": 1, "subscribe": 1})
        call(op_c, cj_c, page_c, "pay_sub_paypal", "guest", "invoice", "payment",
             {"hash": sub_hash, "gateway_id": 2, "subscribe": 1})
        call(op_c, cj_c, page_c, "pay_sub_stripe", "guest", "invoice", "payment",
             {"hash": sub_hash, "gateway_id": 3, "subscribe": 1})
        call(op_a, cj_a, page_a, "pay_admin_custom", "guest", "invoice", "payment",
             {"hash": unpaid_hash, "gateway_id": 1})

        call(op_n, cj_n, page_n, "pdf_badhash", "guest", "invoice", "pdf", {"hash": "xyz"})
        call(op_n, cj_n, page_n, "pdf_unknown", "guest", "invoice", "pdf", {"hash": "e" * 40})
        call(op_n, cj_n, page_n, "pdf_guest_perm", "guest", "invoice", "pdf", {"hash": unpaid_hash})
        call(op_n, cj_n, page_n, "pdf_expired", "guest", "invoice", "pdf", {"hash": expired_hash})
        call(op_c, cj_c, page_c, "pdf_client", "guest", "invoice", "pdf", {"hash": unpaid_hash})
        call(op_a, cj_a, page_a, "pdf_admin", "guest", "invoice", "pdf", {"hash": unpaid_hash})

        # ---------- D3: servicedownloadable binary endpoints ---------- #
        def multipart(fields, file_field=None, file_name=None, file_bytes=None, file_type="text/plain"):
            boundary = "----cap27boundary1234"
            out = bytearray()
            for k, v in fields.items():
                out += f"--{boundary}\r\n".encode()
                out += f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode()
                out += f"{v}\r\n".encode()
            if file_field is not None:
                out += f"--{boundary}\r\n".encode()
                out += (f'Content-Disposition: form-data; name="{file_field}"; '
                        f'filename="{file_name}"\r\n').encode()
                out += f"Content-Type: {file_type}\r\n\r\n".encode()
                out += file_bytes + b"\r\n"
            out += f"--{boundary}--\r\n".encode()
            return bytes(out), f"multipart/form-data; boundary={boundary}"

        def call_multipart(op, cj, page, name, role, module, method, fields, file_field=None,
                           file_name=None, file_bytes=None, file_type="text/plain"):
            fields = dict(fields)
            token = csrf_token(cj, page)
            if token:
                fields["CSRFToken"] = token
            body, ctype = multipart(fields, file_field, file_name, file_bytes, file_type)
            parsed, raw, headers = call_raw(op, cj, page, name, role, module, method, body, ctype)
            return parsed, raw, headers

        # Product-level send setup: product 2 config with one live + one missing file.
        prod2 = dict(zip(cols_of("product"), d.execute("SELECT * FROM product WHERE id = 2").fetchone()))
        prod_cfg = {"files": [
            {"id": "aa" * 16, "filename": "manual.txt", "stored_filename": "b" * 64,
             "label": "Manual", "description": "Docs"},
            {"id": "cc" * 16, "filename": "ghost.txt", "stored_filename": "d" * 64,
             "label": "Ghost", "description": None}]}
        d.execute("UPDATE product SET config = ? WHERE id = 2", (json.dumps(prod_cfg),))
        d.commit()
        (UPLOADS / ("b" * 64)).write_bytes(b"MANUAL-CONTENT\n")
        call(op_a, cj_a, page_a, "dl_prod_send", "admin", "servicedownloadable", "send_file",
             {"id": 2, "file_id": "aa" * 16})
        call(op_a, cj_a, page_a, "dl_prod_send_badkey", "admin", "servicedownloadable", "send_file",
             {"id": 2, "file_id": "ee" * 16})
        call(op_a, cj_a, page_a, "dl_prod_send_badformat", "admin", "servicedownloadable", "send_file",
             {"id": 2, "file_id": "xyz"})
        call(op_a, cj_a, page_a, "dl_prod_send_missingdisk", "admin", "servicedownloadable", "send_file",
             {"id": 2, "file_id": "cc" * 16})
        call(op_a, cj_a, page_a, "dl_prod_send_unknownprod", "admin", "servicedownloadable", "send_file",
             {"id": 999, "file_id": "aa" * 16})

        # Order-level setup: service + service file + order config.
        svc_id = ins("INSERT INTO service_downloadable (client_id, created_at, updated_at) VALUES (1, '2026-10-26 12:00:00', '2026-10-26 12:00:00')")
        sfile_id = ins("INSERT INTO service_downloadable_file (label, description, downloads, sort_order, file_key, filename, stored_filename, created_at, updated_at, service_downloadable_id) VALUES ('Order Guide', 'Guide', 0, 0, ?, 'order-guide.txt', ?, '2026-10-26 12:00:00', '2026-10-26 12:00:00', ?)",
                       ("ff" * 16, "1" * 64, svc_id))
        (UPLOADS / ("1" * 64)).write_bytes(b"ORDER-GUIDE-CONTENT\n")
        order_cfg = {"files": [{"id": "ff" * 16, "filename": "order-guide.txt",
                                "stored_filename": "1" * 64, "label": "Order Guide",
                                "description": "Guide"}]}
        order_id = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": svc_id,
                                                 "service_type": "downloadable", "status": "active",
                                                 "expires_at": None, "config": json.dumps(order_cfg)})
        call(op_a, cj_a, page_a, "dl_order_send", "admin", "servicedownloadable", "send_order_file",
             {"order_id": order_id, "file_id": sfile_id})
        save_dump("dl_order_send_db", d.execute(
            "SELECT * FROM service_downloadable_file WHERE id = ?", (sfile_id,)).fetchall(),
            cols_of("service_downloadable_file"))
        call(op_a, cj_a, page_a, "dl_order_send_badfile", "admin", "servicedownloadable", "send_order_file",
             {"order_id": order_id, "file_id": 99999})
        call(op_a, cj_a, page_a, "dl_order_send_unknownorder", "admin", "servicedownloadable", "send_order_file",
             {"order_id": 99999, "file_id": sfile_id})
        notact_order = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": 1,
                                                     "service_type": "custom", "status": "active",
                                                     "config": "{}"})
        call(op_a, cj_a, page_a, "dl_order_send_notactivated", "admin", "servicedownloadable", "send_order_file",
             {"order_id": notact_order, "file_id": sfile_id})
        call(op_c, cj_c, page_c, "dl_client_send", "client", "servicedownloadable", "send_file",
             {"order_id": order_id, "file_id": sfile_id})
        save_dump("dl_client_send_db", d.execute(
            "SELECT * FROM service_downloadable_file WHERE id = ?", (sfile_id,)).fetchall(),
            cols_of("service_downloadable_file"))
        nonowner_order = clone_row("client_order", 1, {"client_id": 2, "product_id": 2, "service_id": svc_id,
                                                       "service_type": "downloadable", "status": "active",
                                                       "expires_at": None, "config": json.dumps(order_cfg)})
        call(op_c, cj_c, page_c, "dl_client_send_nonowner", "client", "servicedownloadable", "send_file",
             {"order_id": nonowner_order, "file_id": sfile_id})
        pending_order = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": svc_id,
                                                      "service_type": "downloadable", "status": "pending_setup",
                                                      "expires_at": None, "config": json.dumps(order_cfg)})
        call(op_c, cj_c, page_c, "dl_client_send_notactive", "client", "servicedownloadable", "send_file",
             {"order_id": pending_order, "file_id": sfile_id})
        expired_order = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": svc_id,
                                                      "service_type": "downloadable", "status": "active",
                                                      "expires_at": "2020-01-01 00:00:00",
                                                      "config": json.dumps(order_cfg)})
        call(op_c, cj_c, page_c, "dl_client_send_expired", "client", "servicedownloadable", "send_file",
             {"order_id": expired_order, "file_id": sfile_id})

        # Upload / update (multipart in).
        before_files = set(p.name for p in UPLOADS.iterdir())
        call_multipart(op_a, cj_a, page_a, "dl_upload_ok", "admin", "servicedownloadable", "upload",
                       {"id": 2, "label": "Notes", "description": "Release notes"},
                       "file_data", "notes.txt", b"hello downloadable\n")
        new_files = set(p.name for p in UPLOADS.iterdir()) - before_files
        for fn in sorted(new_files):
            (OUT / f"dl_upload_stored_{fn[:8]}.bin").write_bytes((UPLOADS / fn).read_bytes())
        save_dump("dl_upload_ok_db", d.execute("SELECT config FROM product WHERE id = 2").fetchall(), ["config"])
        call_multipart(op_a, cj_a, page_a, "dl_upload_badext", "admin", "servicedownloadable", "upload",
                       {"id": 2}, "file_data", "evil.php", b"<?php echo 1;")
        call_multipart(op_a, cj_a, page_a, "dl_upload_nofile", "admin", "servicedownloadable", "upload",
                       {"id": 2})
        call_multipart(op_a, cj_a, page_a, "dl_upload_unknownprod", "admin", "servicedownloadable", "upload",
                       {"id": 999}, "file_data", "notes.txt", b"hello downloadable\n")
        call_multipart(op_a, cj_a, page_a, "dl_update_ok", "admin", "servicedownloadable", "update",
                       {"order_id": order_id, "label": "Revised Guide", "description": "v2"},
                       "file_data", "guide-v2.txt", b"GUIDE-V2-CONTENT\n")
        save_dump("dl_update_ok_db", d.execute(
            "SELECT config FROM client_order WHERE id = ?", (order_id,)).fetchall(), ["config"])
        save_dump("dl_update_ok_files", d.execute(
            "SELECT * FROM service_downloadable_file WHERE service_downloadable_id = ? ORDER BY id",
            (svc_id,)).fetchall(), cols_of("service_downloadable_file"))
        call_multipart(op_a, cj_a, page_a, "dl_update_unknownorder", "admin", "servicedownloadable", "update",
                       {"order_id": 99999}, "file_data", "x.txt", b"x\n")
        call_multipart(op_a, cj_a, page_a, "dl_update_notactivated", "admin", "servicedownloadable", "update",
                       {"order_id": notact_order}, "file_data", "x.txt", b"x\n")
        call_multipart(op_a, cj_a, page_a, "dl_update_nofile", "admin", "servicedownloadable", "update",
                       {"order_id": order_id})
    finally:
        restore()
        print("RESTORED reference DB + uploads")

if __name__ == "__main__":
    main()
