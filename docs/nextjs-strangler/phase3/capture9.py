#!/usr/bin/env python3
"""Phase 3 batch 1 capture corpus: Product reads + Cart flows (PHP oracle).
Writes captures9/*.json; parity6.py replays the same calls via Next."""
import json, pathlib, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures9"
OUT.mkdir(exist_ok=True)
manifest = []
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


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
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "route": f"/api/{role}/{module}/{method}", "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def main():
    opener.open(f"{BASE}/login", timeout=20).read()
    call("guest_product_get_list", "guest", "product", "get_list")
    call("guest_product_get_pairs", "guest", "product", "get_pairs")
    call("guest_product_get_once", "guest", "product", "get", {"id": 3})
    call("guest_product_get_recurring", "guest", "product", "get", {"id": 9})
    call("guest_product_get_missing", "guest", "product", "get", {"id": 9999})
    call("guest_product_category_get_list", "guest", "product", "category_get_list")
    call("guest_product_category_get_pairs", "guest", "product", "category_get_pairs")
    call("guest_cart_reset", "guest", "cart", "reset")
    call("guest_cart_get_empty", "guest", "cart", "get")
    call("guest_cart_add_once", "guest", "cart", "add_item", {"id": 3})
    call("guest_cart_get_once", "guest", "cart", "get")
    call("guest_cart_add_recurring", "guest", "cart", "add_item", {"id": 9, "period": "1M"})
    call("guest_cart_get_two_items", "guest", "cart", "get")
    items = (call("guest_cart_get_probe", "guest", "cart", "get")["result"] or {}).get("items") or []
    if items:
        call("guest_cart_remove_item", "guest", "cart", "remove_item", {"id": items[0]["id"]})
    call("guest_cart_get_after_remove", "guest", "cart", "get")
    call("guest_cart_get_currency", "guest", "cart", "get_currency")
    call("guest_cart_apply_promo_missing", "guest", "cart", "apply_promo", {"promocode": "NOPE"})
    call("guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    call("admin_product_get_list", "admin", "product", "get_list")
    call("admin_product_get", "admin", "product", "get", {"id": 9})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
