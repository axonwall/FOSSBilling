#!/usr/bin/env python3
"""Phase 2 batch 4 parity: replay capture8 against the Next origin.
Group/staff creates return fresh ids per run (normalized); staff/group
rows created during the run carry fresh timestamps (normalized).
login_history is append-only live data -> shape A/B like activity."""
import json, sys, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
PHP = "http://127.0.0.1:8080"
REF = pathlib.Path(__file__).parent / "captures8"

cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf_of(jar):
    for c in jar:
        if c.name == "fossbilling_csrf":
            return c.value

def raw(op, jar, url, data=None):
    payload = dict(data or {})
    if csrf_of(jar):
        payload["CSRFToken"] = csrf_of(jar)
    req = urllib.request.Request(url, data=urllib.parse.urlencode(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with op.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def call(role, module, method, data=None):
    return raw(opener, cj, f"{NEXT}/api/fb/{role}/{module}/{method}", data)

def scrub(v, ids):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in ("created_at", "updated_at") and isinstance(x, str) and x.startswith("2026-10-24 01:"):
                out[k] = "*ts*"
            elif k == "id" and x in ids:
                out[k] = "*id*"
            elif k == "parent_id" and x in ids:
                out[k] = "*pid*"
            else:
                out[k] = scrub(x, ids)
        return out
    if isinstance(v, list):
        return [scrub(x, ids) for x in v]
    return v

results = []
def expect(name, got, ref_name=None, ref_ids=(), got_ids=()):
    ref = json.loads((REF / f"{ref_name or name}.json").read_text())
    # get_params includes last_patch + every setting: both sides read the
    # same DB; only settings written between runs could differ (none are).
    ok = scrub(got, set(got_ids)) == scrub(ref, set(ref_ids))
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(scrub(ref, set(ref_ids)))[:260]}")
        print(f"   ts:  {json.dumps(scrub(got, set(got_ids)))[:260]}")
    results.append(ok)

opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
expect("guest_system_countries", call("guest", "system", "countries"))
expect("guest_system_default_country", call("guest", "system", "default_country"))
expect("guest_system_phone_codes", call("guest", "system", "phone_codes"))
expect("guest_system_timezones", call("guest", "system", "timezones"))
expect("guest_system_locale", call("guest", "system", "locale"))
expect("guest_system_param_company", call("guest", "system", "param", {"key": "company_name"}))
expect("guest_system_param_missing", call("guest", "system", "param", {"key": "no_such_param"}))
expect("guest_system_get_pending_messages", call("guest", "system", "get_pending_messages"))
call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
expect("admin_system_get_params", call("admin", "system", "get_params"))
expect("admin_system_update_params", call("admin", "system", "update_params", {"company_name": "Company Name"}))

ref_gid = json.loads((REF / "admin_staff_group_create.json").read_text())["result"]
g = call("admin", "staff", "group_create", {"name": "Parity Group"})
ts_gid = g.get("result")
ok = isinstance(ts_gid, int)
print(f"{'MATCH' if ok else 'DIFF '} admin_staff_group_create (returns new id)")
results.append(ok)
expect("admin_staff_group_get", call("admin", "staff", "group_get", {"id": ts_gid}), ref_ids=(ref_gid,), got_ids=(ts_gid,))
expect("admin_staff_group_get_list", call("admin", "staff", "group_get_list"), ref_ids=(ref_gid,), got_ids=(ts_gid,))
expect("admin_staff_group_update", call("admin", "staff", "group_update", {"id": ts_gid, "name": "Parity Group Renamed"}))

ref_sid = json.loads((REF / "admin_staff_create.json").read_text())["result"]
s = call("admin", "staff", "create", {"email": "parity.staff@example.com", "password": "Parity-Staff!42", "name": "Parity Staff", "group_id": ts_gid})
ts_sid = s.get("result")
ok = isinstance(ts_sid, int)
print(f"{'MATCH' if ok else 'DIFF '} admin_staff_create (returns new id)")
results.append(ok)
expect("admin_staff_create_dup", call("admin", "staff", "create", {"email": "parity.staff@example.com", "password": "Parity-Staff!42", "name": "Parity Staff", "group_id": ts_gid}))
expect("admin_staff_create_weak", call("admin", "staff", "create", {"email": "weak.staff@example.com", "password": "weak", "name": "Weak Staff", "group_id": ts_gid}))
expect("admin_staff_get_created", call("admin", "staff", "get", {"id": ts_sid}), ref_ids=(ref_sid, ref_gid), got_ids=(ts_sid, ts_gid))
expect("admin_staff_group_member_get_list", call("admin", "staff", "group_member_get_list", {"group_id": ts_gid}), ref_ids=(ref_sid, ref_gid), got_ids=(ts_sid, ts_gid))
expect("admin_staff_update", call("admin", "staff", "update", {"id": ts_sid, "name": "Parity Staff Jr."}))
expect("admin_staff_change_password", call("admin", "staff", "change_password", {"id": ts_sid, "password": "Parity-Staff!43", "password_confirm": "Parity-Staff!43"}))
expect("admin_staff_change_password_mismatch", call("admin", "staff", "change_password", {"id": ts_sid, "password": "Parity-Staff!44", "password_confirm": "nope"}))
expect("admin_staff_delete", call("admin", "staff", "delete", {"id": ts_sid}))
expect("admin_staff_group_member_add_self", call("admin", "staff", "group_member_add", {"group_id": ts_gid, "admin_id": 1}))
expect("admin_staff_group_member_remove_self", call("admin", "staff", "group_member_remove", {"group_id": ts_gid, "admin_id": 1}))
expect("admin_staff_group_delete", call("admin", "staff", "group_delete", {"id": ts_gid}))

# login history: shape A/B
cj2 = http.cookiejar.CookieJar()
op2 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj2))
op2.open(f"{PHP}/login", timeout=20).read()
raw(op2, cj2, f"{PHP}/api/guest/staff/login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
php_h = raw(op2, cj2, f"{PHP}/api/admin/staff/login_history_get_list")
ts_h = call("admin", "staff", "login_history_get_list")
def hshape(env):
    r = env.get("result") or {}
    items = r.get("list") or []
    return {"keys": sorted(r.keys()), "item_keys": sorted(items[0].keys()) if items else [],
            "staff_keys": sorted(items[0]["staff"].keys()) if items and "staff" in items[0] else [],
            "total_positive": (r.get("total") or 0) > 0}
ok = hshape(php_h) == hshape(ts_h)
print(f"{'MATCH' if ok else 'DIFF '} admin_staff_login_history (shape A/B)")
if not ok:
    print("   php:", hshape(php_h)); print("   ts: ", hshape(ts_h))
results.append(ok)

print(f"\nparity batch4: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
