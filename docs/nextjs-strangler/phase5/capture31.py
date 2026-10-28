#!/usr/bin/env python3
"""Phase 5 R2d PHP-only oracle corpus: the staff/group cases of
parity28, recorded against the PHP stack into captures31/.

Covers: staff create/get/update/delete/change_password, group
create/get/update/delete, the permission-matrix round-trip in the
PHP-native nested form shape, hierarchy refusals as the seeded Lead,
and last-active-super-administrator refusals (refusal-only against
real rows). Crafted rows are removed per case and the full DB is
restored in a finally block; invariants are checked before and after.
"""
import json
import pathlib
import re
import sqlite3
import subprocess
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

PHP = "http://127.0.0.1:8080"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
OUT = pathlib.Path(__file__).parent / "captures31"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
LEAD_EMAIL = "r2d-lead@example.local"
STAFF_EMAIL = "r2d-staff@example.local"
PERSONA_PASS = "R2d-Staff!42"
CRAFT_PASS = "R2d-Craft!42"
NEW_PASS = "R2d-New!42"
FIXED_TS = "2026-10-28 12:00:00"


def main():
    OUT.mkdir(exist_ok=True)
    d = sqlite3.connect(DBP)
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    snaps = {}
    for t in tables:
        cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
    seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()

    def restore():
        for t in tables:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            d.executemany(
                f'INSERT INTO "{t}" (' + ",".join(cols) + ") VALUES (" + ",".join("?" * len(cols)) + ")",
                [tuple(r) for r in rows])
        d.execute("DELETE FROM sqlite_sequence")
        d.executemany("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", seq)
        d.commit()

    def invariants():
        q = lambda s: d.execute(s).fetchone()[0]
        return (
            q("SELECT COUNT(*) FROM tld"), q("SELECT COUNT(*) FROM tld_registrar"),
            q("SELECT COUNT(*) FROM service_domain"), q("SELECT COUNT(*) FROM email_queue"),
            q("SELECT COUNT(*) FROM invoice"), q("SELECT COUNT(*) FROM client_order"),
            q("SELECT COUNT(*) FROM admin"), q("SELECT COUNT(*) FROM admin_group"),
            q("SELECT COUNT(*) FROM admin_group_member"), q("SELECT COUNT(*) FROM support_ticket"),
            q("SELECT COUNT(*) FROM client"), q("SELECT COUNT(*) FROM service_downloadable"),
        )

    def bcrypt_hash(pw):
        out = subprocess.run(
            ["node", "-e",
             "const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
             f"console.log(b.hashSync({json.dumps(pw)}, 12))"],
            capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def make_opener():
        cj = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    def login(op, email, password):
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        token = m.group(1) if m else ""
        payload = {"email": email, "password": password}
        if token:
            payload["CSRFToken"] = token
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed for {email}: {parsed}"
        return token

    def call(op, token, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        req = urllib.request.Request(f"{PHP}/api/admin/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def scrub(v):
        if isinstance(v, dict):
            return {k: scrub(x) for k, x in v.items() if k not in ("created_at", "updated_at")}
        if isinstance(v, list):
            return [scrub(x) for x in v]
        return v

    def cleanup_staff(sid):
        d.execute("DELETE FROM admin_group_member WHERE admin_id = ?", (sid,))
        d.execute("DELETE FROM admin_password_reset WHERE admin_id = ?", (sid,))
        d.execute("DELETE FROM activity_admin_history WHERE admin_id = ?", (sid,))
        d.execute("DELETE FROM admin WHERE id = ?", (sid,))
        d.commit()

    def drop_group(gid):
        d.execute("DELETE FROM admin_group_member WHERE admin_group_id = ?", (gid,))
        d.execute("DELETE FROM admin_group WHERE id = ?", (gid,))
        d.commit()

    corpus = {}
    try:
        assert invariants() == (1, 3, 0, 67, 323, 11, 2, 3, 1, 2, 3, 0), invariants()
        h = bcrypt_hash(PERSONA_PASS)
        cur = d.cursor()
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)", (LEAD_EMAIL, h, "R2d Lead", FIXED_TS, FIXED_TS))
        lead_id = cur.lastrowid
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)", (STAFF_EMAIL, h, "R2d Staff", FIXED_TS, FIXED_TS))
        staff_id = cur.lastrowid
        cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, 2, ?)",
                    (lead_id, FIXED_TS))
        cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, 3, ?)",
                    (staff_id, FIXED_TS))
        d.commit()

        op_super = make_opener()
        tok_super = login(op_super, SUPER_EMAIL, SUPER_PASS)
        op_lead = make_opener()
        tok_lead = login(op_lead, LEAD_EMAIL, PERSONA_PASS)
        op_staff = make_opener()
        tok_staff = login(op_staff, STAFF_EMAIL, PERSONA_PASS)

        def c(op, tok, method, data=None):
            return call(op, tok, "staff", method, data)

        # Staff CRUD (super).
        env = c(op_super, tok_super, "create", {
            "email": "r2d-cap@example.local", "name": "R2d Cap", "password": CRAFT_PASS,
            "group_id": 3, "status": "active"})
        cid = env.get("result")
        corpus["staff_create"] = env
        corpus["staff_get"] = scrub(c(op_super, tok_super, "get", {"id": cid}).get("result"))
        corpus["staff_update"] = c(op_super, tok_super, "update", {
            "id": cid, "email": "r2d-cap2@example.local", "name": "R2d Cap 2"})
        corpus["staff_get_after_update"] = scrub(c(op_super, tok_super, "get", {"id": cid}).get("result"))
        corpus["staff_change_password"] = c(op_super, tok_super, "change_password", {
            "id": cid, "password": NEW_PASS, "password_confirm": NEW_PASS})
        corpus["staff_delete"] = c(op_super, tok_super, "delete", {"id": cid})
        cleanup_staff(cid)

        # Group matrix round-trip, PHP-native nested form shape.
        SET1 = {"support": {"access": True, "view": True, "manage_tickets": True},
                "staff": {"access": True, "view": True}, "invoice": {"access": True}}
        nested = {f"permissions[{m}][{k}]": "1" for m, keys in SET1.items() for k in keys}
        env = c(op_super, tok_super, "group_create", {"name": "R2d Cap Group"})
        gid = env.get("result")
        corpus["group_create"] = env
        corpus["group_update_permissions"] = c(op_super, tok_super, "group_update", {"id": gid, **nested})
        corpus["group_get_after_permissions"] = scrub(
            c(op_super, tok_super, "group_get", {"id": gid}).get("result"))
        corpus["group_delete"] = c(op_super, tok_super, "group_delete", {"id": gid})

        # Hierarchy refusals (Lead).
        corpus["lead_create_own_group"] = c(op_lead, tok_lead, "create", {
            "email": "r2d-cap-own@example.local", "name": "Own", "password": CRAFT_PASS,
            "group_id": 2, "status": "active"})
        corpus["lead_update_self"] = c(op_lead, tok_lead, "update", {"id": lead_id, "name": "Self"})
        corpus["lead_update_super"] = c(op_lead, tok_lead, "update", {"id": 1, "name": "Super"})
        corpus["lead_delete_super"] = c(op_lead, tok_lead, "delete", {"id": 1})
        corpus["lead_group_update"] = c(op_lead, tok_lead, "group_update", {"id": 2, "name": "X"})
        corpus["staff_group_get"] = c(op_staff, tok_staff, "group_get", {"id": 2})

        # Last-active-super-administrator refusals (refusal-only).
        corpus["last_admin_delete"] = c(op_super, tok_super, "delete", {"id": 1})
        corpus["last_admin_remove_member"] = c(op_super, tok_super, "group_member_remove",
                                               {"admin_id": 1, "group_id": 1})
        corpus["self_deactivate"] = c(op_super, tok_super, "update", {"id": 1, "status": "inactive"})

        # Protected-group guards.
        corpus["group_protected_update"] = c(op_super, tok_super, "group_update",
                                             {"id": 1, "name": "Renamed"})
        corpus["group_protected_delete"] = c(op_super, tok_super, "group_delete", {"id": 1})

        for name, value in corpus.items():
            (OUT / f"{name}.json").write_text(json.dumps(value, indent=2, default=str) + "\n")
        print(f"capture31: {len(corpus)} cases -> {OUT}")
    finally:
        restore()
        got = invariants()
        print("invariants-after:", got)
        assert got == (1, 3, 0, 67, 323, 11, 2, 3, 1, 2, 3, 0), got


if __name__ == "__main__":
    main()
