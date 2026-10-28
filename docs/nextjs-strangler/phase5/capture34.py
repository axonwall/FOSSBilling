#!/usr/bin/env python3
"""Phase 5 R4b capture: PHP (:8080) reference corpus for the Extension UI's
read inputs, saved under captures34/. The list and detail pages read via
fbCall to PHP (the established page-read pattern), so the corpus is the
two get_list modes the pages merge (active=1 for core + installed,
default for installed + available), plus the config_get no-row case the
detail page shows for a settings module with no stored config, plus
extension / extension_meta baselines.

Read-only; no mutations. No secrets are captured: the config_get case
uses a module with no stored config row (result is {ext} only), and
baselines record keys, not encrypted values.
"""
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
OUT = pathlib.Path(__file__).resolve().parent / "captures34"
OUT.mkdir(exist_ok=True)


def main():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
    token = m.group(1) if m else None

    def call(role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(
            f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def save(name, env):
        (OUT / name).write_text(json.dumps(env, indent=1, sort_keys=True) + "\n")
        print(f"saved {name}")

    login = call("guest", "staff", "login", {"email": SUPER_EMAIL, "password": SUPER_PASS})
    assert login.get("error") is None, login

    save("01-getlist-active.json",
         call("admin", "extension", "get_list", {"active": 1}))
    save("02-getlist-default.json",
         call("admin", "extension", "get_list", {}))
    save("03-config-get-support-norow.json",
         call("admin", "extension", "config_get", {"ext": "mod_support"}))
    # News declares no manage_settings key, so even the super-admin gets
    # the identity-independent 403 here (R4a findings Q4) — captured as
    # the error envelope the detail page renders inline.
    save("04-config-get-news-403.json",
         call("admin", "extension", "config_get", {"ext": "mod_news"}))

    d = sqlite3.connect(DBP)
    ext = sorted(tuple(r) for r in d.execute(
        "SELECT type, name, status, version FROM extension"))
    meta = sorted(tuple(r) for r in d.execute(
        "SELECT extension, meta_key FROM extension_meta"))
    save("05-baselines.json", {"extension_rows": ext, "extension_meta_keys": meta})
    print("extension rows:", ext)
    print("extension_meta keys:", meta)


if __name__ == "__main__":
    main()
