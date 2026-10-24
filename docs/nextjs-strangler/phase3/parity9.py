#!/usr/bin/env python3
"""Phase 3 batch 4 parity: replay capture12 sequences against Next."""
import json, re, sys, time, urllib.request, urllib.parse, http.cookiejar, pathlib

NEXT = "http://127.0.0.1:3001"
REF = pathlib.Path(__file__).parent / "captures12"
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


def call(role, module, method, data=None, as_json=False):
    if as_json:
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST")
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

def norm(v, key=""):
    if isinstance(v, dict):
        return {k: norm(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    if isinstance(v, str) and TS_RE.match(v):
        return "*ts*"
    if key in ("hash",) and isinstance(v, str):
        return "*hash*"
    if key in ("nr", "currency_rate"):
        return "*seq*"
    if key == "notes" and isinstance(v, str) and v[:4].isdigit():
        return "*note*"
    if key == "serie_nr" and isinstance(v, str):
        return "*serie_nr*"
    return v


def scrub_ids(v):
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in ("id", "credit_note_for_invoice_id", "debit_note_for_invoice_id",
                     "replaces_invoice_id", "replaced_by_invoice_id") and isinstance(x, int):
                out[k] = "*id*"
            elif k in ("refunded_by_invoice_ids", "debited_by_invoice_ids") and isinstance(x, list):
                out[k] = ["*id*"] * len(x)
            else:
                out[k] = scrub_ids(x)
        return out
    if isinstance(v, list):
        return [scrub_ids(x) for x in v]
    return v


results = []
def expect(name, got, ref_name=None, scrub=False):
    ref = json.loads((REF / f"{ref_name or name}.json").read_text())
    g, r = norm(got), norm(ref)
    if scrub:
        g, r = scrub_ids(g), scrub_ids(r)
    ok = g == r
    print(f"{'MATCH' if ok else 'DIFF '} {name}")
    if not ok:
        print(f"   php: {json.dumps(r)[:330]}")
        print(f"   ts:  {json.dumps(g)[:330]}")
    results.append(ok)


def paid_invoice(price=30):
    iid = call("admin", "invoice", "prepare", {"client_id": 1})["result"]
    call("admin", "invoice", "update",
         {"id": iid, "new_item": {"title": "Batch4 line", "price": price, "quantity": 1, "taxed": True}}, as_json=True)
    call("admin", "invoice", "issue", {"id": iid})
    call("admin", "invoice", "mark_as_paid",
         {"id": iid, "gateway_id": 1, "transactionId": f"P9-{int(time.time())}-{iid}"})
    return iid


def issued_invoice(price=25):
    iid = call("admin", "invoice", "prepare", {"client_id": 1})["result"]
    call("admin", "invoice", "update",
         {"id": iid, "new_item": {"title": "Batch4 line", "price": price, "quantity": 1, "taxed": True}}, as_json=True)
    call("admin", "invoice", "issue", {"id": iid})
    return iid


opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
inv1 = paid_invoice(30)
refund = call("admin", "invoice", "refund", {"id": inv1})
note_id = refund.get("result")
expect("admin_invoice_get_after_refund", call("admin", "invoice", "get", {"id": inv1}),
       scrub=True)
if isinstance(note_id, int):
    expect("admin_invoice_get_credit_note", call("admin", "invoice", "get", {"id": note_id}),
           scrub=True)
inv2 = paid_invoice(30)
debit = call("admin", "invoice", "debit",
             {"id": inv2, "items": [{"title": "Extra charge", "price": 7.5, "quantity": 2, "taxed": False}]},
             as_json=True)
debit_id = debit.get("result")
expect("admin_invoice_get_after_debit", call("admin", "invoice", "get", {"id": inv2}), scrub=True)
if isinstance(debit_id, int):
    expect("admin_invoice_get_debit_note", call("admin", "invoice", "get", {"id": debit_id}), scrub=True)
inv3 = issued_invoice(25)
call("admin", "invoice", "cancel", {"id": inv3})
expect("admin_invoice_get_after_cancel", call("admin", "invoice", "get", {"id": inv3}), scrub=True)
inv4 = issued_invoice(25)
reissue = call("admin", "invoice", "reissue", {"id": inv4})
new_id = reissue.get("result")
expect("admin_invoice_get_after_reissue_old", call("admin", "invoice", "get", {"id": inv4}), scrub=True)
if isinstance(new_id, int):
    expect("admin_invoice_get_reissued_new", call("admin", "invoice", "get", {"id": new_id}), scrub=True)
expect("admin_invoice_journal", call("admin", "invoice", "journal", {"id": 1}))
renewal = call("admin", "invoice", "renewal_invoice", {"id": 3})
results.append(isinstance(renewal.get("result"), int))
print(("MATCH" if isinstance(renewal.get("result"), int) else "DIFF ") + " admin_invoice_renewal (returns new invoice id)")
expect("admin_invoice_batch_generate", call("admin", "invoice", "batch_generate"))
expect("admin_invoice_batch_activate_paid", call("admin", "invoice", "batch_activate_paid"))
expect("admin_invoice_batch_send_reminders", call("admin", "invoice", "batch_send_reminders"))
expect("admin_order_batch_suspend_expired", call("admin", "order", "batch_suspend_expired"))
expect("admin_order_batch_cancel_unpaid", call("admin", "order", "batch_cancel_unpaid"))
expect("admin_order_batch_cancel_suspended", call("admin", "order", "batch_cancel_suspended"))
info = call("admin", "cron", "info")
ok = isinstance(info.get("result"), dict) and info["result"].get("cron_path", "").endswith("cron.php")
print(("MATCH" if ok else "DIFF ") + " admin_cron_info (shape)")
results.append(ok)

print(f"\nparity batch Phase3-4: {sum(results)}/{len(results)} match")
sys.exit(0 if all(results) else 1)
