#!/usr/bin/env python3
"""R5i capture45: PHP security-homes behavior OBSERVED on dev :8080.

ip_lookup is OFFLINE (local MMDB files), so PHP behavior IS observable
in the sandbox, unlike R5h's network checks. All calls run on dev
(:8080, limiter bypassed); no prod oracle is needed because no trio
behavior differs by environment (webserver probes SYSTEM_URL, which
is the dev origin on dev; the prod-origin variant is a different
origin, not a different behavior — recorded as a note, not a second
oracle run, to avoid burning prod logins).

Crafted staff (bcryptjs-hashed passwords, parity28 pattern) are deleted
in finally, along with their groups and memberships; baseline admin 2 /
groups 3 / members 1 MUST hold at suite end. No mod_antispam row is
created by this script. No DB file is renamed or deleted: the
missing-DB behavior is proven by a constructor probe (see
missing_db_probe.php note in findings-r5i.md), not by touching the
reference DB files.
"""
import http.cookiejar
import json
import pathlib
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request

DEV = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures45"
OUT.mkdir(exist_ok=True)
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PW = "Phase1-Admin!42"
PW = "Cap45-Pass!42"

manifest = []


def q(sql, args=()):
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    rows = d.execute(sql, args).fetchall()
    d.close()
    return [dict(r) for r in rows]


def exec_sql(sql, args=()):
    d = sqlite3.connect(DBP)
    d.execute(sql, args)
    d.commit()
    d.close()


def fresh(base):
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.open(f"{base}/login", timeout=30).read()
    return op, cj


def csrf_of(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return None


def call(base, op, cj, name, role, module, method, data=None):
    payload = dict(data or {})
    tok = csrf_of(cj)
    if tok:
        payload["CSRFToken"] = tok
    req = urllib.request.Request(
        f"{base}/api/{role}/{module}/{method}",
        data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=90) as resp:
            st, body = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        st, body = e.code, e.read()
    parsed = json.loads(body.decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2, ensure_ascii=False) + "\n")
    manifest.append(name)
    print(f"{name}: http={st} -> {json.dumps(parsed)[:300]}")
    return st, parsed


def login(op, cj, base, email, pw):
    st, env = call(base, op, cj, "tmp_login", "guest", "staff", "login",
                   {"email": email, "password": pw})
    assert env.get("error") is None, f"login failed: {env}"
    return env


def bcrypt_hash(pw):
    js = ("const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
          f"console.log(b.hashSync({pw!r}, 10));")
    return subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout.strip()


def main():
    op, cj = fresh(DEV)
    login(op, cj, DEV, ADMIN_EMAIL, ADMIN_PW)

    # ---------- ip_lookup ----------
    call(DEV, op, cj, "ip_missing", "admin", "security", "ip_lookup", {})
    call(DEV, op, cj, "ip_invalid_text", "admin", "security", "ip_lookup", {"ip": "not-an-ip"})
    call(DEV, op, cj, "ip_invalid_num", "admin", "security", "ip_lookup", {"ip": "999.1.1.1"})
    call(DEV, op, cj, "ip_empty", "admin", "security", "ip_lookup", {"ip": ""})
    call(DEV, op, cj, "ip_loopback", "admin", "security", "ip_lookup", {"ip": "127.0.0.1"})
    call(DEV, op, cj, "ip_private10", "admin", "security", "ip_lookup", {"ip": "10.0.0.5"})
    call(DEV, op, cj, "ip_private192", "admin", "security", "ip_lookup", {"ip": "192.168.1.1"})
    call(DEV, op, cj, "ip_public_google", "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
    call(DEV, op, cj, "ip_public_cloudflare", "admin", "security", "ip_lookup", {"ip": "1.1.1.1"})
    call(DEV, op, cj, "ip_v6loopback", "admin", "security", "ip_lookup", {"ip": "::1"})
    call(DEV, op, cj, "ip_v6public", "admin", "security", "ip_lookup", {"ip": "2001:4860:4860::8888"})
    call(DEV, op, cj, "ip_v4mapped", "admin", "security", "ip_lookup", {"ip": "::ffff:8.8.8.8"})

    # ---------- run_check / run_checks / list_checks ----------
    call(DEV, op, cj, "check_missing_id", "admin", "security", "run_check", {})
    for cid in ("dangerousFunctions", "generalCheck", "phpVersion", "webserver"):
        call(DEV, op, cj, f"check_{cid}", "admin", "security", "run_check", {"id": cid})
    call(DEV, op, cj, "check_unknown", "admin", "security", "run_check", {"id": "nope"})
    call(DEV, op, cj, "check_case_variant", "admin", "security", "run_check", {"id": "GeneralCheck"})
    call(DEV, op, cj, "checks_all", "admin", "security", "run_checks", {})
    call(DEV, op, cj, "checks_list", "admin", "security", "list_checks", {})

    # ---------- permissions: crafted staff ----------
    h = bcrypt_hash(PW)
    # Group with NO security perms at all.
    exec_sql("INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
             " VALUES ('Cap45 NoSec', 'cap45_nosec', ?, 0, NULL, datetime('now'), datetime('now'))",
             (json.dumps({"support": {"access": True, "view": True}}),))
    gid_nosec = q("SELECT id FROM admin_group WHERE system_name = 'cap45_nosec'")[0]["id"]
    # Group with security access but NO view/run_checks keys.
    exec_sql("INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
             " VALUES ('Cap45 SecAccess', 'cap45_secaccess', ?, 0, NULL, datetime('now'), datetime('now'))",
             (json.dumps({"security": {"access": True}}),))
    gid_access = q("SELECT id FROM admin_group WHERE system_name = 'cap45_secaccess'")[0]["id"]
    # Group with view but NO run_checks key.
    exec_sql("INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
             " VALUES ('Cap45 SecView', 'cap45_secview', ?, 0, NULL, datetime('now'), datetime('now'))",
             (json.dumps({"security": {"access": True, "view": True}}),))
    gid_view = q("SELECT id FROM admin_group WHERE system_name = 'cap45_secview'")[0]["id"]
    staff_ids = []
    for name, gid in (("nosec", gid_nosec), ("access", gid_access), ("view", gid_view)):
        exec_sql("INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
                 " VALUES (?, ?, ?, 'active', '', 'UTC', datetime('now'), datetime('now'))",
                 (f"cap45{name}@example.com", h, f"Cap45 {name}"))
        sid = q("SELECT id FROM admin WHERE email = ?", (f"cap45{name}@example.com",))[0]["id"]
        staff_ids.append(sid)
        exec_sql("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at)"
                 " VALUES (?, ?, datetime('now'))", (sid, gid))
    try:
        for name, gid in (("nosec", gid_nosec), ("access", gid_access), ("view", gid_view)):
            o2, c2 = fresh(DEV)
            login(o2, c2, DEV, f"cap45{name}@example.com", PW)
            call(DEV, o2, c2, f"perm_{name}_ip_lookup", "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
            call(DEV, o2, c2, f"perm_{name}_run_check", "admin", "security", "run_check", {"id": "generalCheck"})
            call(DEV, o2, c2, f"perm_{name}_run_checks", "admin", "security", "run_checks", {})
            call(DEV, o2, c2, f"perm_{name}_list_checks", "admin", "security", "list_checks", {})
    finally:
        for sid in staff_ids:
            exec_sql("DELETE FROM admin_group_member WHERE admin_id = ?", (sid,))
            exec_sql("DELETE FROM admin WHERE id = ?", (sid,))
        for gid in (gid_nosec, gid_access, gid_view):
            exec_sql("DELETE FROM admin_group WHERE id = ?", (gid,))

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("captures:", len(manifest))
    print("admin:", q("SELECT COUNT(*) AS c FROM admin")[0]["c"],
          "groups:", q("SELECT COUNT(*) AS c FROM admin_group")[0]["c"],
          "members:", q("SELECT COUNT(*) AS c FROM admin_group_member")[0]["c"])


if __name__ == "__main__":
    main()
