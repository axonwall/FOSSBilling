#!/usr/bin/env python3
"""Phase 3 batch 3 parity: replay capture11 against the Next origin."""
import json, re, sys, time, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures11"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def csrf_of():
    for c in cj:
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
    if csrf_of():
        payload["CSRFToken"] = csrf_of()
    req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with opener.open(req, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

def norm(v, key=""):
    if isinstance(v, dict):
        return {k: norm(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    if key in ("created_at", "updated_at", "activated_at", "suspended_at", "unsuspended_at", "canceled_at", "expires_at") and isinstance(v, str) and TS_RE.match(v):
        return "*ts*"
    if key == "group_id":
        return "*group*"
    return v


def scrub(v):
    if isinstance(v, dict):
        v = {k: x for k, x in v.items()}
        if "service_id" in v and isinstance(v["service_id"], int):
            v["service_id"] = "*svc*"
        return {k: ("*id*" if k in ("id",) and isinstance(x, int) else scrub(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v

def scrub_old(v):
    if isinstance(v, dict):
        return {k: ("*id*" if k in ("id",) and isinstance(x, int) else scrub(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


results = []
def expect(name, got, ref=None, scrub_ids=False):
    ref = ref if ref is not None else json.loads((REF / f"{name}.json").read_text())
    g, r = (scrub(norm(got)), scrub(norm(ref))) if scrub_ids else (norm(got), norm(ref))
    ok = g == r
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(r)[:350]}")
        print(f"   ts:  {json.dumps(g)[:350]}")
    results.append(ok)


def expect_list(name, got):
    ref = json.loads((REF / f"{name}.json").read_text())
    g = {i["id"]: i for i in (got.get("result") or {}).get("list", [])}
    pairs = [(i, g[i["id"]]) for i in (ref.get("result") or {}).get("list", []) if i["id"] in g]
    ok = len(pairs) > 0 and all(norm(a) == norm(b) for a, b in pairs)
    print(f"{'MATCH' if ok else 'DIFF '} {name} ({len(pairs)} common entries)")
    if not ok:
        for a, b in pairs:
            if norm(a) != norm(b):
                print(f"   php: {json.dumps(norm(a))[:300]}")
                print(f"   ts:  {json.dumps(norm(b))[:300]}")
                break
    results.append(ok)


opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
expect_list("admin_order_get_list", call("admin", "order", "get_list"))
expect("admin_order_get", call("admin", "order", "get", {"id": 3}))
expect("admin_order_get_missing", call("admin", "order", "get", {"id": 99999}))
expect("admin_order_get_statuses", call("admin", "order", "get_statuses"))
hist = call("admin", "order", "status_history_get_list", {"id": 3})
expect_list("admin_order_status_history", hist)
created = call("admin", "order", "create", {"client_id": 1, "product_id": 3, "invoice_option": "no-invoice", "quantity": 1})
oid = created.get("result")
if isinstance(oid, int):
    expect("admin_order_get_created", call("admin", "order", "get", {"id": oid}),
           json.loads((REF / "admin_order_get_created.json").read_text()), scrub_ids=True)
    call("admin", "order", "update", {"id": oid, "notes": "capture note"})
    expect("admin_order_activate", call("admin", "order", "activate", {"id": oid}))
    expect("admin_order_get_active", call("admin", "order", "get", {"id": oid}),
           json.loads((REF / "admin_order_get_active.json").read_text()), scrub_ids=True)
    expect("admin_order_suspend", call("admin", "order", "suspend", {"id": oid, "reason": "capture"}))
    expect("admin_order_get_suspended", call("admin", "order", "get", {"id": oid}),
           json.loads((REF / "admin_order_get_suspended.json").read_text()), scrub_ids=True)
    expect("admin_order_unsuspend", call("admin", "order", "unsuspend", {"id": oid}))
    expect("admin_order_cancel", call("admin", "order", "cancel", {"id": oid}))
    expect("admin_order_uncancel", call("admin", "order", "uncancel", {"id": oid}))
    expect("admin_order_delete", call("admin", "order", "delete", {"id": oid}))
    expect("admin_order_get_deleted", call("admin", "order", "get", {"id": oid}))
txn_id = f"P8-{int(time.time())}"
tx = call("admin", "invoice", "transaction_create",
          {"invoice_id": 1, "gateway_id": 1, "amount": 5, "currency": "USD", "txn_id": txn_id, "status": "received"})
txid = tx.get("result")
ref_tx = json.loads((REF / "admin_transaction_get.json").read_text())
if isinstance(txid, int):
    got_tx = call("admin", "invoice", "transaction_get", {"id": txid})
    # txn_id + id differ by construction; amounts/status/ipn must agree
    got_tx["result"]["txn_id"] = ref_tx["result"]["txn_id"]
    expect("admin_transaction_get", got_tx, ref_tx, scrub_ids=True)
    call("admin", "invoice", "transaction_update", {"id": txid, "status": "approved", "amount": 6.5})
    got_tx2 = call("admin", "invoice", "transaction_get", {"id": txid})
    got_tx2["result"]["txn_id"] = ref_tx["result"]["txn_id"]
    ref_tx2 = json.loads((REF / "admin_transaction_get_after_update.json").read_text())
    ref_tx2["result"]["txn_id"] = ref_tx["result"]["txn_id"]
    expect("admin_transaction_get_after_update", got_tx2, ref_tx2, scrub_ids=True)
    expect("admin_transaction_delete", call("admin", "invoice", "transaction_delete", {"id": txid}))
    expect("admin_transaction_get_deleted", call("admin", "invoice", "transaction_get", {"id": txid}))
expect_list("admin_transaction_get_list", call("admin", "invoice", "transaction_get_list"))
sub = call("admin", "invoice", "subscription_create",
           {"client_id": 1, "gateway_id": 1, "currency": "USD", "sid": "sub-cap11",
            "status": "active", "period": "1M", "amount": 15})
sid = sub.get("result")
if isinstance(sid, int):
    expect("admin_subscription_get", call("admin", "invoice", "subscription_get", {"id": sid}),
           json.loads((REF / "admin_subscription_get.json").read_text()), scrub_ids=True)
    call("admin", "invoice", "subscription_update", {"id": sid, "amount": 20})
    expect("admin_subscription_get_after_update", call("admin", "invoice", "subscription_get", {"id": sid}),
           json.loads((REF / "admin_subscription_get_after_update.json").read_text()), scrub_ids=True)
    expect("admin_subscription_delete", call("admin", "invoice", "subscription_delete", {"id": sid}))
    expect("admin_subscription_get_deleted", call("admin", "invoice", "subscription_get", {"id": sid}))
call("guest", "client", "login", {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
expect_list("client_order_get_list", call("client", "order", "get_list"))
expect("client_order_get", call("client", "order", "get", {"id": 3}))
expect("client_order_get_missing", call("client", "order", "get", {"id": 99999}))

print(f"\nparity batch Phase3-3: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
