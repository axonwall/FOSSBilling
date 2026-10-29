#!/usr/bin/env python3
"""R5a parity: config store + six deferred system endpoints +
update_params validation.

Sections:
  A. Baselines + invariants before.
  B. Six endpoints, super admin, both stacks, exact envelopes.
  C. Permission matrix (crafted groups/staff, snapshot-restored):
     support-only -> 725 on all; system-access-no-keys -> 403 on all;
     manage_settings -> localization_settings only; view -> the three
     view endpoints only; update_params -> update_localization_settings
     (the PINNED asymmetry: update_localization_settings needs
     update_params, NOT manage_settings) + update_params itself.
     Logged-out -> 201 on all seven (fresh opener PER CALL: a logged-out
     call primes the jar with an anonymous session cookie, which would
     turn later TS calls into CSRF 403s instead of 201s).
  D. update_params validation, both stacks, exact envelopes:
     invalid starting x7, invalid reminder x5, combined both orders,
     mixed-case key, JSON null/true/5.5 starting, JSON 5 starting
     (valid), urlencoded valid writes + read-backs, validate-then-write
     (probe absent), full-form 38-field post with current values,
     full-form post with one invalid field (nothing written).
  E. Config writes via HTTP (real config, bytes restored in finally):
     toggle round-trips on each stack + cross-stack visibility
     (TS write -> PHP read, polled: PHP opcache revalidation could
     lag; a poll timeout here FAILS, it is not papered over);
     update_localization round-trips; .old.php backup chain
     assertions (TS backup after a two-write call holds the FIRST
     write's result; PHP's holds the pre-call file OR the first
     write, because Symfony's copy skips when the mtimes tie —
     see the E-section comment for the vendor proof).
  F. Secret scan over captured envelopes.
  G. Restore proof (DB snapshot + config bytes + old.php state +
     invariants + crafted rows gone).

Two documented notes, not failures:
  N1. JSON-null reminder: PHP stores NULL, TS stores the string
     "null" (route stringifies JSON null into params; the R5a scope
     leaves the write loop untouched). Envelopes agree (true); the
     stored value differs. Asserted explicitly as a divergence.
  N2. R2e's "39 fields" is an arithmetic slip: the enumerated form
     fields total 38 (21 company + 13 invoices/funds + 4
     nameservers), matching system-settings-fields.ts. parity34 posts
     the actual 38.

Exit 0 only when every check passes.
"""
import hashlib
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
OLDP = CFG.replace("config.php", "config.old.php")
PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
CHECKS = 0
FAILURES = []
ENVELOPES = []
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
PERSONA_PASS = "Parity34-Persona!42"
FIXED_TS = "2026-10-28 12:00:00"
MAX_MINUS_1 = "9223372036854775806"
MAX_VAL = "9223372036854775807"
START_ERR = "Next invoice number must be a positive whole number no greater than 9223372036854775806."
REMIND_ERR = "Reminder send time must be empty or a valid 24-hour time (HH:MM)."
FIELDS_38 = ["company_name", "company_email", "company_tel", "company_address_1",
             "company_address_2", "company_address_3", "company_logo", "company_logo_dark",
             "company_favicon", "company_number", "company_vat_number", "company_account_number",
             "company_bank_name", "company_bic", "company_display_bank_info",
             "company_bank_info_pagebottom", "hide_company_public", "company_signature",
             "company_tos", "company_privacy_policy", "company_note", "invoice_series",
             "invoice_starting_number", "invoice_cn_series", "invoice_cn_starting_number",
             "invoice_dn_series", "invoice_dn_starting_number", "invoice_due_days",
             "invoice_auto_issue", "invoice_refund_logic", "invoice_hash_lifetime_days",
             "invoice_issue_days_before_expire", "funds_min_amount", "funds_max_amount",
             "nameserver_1", "nameserver_2", "nameserver_3", "nameserver_4"]
SIX = ["localization_settings", "update_localization_settings", "error_reporting_enabled",
       "toggle_error_reporting", "last_error_reporting_change", "instance_id"]


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def check_env(name, got, want):
    check(name, got == want, f"got={got} want={want}")


def find_secret_keys(obj, path="$"):
    hits = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if any(s in str(k).lower() for s in ("pass", "token", "salt", "secret", "api_key")):
                hits.append(f"{path}.{k}")
            hits += find_secret_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits += find_secret_keys(v, f"{path}[{i}]")
    return hits


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def staff_login(opener, email, password):
    resp = opener.open(PHP + "/login")
    page = resp.read().decode("utf-8", "replace")
    token = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page).group(1)
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(PHP + "/api/guest/staff/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def call(opener, token, base, role, module, method, params=None, as_json=False):
    if as_json:
        payload = {"CSRFToken": token} if token else {}
        payload.update(params or {})
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}",
            data=body, method="POST", headers={"Content-Type": "application/json"})
    else:
        payload = dict(params or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
    try:
        raw = opener.open(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    env = json.loads(raw)
    ENVELOPES.append(env)
    return env


def bcrypt_hash(password):
    return subprocess.run(
        ["node", "-e",
         "const b=require('bcryptjs');console.log(b.hashSync(process.argv[1],12))", password],
        cwd="/home/hatch/scratch/fossbilling/repo/apps/nextjs",
        capture_output=True, text=True, check=True).stdout.strip()


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    snaps = {}
    for t in tables:
        cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
    seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()
    cfg_bytes = pathlib.Path(CFG).read_bytes()
    cfg_hash = hashlib.sha256(cfg_bytes).hexdigest()
    old_bytes = pathlib.Path(OLDP).read_bytes() if pathlib.Path(OLDP).exists() else None

    def invariants():
        q = lambda sql, args=(): d.execute(sql, args).fetchone()[0]
        return {
            "tld": q("SELECT COUNT(*) FROM tld"),
            "tld_registrar": q("SELECT COUNT(*) FROM tld_registrar"),
            "service_domain": q("SELECT COUNT(*) FROM service_domain"),
            "service_downloadable": q("SELECT COUNT(*) FROM service_downloadable"),
            "service_custom": q("SELECT COUNT(*) FROM service_custom"),
            "email_queue": q("SELECT COUNT(*) FROM email_queue"),
            "setting_rows": q("SELECT COUNT(*) FROM setting"),
            "invoice": q("SELECT COUNT(*) FROM invoice"),
            "client_order": q("SELECT COUNT(*) FROM client_order"),
            "support_ticket": q("SELECT COUNT(*) FROM support_ticket"),
            "client": q("SELECT COUNT(*) FROM client"),
            "admin": q("SELECT COUNT(*) FROM admin"),
            "admin_group": q("SELECT COUNT(*) FROM admin_group"),
            "admin_group_member": q("SELECT COUNT(*) FROM admin_group_member"),
            "currency": q("SELECT COUNT(*) FROM currency"),
            "extension": q("SELECT COUNT(*) FROM extension"),
            "extension_meta": q("SELECT COUNT(*) FROM extension_meta"),
        }

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
        pathlib.Path(CFG).write_bytes(cfg_bytes)
        if old_bytes is None:
            if pathlib.Path(OLDP).exists():
                pathlib.Path(OLDP).unlink()
        else:
            pathlib.Path(OLDP).write_bytes(old_bytes)

    try:
        inv0 = invariants()
        check_env("A invariants baseline", inv0, {
            "tld": 1, "tld_registrar": 3, "service_domain": 0, "service_downloadable": 0,
            "service_custom": 17, "email_queue": 67, "setting_rows": 38, "invoice": 323,
            "client_order": 11, "support_ticket": 2, "client": 3, "admin": 2, "admin_group": 3,
            "admin_group_member": 1, "currency": 1, "extension": 6, "extension_meta": 3})

        op = make_opener()
        stok = staff_login(op, SUPER_EMAIL, SUPER_PASS)

        # ---- B: super reads, exact envelopes.
        for m in ("localization_settings", "error_reporting_enabled",
                  "last_error_reporting_change", "instance_id"):
            p = call(op, stok, PHP, "admin", "system", m)
            t = call(op, stok, TS, "admin", "system", m)
            check_env(f"B {m} envelopes equal", t, p)
        check_env("B localization shape", call(op, stok, TS, "admin", "system", "localization_settings"),
                  {"error": None, "result": {"locale": "en_US", "auto_detect_locale": True}})
        check_env("B last_change constant", call(op, stok, TS, "admin", "system", "last_error_reporting_change"),
                  {"error": None, "result": "0.8.8"})

        # ---- C: permission matrix (crafted groups + staff).
        def craft_group(perms):
            cur = d.cursor()
            cur.execute(
                "INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
                " VALUES (?, NULL, ?, 0, 1, ?, ?)",
                ("R5a Craft", json.dumps(perms), FIXED_TS, FIXED_TS))
            gid = cur.lastrowid
            d.commit()
            return gid

        def craft_staff(email, gid):
            h = bcrypt_hash(PERSONA_PASS)
            cur = d.cursor()
            cur.execute(
                "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
                " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)",
                (email, h, "R5a Craft", FIXED_TS, FIXED_TS))
            sid = cur.lastrowid
            if gid is not None:
                cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at) VALUES (?, ?, ?)",
                            (sid, gid, FIXED_TS))
            d.commit()
            return sid

        personas = {}
        for label, perms in (
                ("access", {"system": {"access": True}}),
                ("manage", {"system": {"access": True, "manage_settings": True}}),
                ("view", {"system": {"access": True, "view": True}}),
                ("update", {"system": {"access": True, "update_params": True}}),
                ("support", {"support": {"access": True, "view": True, "manage_tickets": True}})):
            gid = craft_group(perms)
            sid = craft_staff(f"r5a-{label}@example.com", gid)
            o = make_opener()
            tok = staff_login(o, f"r5a-{label}@example.com", PERSONA_PASS)
            personas[label] = (o, tok)
        # Support-only 725s + logged-out 201s need no crafted staff beyond above.
        for m in SIX + ["update_params"]:
            for label, (o, tok) in personas.items():
                p = call(o, tok, PHP, "admin", "system", m, {} if m != "update_localization_settings" else {})
                t = call(o, tok, TS, "admin", "system", m, {} if m != "update_localization_settings" else {})
                check_env(f"C {label} {m} envelopes equal", t, p)
        # Pinned semantics.
        o, tok = personas["support"]
        for m in SIX + ["update_params"]:
            env = call(o, tok, TS, "admin", "system", m, {})
            check(f"C support {m} is 725", env.get("error", {}).get("code") == 725, str(env)[:160])
        o, tok = personas["access"]
        for m in SIX + ["update_params"]:
            env = call(o, tok, TS, "admin", "system", m, {})
            check(f"C access-only {m} is 403", env.get("error", {}).get("code") == 403, str(env)[:160])
        o, tok = personas["manage"]
        check_env("C manage localization_settings ok",
                  call(o, tok, TS, "admin", "system", "localization_settings")["error"], None)
        check("C manage toggle is 403",
              call(o, tok, TS, "admin", "system", "toggle_error_reporting")["error"]["code"] == 403)
        o, tok = personas["view"]
        for m in ("error_reporting_enabled", "last_error_reporting_change", "instance_id"):
            check_env(f"C view {m} ok", call(o, tok, TS, "admin", "system", m)["error"], None)
        check("C view localization is 403",
              call(o, tok, TS, "admin", "system", "localization_settings")["error"]["code"] == 403)
        o, tok = personas["update"]
        check_env("C update_params-key update_localization ok (asymmetry)",
                  call(o, tok, TS, "admin", "system", "update_localization_settings", {})["error"], None)
        check("C update_params-key localization is 403",
              call(o, tok, TS, "admin", "system", "localization_settings")["error"]["code"] == 403)
        # Logged-out: fresh opener PER CALL (anonymous-cookie priming).
        for base in (PHP, TS):
            for m in SIX + ["update_params"]:
                o2 = make_opener()
                env = call(o2, None, base, "admin", "system", m, {})
                check(f"C logged-out {base.split(':')[-1]} {m} is 201",
                      env.get("error", {}).get("code") == 201, str(env)[:160])

        # ---- D: update_params validation.
        def both(method_params, as_json=False):
            p = call(op, stok, PHP, "admin", "system", "update_params", method_params, as_json=as_json)
            t = call(op, stok, TS, "admin", "system", "update_params", method_params, as_json=as_json)
            return p, t

        for i, v in enumerate(["0", "-5", "1.5", "abc", "", MAX_VAL, "12abc"]):
            p, t = both({"invoice_starting_number": v})
            check_env(f"D start invalid {i} equal", t, p)
            check_env(f"D start invalid {i} message", p["error"],
                      {"code": 9999, "message": START_ERR})
        for i, v in enumerate(["25:00", "9:00", "24:00", "12:60", "banana"]):
            p, t = both({"invoice_reminder_send_time": v})
            check_env(f"D remind invalid {i} equal", t, p)
            check_env(f"D remind invalid {i} message", p["error"],
                      {"code": 9999, "message": REMIND_ERR})
        p, t = both({"invoice_starting_number": "0", "invoice_reminder_send_time": "25:00"})
        check_env("D combined start-first equal", t, p)
        check("D combined start-first is start err", p["error"]["message"] == START_ERR)
        p, t = both({"invoice_reminder_send_time": "25:00", "invoice_starting_number": "0"})
        check_env("D combined remind-first equal", t, p)
        check("D combined remind-first is remind err", p["error"]["message"] == REMIND_ERR)
        p, t = both({"Invoice_Starting_Number": "0"})
        check_env("D mixed-case key equal", t, p)
        check("D mixed-case key is start err", p["error"]["message"] == START_ERR)
        for name, params in (("json-null", {"invoice_starting_number": None}),
                             ("json-true", {"invoice_starting_number": True}),
                             ("json-55", {"invoice_starting_number": 5.5})):
            p, t = both(params, as_json=True)
            check_env(f"D {name} equal", t, p)
            check(f"D {name} is start err", p["error"]["message"] == START_ERR)
        p, t = both({"invoice_starting_number": 5}, as_json=True)
        check_env("D json-5 equal", t, p)
        check_env("D json-5 true", p["error"], None)

        def get_params(base):
            return call(op, stok, base, "admin", "system", "get_params")["result"]

        check_env("D json-5 stored both", get_params(TS).get("invoice_starting_number"),
                  get_params(PHP).get("invoice_starting_number"))
        # N1: JSON-null reminder — envelopes agree, stored value differs.
        # NOTE: the two stacks share one DB, so the stored value must be
        # observed per stack with a reset between the calls; reading
        # "both" after the pair would only ever show the last write.
        p, t = both({"invoice_reminder_send_time": None}, as_json=True)
        check_env("D json-null-remind envelopes equal", t, p)
        check_env("D json-null-remind true", p["error"], None)
        call(op, stok, PHP, "admin", "system", "update_params",
             {"invoice_reminder_send_time": "09:30"})
        t1 = call(op, stok, TS, "admin", "system", "update_params",
                   {"invoice_reminder_send_time": None}, as_json=True)
        check_env("D N1 TS-only call true", t1["error"], None)
        tv = get_params(TS).get("invoice_reminder_send_time")
        check("D N1 TS stores 'null' string", tv == "null", f"ts={tv!r}")
        p1 = call(op, stok, PHP, "admin", "system", "update_params",
                   {"invoice_reminder_send_time": None}, as_json=True)
        check_env("D N1 PHP-only call true", p1["error"], None)
        pv = get_params(PHP).get("invoice_reminder_send_time")
        check("D N1 PHP stores NULL", pv is None, f"php={pv!r}")
        # Urlencoded valid writes + read-backs.
        for params, key, want in (
                ({"invoice_reminder_send_time": "09:30"}, "invoice_reminder_send_time", "09:30"),
                ({"invoice_starting_number": "1"}, "invoice_starting_number", "1"),
                ({"invoice_starting_number": MAX_MINUS_1}, "invoice_starting_number", MAX_MINUS_1)):
            p, t = both(params)
            check_env(f"D valid {key}={want} equal", t, p)
            check_env(f"D valid {key}={want} stored php", get_params(PHP).get(key), want)
            check_env(f"D valid {key}={want} stored ts", get_params(TS).get(key), want)
        # Validate-then-write.
        p, t = both({"r5a_probe_param": "probe-val", "invoice_starting_number": "0"})
        check_env("D validate-then-write equal", t, p)
        check("D probe absent php", "r5a_probe_param" not in get_params(PHP))
        check("D probe absent ts", "r5a_probe_param" not in get_params(TS))
        # Full-form 38-field post with current values.
        cur = get_params(PHP)
        payload = {f: (cur.get(f) if cur.get(f) is not None else "") for f in FIELDS_38}
        check("D 38 fields enumerated", len(FIELDS_38) == 38)
        p, t = both(payload)
        check_env("D full-form equal", t, p)
        check_env("D full-form true", p["error"], None)
        back_p, back_t = get_params(PHP), get_params(TS)
        check("D full-form read-back equal",
              all(back_p.get(f) == payload[f] for f in FIELDS_38) and
              all(back_t.get(f) == payload[f] for f in FIELDS_38))
        # Full-form with one invalid field: nothing written.
        pre_p, pre_t = get_params(PHP), get_params(TS)
        bad = dict(payload)
        bad["invoice_starting_number"] = "0"
        p, t = both(bad)
        check_env("D full-form-invalid equal", t, p)
        check("D full-form-invalid is start err", p["error"]["message"] == START_ERR)
        post_p, post_t = get_params(PHP), get_params(TS)
        check("D full-form-invalid nothing written php",
              all(post_p.get(f) == pre_p.get(f) for f in FIELDS_38))
        check("D full-form-invalid nothing written ts",
              all(post_t.get(f) == pre_t.get(f) for f in FIELDS_38))

        # ---- E: config writes via HTTP.
        def php_poll_read(method, want, timeout=12):
            deadline = time.time() + timeout
            last = None
            while time.time() < deadline:
                last = call(op, stok, PHP, "admin", "system", method)
                if last.get("result") == want:
                    return last, True
                time.sleep(1)
            return last, False

        # Toggle round-trips per stack.
        for base, label in ((PHP, "php"), (TS, "ts")):
            e0 = call(op, stok, base, "admin", "system", "error_reporting_enabled")["result"]
            call(op, stok, base, "admin", "system", "toggle_error_reporting")
            e1 = call(op, stok, base, "admin", "system", "error_reporting_enabled")["result"]
            call(op, stok, base, "admin", "system", "toggle_error_reporting")
            e2 = call(op, stok, base, "admin", "system", "error_reporting_enabled")["result"]
            check(f"E toggle {label} flips then restores", e1 == (not e0) and e2 == e0,
                  f"{e0} -> {e1} -> {e2}")
        # Cross-stack: TS toggle visible to PHP (polled), then back.
        e0 = call(op, stok, TS, "admin", "system", "error_reporting_enabled")["result"]
        call(op, stok, TS, "admin", "system", "toggle_error_reporting")
        last, ok = php_poll_read("error_reporting_enabled", not e0)
        check("E TS toggle visible to PHP", ok, str(last)[:160])
        call(op, stok, TS, "admin", "system", "toggle_error_reporting")
        last, ok = php_poll_read("error_reporting_enabled", e0)
        check("E TS toggle-back visible to PHP", ok, str(last)[:160])
        # Localization round-trips per stack.
        for base, label in ((PHP, "php"), (TS, "ts")):
            call(op, stok, base, "admin", "system", "update_localization_settings",
                 {"locale": "de_DE", "auto_detect_locale": "0"})
            r1 = call(op, stok, base, "admin", "system", "localization_settings")["result"]
            call(op, stok, base, "admin", "system", "update_localization_settings",
                 {"locale": "", "auto_detect_locale": "banana"})
            r2 = call(op, stok, base, "admin", "system", "localization_settings")["result"]
            check(f"E loc {label} write then empty-banana",
                  r1 == {"locale": "de_DE", "auto_detect_locale": False} and
                  r2 == {"locale": "de_DE", "auto_detect_locale": True}, f"{r1} {r2}")
        # Backup chain: after a two-write TS call, .old.php holds the
        # FIRST write's result (new locale, old auto_detect).
        call(op, stok, TS, "admin", "system", "update_localization_settings",
             {"locale": "es_ES", "auto_detect_locale": "1"})
        old_text = pathlib.Path(OLDP).read_text()
        new_text = pathlib.Path(CFG).read_text()
        check("E backup exists + holds first write locale", "'locale' => 'es_ES'" in old_text)
        check("E backup holds old auto_detect", "'auto_detect_locale' => true" in old_text)
        check("E new file holds both writes",
              "'locale' => 'es_ES'" in new_text and "'auto_detect_locale' => true" in new_text)
        # Same chain on PHP (marker it_IT + auto 0; prior state auto true).
        # PHP QUIRK (proven from vendor source, not assumed): Symfony
        # Filesystem::copy skips when filemtime(origin) is NOT strictly
        # greater than filemtime(target). The two setProperty calls in
        # one request usually land in the same second, so the second
        # backup is skipped and .old.php keeps the PRE-call file
        # (es_ES + true) instead of the first write (it_IT + true).
        # The TS store copies unconditionally, so its backup is
        # deterministic; PHP's is mtime-gated. Assert the disjunction
        # (backup is exactly one of the two expected states), not the
        # first-write state alone — asserting that alone fails on PHP
        # whenever the clock does not tick between the two writes.
        pre_php_text = pathlib.Path(CFG).read_text()
        call(op, stok, PHP, "admin", "system", "update_localization_settings",
             {"locale": "it_IT", "auto_detect_locale": "0"})
        old_text = pathlib.Path(OLDP).read_text()
        new_text = pathlib.Path(CFG).read_text()
        check("E php backup is pre-call or first-write state",
              old_text == pre_php_text or
              ("'locale' => 'it_IT'" in old_text and "'auto_detect_locale' => true" in old_text))
        check("E php backup holds old auto_detect", "'auto_detect_locale' => true" in old_text)
        check("E php new file holds both writes",
              "'locale' => 'it_IT'" in new_text and "'auto_detect_locale' => false" in new_text)

        # ---- F: secret scan.
        bad = []
        for env in ENVELOPES:
            bad += find_secret_keys(env)
        check("F secret scan clean", bad == [], str(bad[:5]))
    finally:
        restore()
        inv1 = invariants()
        check_env("G invariants restored", inv1, inv0)
        check("G config bytes restored",
              hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)
        if old_bytes is None:
            check("G old.php absent again", not pathlib.Path(OLDP).exists())
        else:
            check("G old.php bytes restored", pathlib.Path(OLDP).read_bytes() == old_bytes)
        for label in ("access", "manage", "view", "update", "support"):
            check(f"G persona {label} gone",
                  d.execute("SELECT COUNT(*) FROM admin WHERE email = ?",
                            (f"r5a-{label}@example.com",)).fetchone()[0] == 0)
        d.close()

    print(f"\nparity34: {CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("failures:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
