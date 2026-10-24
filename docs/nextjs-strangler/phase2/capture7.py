#!/usr/bin/env python3
"""Phase 2 batch 3 PHP reference capture: Staff reads, Activity log,
News + Custompages guest/admin reads and net-zero mutations.
Created post/page ids are recorded in the manifest (they differ per run;
parity normalizes them)."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures7"
OUT.mkdir(exist_ok=True)
manifest = []
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf():
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value

def call(name, role, module, method, data=None, save=True):
    payload = dict(data or {})
    if csrf():
        payload["CSRFToken"] = csrf()
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            text = resp.read().decode()
    except urllib.error.HTTPError as e:
        text = e.read().decode()
    parsed = json.loads(text)
    if save:
        (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}", "params": data or {},
                     "ok": parsed.get("error") is None, "error": (parsed.get("error") or {}).get("message"),
                     "result": parsed.get("result") if name.endswith("_create") else None})
    print(f"{'OK ' if parsed.get('error') is None else 'ERR'} {name} {(parsed.get('error') or {}).get('message') or ''}")
    return parsed

opener.open(f"{BASE}/login", timeout=20).read()
call("guest_news_get_list_empty", "guest", "news", "get_list")
call("guest_pages_get_list", "guest", "custompages", "get_list")
call("guest_staff_login", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
call("admin_staff_get_list", "admin", "staff", "get_list")
call("admin_staff_get_1", "admin", "staff", "get", {"id": 1})
call("admin_staff_get_missing", "admin", "staff", "get", {"id": 99999})
call("admin_staff_get_pairs", "admin", "staff", "get_pairs")
call("admin_staff_is_super", "admin", "staff", "is_super_administrator")
call("admin_activity_log_get_list", "admin", "activity", "log_get_list")
call("admin_activity_log_staff_only", "admin", "activity", "log_get_list", {"user_filter": "only_staff"})
# News lifecycle (net-zero)
created = call("admin_news_create", "admin", "news", "create",
               {"title": "Parity Post", "content": "Hello parity", "description": "pd", "status": "active"})
pid = created.get("result")
call("guest_news_get_list_after", "guest", "news", "get_list")
call("guest_news_get", "guest", "news", "get", {"id": pid})
call("admin_news_get", "admin", "news", "get", {"id": pid})
call("admin_news_update", "admin", "news", "update", {"id": pid, "title": "Parity Post Edited"})
call("admin_news_get_after_update", "admin", "news", "get", {"id": pid})
call("admin_news_delete", "admin", "news", "delete", {"id": pid})
call("admin_news_get_deleted", "admin", "news", "get", {"id": pid})
# Custompages lifecycle (net-zero)
created2 = call("admin_page_create", "admin", "custompages", "create",
                {"title": "Parity Page", "content": "Page body", "description": "d", "keywords": "k"})
slug = created2.get("result")
call("guest_pages_get_list_after", "guest", "custompages", "get_list")
call("guest_pages_get", "guest", "custompages", "get", {"slug": slug} if isinstance(slug, str) else {"id": slug})
call("admin_page_get_page", "admin", "custompages", "get_page", {"page_id": slug})
call("admin_page_delete", "admin", "custompages", "delete", {"slug": slug} if isinstance(slug, str) else {"id": slug})
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(f"\ncaptures7 done -> {OUT}; news id={pid}, page create result={slug!r}")
