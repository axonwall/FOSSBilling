#!/usr/bin/env python3
"""Phase 5 R1 capture corpus: Profile (admin + client) and small
mop-ups (support toggles/pairs, cron settings, currency cron flag)
against PHP. Restores every mutated value (passwords, names,
tokens, cron settings) before exiting."""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures17"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_PW = "Phase0-Client!42"
ADMIN_TMP = "Temp-Admin!99"
CLIENT_TMP = "Temp-Client!99"


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
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


def call(op, cj, name, role, module, method, data=None):
    payload = flatten(dict(data or {}))
    if csrf_of(cj):
        payload["CSRFToken"] = csrf_of(cj)
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=30) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def clear_rate_limits():
    # The reference install rate-limits guest logins (10/hour/IP)
    # and this capture logs in ~15 times; the limiter is not under
    # test here, so clear its file state before each login.
    import glob, os
    for f in glob.glob("/home/hatch/scratch/fossbilling/runtime/src/data/cache/rate_limit_*"):
        try:
            os.remove(f)
        except OSError:
            pass


def login_staff(password):
    clear_rate_limits()
    op, cj = make_opener()
    op.open(f"{BASE}/login", timeout=20).read()
    call(op, cj, "tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": password})
    return op, cj


def login_client(password):
    clear_rate_limits()
    op, cj = make_opener()
    op.open(f"{BASE}/login", timeout=20).read()
    call(op, cj, "tmp_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": password})
    return op, cj


def main():
    d = sqlite3.connect(DBP)
    op_a, cj_a = login_staff(ADMIN_PW)
    op_c, cj_c = login_client(CLIENT_PW)

    # --- admin profile reads + update ---
    call(op_a, cj_a, "admin_profile_get", "admin", "profile", "get")
    call(op_a, cj_a, "admin_profile_update", "admin", "profile", "update",
         {"name": "Phase Zero Admin (capture17)", "signature": "Capture sig"})
    call(op_a, cj_a, "admin_profile_get_updated", "admin", "profile", "get")
    d.execute("UPDATE admin SET name = 'Phase Zero Admin', signature = NULL WHERE id = 1")
    d.commit()
    call(op_a, cj_a, "admin_profile_update_bad_tz", "admin", "profile", "update",
         {"timezone": "Not/AZone"})

    # --- admin password change: errors then round-trip ---
    call(op_a, cj_a, "admin_change_pw_missing", "admin", "profile", "change_password",
         {"current_password": ADMIN_PW})
    call(op_a, cj_a, "admin_change_pw_weak", "admin", "profile", "change_password",
         {"current_password": ADMIN_PW, "new_password": "weak", "confirm_password": "weak"})
    call(op_a, cj_a, "admin_change_pw_mismatch", "admin", "profile", "change_password",
         {"current_password": ADMIN_PW, "new_password": ADMIN_TMP, "confirm_password": "Other!99"})
    call(op_a, cj_a, "admin_change_pw_wrong_current", "admin", "profile", "change_password",
         {"current_password": "Wrong!99", "new_password": ADMIN_TMP, "confirm_password": ADMIN_TMP})
    call(op_a, cj_a, "admin_change_pw_ok", "admin", "profile", "change_password",
         {"current_password": ADMIN_PW, "new_password": ADMIN_TMP, "confirm_password": ADMIN_TMP})
    op_a, cj_a = login_staff(ADMIN_TMP)
    call(op_a, cj_a, "admin_change_pw_back", "admin", "profile", "change_password",
         {"current_password": ADMIN_TMP, "new_password": ADMIN_PW, "confirm_password": ADMIN_PW})
    op_a, cj_a = login_staff(ADMIN_PW)

    # --- admin api key: generate (bool) + reset for client (string) ---
    old_admin_token = d.execute("SELECT api_token FROM admin WHERE id = 1").fetchone()[0]
    call(op_a, cj_a, "admin_generate_api_key", "admin", "profile", "generate_api_key")
    new_admin_token = d.execute("SELECT api_token FROM admin WHERE id = 1").fetchone()[0]
    print("admin token changed:", old_admin_token != new_admin_token, "len:", len(new_admin_token or ""))
    op_a, cj_a = login_staff(ADMIN_PW)
    call(op_a, cj_a, "admin_api_key_reset_client", "admin", "profile", "api_key_reset", {"id": 1})
    new_client_token = d.execute("SELECT api_token FROM client WHERE id = 1").fetchone()[0]
    print("client token now:", new_client_token)
    call(op_a, cj_a, "admin_api_key_reset_missing", "admin", "profile", "api_key_reset", {"id": 99999})
    d.execute("UPDATE admin SET api_token = ? WHERE id = 1", (old_admin_token,))
    d.execute("UPDATE client SET api_token = NULL WHERE id = 1")
    d.commit()
    op_a, cj_a = login_staff(ADMIN_PW)
    # NOTE: admin api_key_reset invalidates ALL of client 1's
    # sessions, including the capture's own client login above.
    op_c, cj_c = login_client(CLIENT_PW)

    # --- admin destroy_sessions: second session must die ---
    op_a2, cj_a2 = login_staff(ADMIN_PW)
    call(op_a, cj_a, "admin_destroy_sessions", "admin", "profile", "destroy_sessions")
    r = call(op_a2, cj_a2, "admin_second_session_dead", "admin", "profile", "get")
    print("second session dead:", r.get("error") is not None)
    op_a, cj_a = login_staff(ADMIN_PW)

    # --- admin logout ---
    call(op_a, cj_a, "admin_logout", "admin", "profile", "logout")
    r = call(op_a, cj_a, "admin_after_logout", "admin", "profile", "get")
    print("logged out:", r.get("error") is not None)
    op_a, cj_a = login_staff(ADMIN_PW)

    # --- client profile ---
    call(op_c, cj_c, "client_profile_get", "client", "profile", "get")
    call(op_c, cj_c, "client_profile_update", "client", "profile", "update",
         {"first_name": "PhaseX", "custom_1": "capture17"})
    call(op_c, cj_c, "client_profile_get_updated", "client", "profile", "get")
    d.execute("UPDATE client SET first_name = 'Phase', custom_1 = NULL WHERE id = 1")
    d.commit()
    # NOTE: the uniqueness check is client-email scoped — an
    # admin's address is NOT a duplicate. Use client 2's address.
    call(op_c, cj_c, "client_profile_update_dup_email", "client", "profile", "update",
         {"email": "phase1.diag@example.com"})
    call(op_c, cj_c, "client_api_key_get_null", "client", "profile", "api_key_get")
    call(op_c, cj_c, "client_api_key_reset", "client", "profile", "api_key_reset")
    d.execute("UPDATE client SET api_token = NULL WHERE id = 1")
    d.commit()
    # NOTE: api_key_reset invalidates the client's sessions too.
    op_c, cj_c = login_client(CLIENT_PW)
    call(op_c, cj_c, "client_change_pw_missing", "client", "profile", "change_password",
         {"current_password": CLIENT_PW})
    call(op_c, cj_c, "client_change_pw_mismatch", "client", "profile", "change_password",
         {"current_password": CLIENT_PW, "new_password": CLIENT_TMP, "confirm_password": "Other!99"})
    call(op_c, cj_c, "client_change_pw_wrong_current", "client", "profile", "change_password",
         {"current_password": "Wrong!99", "new_password": CLIENT_TMP, "confirm_password": CLIENT_TMP})
    call(op_c, cj_c, "client_change_pw_ok", "client", "profile", "change_password",
         {"current_password": CLIENT_PW, "new_password": CLIENT_TMP, "confirm_password": CLIENT_TMP})
    op_c, cj_c = login_client(CLIENT_TMP)
    call(op_c, cj_c, "client_change_pw_back", "client", "profile", "change_password",
         {"current_password": CLIENT_TMP, "new_password": CLIENT_PW, "confirm_password": CLIENT_PW})
    op_c, cj_c = login_client(CLIENT_PW)
    op_c2, cj_c2 = login_client(CLIENT_PW)
    call(op_c, cj_c, "client_destroy_sessions", "client", "profile", "destroy_sessions")
    r = call(op_c2, cj_c2, "client_second_session_dead", "client", "profile", "get")
    print("client second session dead:", r.get("error") is not None)
    op_c, cj_c = login_client(CLIENT_PW)
    call(op_c, cj_c, "client_logout", "client", "profile", "logout")
    r = call(op_c, cj_c, "client_after_logout", "client", "profile", "get")
    print("client logged out:", r.get("error") is not None)

    # --- mop-ups ---
    op_g, cj_g = make_opener()
    call(op_g, cj_g, "guest_kb_enabled", "guest", "support", "kb_enabled")
    call(op_g, cj_g, "guest_kb_suggestions_contact", "guest", "support", "kb_suggestions_enabled", {"area": "contact"})
    call(op_g, cj_g, "guest_kb_suggestions_ticket", "guest", "support", "kb_suggestions_enabled", {"area": "ticket"})
    call(op_g, cj_g, "guest_kb_suggestions_bogus", "guest", "support", "kb_suggestions_enabled", {"area": "bogus"})
    call(op_g, cj_g, "guest_public_tickets_enabled", "guest", "support", "public_tickets_enabled")
    op_a, cj_a = login_staff(ADMIN_PW)
    call(op_a, cj_a, "admin_kb_category_get_pairs", "admin", "support", "kb_category_get_pairs")
    call(op_a, cj_a, "admin_cron_save_settings_on", "admin", "cron", "save_settings", {"guest_cron": 1})
    call(op_a, cj_a, "admin_cron_regenerate_hash", "admin", "cron", "regenerate_cron_hash")
    call(op_a, cj_a, "admin_cron_save_settings_off", "admin", "cron", "save_settings", {"guest_cron": 0})
    call(op_a, cj_a, "admin_currency_is_cron_enabled", "admin", "currency", "is_cron_enabled")

    # Safety net: the reference client's identity must survive.
    d.execute("UPDATE client SET email = 'phase0.client@example.com', email_approved = NULL WHERE id = 1")
    d.execute("UPDATE client SET first_name = 'Phase', custom_1 = NULL WHERE id = 1")
    d.execute("UPDATE admin SET name = 'Phase Zero Admin', signature = NULL WHERE id = 1")
    d.commit()
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
