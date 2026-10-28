#!/usr/bin/env python3
"""Phase 5 R4a capture: PHP (:8080) reference corpus for the Extension
API, saved under captures33/. Read-only plus error shapes only — the
mutating round-trips (activate/deactivate, config_save) live in
parity30.py, which restores everything in finally.

Captured:
  01-08  get_list modes/filters (default, active, installed,
         has_settings=1, search=news, search=NEWS, type=mod,
         installed+active)
  09-11  activate error shapes (missing id, missing type, unknown mod)
  12-14  deactivate error shapes (missing id, nonexistent, core w/o row)
  15-22  guest is_on cases
  23-27  guest settings cases (incl. missing ext)
  28-29  config_get no-row cases
  30     baselines: extension rows + extension_meta keys
No secrets are captured: config_get cases use modules with no stored
config row (result is {ext} only), and baselines record keys, not
encrypted values.
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
OUT = pathlib.Path(__file__).resolve().parent / "captures33"
OUT.mkdir(exist_ok=True)


def main():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    token = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page).group(1)

    def call(role, module, method, data=None):
        payload = dict(data or {})
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

    cases = [
        ("01-getlist-default.json", ("admin", "extension", "get_list", {})),
        ("02-getlist-active.json", ("admin", "extension", "get_list", {"active": "1"})),
        ("03-getlist-installed.json", ("admin", "extension", "get_list", {"installed": "1"})),
        ("04-getlist-has-settings.json", ("admin", "extension", "get_list", {"has_settings": "1"})),
        ("05-getlist-search-news.json", ("admin", "extension", "get_list", {"search": "news"})),
        ("06-getlist-search-NEWS.json", ("admin", "extension", "get_list", {"search": "NEWS"})),
        ("07-getlist-type-mod.json", ("admin", "extension", "get_list", {"type": "mod"})),
        ("08-getlist-installed-active.json",
         ("admin", "extension", "get_list", {"installed": "1", "active": "1"})),
        ("09-activate-missing-id.json", ("admin", "extension", "activate", {"type": "mod"})),
        ("10-activate-missing-type.json", ("admin", "extension", "activate", {"id": "news"})),
        ("11-activate-unknown.json",
         ("admin", "extension", "activate", {"id": "r4a_no_such_mod", "type": "mod"})),
        ("12-deactivate-missing-id.json", ("admin", "extension", "deactivate", {"type": "mod"})),
        ("13-deactivate-nonexistent.json",
         ("admin", "extension", "deactivate", {"id": "r4a_no_such_mod", "type": "mod"})),
        ("14-deactivate-core-norow.json",
         ("admin", "extension", "deactivate", {"id": "client", "type": "mod"})),
        ("15-ison-news.json", ("guest", "extension", "is_on", {"mod": "news"})),
        ("16-ison-branding.json", ("guest", "extension", "is_on", {"mod": "branding"})),
        ("17-ison-client-core.json", ("guest", "extension", "is_on", {"mod": "client"})),
        ("18-ison-nonexistent.json", ("guest", "extension", "is_on", {"mod": "nonexistent"})),
        ("19-ison-noparams.json", ("guest", "extension", "is_on", {})),
        ("20-ison-id-type.json",
         ("guest", "extension", "is_on", {"id": "news", "type": "mod"})),
        ("21-ison-id-type-nonexistent.json",
         ("guest", "extension", "is_on", {"id": "nonexistent", "type": "mod"})),
        ("22-ison-theme-nonmod.json",
         ("guest", "extension", "is_on", {"id": "theme", "type": "theme"})),
        ("23-settings-mod-support.json", ("guest", "extension", "settings", {"ext": "mod_support"})),
        ("24-settings-support.json", ("guest", "extension", "settings", {"ext": "support"})),
        ("25-settings-mod-news.json", ("guest", "extension", "settings", {"ext": "mod_news"})),
        ("26-settings-nonexistent.json", ("guest", "extension", "settings", {"ext": "nonexistent"})),
        ("27-settings-missing-ext.json", ("guest", "extension", "settings", {})),
        ("28-config-get-mod-support.json", ("admin", "extension", "config_get", {"ext": "mod_support"})),
        ("29-config-get-mod-news.json", ("admin", "extension", "config_get", {"ext": "mod_news"})),
    ]
    for name, (role, module, method, data) in cases:
        save(name, call(role, module, method, data))

    d = sqlite3.connect(DBP)
    ext_rows = [tuple(r) for r in d.execute(
        "SELECT type, name, status, version FROM extension ORDER BY id")]
    meta_keys = [tuple(r) for r in d.execute(
        "SELECT extension, meta_key FROM extension_meta ORDER BY id")]
    save("30-baselines.json", {"extension_rows": ext_rows, "extension_meta_keys": meta_keys})
    print(f"capture33: {len(cases) + 1} files in {OUT}")


if __name__ == "__main__":
    main()
