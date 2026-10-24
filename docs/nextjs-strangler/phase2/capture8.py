#!/usr/bin/env python3
"""Phase 2 batch 4 PHP reference capture: System completion (guest data
methods + admin settings) and Staff mutations/groups (net-zero: a temp
staff member and group are created, exercised, and removed)."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures8"
OUT.mkdir(exist_ok=True)
manifest = []
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value

def call(name, role, module, method, data=None, save=True):
    payload = dict(data or {})
    if csrf():
        payload["CSRFToken"] = csrf()
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            text = resp.read().decode()
    except urllib.error.HTTPError as e:
        text = e.read().decode()
    parsed = json.loads(text)
    if save:
        (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}", "params": data or {},
                     "ok": parsed.get("error") is None, "error": (parsed.get("error") or {}).get("message"),
                     "result": parsed.get("result") if "_create" in name else None})
    print(f"{'OK ' if parsed.get('error') is None else 'ERR'} {name} {(parsed.get('error') or {}).get('message') or ''}")
    return parsed

opener.open(f"{BASE}/login", timeout=20).read()
# Guest system data methods
call("guest_system_countries", "guest", "system", "countries")
call("guest_system_default_country", "guest", "system", "default_country")
call("guest_system_phone_codes", "guest", "system", "phone_codes")
call("guest_system_timezones", "guest", "system", "timezones")
call("guest_system_locale", "guest", "system", "locale")
call("guest_system_param_company", "guest", "system", "param", {"key": "company_name"})
call("guest_system_param_missing", "guest", "system", "param", {"key": "no_such_param"})
call("guest_system_get_pending_messages", "guest", "system", "get_pending_messages")
# Staff session
call("guest_staff_login", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
call("admin_system_get_params", "admin", "system", "get_params")
call("admin_system_messages", "admin", "system", "messages")
# Settings round-trip (net-zero): flip a harmless param and flip it back
before = call("admin_system_get_params_one", "admin", "system", "get_params", {"params": ["company_name"]}, save=False)
call("admin_system_update_params", "admin", "system", "update_params", {"company_name": "Company Name"})
# Staff group lifecycle (net-zero)
g = call("admin_staff_group_create", "admin", "staff", "group_create", {"name": "Parity Group"})
gid = g.get("result")
call("admin_staff_group_get", "admin", "staff", "group_get", {"id": gid})
call("admin_staff_group_get_list", "admin", "staff", "group_get_list")
call("admin_staff_group_update", "admin", "staff", "group_update", {"id": gid, "name": "Parity Group Renamed"})
# Staff member lifecycle (net-zero)
s = call("admin_staff_create", "admin", "staff", "create",
         {"email": "parity.staff@example.com", "password": "Parity-Staff!42", "name": "Parity Staff", "group_id": gid})
sid = s.get("result")
call("admin_staff_create_dup", "admin", "staff", "create",
     {"email": "parity.staff@example.com", "password": "Parity-Staff!42", "name": "Parity Staff", "group_id": gid})
call("admin_staff_create_weak", "admin", "staff", "create",
     {"email": "weak.staff@example.com", "password": "weak", "name": "Weak Staff", "group_id": gid})
call("admin_staff_get_created", "admin", "staff", "get", {"id": sid})
call("admin_staff_group_member_get_list", "admin", "staff", "group_member_get_list", {"group_id": gid})
call("admin_staff_update", "admin", "staff", "update", {"id": sid, "name": "Parity Staff Jr."})
call("admin_staff_change_password", "admin", "staff", "change_password",
     {"id": sid, "password": "Parity-Staff!43", "password_confirm": "Parity-Staff!43"})
call("admin_staff_change_password_mismatch", "admin", "staff", "change_password",
     {"id": sid, "password": "Parity-Staff!44", "password_confirm": "nope"})
call("admin_staff_delete", "admin", "staff", "delete", {"id": sid})
call("admin_staff_group_member_add_self", "admin", "staff", "group_member_add", {"group_id": gid, "admin_id": 1})
call("admin_staff_group_member_remove_self", "admin", "staff", "group_member_remove", {"group_id": gid, "admin_id": 1})
call("admin_staff_group_delete", "admin", "staff", "group_delete", {"id": gid})
call("admin_staff_login_history", "admin", "staff", "login_history_get_list")
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"\ncaptures8 done; group id={gid}, staff id={sid}")
