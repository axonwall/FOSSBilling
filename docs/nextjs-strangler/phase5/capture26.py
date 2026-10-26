#!/usr/bin/env python3
"""Phase 5 R1 leftovers sub-batch 2 capture: platform + small mop-ups vs PHP.

Runs against live PHP only (:8080). Everything is restored from
snapshots at the end (finally), including seeded forms/redirects,
extension_meta rows, settings, activity rows and sessions.

Modules covered: formbuilder (admin 12 + guest get), security (admin 8),
redirect (admin 5), antispam (admin 4 + guest recaptcha), widgets
(admin 2), seo (admin 2), serviceapikey (admin 2 + client reset +
guest check), page (admin get_pairs), index (client get_dashboard),
cookieconsent (guest message), activity (admin log_email),
product (admin get_pairs).

NOTE: encrypted extension_meta config rows (antispam) carry a random
IV, so their meta_value is non-deterministic by design; the capture
stores the row with meta_value replaced by '<encrypted>' and the
plaintext is proven by the get_config envelopes.
"""
import json, pathlib, sqlite3, urllib.request, urllib.parse, urllib.error, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures26"
OUT.mkdir(exist_ok=True)
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
NOW = "2026-10-26 12:00:00"
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"
CLIENT_ID = 1

TABLES = ["form", "form_field", "product", "client_order", "extension_meta",
          "setting", "activity_client_email", "session", "email_queue",
          "email_template", "admin", "client", "support_ticket", "invoice"]


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
        try:
            snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(),
                        [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')])
        except Exception:
            snaps[t] = ([], [])
    seq_tables = ", ".join("?" * len(TABLES))
    snap_seq = d.execute(
        f"SELECT name, seq FROM sqlite_sequence WHERE name IN ({seq_tables})", TABLES).fetchall()

    def restore():
        d.execute(f"DELETE FROM sqlite_sequence WHERE name IN ({seq_tables})", TABLES)
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

    def dump_table(name, sql):
        rows = d.execute(sql).fetchall()
        cols = [r[1] for r in d.execute(f"PRAGMA table_info({name})")]
        out = [dict(zip(cols, r)) for r in rows]
        for row in out:
            if row.get("meta_key") == "config":
                row["meta_value"] = "<encrypted>"
        return out

    def save_dump(name, data):
        (OUT / f"{name}.json").write_text(json.dumps(data, indent=2, default=str))

    def admin_login(op, cj):
        return call(op, cj, "tmp_staff_login", "guest", "staff", "login",
                    {"email": ADMIN_EMAIL, "password": ADMIN_PASS}, save=False)

    def client_login(op, cj):
        return call(op, cj, "tmp_client_login", "guest", "client", "login",
                    {"email": CLIENT_EMAIL, "password": CLIENT_PASS}, save=False)

    try:
        op_a, cj_a = opener()
        admin_login(op_a, cj_a)
        op_n, cj_n = opener()  # no login
        op_c, cj_c = opener()
        client_login(op_c, cj_c)

        # ---------- formbuilder ---------- #
        call(op_a, cj_a, "fb_forms_empty", "admin", "formbuilder", "get_forms")
        call(op_a, cj_a, "fb_pairs_empty", "admin", "formbuilder", "get_pairs")
        call(op_a, cj_a, "fb_get_noid", "admin", "formbuilder", "get_form")
        call(op_a, cj_a, "fb_get_unknown", "admin", "formbuilder", "get_form", {"id": 999999})
        call(op_a, cj_a, "fb_create_noname", "admin", "formbuilder", "create_form")
        call(op_a, cj_a, "fb_create_badtype", "admin", "formbuilder", "create_form",
             {"name": "Bad", "type": "inline"})
        f1 = call(op_a, cj_a, "fb_create", "admin", "formbuilder", "create_form",
                  {"name": "Cap26 Form"})["result"]
        f2 = call(op_a, cj_a, "fb_create_default", "admin", "formbuilder", "create_form",
                  {"name": "Cap26 Default", "type": "default", "show_title": "1"})["result"]
        call(op_a, cj_a, "fb_get_f1", "admin", "formbuilder", "get_form", {"id": f1})
        call(op_a, cj_a, "fb_forms", "admin", "formbuilder", "get_forms")
        call(op_a, cj_a, "fb_add_notype", "admin", "formbuilder", "add_field", {"form_id": f1})
        call(op_a, cj_a, "fb_add_noform", "admin", "formbuilder", "add_field", {"type": "text"})
        call(op_a, cj_a, "fb_add_badtype", "admin", "formbuilder", "add_field",
             {"type": "bogus", "form_id": f1})
        call(op_a, cj_a, "fb_add_dupoptions", "admin", "formbuilder", "add_field",
             {"type": "select", "form_id": f1, "options": {"A": "1", "B": "1"}})
        fld_text = call(op_a, cj_a, "fb_add_text", "admin", "formbuilder", "add_field",
                        {"type": "text", "form_id": f1})["result"]
        fld_full = call(op_a, cj_a, "fb_add_text_full", "admin", "formbuilder", "add_field",
                        {"type": "text", "form_id": f1, "label": "Full Name", "name": "full_name",
                         "description": "Your name", "default_value": "John",
                         "required": 1, "prefix": "$", "text_size": 40})["result"]
        fld_select = call(op_a, cj_a, "fb_add_select", "admin", "formbuilder", "add_field",
                          {"type": "select", "form_id": f1,
                           "options": {"Custom A": "a", "Custom B": "b"}})["result"]
        fld_check = call(op_a, cj_a, "fb_add_checkbox", "admin", "formbuilder", "add_field",
                         {"type": "checkbox", "form_id": f1,
                          "default_value": ["a", "b"]})["result"]
        fld_area = call(op_a, cj_a, "fb_add_textarea", "admin", "formbuilder", "add_field",
                        {"type": "textarea", "form_id": f1})["result"]
        fld_url = call(op_a, cj_a, "fb_add_url", "admin", "formbuilder", "add_field",
                       {"type": "url", "form_id": f1})["result"]
        call(op_a, cj_a, "fb_fields_f1", "admin", "formbuilder", "get_form_fields",
             {"form_id": f1})
        call(op_a, cj_a, "fb_field_get_text", "admin", "formbuilder", "get_field",
             {"id": fld_text})
        call(op_a, cj_a, "fb_field_get_select", "admin", "formbuilder", "get_field",
             {"id": fld_select})
        call(op_a, cj_a, "fb_field_unknown", "admin", "formbuilder", "get_field",
             {"id": 999999})
        call(op_a, cj_a, "fb_pairs", "admin", "formbuilder", "get_pairs")
        call(op_a, cj_a, "fb_get_f1_full", "admin", "formbuilder", "get_form", {"id": f1})
        call(op_a, cj_a, "fb_upd_noid", "admin", "formbuilder", "update_field",
             {"label": "X", "name": "x"})
        call(op_a, cj_a, "fb_upd_unknown", "admin", "formbuilder", "update_field",
             {"id": 999999, "label": "X", "name": "x"})
        call(op_a, cj_a, "fb_upd_text", "admin", "formbuilder", "update_field",
             {"id": fld_text, "label": "Renamed", "name": "renamed"})
        call(op_a, cj_a, "fb_upd_dupname", "admin", "formbuilder", "update_field",
             {"id": fld_text, "label": "Dup", "name": "full_name"})
        call(op_a, cj_a, "fb_upd_digitname", "admin", "formbuilder", "update_field",
             {"id": fld_text, "label": "Digit", "name": "9lives"})
        call(op_a, cj_a, "fb_upd_emptyname", "admin", "formbuilder", "update_field",
             {"id": fld_text, "label": "Empty", "name": ""})
        call(op_a, cj_a, "fb_upd_nonunique_opts", "admin", "formbuilder", "update_field",
             {"id": fld_text, "label": "R", "name": "renamed",
              "options": {"A": "1", "B": "1"}})
        call(op_a, cj_a, "fb_upd_select_values", "admin", "formbuilder", "update_field",
             {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
              "values": ["v1", "v2"], "labels": ["L1", "L2"]})
        call(op_a, cj_a, "fb_upd_select_dupvalues", "admin", "formbuilder", "update_field",
             {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
              "values": ["v1", "v1"], "labels": ["L1", "L2"]})
        call(op_a, cj_a, "fb_upd_select_duplabels", "admin", "formbuilder", "update_field",
             {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
              "values": ["v1", "v2"], "labels": ["L1", "L1"]})
        call(op_a, cj_a, "fb_upd_textarea", "admin", "formbuilder", "update_field",
             {"id": fld_area, "label": "Notes", "name": "notes", "type": "textarea",
              "textarea_option": ["height", "width"], "textarea_size": ["120", "400"]})
        call(op_a, cj_a, "fb_upd_select_novalues", "admin", "formbuilder", "update_field",
             {"id": fld_select, "label": "Choice", "name": "choice", "type": "select"})
        call(op_a, cj_a, "fb_copy_noid", "admin", "formbuilder", "copy_form",
             {"name": "Copy"})
        call(op_a, cj_a, "fb_copy_noname", "admin", "formbuilder", "copy_form",
             {"form_id": f1})
        f3 = call(op_a, cj_a, "fb_copy", "admin", "formbuilder", "copy_form",
                  {"form_id": f1, "name": "Cap26 Copy"})["result"]
        call(op_a, cj_a, "fb_get_f3", "admin", "formbuilder", "get_form", {"id": f3})
        call(op_a, cj_a, "fb_settings_noid", "admin", "formbuilder", "update_form_settings",
             {"form_name": "X", "type": "default"})
        call(op_a, cj_a, "fb_settings_badtype", "admin", "formbuilder", "update_form_settings",
             {"form_id": f1, "form_name": "X", "type": "inline"})
        call(op_a, cj_a, "fb_settings", "admin", "formbuilder", "update_form_settings",
             {"form_id": f1, "form_name": "Cap26 Renamed", "type": "default"})
        call(op_a, cj_a, "fb_get_f1_after_settings", "admin", "formbuilder", "get_form",
             {"id": f1})
        # link a product to f1, then delete f1: product form_id must NULL out
        d.execute("UPDATE product SET form_id = ? WHERE id = 2", (f1,))
        d.commit()
        call(op_a, cj_a, "fb_delete_f1", "admin", "formbuilder", "delete_form", {"id": f1})
        prod2 = d.execute("SELECT form_id FROM product WHERE id = 2").fetchone()[0]
        print("product 2 form_id after delete_form:", prod2)
        save_dump("fb_product2_after_delete", {"form_id": prod2})
        f3_field = d.execute(
            "SELECT id FROM form_field WHERE form_id = ? ORDER BY id LIMIT 1", (f3,)).fetchone()[0]
        call(op_a, cj_a, "fb_delfield_noid", "admin", "formbuilder", "delete_field")
        call(op_a, cj_a, "fb_delfield_unknown", "admin", "formbuilder", "delete_field",
             {"id": 999999})
        call(op_a, cj_a, "fb_delfield", "admin", "formbuilder", "delete_field",
             {"id": f3_field})
        call(op_a, cj_a, "fb_delform_noid", "admin", "formbuilder", "delete_form")
        call(op_a, cj_a, "fb_delform_unknown", "admin", "formbuilder", "delete_form",
             {"id": 999999})
        call(op_a, cj_a, "fb_delform_f2", "admin", "formbuilder", "delete_form", {"id": f2})
        call(op_a, cj_a, "fb_forms_after", "admin", "formbuilder", "get_forms")
        op_g, cj_g = opener()
        call(op_g, cj_g, "fb_guest_get_unknown", "guest", "formbuilder", "get",
             {"id": 999999})
        call(op_g, cj_g, "fb_guest_get", "guest", "formbuilder", "get", {"id": f3})
        call(op_g, cj_g, "fb_guest_get_noid", "guest", "formbuilder", "get")
        call(op_n, cj_n, "fb_noauth", "admin", "formbuilder", "get_forms")
        save_dump("fb_forms_dump", dump_table("form", "SELECT * FROM form ORDER BY id"))
        save_dump("fb_fields_dump",
                  dump_table("form_field", "SELECT * FROM form_field ORDER BY id"))

        # ---------- security ---------- #
        call(op_a, cj_a, "sec_list", "admin", "security", "list_checks")
        call(op_a, cj_a, "sec_run_unknown", "admin", "security", "run_check", {"id": "nope"})
        call(op_a, cj_a, "sec_run_noid", "admin", "security", "run_check")
        call(op_a, cj_a, "sec_run_general", "admin", "security", "run_check",
             {"id": "generalCheck"})
        call(op_a, cj_a, "sec_run_phpversion", "admin", "security", "run_check",
             {"id": "phpVersion"})
        call(op_a, cj_a, "sec_run_webserver", "admin", "security", "run_check",
             {"id": "webserver"})
        call(op_a, cj_a, "sec_run_dangerous", "admin", "security", "run_check",
             {"id": "dangerousFunctions"})
        call(op_a, cj_a, "sec_run_all", "admin", "security", "run_checks")
        call(op_a, cj_a, "sec_ip_missing", "admin", "security", "ip_lookup")
        call(op_a, cj_a, "sec_ip_invalid", "admin", "security", "ip_lookup",
             {"ip": "not-an-ip"})
        call(op_a, cj_a, "sec_ip_loopback", "admin", "security", "ip_lookup",
             {"ip": "127.0.0.1"})
        call(op_a, cj_a, "sec_ip_public", "admin", "security", "ip_lookup",
             {"ip": "8.8.8.8"})
        call(op_a, cj_a, "sec_ip_v6loopback", "admin", "security", "ip_lookup",
             {"ip": "::1"})
        call(op_a, cj_a, "sec_rl_status", "admin", "security", "rate_limit_status")
        call(op_a, cj_a, "sec_rl_list", "admin", "security", "rate_limit_get_list")
        call(op_a, cj_a, "sec_rl_list_ip", "admin", "security", "rate_limit_get_list",
             {"ip": "127.0.0.1"})
        call(op_a, cj_a, "sec_rl_list_badip", "admin", "security", "rate_limit_get_list",
             {"ip": "bogus"})
        call(op_a, cj_a, "sec_rl_list_search", "admin", "security", "rate_limit_get_list",
             {"search": "api"})
        call(op_a, cj_a, "sec_rl_reset_noid", "admin", "security", "rate_limit_reset_ip")
        call(op_a, cj_a, "sec_rl_reset_badip", "admin", "security", "rate_limit_reset_ip",
             {"ip": "bogus"})
        call(op_a, cj_a, "sec_rl_reset", "admin", "security", "rate_limit_reset_ip",
             {"ip": "203.0.113.9"})
        call(op_a, cj_a, "sec_rl_reset_policy", "admin", "security", "rate_limit_reset_ip",
             {"ip": "203.0.113.9", "policy": "api_guest"})
        call(op_a, cj_a, "sec_rl_reset_all", "admin", "security", "rate_limit_reset_all")
        call(op_n, cj_n, "sec_noauth", "admin", "security", "list_checks")

        # ---------- redirect ---------- #
        call(op_a, cj_a, "rd_list_empty", "admin", "redirect", "get_list")
        call(op_a, cj_a, "rd_create_nopath", "admin", "redirect", "create",
             {"target": "https://example.com/x"})
        call(op_a, cj_a, "rd_create_notarget", "admin", "redirect", "create",
             {"path": "x"})
        call(op_a, cj_a, "rd_create_emptypath", "admin", "redirect", "create",
             {"path": "", "target": "https://example.com/x"})
        call(op_a, cj_a, "rd_create_traversal", "admin", "redirect", "create",
             {"path": "../etc", "target": "https://example.com/x"})
        call(op_a, cj_a, "rd_create_badtarget", "admin", "redirect", "create",
             {"path": "x", "target": "ftp://example.com/x"})
        call(op_a, cj_a, "rd_create_emptytarget", "admin", "redirect", "create",
             {"path": "x", "target": ""})
        r1 = call(op_a, cj_a, "rd_create", "admin", "redirect", "create",
                  {"path": "/old/page/", "target": "https://example.com/new"})["result"]
        r2 = call(op_a, cj_a, "rd_create2", "admin", "redirect", "create",
                  {"path": "gone", "target": "/local"})["result"]
        call(op_a, cj_a, "rd_list", "admin", "redirect", "get_list")
        call(op_a, cj_a, "rd_get", "admin", "redirect", "get", {"id": r1})
        call(op_a, cj_a, "rd_get_unknown", "admin", "redirect", "get", {"id": 999999})
        call(op_a, cj_a, "rd_get_noid", "admin", "redirect", "get")
        call(op_a, cj_a, "rd_update_path", "admin", "redirect", "update",
             {"id": r1, "path": "moved"})
        call(op_a, cj_a, "rd_get_after_path", "admin", "redirect", "get", {"id": r1})
        call(op_a, cj_a, "rd_update_target", "admin", "redirect", "update",
             {"id": r1, "target": "https://example.com/final"})
        call(op_a, cj_a, "rd_update_unknown", "admin", "redirect", "update",
             {"id": 999999, "path": "x"})
        call(op_a, cj_a, "rd_delete", "admin", "redirect", "delete", {"id": r2})
        call(op_a, cj_a, "rd_list_after", "admin", "redirect", "get_list")
        call(op_a, cj_a, "rd_delete_unknown", "admin", "redirect", "delete",
             {"id": 999999})
        call(op_n, cj_n, "rd_noauth", "admin", "redirect", "get_list")
        save_dump("rd_dump", dump_table(
            "extension_meta",
            "SELECT * FROM extension_meta WHERE extension = 'mod_redirect' ORDER BY id"))

        # ---------- antispam ---------- #
        call(op_a, cj_a, "as_config", "admin", "antispam", "get_config")
        op_g2, cj_g2 = opener()
        call(op_g2, cj_g2, "as_guest_recaptcha", "guest", "antispam", "recaptcha")
        call(op_a, cj_a, "as_block_noip", "admin", "antispam", "block_ip")
        call(op_a, cj_a, "as_block_badip", "admin", "antispam", "block_ip",
             {"ip": "bogus"})
        call(op_a, cj_a, "as_block_self", "admin", "antispam", "block_ip",
             {"ip": "127.0.0.1"})
        call(op_a, cj_a, "as_block", "admin", "antispam", "block_ip",
             {"ip": "203.0.113.5"})
        call(op_a, cj_a, "as_block_dup", "admin", "antispam", "block_ip",
             {"ip": "203.0.113.5"})
        call(op_a, cj_a, "as_blocked", "admin", "antispam", "get_blocked_ips")
        call(op_a, cj_a, "as_config_after", "admin", "antispam", "get_config")
        call(op_a, cj_a, "as_unblock_unknown", "admin", "antispam", "unblock_ip",
             {"ip": "203.0.113.6"})
        call(op_a, cj_a, "as_unblock", "admin", "antispam", "unblock_ip",
             {"ip": "203.0.113.5"})
        call(op_a, cj_a, "as_blocked_after", "admin", "antispam", "get_blocked_ips")
        call(op_a, cj_a, "as_config_final", "admin", "antispam", "get_config")
        call(op_n, cj_n, "as_noauth", "admin", "antispam", "get_config")
        save_dump("as_dump", dump_table(
            "extension_meta",
            "SELECT * FROM extension_meta WHERE extension = 'mod_antispam' ORDER BY id"))

        # ---------- widgets ---------- #
        call(op_a, cj_a, "wg_list", "admin", "widgets", "list")
        call(op_a, cj_a, "wg_rebuild", "admin", "widgets", "rebuild")
        call(op_a, cj_a, "wg_list_after", "admin", "widgets", "list")
        call(op_n, cj_n, "wg_noauth", "admin", "widgets", "list")

        # ---------- seo ---------- #
        call(op_a, cj_a, "seo_info", "admin", "seo", "info")
        call(op_a, cj_a, "seo_ping", "admin", "seo", "ping_all")
        seo_row = d.execute(
            "SELECT param, value FROM setting WHERE param = 'mod_seo_last_sitemap_submit'"
        ).fetchone()
        print("seo last submit row:", tuple(seo_row) if seo_row else None)
        save_dump("seo_setting_after_ping",
                  {"param": seo_row[0], "value": seo_row[1]} if seo_row else None)
        call(op_a, cj_a, "seo_info_after", "admin", "seo", "info")
        call(op_n, cj_n, "seo_noauth", "admin", "seo", "info")

        # ---------- serviceapikey ---------- #
        op_g3, cj_g3 = opener()
        call(op_g3, cj_g3, "sak_guest_nokey", "guest", "serviceapikey", "check")
        call(op_g3, cj_g3, "sak_guest_unknown", "guest", "serviceapikey", "check",
             {"key": "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA"})
        call(op_a, cj_a, "sak_admin_update_noid", "admin", "serviceapikey", "update")
        call(op_a, cj_a, "sak_admin_update_unknown", "admin", "serviceapikey", "update",
             {"order_id": 999})
        call(op_a, cj_a, "sak_admin_reset_neither", "admin", "serviceapikey", "reset")
        call(op_a, cj_a, "sak_admin_reset_unknownkey", "admin", "serviceapikey", "reset",
             {"key": "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA"})
        call(op_a, cj_a, "sak_admin_reset_unknownorder", "admin", "serviceapikey", "reset",
             {"order_id": 999})
        call(op_c, cj_c, "sak_client_reset_neither", "client", "serviceapikey", "reset")
        call(op_n, cj_n, "sak_client_reset_noauth", "client", "serviceapikey", "reset")

        # ---------- page / index / cookieconsent ---------- #
        call(op_a, cj_a, "page_pairs", "admin", "page", "get_pairs")
        call(op_n, cj_n, "page_pairs_noauth", "admin", "page", "get_pairs")
        call(op_n, cj_n, "idx_dashboard_noauth", "client", "index", "get_dashboard")
        call(op_c, cj_c, "idx_dashboard", "client", "index", "get_dashboard")
        op_g4, cj_g4 = opener()
        call(op_g4, cj_g4, "cc_message", "guest", "cookieconsent", "message")

        # ---------- activity ---------- #
        call(op_a, cj_a, "act_logemail_nosubject", "admin", "activity", "log_email",
             {"client_id": CLIENT_ID})
        call(op_a, cj_a, "act_logemail_min", "admin", "activity", "log_email",
             {"subject": "Cap26 minimal"})
        call(op_a, cj_a, "act_logemail_full", "admin", "activity", "log_email",
             {"subject": "Cap26 full", "client_id": CLIENT_ID, "sender": "a@example.com",
              "recipients": "b@example.com", "content_html": "<p>Hi</p>",
              "content_text": "Hi"})
        call(op_n, cj_n, "act_logemail_noauth", "admin", "activity", "log_email",
             {"subject": "x"})
        save_dump("act_dump", dump_table(
            "activity_client_email",
            "SELECT * FROM activity_client_email ORDER BY id"))

        # ---------- product ---------- #
        call(op_a, cj_a, "prod_pairs_default", "admin", "product", "get_pairs")
        call(op_a, cj_a, "prod_pairs_all", "admin", "product", "get_pairs",
             {"products_only": 0, "active_only": 0})
        call(op_a, cj_a, "prod_pairs_type_custom", "admin", "product", "get_pairs",
             {"type": "custom"})
        call(op_a, cj_a, "prod_pairs_type_hosting", "admin", "product", "get_pairs",
             {"type": "hosting"})
        call(op_n, cj_n, "prod_pairs_noauth", "admin", "product", "get_pairs")
    finally:
        restore()
        print("reference DB restored")


if __name__ == "__main__":
    main()
