#!/usr/bin/env python3
"""Phase 5 R4c capture: PHP theme reads on the reference (super-admin).

Saves the PHP reference corpus for parity32 under captures35/:
  01-getlist.json, 02-getadminlist.json, 03-getcurrent-client.json,
  04-getcurrent-admin.json, 05-getcurrent-invalid.json,
  06-get-client.json, 07-get-admin.json, 08-get-unknown.json,
  09-get-missing.json, 10-baselines.json.
No secrets: theme entries carry no secret keys (paths are server
filesystem paths of the sandbox runtime, not credentials).
No writes are captured: PHP select/preset_* mutate (theme setting,
extension_meta presets) and are deliberately never called here.
"""
import http.cookiejar
import json
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PHP = "http://127.0.0.1:8080"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
OUT = Path(__file__).parent / "captures35"
OUT.mkdir(exist_ok=True)

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
token = m.group(1) if m else None
body = urllib.parse.urlencode(
    {"email": "admin@phase0.local", "password": "Phase1-Admin!42", "CSRFToken": token}
).encode()
resp = json.loads(op.open(
    urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST"),
    timeout=60).read().decode())
assert resp.get("error") is None, f"login failed: {resp}"


def call(method, data, save):
    payload = dict(data or {})
    if token:
        payload["CSRFToken"] = token
    req = urllib.request.Request(
        f"{PHP}/api/admin/theme/{method}",
        data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=60) as r:
            raw, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    parsed = json.loads(raw.decode())
    (OUT / f"{save}.json").write_text(json.dumps(parsed, indent=2))
    err = parsed.get("error") if isinstance(parsed, dict) else None
    print(("OK " if err is None else "ERR"), save,
          (err or {}).get("message", "") if err else "")
    return parsed


call("get_list", None, "01-getlist")
call("get_admin_list", None, "02-getadminlist")
call("get_current", None, "03-getcurrent-client")
call("get_current", {"client": "0"}, "04-getcurrent-admin")
call("get_current", {"client": "banana"}, "05-getcurrent-invalid")
call("get", {"code": "default/client"}, "06-get-client")
call("get", {"code": "default/admin"}, "07-get-admin")
call("get", {"code": "nosuchtheme"}, "08-get-unknown")
call("get", {}, "09-get-missing")

d = sqlite3.connect(DBP)
d.row_factory = sqlite3.Row
q = lambda s: d.execute(s).fetchone()[0]
baselines = {
    "setting_theme": d.execute(
        "SELECT param, value FROM setting WHERE param IN ('theme', 'admin_theme') ORDER BY param"
    ).fetchall(),
    "extension_rows": sorted(tuple(r) for r in d.execute(
        "SELECT type, name, status, version FROM extension")),
    "extension_meta_keys": sorted(tuple(r) for r in d.execute(
        "SELECT extension, meta_key FROM extension_meta")),
    "invariants": (
        q("SELECT COUNT(*) FROM tld"), q("SELECT COUNT(*) FROM tld_registrar"),
        q("SELECT COUNT(*) FROM service_domain"), q("SELECT COUNT(*) FROM email_queue"),
        d.execute("SELECT value FROM setting WHERE id=52").fetchone()[0],
        q("SELECT COUNT(*) FROM invoice"), q("SELECT COUNT(*) FROM client_order"),
        q("SELECT COUNT(*) FROM admin"), q("SELECT COUNT(*) FROM admin_group"),
        q("SELECT COUNT(*) FROM admin_group_member"), q("SELECT COUNT(*) FROM support_ticket"),
        q("SELECT COUNT(*) FROM client"), q("SELECT COUNT(*) FROM service_downloadable"),
    ),
}
(OUT / "10-baselines.json").write_text(json.dumps(baselines, indent=2, default=list))
print("OK 10-baselines")
