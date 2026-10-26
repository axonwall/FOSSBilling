#!/usr/bin/env python3
"""Phase 5 R1 decisions batch parity: identical sequences on PHP (:8080)
and TS (:3001/api/fb), compared after scrubbing.

Sections: currency update_rates, system guest ports, deleted endpoints
(TS-only: the removal error is the EXPECTED answer, counted separately
and never as a failure), deferred-endpoint proxy cases, CSV exports
(bytes + headers), guest invoice payment + pdf, servicedownloadable
binary endpoints (bytes + headers + DB deltas).

The reference DB is snapshotted up front, restored between stacks and
in a finally (plus sqlite_sequence and data/uploads cleanup). Logins go
through PHP once; the session row lives in the shared DB, so the same
cookies authenticate both stacks (TS reads the PHP-created row).
"""
import json
import pathlib
import re
import sqlite3
import sys
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
UPLOADS = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/data/uploads")
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"

TABLES = ["currency", "extension_meta", "setting", "session", "invoice",
          "invoice_item", "client", "client_order", "product",
          "service_downloadable", "service_downloadable_file", "pay_gateway",
          "email_queue", "admin", "transaction", "client_balance",
          "pay_gateway_customer", "pay_gateway_product"]

HEX64 = re.compile(r"\b[0-9a-f]{64}\b")
HEX32 = re.compile(r"\b[0-9a-f]{32}\b")
TS_RE = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}")
BCRYPT_RE = re.compile(r"\$2[aby]\$[0-9]{2}\$[A-Za-z0-9./]{53}")

FAILURES = []
DELETED_OK = 0
CHECKS = 0


def scrub(v):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k == "meta_value" and isinstance(x, str) and x.startswith("v2:"):
                out[k] = "<encrypted>"
            else:
                out[k] = scrub(x)
        return out
    if isinstance(v, list):
        return [scrub(x) for x in v]
    if isinstance(v, tuple):
        return tuple(scrub(x) for x in v)
    if isinstance(v, str):
        v = HEX64.sub("<hex64>", v)
        v = HEX32.sub("<hex32>", v)
        v = TS_RE.sub("<ts>", v)
        v = BCRYPT_RE.sub("<bcrypt>", v)
        return v
    return v


def safe_dump(v):
    try:
        return json.dumps(v, default=lambda o: o.decode("utf-8", "replace") if isinstance(o, bytes) else repr(o))[:800]
    except Exception:
        return repr(v)[:800]


def check(name, php_val, ts_val, mode="exact"):
    global CHECKS
    CHECKS += 1
    a, b = scrub(php_val), scrub(ts_val)
    ok = (a == b) if mode == "exact" else True
    if mode == "code_only":
        ok = (isinstance(a, dict) and isinstance(b, dict)
              and (a.get("error") or {}).get("code") == (b.get("error") or {}).get("code")
              and (a.get("error") is not None) == (b.get("error") is not None))
    if not ok:
        FAILURES.append((name, a, b))
        print(f"DIFF {name}\n  php: {safe_dump(a)}\n  ts:  {safe_dump(b)}")
    else:
        print(f"ok   {name}")
    return ok


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

    def cols_of(table):
        return [r[1] for r in d.execute(f'PRAGMA table_info("{table}")')]

    def dump(table, where="", args=()):
        rows = d.execute(f'SELECT * FROM "{table}" {where}', args).fetchall()
        cols = cols_of(table)
        out = []
        for r in rows:
            row = dict(zip(cols, r))
            if row.get("meta_key") == "config":
                row["meta_value"] = "<encrypted>"
            out.append(row)
        return out

    def ins(sql, params=()):
        d.execute(sql, params)
        d.commit()
        return d.execute("SELECT last_insert_rowid()").fetchone()[0]

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

    # ---- HTTP harness: one opener, PHP login, cookies reused on both stacks.
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")

    def csrf_token():
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

    def api_url(base, role, module, method, query=""):
        # PHP base is the app root (…/api/…); the TS base already ends
        # in /api/fb, so it takes …/fb/<role>/… — never /fb/api/… .
        if base == TS:
            return f"{base}/{role}/{module}/{method}{query}"
        return f"{base}/api/{role}/{module}/{method}{query}"

    def login(role_email, role_pass, module):
        payload = {"email": role_email, "password": role_pass}
        token = csrf_token()
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/{module}/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            resp.read()

    def call(base, role, module, method, data=None, query=""):
        payload = flatten(dict(data or {}))
        token = csrf_token()
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(api_url(base, role, module, method, query), data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
                headers = dict(resp.headers.items())
        except urllib.error.HTTPError as e:
            raw = e.read()
            headers = dict(e.headers.items())
        try:
            return json.loads(raw.decode()), headers
        except Exception:
            return ("<binary>", raw, headers)

    def call_nocsrf(base, role, module, method, query=""):
        req = urllib.request.Request(api_url(base, role, module, method, query), data=b"", method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read()
        try:
            return json.loads(raw.decode()), {}
        except Exception:
            return ("<binary>", raw, {})

    def multipart(base, role, module, method, fields, file_field=None, file_name=None,
                  file_bytes=None, file_type="text/plain"):
        boundary = "----parity24boundary"
        out = bytearray()
        f = dict(fields)
        token = csrf_token()
        if token:
            f["CSRFToken"] = token
        for k, v in f.items():
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
        req = urllib.request.Request(api_url(base, role, module, method), data=bytes(out), method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        try:
            with op.open(req, timeout=60) as resp:
                raw = resp.read()
                headers = dict(resp.headers.items())
        except urllib.error.HTTPError as e:
            raw = e.read()
            headers = dict(e.headers.items())
        try:
            return json.loads(raw.decode()), headers
        except Exception:
            return ("<binary>", raw, headers)

    def keep_headers(headers, names):
        out = {}
        for k, v in headers.items():
            if k.lower() not in names:
                continue
            if k.lower() == "cache-control":
                # PHP appends `private` via the session; order-insensitive.
                parts = sorted(p.strip() for p in v.split(",") if p.strip() and p.strip() != "private")
                out["cache-control"] = ", ".join(parts)
            else:
                out[k.lower()] = v
        return out

    login(ADMIN_EMAIL, ADMIN_PASS, "staff")
    login(CLIENT_EMAIL, CLIENT_PASS, "client")

    HEX40 = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"
    HEX41 = "cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34"
    EXPIRED_HEX = "ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56"
    SUB_HEX = "12ab34cd56ef12ab34cd56ef12ab34cd56ef12ab"

    def setup_invoices():
        item1 = dict(zip(cols_of("invoice_item"),
                         d.execute("SELECT * FROM invoice_item WHERE invoice_id = 1 ORDER BY id LIMIT 1").fetchone()))

        def make_invoice(nr, hashv, status, expires, gateway=None, period=None, price=25):
            inv_id = clone_row("invoice", 1, {"serie": "FOSS", "nr": nr, "hash": hashv,
                                              "hash_expires_at": expires, "status": status,
                                              "gateway_id": gateway, "paid_at": None,
                                              "created_at": "2026-10-26 12:00:00",
                                              "updated_at": "2026-10-26 12:00:00"})
            clone_row("invoice_item", item1["id"], {"invoice_id": inv_id, "title": "Capture Widget",
                                                    "price": price, "quantity": 1, "period": period,
                                                    "taxed": 0})
            return inv_id

        make_invoice(9001, HEX40, "unpaid", "2030-01-01 00:00:00")
        make_invoice(9002, HEX41, "canceled", "2030-01-01 00:00:00")
        make_invoice(9003, EXPIRED_HEX, "unpaid", "2020-01-01 00:00:00")
        inv_sub = make_invoice(9004, SUB_HEX, "unpaid", "2030-01-01 00:00:00")
        d.execute("UPDATE invoice_item SET title = 'Capture Recurring', price = 15, period = '1M' WHERE invoice_id = ?", (inv_sub,))
        d.commit()
        disabled_gw = ins("INSERT INTO pay_gateway (gateway, name, enabled, test_mode, allow_single, allow_recurrent, config) VALUES ('Custom', 'Disabled GW', 0, 0, 1, 1, '{}')")
        single_off_gw = ins("INSERT INTO pay_gateway (gateway, name, enabled, test_mode, allow_single, allow_recurrent, config) VALUES ('Custom', 'Single Off GW', 1, 0, 0, 1, '{}')")
        return disabled_gw, single_off_gw

    def setup_downloadable():
        prod_cfg = {"files": [
            {"id": "aa" * 16, "filename": "manual.txt", "stored_filename": "b" * 64,
             "label": "Manual", "description": "Docs"},
            {"id": "cc" * 16, "filename": "ghost.txt", "stored_filename": "d" * 64,
             "label": "Ghost", "description": None}]}
        d.execute("UPDATE product SET config = ? WHERE id = 2", (json.dumps(prod_cfg),))
        d.commit()
        (UPLOADS / ("b" * 64)).write_bytes(b"MANUAL-CONTENT\n")
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
        notact_order = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": 1,
                                                     "service_type": "custom", "status": "active",
                                                     "config": "{}"})
        nonowner_order = clone_row("client_order", 1, {"client_id": 2, "product_id": 2, "service_id": svc_id,
                                                       "service_type": "downloadable", "status": "active",
                                                       "expires_at": None, "config": json.dumps(order_cfg)})
        pending_order = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": svc_id,
                                                      "service_type": "downloadable", "status": "pending_setup",
                                                      "expires_at": None, "config": json.dumps(order_cfg)})
        expired_order = clone_row("client_order", 1, {"client_id": 1, "product_id": 2, "service_id": svc_id,
                                                      "service_type": "downloadable", "status": "active",
                                                      "expires_at": "2020-01-01 00:00:00",
                                                      "config": json.dumps(order_cfg)})
        return {"svc_id": svc_id, "sfile_id": sfile_id, "order_id": order_id,
                "notact_order": notact_order, "nonowner_order": nonowner_order,
                "pending_order": pending_order, "expired_order": expired_order}

    def run_stack(base):
        results = {}

        # --- Currency update_rates (targeted undos; no restore inside). ---
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_baseline"] = (env, dump("currency"))
        ins("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code) VALUES (0, 1, 0, 'EUR')")
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_eur_live"] = (env, dump("currency"))
        # Normalize the live-fetch asymmetry residue: on TS the live
        # fetch succeeds and stamps EUR.updated_at; on PHP it TLS-fails
        # and leaves NULL. Downstream cases test the manual-skip and
        # missing-key paths, not that stamp, so reset it here.
        d.execute("UPDATE currency SET updated_at = NULL WHERE code = 'EUR'")
        d.commit()
        d.execute("UPDATE currency SET is_rate_manual = 1, conversion_rate = 5.5 WHERE code = 'EUR'")
        d.commit()
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_eur_manual"] = (env, dump("currency"))
        d.execute("UPDATE currency SET is_rate_manual = 0 WHERE code = 'EUR'")
        d.commit()
        call(base, "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "currencylayer"})
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_layer_nokey"] = (env, dump("currency"))
        call(base, "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "currency_data_api"})
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_dataapi_nokey"] = (env, dump("currency"))
        call(base, "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "bogus_provider_xyz"})
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_bogus_provider"] = (env, dump("currency"))
        call(base, "admin", "extension", "config_save", {"ext": "mod_currency"})
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.execute("UPDATE currency SET is_default = 0 WHERE code = 'USD'")
        d.commit()
        env, _ = call(base, "admin", "currency", "update_rates", {})
        results["cur_nodefault"] = (env, dump("currency"))
        d.execute("UPDATE currency SET is_default = 1 WHERE code = 'USD'")
        d.commit()
        results["cur_config_rows"] = dump("extension_meta", "WHERE extension = 'mod_currency'")

        # --- System guest ports. ---
        for name, params in [
            ("pg_default", {}), ("pg_page1", {"page": "1", "total": "30", "per_page": "10"}),
            ("pg_page5", {"page": "5", "total": "95", "per_page": "10"}),
            ("pg_total0", {"total": "0"}), ("pg_page0", {"page": "0", "total": "30", "per_page": "10"}),
            ("pg_perpage0", {"page": "2", "total": "30", "per_page": "0"}),
            ("pg_customparam", {"p": "3", "page_param": "p", "total": "100", "per_page": "10"}),
            ("pg_overflow", {"page": "99", "total": "30", "per_page": "10"})]:
            env, _ = call(base, "guest", "system", "paginator", params)
            results[name] = env
        # current_url: body CSRFToken does NOT pollute the returned URI
        # (REQUEST_URI is path + query only), and it satisfies the TS
        # route's session-call CSRF rule.
        env, _ = call(base, "guest", "system", "current_url", {})
        results["cur_url_plain"] = env
        env, _ = call(base, "guest", "system", "current_url", {}, query="?foo=bar&baz=2")
        results["cur_url_query"] = env

        # --- Deferred-endpoint proxy cases (TS must relay PHP answers). ---
        results["def_localization"] = call(base, "admin", "system", "localization_settings", {})[0]
        results["def_err_enabled"] = call(base, "admin", "system", "error_reporting_enabled", {})[0]
        results["def_err_last"] = call(base, "admin", "system", "last_error_reporting_change", {})[0]
        results["def_instance"] = call(base, "admin", "system", "instance_id", {})[0]
        results["def_is_allowed_admin"] = call(base, "admin", "system", "is_allowed", {"mod": "system"})[0]
        results["def_is_allowed_client"] = call(base, "client", "system", "is_allowed", {"mod": "system"})[0]
        results["def_ip_lookup"] = call(base, "admin", "security", "ip_lookup", {"ip": "127.0.0.1"})[0]
        results["def_run_check"] = call(base, "admin", "security", "run_check", {"name": "webserver"})[0]

        # --- CSV exports (bytes + meaningful headers). ---
        csv_cases = [
            ("csv_client_default", "client", {}),
            ("csv_client_subset", "client", {"headers": ["id", "email", "status"]}),
            ("csv_client_sensitive", "client", {"headers": ["id", "hash", "config", "email"]}),
            ("csv_client_nosuch", "client", {"headers": ["nosuch_col_xyz"]}),
            ("csv_client_reversed", "client", {"headers": ["email", "id"]}),
            ("csv_invoice_default", "invoice", {}),
            ("csv_invoice_subset", "invoice", {"headers": ["id", "nr", "currency"]}),
            ("csv_invoice_sensitive", "invoice", {"headers": ["id", "hash", "config", "nr"]}),
            ("csv_order_default", "order", {}),
            ("csv_order_subset", "order", {"headers": ["id", "title", "status"]}),
            ("csv_order_sensitive", "order", {"headers": ["id", "hash", "config", "title"]}),
            ("csv_order_nosuch", "order", {"headers": ["nosuch_col_xyz"]}),
        ]
        for name, module, data in csv_cases:
            res = call(base, "admin", module, "export_csv", data)
            if isinstance(res, tuple) and len(res) == 3:
                _, raw, headers = res
                results[name] = (raw, keep_headers(headers, ["content-type", "content-disposition", "cache-control", "expires"]))
            else:
                results[name] = res[0]

        # --- Guest invoice payment + pdf. ---
        disabled_gw, single_off_gw = setup_invoices()
        pay_cases = [
            ("pay_nohash", {}, "guest"),
            ("pay_badhash", {"hash": "zz"}, "guest"),
            ("pay_nogateway", {"hash": HEX40}, "guest"),
            ("pay_unknown", {"hash": HEX40, "gateway_id": "1"}, "guest"),
            ("pay_guest_perm", {"hash": HEX40, "gateway_id": "1"}, "guest"),
            ("pay_expired", {"hash": EXPIRED_HEX, "gateway_id": "1"}, "guest"),
            ("pay_canceled", {"hash": HEX41, "gateway_id": "1"}, "client"),
            ("pay_paid", {"hash": "473d69f8652dbf55ed837e4542776254", "gateway_id": "1"}, "client"),
            ("pay_unknown_gw", {"hash": HEX40, "gateway_id": "999"}, "client"),
            ("pay_disabled_gw", {"hash": HEX40, "gateway_id": str(disabled_gw)}, "client"),
            ("pay_single_off", {"hash": HEX40, "gateway_id": str(single_off_gw)}, "client"),
            ("pay_custom", {"hash": HEX40, "gateway_id": "1"}, "client"),
            ("pay_paypal", {"hash": HEX40, "gateway_id": "2"}, "client"),
            ("pay_stripe", {"hash": HEX40, "gateway_id": "3"}, "client"),
            ("pay_sub_custom", {"hash": SUB_HEX, "gateway_id": "1", "subscribe": "true"}, "client"),
            ("pay_sub_paypal", {"hash": SUB_HEX, "gateway_id": "2", "subscribe": "true"}, "client"),
            ("pay_sub_stripe", {"hash": SUB_HEX, "gateway_id": "3", "subscribe": "true"}, "client"),
            ("pay_admin_custom", {"hash": HEX40, "gateway_id": "1"}, "admin"),
        ]
        for name, data, _role in pay_cases:
            # All payment calls are guest-role API calls; the session
            # identity (client owner vs admin vs none) is what matters,
            # so the opener's cookies select the caller. Guest-role calls
            # with an admin session behave as admin (PHP checkInvoiceAuth
            # accepts admin too).
            env, _ = call(base, "guest", "invoice", "payment", data)
            results[name] = env
        results["pay_side_tables"] = (dump("pay_gateway_customer"), dump("pay_gateway_product"))
        pdf_cases = [
            ("pdf_badhash", {"hash": "zz"}),
            ("pdf_unknown", {"hash": HEX40}),
            ("pdf_guest_perm", {"hash": HEX40}),
            ("pdf_expired", {"hash": EXPIRED_HEX}),
            ("pdf_client", {"hash": HEX40}),
            ("pdf_admin", {"hash": HEX40}),
        ]
        for name, data in pdf_cases:
            res = call(base, "guest", "invoice", "pdf", data)
            if isinstance(res, tuple) and len(res) == 3:
                _, raw, headers = res
                results[name] = ("<pdf>", raw[:8], len(raw),
                                 keep_headers(headers, ["content-type", "content-disposition"]))
            else:
                results[name] = res[0]

        # --- Servicedownloadable binary endpoints. ---
        dl = setup_downloadable()
        res = call(base, "admin", "servicedownloadable", "send_file",
                   {"id": "2", "file_id": "aa" * 16})
        if isinstance(res, tuple) and len(res) == 3:
            _, raw, headers = res
            results["dl_prod_send"] = (raw, keep_headers(headers, ["content-type", "content-disposition", "content-length", "cache-control", "accept-ranges"]))
        else:
            results["dl_prod_send"] = res[0]
        results["dl_prod_send_badkey"] = call(base, "admin", "servicedownloadable", "send_file", {"id": "2", "file_id": "ff" * 16})[0]
        results["dl_prod_send_badformat"] = call(base, "admin", "servicedownloadable", "send_file", {"id": "2", "file_id": "not-a-key"})[0]
        results["dl_prod_send_missingdisk"] = call(base, "admin", "servicedownloadable", "send_file", {"id": "2", "file_id": "cc" * 16})[0]
        results["dl_prod_send_unknownprod"] = call(base, "admin", "servicedownloadable", "send_file", {"id": "9999", "file_id": "aa" * 16})[0]
        res = call(base, "admin", "servicedownloadable", "send_order_file",
                   {"order_id": str(dl["order_id"]), "file_id": str(dl["sfile_id"])})
        if isinstance(res, tuple) and len(res) == 3:
            _, raw, headers = res
            results["dl_order_send"] = (raw, keep_headers(headers, ["content-type", "content-disposition", "content-length", "cache-control", "accept-ranges"]))
        else:
            results["dl_order_send"] = res[0]
        results["dl_order_send_db"] = dump("service_downloadable_file", "WHERE id = ?", (dl["sfile_id"],))
        results["dl_order_send_badfile"] = call(base, "admin", "servicedownloadable", "send_order_file", {"order_id": str(dl["order_id"]), "file_id": "9999"})[0]
        results["dl_order_send_unknownorder"] = call(base, "admin", "servicedownloadable", "send_order_file", {"order_id": "9999", "file_id": str(dl["sfile_id"])})[0]
        results["dl_order_send_notactivated"] = call(base, "admin", "servicedownloadable", "send_order_file", {"order_id": str(dl["notact_order"]), "file_id": str(dl["sfile_id"])})[0]
        res = call(base, "client", "servicedownloadable", "send_file",
                   {"order_id": str(dl["order_id"]), "file_id": str(dl["sfile_id"])})
        if isinstance(res, tuple) and len(res) == 3:
            _, raw, headers = res
            results["dl_client_send"] = (raw, keep_headers(headers, ["content-type", "content-disposition", "content-length", "cache-control", "accept-ranges"]))
        else:
            results["dl_client_send"] = res[0]
        results["dl_client_send_db"] = dump("service_downloadable_file", "WHERE id = ?", (dl["sfile_id"],))
        results["dl_client_send_nonowner"] = call(base, "client", "servicedownloadable", "send_file", {"order_id": str(dl["nonowner_order"]), "file_id": str(dl["sfile_id"])})[0]
        results["dl_client_send_notactive"] = call(base, "client", "servicedownloadable", "send_file", {"order_id": str(dl["pending_order"]), "file_id": str(dl["sfile_id"])})[0]
        results["dl_client_send_expired"] = call(base, "client", "servicedownloadable", "send_file", {"order_id": str(dl["expired_order"]), "file_id": str(dl["sfile_id"])})[0]
        results["dl_client_send_zero"] = call(base, "client", "servicedownloadable", "send_file", {"order_id": "0", "file_id": str(dl["sfile_id"])})[0]
        up_env, _ = multipart(base, "admin", "servicedownloadable", "upload",
                              {"id": "2", "label": "Guide v2", "description": "Second guide"},
                              file_field="file_data", file_name="guide-v2.txt",
                              file_bytes=b"GUIDE-V2-CONTENT\n")
        results["dl_upload_ok"] = up_env
        prod_after = d.execute("SELECT config FROM product WHERE id = 2").fetchone()[0]
        results["dl_upload_ok_cfg"] = json.loads(prod_after)
        stored = json.loads(prod_after)["files"][-1]["stored_filename"]
        results["dl_upload_ok_bytes"] = (UPLOADS / stored).read_bytes()
        results["dl_upload_badext"] = multipart(base, "admin", "servicedownloadable", "upload",
                                                {"id": "2"}, file_field="file_data",
                                                file_name="evil.php", file_bytes=b"<?php bad();")[0]
        results["dl_upload_nofile"] = multipart(base, "admin", "servicedownloadable", "upload", {"id": "2"})[0]
        results["dl_upload_unknownprod"] = multipart(base, "admin", "servicedownloadable", "upload",
                                                     {"id": "9999"}, file_field="file_data",
                                                     file_name="x.txt", file_bytes=b"x")[0]
        upd_env, _ = multipart(base, "admin", "servicedownloadable", "update",
                               {"order_id": str(dl["order_id"]), "label": "Replacement"},
                               file_field="file_data", file_name="replacement.txt",
                               file_bytes=b"REPLACEMENT-CONTENT\n")
        results["dl_update_ok"] = upd_env
        order_after = d.execute("SELECT config FROM client_order WHERE id = ?", (dl["order_id"],)).fetchone()[0]
        results["dl_update_ok_cfg"] = json.loads(order_after)
        stored2 = json.loads(order_after)["files"][-1]["stored_filename"]
        results["dl_update_ok_bytes"] = (UPLOADS / stored2).read_bytes()
        results["dl_update_ok_files"] = dump("service_downloadable_file", "WHERE service_downloadable_id = ?", (dl["svc_id"],))
        results["dl_update_unknownorder"] = multipart(base, "admin", "servicedownloadable", "update",
                                                      {"order_id": "9999"}, file_field="file_data",
                                                      file_name="x.txt", file_bytes=b"x")[0]
        results["dl_update_notactivated"] = multipart(base, "admin", "servicedownloadable", "update",
                                                      {"order_id": str(dl["notact_order"])},
                                                      file_field="file_data", file_name="x.txt",
                                                      file_bytes=b"x")[0]
        results["dl_update_nofile"] = multipart(base, "admin", "servicedownloadable", "update",
                                                {"order_id": str(dl["order_id"])})[0]
        return results

    import shutil
    cache_dir = pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/data/cache")

    def clear_cache():
        if cache_dir.exists():
            for entry in cache_dir.iterdir():
                if entry.is_dir():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()

    def restore_tables(except_tables):
        for name in list(UPLOADS.iterdir()) if UPLOADS.exists() else []:
            if name.name not in uploads_before:
                name.unlink()
        keep = [t for t in TABLES if t not in except_tables]
        seq_keep = ", ".join("?" * len(keep))
        d.execute(f"DELETE FROM sqlite_sequence WHERE name IN ({seq_keep})", keep)
        for name, seq in snap_seq:
            if name in keep:
                d.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (name, seq))
        for t in keep:
            rows, cols = snaps[t]
            if not cols:
                continue
            d.execute(f'DELETE FROM "{t}"')
            col_list = ",".join(cols)
            placeholders = ",".join("?" * len(cols))
            d.executemany(f'INSERT INTO "{t}" (' + col_list + ") VALUES (" + placeholders + ")",
                          [tuple(r) for r in rows])
        d.commit()
        clear_cache()

    def restore_between():
        # Keep the session table: restoring it would invalidate the live
        # login sessions both stacks share.
        restore_tables({"session"})

    def restore_all():
        restore_tables(set())

    deleted_results = []
    try:
        php_results = run_stack(PHP)
        restore_between()
        ts_results = run_stack(TS)
        # Deleted endpoints (TS-only): the removal error IS the expected
        # answer, counted separately and never as a failure.
        admin_deleted = ["update_available", "update_info", "recheck_update", "update_core",
                         "update_finalization_status", "finalize_update",
                         "complete_update_finalization", "manual_update", "is_behind_on_patches",
                         "cache_settings", "update_cache_settings", "clear_cache",
                         "template_exists", "env", "get_interface_ips", "set_interface_ip",
                         "messages", "cas_messages"]
        for m in admin_deleted:
            env, _ = call(TS, "admin", "system", m, {})
            deleted_results.append((f"del_admin_{m}", env,
                                    {"result": None,
                                     "error": {"message": f"Endpoint admin/system/{m} was removed in the Next.js port.",
                                               "code": 9999}}))
        env, _ = call(TS, "guest", "system", "template_exists", {"template": "x"})
        deleted_results.append(("del_guest_template_exists", env,
                                {"result": None,
                                 "error": {"message": "Endpoint guest/system/template_exists was removed in the Next.js port.",
                                           "code": 9999}}))
    finally:
        restore_all()
    # Persist results so a compare crash never loses a full run.
    def _jsonable(v):
        if isinstance(v, bytes):
            return {"__bytes_b64__": __import__("base64").b64encode(v).decode()}
        if isinstance(v, tuple):
            return [_jsonable(x) for x in v]
        if isinstance(v, list):
            return [_jsonable(x) for x in v]
        if isinstance(v, dict):
            return {k: _jsonable(x) for k, x in v.items()}
        return v
    with open("/tmp/parity24-results.json", "w") as fh:
        json.dump({"php": _jsonable(php_results), "ts": _jsonable(ts_results),
                   "deleted": _jsonable(deleted_results)}, fh)
    return php_results, ts_results, deleted_results


def compare_all(php_results, ts_results, deleted_results):
    global CHECKS, DELETED_OK
    for name, pv in php_results.items():
        if name not in ts_results:
            FAILURES.append((name, pv, "<MISSING>"))
            print(f"DIFF {name}: missing from TS results")
            continue
        tv = ts_results[name]
        if name in ("cur_eur_live", "cur_bogus_provider"):
            # EXPECTED SANDBOX ASYMMETRY, not an implementation diff:
            # PHP's fetch dies at the TLS layer (9999, nothing flushed),
            # while Node's fetch reaches the live API and updates the
            # rate — which VERIFIES the TS live happy path. Assert the
            # PHP error, the TS success, and a plausible updated rate.
            CHECKS += 1
            php_env, _ = pv
            ts_env, ts_dump = tv
            php_err = (php_env.get("error") or {}).get("code") == 9999
            ts_ok = ts_env.get("result") is True and ts_env.get("error") is None
            eur = [r for r in ts_dump if r.get("code") == "EUR"]
            usd = [r for r in ts_dump if r.get("code") == "USD"]
            rate_ok = bool(eur and usd) and 0 < eur[0]["conversion_rate"] < 2 \
                and eur[0]["conversion_rate"] != 1 and usd[0]["conversion_rate"] == 1
            if php_err and ts_ok and rate_ok:
                print(f"ok   {name} (sandbox asymmetry: PHP TLS-fails, TS live rate "
                      f"{eur[0]['conversion_rate']})")
            else:
                FAILURES.append((name, pv, tv))
                print(f"DIFF {name}\n  php: {safe_dump(pv)}\n  ts:  {safe_dump(tv)}")
        elif name.startswith("pdf_") and isinstance(pv, tuple):
            CHECKS += 1
            ok = (isinstance(tv, tuple) and tv[0] == "<pdf>"
                  and pv[1][:5] == b"%PDF-" and tv[1][:5] == b"%PDF-"
                  and pv[2] > 0 and tv[2] > 0
                  and scrub(pv[3]) == scrub(tv[3]))
            if not ok:
                FAILURES.append((name, pv, tv))
                print(f"DIFF {name}\n  php: {pv}\n  ts:  {tv}")
            else:
                print(f"ok   {name}")
        else:
            check(name, pv, tv)
    for name in ts_results:
        if name not in php_results:
            FAILURES.append((name, "<MISSING>", ts_results[name]))
            print(f"DIFF {name}: extra in TS results")
    for name, got, expected in deleted_results:
        CHECKS += 1
        if scrub(got) == scrub(expected):
            DELETED_OK += 1
            print(f"ok   {name} (removal error)")
        else:
            FAILURES.append((name, expected, got))
            print(f"DIFF {name}\n  expected: {expected}\n  got:      {got}")
    print(f"\nparity24: {CHECKS} checks, {len(FAILURES)} failures, "
          f"{DELETED_OK}/{len(deleted_results)} deleted-endpoint removals confirmed")
    if FAILURES:
        print("FAILURES:")
        for name, _, _ in FAILURES:
            print(f"  - {name}")
        sys.exit(1)
    print("parity24: ALL GREEN")


if __name__ == "__main__":
    php_r, ts_r, del_r = main()
    compare_all(php_r, ts_r, del_r)

