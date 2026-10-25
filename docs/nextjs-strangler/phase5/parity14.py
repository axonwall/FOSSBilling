#!/usr/bin/env python3
"""Phase 5 R1 parity: Profile (admin + client) + small mop-ups
through the TS stack, checked against captures17/ and pinned
expectations. Restores every mutated value via SQL at the end
(passwords are round-tripped through the API itself)."""
import glob, json, os, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
HERE = pathlib.Path(__file__).parent
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
results = []
ADMIN_PW = "Phase1-Admin!42"
CLIENT_PW = "Phase0-Client!42"
ADMIN_TMP = "Temp-Admin!99"
CLIENT_TMP = "Temp-Client!99"


def report(name, ok, detail=""):
    results.append((name, ok))
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


def clear_rate_limits():
    for f in glob.glob("/home/hatch/scratch/fossbilling/runtime/src/data/cache/rate_limit_*"):
        try:
            os.remove(f)
        except OSError:
            pass


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def call(cj, role, module, method, data=None):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    payload = flatten(dict(data or {}))
    if csrf:
        payload["CSRFToken"] = csrf
    req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def login(email, password, module="client"):
    clear_rate_limits()
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(cj, "guest", module, "login", {"email": email, "password": password})
    assert r.get("error") is None, r
    return cj


def err(r):
    return (r.get("error") or {}).get("message")


def main():
    d = sqlite3.connect(DBP)
    cj_a = login("admin@phase0.local", ADMIN_PW, module="staff")
    cj_c = login("phase0.client@example.com", CLIENT_PW)

    # --- admin profile ---
    r = call(cj_a, "admin", "profile", "get")
    t = dict(r["result"])
    t.pop("api_token", None)
    t.pop("updated_at", None)
    report("admin_profile_get", t["name"] == "Phase Zero Admin" and t["email"] == "admin@phase0.local"
           and t["status"] == "active" and t["created_at"] == "2026-10-23", str(t)[:200])
    r = call(cj_a, "admin", "profile", "update", {"name": "Phase Zero Admin (parity14)", "signature": "Parity sig"})
    report("admin_profile_update", r["result"] is True, str(r))
    r = call(cj_a, "admin", "profile", "get")
    report("admin_profile_get_updated", r["result"]["name"] == "Phase Zero Admin (parity14)"
           and r["result"]["signature"] == "Parity sig", str(r["result"])[:200])
    r = call(cj_a, "admin", "profile", "update", {"timezone": "Not/AZone"})
    report("admin_profile_update_bad_tz", err(r) == "Invalid timezone: Not/AZone", str(r))
    r = call(cj_a, "admin", "profile", "change_password", {"current_password": ADMIN_PW})
    report("admin_change_pw_missing", err(r) == "New password is required", str(r))
    r = call(cj_a, "admin", "profile", "change_password",
             {"current_password": ADMIN_PW, "new_password": "weak", "confirm_password": "weak"})
    report("admin_change_pw_weak", err(r) == "Minimum password length is 8 characters.", str(r))
    r = call(cj_a, "admin", "profile", "change_password",
             {"current_password": ADMIN_PW, "new_password": ADMIN_TMP, "confirm_password": "Other!99"})
    report("admin_change_pw_mismatch", err(r) == "Passwords do not match", str(r))
    r = call(cj_a, "admin", "profile", "change_password",
             {"current_password": "Wrong!99", "new_password": ADMIN_TMP, "confirm_password": ADMIN_TMP})
    report("admin_change_pw_wrong_current", err(r) == "Current password incorrect", str(r))
    r = call(cj_a, "admin", "profile", "change_password",
             {"current_password": ADMIN_PW, "new_password": ADMIN_TMP, "confirm_password": ADMIN_TMP})
    report("admin_change_pw_ok", r["result"] is True, str(r))
    cj_a = login("admin@phase0.local", ADMIN_TMP, module="staff")
    r = call(cj_a, "admin", "profile", "change_password",
             {"current_password": ADMIN_TMP, "new_password": ADMIN_PW, "confirm_password": ADMIN_PW})
    report("admin_change_pw_back", r["result"] is True, str(r))
    cj_a = login("admin@phase0.local", ADMIN_PW, module="staff")

    # --- admin api key ---
    old_token = d.execute("SELECT api_token FROM admin WHERE id = 1").fetchone()[0]
    r = call(cj_a, "admin", "profile", "generate_api_key")
    new_token = d.execute("SELECT api_token FROM admin WHERE id = 1").fetchone()[0]
    report("admin_generate_api_key", r["result"] is True and new_token != old_token and len(new_token) == 32, str(r))
    r = call(cj_a, "admin", "profile", "get")
    report("admin_session_dead_after_keygen", err(r) == "Authentication Failed", str(r))
    cj_a = login("admin@phase0.local", ADMIN_PW, module="staff")
    r = call(cj_a, "admin", "profile", "api_key_reset", {"id": 1})
    report("admin_api_key_reset_client", isinstance(r["result"], str) and len(r["result"]) == 32, str(r))
    r = call(cj_a, "admin", "profile", "api_key_reset", {"id": 99999})
    report("admin_api_key_reset_missing", err(r) == "Client not found", str(r))
    # Mirror capture17: restore the client token now so the
    # client section starts from the null-token state.
    d.execute("UPDATE client SET api_token = NULL WHERE id = 1")
    d.commit()
    cj_c = login("phase0.client@example.com", CLIENT_PW)

    # --- admin destroy_sessions + logout ---
    cj_a2 = login("admin@phase0.local", ADMIN_PW, module="staff")
    r = call(cj_a, "admin", "profile", "destroy_sessions")
    report("admin_destroy_sessions", r["result"] is True, str(r))
    r = call(cj_a2, "admin", "profile", "get")
    report("admin_second_session_dead", err(r) == "Authentication Failed", str(r))
    cj_a = login("admin@phase0.local", ADMIN_PW, module="staff")
    r = call(cj_a, "admin", "profile", "logout")
    report("admin_logout", r["result"] is True, str(r))
    r = call(cj_a, "admin", "profile", "get")
    report("admin_after_logout", err(r) == "Authentication Failed", str(r))
    cj_a = login("admin@phase0.local", ADMIN_PW, module="staff")

    # --- client profile ---
    r = call(cj_c, "client", "profile", "get")
    report("client_profile_get", r["result"]["email"] == "phase0.client@example.com"
           and r["result"]["first_name"] == "Phase", str(r["result"])[:200])
    r = call(cj_c, "client", "profile", "update", {"first_name": "PhaseX", "custom_1": "parity14"})
    report("client_profile_update", r["result"] is True, str(r))
    r = call(cj_c, "client", "profile", "get")
    # NOTE: PHP's self view omits custom_* fields (they are admin
    # extras), so custom_1 is verified against the row directly.
    db_custom = d.execute("SELECT custom_1 FROM client WHERE id = 1").fetchone()[0]
    report("client_profile_get_updated", r["result"]["first_name"] == "PhaseX"
           and db_custom == "parity14", str(r["result"])[:200])
    r = call(cj_c, "client", "profile", "update", {"email": "phase1.diag@example.com"})
    report("client_profile_update_dup_email", err(r) == "This email address is already registered.", str(r))
    r = call(cj_c, "client", "profile", "api_key_get")
    report("client_api_key_get_null", r["result"] is None, str(r))
    r = call(cj_c, "client", "profile", "api_key_reset")
    report("client_api_key_reset", isinstance(r["result"], str) and len(r["result"]) == 32, str(r))
    # NOTE: reset invalidates the client's sessions, PHP included.
    cj_c = login("phase0.client@example.com", CLIENT_PW)
    r = call(cj_c, "client", "profile", "api_key_get")
    report("client_api_key_get_after_reset", isinstance(r["result"], str) and len(r["result"]) == 32, str(r))
    cj_c = login("phase0.client@example.com", CLIENT_PW)
    r = call(cj_c, "client", "profile", "change_password", {"current_password": CLIENT_PW})
    report("client_change_pw_missing", err(r) == "New password required", str(r))
    r = call(cj_c, "client", "profile", "change_password",
             {"current_password": CLIENT_PW, "new_password": CLIENT_TMP, "confirm_password": "Other!99"})
    report("client_change_pw_mismatch", err(r) == "Passwords do not match.", str(r))
    r = call(cj_c, "client", "profile", "change_password",
             {"current_password": "Wrong!99", "new_password": CLIENT_TMP, "confirm_password": CLIENT_TMP})
    report("client_change_pw_wrong_current", err(r) == "Current password incorrect", str(r))
    r = call(cj_c, "client", "profile", "change_password",
             {"current_password": CLIENT_PW, "new_password": CLIENT_TMP, "confirm_password": CLIENT_TMP})
    report("client_change_pw_ok", r["result"] is True, str(r))
    cj_c = login("phase0.client@example.com", CLIENT_TMP)
    r = call(cj_c, "client", "profile", "change_password",
             {"current_password": CLIENT_TMP, "new_password": CLIENT_PW, "confirm_password": CLIENT_PW})
    report("client_change_pw_back", r["result"] is True, str(r))
    cj_c = login("phase0.client@example.com", CLIENT_PW)
    cj_c2 = login("phase0.client@example.com", CLIENT_PW)
    r = call(cj_c, "client", "profile", "destroy_sessions")
    report("client_destroy_sessions", r["result"] is True, str(r))
    r = call(cj_c2, "client", "profile", "get")
    report("client_second_session_dead", err(r) == "Authentication Failed", str(r))
    cj_c = login("phase0.client@example.com", CLIENT_PW)
    r = call(cj_c, "client", "profile", "logout")
    report("client_logout", r["result"] is True, str(r))
    r = call(cj_c, "client", "profile", "get")
    report("client_after_logout", err(r) == "Authentication Failed", str(r))

    # --- mop-ups ---
    cj_g = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj_g))
    opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(cj_g, "guest", "support", "kb_enabled")
    report("guest_kb_enabled", r["result"] is True, str(r))
    r = call(cj_g, "guest", "support", "kb_suggestions_enabled", {"area": "contact"})
    report("guest_kb_suggestions_contact", r["result"] is False, str(r))
    r = call(cj_g, "guest", "support", "kb_suggestions_enabled", {"area": "ticket"})
    report("guest_kb_suggestions_ticket", r["result"] is False, str(r))
    r = call(cj_g, "guest", "support", "kb_suggestions_enabled", {"area": "bogus"})
    report("guest_kb_suggestions_bogus", r["result"] is False, str(r))
    r = call(cj_g, "guest", "support", "public_tickets_enabled")
    report("guest_public_tickets_enabled", r["result"] is True, str(r))
    cj_a = login("admin@phase0.local", ADMIN_PW, module="staff")
    r = call(cj_a, "admin", "support", "kb_category_get_pairs")
    report("admin_kb_category_get_pairs", r["result"] == {"1": "Frequently asked questions", "2": "How to's"}, str(r))
    r = call(cj_a, "admin", "cron", "save_settings", {"guest_cron": 1})
    report("admin_cron_save_settings_on", r["result"] is True, str(r))
    r = call(cj_a, "admin", "cron", "regenerate_cron_hash")
    report("admin_cron_regenerate_hash", isinstance(r["result"].get("cron_hash"), str)
           and len(r["result"]["cron_hash"]) == 64, str(r))
    r = call(cj_a, "admin", "cron", "save_settings", {"guest_cron": 0})
    report("admin_cron_save_settings_off", r["result"] is True, str(r))
    r = call(cj_a, "admin", "currency", "is_cron_enabled")
    report("admin_currency_is_cron_enabled", r["result"] is True, str(r))

    # --- restore reference state ---
    d.execute("UPDATE admin SET name = 'Phase Zero Admin', signature = NULL WHERE id = 1")
    d.execute("UPDATE admin SET api_token = 'phase0-token-9f27c1a4d8' WHERE id = 1")
    d.execute("UPDATE client SET first_name = 'Phase', custom_1 = NULL, api_token = NULL, email = 'phase0.client@example.com', email_approved = NULL WHERE id = 1")
    d.execute("DELETE FROM setting WHERE param IN ('cron_guest_enabled', 'cron_hash')")
    d.commit()
    n = sum(1 for _, ok in results if ok)
    print(f"\nparity Phase5-R1: {n}/{len(results)} match")
    return 0 if n == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
