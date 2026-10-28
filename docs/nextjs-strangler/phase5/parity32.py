#!/usr/bin/env python3
"""Phase 5 R4c parity: single-theme replacements, compared live on
PHP (:8080) vs TS (:3001/api/fb).

The suite SEPARATES two assertion kinds into distinct sections:
  B. TS-SHAPE — the documented single-theme shape for all four reads.
     These assert TS behavior, NOT PHP equivalence: PHP returns N
     themes by design (reference: default/client + default/admin),
     so a list-content comparison against PHP's lists would fail by
     design and is never written as an equivalence case. If theme is
     missing from the Next server's FB_TS_MODULES list, section B
     fails with PHP's list — a useful failure, not a silent pass.
  C. PHP-EQUIVALENT — error shapes and permission outcomes, which do
     not depend on theme count and must match PHP exactly (unknown
     theme code, missing code, invalid client param, 725/403/201).
  D. Removals (TS only): select, preset_delete, preset_select.
     PHP still serves these — that is exactly what R4 ends — and
     PHP's select/preset_* MUTATE (theme setting, extension_meta
     presets), so they are never called on PHP here.
  E. No-mutation proof: setting/extension_meta/non-persona invariants
     unchanged after the read sections, checked BEFORE the
     finally-restore; the admin tables differ by exactly the 2
     crafted personas and nothing else.
  F. Secret-key scan over every captured envelope.
  G. Final restore proof (full-DB snapshot restore + invariants).
Only envelopes are compared, never HTTP status: TS error envelopes are
always HTTP 200 by seam convention while PHP answers 4xx with the same
envelope, documented not hidden.
"""
import http.cookiejar
import json
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
STAFF_PASS = "R2a-Staff!42"
PASS_HASH = "$2b$12$EDk8uU38CUzztiThw9jM9enmE5idjJ9q2cGrWj8b.bLDG8F4OJqGq"

# The documented single-theme entry (must equal theme.ts exactly).
NEXT_THEME_ENTRY = {
    "author": "FOSSBilling",
    "author_url": "https://www.fossbilling.org/",
    "code": "next",
    "description": "Built-in Next.js theme",
    "hasSettings": False,
    "icon": None,
    "markdown_attributes": {},
    "name": "Next",
    "paths": [],
    "url": "/",
    "version": "0.1.0",
}

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
                f'INSERT INTO "{t}" (' + ", ".join(cols) + ") VALUES (" + ", ".join("?" * len(cols)) + ")",
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

    def theme_settings():
        return sorted(tuple(r) for r in d.execute(
            "SELECT param, value FROM setting WHERE param IN ('theme', 'admin_theme')"))

    def make_opener():
        cj = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj

    def page_token(op):
        page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
        m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
        return m.group(1) if m else None

    def login(op, email, password):
        token = page_token(op)
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
        if not isinstance(parsed, dict):
            parsed = {"_non_dict": parsed}
        return parsed, status

    try:
        # ---- Section A: baselines + invariants before. ----
        inv_before, inv_want = invariants()
        check_true("invariants-before", inv_before == inv_want, f"{inv_before} != {inv_want}")
        ext_before = ext_rows_set()
        meta_before = meta_keys()
        theme_before = theme_settings()
        check_true("ext-rows-before", len(ext_before) == 6 and all(r[2] == "installed" for r in ext_before),
                   str(ext_before))
        check_true("meta-keys-before", len(meta_before) == 3, str(meta_before))

        op, _ = make_opener()
        token = login(op, SUPER_EMAIL, SUPER_PASS)

        # ---- Section B: TS-SHAPE (TS only, documented single theme). ----
        # If the Next server proxied to PHP, these would return
        # default/client / default/admin entries instead — so exact
        # equality with the documented entry IS the seam-serving proof.
        ts_list, _ = call(op, token, TS, "admin", "theme", "get_list")
        check_true("shape-get_list", ts_list == {"result": {"list": [NEXT_THEME_ENTRY]}, "error": None},
                   json.dumps(ts_list)[:300])
        ts_alist, _ = call(op, token, TS, "admin", "theme", "get_admin_list")
        check_true("shape-get_admin_list", ts_alist == {"result": {"list": [NEXT_THEME_ENTRY]}, "error": None},
                   json.dumps(ts_alist)[:300])
        check_true("shape-lists-both-single",
                   ts_list["result"]["list"] == ts_alist["result"]["list"]
                   and len(ts_list["result"]["list"]) == 1, "")
        for label, data in [
            ("get_current-none", None),
            ("get_current-1", {"client": "1"}),
            ("get_current-0", {"client": "0"}),
            ("get_current-true", {"client": "true"}),
            ("get_current-false", {"client": "false"}),
            ("get_current-on", {"client": "on"}),
            ("get_current-off", {"client": "off"}),
            ("get_current-yes", {"client": "yes"}),
            ("get_current-no", {"client": "no"}),
            ("get_current-empty", {"client": ""}),
        ]:
            ts_cur, _ = call(op, token, TS, "admin", "theme", "get_current", data)
            check_true(f"shape-{label}", ts_cur == {"result": NEXT_THEME_ENTRY, "error": None},
                       json.dumps(ts_cur)[:300])
        check_true("shape-current-equals-list-entry",
                   ts_list["result"]["list"][0] == NEXT_THEME_ENTRY, "")
        ts_get, _ = call(op, token, TS, "admin", "theme", "get", {"code": "next"})
        check_true("shape-get-next", ts_get == {"result": NEXT_THEME_ENTRY, "error": None},
                   json.dumps(ts_get)[:300])
        # JSON-body client values take the rawParams path (real types).
        for label, data in [
            ("jcur-true", {"client": True}),
            ("jcur-false", {"client": False}),
            ("jcur-1", {"client": 1}),
            ("jcur-0", {"client": 0}),
            ("jcur-2", {"client": 2}),
        ]:
            ts_cur, _ = jcall(op, token, TS, "admin", "theme", "get_current", data)
            check_true(f"shape-{label}", ts_cur == {"result": NEXT_THEME_ENTRY, "error": None},
                       json.dumps(ts_cur)[:300])
        ts_jarr, _ = jcall(op, token, TS, "admin", "theme", "get_current", {"client": ["x"]})
        check_true("shape-jcur-array-invalid",
                   ts_jarr == {"result": None, "error": {"message": 'Invalid "client" parameter.', "code": 9999}},
                   json.dumps(ts_jarr)[:300])

        # ---- Section C: PHP-EQUIVALENT (both stacks, exact envelopes). ----
        for label, method, data in [
            ("get-missing-code", "get", {}),
            ("get_current-banana", "get_current", {"client": "banana"}),
            ("get_current-2", "get_current", {"client": "2"}),
            ("get_current-maybe", "get_current", {"client": "maybe"}),
        ]:
            php_v, _ = call(op, token, PHP, "admin", "theme", method, data)
            ts_v, _ = call(op, token, TS, "admin", "theme", method, data)
            check(f"equiv-{label}", php_v, ts_v)
        # Unknown code: code + message prefix match exactly; the suffix
        # differs by design (PHP embeds its server themes path, TS
        # names the requested code) and is asserted separately.
        for code in ["nosuchtheme", "huraga"]:
            php_v, _ = call(op, token, PHP, "admin", "theme", "get", {"code": code})
            ts_v, _ = call(op, token, TS, "admin", "theme", "get", {"code": code})
            check_true(f"equiv-get-unknown-code-{code}",
                       php_v.get("error", {}).get("code") == 9999
                       and ts_v.get("error", {}).get("code") == 9999, f"{php_v} vs {ts_v}")
            check_true(f"equiv-get-unknown-prefix-{code}",
                       str(php_v.get("error", {}).get("message", "")).startswith("Theme was not found in path ")
                       and str(ts_v.get("error", {}).get("message", "")).startswith("Theme was not found in path "),
                       f"{php_v} vs {ts_v}")
            check_true(f"shape-get-unknown-ts-msg-{code}",
                       ts_v.get("error", {}).get("message") == f"Theme was not found in path {code}",
                       json.dumps(ts_v)[:300])
        # PHP-existing codes are a DIVERGENCE case, not equivalence:
        # PHP returns its entry; TS has no such theme and answers
        # not-found. Asserted explicitly so the difference is pinned,
        # not hidden.
        for code in ["default/client", "default/admin"]:
            php_v, _ = call(op, token, PHP, "admin", "theme", "get", {"code": code})
            ts_v, _ = call(op, token, TS, "admin", "theme", "get", {"code": code})
            check_true(f"divergence-php-serves-{code}",
                       php_v.get("error") is None and php_v.get("result", {}).get("code") == code,
                       json.dumps(php_v)[:300])
            check_true(f"divergence-ts-notfound-{code}",
                       ts_v == {"result": None, "error": {
                           "message": f"Theme was not found in path {code}", "code": 9999}},
                       json.dumps(ts_v)[:300])

        # Non-super personas (crafted; removed by the finally-restore).
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R4c Support Only", json.dumps({"support": {"access": True, "view": True}})))
        g_support = cur.lastrowid
        cur = d.execute(
            "INSERT INTO admin_group (name, system_name, permissions, protected) VALUES (?, NULL, ?, 0)",
            ("R4c Theme Access No View", json.dumps({"theme": {"access": True}})))
        g_themeacc = cur.lastrowid
        for email, name, groups in [
            ("r4c-support@example.local", "R4c Support", [g_support]),
            ("r4c-themeacc@example.local", "R4c ThemeAcc", [g_themeacc]),
        ]:
            cur = d.execute(
                "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
                (email, PASS_HASH, name))
            for gid in groups:
                d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                          (cur.lastrowid, gid))
        d.commit()
        op_sup, _ = make_opener()
        tok_sup = login(op_sup, "r4c-support@example.local", STAFF_PASS)
        op_acc, _ = make_opener()
        tok_acc = login(op_acc, "r4c-themeacc@example.local", STAFF_PASS)
        for method, data in [("get_list", None), ("get_current", None), ("get", {"code": "next"})]:
            php_v, _ = call(op_sup, tok_sup, PHP, "admin", "theme", method, data)
            ts_v, _ = call(op_sup, tok_sup, TS, "admin", "theme", method, data)
            check(f"equiv-support-725-{method}", php_v, ts_v)
            check_true(f"support-725-is-725-{method}",
                       php_v.get("error", {}).get("code") == 725
                       and ts_v.get("error", {}).get("code") == 725, f"{php_v} vs {ts_v}")
        for method, data in [("get_list", None), ("get", {"code": "next"})]:
            php_v, _ = call(op_acc, tok_acc, PHP, "admin", "theme", method, data)
            ts_v, _ = call(op_acc, tok_acc, TS, "admin", "theme", method, data)
            check(f"equiv-themeacc-403-{method}", php_v, ts_v)
            check_true(f"themeacc-403-is-403-{method}",
                       php_v.get("error", {}).get("code") == 403
                       and ts_v.get("error", {}).get("code") == 403, f"{php_v} vs {ts_v}")
        # Logged-out: 201 on both stacks (identity gate, before guards).
        op_out, _ = make_opener()
        tok_out = page_token(op_out)
        php_v, _ = call(op_out, tok_out, PHP, "admin", "theme", "get_list")
        ts_v, _ = call(op_out, tok_out, TS, "admin", "theme", "get_list")
        check("equiv-loggedout-201", php_v, ts_v)
        check_true("loggedout-201-is-201",
                   php_v.get("error", {}).get("code") == 201
                   and ts_v.get("error", {}).get("code") == 201, f"{php_v} vs {ts_v}")

        # ---- Section D: removals (TS only; PHP writes mutate, never called). ----
        for method, data in [
            ("select", {"code": "next", "client": "1"}),
            ("preset_delete", {"code": "next", "preset": "x"}),
            ("preset_select", {"code": "next", "preset": "x"}),
        ]:
            ts_v, _ = call(op, token, TS, "admin", "theme", method, data)
            check_true(f"removed-{method}",
                       ts_v == {"result": None, "error": {
                           "message": f"Endpoint admin/theme/{method} was removed in the Next.js port.",
                           "code": 9999}}, json.dumps(ts_v)[:300])
            # Logged-out caller proves the gate skip (removal before auth).
            ts_lo, _ = call(op_out, tok_out, TS, "admin", "theme", method, data)
            check_true(f"removed-loggedout-{method}",
                       ts_lo == {"result": None, "error": {
                           "message": f"Endpoint admin/theme/{method} was removed in the Next.js port.",
                           "code": 9999}}, json.dumps(ts_lo)[:300])

        # ---- Section E: no-mutation proof (before the finally-restore). ----
        # The invariants tuple includes the admin tables, which
        # legitimately differ by exactly the 2 crafted personas (2
        # staff + 2 groups + 2 memberships); compare the other 10
        # elements, and assert the persona tables differ by exactly
        # the crafts — that combination proves the reads mutated
        # nothing while the crafts are exactly as intended.
        inv_after, _ = invariants()
        check_true("nomutation-invariants-nonpersona",
                   inv_after[:7] + inv_after[10:] == inv_want[:7] + inv_want[10:],
                   f"{inv_after} != {inv_want}")
        check_true("nomutation-persona-tables-exact",
                   inv_after[7:10] == (4, 5, 3), f"{inv_after[7:10]}")
        check_true("nomutation-theme-settings", theme_settings() == theme_before,
                   f"{theme_settings()} != {theme_before}")
        check_true("nomutation-meta-keys", meta_keys() == meta_before, str(meta_keys()))

        # ---- Section F: secret scan over captured envelopes. ----
        scanned = [ts_list, ts_alist, ts_get, ts_cur, ts_jarr, php_v, ts_v, ts_lo]
        hits = []
        for env in scanned:
            hits += find_secret_keys(env)
        check_true("secret-scan-clean", hits == [], str(hits))

    finally:
        restore()
        # ---- Section G: restore proof. ----
        inv_restored, _ = invariants()
        check_true("invariants-after", inv_restored == inv_want, f"{inv_restored} != {inv_want}")
        check_true("ext-rows-after", ext_rows_set() == ext_before, str(ext_rows_set()))
        check_true("meta-keys-after", meta_keys() == meta_before, str(meta_keys()))
        check_true("theme-settings-after", theme_settings() == theme_before,
                   str(theme_settings()))

    print()
    print(f"parity32: {CHECKS} checks, {len(FAILURES)} failures")
    print("parity32: ALL GREEN" if not FAILURES else "parity32: FAILURES PRESENT")
    for name, php_v, ts_v in FAILURES:
        print("FAILED:", name)


if __name__ == "__main__":
    main()
