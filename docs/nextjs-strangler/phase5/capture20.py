#!/usr/bin/env python3
"""Phase 5 core-CRUD capture 2: Product admin module against PHP.
Fresh products/categories/promos (par20*) are deleted at the end
via the API where possible, else SQL. Seeded products are never
mutated except priority swaps (restored)."""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures20"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"


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


def main():
    d = sqlite3.connect(DBP)
    d.execute("DELETE FROM product WHERE title LIKE 'Par20%'")
    d.execute("DELETE FROM product_category WHERE title LIKE 'Par20%'")
    d.execute("DELETE FROM promo WHERE code LIKE 'PAR20%'")
    d.commit()
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.open(f"{BASE}/login", timeout=20).read()

    def csrf():
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(name, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf():
            payload["CSRFToken"] = csrf()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            parsed = json.loads(e.read().decode())
        (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
        ok = isinstance(parsed, dict) and parsed.get("error") is None
        manifest.append({"name": name, "ok": ok,
                         "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
        print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
        return parsed

    call("tmp_staff_login", "guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})

    # --- types + prepare ---
    call("admin_get_types", "admin", "product", "get_types")
    call("admin_prepare_missing_title", "admin", "product", "prepare", {"type": "custom"})
    call("admin_prepare_missing_type", "admin", "product", "prepare", {"title": "Par20 NoType"})
    call("admin_prepare_bad_type", "admin", "product", "prepare", {"title": "Par20 Bad", "type": "nope"})
    call("admin_prepare_domain_dup", "admin", "product", "prepare", {"title": "Par20 Domain", "type": "domain"})
    r = call("admin_prepare_ok", "admin", "product", "prepare", {"title": "Par20 Widget", "type": "custom"})
    pid = r["result"]
    print("product id:", pid)
    call("admin_get_new", "admin", "product", "get", {"id": pid})

    # --- update: errors then ok ---
    call("admin_update_missing_id", "admin", "product", "update", {"title": "X"})
    call("admin_update_missing_product", "admin", "product", "update", {"id": 99999, "title": "X"})
    call("admin_update_icon_too_long", "admin", "product", "update", {"id": pid, "icon_url": "x" * 256})
    call("admin_update_bad_grace", "admin", "product", "update", {"id": pid, "suspension_grace_days": -1})
    call("admin_update_pricing_no_type", "admin", "product", "update", {"id": pid, "pricing": {"once": {"price": 5}}})
    call("admin_update_pricing_bad_type", "admin", "product", "update", {"id": pid, "pricing": {"type": "bogus"}})
    call("admin_update_pricing_recurrent_empty", "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {}}})
    call("admin_update_pricing_bad_period", "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {"99Z": {"price": 1}}}})
    call("admin_update_pricing_once", "admin", "product", "update", {"id": pid, "pricing": {"type": "once", "once": {"price": 42, "setup": 7}}})
    call("admin_get_after_once", "admin", "product", "get", {"id": pid})
    call("admin_update_pricing_recurrent", "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {"1M": {"price": 15, "setup": 5, "enabled": 1}, "1Y": {"price": 150, "setup": 0, "enabled": 1}}}})
    call("admin_get_after_recurrent", "admin", "product", "get", {"id": pid})
    call("admin_update_pricing_recurrent_replace", "admin", "product", "update", {"id": pid, "pricing": {"type": "recurrent", "recurrent": {"1M": {"price": 20, "setup": 0, "enabled": 1}}}})
    call("admin_get_after_replace", "admin", "product", "get", {"id": pid})
    call("admin_update_fields", "admin", "product", "update",
         {"id": pid, "title": "Par20 Widget Renamed", "description": "cap20 desc", "status": "enabled",
          "hidden": 1, "stock_control": 1, "quantity_in_stock": 3, "setup": "after_order",
          "slug": "par20-renamed", "upgrades": [2, 3], "addons": [], "config": {"foo": "bar"}})
    call("admin_get_after_fields", "admin", "product", "get", {"id": pid})
    call("admin_update_config", "admin", "product", "update_config",
         {"id": pid, "config": {"foo": "", "baz": "qux"}, "new_config_name": "extra", "new_config_value": "val"})
    call("admin_get_after_config", "admin", "product", "get", {"id": pid})

    # --- priority (swap 2 products, restore) ---
    p2 = d.execute("SELECT priority FROM product WHERE id = 2").fetchone()[0]
    p3 = d.execute("SELECT priority FROM product WHERE id = 3").fetchone()[0]
    call("admin_update_priority_missing", "admin", "product", "update_priority", {})
    call("admin_update_priority_ok", "admin", "product", "update_priority", {"priority": {2: p3, 3: p2}})
    call("admin_get_after_priority", "admin", "product", "get", {"id": 2})
    call("admin_update_priority_restore", "admin", "product", "update_priority", {"priority": {2: p2, 3: p3}})

    # --- addons ---
    call("admin_addon_create_missing", "admin", "product", "addon_create", {})
    r = call("admin_addon_create_ok", "admin", "product", "addon_create",
             {"title": "Par20 Addon", "description": "addon desc", "status": "enabled", "setup": "after_payment"})
    aid = r["result"]
    call("admin_addon_get", "admin", "product", "addon_get", {"id": aid})
    call("admin_addon_get_not_addon", "admin", "product", "addon_get", {"id": pid})
    call("admin_addon_get_missing", "admin", "product", "addon_get", {"id": 99999})
    call("admin_addon_update", "admin", "product", "addon_update", {"id": aid, "title": "Par20 Addon Renamed"})
    call("admin_addon_get_pairs", "admin", "product", "addon_get_pairs")
    call("admin_addon_delete", "admin", "product", "addon_delete", {"id": aid})

    # --- delete guards ---
    call("admin_delete_missing_id", "admin", "product", "delete", {})
    call("admin_delete_missing_product", "admin", "product", "delete", {"id": 99999})
    call("admin_delete_blocked_orders", "admin", "product", "delete", {"id": 3})
    call("admin_delete_ok", "admin", "product", "delete", {"id": pid})
    call("admin_get_after_delete", "admin", "product", "get", {"id": pid})

    # --- categories ---
    call("admin_category_create_missing", "admin", "product", "category_create", {})
    r = call("admin_category_create_ok", "admin", "product", "category_create",
             {"title": "Par20 Category", "description": "cat desc", "priority": 5})
    cat = r["result"]
    call("admin_category_get", "admin", "product", "category_get", {"id": cat})
    call("admin_category_get_missing", "admin", "product", "category_get", {"id": 99999})
    call("admin_category_update", "admin", "product", "category_update", {"id": cat, "title": "Par20 Category Renamed"})
    call("admin_category_update_icon_too_long", "admin", "product", "category_update", {"id": cat, "icon_url": "x" * 256})
    call("admin_category_get_list", "admin", "product", "category_get_list", {})
    call("admin_category_get_list_search", "admin", "product", "category_get_list", {"search": "Par20"})
    call("admin_category_get_pairs", "admin", "product", "category_get_pairs")
    call("admin_category_update_priority_bad", "admin", "product", "category_update_priority", {"priority": {cat: "abc"}})
    call("admin_category_update_priority_ok", "admin", "product", "category_update_priority", {"priority": {cat: 7}})
    call("admin_category_get_after_priority", "admin", "product", "category_get", {"id": cat})
    # blocked delete: put a product in the category first
    r = call("admin_prepare_in_category", "admin", "product", "prepare",
             {"title": "Par20 InCat", "type": "custom", "product_category_id": cat})
    catpid = r["result"]
    call("admin_category_delete_blocked", "admin", "product", "category_delete", {"id": cat})
    call("admin_delete_incat", "admin", "product", "delete", {"id": catpid})
    call("admin_category_delete_ok", "admin", "product", "category_delete", {"id": cat})
    call("admin_category_delete_missing", "admin", "product", "category_delete", {"id": 99999})

    # --- promos ---
    call("admin_promo_create_missing", "admin", "product", "promo_create", {"type": "percentage", "value": 10})
    r = call("admin_promo_create_ok", "admin", "product", "promo_create",
             {"code": "PAR20SAVE", "type": "percentage", "value": 10, "products": [2, 3], "periods": ["1M"],
              "active": 1, "maxuses": 100, "description": "cap20 promo"})
    prom = r["result"]
    call("admin_promo_create_dup", "admin", "product", "promo_create", {"code": "PAR20SAVE", "type": "percentage", "value": 5})
    call("admin_promo_get", "admin", "product", "promo_get", {"id": prom})
    call("admin_promo_get_missing", "admin", "product", "promo_get", {"id": 99999})
    call("admin_promo_get_list", "admin", "product", "promo_get_list", {})
    call("admin_promo_get_list_search", "admin", "product", "promo_get_list", {"search": "PAR20"})
    call("admin_promo_get_list_status_active", "admin", "product", "promo_get_list", {"status": "active"})
    call("admin_promo_update", "admin", "product", "promo_update",
         {"id": prom, "value": 15, "maxuses": 50, "products": [2]})
    call("admin_promo_get_after_update", "admin", "product", "promo_get", {"id": prom})
    r = call("admin_promo_duplicate", "admin", "product", "promo_duplicate", {"id": prom})
    dup = r["result"]
    call("admin_promo_get_dup", "admin", "product", "promo_get", {"id": dup})
    call("admin_promo_redemption_get_list", "admin", "product", "promo_redemption_get_list", {"promo_id": prom})
    call("admin_promo_redemption_missing_id", "admin", "product", "promo_redemption_get_list", {})
    call("admin_promo_update_dup_code", "admin", "product", "promo_update", {"id": dup, "code": "PAR20SAVE"})
    call("admin_promo_delete_dup", "admin", "product", "promo_delete", {"id": dup})
    call("admin_promo_delete_ok", "admin", "product", "promo_delete", {"id": prom})
    call("admin_promo_delete_missing", "admin", "product", "promo_delete", {"id": 99999})

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
