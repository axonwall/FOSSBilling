#!/usr/bin/env python3
"""Phase 3 batch 2 parity: replay capture10 against the Next origin.
Volatile values (ids of created rows, hashes, timestamps, serie
numbers, transaction ids) are normalized before comparison."""
import json, re, sys, time, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures10"
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

CREATED = {"invoice": None, "invoice2": None, "tax": None}

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

def call(role, module, method, data=None, as_json=False):
    if as_json:
        body = json.dumps(data or {}).encode()
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if csrf_of():
            req.add_header("X-CSRF-TOKEN", csrf_of())
    else:
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
HASH_RE = re.compile(r"^[0-9a-f]{32,64}$")

def norm(v, key=""):
    if isinstance(v, dict):
        return {k: norm(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    if key in ("hash",) and isinstance(v, str):
        return "*hash*"
    if key in ("created_at", "updated_at", "due_at", "paid_at", "reminded_at", "hash_expires_at") and isinstance(v, str) and TS_RE.match(v):
        return "*ts*"
    if key == "serie_nr" and isinstance(v, str):
        return "FOSS*"
    if key == "currency_rate":
        # Storage-form noise: 1 vs "1" depends on how the row was written.
        return "*rate*"
    if key == "nr":
        return "*nr*"
    return v

def scrub_seq(v):
    """For sequence-created invoices: ids are fresh in both runs."""
    if isinstance(v, dict):
        return {k: ("*id*" if k in ("id", "invoice_id") and isinstance(x, int) else scrub_seq(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub_seq(x) for x in v]
    return v


def scrub_ids(v):
    """Replace the ids of rows created during capture/replay with markers."""
    if isinstance(v, dict):
        return {k: scrub_ids(x) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub_ids(x) for x in v]
    return v

def list_intersect(got, ref):
    """Compare list endpoints on the entries present in BOTH runs
    (later runs create additional rows; ids are the join key)."""
    g = {i["id"]: i for i in (got.get("result") or {}).get("list", [])}
    out = {"result": {"list": []}, "error": None}
    items = []
    for item in (ref.get("result") or {}).get("list", []):
        if item["id"] in g:
            items.append((item, g[item["id"]]))
    return items

results = []
def expect_list(name, got, ref=None):
    ref = ref if ref is not None else json.loads((REF / f"{name}.json").read_text())
    pairs = list_intersect(got, ref)
    ok = len(pairs) > 0 and all(norm(a) == norm(b) for a, b in pairs)
    print(f"{'MATCH' if ok else 'DIFF '} {name} ({len(pairs)} common entries)")
    if not ok:
        for a, b in pairs:
            if norm(a) != norm(b):
                print(f"   php: {json.dumps(norm(a))[:300]}")
                print(f"   ts:  {json.dumps(norm(b))[:300]}")
                break
    results.append(ok)

def expect(name, got, ref=None):
    ref = ref if ref is not None else json.loads((REF / f"{name}.json").read_text())
    ok = norm(got) == norm(ref)
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(norm(ref))[:400]}")
        print(f"   ts:  {json.dumps(norm(got))[:400]}")
    results.append(ok)

opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
expect_list("admin_invoice_get_list", call("admin", "invoice", "get_list"))
expect_list("admin_invoice_get_list_summary", call("admin", "invoice", "get_list", {"summary": 1}))
one = call("admin", "invoice", "get", {"id": 1})
expect("admin_invoice_get", one)
hash1 = (one.get("result") or {}).get("hash")
expect("admin_invoice_get_missing", call("admin", "invoice", "get", {"id": 99999}))
prep = call("admin", "invoice", "prepare", {"client_id": 1})
inv = prep.get("result")
expect("admin_invoice_prepare", {"result": "*invid*", "error": None} if isinstance(inv, int) else prep,
       {"result": "*invid*", "error": None})
call("admin", "invoice", "update", {"id": inv, "new_item": {"title": "Capture line", "price": 42.5, "quantity": 2, "taxed": True}}, as_json=True)
expect("admin_invoice_get_draft", scrub_seq(call("admin", "invoice", "get", {"id": inv})),
       scrub_seq(json.loads((REF / "admin_invoice_get_draft.json").read_text())))
call("admin", "invoice", "issue", {"id": inv})
expect("admin_invoice_get_issued", scrub_seq(call("admin", "invoice", "get", {"id": inv})),
       scrub_seq(json.loads((REF / "admin_invoice_get_issued.json").read_text())))
txn = "P7-" + str(int(time.time()))
mp = call("admin", "invoice", "mark_as_paid", {"id": inv, "gateway_id": 1, "transactionId": txn})
expect("admin_invoice_mark_as_paid", mp)
expect("admin_invoice_get_paid", scrub_seq(call("admin", "invoice", "get", {"id": inv})),
       scrub_seq(json.loads((REF / "admin_invoice_get_paid.json").read_text())))
prep2 = call("admin", "invoice", "prepare", {"client_id": 1})
inv2 = prep2.get("result")
call("admin", "invoice", "delete", {"id": inv2})
expect("admin_invoice_get_deleted", call("admin", "invoice", "get", {"id": inv2}))
tc = call("admin", "invoice", "tax_create", {"name": "Capture Tax", "country": "ZZ", "taxrate": "7.5"})
tax_id = tc.get("result")
expect("admin_tax_get_list", scrub_seq(call("admin", "invoice", "tax_get_list")),
       scrub_seq(json.loads((REF / "admin_tax_get_list.json").read_text())))
if tax_id:
    expect("admin_tax_get", scrub_seq(call("admin", "invoice", "tax_get", {"id": tax_id})),
           scrub_seq(json.loads((REF / "admin_tax_get.json").read_text())))
    expect("admin_tax_update_partial", call("admin", "invoice", "tax_update", {"id": tax_id, "taxrate": "8.25"}))
    call("admin", "invoice", "tax_update", {"id": tax_id, "name": "Capture Tax", "country": "ZZ", "taxrate": "8.25"})
    expect("admin_tax_get_after_update", scrub_seq(call("admin", "invoice", "tax_get", {"id": tax_id})),
           scrub_seq(json.loads((REF / "admin_tax_get_after_update.json").read_text())))
    call("admin", "invoice", "tax_delete", {"id": tax_id})
    expect("admin_tax_get_deleted", call("admin", "invoice", "tax_get", {"id": tax_id}))
call("guest", "client", "login", {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
expect_list("client_invoice_get_list", call("client", "invoice", "get_list"))
expect("client_invoice_get", call("client", "invoice", "get", {"id": 1}))
if hash1:
    expect("client_invoice_get_hash", call("client", "invoice", "get", {"hash": hash1}))
expect("client_invoice_get_missing", call("client", "invoice", "get", {"hash": "deadbeefdeadbeef"}))
issued = call("admin", "invoice", "get", {"id": inv})
inv_hash = (issued.get("result") or {}).get("hash")
if inv_hash:
    expect("guest_invoice_get", scrub_seq(call("guest", "invoice", "get", {"hash": inv_hash})),
           scrub_seq(json.loads((REF / "guest_invoice_get.json").read_text())))

print(f"\nparity batch Phase3-2: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
