#!/usr/bin/env python3
"""Phase 5 R4b parity: extension UI pages.

Sections:
  A. Baselines + invariants before (extension rows as (type, name,
     status, version) SETS — delete+reinsert churns ids — plus
     extension_meta keys, plus the parity29 invariants tuple).
  B. Page smoke (super session, cookies shared across stacks):
     list renders registry modules with statuses, the in-tree-only
     note, and NO install/upload affordance and NO action for PHP-only
     modules (no detail href for branding/embed); detail support
     renders metadata + config form; detail news renders the
     no-settings note + Deactivate, no config form; unknown id renders
     an error box; logged-out list + detail render the sign-in link
     box, not data; super's sidebar carries the Extensions link.
  C. Activate/deactivate through the UI's action path (fbPost,
     urlencoded id/type, exactly as ExtensionActions posts) on news:
     deactivate -> news endpoints answer 715 on BOTH stacks and guest
     is_on goes false; reactivate -> served again, is_on true.
  D. Config round-trip through the page's save path (JSON-body POST,
     exactly as ConfigForm posts via fbPostJson) on mod_support:
     nested objects + arrays + numbers/booleans + benign flags, read
     back via config_get on BOTH stacks (PHP app pool cleared first —
     R4a §3.5) with parsed equality, plus a direct DB check that the
     stored value is v2:-encrypted with no plaintext flag. Then a
     REJECTED save: an invalid JSON body must error without writing,
     proven by config_get afterwards returning the crafted config
     unchanged. Client-side invalid-JSON rejection is browser code and
     is NOT proven here (no live browser; see findings-r4b).
  E. Non-super outcomes: a crafted extension-view-only persona reads
     list + detail but gets the seam 403 on activate and config_save;
     a support-only persona gets the 725 box on list + detail and no
     Extensions sidebar section. The seam (not UI hiding) enforces.
  F. Restore proof: full-DB snapshot restore + extension row SET +
     meta keys + invariants identical to section A.
Only envelopes are compared, never HTTP status (TS envelopes are always
HTTP 200 by seam convention). Config test values are benign flags only.
"""
import glob
import http.cookiejar
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
NEXT = "http://127.0.0.1:3001"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
PERSONA_PASS = "R4b-Staff!42"

FAILURES = []
CHECKS = 0


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

    def rawcall(op, base, role, module, method, raw_body):
        # A literally invalid JSON body, exactly what a broken client
        # (or a truncated post) would send. No CSRF token is readable
        # from it — the route's JSON.parse throws before dispatch.
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=raw_body.encode(), method="POST",
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

    def page(op, path):
        req = urllib.request.Request(f"{NEXT}{path}", method="GET")
        try:
            with op.open(req, timeout=60) as resp:
                return resp.read().decode("utf-8", "replace"), resp.status
        except urllib.error.HTTPError as e:
            return e.read().decode("utf-8", "replace"), e.code

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

        # ---- B. Page smoke (super) ----
        html, _ = page(op, "/admin/extensions")
        check_true("list-h1", ">Extensions</h1>" in html)
        check_true("list-note-in-tree-only", "in-tree modules only" in html)
        for mod, label in [("news", ">News<"), ("support", ">Support<"),
                           ("custompages", ">Custom Pages<"), ("massmailer", ">Mass Mail Tool<")]:
            check_true(f"list-row-{mod}", f'href="/admin/extensions/{mod}"' in html and label in html)
        for status in ("Core", "Installed", "Available"):
            check_true(f"list-status-{status}", f">{status}<" in html)
        check_true("list-no-branding-row", 'href="/admin/extensions/branding"' not in html)
        check_true("list-no-embed-row", 'href="/admin/extensions/embed"' not in html)
        check_true("list-no-install-button", ">Install<" not in html)
        check_true("list-no-upload-button", ">Upload<" not in html)
        check_true("list-no-install-href",
                   not re.search(r'href="[^"]*(install|upload)', html))
        check_true("sidebar-extensions-link", 'href="/admin/extensions">Extensions' in html)

        html, _ = page(op, "/admin/extensions/support")
        check_true("detail-support-h1", ">Support</h1>" in html)
        check_true("detail-support-config-heading", ">Configuration</h2>" in html)
        check_true("detail-support-save-button", ">Save configuration<" in html)
        check_true("detail-support-textarea", "<textarea" in html)
        check_true("detail-support-no-deactivate", ">Deactivate<" not in html)

        html, _ = page(op, "/admin/extensions/news")
        check_true("detail-news-no-settings-note", "declares no settings page" in html)
        check_true("detail-news-deactivate", ">Deactivate<" in html)
        check_true("detail-news-no-save", ">Save configuration<" not in html)

        html, _ = page(op, "/admin/extensions/nope123")
        check_true("detail-unknown-error", "Unknown extension: nope123." in html)

        op_out, _ = make_opener()
        html, _ = page(op_out, "/admin/extensions")
        check_true("loggedout-list-signin", "/admin/login" in html and "sign in as staff" in html)
        check_true("loggedout-list-no-table", ">News<" not in html)
        html, _ = page(op_out, "/admin/extensions/support")
        check_true("loggedout-detail-signin", "/admin/login" in html and "sign in as staff" in html)
        check_true("loggedout-detail-no-form", "<textarea" not in html)

        # ---- C. Gating through the UI's action path (news) ----
        env, _ = call(op, token, TS, "admin", "extension", "deactivate",
                      {"id": "news", "type": "mod"})
        check_true("ui-deactivate-news", env.get("error") is None, str(env))
        for base, label in [(TS, "ts"), (PHP, "php")]:
            env, _ = call(op, token, base, "admin", "news", "get_list", {})
            check_true(f"gating-{label}-715",
                       (env.get("error") or {}).get("code") == 715, str(env)[:200])
            env, _ = call(op, token, base, "guest", "extension", "is_on", {"mod": "news"})
            check_true(f"gating-{label}-is-on-false", env.get("result") is False, str(env))
        env, _ = call(op, token, TS, "admin", "extension", "activate",
                      {"id": "news", "type": "mod"})
        check_true("ui-reactivate-news", env.get("error") is None, str(env))
        for base, label in [(TS, "ts"), (PHP, "php")]:
            env, _ = call(op, token, base, "admin", "news", "get_list", {})
            check_true(f"regating-{label}-served", env.get("error") is None, str(env)[:200])
            env, _ = call(op, token, base, "guest", "extension", "is_on", {"mod": "news"})
            check_true(f"regating-{label}-is-on-true", env.get("result") is True, str(env))

        # ---- D. Config round-trip through the page's save path ----
        crafted = {
            "r4b_flag": "parity31-benign",
            "nested": {"n": 3, "ok": True, "tags": ["a", "b"]},
            "nums": [1, 2.5],
            "enabled": True,
        }
        env, _ = jcall(op, token, TS, "admin", "extension", "config_save",
                       dict(crafted, ext="mod_support"))
        check_true("config-save-ts", env.get("error") is None, str(env))
        env_ts, _ = call(op, token, TS, "admin", "extension", "config_get",
                         {"ext": "mod_support"})
        got_ts = dict(env_ts.get("result") or {})
        got_ts.pop("ext", None)
        check("config-read-ts", crafted, got_ts)
        clear_php_app_cache()
        env_php, _ = call(op, token, PHP, "admin", "extension", "config_get",
                          {"ext": "mod_support"})
        got_php = dict(env_php.get("result") or {})
        got_php.pop("ext", None)
        check("config-read-php", crafted, got_php)
        row = d.execute(
            "SELECT meta_value FROM extension_meta WHERE extension = ? AND meta_key = 'config'",
            ("mod_support",)).fetchone()
        check_true("config-stored-v2",
                   row is not None and str(row[0]).startswith("v2:"), str(row)[:60] if row else "no row")
        check_true("config-stored-no-plaintext",
                   row is not None and "parity31-benign" not in str(row[0]))
        secrets = find_secret_keys(env_ts) + find_secret_keys(env_php)
        check_true("secret-scan-clean", not secrets, str(secrets))
        # Rejected save: invalid JSON must error and change nothing.
        env_bad, _ = rawcall(op, TS, "admin", "extension", "config_save", "{invalid json")
        check_true("rejected-save-errors", env_bad.get("error") is not None, str(env_bad)[:200])
        env_after, _ = call(op, token, TS, "admin", "extension", "config_get",
                            {"ext": "mod_support"})
        got_after = dict(env_after.get("result") or {})
        got_after.pop("ext", None)
        check("rejected-save-unchanged", crafted, got_after)

        # ---- E. Non-super outcomes ----
        pw_hash = bcrypt_hash(PERSONA_PASS)
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R4b ExtView", json.dumps({"extension": {"access": True, "view": True}})))
        g_view = cur.lastrowid
        cur = d.execute(
            "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
            ("r4b-extview@example.local", pw_hash, "R4b ExtView"))
        a_view = cur.lastrowid
        d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                  (a_view, g_view))
        cur = d.execute(
            "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
            ("r4b-support@example.local", pw_hash, "R4b Support"))
        a_sup = cur.lastrowid
        d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                  (a_sup, 3))
        d.commit()

        op_view, _ = make_opener()
        token_view = login(op_view, "r4b-extview@example.local", PERSONA_PASS)
        html, _ = page(op_view, "/admin/extensions")
        check_true("viewonly-list-renders", ">News<" in html)
        check_true("viewonly-sidebar-extensions", 'href="/admin/extensions">Extensions' in html)
        html, _ = page(op_view, "/admin/extensions/support")
        check_true("viewonly-detail-support-403-inline",
                   "You do not have permission to access the support module" in html)
        check_true("viewonly-detail-no-textarea", "<textarea" not in html)
        env, _ = call(op_view, token_view, TS, "admin", "extension", "activate",
                      {"id": "news", "type": "mod"})
        check_true("viewonly-activate-403",
                   (env.get("error") or {}).get("code") == 403
                   and "manage_extensions" in (env.get("error") or {}).get("message", ""),
                   str(env))
        env, _ = jcall(op_view, token_view, TS, "admin", "extension", "config_save",
                       {"ext": "mod_support", "r4b_flag": "parity31-viewonly"})
        check_true("viewonly-configsave-403",
                   (env.get("error") or {}).get("code") == 403
                   and "support module" in (env.get("error") or {}).get("message", ""),
                   str(env))

        op_sup, _ = make_opener()
        token_sup = login(op_sup, "r4b-support@example.local", PERSONA_PASS)
        html, _ = page(op_sup, "/admin/extensions")
        check_true("supportonly-list-725", "You do not have access to the extension module" in html)
        check_true("supportonly-list-no-rows", ">News<" not in html)
        check_true("supportonly-no-sidebar-extensions", 'href="/admin/extensions"' not in html)
        html, _ = page(op_sup, "/admin/extensions/support")
        check_true("supportonly-detail-725", "You do not have access to the extension module" in html)
        env, _ = call(op_sup, token_sup, TS, "admin", "extension", "get_list", {})
        check_true("supportonly-seam-725",
                   (env.get("error") or {}).get("code") == 725, str(env)[:200])
    finally:
        restore()
        clear_php_app_cache()
        d.commit()
        got, want = invariants()
        check_true("invariants-after", got == want, f"{got} != {want}")
        check_true("ext-rows-after", ext_rows_set() == ext_before, str(ext_rows_set()))
        check_true("meta-keys-after", meta_keys() == meta_before, str(meta_keys()))

    print()
    print(f"parity31: {CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        for name, a, b in FAILURES:
            print("FAILED:", name)
        raise SystemExit(1)
    print("parity31: ALL GREEN")


if __name__ == "__main__":
    main()
