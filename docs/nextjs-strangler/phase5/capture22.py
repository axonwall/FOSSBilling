#!/usr/bin/env python3
"""Phase 5 core-CRUD capture 4: Order admin/client leftovers against PHP.

Fresh orders are created via the API and deleted via the API; the one
fabricated addon order and the order-1 renew extension are restored
via SQL (renew adds a status-history row, also removed).
"""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures22"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
NOW = "2026-10-25 23:00:00"


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


def main():
    d = sqlite3.connect(DBP)

    def staff_opener():
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(f"{BASE}/login", timeout=20).read()
        return op, cj

    def csrf_of(cj):
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(op, cj, name, role, module, method, data=None, save=True):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            parsed = json.loads(e.read().decode())
        if save:
            (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
        ok = isinstance(parsed, dict) and parsed.get("error") is None
        manifest.append({"name": name, "ok": ok,
                         "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
        print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
        return parsed

    def raw(op, cj, name, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                body = resp.read()
                info = {"status": resp.status, "content_type": resp.headers.get("Content-Type"),
                        "length": len(body), "head": body[:8].hex()}
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                info = {"status": e.code, "body": json.loads(body.decode())}
            except Exception:
                info = {"status": e.code, "length": len(body)}
        (OUT / f"{name}.json").write_text(json.dumps(info, indent=2))
        print("RAW", name, info.get("status"), info.get("content_type"), info.get("length"))
        return info

    op_a, cj_a = staff_opener()
    call(op_a, cj_a, "tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}, save=False)
    op_c, cj_c = staff_opener()
    call(op_c, cj_c, "tmp_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}, save=False)

    # --- static maps + errors ---
    call(op_a, cj_a, "admin_get_invoice_options", "admin", "order", "get_invoice_options")
    call(op_a, cj_a, "admin_service_missing", "admin", "order", "service", {})
    call(op_a, cj_a, "admin_service_notfound", "admin", "order", "service", {"id": 99999})
    call(op_a, cj_a, "admin_service_order1", "admin", "order", "service", {"id": 1})
    null_service_order = d.execute("SELECT id FROM client_order WHERE service_id IS NULL AND client_id = 1 LIMIT 1").fetchone()[0]
    call(op_a, cj_a, "admin_service_null", "admin", "order", "service", {"id": null_service_order})
    call(op_a, cj_a, "admin_addons_order1_empty", "admin", "order", "addons", {"id": 1})
    call(op_a, cj_a, "admin_addons_missing", "admin", "order", "addons", {})
    call(op_a, cj_a, "admin_addons_notfound", "admin", "order", "addons", {"id": 99999})
    call(op_a, cj_a, "admin_can_cancel_order1", "admin", "order", "can_cancel_at_period_end", {"id": 1})
    call(op_a, cj_a, "admin_can_cancel_missing", "admin", "order", "can_cancel_at_period_end", {})
    call(op_a, cj_a, "admin_can_cancel_notfound", "admin", "order", "can_cancel_at_period_end", {"id": 99999})
    call(op_a, cj_a, "admin_renew_missing", "admin", "order", "renew", {})
    call(op_a, cj_a, "admin_renew_notfound", "admin", "order", "renew", {"id": 99999})
    call(op_a, cj_a, "admin_update_config_missing", "admin", "order", "update_config", {})
    call(op_a, cj_a, "admin_update_config_notfound", "admin", "order", "update_config", {"id": 99999, "config": {"x": 1}})
    call(op_a, cj_a, "admin_update_config_no_config", "admin", "order", "update_config", {"id": 1})
    call(op_a, cj_a, "admin_update_config_scalar", "admin", "order", "update_config", {"id": 1, "config": "hello"})
    call(op_a, cj_a, "admin_batch_delete_missing", "admin", "order", "batch_delete", {})

    # --- client errors + reads ---
    call(op_c, cj_c, "client_addons_missing", "client", "order", "addons", {})
    call(op_c, cj_c, "client_addons_notfound", "client", "order", "addons", {"id": 99999})
    call(op_c, cj_c, "client_addons_order1_empty", "client", "order", "addons", {"id": 1})
    call(op_c, cj_c, "client_service_notactive", "client", "order", "service", {"id": null_service_order})
    call(op_c, cj_c, "client_service_order1", "client", "order", "service", {"id": 1})
    call(op_c, cj_c, "client_service_missing", "client", "order", "service", {})
    call(op_c, cj_c, "client_service_notfound", "client", "order", "service", {"id": 99999})
    call(op_c, cj_c, "client_upgradables_order1", "client", "order", "upgradables", {"id": 1})
    call(op_c, cj_c, "client_upgradables_missing", "client", "order", "upgradables", {})
    call(op_c, cj_c, "client_delete_active", "client", "order", "delete", {"id": 1})
    call(op_c, cj_c, "client_delete_missing", "client", "order", "delete", {})
    call(op_c, cj_c, "client_delete_notfound", "client", "order", "delete", {"id": 99999})

    # --- fabricated addon in order 1's group ---
    group1 = d.execute("SELECT group_id FROM client_order WHERE id = 1").fetchone()[0]
    d.execute("INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at) VALUES (1, 6, NULL, NULL, NULL, NULL, ?, 0, 'no-invoice', 'Cap22 addon', 'USD', NULL, NULL, 'custom', '1M', 1, 'product', 10, 0, 'active', NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)", (group1, NOW, NOW))
    d.commit()
    addon_id = d.execute("SELECT id FROM client_order WHERE title = 'Cap22 addon'").fetchone()[0]
    print("addon id:", addon_id)
    call(op_a, cj_a, "admin_addons_order1_one", "admin", "order", "addons", {"id": 1})
    call(op_c, cj_c, "client_addons_order1_one", "client", "order", "addons", {"id": 1})
    d.execute("DELETE FROM client_order WHERE id = ?", (addon_id,))
    d.commit()

    # --- update_config on a fresh order (replacement, not merge) ---
    r = call(op_a, cj_a, "admin_create_config_order", "admin", "order", "create",
             {"client_id": 1, "product_id": 6, "period": "1M"}, save=False)
    cfg_order = r["result"]
    call(op_a, cj_a, "admin_update_config_ok", "admin", "order", "update_config",
         {"id": cfg_order, "config": {"custom": "yes"}})
    call(op_a, cj_a, "admin_get_config_order", "admin", "order", "get", {"id": cfg_order})
    call(op_a, cj_a, "admin_delete_config_order", "admin", "order", "delete", {"id": cfg_order})

    # --- client delete on a fresh pending order ---
    r = call(op_a, cj_a, "admin_create_clientdel_order", "admin", "order", "create",
             {"client_id": 1, "product_id": 6, "period": "1M"}, save=False)
    del_order = r["result"]
    call(op_c, cj_c, "client_delete_ok", "client", "order", "delete", {"id": del_order})
    call(op_c, cj_c, "client_get_deleted_gone", "client", "order", "get", {"id": del_order})

    # --- renew: pending (activate path) ---
    r = call(op_a, cj_a, "admin_create_renew_pending", "admin", "order", "create",
             {"client_id": 1, "product_id": 6, "period": "1M"}, save=False)
    pend_order = r["result"]
    call(op_a, cj_a, "admin_renew_pending", "admin", "order", "renew", {"id": pend_order})
    call(op_a, cj_a, "admin_get_renewed_pending", "admin", "order", "get", {"id": pend_order})
    svc = d.execute("SELECT service_id FROM client_order WHERE id = ?", (pend_order,)).fetchone()[0]
    print("renewed pending service_id:", svc)
    call(op_a, cj_a, "admin_delete_renewed_pending", "admin", "order", "delete", {"id": pend_order})
    print("service row after delete:", d.execute("SELECT COUNT(*) FROM service_custom WHERE id = ?", (svc,)).fetchone()[0])

    # --- renew: active order 1 (extend path; SQL restore after) ---
    exp_before = d.execute("SELECT expires_at FROM client_order WHERE id = 1").fetchone()[0]
    max_status_before = d.execute("SELECT COALESCE(MAX(id), 0) FROM client_order_status WHERE client_order_id = 1").fetchone()[0]
    print("order1 expires before:", exp_before)
    call(op_a, cj_a, "admin_renew_active", "admin", "order", "renew", {"id": 1})
    call(op_a, cj_a, "admin_get_renewed_active", "admin", "order", "get", {"id": 1})
    exp_after = d.execute("SELECT expires_at FROM client_order WHERE id = 1").fetchone()[0]
    print("order1 expires after:", exp_after)
    d.execute("UPDATE client_order SET expires_at = ? WHERE id = 1", (exp_before,))
    d.execute("DELETE FROM client_order_status WHERE client_order_id = 1 AND id > ? AND notes = 'Order renewed'", (max_status_before,))
    d.commit()
    print("order1 restored:", d.execute("SELECT expires_at FROM client_order WHERE id = 1").fetchone()[0] == exp_before)

    # --- batch delete ---
    masters = []
    for i in (1, 2):
        r = call(op_a, cj_a, f"admin_create_batch{i}", "admin", "order", "create",
                 {"client_id": 1, "product_id": 6, "period": "1M"}, save=False)
        masters.append(r["result"])
    call(op_a, cj_a, "admin_batch_delete_ok", "admin", "order", "batch_delete", {"ids": masters})
    for i, mid in enumerate(masters, 1):
        call(op_a, cj_a, f"admin_get_batch{i}_gone", "admin", "order", "get", {"id": mid})
    # with delete_addons
    r = call(op_a, cj_a, "admin_create_batch_master", "admin", "order", "create",
             {"client_id": 1, "product_id": 6, "period": "1M"}, save=False)
    master = r["result"]
    mgroup = d.execute("SELECT group_id FROM client_order WHERE id = ?", (master,)).fetchone()[0]
    d.execute("INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at) VALUES (1, 6, NULL, NULL, NULL, NULL, ?, 0, 'no-invoice', 'Cap22 batch addon', 'USD', NULL, NULL, 'custom', '1M', 1, 'product', 10, 0, 'active', NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)", (mgroup, NOW, NOW))
    d.commit()
    batch_addon = d.execute("SELECT id FROM client_order WHERE title = 'Cap22 batch addon'").fetchone()[0]
    call(op_a, cj_a, "admin_batch_delete_addons", "admin", "order", "batch_delete", {"ids": [master], "delete_addons": 1})
    call(op_a, cj_a, "admin_get_batch_master_gone", "admin", "order", "get", {"id": master})
    call(op_a, cj_a, "admin_get_batch_addon_gone", "admin", "order", "get", {"id": batch_addon})
    # without delete_addons: addon survives
    r = call(op_a, cj_a, "admin_create_batch_master2", "admin", "order", "create",
             {"client_id": 1, "product_id": 6, "period": "1M"}, save=False)
    master2 = r["result"]
    mgroup2 = d.execute("SELECT group_id FROM client_order WHERE id = ?", (master2,)).fetchone()[0]
    d.execute("INSERT INTO client_order (client_id, product_id, form_id, promo_id, promo_recurring, promo_used, group_id, group_master, invoice_option, title, currency, unpaid_invoice_id, service_id, service_type, period, quantity, unit, price, discount, status, reason, notes, config, suspension_grace_days, referred_by, expires_at, activated_at, suspended_at, unsuspended_at, canceled_at, created_at, updated_at) VALUES (1, 6, NULL, NULL, NULL, NULL, ?, 0, 'no-invoice', 'Cap22 batch addon2', 'USD', NULL, NULL, 'custom', '1M', 1, 'product', 10, 0, 'active', NULL, NULL, '[]', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)", (mgroup2, NOW, NOW))
    d.commit()
    batch_addon2 = d.execute("SELECT id FROM client_order WHERE title = 'Cap22 batch addon2'").fetchone()[0]
    call(op_a, cj_a, "admin_batch_delete_noflag", "admin", "order", "batch_delete", {"ids": [master2]})
    call(op_a, cj_a, "admin_get_batch_master2_gone", "admin", "order", "get", {"id": master2})
    call(op_a, cj_a, "admin_get_batch_addon2_alive", "admin", "order", "get", {"id": batch_addon2})
    d.execute("DELETE FROM client_order WHERE id = ?", (batch_addon2,))
    d.commit()

    raw(op_a, cj_a, "admin_export_csv", "admin", "order", "export_csv", {})

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
