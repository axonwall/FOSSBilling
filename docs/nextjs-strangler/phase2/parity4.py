#!/usr/bin/env python3
"""Phase 2 batch 3 parity: replay capture7 against the Next origin.
News/page creates return fresh ids per run — each side's own id is used
downstream, and created-row timestamps are normalized before compare.
The activity log is live append-only data, so it gets a back-to-back
A/B (PHP direct vs Next TS) comparing envelope/item shapes instead of
frozen values."""
import json, sys, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
PHP = "http://127.0.0.1:8080"
REF = pathlib.Path(__file__).parent / "captures7"

def make_opener():
    cj = http.cookiejar.CookieJar()
    return cj, urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

cj, opener = make_opener()

def csrf_of(jar):
    for c in jar:
        if c.name == "fossbilling_csrf":
            return c.value

def raw_call(op, jar, base, role, module, method, data=None):
    payload = dict(data or {})
    if csrf_of(jar):
        payload["CSRFToken"] = csrf_of(jar)
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{base}/api/fb/{role}/{module}/{method}" if base == NEXT else f"{base}/api/{role}/{module}/{method}",
                                 data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with op.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def call(name, role, module, method, data=None):
    return raw_call(opener, cj, NEXT, role, module, method, data)

def scrub(v, ids):
    """Normalize volatile values: this run's created ids + row timestamps."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in ("created_at", "updated_at") and isinstance(x, str) and x.startswith("2026-10-24"):
                out[k] = "*ts*"
            elif k == "id" and x in ids:
                out[k] = "*id*"
            else:
                out[k] = scrub(x, ids)
        return out
    if isinstance(v, list):
        return [scrub(x, ids) for x in v]
    return v

results = []
def expect(name, got, ref_name, ref_ids=(), got_ids=()):
    ref = json.loads((REF / f"{ref_name}.json").read_text())
    ok = scrub(got, set(got_ids)) == scrub(ref, set(ref_ids))
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(scrub(ref, set(ref_ids)))[:240]}")
        print(f"   ts:  {json.dumps(scrub(got, set(got_ids)))[:240]}")
    results.append(ok)

def expect_live(name, got, ref_name, **kw):
    expect(name, got, ref_name, **kw)

opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
expect_live("guest_news_get_list_empty", call("x", "guest", "news", "get_list"), "guest_news_get_list_empty")
expect_live("guest_pages_get_list", call("x", "guest", "custompages", "get_list"), "guest_pages_get_list")
call("x", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
expect_live("admin_staff_get_list", call("x", "admin", "staff", "get_list"), "admin_staff_get_list")
expect_live("admin_staff_get_1", call("x", "admin", "staff", "get", {"id": 1}), "admin_staff_get_1")
expect_live("admin_staff_get_missing", call("x", "admin", "staff", "get", {"id": 99999}), "admin_staff_get_missing")
expect_live("admin_staff_get_pairs", call("x", "admin", "staff", "get_pairs"), "admin_staff_get_pairs")
expect_live("admin_staff_is_super", call("x", "admin", "staff", "is_super_administrator"), "admin_staff_is_super")

# News lifecycle with this run's id (PHP run created id 5, recorded in captures)
ref_news_id = json.loads((REF / "admin_news_create.json").read_text())["result"]
created = call("x", "admin", "news", "create", {"title": "Parity Post", "content": "Hello parity", "description": "pd", "status": "active"})
ts_news_id = created.get("result")
ok = isinstance(ts_news_id, int)
print(f"{'MATCH' if ok else 'DIFF '} admin_news_create (returns new id)")
results.append(ok)
expect("guest_news_get_list_after", call("x", "guest", "news", "get_list"), "guest_news_get_list_after", ref_ids=(ref_news_id,), got_ids=(ts_news_id,))
expect("guest_news_get", call("x", "guest", "news", "get", {"id": ts_news_id}), "guest_news_get", ref_ids=(ref_news_id,), got_ids=(ts_news_id,))
expect("admin_news_get", call("x", "admin", "news", "get", {"id": ts_news_id}), "admin_news_get", ref_ids=(ref_news_id,), got_ids=(ts_news_id,))
expect("admin_news_update", call("x", "admin", "news", "update", {"id": ts_news_id, "title": "Parity Post Edited"}), "admin_news_update")
expect("admin_news_get_after_update", call("x", "admin", "news", "get", {"id": ts_news_id}), "admin_news_get_after_update", ref_ids=(ref_news_id,), got_ids=(ts_news_id,))
expect("admin_news_delete", call("x", "admin", "news", "delete", {"id": ts_news_id}), "admin_news_delete")
expect("admin_news_get_deleted", call("x", "admin", "news", "get", {"id": ts_news_id}), "admin_news_get_deleted")

# Custompages lifecycle
ref_page_id = json.loads((REF / "admin_page_create.json").read_text())["result"]
created2 = call("x", "admin", "custompages", "create", {"title": "Parity Page", "content": "Page body", "description": "d", "keywords": "k"})
ts_page_id = created2.get("result")
ok = isinstance(ts_page_id, int)
print(f"{'MATCH' if ok else 'DIFF '} admin_page_create (returns new id)")
results.append(ok)
expect("guest_pages_get_list_after", call("x", "guest", "custompages", "get_list"), "guest_pages_get_list_after", ref_ids=(ref_page_id,), got_ids=(ts_page_id,))
expect("guest_pages_get", call("x", "guest", "custompages", "get", {"slug": "parity-page"}), "guest_pages_get", ref_ids=(ref_page_id,), got_ids=(ts_page_id,))
expect("admin_page_get_page", call("x", "admin", "custompages", "get_page", {"page_id": ts_page_id}), "admin_page_get_page", ref_ids=(ref_page_id,), got_ids=(ts_page_id,))
expect("admin_page_delete", call("x", "admin", "custompages", "delete", {"id": ts_page_id}), "admin_page_delete")

# Activity: live A/B shape check (append-only log; values drift)
cj2, op2 = make_opener()
op2.open(f"{PHP}/login", timeout=20).read()
raw_call(op2, cj2, PHP, "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
php_act = raw_call(op2, cj2, PHP, "admin", "activity", "log_get_list", {"search": "Parity Post"})
ts_act = call("x", "admin", "activity", "log_get_list", {"search": "Parity Post"})
def shape(env):
    r = env.get("result") or {}
    items = r.get("list") or []
    return {
        "envelope_keys": sorted(r.keys()),
        "item_keys": sorted(items[0].keys()) if items else [],
        "total_positive": (r.get("total") or 0) > 0,
        "has_nested_staff": any("staff" in i for i in items),
    }
ok = shape(php_act) == shape(ts_act)
print(f"{'MATCH' if ok else 'DIFF '} admin_activity_log_get_list (shape A/B)")
if not ok:
    print("   php:", shape(php_act))
    print("   ts: ", shape(ts_act))
results.append(ok)

print(f"\nparity batch3: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
