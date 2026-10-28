#!/usr/bin/env python3
"""Phase 5 R4a parity: registry + extension API, compared live on
PHP (:8080) vs TS (:3001/api/fb).

Sections:
  A. Baselines + invariants before (extension rows as (type, name,
     status, version) SETS — delete+reinsert churns ids, so ids are
     never compared — plus extension_meta keys, plus the parity29
     invariants tuple).
  B. get_list equivalence per mode/filter: every TS entry must equal
     the PHP entry with the same id (full dict equality: manifest
     defaults, icon_url double slash, icon_path presence, versions,
     status, has_settings, available-only keys). The TS list is a
     SUBSET of PHP's by design: PHP extras are enumerated exactly
     (branding, embed, api, orderbutton, theme — modules outside the
     34-module TS registry), never hand-waved.
  C. activate/deactivate error-shape equivalence (missing id/type,
     unknown mod, nonexistent, core-without-row).
  D. News activate/deactivate round-trip on the TS stack with
     ACTIVATION GATING PROVEN BOTH DIRECTIONS: deactivate -> news
     endpoints answer 715 on BOTH stacks (shared DB) and guest is_on
     goes false; reactivate -> served again, is_on true, row restored.
  E. config_save round-trip (urlencoded + JSON + nested types) on a
     benign test flag only, read back via config_get on BOTH stacks
     in both directions, plus a direct DB check that the stored value
     is v2:-encrypted (never plaintext), plus the guest-settings
     public-subset proof via a crafted public array. Secret-key scan
     over every config envelope captured. PHP's getConfig caches
     configs for 1h in the Symfony app pool (data/cache/sf_cache_*),
     and a TS write or direct SQL delete does NOT invalidate it — so
     section E clears that pool (regenerable; Doctrine pools untouched)
     before every PHP config read that follows a TS write, and again
     in the outer finally, or PHP would serve the stale pre-write
     value and the comparison would fail on a cache artifact, not a
     code difference.
  F. All 9 removal errors on the TS stack only (PHP still serves
     these — that is exactly what R4 ends), including a logged-out
     caller proving the removal error throws before any auth check.
  G. Permission-denied cases with non-super personas (support-only
     -> 725; extension-only -> 403 method guard and 403 module-access
     from hasManagePermission; ext+news and super-admin -> the
     identity-independent manage_settings 403 for news).
  H. Final restore proof: full-DB snapshot restore + extension row
     SET + meta keys identical to section A + invariants.
Only envelopes are compared, never HTTP status: TS error envelopes are
always HTTP 200 by seam convention while PHP answers 4xx with the same
envelope, documented not hidden.
"""
import http.cookiejar
import glob
import json
import re
import shutil
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
FIXED_TS = "2026-10-28 12:00:00"

FAILURES = []
CHECKS = 0


def check(name, php_val, ts_val):
    global CHECKS
    CHECKS += 1
    if php_val != ts_val:
        FAILURES.append((name, php_val, ts_val))
        print("FAIL", name)
        print("  php:", json.dumps(php_val, default=str)[:500])
        print("  ts :", json.dumps(ts_val, default=str)[:500])
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


SECRET_KEY_SUBSTRINGS = (
    "password", "passwd", "api_token", "secret", "salt",
    "private_key", "webhook", "smtp", "captcha",
)


def find_secret_keys(v, path=""):
    hits = []
    if isinstance(v, dict):
        for k, x in v.items():
            kl = str(k).lower()
            if any(s in kl for s in SECRET_KEY_SUBSTRINGS):
                hits.append(f"{path}.{k}")
            hits += find_secret_keys(x, f"{path}.{k}")
    elif isinstance(v, list):
        for i, x in enumerate(v):
            hits += find_secret_keys(x, f"{path}[{i}]")
    return hits


CORE_TS_ORDER = ["activity", "antispam", "cart", "client", "cron", "currency",
                 "email", "extension", "index", "invoice", "order", "page",
                 "product", "profile", "security", "servicecustom",
                 "servicedomain", "servicedownloadable", "servicehosting",
                 "servicelicense", "staff", "stats", "support", "system",
                 "formbuilder", "widgets"]
INSTALLED_REGISTRY_BY_ID = ["redirect", "custompages", "massmailer",
                            "notification", "news"]
AVAILABLE_REGISTRY_ALPHA = ["cookieconsent", "seo", "serviceapikey"]


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

    def ext_rows_set():
        return sorted(tuple(r) for r in d.execute(
            "SELECT type, name, status, version FROM extension"))

    def meta_keys():
        return sorted(tuple(r) for r in d.execute(
            "SELECT extension, meta_key FROM extension_meta"))

    def clear_php_app_cache():
        # See the section E docstring: PHP's 1h config cache is not
        # invalidated by TS writes or SQL deletes. Clearing the app
        # pool (regenerable) forces PHP reads to see the DB row.
        for pool in glob.glob(
                "/home/hatch/scratch/fossbilling/runtime/src/data/cache/sf_cache_*"):
            shutil.rmtree(pool, ignore_errors=True)

    got, want = invariants()
    check_true("invariants-before", got == want, f"{got} != {want}")
    ext_before = ext_rows_set()
    check_true("ext-rows-before", len(ext_before) == 6 and all(r[2] == "installed" for r in ext_before),
               str(ext_before))
    meta_before = meta_keys()
    check_true("meta-keys-before", len(meta_before) == 3, str(meta_before))

    def make_opener():
        cj = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

    def login(op, email, password):
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        token = m.group(1) if m else None
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
            parsed = {"_non_dict": parsed}
        return parsed, status

    def jcall(op, token, base, role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = json.dumps(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with op.open(req, timeout=60) as resp:
                raw, status = resp.read(), resp.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        try:
            parsed = json.loads(raw.decode())
        except Exception:
            parsed = {"_raw": raw[:200].decode("utf-8", "replace")}
        return parsed, status

    def bcrypt_hash(pw):
        out = subprocess.run(
            ["node", "-e",
             "const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
             f"console.log(b.hashSync({json.dumps(pw)}, 12))"],
            capture_output=True, text=True, timeout=30)
        assert out.returncode == 0, out.stderr
        return out.stdout.strip()

    try:
        op, _ = make_opener()
        token = login(op, SUPER_EMAIL, SUPER_PASS)

        # ---- B. get_list equivalence ----
        def getlist_case(name, data, ts_ids, php_extra):
            gp, _ = call(op, token, PHP, "admin", "extension", "get_list", data)
            gt, _ = call(op, token, TS, "admin", "extension", "get_list", data)
            pmap = {e["id"]: e for e in gp["result"]}
            tmap = {e["id"]: e for e in gt["result"]}
            check_true(f"{name}_ts_ids", [e["id"] for e in gt["result"]] == ts_ids,
                       f"got {[e['id'] for e in gt['result']]}")
            check_true(f"{name}_php_extra", sorted(set(pmap) - set(tmap)) == sorted(php_extra),
                       f"got {sorted(set(pmap) - set(tmap))}")
            for mid in ts_ids:
                check(f"{name}_entry_{mid}", pmap[mid], tmap[mid])

        getlist_case("gl_default", {},
                     INSTALLED_REGISTRY_BY_ID + AVAILABLE_REGISTRY_ALPHA,
                     ["branding", "embed"])
        getlist_case("gl_active", {"active": "1"},
                     CORE_TS_ORDER + INSTALLED_REGISTRY_BY_ID,
                     ["api", "branding", "orderbutton", "theme"])
        getlist_case("gl_installed", {"installed": "1"},
                     INSTALLED_REGISTRY_BY_ID, ["branding"])
        getlist_case("gl_has_settings", {"has_settings": "1"},
                     ["redirect"], [])
        getlist_case("gl_search_news", {"search": "news"}, ["news"], [])
        getlist_case("gl_search_NEWS", {"search": "NEWS"}, ["news"], [])
        getlist_case("gl_type_mod", {"type": "mod"},
                     INSTALLED_REGISTRY_BY_ID + AVAILABLE_REGISTRY_ALPHA,
                     ["branding", "embed"])
        getlist_case("gl_installed_active", {"installed": "1", "active": "1"},
                     CORE_TS_ORDER + INSTALLED_REGISTRY_BY_ID,
                     ["api", "branding", "orderbutton", "theme"])

        # ---- C. activate/deactivate error equivalence ----
        for name, role, method, data in [
            ("act_missing_id", "admin", "activate", {"type": "mod"}),
            ("act_missing_type", "admin", "activate", {"id": "news"}),
            ("act_unknown", "admin", "activate", {"id": "r4a_no_such_mod", "type": "mod"}),
            ("deact_missing_id", "admin", "deactivate", {"type": "mod"}),
            ("deact_missing_type", "admin", "deactivate", {"id": "news"}),
            ("deact_nonexistent", "admin", "deactivate", {"id": "r4a_no_such_mod", "type": "mod"}),
            ("deact_core_norow", "admin", "deactivate", {"id": "client", "type": "mod"}),
            ("cfg_missing_ext", "admin", "config_get", {}),
            ("cfgsave_missing_ext", "admin", "config_save", {}),
            ("guest_settings_missing_ext", "guest", "settings", {}),
        ]:
            gp, _ = call(op, token, PHP, role, "extension", method, data)
            gt, _ = call(op, token, TS, role, "extension", method, data)
            check(name, gp, gt)

        # ---- D. News round-trip + gating, both directions ----
        try:
            served_p, _ = call(op, token, PHP, "admin", "news", "get_list", {})
            served_t, _ = call(op, token, TS, "admin", "news", "get_list", {})
            check_true("news_served_before_php", served_p.get("error") is None, str(served_p)[:200])
            check_true("news_served_before_ts", served_t.get("error") is None, str(served_t)[:200])
            d_out, _ = call(op, token, TS, "admin", "extension", "deactivate",
                            {"id": "news", "type": "mod"})
            check_true("news_deactivate_ts", d_out.get("error") is None and d_out.get("result") is True,
                       str(d_out))
            g715_p, _ = call(op, token, PHP, "admin", "news", "get_list", {})
            g715_t, _ = call(op, token, TS, "admin", "news", "get_list", {})
            check("news_gated_php", g715_p, g715_t)
            check_true("news_gated_715",
                       g715_t.get("error", {}).get("code") == 715 and
                       g715_t["error"]["message"] == "FOSSBilling module news is not installed/activated",
                       str(g715_t))
            gl_t, _ = call(op, token, TS, "admin", "extension", "get_list", {})
            news_entry = [e for e in gl_t["result"] if e["id"] == "news"]
            check_true("news_available_after_deact",
                       len(news_entry) == 1 and news_entry[0]["status"] is None and
                       news_entry[0].get("has_settings_routes") is False and
                       news_entry[0].get("settings_routes") == [],
                       str(news_entry))
            ion_p, _ = call(op, token, PHP, "guest", "extension", "is_on", {"mod": "news"})
            ion_t, _ = call(op, token, TS, "guest", "extension", "is_on", {"mod": "news"})
            check("news_ison_false", ion_p, ion_t)
            check_true("news_ison_false_val", ion_t.get("result") is False, str(ion_t))
            a_out, _ = call(op, token, TS, "admin", "extension", "activate",
                            {"id": "news", "type": "mod"})
            check_true("news_reactivate_ts",
                       a_out.get("error") is None and
                       a_out.get("result") == {"id": "news", "type": "mod", "redirect": True, "has_settings": False},
                       str(a_out))
            back_p, _ = call(op, token, PHP, "admin", "news", "get_list", {})
            back_t, _ = call(op, token, TS, "admin", "news", "get_list", {})
            check_true("news_served_after_php", back_p.get("error") is None, str(back_p)[:200])
            check_true("news_served_after_ts", back_t.get("error") is None, str(back_t)[:200])
            ion2_t, _ = call(op, token, TS, "guest", "extension", "is_on", {"mod": "news"})
            check_true("news_ison_true_val", ion2_t.get("result") is True, str(ion2_t))
        finally:
            # Row-set restore even if the round-trip died mid-way: the
            # outer finally restores the full DB, but re-activate now
            # so later sections see news installed.
            row = d.execute("SELECT status FROM extension WHERE type='mod' AND name='news'").fetchone()
            if not row:
                call(op, token, TS, "admin", "extension", "activate", {"id": "news", "type": "mod"})
            elif row[0] != "installed":
                d.execute("UPDATE extension SET status='installed', version='1.0.0' "
                          "WHERE type='mod' AND name='news'")
                d.commit()

        # ---- E. config_save round-trip (benign flag only) ----
        try:
            check_true("support_config_row_absent_before",
                       d.execute("SELECT COUNT(*) FROM extension_meta WHERE extension='mod_support' "
                                 "AND meta_key='config'").fetchone()[0] == 0)
            w_t, _ = call(op, token, TS, "admin", "extension", "config_save",
                          {"ext": "mod_support", "r4a_test_flag": "parity30-benign"})
            check_true("cfgsave_ts_ok", w_t.get("error") is None and w_t.get("result") is True, str(w_t))
            r_t, _ = call(op, token, TS, "admin", "extension", "config_get", {"ext": "mod_support"})
            clear_php_app_cache()
            r_p, _ = call(op, token, PHP, "admin", "extension", "config_get", {"ext": "mod_support"})
            check("cfgsave_read_both", r_p, r_t)
            check_true("cfgsave_read_flag",
                       r_t.get("result") == {"ext": "mod_support", "r4a_test_flag": "parity30-benign"},
                       str(r_t))
            raw = d.execute("SELECT meta_value FROM extension_meta WHERE extension='mod_support' "
                            "AND meta_key='config'").fetchone()[0]
            check_true("cfgsave_stored_v2", raw.startswith("v2:"), raw[:20])
            check_true("cfgsave_stored_not_plaintext", "parity30-benign" not in raw)
            check_true("cfgsave_audit_ts", find_secret_keys(r_t) == [], str(find_secret_keys(r_t)))
            check_true("cfgsave_audit_php", find_secret_keys(r_p) == [], str(find_secret_keys(r_p)))
            w_p, _ = call(op, token, PHP, "admin", "extension", "config_save",
                          {"ext": "mod_support", "r4a_test_flag": "parity30-php"})
            check_true("cfgsave_php_ok", w_p.get("error") is None and w_p.get("result") is True, str(w_p))
            r2_t, _ = call(op, token, TS, "admin", "extension", "config_get", {"ext": "mod_support"})
            check_true("cfgsave_reverse_flag",
                       r2_t.get("result") == {"ext": "mod_support", "r4a_test_flag": "parity30-php"},
                       str(r2_t))
            # JSON body with nested types: PHP accepts JSON posts too
            # (verified by probe), so this is a full equivalence case.
            jw_p, _ = jcall(op, token, PHP, "admin", "extension", "config_save",
                            {"ext": "mod_support", "r4a_nested": {"a": 1, "b": "x"}, "r4a_list": [1, 2]})
            check_true("cfgsave_json_php_ok", jw_p.get("error") is None and jw_p.get("result") is True, str(jw_p))
            jr_t, _ = jcall(op, token, TS, "admin", "extension", "config_get", {"ext": "mod_support"})
            jr_p, _ = call(op, token, PHP, "admin", "extension", "config_get", {"ext": "mod_support"})
            check("cfgsave_json_read_both", jr_p, jr_t)
            check_true("cfgsave_json_nested",
                       jr_t.get("result", {}).get("r4a_nested") == {"a": 1, "b": "x"} and
                       jr_t.get("result", {}).get("r4a_list") == [1, 2],
                       str(jr_t))
            # Guest settings public-subset proof via a crafted public array.
            # JSON body: urlencoded posts stringify the array, so the
            # craft must go through jcall for a real JSON array.
            w_pub, _ = jcall(op, token, TS, "admin", "extension", "config_save",
                             {"ext": "mod_support", "public": ["r4a-public-test"]})
            check_true("cfgsave_public_ok", w_pub.get("error") is None and w_pub.get("result") is True, str(w_pub))
            s_t, _ = call(op, token, TS, "guest", "extension", "settings", {"ext": "mod_support"})
            clear_php_app_cache()
            s_p, _ = call(op, token, PHP, "guest", "extension", "settings", {"ext": "mod_support"})
            check("guest_settings_public", s_p, s_t)
            check_true("guest_settings_public_val", s_t.get("result") == ["r4a-public-test"], str(s_t))
            # Guest is_on/settings read-only cases, both stacks.
            for name, method, data in [
                ("ison_news", "is_on", {"mod": "news"}),
                ("ison_branding", "is_on", {"mod": "branding"}),
                ("ison_client_core", "is_on", {"mod": "client"}),
                ("ison_nonexistent", "is_on", {"mod": "nonexistent"}),
                ("ison_noparams", "is_on", {}),
                ("ison_id_type", "is_on", {"id": "news", "type": "mod"}),
                ("ison_id_type_nonexistent", "is_on", {"id": "nonexistent", "type": "mod"}),
                ("ison_theme_nonmod", "is_on", {"id": "theme", "type": "theme"}),
                ("ison_mod_zero", "is_on", {"mod": "0"}),
                ("settings_support", "settings", {"ext": "support"}),
                ("settings_mod_news", "settings", {"ext": "mod_news"}),
                ("settings_nonexistent", "settings", {"ext": "nonexistent"}),
            ]:
                gp, _ = call(op, token, PHP, "guest", "extension", method, data)
                gt, _ = call(op, token, TS, "guest", "extension", method, data)
                check(name, gp, gt)
        finally:
            d.execute("DELETE FROM extension_meta WHERE extension='mod_support' AND meta_key='config'")
            d.commit()

        # ---- F. Removals, TS only ----
        removed_admin = ["install", "uninstall", "update", "get_latest",
                         "get_extension_readme", "languages", "toggle_language",
                         "locale_completion"]
        for method in removed_admin:
            env, _ = call(op, token, TS, "admin", "extension", method,
                          {"id": "news", "type": "mod"})
            check_true(f"removed_admin_{method}",
                       env.get("error", {}).get("code") == 9999 and
                       env["error"]["message"] == f"Endpoint admin/extension/{method} was removed in the Next.js port.",
                       str(env))
        env, _ = call(op, token, TS, "guest", "extension", "languages", {})
        check_true("removed_guest_languages",
                   env.get("error", {}).get("code") == 9999 and
                   env["error"]["message"] == "Endpoint guest/extension/languages was removed in the Next.js port.",
                   str(env))
        # Logged-out caller: no admin identity, valid CSRF only. A
        # non-removed endpoint would answer 201 here; the removal
        # error must win, proving the gate skip.
        op_out, _ = make_opener()
        page = op_out.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        out_token = m.group(1) if m else None
        env, _ = call(op_out, out_token, TS, "admin", "extension", "install",
                      {"id": "news", "type": "mod"})
        check_true("removed_loggedout",
                   env.get("error", {}).get("code") == 9999 and
                   "was removed in the Next.js port." in env["error"]["message"],
                   str(env))
        env, _ = call(op_out, out_token, TS, "guest", "extension", "languages", {})
        check_true("removed_guest_loggedout",
                   env.get("error", {}).get("code") == 9999 and
                   "was removed in the Next.js port." in env["error"]["message"],
                   str(env))

        # ---- G. Permission-denied personas ----
        def make_persona(email, pw, group_name, system_name, perms):
            h = bcrypt_hash(pw)
            cur = d.cursor()
            cur.execute(
                "INSERT INTO admin_group (name, system_name, permissions, protected, created_at, updated_at, parent_id)"
                " VALUES (?, ?, ?, 0, ?, ?, 1)",
                (group_name, system_name, json.dumps(perms), FIXED_TS, FIXED_TS))
            gid = cur.lastrowid
            cur.execute(
                "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
                " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)",
                (email, h, group_name, FIXED_TS, FIXED_TS))
            vid = cur.lastrowid
            cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at)"
                        " VALUES (?, ?, ?)", (vid, gid, FIXED_TS))
            d.commit()
            o, _ = make_opener()
            t = login(o, email, pw)
            return o, t

        personas = []
        try:
            op_sup, tok_sup = make_persona("r4a-support@example.local", "R4a-Sup!42",
                                           "R4a Support Only", "r4a_support_only",
                                           {"support": {"access": True}})
            personas.append((op_sup, tok_sup))
            op_ext, tok_ext = make_persona("r4a-extonly@example.local", "R4a-Ext!42",
                                           "R4a Extension Only", "r4a_extension_only",
                                           {"extension": {"access": True}})
            personas.append((op_ext, tok_ext))
            op_en, tok_en = make_persona("r4a-extnews@example.local", "R4a-En!42",
                                         "R4a Ext News", "r4a_ext_news",
                                         {"extension": {"access": True}, "news": {"access": True}})
            personas.append((op_en, tok_en))
            denied = [
                ("deny_sup_activate", op_sup, tok_sup, "admin", "activate", {"id": "news", "type": "mod"}),
                ("deny_sup_config_save", op_sup, tok_sup, "admin", "config_save",
                 {"ext": "mod_support", "r4a_test_flag": "nope"}),
                ("deny_sup_get_list", op_sup, tok_sup, "admin", "get_list", {}),
                ("deny_sup_deactivate", op_sup, tok_sup, "admin", "deactivate", {"id": "news", "type": "mod"}),
                ("deny_ext_deactivate", op_ext, tok_ext, "admin", "deactivate", {"id": "news", "type": "mod"}),
                ("deny_ext_cfgsave_support", op_ext, tok_ext, "admin", "config_save",
                 {"ext": "mod_support", "r4a_test_flag": "nope"}),
                ("deny_ext_cfgsave_news", op_ext, tok_ext, "admin", "config_save",
                 {"ext": "mod_news", "r4a_test_flag": "nope"}),
                ("deny_en_cfgsave_news", op_en, tok_en, "admin", "config_save",
                 {"ext": "mod_news", "r4a_test_flag": "nope"}),
            ]
            for name, o, t, role, method, data in denied:
                gp, _ = call(o, t, PHP, role, "extension", method, data)
                gt, _ = call(o, t, TS, role, "extension", method, data)
                check(name, gp, gt)
            # Super-admin hits the identity-independent throw too.
            gp, _ = call(op, token, PHP, "admin", "extension", "config_save",
                         {"ext": "mod_news", "r4a_test_flag": "nope"})
            gt, _ = call(op, token, TS, "admin", "extension", "config_save",
                         {"ext": "mod_news", "r4a_test_flag": "nope"})
            check("deny_super_cfgsave_news", gp, gt)
            check_true("deny_super_cfgsave_news_403",
                       gt.get("error", {}).get("code") == 403 and
                       gt["error"]["message"] == "You do not have permission to perform this action",
                       str(gt))
        finally:
            for email in ("r4a-support@example.local", "r4a-extonly@example.local",
                          "r4a-extnews@example.local"):
                d.execute("DELETE FROM admin WHERE email=?", (email,))
            for sn in ("r4a_support_only", "r4a_extension_only", "r4a_ext_news"):
                d.execute("DELETE FROM admin_group WHERE system_name=?", (sn,))
            d.commit()
    finally:
        restore()
        clear_php_app_cache()
        print("reference DB restored")

    got, want = invariants()
    check_true("invariants-after", got == want, f"{got} != {want}")
    check_true("ext-rows-after", ext_rows_set() == ext_before,
               f"{ext_rows_set()} != {ext_before}")
    check_true("meta-keys-after", meta_keys() == meta_before,
               f"{meta_keys()} != {meta_before}")
    print(f"\nparity30: {CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("parity30: FAILURES PRESENT")
        raise SystemExit(1)
    print("parity30: ALL GREEN")


if __name__ == "__main__":
    main()
