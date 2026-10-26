#!/usr/bin/env python3
"""Phase 5 R1 comms capture: email leftovers + massmailer + notification, vs PHP.

Modules massmailer/notification were activated on the reference install
2026-10-25 (extension rows + mod_massmailer table + default config
test_client_id=1) so PHP serves them; that activation is environment
setup, not test data, and is kept. Everything this script creates is
restored at the end from snapshots taken at the start.
"""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures23"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
NOW = "2026-10-25 12:00:00"


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
    # Snapshots for teardown.
    snap_templates = d.execute("SELECT * FROM email_template").fetchall()
    snap_tcols = [r[1] for r in d.execute("PRAGMA table_info(email_template)")]
    snap_groups = d.execute("SELECT * FROM email_template_group").fetchall()
    snap_gcols = [r[1] for r in d.execute("PRAGMA table_info(email_template_group)")]
    snap_queue_ids = [r[0] for r in d.execute("SELECT id FROM email_queue")]
    snap_history = d.execute("SELECT * FROM activity_client_email").fetchall()
    snap_hcols = [r[1] for r in d.execute("PRAGMA table_info(activity_client_email)")]

    def staff_opener():
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(f"{BASE}/login", timeout=20).read()
        return op, cj

    def csrf_of(cj):
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(op, cj, name, role, module, method, data=None, save=True, raw_json=False):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        if raw_json and csrf_of(cj):
            data = dict(data or {})
            data["CSRFToken"] = csrf_of(cj)
        body = json.dumps(data).encode() if raw_json else urllib.parse.urlencode(payload).encode()
        headers = {"Content-Type": "application/json"} if raw_json else {}
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST", headers=headers)
        try:
            with op.open(req, timeout=30) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            parsed = json.loads(e.read().decode())
        if save:
            (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
        ok = isinstance(parsed, dict) and parsed.get("error") is None
        manifest.append({"name": name, "ok": ok,
                         "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
        print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
        return parsed

    def seed_history(client_id, sender, recipients, subject):
        d.execute(
            "INSERT INTO activity_client_email (client_id, sender, recipients, subject, content_html, content_text, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (client_id, sender, recipients, subject, f"<p>{subject} html</p>", f"{subject} text", NOW, NOW))
        d.commit()
        return d.execute("SELECT last_insert_rowid()").fetchone()[0]

    def seed_template(code, subject, content, enabled=1, custom=1):
        d.execute(
            "INSERT INTO email_template (category, enabled, is_custom, is_overridden, subject, content, description, vars, action_code)"
            " VALUES ('comms23', ?, ?, 0, ?, ?, NULL, NULL, ?)",
            (enabled, custom, subject, content, code))
        d.commit()
        return d.execute("SELECT last_insert_rowid()").fetchone()[0]

    op_a, cj_a = staff_opener()
    call(op_a, cj_a, "tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}, save=False)
    op_c, cj_c = staff_opener()
    call(op_c, cj_c, "tmp_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}, save=False)

    # Seeded fixtures.
    h1 = seed_history(1, "sender@comms23.local", "phase0.client@example.com", "Comms23 history one")
    h2 = seed_history(2, "sender@comms23.local", "phase1.diag@example.com", "Comms23 history two")
    t2 = seed_template("comms23_send_client", "Hello {{ c.first_name }}",
                       "Dear {{ c.first_name }} {{ c.last_name }}, your email is {{ c.email }}.")
    t3 = seed_template("comms23_send_staff", "Staff note {{ staff.name }}", "Hello {{ staff.name }}.")
    t4 = seed_template("comms23_disabled", "Disabled subject", "Disabled body.", enabled=0)
    tbroken = seed_template("comms23_broken", "Broken", "{% if c.first_name %}oops")
    t6 = seed_template("comms23_novar", "No var", "Hello {{ nosuchvar }}.")
    # T3 is staff-grouped (group 1 -> admin 1); T3E has no groups on purpose.
    d.execute("INSERT INTO email_template_group (admin_group_id, created_at, email_template_id) VALUES (1, ?, ?)", (NOW, t3))
    t3e = seed_template("comms23_staff_nogroup", "Staff note {{ staff.name }}", "Hello {{ staff.name }}.")
    d.commit()
    print("seeded history", h1, h2, "templates", t2, t3, t4, tbroken, t6, t3e)

    # --- email template create / groups ---
    t1 = call(op_a, cj_a, "admin_template_create_plain", "admin", "email", "template_create",
              {"action_code": "comms23_custom", "subject": "Comms23 custom subject",
               "content": "Comms23 custom body.", "enabled": 1, "category": "comms23"})["result"]
    call(op_a, cj_a, "admin_template_create_var", "admin", "email", "template_create",
         {"action_code": "comms23_var", "subject": "Hi {{ c.first_name }}",
          "content": "Body {{ c.first_name }}"})
    call(op_a, cj_a, "admin_template_create_missing", "admin", "email", "template_create",
         {"action_code": "comms23_nosubject"})
    call(op_a, cj_a, "admin_group_list_7", "admin", "email", "template_group_get_list", {"id": 7})
    call(op_a, cj_a, "admin_group_list_missing", "admin", "email", "template_group_get_list", {})
    call(op_a, cj_a, "admin_group_list_notfound", "admin", "email", "template_group_get_list", {"id": 99999})
    call(op_a, cj_a, "admin_group_add_dup", "admin", "email", "template_group_add", {"id": 7, "group_id": 1})
    call(op_a, cj_a, "admin_group_add_t1", "admin", "email", "template_group_add", {"id": t1, "group_id": 2})
    call(op_a, cj_a, "admin_group_list_t1", "admin", "email", "template_group_get_list", {"id": t1})
    call(op_a, cj_a, "admin_group_add_badgroup", "admin", "email", "template_group_add", {"id": 7, "group_id": 999})
    call(op_a, cj_a, "admin_group_add_notfound", "admin", "email", "template_group_add", {"id": 99999, "group_id": 1})
    call(op_a, cj_a, "admin_group_remove_t1", "admin", "email", "template_group_remove", {"id": t1, "group_id": 2})
    call(op_a, cj_a, "admin_group_list_t1_after", "admin", "email", "template_group_get_list", {"id": t1})
    call(op_a, cj_a, "admin_group_remove_absent", "admin", "email", "template_group_remove", {"id": t1, "group_id": 2})

    # --- template_send error pins + sends ---
    call(op_a, cj_a, "admin_template_send_nocode", "admin", "email", "template_send", {"to": "x@example.com"})
    call(op_a, cj_a, "admin_template_send_noreceiver", "admin", "email", "template_send", {"code": "comms23_custom"})
    call(op_a, cj_a, "admin_template_send_billing", "admin", "email", "template_send",
         {"code": "comms23_custom", "to": "x@example.com", "client_billing_email": "x@example.com"})
    call(op_a, cj_a, "admin_template_send_both", "admin", "email", "template_send",
         {"code": "comms23_custom", "to": "x@example.com", "to_client": 1})
    call(op_a, cj_a, "admin_template_send_adminonly", "admin", "email", "template_send",
         {"code": "comms23_custom", "to_admin": 1})
    call(op_a, cj_a, "admin_template_send_plain", "admin", "email", "template_send",
         {"code": "comms23_custom", "to": "comms23@example.com", "to_name": "Comms Tester"})
    call(op_a, cj_a, "admin_template_send_client", "admin", "email", "template_send",
         {"code": "comms23_send_client", "to_client": 1})
    call(op_a, cj_a, "admin_template_send_client_missing", "admin", "email", "template_send",
         {"code": "comms23_send_client", "to_client": 99999})
    call(op_a, cj_a, "admin_template_send_staff_nogroups", "admin", "email", "template_send",
         {"code": "comms23_custom", "to_staff": 1})
    call(op_a, cj_a, "admin_template_send_staff", "admin", "email", "template_send",
         {"code": "comms23_send_staff", "to_staff": 1})
    call(op_a, cj_a, "admin_template_send_staff_err", "admin", "email", "template_send",
         {"code": "comms23_staff_nogroup", "to_staff": 1})
    call(op_a, cj_a, "admin_template_send_novar", "admin", "email", "template_send",
         {"code": "comms23_novar", "to": "comms23@example.com"})
    call(op_a, cj_a, "admin_template_send_to_admin", "admin", "email", "template_send",
         {"code": "comms23_custom", "to": "ignored@example.com", "to_admin": 1})
    call(op_a, cj_a, "admin_template_send_disabled", "admin", "email", "template_send",
         {"code": "comms23_disabled", "to": "comms23@example.com"})
    call(op_a, cj_a, "admin_template_send_newcode", "admin", "email", "template_send",
         {"code": "comms23_newcode", "to": "comms23@example.com",
          "default_subject": "Comms23 new subject", "default_template": "Comms23 new body."})
    newcode_id = d.execute("SELECT id FROM email_template WHERE action_code = 'comms23_newcode'").fetchone()
    print("newcode template id:", newcode_id)
    if newcode_id:
        call(op_a, cj_a, "admin_template_get_newcode", "admin", "email", "template_get", {"id": newcode_id[0]})
    call(op_a, cj_a, "admin_template_send_filedefault", "admin", "email", "template_send",
         {"code": "mod_email_test", "to": "comms23@example.com", "to_name": "Comms Tester"})
    filedef_id = d.execute("SELECT id FROM email_template WHERE action_code = 'mod_email_test'").fetchone()
    print("mod_email_test template id:", filedef_id)
    if filedef_id:
        call(op_a, cj_a, "admin_template_get_filedefault", "admin", "email", "template_get", {"id": filedef_id[0]})

    # Queue rows created by the sends above (for the parity script's reference).
    qrows = d.execute(
        "SELECT id, recipient, sender, subject, substr(content, 1, 120), to_name, from_name, client_id, admin_id, priority, tries, status"
        " FROM email_queue WHERE id NOT IN (%s) ORDER BY id" % ",".join("?" * len(snap_queue_ids)),
        snap_queue_ids).fetchall() if snap_queue_ids else []
    (OUT / "send_queue_rows.json").write_text(json.dumps(qrows, indent=2))
    print("new queue rows:", len(qrows))

    # --- get_queue ---
    call(op_a, cj_a, "admin_get_queue_default", "admin", "email", "get_queue", {})
    call(op_a, cj_a, "admin_get_queue_pending", "admin", "email", "get_queue", {"status": "pending"})
    call(op_a, cj_a, "admin_get_queue_client1", "admin", "email", "get_queue", {"client_id": 1})
    call(op_a, cj_a, "admin_get_queue_sort_subject", "admin", "email", "get_queue", {"sort": "subject", "direction": "ASC"})

    # --- validate_all (broken template present) ---
    call(op_a, cj_a, "admin_template_validate_all", "admin", "email", "template_validate_all", {})
    call(op_a, cj_a, "admin_template_get_broken_after_validate", "admin", "email", "template_get", {"id": tbroken})

    # --- batch deletes (templates + history) ---
    call(op_a, cj_a, "admin_batch_template_delete_missing", "admin", "email", "batch_template_delete", {})
    call(op_a, cj_a, "admin_batch_template_delete", "admin", "email", "batch_template_delete", {"ids": [t1, 3]})
    call(op_a, cj_a, "admin_template_get_t1_after_delete", "admin", "email", "template_get", {"id": t1})
    call(op_a, cj_a, "admin_template_get_3_after_delete", "admin", "email", "template_get", {"id": 3})
    call(op_a, cj_a, "admin_batch_template_delete_partial", "admin", "email", "batch_template_delete", {"ids": [t2, 99999]})
    call(op_a, cj_a, "admin_template_get_t2_after_delete", "admin", "email", "template_get", {"id": t2})
    call(op_a, cj_a, "admin_batch_delete_missing", "admin", "email", "batch_delete", {})
    call(op_a, cj_a, "admin_batch_delete_h2", "admin", "email", "batch_delete", {"ids": [h2]})
    call(op_a, cj_a, "admin_batch_delete_notfound", "admin", "email", "batch_delete", {"ids": [99999]})

    # --- reset / generate / disable / enable ---
    call(op_a, cj_a, "admin_template_update_override4", "admin", "email", "template_update",
         {"id": 4, "subject": "Comms23 override"})
    call(op_a, cj_a, "admin_template_get_4_overridden", "admin", "email", "template_get", {"id": 4})
    call(op_a, cj_a, "admin_template_reset_4", "admin", "email", "template_reset", {"code": "mod_invoice_paid"})
    call(op_a, cj_a, "admin_template_get_4_reset", "admin", "email", "template_get", {"id": 4})
    t5 = call(op_a, cj_a, "admin_template_create_t5", "admin", "email", "template_create",
              {"action_code": "comms23_resetme", "subject": "Reset me", "content": "Reset body."})["result"]
    call(op_a, cj_a, "admin_template_reset_custom", "admin", "email", "template_reset", {"code": "comms23_resetme"})
    call(op_a, cj_a, "admin_template_reset_missing_code", "admin", "email", "template_reset", {})
    call(op_a, cj_a, "admin_template_reset_nodefault", "admin", "email", "template_reset", {"code": "xyz_nope"})
    call(op_a, cj_a, "admin_template_update_override3", "admin", "email", "template_update",
         {"id": 3, "subject": "Comms23 override three"})
    total_before = call(op_a, cj_a, "admin_template_list_before_generate", "admin", "email", "template_get_list", {})["result"]["total"]
    call(op_a, cj_a, "admin_batch_template_generate", "admin", "email", "batch_template_generate", {})
    call(op_a, cj_a, "admin_template_get_3_generated", "admin", "email", "template_get", {"id": 3})
    total_after_gen = call(op_a, cj_a, "admin_template_list_after_generate", "admin", "email", "template_get_list", {})["result"]["total"]
    print("template totals before/after generate:", total_before, total_after_gen)
    call(op_a, cj_a, "admin_batch_template_disable", "admin", "email", "batch_template_disable", {})
    total_after_dis = call(op_a, cj_a, "admin_template_list_after_disable", "admin", "email", "template_get_list", {})["result"]["total"]
    call(op_a, cj_a, "admin_template_get_3_disabled", "admin", "email", "template_get", {"id": 3})
    print("template total after disable (sync may create):", total_after_dis)
    call(op_a, cj_a, "admin_batch_template_enable", "admin", "email", "batch_template_enable", {})
    call(op_a, cj_a, "admin_template_get_3_enabled", "admin", "email", "template_get", {"id": 3})

    # --- client email history ---
    h1b = seed_history(1, "sender@comms23.local", "phase0.client@example.com", "Comms23 history one")
    h2b = seed_history(2, "sender@comms23.local", "phase1.diag@example.com", "Comms23 history two")
    call(op_c, cj_c, "client_email_list", "client", "email", "get_list", {})
    call(op_c, cj_c, "client_email_list_forced", "client", "email", "get_list", {"client_id": 2})
    call(op_c, cj_c, "client_email_list_sender", "client", "email", "get_list", {"sender": "comms23.local"})
    call(op_c, cj_c, "client_email_list_search", "client", "email", "get_list", {"search": "history one"})
    call(op_c, cj_c, "client_email_list_date_in", "client", "email", "get_list", {"date_from": "2026-10-25", "date_to": "2026-10-25"})
    call(op_c, cj_c, "client_email_list_date_out", "client", "email", "get_list", {"date_from": "2026-10-26"})
    call(op_c, cj_c, "client_email_get", "client", "email", "get", {"id": h1b})
    call(op_c, cj_c, "client_email_get_other", "client", "email", "get", {"id": h2b})
    call(op_c, cj_c, "client_email_get_missing", "client", "email", "get", {})
    call(op_c, cj_c, "client_email_resend", "client", "email", "resend", {"id": h1b})
    call(op_c, cj_c, "client_email_resend_missing", "client", "email", "resend", {"id": 99999})
    call(op_c, cj_c, "client_email_delete", "client", "email", "delete", {"id": h1b})
    call(op_c, cj_c, "client_email_get_after_delete", "client", "email", "get", {"id": h1b})
    call(op_c, cj_c, "client_email_delete_missing", "client", "email", "delete", {"id": 99999})

    # --- massmailer ---
    call(op_a, cj_a, "admin_mm_list_empty", "admin", "massmailer", "get_list", {})
    m1 = call(op_a, cj_a, "admin_mm_create", "admin", "massmailer", "create",
              {"subject": "Comms23 Alpha", "content": "Hello {{ c.first_name }} {{ c.last_name }}, your email is {{ c.email }}."})["result"]
    m2 = call(op_a, cj_a, "admin_mm_create_beta", "admin", "massmailer", "create",
              {"subject": "Comms23 Beta", "content": "Beta body."})["result"]
    m3 = call(op_a, cj_a, "admin_mm_create_empty", "admin", "massmailer", "create",
              {"subject": "Comms23 Empty", "content": ""})["result"]
    call(op_a, cj_a, "admin_mm_create_nosubject", "admin", "massmailer", "create", {"content": "x"})
    mdef = call(op_a, cj_a, "admin_mm_create_default", "admin", "massmailer", "create",
                {"subject": "Comms23 Default"})["result"]
    call(op_a, cj_a, "admin_mm_get_default", "admin", "massmailer", "get", {"id": mdef})
    call(op_a, cj_a, "admin_mm_get", "admin", "massmailer", "get", {"id": m1})
    call(op_a, cj_a, "admin_mm_get_missing", "admin", "massmailer", "get", {})
    call(op_a, cj_a, "admin_mm_get_notfound", "admin", "massmailer", "get", {"id": 99999})
    call(op_a, cj_a, "admin_mm_update", "admin", "massmailer", "update",
         {"id": m1, "subject": "Comms23 Alpha Updated", "content": "Updated {{ c.first_name }}.",
          "filter": {"client_status": ["active"]}}, raw_json=True)
    call(op_a, cj_a, "admin_mm_get_updated", "admin", "massmailer", "get", {"id": m1})
    call(op_a, cj_a, "admin_mm_update_badfilter", "admin", "massmailer", "update",
         {"id": m1, "filter": {"client_status": ["bogus"]}}, raw_json=True)
    call(op_a, cj_a, "admin_mm_update_badfilter_key", "admin", "massmailer", "update",
         {"id": m1, "filter": {"nope": ["active"]}}, raw_json=True)
    call(op_a, cj_a, "admin_mm_update_empty_fromname", "admin", "massmailer", "update",
         {"id": m1, "from_name": ""})
    call(op_a, cj_a, "admin_mm_update_bademail", "admin", "massmailer", "update",
         {"id": m1, "from_email": "not-an-email"})
    call(op_a, cj_a, "admin_mm_update_missing", "admin", "massmailer", "update", {})
    call(op_a, cj_a, "admin_mm_receivers_all", "admin", "massmailer", "receivers", {"id": m1})
    call(op_a, cj_a, "admin_mm_update_filter_beta", "admin", "massmailer", "update",
         {"id": m2, "filter": {"client_status": ["active"]}}, raw_json=True)
    call(op_a, cj_a, "admin_mm_receivers_beta", "admin", "massmailer", "receivers", {"id": m2})
    call(op_a, cj_a, "admin_mm_update_filter_groups", "admin", "massmailer", "update",
         {"id": m2, "filter": {"client_groups": [1]}}, raw_json=True)
    call(op_a, cj_a, "admin_mm_receivers_groups", "admin", "massmailer", "receivers", {"id": m2})
    call(op_a, cj_a, "admin_mm_preview", "admin", "massmailer", "preview", {"id": m1})
    call(op_a, cj_a, "admin_mm_preview_recipients", "admin", "massmailer", "preview",
         {"id": m1, "include_recipients": True})
    call(op_a, cj_a, "admin_mm_preview_missing", "admin", "massmailer", "preview", {})
    call(op_a, cj_a, "admin_mm_send_test", "admin", "massmailer", "send_test", {"id": m1})
    call(op_a, cj_a, "admin_mm_send_test_empty", "admin", "massmailer", "send_test", {"id": m3})
    call(op_a, cj_a, "admin_mm_send", "admin", "massmailer", "send", {"id": m2})
    call(op_a, cj_a, "admin_mm_get_sent", "admin", "massmailer", "get", {"id": m2})
    call(op_a, cj_a, "admin_mm_send_empty", "admin", "massmailer", "send", {"id": m3})
    mcopy = call(op_a, cj_a, "admin_mm_copy", "admin", "massmailer", "copy", {"id": m1})["result"]
    call(op_a, cj_a, "admin_mm_get_copy", "admin", "massmailer", "get", {"id": mcopy})
    call(op_a, cj_a, "admin_mm_delete_copy", "admin", "massmailer", "delete", {"id": mcopy})
    call(op_a, cj_a, "admin_mm_test_client", "admin", "massmailer", "get_test_client", {})
    call(op_a, cj_a, "admin_mm_list_status_sent", "admin", "massmailer", "get_list", {"status": "sent"})
    call(op_a, cj_a, "admin_mm_list_search", "admin", "massmailer", "get_list", {"search": "Alpha"})
    call(op_a, cj_a, "admin_mm_list_sort_subject", "admin", "massmailer", "get_list", {"sort": "subject", "direction": "ASC"})

    # --- notification ---
    call(op_a, cj_a, "admin_notif_list_empty", "admin", "notification", "get_list", {})
    n1 = call(op_a, cj_a, "admin_notif_add_one", "admin", "notification", "add", {"message": "Comms23 notice one"})["result"]
    n2 = call(op_a, cj_a, "admin_notif_add_two", "admin", "notification", "add", {"message": "Comms23 notice two"})["result"]
    call(op_a, cj_a, "admin_notif_list", "admin", "notification", "get_list", {})
    call(op_a, cj_a, "admin_notif_list_search", "admin", "notification", "get_list", {"search": "notice one"})
    call(op_a, cj_a, "admin_notif_list_date", "admin", "notification", "get_list",
         {"date_from": "2026-10-25", "date_to": "2026-10-26"})
    call(op_a, cj_a, "admin_notif_get", "admin", "notification", "get", {"id": n1})
    call(op_a, cj_a, "admin_notif_get_missing", "admin", "notification", "get", {})
    call(op_a, cj_a, "admin_notif_get_notfound", "admin", "notification", "get", {"id": 99999})
    call(op_a, cj_a, "admin_notif_add_nomessage", "admin", "notification", "add", {})
    n_empty = call(op_a, cj_a, "admin_notif_add_empty", "admin", "notification", "add", {"message": ""})["result"]
    print("empty-message notification id:", n_empty)
    call(op_a, cj_a, "admin_notif_delete_two", "admin", "notification", "delete", {"id": n2})
    call(op_a, cj_a, "admin_notif_delete_missing", "admin", "notification", "delete", {})
    call(op_a, cj_a, "admin_notif_delete_notfound", "admin", "notification", "delete", {"id": 99999})
    call(op_a, cj_a, "admin_notif_delete_all", "admin", "notification", "delete_all", {})
    call(op_a, cj_a, "admin_notif_list_after_all", "admin", "notification", "get_list", {})

    # --- teardown: restore snapshots ---
    d.execute("DELETE FROM email_template")
    for row in snap_templates:
        d.execute(f"INSERT INTO email_template ({','.join(snap_tcols)}) VALUES ({','.join('?' * len(row))})", row)
    d.execute("DELETE FROM email_template_group")
    for row in snap_groups:
        d.execute(f"INSERT INTO email_template_group ({','.join(snap_gcols)}) VALUES ({','.join('?' * len(row))})", row)
    if snap_queue_ids:
        d.execute("DELETE FROM email_queue WHERE id NOT IN (%s)" % ",".join("?" * len(snap_queue_ids)), snap_queue_ids)
    else:
        d.execute("DELETE FROM email_queue")
    d.execute("DELETE FROM activity_client_email")
    for row in snap_history:
        d.execute(f"INSERT INTO activity_client_email ({','.join(snap_hcols)}) VALUES ({','.join('?' * len(row))})", row)
    d.execute("DELETE FROM mod_massmailer")
    d.execute("DELETE FROM extension_meta WHERE extension = 'mod_notification' AND meta_key = 'message'")
    d.commit()
    print("teardown done; templates:", d.execute("SELECT COUNT(*) FROM email_template").fetchone()[0],
          "queue:", d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0],
          "massmailer:", d.execute("SELECT COUNT(*) FROM mod_massmailer").fetchone()[0])

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
