#!/usr/bin/env python3
"""Phase 5 core-CRUD parity 1: Client module through TS, checked
against captures19/.

Mutating calls replay with FRESH test data (new emails, groups,
balance rows) and compare shapes + messages; stateless error
pins replay exactly. Balance totals are compared as deltas.
Login history totals grow with every login, so only the shape
and the first item's client block are compared."""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
CAP = pathlib.Path(__file__).parent / "captures19"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_PW = "Phase0-Client!42"
PW = "Parity-Client!42"
NEW_PW = "Parity-Client!99"
results = []


def report(name, ok, detail=""):
    results.append(ok)
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


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


def main():
    d = sqlite3.connect(DBP)
    d.execute("DELETE FROM client WHERE email LIKE 'par16%@example.com'")
    d.execute("DELETE FROM client_group WHERE title LIKE 'Parity16%'")
    d.commit()

    def call(op, cj, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def oracle(name):
        return json.load(open(CAP / f"{name}.json"))

    def err(r):
        return (r.get("error") or {}).get("message") if isinstance(r, dict) else None

    def expect_err(name, r, capname):
        want = oracle(capname)
        report(name, err(r) == err(want), f"got {err(r)!r} want {err(want)!r}")

    def expect_eq(name, r, capname):
        want = oracle(capname)
        report(name, r == want, f"got {str(r)[:200]} want {str(want)[:200]}")

    op_a, cj_a = make_opener()
    op_a.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_a, cj_a, "guest", "staff", "login", {"email": "admin@phase0.local", "password": ADMIN_PW})
    assert r.get("error") is None, r

    # Statuses first: seeded state (3 clients) before any fresh client exists.
    r = call(op_a, cj_a, "admin", "client", "get_statuses")
    report("admin_get_statuses", r.get("result") == {"total": 3, "active": 3, "suspended": 0, "canceled": 0}, str(r)[:200])

    # --- guest config reads (exact) ---
    op_g, cj_g = make_opener()
    op_g.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    expect_eq("guest_required", call(op_g, cj_g, "guest", "client", "required"), "guest_required")
    expect_eq("guest_custom_fields", call(op_g, cj_g, "guest", "client", "custom_fields"), "guest_custom_fields")
    expect_eq("guest_is_email_validation_required",
              call(op_g, cj_g, "guest", "client", "is_email_validation_required"),
              "guest_is_email_validation_required")

    # --- guest create errors (exact messages) ---
    expect_err("guest_create_missing", call(op_g, cj_g, "guest", "client", "create", {"first_name": "Par"}), "guest_create_missing")
    expect_err("guest_create_mismatch", call(op_g, cj_g, "guest", "client", "create",
               {"email": "par16a@example.com", "first_name": "Par", "password": PW, "password_confirm": "Other!99"}), "guest_create_mismatch")
    expect_err("guest_create_weak", call(op_g, cj_g, "guest", "client", "create",
               {"email": "par16a@example.com", "first_name": "Par", "password": "weak", "password_confirm": "weak"}), "guest_create_weak")

    # --- guest create ok + autologin + duplicate ---
    r = call(op_g, cj_g, "guest", "client", "create",
             {"email": "par16a@example.com", "first_name": "Par", "password": PW, "password_confirm": PW})
    report("guest_create_ok", r.get("result") is True, str(r)[:200])
    tid = d.execute("SELECT id FROM client WHERE email = 'par16a@example.com'").fetchone()[0]
    r = call(op_g, cj_g, "client", "profile", "get")
    report("guest_create_autologin_profile", r.get("result", {}).get("email") == "par16a@example.com", str(r)[:200])
    r = call(op_g, cj_g, "guest", "client", "create",
             {"email": "par16a@example.com", "first_name": "Par", "password": PW, "password_confirm": PW})
    report("guest_create_duplicate", r.get("result") is True, str(r)[:200])

    # --- guest login errors ---
    op_x, cj_x = make_opener()
    op_x.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    expect_err("guest_login_wrong_pw", call(op_x, cj_x, "guest", "client", "login",
               {"email": "par16a@example.com", "password": "Wrong!99"}), "guest_login_wrong_pw")
    expect_err("guest_login_unknown", call(op_x, cj_x, "guest", "client", "login",
               {"email": "nobody16@example.com", "password": "Whatever!99"}), "guest_login_unknown")

    # --- admin create errors ---
    expect_err("admin_create_missing", call(op_a, cj_a, "admin", "client", "create", {"first_name": "NoMail"}), "admin_create_missing")
    expect_err("admin_create_dup", call(op_a, cj_a, "admin", "client", "create",
               {"email": "par16a@example.com", "first_name": "Dup", "password": PW, "send_welcome_email": 0}), "admin_create_dup")
    expect_err("admin_create_no_pw_no_welcome", call(op_a, cj_a, "admin", "client", "create",
               {"email": "par16b@example.com", "first_name": "NoPw", "send_welcome_email": 0}), "admin_create_no_pw_no_welcome")
    expect_err("admin_create_welcome_nonactive", call(op_a, cj_a, "admin", "client", "create",
               {"email": "par16b@example.com", "first_name": "NonAct", "status": "suspended", "send_welcome_email": 1}), "admin_create_welcome_nonactive")
    r = call(op_a, cj_a, "admin", "client", "create",
             {"email": "par16b@example.com", "first_name": "Bee", "last_name": "Par", "password": PW,
              "send_welcome_email": 0, "country": "US", "phone_cc": "1", "phone": "5125550199"})
    bid = r.get("result")
    report("admin_create_ok", isinstance(bid, int), str(r)[:200])

    # --- admin update errors + ok ---
    expect_err("admin_update_dup_email", call(op_a, cj_a, "admin", "client", "update",
               {"id": bid, "email": "phase0.client@example.com"}), "admin_update_dup_email")
    expect_err("admin_update_bad_country", call(op_a, cj_a, "admin", "client", "update",
               {"id": bid, "country": "XX"}), "admin_update_bad_country")
    expect_err("admin_update_bad_lang", call(op_a, cj_a, "admin", "client", "update",
               {"id": bid, "lang": "xx_XX"}), "admin_update_bad_lang")
    expect_err("admin_update_bad_tz", call(op_a, cj_a, "admin", "client", "update",
               {"id": bid, "timezone": "Not/AZone"}), "admin_update_bad_tz")
    expect_err("admin_update_missing", call(op_a, cj_a, "admin", "client", "update", {"id": 99999, "city": "X"}), "admin_update_missing")
    r = call(op_a, cj_a, "admin", "client", "update", {"id": bid, "last_name": "ParUpdated", "city": "Austin", "custom_1": "par16"})
    report("admin_update_ok", r.get("result") is True, str(r)[:200])
    r = call(op_a, cj_a, "admin", "client", "get", {"id": bid})
    got = r.get("result") or {}
    report("admin_update_visible", got.get("last_name") == "ParUpdated" and got.get("city") == "Austin" and got.get("custom_1") == "par16", str(got)[:200])

    # --- groups ---
    r = call(op_a, cj_a, "admin", "client", "group_create", {"title": "Parity16 Group"})
    gid = r.get("result")
    report("admin_group_create", isinstance(gid, int), str(r)[:200])
    r = call(op_a, cj_a, "admin", "client", "group_get", {"id": gid})
    report("admin_group_get", r.get("result", {}).get("title") == "Parity16 Group", str(r)[:200])
    r = call(op_a, cj_a, "admin", "client", "group_update", {"id": gid, "title": "Parity16 Group Renamed"})
    report("admin_group_update", r.get("result") is True, str(r)[:200])
    r = call(op_a, cj_a, "admin", "client", "group_get_pairs")
    report("admin_group_get_pairs_contains", r.get("result", {}).get(str(gid)) == "Parity16 Group Renamed", str(r)[:200])
    r = call(op_a, cj_a, "admin", "client", "update", {"id": bid, "group_ids": [gid]})
    report("admin_update_assign_group", r.get("result") is True, str(r)[:200])
    expect_err("admin_group_delete_blocked", call(op_a, cj_a, "admin", "client", "group_delete", {"id": gid}), "admin_group_delete_blocked")
    r = call(op_a, cj_a, "admin", "client", "update", {"id": bid, "group_ids": ""})
    report("admin_update_unassign_group", r.get("result") is True, str(r)[:200])
    r = call(op_a, cj_a, "admin", "client", "group_delete", {"id": gid})
    report("admin_group_delete_ok", r.get("result") is True, str(r)[:200])
    expect_err("admin_group_get_missing", call(op_a, cj_a, "admin", "client", "group_get", {"id": gid}), "admin_group_get_missing")

    # --- admin change_password ---
    expect_err("admin_change_pw_missing", call(op_a, cj_a, "admin", "client", "change_password", {"id": bid}), "admin_change_pw_missing")
    expect_err("admin_change_pw_mismatch", call(op_a, cj_a, "admin", "client", "change_password",
               {"id": bid, "password": NEW_PW, "password_confirm": "Other!99"}), "admin_change_pw_mismatch")
    expect_err("admin_change_pw_weak", call(op_a, cj_a, "admin", "client", "change_password",
               {"id": bid, "password": "weak", "password_confirm": "weak"}), "admin_change_pw_weak")
    expect_err("admin_change_pw_missing_client", call(op_a, cj_a, "admin", "client", "change_password",
               {"id": 99999, "password": NEW_PW, "password_confirm": NEW_PW}), "admin_change_pw_missing_client")
    r = call(op_a, cj_a, "admin", "client", "change_password",
             {"id": bid, "password": NEW_PW, "password_confirm": NEW_PW})
    report("admin_change_pw_ok", r.get("result") is True, str(r)[:200])
    op_b, cj_b = make_opener()
    op_b.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_b, cj_b, "guest", "client", "login", {"email": "par16b@example.com", "password": NEW_PW})
    report("admin_change_pw_login_new", r.get("result", {}).get("email") == "par16b@example.com", str(r)[:200])
    call(op_a, cj_a, "admin", "client", "change_password", {"id": bid, "password": PW, "password_confirm": PW})

    # --- impersonation ---
    r = call(op_a, cj_a, "admin", "client", "login", {"id": tid})
    report("admin_login_impersonate", r.get("result") == {"id": tid, "email": "par16a@example.com", "name": "Par", "role": "client"}, str(r)[:200])
    r = call(op_a, cj_a, "client", "profile", "get")
    report("admin_impersonated_profile", r.get("result", {}).get("email") == "par16a@example.com", str(r)[:200])
    call(op_a, cj_a, "admin", "client", "login", {"id": tid, "strip_admin_identity": 1})
    expect_err("admin_after_strip", call(op_a, cj_a, "admin", "profile", "get"), "admin_after_strip")
    r = call(op_a, cj_a, "client", "profile", "get")
    report("admin_stripped_client_profile", r.get("result", {}).get("email") == "par16a@example.com", str(r)[:200])
    op_a, cj_a = make_opener()
    op_a.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    call(op_a, cj_a, "guest", "staff", "login", {"email": "admin@phase0.local", "password": ADMIN_PW})

    # --- balances ---
    expect_err("admin_balance_add_funds_nocurrency", call(op_a, cj_a, "admin", "client", "balance_add_funds",
               {"id": bid, "amount": 10, "description": "par16"}), "admin_balance_add_funds_nocurrency")
    expect_err("admin_balance_add_funds_missing", call(op_a, cj_a, "admin", "client", "balance_add_funds", {"id": 1}), "admin_balance_add_funds_missing")
    op_c, cj_c = make_opener()
    op_c.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    call(op_c, cj_c, "guest", "client", "login", {"email": "phase0.client@example.com", "password": CLIENT_PW})
    before = call(op_c, cj_c, "client", "client", "balance_get_total").get("result")
    r = call(op_a, cj_a, "admin", "client", "balance_add_funds",
             {"id": 1, "amount": 25, "description": "parity16 funds"})
    report("admin_balance_add_funds_ok", r.get("result") is True, str(r)[:200])
    brow = d.execute("SELECT id FROM client_balance WHERE client_id = 1 AND description = 'parity16 funds' ORDER BY id DESC LIMIT 1").fetchone()
    r = call(op_a, cj_a, "admin", "client", "balance_get_list", {"client_id": 1})
    items = (r.get("result") or {}).get("list", [])
    mine = [x for x in items if x.get("id") == brow[0]] if brow else []
    report("admin_balance_get_list", len(mine) == 1 and mine[0]["amount"] == 25 and mine[0]["currency"] == "USD", str(mine)[:200])
    r = call(op_c, cj_c, "client", "client", "balance_get_list")
    items = (r.get("result") or {}).get("list", [])
    mine = [x for x in items if x.get("id") == brow[0]] if brow else []
    report("client_balance_get_list", len(mine) == 1 and mine[0]["amount"] == "25", str(mine)[:200])
    after = call(op_c, cj_c, "client", "client", "balance_get_total").get("result")
    report("client_balance_get_total_delta", after - before == 25, f"{before} -> {after}")
    r = call(op_c, cj_c, "client", "client", "is_taxable")
    report("client_is_taxable", r.get("result") is False, str(r)[:200])
    r = call(op_c, cj_c, "client", "client", "resend_email_verification")
    report("client_resend_email_verification", r.get("result") is True, str(r)[:200])
    has_confirm = d.execute("SELECT COUNT(*) FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = 1").fetchone()[0] > 0
    report("client_resend_confirm_row", has_confirm)
    d.execute("DELETE FROM extension_meta WHERE extension = 'mod_client' AND meta_key = 'confirm_email' AND client_id = 1")
    d.execute("DELETE FROM email_queue WHERE recipient = 'phase0.client@example.com'")
    d.commit()
    if brow:
        r = call(op_a, cj_a, "admin", "client", "balance_delete", {"id": brow[0]})
        report("admin_balance_delete_ok", r.get("result") is True, str(r)[:200])
    expect_err("admin_balance_delete_missing", call(op_a, cj_a, "admin", "client", "balance_delete", {"id": 99999}), "admin_balance_delete_missing")

    # --- login history shape ---
    r = call(op_a, cj_a, "admin", "client", "login_history_get_list", {"client_id": 1})
    res = r.get("result") or {}
    first = (res.get("list") or [{}])[0]
    report("admin_login_history_shape",
           res.get("page") == 1 and first.get("client", {}).get("id") == 1 and "ip" in first, str(first)[:200])

    # --- batch expiry ---
    d.execute("INSERT INTO client_password_reset (hash, ip, created_at, updated_at, client_id) VALUES ('par16stale', '127.0.0.1', datetime('now', '-3 hours'), datetime('now', '-3 hours'), ?)", (tid,))
    d.commit()
    r = call(op_a, cj_a, "admin", "client", "batch_expire_password_reminders")
    gone = d.execute("SELECT COUNT(*) FROM client_password_reset WHERE hash = 'par16stale'").fetchone()[0] == 0
    report("admin_batch_expire_pw_reminders", r.get("result") is True and gone, str(r)[:200])

    # --- delete errors ---
    expect_err("admin_delete_invalid", call(op_a, cj_a, "admin", "client", "delete", {"id": "abc"}), "admin_delete_invalid")
    expect_err("admin_delete_missing", call(op_a, cj_a, "admin", "client", "delete", {"id": 99999}), "admin_delete_missing")
    expect_err("admin_delete_blocked_services", call(op_a, cj_a, "admin", "client", "delete", {"id": 1}), "admin_delete_blocked_services")

    # --- guest reset / update_password ---
    r = call(op_g, cj_g, "guest", "client", "reset_password", {"email": "nobody16@example.com"})
    report("guest_reset_unknown", r.get("result") is True, str(r)[:200])
    r = call(op_g, cj_g, "guest", "client", "reset_password", {"email": "par16a@example.com"})
    report("guest_reset_ok", r.get("result") is True, str(r)[:200])
    hrow = d.execute("SELECT hash FROM client_password_reset WHERE client_id = ? ORDER BY id DESC LIMIT 1", (tid,)).fetchone()
    expect_err("guest_update_pw_mismatch", call(op_g, cj_g, "guest", "client", "update_password",
               {"hash": hrow[0], "password": NEW_PW, "password_confirm": "Other!99"}), "guest_update_pw_mismatch")
    expect_err("guest_update_pw_bad_hash", call(op_g, cj_g, "guest", "client", "update_password",
               {"hash": "deadbeef-nope", "password": NEW_PW, "password_confirm": NEW_PW}), "guest_update_pw_bad_hash")
    r = call(op_g, cj_g, "guest", "client", "update_password",
             {"hash": hrow[0], "password": NEW_PW, "password_confirm": NEW_PW})
    report("guest_update_pw_ok", r.get("result") is True, str(r)[:200])
    op_t, cj_t = make_opener()
    op_t.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_t, cj_t, "guest", "client", "login", {"email": "par16a@example.com", "password": NEW_PW})
    report("guest_update_pw_login_new", r.get("result", {}).get("email") == "par16a@example.com", str(r)[:200])
    expect_err("guest_update_pw_replay", call(op_g, cj_g, "guest", "client", "update_password",
               {"hash": hrow[0], "password": PW, "password_confirm": PW}), "guest_update_pw_replay")

    # --- batch_delete ---
    r = call(op_a, cj_a, "admin", "client", "batch_delete", {"ids": [tid, bid]})
    gone = d.execute("SELECT COUNT(*) FROM client WHERE id IN (?, ?)", (tid, bid)).fetchone()[0] == 0
    report("admin_batch_delete", r.get("result") is True and gone, str(r)[:200])

    n = sum(1 for ok in results if ok)
    print(f"\nparity Phase5-CRUD1: {n}/{len(results)} match")
    return 0 if n == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
