#!/usr/bin/env python3
"""Phase 5 core-CRUD parity 4: Order admin/client leftovers through TS,
checked against captures22/.

Fresh orders get fresh ids (scrubbed); order 1's renew extension is
restored via SQL, like the capture.
"""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
CAP = pathlib.Path(__file__).parent / "captures22"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_PW = "Phase0-Client!42"
NOW = "2026-10-25 23:00:00"
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
                if isinstance(item, dict):
                    out.update(flatten(item, f"{key}[{i}]"))
                else:
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


def scrub(obj, subs=None):
    subs = subs or {}
    if isinstance(obj, dict):
        return {k: ("*ts*" if k in ("created_at", "updated_at")
                    else scrub(v, subs)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(x, subs) for x in obj]
    if isinstance(obj, (str, int)) and obj in subs:
        return subs[obj]
    return obj


def main():
    d = sqlite3.connect(DBP)

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

    def raw(op, cj, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                body = resp.read()
                return {"status": resp.status, "content_type": resp.headers.get("Content-Type"),
                        "length": len(body), "head": body[:8]}
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                return {"status": e.code, "body": json.loads(body.decode())}
            except Exception:
                return {"status": e.code, "length": len(body)}

    def oracle(name):
        return json.load(open(CAP / f"{name}.json"))

    def err(r):
        return (r.get("error") or {}).get("message") if isinstance(r, dict) else None

    def expect_err(name, r, capname):
        want = oracle(capname)
        report(name, err(r) == err(want), f"got {err(r)!r} want {err(want)!r}")

    def expect_val(name, r, capname, subs=None):
        want = oracle(capname)["result"]
        report(name, scrub(r.get("result"), subs) == scrub(want, subs),
               f"got {str(scrub(r.get('result'), subs))[:300]} want {str(scrub(want, subs))[:300]}")

    def expect_bool(name, r, capname):
        want = oracle(capname)["result"]
        report(name, r.get("result") == want and r.get("error") is None,
               f"got {r.get('result')!r} want {want!r}")

    op_a, cj_a = make_opener()
    op_a.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_a, cj_a, "guest", "staff", "login", {"email": "admin@phase0.local", "password": ADMIN_PW})
    assert r.get("error") is None, r
    op_c, cj_c = make_opener()
    op_c.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(op_c, cj_c, "guest", "client", "login", {"email": "phase0.client@example.com", "password": CLIENT_PW})
    assert r.get("error") is None, r

    expect_val("admin_get_invoice_options", call(op_a, cj_a, "admin", "order", "get_invoice_options"),
               "admin_get_invoice_options")
    expect_err("admin_service_missing", call(op_a, cj_a, "admin", "order", "service", {}), "admin_service_missing")
    expect_err("admin_service_notfound", call(op_a, cj_a, "admin", "order", "service", {"id": 99999}), "admin_service_notfound")
    expect_val("admin_service_order1", call(op_a, cj_a, "admin", "order", "service", {"id": 1}), "admin_service_order1")
    null_service_order = d.execute("SELECT id FROM client_order WHERE service_id IS NULL AND client_id = 1 LIMIT 1").fetchone()[0]
    r = call(op_a, cj_a, "admin", "order", "service", {"id": null_service_order})
    report("admin_service_null", r.get("result") is None and r.get("error") is None, f"got {r}")
    expect_val("admin_addons_order1_empty", call(op_a, cj_a, "admin", "order", "addons", {"id": 1}),
               "admin_addons_order1_empty")
    expect_err("admin_addons_missing", call(op_a, cj_a, "admin", "order", "addons", {}), "admin_addons_missing")
    expect_err("admin_addons_notfound", call(op_a, cj_a, "admin", "order", "addons", {"id": 99999}), "admin_addons_notfound")
    expect_val("admin_can_cancel_order1", call(op_a, cj_a, "admin", "order", "can_cancel_at_period_end", {"id": 1}),
               "admin_can_cancel_order1")
    expect_err("admin_can_cancel_missing", call(op_a, cj_a, "admin", "order", "can_cancel_at_period_end", {}),
               "admin_can_cancel_missing")
    expect_err("admin_can_cancel_notfound", call(op_a, cj_a, "admin", "order", "can_cancel_at_period_end", {"id": 99999}),
               "admin_can_cancel_notfound")
    expect_err("admin_renew_missing", call(op_a, cj_a, "admin", "order", "renew", {}), "admin_renew_missing")
    expect_err("admin_renew_notfound", call(op_a, cj_a, "admin", "order", "renew", {"id": 99999}), "admin_renew_notfound")
    expect_err("admin_update_config_missing", call(op_a, cj_a, "admin", "order", "update_config", {}),
               "admin_update_config_missing")
    expect_err("admin_update_config_notfound",
               call(op_a, cj_a, "admin", "order", "update_config", {"id": 99999, "config": {"x": 1}}),
               "admin_update_config_notfound")
    expect_err("admin_update_config_no_config", call(op_a, cj_a, "admin", "order", "update_config", {"id": 1}),
               "admin_update_config_no_config")
    expect_err("admin_update_config_scalar",
               call(op_a, cj_a, "admin", "order", "update_config", {"id": 1, "config": "hello"}),
               "admin_update_config_scalar")
    expect_err("admin_batch_delete_missing", call(op_a, cj_a, "admin", "order", "batch_delete", {}),
               "admin_batch_delete_missing")

    expect_err("client_addons_missing", call(op_c, cj_c, "client", "order", "addons", {}), "client_addons_missing")
    expect_err("client_addons_notfound", call(op_c, cj_c, "client", "order", "addons", {"id": 99999}),
               "client_addons_notfound")
    expect_val("client_addons_order1_empty", call(op_c, cj_c, "client", "order", "addons", {"id": 1}),
               "client_addons_order1_empty")
    expect_err("client_service_notactive", call(op_c, cj_c, "client", "order", "service", {"id": null_service_order}),
               "client_service_notactive")
    expect_val("client_service_order1", call(op_c, cj_c, "client", "order", "service", {"id": 1}),
               "client_service_order1")
    expect_err("client_service_missing", call(op_c, cj_c, "client", "order", "service", {}), "client_service_missing")
    expect_err("client_service_notfound", call(op_c, cj_c, "client", "order", "service", {"id": 99999}),
               "client_service_notfound")
    expect_val("client_upgradables_order1", call(op_c, cj_c, "client", "order", "upgradables", {"id": 1}),
               "client_upgradables_order1")
    expect_err("client_upgradables_missing", call(op_c, cj_c, "client", "order", "upgradables", {}),
               "client_upgradables_missing")
    expect_err("client_delete_active", call(op_c, cj_c, "client", "order", "delete", {"id": 1}), "client_delete_active")
    expect_err("client_delete_missing", call(op_c, cj_c, "client", "order", "delete", {}), "client_delete_missing")
    expect_err("client_delete_notfound", call(op_c, cj_c, "client", "order", "delete", {"id": 99999}),
               "client_delete_notfound")

    # fabricated addon in order 1's group
    group1 = d.execute("SELECT group_id FROM client_order WHERE id = 1").fetchone()[0]
    d.execute("INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at) VALUES (1, 6, NULL, NULL, NULL, NULL, ?, 0, 'no-invoice', 'Cap22 addon', 'USD', NULL, NULL, 'custom', '1M', 1, 'product', 10, 0, 'active', NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)", (group1, NOW, NOW))
    d.commit()
    addon_id = d.execute("SELECT id FROM client_order WHERE title = 'Cap22 addon'").fetchone()[0]
    print("addon id:", addon_id)
    r = call(op_a, cj_a, "admin", "order", "addons", {"id": 1})
    want = oracle("admin_addons_order1_one")["result"]
    want[0]["id"] = addon_id
    report("admin_addons_order1_one", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    r = call(op_c, cj_c, "client", "order", "addons", {"id": 1})
    want = oracle("client_addons_order1_one")["result"] if (CAP / "client_addons_order1_one.json").exists() else oracle("admin_addons_order1_one")["result"]
    want[0]["id"] = addon_id
    report("client_addons_order1_one", scrub(r.get("result")) == scrub(want),
           f"got {str(scrub(r.get('result')))[:300]} want {str(scrub(want))[:300]}")
    d.execute("DELETE FROM client_order WHERE id = ?", (addon_id,))
    d.commit()

    # update_config replacement on a fresh order
    r = call(op_a, cj_a, "admin", "order", "create", {"client_id": 1, "product_id": 6, "period": "1M"})
    cfg_order = r["result"]
    report("admin_create_config_order", isinstance(cfg_order, int), f"got {cfg_order!r}")
    expect_bool("admin_update_config_ok",
                call(op_a, cj_a, "admin", "order", "update_config", {"id": cfg_order, "config": {"custom": "yes"}}),
                "admin_update_config_ok")
    r = call(op_a, cj_a, "admin", "order", "get", {"id": cfg_order})
    want = oracle("admin_get_config_order")["result"]
    subs = {want["id"]: cfg_order, want["group_id"]: r["result"]["group_id"]}
    report("admin_get_config_order", scrub(r.get("result"), subs) == scrub(want, subs),
           f"got {str(scrub(r.get('result'), subs))[:300]} want {str(scrub(want, subs))[:300]}")
    expect_bool("admin_delete_config_order",
                call(op_a, cj_a, "admin", "order", "delete", {"id": cfg_order}),
                "admin_delete_config_order")

    # client delete on a fresh pending order
    r = call(op_a, cj_a, "admin", "order", "create", {"client_id": 1, "product_id": 6, "period": "1M"})
    del_order = r["result"]
    expect_bool("client_delete_ok", call(op_c, cj_c, "client", "order", "delete", {"id": del_order}), "client_delete_ok")
    expect_err("client_get_deleted_gone", call(op_c, cj_c, "client", "order", "get", {"id": del_order}),
               "client_get_deleted_gone")

    # renew pending (activate path)
    r = call(op_a, cj_a, "admin", "order", "create", {"client_id": 1, "product_id": 6, "period": "1M"})
    pend_order = r["result"]
    expect_bool("admin_renew_pending", call(op_a, cj_a, "admin", "order", "renew", {"id": pend_order}),
                "admin_renew_pending")
    r = call(op_a, cj_a, "admin", "order", "get", {"id": pend_order})
    want = oracle("admin_get_renewed_pending")["result"]
    subs = {want["id"]: pend_order, want["group_id"]: r["result"]["group_id"],
            want["service_id"]: r["result"]["service_id"]}
    # activated/expires timestamps are run-time dependent; compare shape + status + service presence
    got = dict(r["result"])
    report("admin_get_renewed_pending",
           got["status"] == "active" and got["service_id"] is not None
           and got["activated_at"] is not None and got["expires_at"] is not None
           and scrub(got, subs)["title"] == scrub(want, subs)["title"],
           f"got status={got['status']} service={got['service_id']} activated={got['activated_at']} expires={got['expires_at']}")
    svc = d.execute("SELECT service_id FROM client_order WHERE id = ?", (pend_order,)).fetchone()[0]
    expect_bool("admin_delete_renewed_pending",
                call(op_a, cj_a, "admin", "order", "delete", {"id": pend_order}),
                "admin_delete_renewed_pending")
    row = d.execute("SELECT COUNT(*) FROM service_custom WHERE id = ?", (svc,)).fetchone()[0]
    report("service_row_after_delete", row == 0, f"got {row}")

    # renew active order 1 (extend path; SQL restore after)
    exp_before = d.execute("SELECT expires_at FROM client_order WHERE id = 1").fetchone()[0]
    max_status_before = d.execute("SELECT COALESCE(MAX(id), 0) FROM client_order_status WHERE client_order_id = 1").fetchone()[0]
    expect_bool("admin_renew_active", call(op_a, cj_a, "admin", "order", "renew", {"id": 1}), "admin_renew_active")
    r = call(op_a, cj_a, "admin", "order", "get", {"id": 1})
    want = oracle("admin_get_renewed_active")["result"]
    report("admin_get_renewed_active",
           r["result"]["expires_at"] == "2026-12-23 20:40:16" and r["result"]["status"] == "active"
           and r["result"]["suspended_at"] is None and r["result"]["canceled_at"] is None,
           f"got expires={r['result']['expires_at']} status={r['result']['status']}")
    d.execute("UPDATE client_order SET expires_at = ? WHERE id = 1", (exp_before,))
    d.execute("DELETE FROM client_order_status WHERE client_order_id = 1 AND id > ? AND notes = 'Order renewed'", (max_status_before,))
    d.commit()
    print("order1 restored:", d.execute("SELECT expires_at FROM client_order WHERE id = 1").fetchone()[0] == exp_before)

    # batch delete
    masters = []
    for i in (1, 2):
        r = call(op_a, cj_a, "admin", "order", "create", {"client_id": 1, "product_id": 6, "period": "1M"})
        masters.append(r["result"])
    expect_bool("admin_batch_delete_ok",
                call(op_a, cj_a, "admin", "order", "batch_delete", {"ids": masters}),
                "admin_batch_delete_ok")
    for i, mid in enumerate(masters, 1):
        expect_err(f"admin_get_batch{i}_gone", call(op_a, cj_a, "admin", "order", "get", {"id": mid}),
                   f"admin_get_batch{i}_gone")
    r = call(op_a, cj_a, "admin", "order", "create", {"client_id": 1, "product_id": 6, "period": "1M"})
    master = r["result"]
    mgroup = d.execute("SELECT group_id FROM client_order WHERE id = ?", (master,)).fetchone()[0]
    d.execute("INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at) VALUES (1, 6, NULL, NULL, NULL, NULL, ?, 0, 'no-invoice', 'Cap22 batch addon', 'USD', NULL, NULL, 'custom', '1M', 1, 'product', 10, 0, 'active', NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)", (mgroup, NOW, NOW))
    d.commit()
    batch_addon = d.execute("SELECT id FROM client_order WHERE title = 'Cap22 batch addon'").fetchone()[0]
    expect_bool("admin_batch_delete_addons",
                call(op_a, cj_a, "admin", "order", "batch_delete", {"ids": [master], "delete_addons": 1}),
                "admin_batch_delete_addons")
    expect_err("admin_get_batch_master_gone", call(op_a, cj_a, "admin", "order", "get", {"id": master}),
               "admin_get_batch_master_gone")
    expect_err("admin_get_batch_addon_gone", call(op_a, cj_a, "admin", "order", "get", {"id": batch_addon}),
               "admin_get_batch_addon_gone")
    r = call(op_a, cj_a, "admin", "order", "create", {"client_id": 1, "product_id": 6, "period": "1M"})
    master2 = r["result"]
    mgroup2 = d.execute("SELECT group_id FROM client_order WHERE id = ?", (master2,)).fetchone()[0]
    d.execute("INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at) VALUES (1, 6, NULL, NULL, NULL, NULL, ?, 0, 'no-invoice', 'Cap22 batch addon2', 'USD', NULL, NULL, 'custom', '1M', 1, 'product', 10, 0, 'active', NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)", (mgroup2, NOW, NOW))
    d.commit()
    batch_addon2 = d.execute("SELECT id FROM client_order WHERE title = 'Cap22 batch addon2'").fetchone()[0]
    expect_bool("admin_batch_delete_noflag",
                call(op_a, cj_a, "admin", "order", "batch_delete", {"ids": [master2]}),
                "admin_batch_delete_noflag")
    expect_err("admin_get_batch_master2_gone", call(op_a, cj_a, "admin", "order", "get", {"id": master2}),
               "admin_get_batch_master2_gone")
    r = call(op_a, cj_a, "admin", "order", "get", {"id": batch_addon2})
    report("admin_get_batch_addon2_alive", r.get("error") is None and r["result"]["id"] == batch_addon2, f"got {r}")
    d.execute("DELETE FROM client_order WHERE id = ?", (batch_addon2,))
    d.commit()

    info = raw(op_a, cj_a, "admin", "order", "export_csv", {})
    report("admin_export_csv",
           info.get("status") == 200 and (info.get("content_type") or "").startswith("text/csv"),
           f"got {info}")

    print(f"\n{sum(1 for x in results if x)}/{len(results)} MATCH")


if __name__ == "__main__":
    main()
