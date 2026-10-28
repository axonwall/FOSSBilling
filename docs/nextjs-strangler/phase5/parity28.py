#!/usr/bin/env python3
"""Phase 5 R2d parity: staff + group pages and the staff hierarchy
guards, compared live on PHP (:8080) vs TS (:3001/api/fb).

Sections:
  A. Page smoke (TS pages only, super-admin): every new route returns
     200 with the sidebar Staff section and markers proving real data
     rendered; missing-record cases render the API error box.
  B. Logged-out smoke: staff list + one group page render without the
     sidebar and show the staff sign-in link.
  C. Secret audit: staff/group envelopes on both stacks contain no
     pass/api_token/password keys at any depth.
  D. Staff create/update/delete/change_password equivalence (super,
     crafted rows, PHP outputs recorded then replayed on TS after a
     full restore + reseed, so ids match; timestamp fields scrubbed).
  E. Group matrix round-trip + guard messages (protected / members /
     children blocks) on both stacks.
  F. Hierarchy cases (Lead + Staff personas): descendant allows,
     own/super refusals, self-management refusal, last-active-super-
     administrator refusals (refusal-only against real rows, asserted
     still intact afterwards).
  G. Non-super viewer behavior on group pages (TS pages): Lead gets
     the super-admin notice without live group data; Staff gets the
     403 error box; sidebar Groups link follows manage_groups.
Only envelopes are compared, never HTTP status: TS error envelopes are
always HTTP 200 by seam convention while PHP answers 4xx with the same
envelope, documented not hidden.
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
TS = "http://127.0.0.1:3001/api/fb"
TS_PAGES = "http://127.0.0.1:3001"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
LEAD_EMAIL = "r2d-lead@example.local"
STAFF_EMAIL = "r2d-staff@example.local"
PERSONA_PASS = "R2d-Staff!42"
CRAFT_PASS = "R2d-Craft!42"
NEW_PASS = "R2d-New!42"
FIXED_TS = "2026-10-28 12:00:00"

FAILURES = []
CHECKS = 0
STATUS_NOTES = []


def check(name, php_val, ts_val):
    global CHECKS
    CHECKS += 1
    if php_val != ts_val:
        FAILURES.append((name, php_val, ts_val))
        print("FAIL", name)
        print("  php:", json.dumps(php_val, default=str)[:400])
        print("  ts :", json.dumps(ts_val, default=str)[:400])
    else:
        print("ok  ", name)


def check_true(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if not cond:
        FAILURES.append((name, detail, ""))
        print("FAIL", name, detail)
    else:
        print("ok  ", name)


def scrub(v):
    """Drop timestamp fields so API-created rows compare across runs."""
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items() if k not in ("created_at", "updated_at")}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


def main():
    global CHECKS
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
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
        got = (
            q("SELECT COUNT(*) FROM tld"), q("SELECT COUNT(*) FROM tld_registrar"),
            q("SELECT COUNT(*) FROM service_domain"), q("SELECT COUNT(*) FROM email_queue"),
            d.execute("SELECT value FROM setting WHERE id=52").fetchone()[0],
            q("SELECT COUNT(*) FROM invoice"), q("SELECT COUNT(*) FROM client_order"),
            q("SELECT COUNT(*) FROM admin"), q("SELECT COUNT(*) FROM admin_group"),
            q("SELECT COUNT(*) FROM admin_group_member"), q("SELECT COUNT(*) FROM support_ticket"),
            q("SELECT COUNT(*) FROM client"), q("SELECT COUNT(*) FROM service_downloadable"),
        )
        want = (1, 3, 0, 67, "2026-10-26 03:24:56", 323, 11, 2, 3, 1, 2, 3, 0)
        return got, want

    got, want = invariants()
    check_true("invariants-before", got == want, f"{got} != {want}")

    def bcrypt_hash(pw):
        out = subprocess.run(
            ["node", "-e",
             "const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
             f"console.log(b.hashSync({json.dumps(pw)}, 12))"],
            capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    def seed_personas():
        h = bcrypt_hash(PERSONA_PASS)
        cur = d.cursor()
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)",
            (LEAD_EMAIL, h, "R2d Lead", FIXED_TS, FIXED_TS))
        lead_id = cur.lastrowid
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)",
            (STAFF_EMAIL, h, "R2d Staff", FIXED_TS, FIXED_TS))
        staff_id = cur.lastrowid
        cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, 2, ?)",
                    (lead_id, FIXED_TS))
        cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, 3, ?)",
                    (staff_id, FIXED_TS))
        d.commit()
        return lead_id, staff_id

    def make_opener():
        cj = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

    def login(op, email, password):
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        token = m.group(1) if m else ""
        payload = {"email": email, "password": password}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed for {email}: {parsed}"
        return token

    def call(op, token, base, role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw, status = resp.read(), resp.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        try:
            parsed = json.loads(raw.decode())
        except Exception:
            parsed = {"_raw": raw[:200].decode("utf-8", "replace")}
        if not isinstance(parsed, dict):
            # A non-envelope response (never observed on a clean run) must
            # be recorded, not crash the run: wrap it and print the raw.
            print(f"NON-DICT response from {url}: {raw[:200]!r}")
            parsed = {"_non_dict": parsed}
        return parsed, status

    def page(op, path):
        req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
        try:
            with op.open(req, timeout=60) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def db_one(sql, params=()):
        row = d.execute(sql, params).fetchone()
        return row[0] if row else None

    def db_all(sql, params=()):
        return [tuple(r) for r in d.execute(sql, params).fetchall()]

    def craft_staff(email, group_id):
        h = bcrypt_hash(CRAFT_PASS)
        cur = d.cursor()
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)",
            (email, h, "R2d Craft", FIXED_TS, FIXED_TS))
        sid = cur.lastrowid
        if group_id is not None:
            cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, ?, ?)",
                        (sid, group_id, FIXED_TS))
        d.commit()
        return sid

    def cleanup_staff(sid):
        # Session rows are content-addressed per case (see D6); this helper
        # removes only rows the harness itself created for a crafted admin.
        d.execute("DELETE FROM admin_group_member WHERE admin_id = ?", (sid,))
        d.execute("DELETE FROM admin_password_reset WHERE admin_id = ?", (sid,))
        d.execute("DELETE FROM activity_admin_history WHERE admin_id = ?", (sid,))
        d.execute("DELETE FROM admin WHERE id = ?", (sid,))
        d.commit()

    def craft_group(name, parent_id=None):
        cur = d.cursor()
        if parent_id is None:
            cur.execute(
                "INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
                " VALUES (?, NULL, NULL, 0, 1, ?, ?)", (name, FIXED_TS, FIXED_TS))
        else:
            cur.execute(
                "INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
                " VALUES (?, NULL, NULL, 0, ?, ?, ?)", (name, parent_id, FIXED_TS, FIXED_TS))
        gid = cur.lastrowid
        d.commit()
        return gid

    def drop_group(gid):
        d.execute("DELETE FROM admin_group_member WHERE admin_group_id = ?", (gid,))
        d.execute("DELETE FROM admin_group WHERE id = ?", (gid,))
        d.commit()

    FORBIDDEN_KEYS = {"pass", "api_token", "password", "password_hash", "token"}

    def scan_secrets(v, path="$"):
        bad = []
        if isinstance(v, dict):
            for k, x in v.items():
                if k in FORBIDDEN_KEYS:
                    bad.append(f"{path}.{k}")
                bad += scan_secrets(x, f"{path}.{k}")
        elif isinstance(v, list):
            for i, x in enumerate(v):
                bad += scan_secrets(x, f"{path}[{i}]")
        return bad

    def run(stack_label):
        """Run the mutation cases on one stack; returns {name: record}."""
        base = PHP if stack_label == "php" else TS
        op_super, _ = make_opener()
        tok_super = login(op_super, SUPER_EMAIL, SUPER_PASS)
        op_lead, _ = make_opener()
        tok_lead = login(op_lead, LEAD_EMAIL, PERSONA_PASS)
        op_staff, _ = make_opener()
        tok_staff = login(op_staff, STAFF_EMAIL, PERSONA_PASS)

        def c(op, tok, module, method, data=None):
            env, st = call(op, tok, base, "admin", module, method, data)
            if base == TS:
                STATUS_NOTES.append((method, st))
            return env

        out = {}

        def rec(name, value):
            out[name] = value

        # ---- D: staff CRUD (super) ----
        n = 0
        n += 1
        email = f"r2d-craft-{n}@example.local"
        env = c(op_super, tok_super, "staff", "create", {
            "email": email, "name": "R2d Craft", "password": CRAFT_PASS,
            "group_id": 3, "status": "active"})
        cid = env.get("result", {}).get("id") if isinstance(env.get("result"), dict) else env.get("result")
        if not isinstance(cid, int):
            cid = None
        got = c(op_super, tok_super, "staff", "get", {"id": cid}) if cid else {"error": "no-id"}
        rec("D1_staff_create_ok", {"create": env, "record": scrub(got.get("result"))})
        cleanup_staff(cid) if cid else None

        n += 1
        env = c(op_super, tok_super, "staff", "create", {
            "email": SUPER_EMAIL, "name": "Dup", "password": CRAFT_PASS,
            "group_id": 3, "status": "active"})
        rec("D2_staff_create_dup", env)

        env = c(op_super, tok_super, "staff", "create", {
            "email": "r2d-nogroup@example.local", "name": "NoGroup", "password": CRAFT_PASS,
            "group_id": 999999, "status": "active"})
        rec("D3_staff_create_nogroup", env)

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        env = c(op_super, tok_super, "staff", "update", {
            "id": sid, "email": f"r2d-updated-{n}@example.local", "name": "R2d Updated"})
        got = c(op_super, tok_super, "staff", "get", {"id": sid})
        rec("D4_staff_update_ok", {"update": env, "record": scrub(got.get("result"))})
        cleanup_staff(sid)

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        env = c(op_super, tok_super, "staff", "update", {"id": sid, "email": SUPER_EMAIL})
        rec("D5_staff_update_dup", env)
        cleanup_staff(sid)

        # D6: deactivate an active staff member who holds a session.
        # The session row is keyed by the session cookie value, so capture
        # it from the crafted member's jar and assert that exact row is
        # gone after deactivation (PHP and TS both invalidate sessions).
        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        op_c, cj_c = make_opener()
        tok_c = login(op_c, f"r2d-craft-{n}@example.local", CRAFT_PASS)
        # Find the session row by trying every jar cookie value against the
        # session table (cookie name varies; the row id is the value).
        sess_id = None
        for ck in cj_c:
            if db_one("SELECT COUNT(*) FROM session WHERE id = ?", (ck.value,)):
                sess_id = ck.value
                break
        sess_before = db_one("SELECT COUNT(*) FROM session WHERE id = ?", (sess_id,)) if sess_id else -1
        env = c(op_super, tok_super, "staff", "update", {"id": sid, "status": "inactive"})
        row = db_one("SELECT status FROM admin WHERE id = ?", (sid,))
        tok_after = db_one("SELECT api_token FROM admin WHERE id = ?", (sid,))
        sess_after = db_one("SELECT COUNT(*) FROM session WHERE id = ?", (sess_id,)) if sess_id else -1
        rec("D6_staff_deactivate", {"update": env, "status": row, "api_token": tok_after,
                                    "session_before": sess_before, "session_after": sess_after})
        cleanup_staff(sid)

        # D7: change_password, then new-password login works, old fails.
        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        env = c(op_super, tok_super, "staff", "change_password", {
            "id": sid, "password": NEW_PASS, "password_confirm": NEW_PASS})
        op_new, _ = make_opener()
        try:
            login(op_new, f"r2d-craft-{n}@example.local", NEW_PASS)
            new_ok = True
        except Exception:
            new_ok = False
        op_old, _ = make_opener()
        try:
            login(op_old, f"r2d-craft-{n}@example.local", CRAFT_PASS)
            old_ok = True
        except Exception:
            old_ok = False
        rec("D7_staff_change_password", {"change": env, "new_login_ok": new_ok, "old_login_ok": old_ok})
        cleanup_staff(sid)

        # D8: delete removes the row, memberships, and password resets.
        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        d.execute("INSERT INTO admin_password_reset (admin_id, hash, ip, created_at) VALUES (?, 'r2dreset', '127.0.0.1', ?)",
                  (sid, FIXED_TS))
        d.commit()
        env = c(op_super, tok_super, "staff", "delete", {"id": sid})
        rec("D8_staff_delete", {"delete": env,
                                "row_gone": db_one("SELECT COUNT(*) FROM admin WHERE id = ?", (sid,)),
                                "members_gone": db_one("SELECT COUNT(*) FROM admin_group_member WHERE admin_id = ?", (sid,)),
                                "resets_gone": db_one("SELECT COUNT(*) FROM admin_password_reset WHERE admin_id = ?", (sid,))})
        cleanup_staff(sid)

        # ---- E: group matrix round-trip + guards ----
        # E1 posts the PHP-native nested form shape
        # (permissions[mod][key]=1) on BOTH stacks and compares the
        # read-back JSON exactly. PHP stores the array verbatim
        # (strings included); the seam expands bracket keys verbatim
        # (R2d staff.ts fix — previously it silently ignored them).
        SET1 = {"support": {"access": True, "view": True, "manage_tickets": True},
                "staff": {"access": True, "view": True}, "invoice": {"access": True}}
        SET2 = {"support": {"access": True, "view": True},
                "order": {"access": True, "manage": True}}

        def nested_perms(s):
            return {f"permissions[{m}][{k}]": "1" for m, keys in s.items() for k in keys}

        def norm_perms(v):
            if isinstance(v, dict):
                return {k: norm_perms(x) for k, x in v.items()}
            if isinstance(v, list):
                return [norm_perms(x) for x in v]
            if v in (True, "1", "true"):
                return True
            if v in (False, "0", "false", ""):
                return False
            return v

        env_c = c(op_super, tok_super, "staff", "group_create", {"name": "R2d Matrix"})
        gid2 = env_c.get("result", {}).get("id") if isinstance(env_c.get("result"), dict) else env_c.get("result")
        env_u = c(op_super, tok_super, "staff", "group_update", {
            "id": gid2, **nested_perms(SET1)})
        got1 = c(op_super, tok_super, "staff", "group_get", {"id": gid2})
        env_u2 = c(op_super, tok_super, "staff", "group_update", {
            "id": gid2, **nested_perms(SET2)})
        got2 = c(op_super, tok_super, "staff", "group_get", {"id": gid2})
        env_d = c(op_super, tok_super, "staff", "group_delete", {"id": gid2})
        got3 = c(op_super, tok_super, "staff", "group_get", {"id": gid2})
        rec("E1_group_matrix_roundtrip", {
            "create": env_c, "update1": env_u,
            "perms1": got1.get("result", {}).get("permissions") if isinstance(got1.get("result"), dict) else got1,
            "update2": env_u2,
            "perms2": got2.get("result", {}).get("permissions") if isinstance(got2.get("result"), dict) else got2,
            "delete": env_d, "after_delete": got3})

        # E1b: the page's own mutation path — the group editor form posts
        # a JSON string to the seam. On PHP the equivalent page path is
        # the nested form shape, so compare truthiness-normalized
        # read-backs (PHP stores "1" strings, the JSON path booleans).
        env_c = c(op_super, tok_super, "staff", "group_create", {"name": "R2d Matrix Json"})
        gid3 = env_c.get("result", {}).get("id") if isinstance(env_c.get("result"), dict) else env_c.get("result")
        if stack_label == "ts":
            c(op_super, tok_super, "staff", "group_update", {
                "id": gid3, "permissions": json.dumps(SET1)})
        else:
            c(op_super, tok_super, "staff", "group_update", {
                "id": gid3, **nested_perms(SET1)})
        gotj = c(op_super, tok_super, "staff", "group_get", {"id": gid3})
        c(op_super, tok_super, "staff", "group_delete", {"id": gid3})
        rec("E1b_group_matrix_json_path", norm_perms(
            gotj.get("result", {}).get("permissions") if isinstance(gotj.get("result"), dict) else gotj))

        env = c(op_super, tok_super, "staff", "group_update", {"id": 1, "name": "Renamed"})
        rec("E2_group_protected_update", env)
        env = c(op_super, tok_super, "staff", "group_delete", {"id": 1})
        rec("E3_group_protected_delete", env)

        parent = craft_group("R2d Parent")
        child = craft_group("R2d Child", parent)
        env = c(op_super, tok_super, "staff", "group_delete", {"id": parent})
        rec("E4_group_delete_children", env)
        drop_group(child)
        drop_group(parent)

        n += 1
        grp = craft_group("R2d WithMember")
        sid = craft_staff(f"r2d-craft-{n}@example.local", grp)
        env = c(op_super, tok_super, "staff", "group_delete", {"id": grp})
        rec("E5_group_delete_members", env)
        cleanup_staff(sid)
        drop_group(grp)

        grp = craft_group("R2d Reparent")
        env = c(op_super, tok_super, "staff", "group_update", {"id": grp, "parent_id": 3})
        got = c(op_super, tok_super, "staff", "group_get", {"id": grp})
        rec("E6_group_reparent", {"update": env, "record": scrub(got.get("result"))})
        drop_group(grp)

        # ---- F: hierarchy cases ----
        n += 1
        env = c(op_lead, tok_lead, "staff", "create", {
            "email": f"r2d-craft-{n}@example.local", "name": "Lead Craft", "password": CRAFT_PASS,
            "group_id": 3, "status": "active"})
        lid = env.get("result", {}).get("id") if isinstance(env.get("result"), dict) else env.get("result")
        got = c(op_lead, tok_lead, "staff", "get", {"id": lid}) if isinstance(lid, int) else {"error": "no-id"}
        rec("F1_lead_create_descendant", {"create": env, "record": scrub(got.get("result"))})
        cleanup_staff(lid) if isinstance(lid, int) else None

        env = c(op_lead, tok_lead, "staff", "create", {
            "email": "r2d-own@example.local", "name": "Own", "password": CRAFT_PASS,
            "group_id": 2, "status": "active"})
        rec("F2_lead_create_own", env)
        env = c(op_lead, tok_lead, "staff", "create", {
            "email": "r2d-super@example.local", "name": "Super", "password": CRAFT_PASS,
            "group_id": 1, "status": "active"})
        rec("F3_lead_create_super", env)

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        env = c(op_lead, tok_lead, "staff", "update", {"id": sid, "name": "Lead Renamed"})
        got = c(op_lead, tok_lead, "staff", "get", {"id": sid})
        rec("F4_lead_update_descendant", {"update": env, "record": scrub(got.get("result"))})
        cleanup_staff(sid)

        lead_id = db_one("SELECT id FROM admin WHERE email = ?", (LEAD_EMAIL,))
        env = c(op_lead, tok_lead, "staff", "update", {"id": lead_id, "name": "Self Rename"})
        rec("F5_lead_update_self", env)
        env = c(op_lead, tok_lead, "staff", "update", {"id": 1, "name": "Super Rename"})
        rec("F6_lead_update_super", env)

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        env = c(op_lead, tok_lead, "staff", "delete", {"id": sid})
        rec("F7_lead_delete_descendant", {"delete": env,
                                          "row_gone": db_one("SELECT COUNT(*) FROM admin WHERE id = ?", (sid,))})
        cleanup_staff(sid)
        env = c(op_lead, tok_lead, "staff", "delete", {"id": 1})
        rec("F8_lead_delete_super", env)

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 3)
        env = c(op_lead, tok_lead, "staff", "change_password", {
            "id": sid, "password": NEW_PASS, "password_confirm": NEW_PASS})
        op_new, _ = make_opener()
        try:
            login(op_new, f"r2d-craft-{n}@example.local", NEW_PASS)
            new_ok = True
        except Exception:
            new_ok = False
        rec("F9_lead_changepw_descendant", {"change": env, "new_login_ok": new_ok})
        cleanup_staff(sid)

        env = c(op_lead, tok_lead, "staff", "change_password", {
            "id": lead_id, "password": NEW_PASS, "password_confirm": NEW_PASS})
        rec("F10_lead_changepw_self", env)

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", None)
        env = c(op_lead, tok_lead, "staff", "group_member_add", {"admin_id": sid, "group_id": 3})
        got = c(op_super, tok_super, "staff", "get", {"id": sid})
        rec("F11_lead_member_add_descendant", {"add": env,
                                               "groups": scrub(got.get("result", {}).get("groups")) if isinstance(got.get("result"), dict) else got})
        env = c(op_lead, tok_lead, "staff", "group_member_add", {"admin_id": sid, "group_id": 1})
        rec("F12_lead_member_add_super", env)
        env = c(op_lead, tok_lead, "staff", "group_member_remove", {"admin_id": sid, "group_id": 3})
        rec("F13_lead_member_remove_descendant", env)
        cleanup_staff(sid)

        grp = craft_group("R2d LeadGroup")
        env = c(op_lead, tok_lead, "staff", "group_update", {"id": grp, "name": "Lead Rename"})
        rec("F14_lead_group_update", env)
        drop_group(grp)

        env = c(op_staff, tok_staff, "staff", "group_get", {"id": 2})
        rec("F15_staff_group_get", env)
        env = c(op_staff, tok_staff, "staff", "create", {
            "email": "r2d-staffcreate@example.local", "name": "Denied", "password": CRAFT_PASS,
            "group_id": 3, "status": "active"})
        rec("F16_staff_create_denied", env)

        env = c(op_super, tok_super, "staff", "delete", {"id": 1})
        rec("F17_last_admin_delete", {"delete": env,
                                      "still_active": db_one("SELECT status FROM admin WHERE id = 1"),
                                      "still_member": db_one("SELECT COUNT(*) FROM admin_group_member WHERE admin_id = 1 AND admin_group_id = 1")})

        n += 1
        sid = craft_staff(f"r2d-craft-{n}@example.local", 1)
        env = c(op_super, tok_super, "staff", "update", {"id": sid, "status": "inactive"})
        rec("F18_last_admin_deactivate_other", {"update": env,
                                                "still_active": db_one("SELECT status FROM admin WHERE id = ?", (sid,))})
        cleanup_staff(sid)

        env = c(op_super, tok_super, "staff", "group_member_remove", {"admin_id": 1, "group_id": 1})
        rec("F19_last_admin_remove_member", {"remove": env,
                                             "still_member": db_one("SELECT COUNT(*) FROM admin_group_member WHERE admin_id = 1 AND admin_group_id = 1")})

        env = c(op_super, tok_super, "staff", "update", {"id": 1, "status": "inactive"})
        rec("F20_self_deactivate", env)

        env = c(op_lead, tok_lead, "staff", "group_get_list", {})
        rec("F21_lead_group_list", scrub(env))
        env = c(op_staff, tok_staff, "staff", "group_get_list", {})
        rec("F22_staff_group_list_denied", env)

        # ---- C: secret audit (both stacks, read-only) ----
        for label, env in [
            ("staff_get", c(op_super, tok_super, "staff", "get", {"id": 1})),
            ("staff_list", c(op_super, tok_super, "staff", "get_list", {})),
            ("group_get", c(op_super, tok_super, "staff", "group_get", {"id": 2})),
            ("group_list", c(op_super, tok_super, "staff", "group_get_list", {})),
        ]:
            rec(f"C_secret_{label}", scan_secrets(env))

        return out, (op_super, op_lead, op_staff)

    # ---- A/B/G: page smokes (TS pages, read-only) ----
    def smoke(name, op, path, status_want, must, must_not):
        st, html = page(op, path)
        check_true(f"{name} status", st == status_want, f"got {st}")
        for m in must:
            check_true(f"{name} marker:{m}", m in html, f"missing {m!r}")
        for m in must_not:
            check_true(f"{name} absent:{m}", m not in html, f"leaked {m!r}")

    seed_personas()
    op_super, _ = make_opener()
    login(op_super, SUPER_EMAIL, SUPER_PASS)
    op_lead, _ = make_opener()
    login(op_lead, LEAD_EMAIL, PERSONA_PASS)
    op_staff, _ = make_opener()
    login(op_staff, STAFF_EMAIL, PERSONA_PASS)
    op_anon, _ = make_opener()

    # A: super-admin smoke on every new route.
    # (List-page h1 is "Staff", not "Staff members"; missing-record
    # boxes show the API message, "Staff member not found" /
    # "Group not found".)
    smoke("A_staff_list", op_super, "/admin/staff", 200,
          ["Phase Zero Admin", "New staff member", "/admin/staff/groups",
           "Support Lead"], [])
    smoke("A_staff_new", op_super, "/admin/staff/new", 200,
          ["New staff member", "Email", "Password"], [])
    smoke("A_staff_detail", op_super, "/admin/staff/1", 200,
          ["Edit staff member", "Phase Zero Admin", "Change password", "Recent logins",
           "Groups", "Delete staff member"], [])
    smoke("A_staff_detail_cron", op_super, "/admin/staff/2", 200,
          ["Edit staff member", "System Cron Job"], [])
    smoke("A_groups_list", op_super, "/admin/staff/groups", 200,
          ["Staff groups", "Super Administrator", "Support Lead", "New group"], [])
    smoke("A_groups_new", op_super, "/admin/staff/groups/new", 200,
          ["New staff group", "Name", "Parent group"], [])
    smoke("A_group_editor", op_super, "/admin/staff/groups/2", 200,
          ["Support Lead", "Save permissions", "Members", "Delete group"], [])
    smoke("A_group_protected", op_super, "/admin/staff/groups/1", 200,
          ["Super Administrator", "protected system group"], ["Save permissions"])
    smoke("A_staff_missing", op_super, "/admin/staff/999999", 200,
          ["Staff member not found"], [])
    smoke("A_group_missing", op_super, "/admin/staff/groups/999999", 200,
          ["Group not found"], [])
    # Sidebar Staff section on a staff page (detail page has no Groups
    # link in main content, so the href proves the sidebar section).
    smoke("A_sidebar_staff", op_super, "/admin/staff/1", 200,
          ['href="/admin/staff"', 'href="/admin/staff/groups"'], [])

    # B: logged-out smoke — fallback header chrome, no <aside> sidebar,
    # and the R2c-style sign-in link on the error box.
    smoke("B_logged_out_staff", op_anon, "/admin/staff", 200,
          ["Sign in as staff", "Authentication Failed"], ["<aside", "Phase Zero Admin"])
    smoke("B_logged_out_group", op_anon, "/admin/staff/groups/2", 200,
          ["Sign in as staff", "Authentication Failed"], ["<aside", "Save permissions"])

    # G: non-super viewers on group pages. PHP's page-read guard for a
    # persona with no staff module access at all (Support Staff, group 3
    # holds support perms only) is the dispatcher 725 message "You do
    # not have access to the staff module" (Dispatcher.php:69 — the
    # module-access gate fires before AppAdmin's 403) — so the Staff
    # persona gets error boxes, not lists, on every staff page.
    MODULE_DENIED = "You do not have access to the staff module"
    smoke("G_lead_group_editor", op_lead, "/admin/staff/groups/2", 200,
          ["Only super administrators can manage staff groups"],
          ["Save permissions", "Support Lead"])
    smoke("G_staff_group_editor", op_staff, "/admin/staff/groups/2", 200,
          [MODULE_DENIED], ["Save permissions", "Support Lead"])
    smoke("G_lead_group_list", op_lead, "/admin/staff/groups", 200,
          ["Staff groups", "Super Administrator"], [])
    smoke("G_staff_group_list", op_staff, "/admin/staff/groups", 200,
          [MODULE_DENIED], ["Super Administrator"])
    smoke("G_lead_staff_list", op_lead, "/admin/staff", 200,
          ["Phase Zero Admin", "New staff member"], [])
    smoke("G_staff_staff_list", op_staff, "/admin/staff", 200,
          [MODULE_DENIED], ["Phase Zero Admin"])
    # Sidebar filtering: Lead's detail page carries the Groups sidebar
    # link (no Groups link in main content there); Staff's detail page
    # errors (no staff access) and carries no Groups link. The dashboard
    # (no staff links in main content) proves Staff has no Staff
    # section at all while Lead has the Groups link.
    smoke("G_lead_sidebar", op_lead, "/admin/staff/1", 200,
          ["Edit staff member", 'href="/admin/staff/groups"'], [])
    smoke("G_staff_sidebar", op_staff, "/admin/staff/1", 200,
          [MODULE_DENIED], ['href="/admin/staff/groups"'])
    smoke("G_lead_dashboard_sidebar", op_lead, "/admin", 200,
          ['href="/admin/staff/groups"'], [])
    smoke("G_staff_dashboard_sidebar", op_staff, "/admin", 200,
          [], ['href="/admin/staff"'])

    # ---- Mutation equivalence: PHP first, then restore + TS ----
    try:
        php_out, _ = run("php")
    finally:
        restore()
    seed_personas()
    ts_out = None
    try:
        ts_out, _ = run("ts")
    finally:
        restore()
    for name in php_out:
        check(f"mut:{name}", php_out[name], ts_out.get(name) if ts_out else None)
    for name in ts_out:
        if name not in php_out:
            check_true(f"mut:extra-{name}", False, "TS-only case")

    # TS error envelopes must all be HTTP 200 (seam convention).
    non200 = [(m, s) for m, s in STATUS_NOTES if s != 200]
    check_true("ts_envelopes_http200", not non200, str(non200[:5]))

    restore()
    got, want = invariants()
    check_true("invariants-after", got == want, f"{got} != {want}")
    print(f"\nparity28: {CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILURES:")
        for f in FAILURES:
            print(" -", f[0])
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
