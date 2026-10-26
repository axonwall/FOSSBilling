#!/usr/bin/env python3
"""Phase 5 R1 leftovers sub-batch 2 parity: platform + small mop-ups.

Runs the IDENTICAL sequence against PHP (:8080) and the TS seam
(:3001), with a full snapshot/restore between stacks so autoincrement
sequences align. Openers are always primed via the PHP /login page
(the session row lives in the shared DB, so the TS seam reads it).

Envelope + per-case DB-delta comparison. Scrubbed (never compared
literally): timestamps, random hex (session ids, invoice hashes),
bcrypt values (cost compared instead), encrypted extension_meta
config values (random IV; plaintext proven by get_config envelopes).

Endpoints served by TS handlers are the ported set; security
ip_lookup/run_check/run_checks are NOT registered in TS, so the
TS-base calls for them exercise the PHP proxy (labeled sec_proxy_*)
and match by construction — they are reported as proxied, not
ported. Seo/serviceapikey/cookieconsent handlers ARE registered
but answer 715 on this install (modules not installed); the logic
behind those gates is unverified-live.
"""
import json, re, sqlite3, urllib.request, urllib.parse, urllib.error, http.cookiejar

PHP = "http://127.0.0.1:8080"
NEXT = "http://127.0.0.1:3001"
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

DUMP_TABLES = ["form", "form_field", "extension_meta", "activity_client_email"]

HEXVAR = re.compile(r"\b[0-9a-f]{30,64}\b")
DT = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}")
BCRYPT = re.compile(r"\$2[aby]\$(\d{2})\$")


def scrub(v):
    if isinstance(v, str):
        v = DT.sub("TS", v)
        v = HEXVAR.sub("HEX", v)
        v = BCRYPT.sub(r"$2X$\1$", v)
        return v
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items() if k != "vars"}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


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


class Run:
    def __init__(self, base):
        self.base = base
        self.api = base + "/api" if base == PHP else base + "/api/fb"
        self.d = sqlite3.connect(DBP)
        self.d.row_factory = sqlite3.Row
        self.env = {}
        self.db = {}
        self.last_max = {}
        for t in DUMP_TABLES:
            try:
                self.last_max[t] = self.d.execute(
                    f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
            except Exception:
                self.last_max[t] = 0
        self.seen_sessions = set(r[0] for r in self.d.execute(
            "SELECT id FROM session").fetchall())
        self.setting_start = {r[0]: r[1] for r in self.d.execute(
            "SELECT id, value FROM setting").fetchall()}

    def ins(self, sql, params=()):
        self.d.execute(sql, params)
        self.d.commit()
        return self.d.execute("SELECT last_insert_rowid()").fetchone()[0]

    def opener(self):
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(f"{PHP}/login", timeout=20).read()
        return op, cj

    def csrf_of(self, cj):
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(self, op, cj, name, role, module, method, data=None,
             with_csrf=True, raw_body=None):
        if raw_body is not None:
            body = raw_body
        else:
            payload = flatten(dict(data or {}))
            if with_csrf and self.csrf_of(cj):
                payload["CSRFToken"] = self.csrf_of(cj)
            body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(
            f"{self.api}/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                parsed = json.loads(e.read().decode())
            except Exception:
                parsed = {"error": {"message": f"non-json HTTP {e.code}"}}
        self.env[name] = parsed
        return parsed

    def dump_delta(self, name):
        out = {}
        for t in DUMP_TABLES:
            cols = [r[1] for r in self.d.execute(f'PRAGMA table_info("{t}")')]
            rows = self.d.execute(
                f'SELECT * FROM "{t}" WHERE id > ?', (self.last_max[t],)).fetchall()
            new_max = self.d.execute(
                f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
            self.last_max[t] = max(self.last_max[t], new_max)
            if rows:
                dicts = [dict(zip(cols, r)) for r in rows]
                if t == "extension_meta":
                    for row in dicts:
                        if row.get("meta_key") == "config":
                            row["meta_value"] = "<encrypted>"
                out[t] = dicts
        new_sess = []
        for (sid, content) in self.d.execute("SELECT id, content FROM session").fetchall():
            if sid in self.seen_sessions:
                continue
            self.seen_sessions.add(sid)
            if isinstance(content, bytes):
                content = content.decode("utf-8", "replace")
            m = re.search(r's:5:"admin";a:\d+:\{s:2:"id";i:(\d+);'
                          r's:5:"email";s:\d+:"([^"]*)";s:4:"name";s:\d+:"([^"]*)"',
                          content or "")
            cm = re.search(r's:9:"client_id";i:(\d+);', content or "")
            new_sess.append({
                "admin": [int(m.group(1)), m.group(2), m.group(3)] if m else None,
                "client": int(cm.group(1)) if cm else None,
                "has_csrf": "csrf_token" in (content or ""),
            })
        # Identity-carrying sessions only. Null/null rows are priming
        # artifacts: PHP's client login leaves the pre-login priming
        # row orphaned (5 new rows) while the TS client login (ported
        # in an earlier batch, not this one) does not (4 new rows).
        # API envelopes are identical either way; comparing orphan
        # garbage would fail the gate on noise. The divergence is
        # documented in findings-r1h.md.
        new_sess = [s for s in new_sess if s["admin"] is not None or s["client"] is not None]
        if new_sess:
            new_sess.sort(key=lambda s: json.dumps(s, sort_keys=True))
            out["session_new"] = new_sess
        self.db[name] = scrub(out)
        return out

    def dump_changed_settings(self, name):
        changed = {}
        for rid, val in self.d.execute("SELECT id, value FROM setting").fetchall():
            if self.setting_start.get(rid) != val:
                changed[rid] = val
        self.db[name] = scrub(changed)


def run_sequence(base):
    r = Run(base)
    d = r.d
    op_a, cj_a = r.opener()
    r.call(op_a, cj_a, "tmp_staff_login", "guest", "staff", "login",
           {"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    op_n, cj_n = r.opener()
    op_c, cj_c = r.opener()
    r.call(op_c, cj_c, "tmp_client_login", "guest", "client", "login",
           {"email": CLIENT_EMAIL, "password": CLIENT_PASS})
    r.dump_delta("login_db")

    # ---------- formbuilder ---------- #
    r.call(op_a, cj_a, "fb_forms_empty", "admin", "formbuilder", "get_forms")
    r.call(op_a, cj_a, "fb_pairs_empty", "admin", "formbuilder", "get_pairs")
    r.call(op_a, cj_a, "fb_get_noid", "admin", "formbuilder", "get_form")
    r.call(op_a, cj_a, "fb_get_unknown", "admin", "formbuilder", "get_form", {"id": 999999})
    r.call(op_a, cj_a, "fb_create_noname", "admin", "formbuilder", "create_form")
    r.call(op_a, cj_a, "fb_create_badtype", "admin", "formbuilder", "create_form",
           {"name": "Bad", "type": "inline"})
    f1 = r.call(op_a, cj_a, "fb_create", "admin", "formbuilder", "create_form",
                {"name": "Cap26 Form"})["result"]
    f2 = r.call(op_a, cj_a, "fb_create_default", "admin", "formbuilder", "create_form",
                {"name": "Cap26 Default", "type": "default", "show_title": "1"})["result"]
    r.call(op_a, cj_a, "fb_get_f1", "admin", "formbuilder", "get_form", {"id": f1})
    r.call(op_a, cj_a, "fb_forms", "admin", "formbuilder", "get_forms")
    r.call(op_a, cj_a, "fb_add_notype", "admin", "formbuilder", "add_field", {"form_id": f1})
    r.call(op_a, cj_a, "fb_add_noform", "admin", "formbuilder", "add_field", {"type": "text"})
    r.call(op_a, cj_a, "fb_add_badtype", "admin", "formbuilder", "add_field",
           {"type": "bogus", "form_id": f1})
    r.call(op_a, cj_a, "fb_add_dupoptions", "admin", "formbuilder", "add_field",
           {"type": "select", "form_id": f1, "options": {"A": "1", "B": "1"}})
    fld_text = r.call(op_a, cj_a, "fb_add_text", "admin", "formbuilder", "add_field",
                      {"type": "text", "form_id": f1})["result"]
    fld_full = r.call(op_a, cj_a, "fb_add_text_full", "admin", "formbuilder", "add_field",
                      {"type": "text", "form_id": f1, "label": "Full Name", "name": "full_name",
                       "description": "Your name", "default_value": "John",
                       "required": 1, "prefix": "$", "text_size": 40})["result"]
    fld_select = r.call(op_a, cj_a, "fb_add_select", "admin", "formbuilder", "add_field",
                        {"type": "select", "form_id": f1,
                         "options": {"Custom A": "a", "Custom B": "b"}})["result"]
    fld_check = r.call(op_a, cj_a, "fb_add_checkbox", "admin", "formbuilder", "add_field",
                       {"type": "checkbox", "form_id": f1,
                        "default_value": ["a", "b"]})["result"]
    fld_area = r.call(op_a, cj_a, "fb_add_textarea", "admin", "formbuilder", "add_field",
                      {"type": "textarea", "form_id": f1})["result"]
    fld_url = r.call(op_a, cj_a, "fb_add_url", "admin", "formbuilder", "add_field",
                     {"type": "url", "form_id": f1})["result"]
    r.call(op_a, cj_a, "fb_fields_f1", "admin", "formbuilder", "get_form_fields",
           {"form_id": f1})
    r.call(op_a, cj_a, "fb_field_get_text", "admin", "formbuilder", "get_field",
           {"id": fld_text})
    r.call(op_a, cj_a, "fb_field_get_select", "admin", "formbuilder", "get_field",
           {"id": fld_select})
    r.call(op_a, cj_a, "fb_field_get_checkbox", "admin", "formbuilder", "get_field",
           {"id": fld_check})
    r.call(op_a, cj_a, "fb_field_unknown", "admin", "formbuilder", "get_field",
           {"id": 999999})
    r.call(op_a, cj_a, "fb_pairs", "admin", "formbuilder", "get_pairs")
    r.call(op_a, cj_a, "fb_get_f1_full", "admin", "formbuilder", "get_form", {"id": f1})
    r.call(op_a, cj_a, "fb_upd_noid", "admin", "formbuilder", "update_field",
           {"label": "X", "name": "x"})
    r.call(op_a, cj_a, "fb_upd_unknown", "admin", "formbuilder", "update_field",
           {"id": 999999, "label": "X", "name": "x"})
    r.call(op_a, cj_a, "fb_upd_text", "admin", "formbuilder", "update_field",
           {"id": fld_text, "label": "Renamed", "name": "renamed"})
    r.call(op_a, cj_a, "fb_upd_dupname", "admin", "formbuilder", "update_field",
           {"id": fld_text, "label": "Dup", "name": "full_name"})
    r.call(op_a, cj_a, "fb_upd_digitname", "admin", "formbuilder", "update_field",
           {"id": fld_text, "label": "Digit", "name": "9lives"})
    r.call(op_a, cj_a, "fb_upd_emptyname", "admin", "formbuilder", "update_field",
           {"id": fld_text, "label": "Empty", "name": ""})
    r.call(op_a, cj_a, "fb_upd_nonunique_opts", "admin", "formbuilder", "update_field",
           {"id": fld_text, "label": "R", "name": "renamed",
            "options": {"A": "1", "B": "1"}})
    r.call(op_a, cj_a, "fb_upd_select_values", "admin", "formbuilder", "update_field",
           {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
            "values": ["v1", "v2"], "labels": ["L1", "L2"]})
    r.call(op_a, cj_a, "fb_upd_select_dupvalues", "admin", "formbuilder", "update_field",
           {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
            "values": ["v1", "v1"], "labels": ["L1", "L2"]})
    r.call(op_a, cj_a, "fb_upd_select_duplabels", "admin", "formbuilder", "update_field",
           {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
            "values": ["v1", "v2"], "labels": ["L1", "L1"]})
    r.call(op_a, cj_a, "fb_upd_select_mismatch", "admin", "formbuilder", "update_field",
           {"id": fld_select, "label": "Choice", "name": "choice", "type": "select",
            "values": ["v1", "v2"], "labels": ["L1"]})
    r.call(op_a, cj_a, "fb_upd_textarea", "admin", "formbuilder", "update_field",
           {"id": fld_area, "label": "Notes", "name": "notes", "type": "textarea",
            "textarea_option": ["height", "width"], "textarea_size": ["120", "400"]})
    r.call(op_a, cj_a, "fb_upd_textarea_nosize", "admin", "formbuilder", "update_field",
           {"id": fld_area, "label": "Notes", "name": "notes", "type": "textarea",
            "textarea_option": ["height"]})
    r.call(op_a, cj_a, "fb_upd_textarea_nooption", "admin", "formbuilder", "update_field",
           {"id": fld_area, "label": "Notes", "name": "notes", "type": "textarea",
            "textarea_size": ["120"]})
    r.call(op_a, cj_a, "fb_upd_textarea_badsize", "admin", "formbuilder", "update_field",
           {"id": fld_area, "label": "Notes", "name": "notes", "type": "textarea",
            "textarea_option": ["height"], "textarea_size": ["big"]})
    r.call(op_a, cj_a, "fb_upd_select_novalues", "admin", "formbuilder", "update_field",
           {"id": fld_select, "label": "Choice", "name": "choice", "type": "select"})
    r.call(op_a, cj_a, "fb_copy_noid", "admin", "formbuilder", "copy_form",
           {"name": "Copy"})
    r.call(op_a, cj_a, "fb_copy_noname", "admin", "formbuilder", "copy_form",
           {"form_id": f1})
    f3 = r.call(op_a, cj_a, "fb_copy", "admin", "formbuilder", "copy_form",
                {"form_id": f1, "name": "Cap26 Copy"})["result"]
    r.call(op_a, cj_a, "fb_get_f3", "admin", "formbuilder", "get_form", {"id": f3})
    r.call(op_a, cj_a, "fb_settings_noid", "admin", "formbuilder", "update_form_settings",
           {"form_name": "X", "type": "default"})
    r.call(op_a, cj_a, "fb_settings_badtype", "admin", "formbuilder", "update_form_settings",
           {"form_id": f1, "form_name": "X", "type": "inline"})
    r.call(op_a, cj_a, "fb_settings", "admin", "formbuilder", "update_form_settings",
           {"form_id": f1, "form_name": "Cap26 Renamed", "type": "default"})
    r.call(op_a, cj_a, "fb_get_f1_after_settings", "admin", "formbuilder", "get_form",
           {"id": f1})
    r.call(op_a, cj_a, "fb_create_case_type", "admin", "formbuilder", "create_form",
           {"name": "Cap26 Case", "type": "Horizontal"})
    d.execute("UPDATE product SET form_id = ? WHERE id = 2", (f1,))
    d.commit()
    r.call(op_a, cj_a, "fb_delete_f1", "admin", "formbuilder", "delete_form", {"id": f1})
    prod2 = d.execute("SELECT form_id FROM product WHERE id = 2").fetchone()[0]
    r.db["fb_product2_after_delete"] = {"form_id": prod2}
    f3_field = d.execute(
        "SELECT id FROM form_field WHERE form_id = ? ORDER BY id LIMIT 1", (f3,)).fetchone()[0]
    r.call(op_a, cj_a, "fb_delfield_noid", "admin", "formbuilder", "delete_field")
    r.call(op_a, cj_a, "fb_delfield_unknown", "admin", "formbuilder", "delete_field",
           {"id": 999999})
    r.call(op_a, cj_a, "fb_delfield", "admin", "formbuilder", "delete_field",
           {"id": f3_field})
    r.call(op_a, cj_a, "fb_delform_noid", "admin", "formbuilder", "delete_form")
    r.call(op_a, cj_a, "fb_delform_unknown", "admin", "formbuilder", "delete_form",
           {"id": 999999})
    r.call(op_a, cj_a, "fb_delform_f2", "admin", "formbuilder", "delete_form", {"id": f2})
    r.call(op_a, cj_a, "fb_forms_after", "admin", "formbuilder", "get_forms")
    r.dump_delta("fb_db")
    op_g, cj_g = r.opener()
    r.call(op_g, cj_g, "fb_guest_get_unknown", "guest", "formbuilder", "get",
           {"id": 999999})
    r.call(op_g, cj_g, "fb_guest_get", "guest", "formbuilder", "get", {"id": f3})
    r.call(op_g, cj_g, "fb_guest_get_noid", "guest", "formbuilder", "get")
    r.call(op_n, cj_n, "fb_noauth", "admin", "formbuilder", "get_forms")

    # ---------- security (ported subset + proxied remainder) ---------- #
    r.call(op_a, cj_a, "sec_list", "admin", "security", "list_checks")
    r.call(op_a, cj_a, "sec_run_unknown_proxy", "admin", "security", "run_check", {"id": "nope"})
    r.call(op_a, cj_a, "sec_run_noid_proxy", "admin", "security", "run_check")
    r.call(op_a, cj_a, "sec_run_general_proxy", "admin", "security", "run_check",
           {"id": "generalCheck"})
    r.call(op_a, cj_a, "sec_run_phpversion_proxy", "admin", "security", "run_check",
           {"id": "phpVersion"})
    r.call(op_a, cj_a, "sec_run_webserver_proxy", "admin", "security", "run_check",
           {"id": "webserver"})
    r.call(op_a, cj_a, "sec_run_dangerous_proxy", "admin", "security", "run_check",
           {"id": "dangerousFunctions"})
    r.call(op_a, cj_a, "sec_run_all_proxy", "admin", "security", "run_checks")
    r.call(op_a, cj_a, "sec_ip_missing_proxy", "admin", "security", "ip_lookup")
    r.call(op_a, cj_a, "sec_ip_invalid_proxy", "admin", "security", "ip_lookup",
           {"ip": "not-an-ip"})
    r.call(op_a, cj_a, "sec_ip_loopback_proxy", "admin", "security", "ip_lookup",
           {"ip": "127.0.0.1"})
    r.call(op_a, cj_a, "sec_ip_public_proxy", "admin", "security", "ip_lookup",
           {"ip": "8.8.8.8"})
    r.call(op_a, cj_a, "sec_ip_v6loopback_proxy", "admin", "security", "ip_lookup",
           {"ip": "::1"})
    r.call(op_a, cj_a, "sec_rl_status", "admin", "security", "rate_limit_status")
    r.call(op_a, cj_a, "sec_rl_list", "admin", "security", "rate_limit_get_list")
    r.call(op_a, cj_a, "sec_rl_list_ip", "admin", "security", "rate_limit_get_list",
           {"ip": "127.0.0.1"})
    r.call(op_a, cj_a, "sec_rl_list_badip", "admin", "security", "rate_limit_get_list",
           {"ip": "bogus"})
    r.call(op_a, cj_a, "sec_rl_list_search", "admin", "security", "rate_limit_get_list",
           {"search": "api"})
    r.call(op_a, cj_a, "sec_rl_reset_noid", "admin", "security", "rate_limit_reset_ip")
    r.call(op_a, cj_a, "sec_rl_reset_badip", "admin", "security", "rate_limit_reset_ip",
           {"ip": "bogus"})
    r.call(op_a, cj_a, "sec_rl_reset", "admin", "security", "rate_limit_reset_ip",
           {"ip": "203.0.113.9"})
    r.call(op_a, cj_a, "sec_rl_reset_policy", "admin", "security", "rate_limit_reset_ip",
           {"ip": "203.0.113.9", "policy": "api_guest"})
    r.call(op_a, cj_a, "sec_rl_reset_all", "admin", "security", "rate_limit_reset_all")
    r.call(op_n, cj_n, "sec_noauth", "admin", "security", "list_checks")

    # ---------- redirect ---------- #
    r.call(op_a, cj_a, "rd_list_empty", "admin", "redirect", "get_list")
    r.call(op_a, cj_a, "rd_create_nopath", "admin", "redirect", "create",
           {"target": "https://example.com/x"})
    r.call(op_a, cj_a, "rd_create_notarget", "admin", "redirect", "create",
           {"path": "x"})
    r.call(op_a, cj_a, "rd_create_emptypath", "admin", "redirect", "create",
           {"path": "", "target": "https://example.com/x"})
    r.call(op_a, cj_a, "rd_create_traversal", "admin", "redirect", "create",
           {"path": "../etc", "target": "https://example.com/x"})
    r.call(op_a, cj_a, "rd_create_badtarget", "admin", "redirect", "create",
           {"path": "x", "target": "ftp://example.com/x"})
    r.call(op_a, cj_a, "rd_create_emptytarget", "admin", "redirect", "create",
           {"path": "x", "target": ""})
    r1 = r.call(op_a, cj_a, "rd_create", "admin", "redirect", "create",
                {"path": "/old/page/", "target": "https://example.com/new"})["result"]
    r2 = r.call(op_a, cj_a, "rd_create2", "admin", "redirect", "create",
                {"path": "gone", "target": "/local"})["result"]
    r.call(op_a, cj_a, "rd_list", "admin", "redirect", "get_list")
    r.call(op_a, cj_a, "rd_get", "admin", "redirect", "get", {"id": r1})
    r.call(op_a, cj_a, "rd_get_unknown", "admin", "redirect", "get", {"id": 999999})
    r.call(op_a, cj_a, "rd_get_noid", "admin", "redirect", "get")
    r.call(op_a, cj_a, "rd_update_path", "admin", "redirect", "update",
           {"id": r1, "path": "moved"})
    r.call(op_a, cj_a, "rd_get_after_path", "admin", "redirect", "get", {"id": r1})
    r.call(op_a, cj_a, "rd_update_target", "admin", "redirect", "update",
           {"id": r1, "target": "https://example.com/final"})
    r.call(op_a, cj_a, "rd_update_unknown", "admin", "redirect", "update",
           {"id": 999999, "path": "x"})
    before = d.execute(
        "SELECT updated_at FROM extension_meta WHERE id = ?", (r1,)).fetchone()[0]
    r.call(op_a, cj_a, "rd_update_nochange", "admin", "redirect", "update",
           {"id": r1, "path": "moved", "target": "https://example.com/final"})
    after = d.execute(
        "SELECT updated_at FROM extension_meta WHERE id = ?", (r1,)).fetchone()[0]
    r.db["rd_nochange_check"] = {"unchanged": before == after}
    r.call(op_a, cj_a, "rd_update_empty", "admin", "redirect", "update",
           {"id": r1, "path": ""})
    r.call(op_a, cj_a, "rd_delete", "admin", "redirect", "delete", {"id": r2})
    r.call(op_a, cj_a, "rd_list_after", "admin", "redirect", "get_list")
    r.call(op_a, cj_a, "rd_delete_unknown", "admin", "redirect", "delete",
           {"id": 999999})
    r.call(op_n, cj_n, "rd_noauth", "admin", "redirect", "get_list")
    r.dump_delta("rd_db")

    # ---------- antispam ---------- #
    r.call(op_a, cj_a, "as_config", "admin", "antispam", "get_config")
    op_g2, cj_g2 = r.opener()
    r.call(op_g2, cj_g2, "as_guest_recaptcha", "guest", "antispam", "recaptcha")
    r.call(op_a, cj_a, "as_block_noip", "admin", "antispam", "block_ip")
    r.call(op_a, cj_a, "as_block_badip", "admin", "antispam", "block_ip",
           {"ip": "bogus"})
    r.call(op_a, cj_a, "as_block_self", "admin", "antispam", "block_ip",
           {"ip": "127.0.0.1"})
    r.call(op_a, cj_a, "as_block", "admin", "antispam", "block_ip",
           {"ip": "203.0.113.5"})
    r.call(op_a, cj_a, "as_block_dup", "admin", "antispam", "block_ip",
           {"ip": "203.0.113.5"})
    r.call(op_a, cj_a, "as_blocked", "admin", "antispam", "get_blocked_ips")
    r.call(op_a, cj_a, "as_config_after", "admin", "antispam", "get_config")
    r.call(op_a, cj_a, "as_unblock_unknown", "admin", "antispam", "unblock_ip",
           {"ip": "203.0.113.6"})
    r.call(op_a, cj_a, "as_unblock", "admin", "antispam", "unblock_ip",
           {"ip": "203.0.113.5"})
    r.call(op_a, cj_a, "as_blocked_after", "admin", "antispam", "get_blocked_ips")
    r.call(op_a, cj_a, "as_config_final", "admin", "antispam", "get_config")
    r.call(op_n, cj_n, "as_noauth", "admin", "antispam", "get_config")
    r.dump_delta("as_db")

    # ---------- widgets ---------- #
    r.call(op_a, cj_a, "wg_list", "admin", "widgets", "list")
    r.call(op_a, cj_a, "wg_rebuild", "admin", "widgets", "rebuild")
    r.call(op_a, cj_a, "wg_list_after", "admin", "widgets", "list")
    r.call(op_n, cj_n, "wg_noauth", "admin", "widgets", "list")

    # ---------- seo (715 gate on this install) ---------- #
    r.call(op_a, cj_a, "seo_info", "admin", "seo", "info")
    r.call(op_a, cj_a, "seo_ping", "admin", "seo", "ping_all")
    r.call(op_a, cj_a, "seo_info_after", "admin", "seo", "info")
    r.call(op_n, cj_n, "seo_noauth", "admin", "seo", "info")

    # ---------- serviceapikey (715 gate on this install) ---------- #
    op_g3, cj_g3 = r.opener()
    r.call(op_g3, cj_g3, "sak_guest_nokey", "guest", "serviceapikey", "check")
    r.call(op_g3, cj_g3, "sak_guest_unknown", "guest", "serviceapikey", "check",
           {"key": "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA"})
    r.call(op_a, cj_a, "sak_admin_update_noid", "admin", "serviceapikey", "update")
    r.call(op_a, cj_a, "sak_admin_update_unknown", "admin", "serviceapikey", "update",
           {"order_id": 999})
    r.call(op_a, cj_a, "sak_admin_reset_neither", "admin", "serviceapikey", "reset")
    r.call(op_a, cj_a, "sak_admin_reset_unknownkey", "admin", "serviceapikey", "reset",
           {"key": "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA"})
    r.call(op_a, cj_a, "sak_admin_reset_unknownorder", "admin", "serviceapikey", "reset",
           {"order_id": 999})
    r.call(op_c, cj_c, "sak_client_reset_neither", "client", "serviceapikey", "reset")
    r.call(op_n, cj_n, "sak_client_reset_noauth", "client", "serviceapikey", "reset")

    # ---------- page / index / cookieconsent ---------- #
    r.call(op_a, cj_a, "page_pairs", "admin", "page", "get_pairs")
    r.call(op_n, cj_n, "page_pairs_noauth", "admin", "page", "get_pairs")
    r.call(op_n, cj_n, "idx_dashboard_noauth", "client", "index", "get_dashboard")
    r.call(op_c, cj_c, "idx_dashboard", "client", "index", "get_dashboard")
    op_g4, cj_g4 = r.opener()
    r.call(op_g4, cj_g4, "cc_message", "guest", "cookieconsent", "message")

    # ---------- activity ---------- #
    r.call(op_a, cj_a, "act_logemail_nosubject", "admin", "activity", "log_email",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "act_logemail_min", "admin", "activity", "log_email",
           {"subject": "Cap26 minimal"})
    r.call(op_a, cj_a, "act_logemail_full", "admin", "activity", "log_email",
           {"subject": "Cap26 full", "client_id": CLIENT_ID, "sender": "a@example.com",
            "recipients": "b@example.com", "content_html": "<p>Hi</p>",
            "content_text": "Hi"})
    r.call(op_n, cj_n, "act_logemail_noauth", "admin", "activity", "log_email",
           {"subject": "x"})
    r.dump_delta("act_db")

    # ---------- product ---------- #
    r.call(op_a, cj_a, "prod_pairs_default", "admin", "product", "get_pairs")
    r.call(op_a, cj_a, "prod_pairs_all", "admin", "product", "get_pairs",
           {"products_only": 0, "active_only": 0})
    r.call(op_a, cj_a, "prod_pairs_type_custom", "admin", "product", "get_pairs",
           {"type": "custom"})
    r.call(op_a, cj_a, "prod_pairs_type_hosting", "admin", "product", "get_pairs",
           {"type": "hosting"})
    r.call(op_n, cj_n, "prod_pairs_noauth", "admin", "product", "get_pairs")
    r.dump_changed_settings("changed_settings")
    return {"env": scrub(r.env), "db": r.db}


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    snaps = {}
    for t in TABLES:
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(),
                    [x[1] for x in d.execute(f'PRAGMA table_info("{t}")')])
    seq_q = ", ".join("?" * len(TABLES))
    snap_seq = d.execute(
        f"SELECT name, seq FROM sqlite_sequence WHERE name IN ({seq_q})", TABLES).fetchall()

    def restore():
        d.execute(f"DELETE FROM sqlite_sequence WHERE name IN ({seq_q})", TABLES)
        for name, seq in snap_seq:
            d.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (name, seq))
        for t in TABLES:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            d.executemany(f'INSERT INTO "{t}" (' + ",".join(cols) + ") VALUES ("
                          + ",".join("?" * len(cols)) + ")",
                          [tuple(x) for x in rows])
        d.commit()

    try:
        php = run_sequence(PHP)
        restore()
        nxt = run_sequence(NEXT)
    finally:
        restore()
        print("reference DB restored")

    mismatches = []
    for name in sorted(set(php["env"]) | set(nxt["env"])):
        if php["env"].get(name) != nxt["env"].get(name):
            mismatches.append(("env", name, php["env"].get(name), nxt["env"].get(name)))
    for name in sorted(set(php["db"]) | set(nxt["db"])):
        if php["db"].get(name) != nxt["db"].get(name):
            mismatches.append(("db", name, php["db"].get(name), nxt["db"].get(name)))

    total_env = len(php["env"])
    total_db = len(php["db"])
    print(f"envelopes: {total_env - sum(1 for k, *_ in mismatches if k == 'env')}/{total_env} match")
    print(f"db dumps:  {total_db - sum(1 for k, *_ in mismatches if k == 'db')}/{total_db} match")
    import difflib
    for kind, name, a, b in mismatches:
        print(f"\n=== MISMATCH {kind} {name} ===")
        al = json.dumps(a, indent=2, default=str, sort_keys=True).splitlines()
        bl = json.dumps(b, indent=2, default=str, sort_keys=True).splitlines()
        diff = list(difflib.unified_diff(al, bl, "PHP", "NEXT", lineterm=""))
        print("\n".join(diff[:80]))
        if len(diff) > 80:
            print(f"... ({len(diff) - 80} more diff lines)")
    if not mismatches:
        print("PARITY23 ALL MATCH")


if __name__ == "__main__":
    main()
