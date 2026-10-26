#!/usr/bin/env python3
"""Phase 5 core-CRUD capture 1: Client module against PHP.
Creates throwaway clients (deleted at the end via batch_delete
where possible, else SQL) and never mutates seeded clients'
passwords. Balance rows created for client 1 are deleted."""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures19"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_PW = "Phase0-Client!42"
THROW_PW = "Throw-Client!42"
THROW_NEW = "Throw-Client!99"


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        elif isinstance(v, list):
            for i, item in enumerate(v):
                out[f"{key}[{i}]"] = item
        else:
            out[key] = v
    return out


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def csrf_of(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value


def call(op, cj, name, role, module, method, data=None, raw=False):
    payload = flatten(dict(data or {}))
    if csrf_of(cj):
        payload["CSRFToken"] = csrf_of(cj)
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=30) as resp:
            body = resp.read()
            ctype = resp.headers.get_content_type()
    except urllib.error.HTTPError as e:
        body = e.read()
        ctype = e.headers.get_content_type()
    if raw or ctype != "application/json":
        (OUT / f"{name}.txt").write_bytes(body)
        print("RAW", name, ctype, len(body))
        manifest.append({"name": name, "ok": True, "error": None, "raw": True})
        return {"raw": body[:200].decode(errors="replace")}
    parsed = json.loads(body.decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def login_staff(password=ADMIN_PW):
    op, cj = make_opener()
    op.open(f"{BASE}/login", timeout=20).read()
    call(op, cj, "tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": password})
    return op, cj


def login_client(email, password):
    op, cj = make_opener()
    op.open(f"{BASE}/login", timeout=20).read()
    call(op, cj, "tmp_client_login", "guest", "client", "login",
         {"email": email, "password": password})
    return op, cj


def main():
    d = sqlite3.connect(DBP)
    # Idempotency: remove leftovers from aborted runs.
    d.execute("DELETE FROM client WHERE email LIKE 'cap19%@example.com' OR email LIKE 'admintest19@example.com' OR email LIKE 'retry19-%@example.com'")
    d.commit()
    op_a, cj_a = login_staff()
    # The Antispam temp-email check (default ON) fetches a remote
    # disposable-domain list that fails at the sandbox TLS layer,
    # 500ing every guest signup. Disable it via PHP's own config
    # API for the capture; the row is deleted at the end to
    # restore the no-config default.
    call(op_a, cj_a, "tmp_antispam_disable", "admin", "extension", "config_save",
         {"ext": "mod_antispam", "check_temp_emails": 0})

    # --- guest config reads ---
    op_g, cj_g = make_opener()
    op_g.open(f"{BASE}/login", timeout=20).read()
    call(op_g, cj_g, "guest_required", "guest", "client", "required")
    call(op_g, cj_g, "guest_custom_fields", "guest", "client", "custom_fields")
    call(op_g, cj_g, "guest_is_email_validation_required", "guest", "client", "is_email_validation_required")

    # --- guest create: errors, then success ---
    call(op_g, cj_g, "guest_create_missing", "guest", "client", "create", {"first_name": "Cap"})
    call(op_g, cj_g, "guest_create_mismatch", "guest", "client", "create",
         {"email": "cap19a@example.com", "first_name": "Cap", "password": THROW_PW, "password_confirm": "Other!99"})
    call(op_g, cj_g, "guest_create_weak", "guest", "client", "create",
         {"email": "cap19a@example.com", "first_name": "Cap", "password": "weak", "password_confirm": "weak"})
    r = call(op_g, cj_g, "guest_create_ok", "guest", "client", "create",
             {"email": "cap19a@example.com", "first_name": "Cap", "password": THROW_PW, "password_confirm": THROW_PW})
    tid = d.execute("SELECT id FROM client WHERE email = 'cap19a@example.com'").fetchone()[0]
    print("throwaway client id:", tid)
    # guest create auto-logs in: prove with a client call on the same jar
    call(op_g, cj_g, "guest_create_autologin_profile", "client", "profile", "get")
    # duplicate signup: enumeration-safe true + login attempt with given pw
    call(op_g, cj_g, "guest_create_duplicate", "guest", "client", "create",
         {"email": "cap19a@example.com", "first_name": "Cap", "password": THROW_PW, "password_confirm": THROW_PW})
    call(op_g, cj_g, "guest_create_duplicate_profile", "client", "profile", "get")

    # --- guest login errors ---
    op_x, cj_x = make_opener()
    op_x.open(f"{BASE}/login", timeout=20).read()
    call(op_x, cj_x, "guest_login_wrong_pw", "guest", "client", "login",
         {"email": "cap19a@example.com", "password": "Wrong!99"})
    call(op_x, cj_x, "guest_login_unknown", "guest", "client", "login",
         {"email": "nobody19@example.com", "password": "Whatever!99"})

    # --- admin create / update / groups ---
    call(op_a, cj_a, "admin_create_missing", "admin", "client", "create", {"first_name": "NoMail"})
    call(op_a, cj_a, "admin_create_dup", "admin", "client", "create",
         {"email": "cap19a@example.com", "first_name": "Dup", "password": THROW_PW, "send_welcome_email": 0})
    call(op_a, cj_a, "admin_create_no_pw_no_welcome", "admin", "client", "create",
         {"email": "cap19b@example.com", "first_name": "NoPw", "send_welcome_email": 0})
    call(op_a, cj_a, "admin_create_welcome_nonactive", "admin", "client", "create",
         {"email": "cap19b@example.com", "first_name": "NonAct", "status": "suspended", "send_welcome_email": 1})
    r = call(op_a, cj_a, "admin_create_ok", "admin", "client", "create",
             {"email": "cap19b@example.com", "first_name": "Bee", "last_name": "Cap", "password": THROW_PW,
              "send_welcome_email": 0, "country": "US", "phone_cc": "1", "phone": "5125550199"})
    bid = r["result"]
    print("admin-created client id:", bid)
    call(op_a, cj_a, "admin_update_ok", "admin", "client", "update",
         {"id": bid, "last_name": "CapUpdated", "city": "Austin", "custom_1": "cap19"})
    call(op_a, cj_a, "admin_update_dup_email", "admin", "client", "update",
         {"id": bid, "email": "phase0.client@example.com"})
    call(op_a, cj_a, "admin_update_bad_country", "admin", "client", "update",
         {"id": bid, "country": "XX"})
    call(op_a, cj_a, "admin_update_bad_lang", "admin", "client", "update",
         {"id": bid, "lang": "xx_XX"})
    call(op_a, cj_a, "admin_update_bad_tz", "admin", "client", "update",
         {"id": bid, "timezone": "Not/AZone"})
    call(op_a, cj_a, "admin_update_missing", "admin", "client", "update", {"id": 99999, "city": "X"})
    call(op_a, cj_a, "admin_get_statuses", "admin", "client", "get_statuses")

    # --- groups ---
    r = call(op_a, cj_a, "admin_group_create", "admin", "client", "group_create", {"title": "Capture19 Group"})
    gid = r["result"]
    call(op_a, cj_a, "admin_group_get", "admin", "client", "group_get", {"id": gid})
    call(op_a, cj_a, "admin_group_update", "admin", "client", "group_update", {"id": gid, "title": "Capture19 Group Renamed"})
    call(op_a, cj_a, "admin_group_get_pairs", "admin", "client", "group_get_pairs")
    call(op_a, cj_a, "admin_update_assign_group", "admin", "client", "update", {"id": bid, "group_ids": [gid]})
    call(op_a, cj_a, "admin_group_delete_blocked", "admin", "client", "group_delete", {"id": gid})
    # NOTE: an empty list encodes to zero form keys, so PHP never
    # sees group_ids at all; an empty string survives as a key and
    # PHP's filter turns it into [] (clear all memberships).
    call(op_a, cj_a, "admin_update_unassign_group", "admin", "client", "update", {"id": bid, "group_ids": ""})
    call(op_a, cj_a, "admin_group_delete_ok", "admin", "client", "group_delete", {"id": gid})
    call(op_a, cj_a, "admin_group_get_missing", "admin", "client", "group_get", {"id": gid})

    # --- admin change_password on throwaway ---
    call(op_a, cj_a, "admin_change_pw_missing", "admin", "client", "change_password", {"id": bid})
    call(op_a, cj_a, "admin_change_pw_mismatch", "admin", "client", "change_password",
         {"id": bid, "password": THROW_NEW, "password_confirm": "Other!99"})
    call(op_a, cj_a, "admin_change_pw_weak", "admin", "client", "change_password",
         {"id": bid, "password": "weak", "password_confirm": "weak"})
    call(op_a, cj_a, "admin_change_pw_missing_client", "admin", "client", "change_password",
         {"id": 99999, "password": THROW_NEW, "password_confirm": THROW_NEW})
    call(op_a, cj_a, "admin_change_pw_ok", "admin", "client", "change_password",
         {"id": bid, "password": THROW_NEW, "password_confirm": THROW_NEW})
    op_b, cj_b = login_client("cap19b@example.com", THROW_NEW)
    call(op_a, cj_a, "admin_change_pw_back", "admin", "client", "change_password",
         {"id": bid, "password": THROW_PW, "password_confirm": THROW_PW})

    # --- admin impersonation ---
    call(op_a, cj_a, "admin_login_impersonate", "admin", "client", "login", {"id": tid})
    call(op_a, cj_a, "admin_impersonated_profile", "client", "profile", "get")
    call(op_a, cj_a, "admin_login_impersonate_strip", "admin", "client", "login",
         {"id": tid, "strip_admin_identity": 1})
    call(op_a, cj_a, "admin_after_strip", "admin", "profile", "get")
    call(op_a, cj_a, "admin_stripped_client_profile", "client", "profile", "get")
    op_a, cj_a = login_staff()

    # --- balances (client 1 + currency-less throwaway) ---
    call(op_a, cj_a, "admin_balance_add_funds_nocurrency", "admin", "client", "balance_add_funds",
         {"id": bid, "amount": 10, "description": "cap19"})
    call(op_a, cj_a, "admin_balance_add_funds_missing", "admin", "client", "balance_add_funds", {"id": 1})
    call(op_a, cj_a, "admin_balance_add_funds_ok", "admin", "client", "balance_add_funds",
         {"id": 1, "amount": 25, "description": "capture19 funds"})
    brow = d.execute("SELECT id FROM client_balance WHERE client_id = 1 AND description = 'capture19 funds' ORDER BY id DESC LIMIT 1").fetchone()
    print("balance row:", brow)
    call(op_a, cj_a, "admin_balance_get_list", "admin", "client", "balance_get_list", {"client_id": 1})
    op_c, cj_c = login_client("phase0.client@example.com", CLIENT_PW)
    call(op_c, cj_c, "client_balance_get_list", "client", "client", "balance_get_list")
    call(op_c, cj_c, "client_balance_get_total", "client", "client", "balance_get_total")
    call(op_c, cj_c, "client_is_taxable", "client", "client", "is_taxable")
    call(op_c, cj_c, "client_resend_email_verification", "client", "client", "resend_email_verification")
    if brow:
        call(op_a, cj_a, "admin_balance_delete_ok", "admin", "client", "balance_delete", {"id": brow[0]})
    call(op_a, cj_a, "admin_balance_delete_missing", "admin", "client", "balance_delete", {"id": 99999})

    # --- login history + batch expiry ---
    call(op_a, cj_a, "admin_login_history", "admin", "client", "login_history_get_list", {"client_id": 1})
    d.execute("INSERT INTO client_password_reset (hash, ip, created_at, updated_at, client_id) VALUES ('cap19stale', '127.0.0.1', datetime('now', '-3 hours'), datetime('now', '-3 hours'), ?)", (tid,))
    d.commit()
    call(op_a, cj_a, "admin_batch_expire_pw_reminders", "admin", "client", "batch_expire_password_reminders")
    print("stale reset row gone:", d.execute("SELECT COUNT(*) FROM client_password_reset WHERE hash = 'cap19stale'").fetchone()[0] == 0)

    # --- delete paths ---
    call(op_a, cj_a, "admin_delete_invalid", "admin", "client", "delete", {"id": "abc"})
    call(op_a, cj_a, "admin_delete_missing", "admin", "client", "delete", {"id": 99999})
    call(op_a, cj_a, "admin_delete_blocked_services", "admin", "client", "delete", {"id": 1})
    call(op_a, cj_a, "admin_export_csv", "admin", "client", "export_csv", raw=True)

    # --- guest reset / update_password on throwaway ---
    call(op_g, cj_g, "guest_reset_unknown", "guest", "client", "reset_password", {"email": "nobody19@example.com"})
    call(op_g, cj_g, "guest_reset_ok", "guest", "client", "reset_password", {"email": "cap19a@example.com"})
    hrow = d.execute("SELECT hash FROM client_password_reset WHERE client_id = ? ORDER BY id DESC LIMIT 1", (tid,)).fetchone()
    print("reset hash:", hrow[0] if hrow else None)
    call(op_g, cj_g, "guest_update_pw_mismatch", "guest", "client", "update_password",
         {"hash": hrow[0], "password": THROW_NEW, "password_confirm": "Other!99"})
    call(op_g, cj_g, "guest_update_pw_bad_hash", "guest", "client", "update_password",
         {"hash": "deadbeef-nope", "password": THROW_NEW, "password_confirm": THROW_NEW})
    call(op_g, cj_g, "guest_update_pw_ok", "guest", "client", "update_password",
         {"hash": hrow[0], "password": THROW_NEW, "password_confirm": THROW_NEW})
    op_t, cj_t = login_client("cap19a@example.com", THROW_NEW)
    call(op_g, cj_g, "guest_update_pw_replay", "guest", "client", "update_password",
         {"hash": hrow[0], "password": THROW_PW, "password_confirm": THROW_PW})
    call(op_a, cj_a, "admin_change_pw_restore_throwaway", "admin", "client", "change_password",
         {"id": tid, "password": THROW_PW, "password_confirm": THROW_PW})

    # --- batch_delete the throwaways ---
    call(op_a, cj_a, "admin_batch_delete", "admin", "client", "batch_delete", {"ids": [tid, bid]})
    print("throwaways gone:", d.execute("SELECT COUNT(*) FROM client WHERE id IN (?, ?)", (tid, bid)).fetchone()[0] == 0)
    # Restore the no-config Antispam default + clean resend artifacts.
    d.execute("DELETE FROM extension_meta WHERE extension = 'mod_antispam'")
    d.execute("DELETE FROM email_queue WHERE recipient = 'phase0.client@example.com' AND subject LIKE '%confirm%'")
    d.execute("DELETE FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = 1")
    d.commit()

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
