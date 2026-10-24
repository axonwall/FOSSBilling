#!/usr/bin/env python3
"""Phase 3 batch 1 parity: replay capture9 against the Next origin
(product reads + guest cart flows). Cart sequences mutate only the
session's own cart and end reset. __cart_family values are random per
add — normalized before comparison."""
import json, sys, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures9"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def csrf_of(jar):
    for c in jar:
        if c.name == "fossbilling_csrf":
            return c.value

def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out

def call(role, module, method, data=None):
    payload = flatten(dict(data or {}))
    if csrf_of(cj):
        payload["CSRFToken"] = csrf_of(cj)
    req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def norm(v, in_items=False):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k == "__cart_family":
                out[k] = "*"
            elif k == "items" and isinstance(x, list):
                out[k] = [norm(i, in_items=True) for i in x]
            elif k == "id" and in_items:
                # cart_product ids are global autoincrements; they differ
                # between the capture session and any replay session.
                out[k] = "*cpid*"
            else:
                out[k] = norm(x, in_items)
        return out
    if isinstance(v, list):
        return [norm(x, in_items) for x in v]
    return v

results = []
def expect(name, got):
    ref = json.loads((REF / f"{name}.json").read_text())
    ok = norm(got) == norm(ref)
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(norm(ref))[:300]}")
        print(f"   ts:  {json.dumps(norm(got))[:300]}")
    results.append(ok)

opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
expect("guest_product_get_list", call("guest", "product", "get_list"))
expect("guest_product_get_pairs", call("guest", "product", "get_pairs"))
expect("guest_product_get_once", call("guest", "product", "get", {"id": 3}))
expect("guest_product_get_recurring", call("guest", "product", "get", {"id": 9}))
expect("guest_product_get_missing", call("guest", "product", "get", {"id": 9999}))
expect("guest_product_category_get_list", call("guest", "product", "category_get_list"))
expect("guest_product_category_get_pairs", call("guest", "product", "category_get_pairs"))
call("guest", "cart", "reset")
expect("guest_cart_get_empty", call("guest", "cart", "get"))
call("guest", "cart", "add_item", {"id": 3})
expect("guest_cart_get_once", call("guest", "cart", "get"))
call("guest", "cart", "add_item", {"id": 9, "period": "1M", "multiple": 1})
expect("guest_cart_get_two_items", call("guest", "cart", "get"))
items = (call("guest", "cart", "get").get("result") or {}).get("items") or []
for it in items:
    call("guest", "cart", "remove_item", {"id": it["id"]})
expect("guest_cart_get_after_remove", call("guest", "cart", "get"))
expect("guest_cart_get_currency", call("guest", "cart", "get_currency"))
expect("guest_cart_apply_promo_missing", call("guest", "cart", "apply_promo", {"promocode": "NOPE"}))
call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
expect("admin_product_get_list", call("admin", "product", "get_list"))
expect("admin_product_get", call("admin", "product", "get", {"id": 9}))
call("guest", "cart", "reset")

print(f"\nparity batch Phase3-1: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
