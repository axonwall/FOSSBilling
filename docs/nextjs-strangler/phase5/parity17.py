#!/usr/bin/env python3
"""Phase 5 core-CRUD parity 2: Product admin module through TS, checked
against captures20/.

Mirrors capture20.py with fresh Par17* data. Error pins compare
messages exactly (plus code where pinned). Value comparisons scrub
created_at/updated_at, rename Par20/PAR20/par20/cap20 -> Par17
equivalents, and substitute the fresh ids returned by the TS run.
"""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
CAP = pathlib.Path(__file__).parent / "captures20"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_PW = "Phase1-Admin!42"
results = []


def report(name, ok, detail=""):
    results.append(ok)
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        elif isinstance(v, list):
            for i, item in enumerate(v):
                out[f"{key}[{i}]"] = item
        else:
            out[key] = v
    return out


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def csrf_of(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value


RENAMES = [("Par20", "Par17"), ("PAR20", "PAR17"), ("par20", "par17"), ("cap20", "cap17")]


def rename_strings(obj):
    if isinstance(obj, dict):
        return {rename_strings(k): rename_strings(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [rename_strings(x) for x in obj]
    if isinstance(obj, str):
        for a, b in RENAMES:
            obj = obj.replace(a, b)
        return obj
    return obj


def scrub(obj):
    if isinstance(obj, dict):
        return {k: ("*ts*" if k in ("created_at", "updated_at") else scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    return obj


def main():
    d = sqlite3.connect(DBP)
    d.execute("DELETE FROM product WHERE title LIKE 'Par17%'")
    d.execute("DELETE FROM product_category WHERE title LIKE 'Par17%'")
    d.execute("DELETE FROM promo WHERE code LIKE 'PAR17%'")
    d.commit()

    def call(op, cj, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def oracle(name):
        return json.load(open(CAP / f"{name}.json"))

    def err(r):
        return (r.get("error") or {}).get("message") if isinstance(r, dict) else None

    def errcode(r):
        return (r.get("error") or {}).get("code") if isinstance(r, dict) else None

    def expect_err(name, r, capname, code=None):
        want = oracle(capname)
        ok = err(r) == err(want) and (code is None or errcode(r) == code)
        report(name, ok, f"got {err(r)!r}/{errcode(r)!r} want {err(want)!r}/{code!r}")

    def expect_bool(name, r, capname):
        want = oracle(capname)["result"]
        report(name, r.get("result") == want and r.get("error") is None,
               f"got {r.get('result')!r} want {want!r}")

    op_a, cj_a = make_opener()
    op_a.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_a, cj_a, "guest", "staff", "login", {"email": "admin@phase0.local", "password": ADMIN_PW})
    assert r.get("error") is None, r

    # --- types + prepare ---
    r = call(op_a, cj_a, "admin", "product", "get_types")
    report("admin_get_types", r.get("result") == oracle("admin_get_types")["result"],
           f"got {r.get('result')} want {oracle('admin_get_types')['result']}")
    expect_err("admin_prepare_missing_title",
               call(op_a, cj_a, "admin", "product", "prepare", {"type": "custom"}),
               "admin_prepare_missing_title")
    expect_err("admin_prepare_missing_type",
               call(op_a, cj_a, "admin", "product", "prepare", {"title": "Par17 NoType"}),
               "admin_prepare_missing_type")
    expect_err("admin_prepare_bad_type",
               call(op_a, cj_a, "admin", "product", "prepare", {"title": "Par17 Bad", "type": "nope"}),
               "admin_prepare_bad_type", code=413)
    expect_err("admin_prepare_domain_dup",
               call(op_a, cj_a, "admin", "product", "prepare", {"title": "Par17 Domain", "type": "domain"}),
               "admin_prepare_domain_dup", code=413)
    r = call(op_a, cj_a, "admin", "product", "prepare", {"title": "Par17 Widget", "type": "custom"})
    pid = r["result"]
    print("product id:", pid)
    report("admin_prepare_ok", isinstance(pid, int), f"got {pid!r}")
    r = call(op_a, cj_a, "admin", "product", "get", {"id": pid})
    want = rename_strings(oracle("admin_get_new")["result"])
    want["id"] = pid
    report("admin_get_new", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")

    # --- update: errors then ok ---
    expect_err("admin_update_missing_id",
               call(op_a, cj_a, "admin", "product", "update", {"title": "X"}),
               "admin_update_missing_id")
    expect_err("admin_update_missing_product",
               call(op_a, cj_a, "admin", "product", "update", {"id": 99999, "title": "X"}),
               "admin_update_missing_product")
    expect_err("admin_update_icon_too_long",
               call(op_a, cj_a, "admin", "product", "update", {"id": pid, "icon_url": "x" * 256}),
               "admin_update_icon_too_long")
    expect_err("admin_update_bad_grace",
               call(op_a, cj_a, "admin", "product", "update", {"id": pid, "suspension_grace_days": -1}),
               "admin_update_bad_grace")
    expect_err("admin_update_pricing_no_type",
               call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"once": {"price": 5}}}),
               "admin_update_pricing_no_type")
    expect_err("admin_update_pricing_bad_type",
               call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"type": "bogus"}}),
               "admin_update_pricing_bad_type")
    expect_err("admin_update_pricing_recurrent_empty",
               call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {}}}),
               "admin_update_pricing_recurrent_empty")
    expect_err("admin_update_pricing_bad_period",
               call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {"99Z": {"price": 1}}}}),
               "admin_update_pricing_bad_period")

    def get_after(name, capname):
        r = call(op_a, cj_a, "admin", "product", "get", {"id": pid})
        want = rename_strings(oracle(capname)["result"])
        want["id"] = pid
        report(name, scrub(r.get("result")) == scrub(want),
               f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")

    expect_bool("admin_update_pricing_once",
                call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"type": "once", "once": {"price": 42, "setup": 7}}}),
                "admin_update_pricing_once")
    get_after("admin_get_after_once", "admin_get_after_once")
    expect_bool("admin_update_pricing_recurrent",
                call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {"1M": {"price": 15, "setup": 5, "enabled": 1}, "1Y": {"price": 150, "setup": 0, "enabled": 1}}}}),
                "admin_update_pricing_recurrent")
    get_after("admin_get_after_recurrent", "admin_get_after_recurrent")
    expect_bool("admin_update_pricing_recurrent_replace",
                call(op_a, cj_a, "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {"1M": {"price": 20, "setup": 0, "enabled": 1}}}}),
                "admin_update_pricing_recurrent_replace")
    get_after("admin_get_after_replace", "admin_get_after_replace")
    expect_bool("admin_update_fields",
                call(op_a, cj_a, "admin", "product", "update",
                     {"id": pid, "title": "Par17 Widget Renamed", "description": "cap17 desc", "status": "enabled",
                      "hidden": 1, "stock_control": 1, "quantity_in_stock": 3, "setup": "after_order",
                      "slug": "par17-renamed", "upgrades": [2, 3], "addons": [], "config": {"foo": "bar"}}),
                "admin_update_fields")
    get_after("admin_get_after_fields", "admin_get_after_fields")
    expect_bool("admin_update_config",
                call(op_a, cj_a, "admin", "product", "update_config",
                     {"id": pid, "config": {"foo": "", "baz": "qux"}, "new_config_name": "extra", "new_config_value": "val"}),
                "admin_update_config")
    get_after("admin_get_after_config", "admin_get_after_config")

    # --- priority (swap 2 products, restore) ---
    p2 = d.execute("SELECT priority FROM product WHERE id = 2").fetchone()[0]
    p3 = d.execute("SELECT priority FROM product WHERE id = 3").fetchone()[0]
    expect_err("admin_update_priority_missing",
               call(op_a, cj_a, "admin", "product", "update_priority", {}),
               "admin_update_priority_missing")
    expect_bool("admin_update_priority_ok",
                call(op_a, cj_a, "admin", "product", "update_priority", {"priority": {2: p3, 3: p2}}),
                "admin_update_priority_ok")
    r = call(op_a, cj_a, "admin", "product", "get", {"id": 2})
    want = rename_strings(oracle("admin_get_after_priority")["result"])
    report("admin_get_after_priority", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    expect_bool("admin_update_priority_restore",
                call(op_a, cj_a, "admin", "product", "update_priority", {"priority": {2: p2, 3: p3}}),
                "admin_update_priority_restore")

    # --- addons ---
    expect_err("admin_addon_create_missing",
               call(op_a, cj_a, "admin", "product", "addon_create", {}),
               "admin_addon_create_missing")
    r = call(op_a, cj_a, "admin", "product", "addon_create",
             {"title": "Par17 Addon", "description": "addon desc", "status": "enabled", "setup": "after_payment"})
    aid = r["result"]
    print("addon id:", aid)
    report("admin_addon_create_ok", isinstance(aid, int), f"got {aid!r}")
    r = call(op_a, cj_a, "admin", "product", "addon_get", {"id": aid})
    want = rename_strings(oracle("admin_addon_get")["result"])
    want["id"] = aid
    report("admin_addon_get", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    expect_err("admin_addon_get_not_addon",
               call(op_a, cj_a, "admin", "product", "addon_get", {"id": pid}),
               "admin_addon_get_not_addon")
    expect_err("admin_addon_get_missing",
               call(op_a, cj_a, "admin", "product", "addon_get", {"id": 99999}),
               "admin_addon_get_missing")
    expect_bool("admin_addon_update",
                call(op_a, cj_a, "admin", "product", "addon_update", {"id": aid, "title": "Par17 Addon Renamed"}),
                "admin_addon_update")
    r = call(op_a, cj_a, "admin", "product", "addon_get_pairs")
    want = rename_strings(oracle("admin_addon_get_pairs")["result"])
    want = {str(aid): want["11"]} if "11" in want else want
    report("admin_addon_get_pairs", r.get("result") == want,
           f"got {r.get('result')} want {want}")
    expect_bool("admin_addon_delete",
                call(op_a, cj_a, "admin", "product", "addon_delete", {"id": aid}),
                "admin_addon_delete")

    # --- delete guards ---
    expect_err("admin_delete_missing_id",
               call(op_a, cj_a, "admin", "product", "delete", {}),
               "admin_delete_missing_id")
    expect_err("admin_delete_missing_product",
               call(op_a, cj_a, "admin", "product", "delete", {"id": 99999}),
               "admin_delete_missing_product")
    expect_err("admin_delete_blocked_orders",
               call(op_a, cj_a, "admin", "product", "delete", {"id": 3}),
               "admin_delete_blocked_orders")
    expect_bool("admin_delete_ok",
                call(op_a, cj_a, "admin", "product", "delete", {"id": pid}),
                "admin_delete_ok")
    expect_err("admin_get_after_delete",
               call(op_a, cj_a, "admin", "product", "get", {"id": pid}),
               "admin_get_after_delete")

    # --- categories ---
    expect_err("admin_category_create_missing",
               call(op_a, cj_a, "admin", "product", "category_create", {}),
               "admin_category_create_missing")
    r = call(op_a, cj_a, "admin", "product", "category_create",
             {"title": "Par17 Category", "description": "cat desc", "priority": 5})
    cat = r["result"]
    print("category id:", cat)
    report("admin_category_create_ok", isinstance(cat, int), f"got {cat!r}")
    r = call(op_a, cj_a, "admin", "product", "category_get", {"id": cat})
    want = rename_strings(oracle("admin_category_get")["result"])
    want["id"] = cat
    report("admin_category_get", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    expect_err("admin_category_get_missing",
               call(op_a, cj_a, "admin", "product", "category_get", {"id": 99999}),
               "admin_category_get_missing")
    expect_bool("admin_category_update",
                call(op_a, cj_a, "admin", "product", "category_update", {"id": cat, "title": "Par17 Category Renamed"}),
                "admin_category_update")
    expect_err("admin_category_update_icon_too_long",
               call(op_a, cj_a, "admin", "product", "category_update", {"id": cat, "icon_url": "x" * 256}),
               "admin_category_update_icon_too_long")
    r = call(op_a, cj_a, "admin", "product", "category_get_list", {})
    want = rename_strings(oracle("admin_category_get_list")["result"])
    for item in want:
        if item["title"] == "Par17 Category Renamed":
            item["id"] = cat
    report("admin_category_get_list", r.get("result") == want,
           f"got {r.get('result')} want {want}")
    r = call(op_a, cj_a, "admin", "product", "category_get_list", {"search": "Par17"})
    want = rename_strings(oracle("admin_category_get_list_search")["result"])
    for item in want:
        if item["title"] == "Par17 Category Renamed":
            item["id"] = cat
    report("admin_category_get_list_search", r.get("result") == want,
           f"got {r.get('result')} want {want}")
    r = call(op_a, cj_a, "admin", "product", "category_get_pairs")
    want = rename_strings(oracle("admin_category_get_pairs")["result"])
    want = {str(cat) if k == "2" and want.get("2") == "Par17 Category Renamed" else k: v for k, v in want.items()}
    report("admin_category_get_pairs", r.get("result") == want,
           f"got {r.get('result')} want {want}")
    expect_err("admin_category_update_priority_bad",
               call(op_a, cj_a, "admin", "product", "category_update_priority", {"priority": {cat: "abc"}}),
               "admin_category_update_priority_bad")
    expect_bool("admin_category_update_priority_ok",
                call(op_a, cj_a, "admin", "product", "category_update_priority", {"priority": {cat: 7}}),
                "admin_category_update_priority_ok")
    r = call(op_a, cj_a, "admin", "product", "category_get", {"id": cat})
    want = rename_strings(oracle("admin_category_get_after_priority")["result"])
    want["id"] = cat
    report("admin_category_get_after_priority", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    r = call(op_a, cj_a, "admin", "product", "prepare",
             {"title": "Par17 InCat", "type": "custom", "product_category_id": cat})
    catpid = r["result"]
    report("admin_prepare_in_category", isinstance(catpid, int), f"got {catpid!r}")
    expect_err("admin_category_delete_blocked",
               call(op_a, cj_a, "admin", "product", "category_delete", {"id": cat}),
               "admin_category_delete_blocked")
    expect_bool("admin_delete_incat",
                call(op_a, cj_a, "admin", "product", "delete", {"id": catpid}),
                "admin_delete_incat")
    expect_bool("admin_category_delete_ok",
                call(op_a, cj_a, "admin", "product", "category_delete", {"id": cat}),
                "admin_category_delete_ok")
    expect_err("admin_category_delete_missing",
               call(op_a, cj_a, "admin", "product", "category_delete", {"id": 99999}),
               "admin_category_delete_missing")

    # --- promos ---
    expect_err("admin_promo_create_missing",
               call(op_a, cj_a, "admin", "product", "promo_create", {"type": "percentage", "value": 10}),
               "admin_promo_create_missing")
    r = call(op_a, cj_a, "admin", "product", "promo_create",
             {"code": "PAR17SAVE", "type": "percentage", "value": 10, "products": [2, 3], "periods": ["1M"],
              "active": 1, "maxuses": 100, "description": "cap17 promo"})
    prom = r["result"]
    print("promo id:", prom)
    report("admin_promo_create_ok", isinstance(prom, int), f"got {prom!r}")
    expect_err("admin_promo_create_dup",
               call(op_a, cj_a, "admin", "product", "promo_create", {"code": "PAR17SAVE", "type": "percentage", "value": 5}),
               "admin_promo_create_dup")
    r = call(op_a, cj_a, "admin", "product", "promo_get", {"id": prom})
    want = rename_strings(oracle("admin_promo_get")["result"])
    want["id"] = prom
    report("admin_promo_get", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    expect_err("admin_promo_get_missing",
               call(op_a, cj_a, "admin", "product", "promo_get", {"id": 99999}),
               "admin_promo_get_missing")
    for lname, args in [("admin_promo_get_list", {}),
                        ("admin_promo_get_list_search", {"search": "PAR17"}),
                        ("admin_promo_get_list_status_active", {"status": "active"})]:
        r = call(op_a, cj_a, "admin", "product", "promo_get_list", args)
        want = rename_strings(oracle(lname)["result"])
        for item in want["list"]:
            item["id"] = prom
        report(lname, scrub(r.get("result")) == scrub(want),
               f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    expect_bool("admin_promo_update",
                call(op_a, cj_a, "admin", "product", "promo_update",
                     {"id": prom, "value": 15, "maxuses": 50, "products": [2]}),
                "admin_promo_update")
    r = call(op_a, cj_a, "admin", "product", "promo_get", {"id": prom})
    want = rename_strings(oracle("admin_promo_get_after_update")["result"])
    want["id"] = prom
    report("admin_promo_get_after_update", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    r = call(op_a, cj_a, "admin", "product", "promo_duplicate", {"id": prom})
    dup = r["result"]
    print("promo dup id:", dup)
    report("admin_promo_duplicate", isinstance(dup, int), f"got {dup!r}")
    r = call(op_a, cj_a, "admin", "product", "promo_get", {"id": dup})
    want = rename_strings(oracle("admin_promo_get_dup")["result"])
    want["id"] = dup
    report("admin_promo_get_dup", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    r = call(op_a, cj_a, "admin", "product", "promo_redemption_get_list", {"promo_id": prom})
    report("admin_promo_redemption_get_list",
           r.get("result") == oracle("admin_promo_redemption_get_list")["result"],
           f"got {r.get('result')} want {oracle('admin_promo_redemption_get_list')['result']}")
    expect_err("admin_promo_redemption_missing_id",
               call(op_a, cj_a, "admin", "product", "promo_redemption_get_list", {}),
               "admin_promo_redemption_missing_id")
    expect_err("admin_promo_update_dup_code",
               call(op_a, cj_a, "admin", "product", "promo_update", {"id": dup, "code": "PAR17SAVE"}),
               "admin_promo_update_dup_code")
    expect_bool("admin_promo_delete_dup",
                call(op_a, cj_a, "admin", "product", "promo_delete", {"id": dup}),
                "admin_promo_delete_dup")
    expect_bool("admin_promo_delete_ok",
                call(op_a, cj_a, "admin", "product", "promo_delete", {"id": prom}),
                "admin_promo_delete_ok")
    expect_err("admin_promo_delete_missing",
               call(op_a, cj_a, "admin", "product", "promo_delete", {"id": 99999}),
               "admin_promo_delete_missing")

    print(f"\n{sum(1 for x in results if x)}/{len(results)} MATCH")


if __name__ == "__main__":
    main()
