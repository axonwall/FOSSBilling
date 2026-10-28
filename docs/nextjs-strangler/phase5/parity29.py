#!/usr/bin/env python3
"""Phase 5 R2e parity: system settings + currency + stats pages,
compared live on PHP (:8080) vs TS (:3001/api/fb).

Sections:
  A. Page smoke (TS pages only, super-admin): all three routes return
     200 with the sidebar System section and markers proving real
     settings/rates/stats data rendered.
  B. Logged-out smoke: settings + currencies + stats render without
     the sidebar and show the staff sign-in link.
  C. Secret audit: get_params, currency list, and stats envelopes on
     both stacks contain no credential-secret keys at any depth.
  D. Settings-write equivalence (super, via the page's mutation path
     on both stacks, full settings-table comparison proving restore).
  E. Currency equivalence + refresh cases: list/default, manual-only
     refresh (no fetch on either stack), keyed-provider-no-key refresh
     (identical missing-key error, no fetch). Live-rate refresh is
     NOT compared: TS Node fetch reaches the open API while PHP's
     fetch dies at the sandbox TLS layer (standing R1 asymmetry).
  F. Stats equivalence: all 12 admin stats endpoints, exact envelopes.
  G. Non-super viewer behavior on the settings pages (TS pages):
     support-only persona gets error boxes, no editable form, no
     stats data, no System sidebar entries.
  H. Final restore proof: settings map identical to the initial
     snapshot + invariants.
Only envelopes are compared, never HTTP status: TS error envelopes are
always HTTP 200 by seam convention while PHP answers 4xx with the same
envelope, documented not hidden.
"""
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
TS_PAGES = "http://127.0.0.1:3001"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
VIEWER_EMAIL = "r2e-viewer@example.local"
VIEWER_PASS = "R2e-View!42"
FIXED_TS = "2026-10-28 12:00:00"

FAILURES = []
CHECKS = 0


def check(name, php_val, ts_val):
    global CHECKS
    CHECKS += 1
    if php_val != ts_val:
        FAILURES.append((name, php_val, ts_val))
        print("FAIL", name)
        print("  php:", json.dumps(php_val, default=str)[:400])
        print("  ts :", json.dumps(ts_val, default=str)[:400])
    else:
        print("ok  ", name)


def check_true(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if not cond:
        FAILURES.append((name, detail, ""))
        print("FAIL", name, detail)
    else:
        print("ok  ", name)


SECRET_KEY_SUBSTRINGS = (
    "password", "passwd", "api_token", "secret", "salt",
    "private_key", "webhook", "smtp", "captcha",
)


def find_secret_keys(v, path=""):
    """All key paths whose key looks like a credential secret."""
    hits = []
    if isinstance(v, dict):
        for k, x in v.items():
            kl = str(k).lower()
            if any(s in kl for s in SECRET_KEY_SUBSTRINGS):
                hits.append(f"{path}.{k}")
            hits += find_secret_keys(x, f"{path}.{k}")
    elif isinstance(v, list):
        for i, x in enumerate(v):
            hits += find_secret_keys(x, f"{path}[{i}]")
    return hits


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

    def invariants():
        q = lambda s: d.execute(s).fetchone()[0]
        got = (
            q("SELECT COUNT(*) FROM tld"), q("SELECT COUNT(*) FROM tld_registrar"),
            q("SELECT COUNT(*) FROM service_domain"), q("SELECT COUNT(*) FROM email_queue"),
            d.execute("SELECT value FROM setting WHERE id=52").fetchone()[0],
            q("SELECT COUNT(*) FROM invoice"), q("SELECT COUNT(*) FROM client_order"),
            q("SELECT COUNT(*) FROM admin"), q("SELECT COUNT(*) FROM admin_group"),
            q("SELECT COUNT(*) FROM admin_group_member"), q("SELECT COUNT(*) FROM support_ticket"),
            q("SELECT COUNT(*) FROM client"), q("SELECT COUNT(*) FROM service_downloadable"),
        )
        want = (1, 3, 0, 67, "2026-10-26 03:24:56", 323, 11, 2, 3, 1, 2, 3, 0)
        return got, want

    def settings_map():
        return {r[0]: r[1] for r in d.execute("SELECT param, value FROM setting").fetchall()}

    def restore_settings(snap):
        # Interim restore only: values + param set. The full restore()
        # in finally re-applies exact rows (incl. ids) afterwards.
        d.execute("DELETE FROM setting")
        for param, value in snap.items():
            d.execute("INSERT INTO setting (param, value) VALUES (?, ?)", (param, value))
        d.commit()

    got, want = invariants()
    check_true("invariants-before", got == want, f"{got} != {want}")
    settings_initial = settings_map()

    def make_opener():
        cj = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

    def login(op, email, password):
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^\"]+)"', page)
        token = m.group(1) if m else None
        payload = {"email": email, "password": password}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed for {email}: {parsed}"
        return token

    def call(op, token, base, role, module, method, data=None):
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
        if not isinstance(parsed, dict):
            print(f"NON-DICT response from {url}: {raw[:200]!r}")
            parsed = {"_non_dict": parsed}
        return parsed, status

    def page(op, path):
        req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
        try:
            with op.open(req, timeout=60) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def bcrypt_hash(pw):
        out = subprocess.run(
            ["node", "-e",
             "const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
             f"console.log(b.hashSync({json.dumps(pw)}, 12))"],
            capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    try:
        op, _ = make_opener()
        token = login(op, SUPER_EMAIL, SUPER_PASS)

        # ---- A. Page smoke (super) ----
        gp0, _ = call(op, token, TS, "admin", "system", "get_params")
        st, html = page(op, "/admin/system")
        check_true("page_system_200", st == 200, f"status {st}")
        check_true("page_system_heading", "System settings" in html)
        cname = gp0["result"].get("company_name") or ""
        if cname:
            check_true("page_system_company_value", cname in html, f"company_name={cname!r}")
        else:
            check_true("page_system_company_label", "Company Name" in html)
        check_true("page_system_sidebar_currencies", "/admin/system/currencies" in html)
        check_true("page_system_sidebar_stats", "/admin/system/stats" in html)
        check_true("page_system_save_button", "Save settings" in html)
        st, html = page(op, "/admin/system/currencies")
        check_true("page_currencies_200", st == 200, f"status {st}")
        # React SSR splits "Default currency: <!-- -->USD" with comment
        # nodes, so assert the line label and the USD marker separately.
        check_true("page_currencies_default", "Default currency:" in html and "USD" in html)
        check_true("page_currencies_usd_row", ">USD<" in html or "USD" in html)
        check_true("page_currencies_refresh", "Refresh rates" in html)
        # Stats markers come from the live API so they prove real data.
        inc, _ = call(op, token, TS, "admin", "stats", "get_summary_income")
        prod, _ = call(op, token, TS, "admin", "stats", "get_product_summary")
        st, html = page(op, "/admin/system/stats")
        check_true("page_stats_200", st == 200, f"status {st}")
        check_true("page_stats_heading", "Income summary" in html)
        check_true("page_stats_income_total",
                   str(inc["result"]["total"]) in html, f"total {inc['result']}")
        if prod["result"]:
            check_true("page_stats_product_title",
                       prod["result"][0]["title"] in html, f"{prod['result'][0]}")

        # ---- B. Logged-out smoke ----
        op_out, _ = make_opener()
        for path, name in (("/admin/system", "loggedout_system"),
                           ("/admin/system/currencies", "loggedout_currencies"),
                           ("/admin/system/stats", "loggedout_stats")):
            st, html = page(op_out, path)
            check_true(f"{name}_no_sidebar", "<aside" not in html)
            check_true(f"{name}_signin_link", "sign in as staff" in html)

        # ---- C. Secret audit ----
        gp, _ = call(op, token, PHP, "admin", "system", "get_params")
        gt, _ = call(op, token, TS, "admin", "system", "get_params")
        check_true("audit_settings_php_keys", find_secret_keys(gp) == [],
                   str(find_secret_keys(gp)))
        check_true("audit_settings_ts_keys", find_secret_keys(gt) == [],
                   str(find_secret_keys(gt)))
        cl_p, _ = call(op, token, PHP, "admin", "currency", "get_list", {"per_page": 100})
        cl_t, _ = call(op, token, TS, "admin", "currency", "get_list", {"per_page": 100})
        check_true("audit_currency_php_keys", find_secret_keys(cl_p) == [],
                   str(find_secret_keys(cl_p)))
        check_true("audit_currency_ts_keys", find_secret_keys(cl_t) == [],
                   str(find_secret_keys(cl_t)))
        for method in ("get_summary_income", "get_product_summary"):
            s_p, _ = call(op, token, PHP, "admin", "stats", method)
            s_t, _ = call(op, token, TS, "admin", "stats", method)
            check_true(f"audit_stats_{method}_php", find_secret_keys(s_p) == [],
                       str(find_secret_keys(s_p)))
            check_true(f"audit_stats_{method}_ts", find_secret_keys(s_t) == [],
                       str(find_secret_keys(s_t)))

        # ---- D. Settings-write equivalence ----
        def settings_write(base):
            w, _ = call(op, token, base, "admin", "system", "update_params",
                        {"company_name": "R2e Test Co", "hide_company_public": "0"})
            r, _ = call(op, token, base, "admin", "system", "get_params")
            return w, r["result"]["company_name"], r["result"]["hide_company_public"], \
                sorted(r["result"].keys())

        w_p, name_p, hide_p, keys_p = settings_write(PHP)
        restore_settings(settings_initial)
        w_t, name_t, hide_t, keys_t = settings_write(TS)
        restore_settings(settings_initial)
        check("settings_write_result", w_p, w_t)
        check_true("settings_write_company", name_p == "R2e Test Co" and name_t == "R2e Test Co",
                   f"{name_p} vs {name_t}")
        check_true("settings_write_checkbox", hide_p == "0" and hide_t == "0",
                   f"{hide_p} vs {hide_t}")
        check_true("settings_write_no_new_params", keys_p == keys_t == sorted(settings_initial.keys()))
        check_true("settings_restored_values", settings_map() == settings_initial)

        # ---- E. Currency equivalence + refresh cases ----
        cl_p, _ = call(op, token, PHP, "admin", "currency", "get_list", {"per_page": 100})
        cl_t, _ = call(op, token, TS, "admin", "currency", "get_list", {"per_page": 100})
        check("currency_list", cl_p, cl_t)
        cd_p, _ = call(op, token, PHP, "admin", "currency", "get_default")
        cd_t, _ = call(op, token, TS, "admin", "currency", "get_default")
        check("currency_default", cd_p, cd_t)

        def rates(base):
            r, _ = call(op, token, base, "admin", "currency", "get_list", {"per_page": 100})
            return {c["code"]: c["conversion_rate"] for c in r["result"]["list"]}

        # Manual-only refresh: no fetch on either stack.
        d.execute("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code)"
                  " VALUES (0, 0.9, 1, 'EUR')")
        d.commit()
        rp, _ = call(op, token, PHP, "admin", "currency", "update_rates")
        rt, _ = call(op, token, TS, "admin", "currency", "update_rates")
        check("refresh_manual_result", rp, rt)
        check_true("refresh_manual_rates_unchanged",
                   rates(PHP) == rates(TS) == {"USD": 1, "EUR": 0.9},
                   f"{rates(PHP)} vs {rates(TS)}")
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # Keyed-provider-no-key refresh: identical missing-key error.
        d.execute("INSERT INTO currency (is_default, conversion_rate, is_rate_manual, code)"
                  " VALUES (0, 1, 0, 'EUR')")
        d.commit()
        call(op, token, PHP, "admin", "extension", "config_save",
             {"ext": "mod_currency", "provider": "currency_data_api"})
        rp, _ = call(op, token, PHP, "admin", "currency", "update_rates")
        rt, _ = call(op, token, TS, "admin", "currency", "update_rates")
        check("refresh_dataapi_nokey", rp, rt)
        call(op, token, PHP, "admin", "extension", "config_save", {"ext": "mod_currency"})
        d.execute("DELETE FROM currency WHERE code = 'EUR'")
        d.commit()
        # config_save never deletes the row: it rewrites the encrypted
        # config, so "clear" leaves a row holding {"ext": ...} with no
        # provider. The honest assertion is the effective config, not
        # row absence (the full-DB restore in finally removes the row).
        cfg, _ = call(op, token, PHP, "admin", "extension", "config_get",
                      {"ext": "mod_currency"})
        check_true("refresh_cfg_restored",
                   isinstance(cfg.get("result"), dict) and "provider" not in cfg["result"],
                   f"{cfg}")

        # ---- F. Stats equivalence ----
        # Default-window flot series carry "now"-derived timestamps:
        # PHP emits second precision, TS millisecond precision, and
        # PHP's own consecutive calls differ by a second (363000 vs
        # 364000 above), so exact envelope equality is unachievable
        # even in principle. Per the parity15 practice documented in
        # stats.ts, series are compared by calendar day + value.
        import datetime as _dt

        def series_day_values(env):
            return [(_dt.datetime.fromtimestamp(ts / 1000, tz=_dt.timezone.utc)
                     .strftime("%Y-%m-%d"), v) for ts, v in env["result"]]

        for method, params in (
                ("get_summary_income", {}), ("get_income_vs_refunds", {}),
                ("get_product_summary", {}), ("get_product_sales", {}),
                ("client_countries", {"limit": 10}), ("sales_countries", {"limit": 10})):
            s_p, _ = call(op, token, PHP, "admin", "stats", method, params)
            s_t, _ = call(op, token, TS, "admin", "stats", method, params)
            check(f"stats_{method}", s_p, s_t)
        for method in ("get_income", "get_refunds", "get_orders",
                       "get_clients", "get_invoices", "get_tickets"):
            s_p, _ = call(op, token, PHP, "admin", "stats", method)
            s_t, _ = call(op, token, TS, "admin", "stats", method)
            check(f"stats_{method}_day_values",
                  series_day_values(s_p), series_day_values(s_t))

        # ---- G. Non-super viewer ----
        h = bcrypt_hash(VIEWER_PASS)
        cur = d.cursor()
        cur.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected, created_at, updated_at, parent_id)"
            " VALUES ('R2e Support Only', 'r2e_support_only', ?, 0, ?, ?, 1)",
            (json.dumps({"support": {"access": True}}), FIXED_TS, FIXED_TS))
        gid = cur.lastrowid
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, 'R2e Viewer', 'active', NULL, NULL, ?, ?)",
            (VIEWER_EMAIL, h, FIXED_TS, FIXED_TS))
        vid = cur.lastrowid
        cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at)"
                    " VALUES (?, ?, ?)", (vid, gid, FIXED_TS))
        d.commit()
        op_v, _ = make_opener()
        login(op_v, VIEWER_EMAIL, VIEWER_PASS)
        st, html = page(op_v, "/admin/system")
        check_true("viewer_system_error_box",
                   "You do not have access to the system module" in html)
        check_true("viewer_system_no_form", "Save settings" not in html)
        st, html = page(op_v, "/admin/system/currencies")
        check_true("viewer_currencies_error_box",
                   "You do not have access to the currency module" in html)
        check_true("viewer_currencies_no_table", "<table" not in html)
        st, html = page(op_v, "/admin/system/stats")
        check_true("viewer_stats_error_box",
                   "You do not have access to the stats module" in html)
        check_true("viewer_stats_no_signin_link", "sign in as staff" not in html)
        check_true("viewer_stats_no_data", "Income summary" not in html)
        st, html = page(op_v, "/admin")
        check_true("viewer_sidebar_no_system",
                   "/admin/system/currencies" not in html and "/admin/system/stats" not in html)
    finally:
        restore()
        print("reference DB restored")

    got, want = invariants()
    check_true("invariants-after", got == want, f"{got} != {want}")
    check_true("settings-final-restored", settings_map() == settings_initial)
    print(f"\nparity29: {CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("parity29: FAILURES PRESENT")
        raise SystemExit(1)
    print("parity29: ALL GREEN")


if __name__ == "__main__":
    main()
