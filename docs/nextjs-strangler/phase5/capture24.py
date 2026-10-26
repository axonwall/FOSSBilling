#!/usr/bin/env python3
"""Phase 5 R1 D7 capture: service provisioning modules vs PHP.

servicedomain, servicehosting, servicedownloadable, servicelicense,
servicecustom. Seeded fixtures are restored at the end from snapshots.
send_file endpoints return binary, so raw() records status/headers/length/
head bytes instead of a JSON envelope. upload/update (multipart file_data)
are captured as the no-file error only; real multipart uploads stay
PHP-proxied in the TS port (see findings).
"""
import json, pathlib, sqlite3, urllib.request, urllib.parse, urllib.error, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures24"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
UPLOADS = "/home/hatch/scratch/fossbilling/runtime/src/data/uploads"
NOW = "2026-10-25 12:00:00"
REALHEX = "a" * 64
MISSHEX = "b" * 64
PKEY1 = "c" * 32
PKEY2 = "d" * 32
OKEY1 = "e" * 32
OKEY2 = "f" * 32
CKEY = "a1" * 16


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
    tables = ["service_domain", "service_hosting", "service_hosting_server",
              "service_hosting_hp", "tld", "tld_registrar",
              "service_downloadable", "service_downloadable_file",
              "service_license", "service_custom", "client_order", "product"]
    snaps = {}
    for t in tables:
        snaps[t] = (d.execute(f"SELECT * FROM {t}").fetchall(),
                    [r[1] for r in d.execute(f"PRAGMA table_info({t})")])

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
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                parsed = json.loads(e.read().decode())
            except Exception:
                parsed = {"error": {"message": f"non-json HTTP {e.code}"}}
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
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                blob = resp.read()
                info = {"status": resp.status, "content_type": resp.headers.get("Content-Type"),
                        "content_disposition": resp.headers.get("Content-Disposition"),
                        "length": len(blob), "head_hex": blob[:64].hex()}
        except urllib.error.HTTPError as e:
            blob = e.read()
            try:
                info = json.loads(blob.decode())
            except Exception:
                info = {"status": e.code, "length": len(blob), "head_hex": blob[:64].hex()}
        (OUT / f"{name}.json").write_text(json.dumps(info, indent=2))
        print("RAW", name, info.get("status"), info.get("length"))
        return info

    op_a, cj_a = staff_opener()
    call(op_a, cj_a, "tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}, save=False)
    op_c, cj_c = staff_opener()
    call(op_c, cj_c, "tmp_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}, save=False)

    def ins(sql, params=()):
        d.execute(sql, params)
        d.commit()
        return d.execute("SELECT last_insert_rowid()").fetchone()[0]

    # --- seeds ---
    srv_hestia = ins(
        "INSERT INTO service_hosting_server (name, ip, hostname, assigned_ips, status_url, active,"
        " max_accounts, ns1, ns2, manager, username, password, port, config, secure, created_at, updated_at)"
        " VALUES ('Cap24 Hestia', '192.0.2.10', 'hestia.cap24.local', NULL, NULL, 1, 100,"
        " 'ns1.cap24.local', 'ns2.cap24.local', 'Hestia', 'hestiaadmin', 'hestiapass', '8083',"
        " '{\"userprefix\":null,\"tls_verify\":true}', 1, ?, ?)", (NOW, NOW))
    srv_custom = ins(
        "INSERT INTO service_hosting_server (name, ip, hostname, active, manager, username, password,"
        " port, config, secure, created_at, updated_at)"
        " VALUES ('Cap24 Custom', '192.0.2.11', 'custom.cap24.local', 1, 'Custom', 'customadmin',"
        " 'custompass', '', '{\"userprefix\":null,\"tls_verify\":true}', 0, ?, ?)", (NOW, NOW))
    srv_del = ins(
        "INSERT INTO service_hosting_server (name, ip, hostname, active, manager, created_at, updated_at)"
        " VALUES ('Cap24 Doomed', '192.0.2.12', 'doomed.cap24.local', 1, 'Custom', ?, ?)", (NOW, NOW))
    hp1 = ins(
        "INSERT INTO service_hosting_hp (name, quota, bandwidth, max_ftp, max_sql, max_pop, max_sub,"
        " max_park, max_addon, created_at, updated_at) VALUES ('Cap24 Basic', '1000', '10000', '5',"
        " '5', '10', '5', '2', '2', ?, ?)", (NOW, NOW))
    hp_del = ins(
        "INSERT INTO service_hosting_hp (name, quota, bandwidth, created_at, updated_at)"
        " VALUES ('Cap24 Doomed Plan', '500', '5000', ?, ?)", (NOW, NOW))
    host_svc = ins(
        "INSERT INTO service_hosting (client_id, sld, tld, ip, username, pass, reseller,"
        " service_hosting_server_id, service_hosting_hp_id, created_at, updated_at)"
        " VALUES (1, 'cap24host', '.com', '192.0.2.20', 'cap24user', 'cap24pass', 0, ?, ?, ?, ?)",
        (srv_hestia, hp1, NOW, NOW))
    host_ord = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 hosting', 'USD', ?,"
        " 'hosting', '1M', 10, 'active', ?, ?)", (host_svc, NOW, NOW))
    host_svc_inactive = ins(
        "INSERT INTO service_hosting (client_id, sld, tld, ip, username, pass, reseller,"
        " service_hosting_server_id, service_hosting_hp_id, created_at, updated_at)"
        " VALUES (1, 'cap24host2', '.com', '192.0.2.21', 'cap24user2', 'cap24pass2', 0, ?, ?, ?, ?)",
        (srv_hestia, hp1, NOW, NOW))
    host_ord_inactive = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 hosting inactive',"
        " 'USD', ?, 'hosting', '1M', 10, 'pending_setup', ?, ?)", (host_svc_inactive, NOW, NOW))
    orphan_srv = ins(
        "INSERT INTO service_hosting (client_id, sld, tld, ip, username, pass, reseller,"
        " service_hosting_server_id, service_hosting_hp_id, created_at, updated_at)"
        " VALUES (1, 'cap24orphan', '.com', '192.0.2.22', 'orphanuser', 'orphanpass', 0, ?, ?, ?, ?)",
        (srv_del, hp1, NOW, NOW))
    orphan_hp = ins(
        "INSERT INTO service_hosting (client_id, sld, tld, ip, username, pass, reseller,"
        " service_hosting_server_id, service_hosting_hp_id, created_at, updated_at)"
        " VALUES (1, 'cap24orphanhp', '.com', '192.0.2.23', 'orphanhpuser', 'orphanhppass', 0, ?, ?, ?, ?)",
        (srv_hestia, hp_del, NOW, NOW))
    dom_svc = ins(
        "INSERT INTO service_domain (client_id, sld, tld, ns1, ns2, period, privacy, locked,"
        " transfer_code, contact_email, contact_first_name, contact_last_name, contact_address1,"
        " contact_city, contact_country, contact_phone_cc, contact_phone, tld_registrar_id,"
        " registered_at, expires_at, created_at, updated_at) VALUES (1, 'cap24domain', '.com',"
        " 'ns1.cap24.local', 'ns2.cap24.local', 1, 0, 0, 'CAP24-EPP', 'phase0.client@example.com',"
        " 'Phase', 'Zero', '1 Cap St', 'Austin', 'US', '1', '5550100', 1, '2026-01-01', '2027-01-01',"
        " ?, ?)", (NOW, NOW))
    dom_ord = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 1, 'Cap24 domain', 'USD', ?,"
        " 'domain', '1Y', 11.99, 'active', ?, ?)", (dom_svc, NOW, NOW))
    dom_svc2 = ins(
        "INSERT INTO service_domain (client_id, sld, tld, ns1, ns2, period, privacy, locked,"
        " tld_registrar_id, created_at, updated_at) VALUES (1, 'cap24domain2', '.com',"
        " 'ns1.cap24.local', 'ns2.cap24.local', 1, 0, 0, 1, ?, ?)", (NOW, NOW))
    dom_ord_inactive = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 1, 'Cap24 domain inactive',"
        " 'USD', ?, 'domain', '1Y', 11.99, 'pending_setup', ?, ?)", (dom_svc2, NOW, NOW))
    dom_ord_client2 = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (2, 1, 'Cap24 domain c2', 'USD', ?,"
        " 'domain', '1Y', 11.99, 'active', ?, ?)", (dom_svc, NOW, NOW))
    tld_inactive = ins(
        "INSERT INTO tld (tld, price_registration, price_renew, price_transfer, allow_register,"
        " allow_transfer, active, min_years, tld_registrar_id, created_at, updated_at)"
        " VALUES ('.cap24inactive', 9.99, 9.99, 9.99, 1, 1, 0, 1, 1, ?, ?)", (NOW, NOW))
    dl_svc = ins("INSERT INTO service_downloadable (client_id, created_at, updated_at)"
                 " VALUES (1, ?, ?)", (NOW, NOW))
    dl_ord = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 downloadable', 'USD',"
        " ?, 'downloadable', '1M', 5, 'active', ?, ?)", (dl_svc, NOW, NOW))
    dl_svc2 = ins("INSERT INTO service_downloadable (client_id, created_at, updated_at)"
                  " VALUES (1, ?, ?)", (NOW, NOW))
    dl_ord_inactive = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 downloadable inactive',"
        " 'USD', ?, 'downloadable', '1M', 5, 'pending_setup', ?, ?)", (dl_svc2, NOW, NOW))
    dl_file_real = ins(
        "INSERT INTO service_downloadable_file (label, description, downloads, sort_order, file_key,"
        " filename, stored_filename, service_downloadable_id, created_at, updated_at)"
        " VALUES ('Cap24 real', 'Real file', 0, 0, ?, 'cap24.txt', ?, ?, ?, ?)",
        (OKEY1, REALHEX, dl_svc, NOW, NOW))
    dl_file_missing = ins(
        "INSERT INTO service_downloadable_file (label, downloads, sort_order, file_key, filename,"
        " stored_filename, service_downloadable_id, created_at, updated_at)"
        " VALUES ('Cap24 missing', 0, 1, ?, 'missing.txt', ?, ?, ?, ?)",
        (OKEY2, MISSHEX, dl_svc, NOW, NOW))
    dl_file_cascade = ins(
        "INSERT INTO service_downloadable_file (label, downloads, sort_order, file_key, filename,"
        " stored_filename, service_downloadable_id, created_at, updated_at)"
        " VALUES ('Cap24 cascade', 0, 2, ?, 'cascade.txt', ?, ?, ?, ?)",
        (CKEY, REALHEX, dl_svc, NOW, NOW))
    pathlib.Path(UPLOADS, REALHEX).write_text("Cap24 downloadable content.\n")
    d.execute("UPDATE product SET config = ? WHERE id = 2", (json.dumps({"files": [
        {"id": PKEY1, "filename": "cap24prod.txt", "stored_filename": REALHEX,
         "label": "Cap24 prod file", "description": "Prod desc"},
        {"id": PKEY2, "filename": "missing.txt", "stored_filename": MISSHEX,
         "label": "Missing prod", "description": None},
        {"id": CKEY, "filename": "cascade.txt", "stored_filename": REALHEX,
         "label": "Cascade prod", "description": None}]}),))
    d.commit()
    lic_svc = ins(
        "INSERT INTO service_license (client_id, license_key, validate_ip, validate_host,"
        " validate_path, validate_version, ips, hosts, paths, versions, created_at, updated_at)"
        " VALUES (1, 'CAP24-KEY-1', 1, 1, 0, 0, '[\"192.0.2.30\"]', '[\"cap24host.local\"]', '[]',"
        " '[]', ?, ?)", (NOW, NOW))
    lic_ord = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 license', 'USD', ?,"
        " 'license', '1M', 5, 'active', ?, ?)", (lic_svc, NOW, NOW))
    lic_svc2 = ins(
        "INSERT INTO service_license (client_id, license_key, validate_ip, validate_host,"
        " validate_path, validate_version, ips, hosts, paths, versions, created_at, updated_at)"
        " VALUES (1, 'CAP24-KEY-2', 0, 0, 0, 0, '[]', '[]', '[]', '[]', ?, ?)", (NOW, NOW))
    lic_ord_inactive = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 license inactive',"
        " 'USD', ?, 'license', '1M', 5, 'pending_setup', ?, ?)", (lic_svc2, NOW, NOW))
    lic_svc_open = ins(
        "INSERT INTO service_license (client_id, license_key, validate_ip, validate_host,"
        " validate_path, validate_version, ips, hosts, paths, versions, created_at, updated_at)"
        " VALUES (1, 'CAP24-OPEN-1', 0, 0, 0, 0, '[]', '[]', '[]', '[]', ?, ?)", (NOW, NOW))
    lic_ord_open = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 license open',"
        " 'USD', ?, 'license', '1M', 5, 'active', ?, ?)", (lic_svc_open, NOW, NOW))
    lic_svc_strict = ins(
        "INSERT INTO service_license (client_id, license_key, validate_ip, validate_host,"
        " validate_path, validate_version, ips, hosts, paths, versions, created_at, updated_at)"
        " VALUES (1, 'CAP24-STRICT-1', 1, 1, 0, 0, '[\"192.0.2.30\"]', '[\"cap24host.local\"]',"
        " '[]', '[]', ?, ?)", (NOW, NOW))
    lic_ord_strict = ins(
        "INSERT INTO client_order (client_id, product_id, title, currency, service_id, service_type,"
        " period, price, status, created_at, updated_at) VALUES (1, 2, 'Cap24 license strict',"
        " 'USD', ?, 'license', '1M', 5, 'active', ?, ?)", (lic_svc_strict, NOW, NOW))
    prod_host = ins(
        "INSERT INTO product (title, slug, type, active, status, config, created_at, updated_at)"
        " VALUES ('Cap24 Hosting Product', 'cap24-hosting', 'hosting', 1, 'enabled',"
        " '{\"free_tlds\":[\".com\",\".net\"]}', ?, ?)", (NOW, NOW))
    print("seeds:", srv_hestia, srv_custom, srv_del, hp1, hp_del, host_svc, host_ord,
          host_ord_inactive, dom_svc, dom_ord, dom_ord_inactive, dom_ord_client2, tld_inactive,
          dl_svc, dl_ord, dl_file_real, dl_file_missing, dl_file_cascade, lic_svc, lic_ord,
          lic_ord_open, prod_host)

    A = lambda n, m, p=None: call(op_a, cj_a, n, "admin", "servicedomain", m, p)
    C = lambda n, m, p=None: call(op_c, cj_c, n, "client", "servicedomain", m, p)
    G = lambda n, m, p=None: call(op_a, cj_a, n, "guest", "servicedomain", m, p)

    # --- servicedomain admin service actions (Custom registrar) ---
    A("sd_admin_update", "update", {"order_id": dom_ord, "ns1": "ns1.newcap24.local",
      "ns2": "ns2.newcap24.local", "period": 2, "privacy": 1, "locked": 1,
      "transfer_code": "CAP24-EPP-NEW"})
    A("sd_admin_update_missing", "update", {})
    A("sd_admin_update_notfound", "update", {"order_id": 99999})
    A("sd_admin_update_wrongtype", "update", {"order_id": 1})
    A("sd_admin_ns", "update_nameservers", {"order_id": dom_ord, "ns1": "ns1.cap24.local",
      "ns2": "ns2.cap24.local", "ns3": "ns3.cap24.local", "ns4": "ns4.cap24.local"})
    A("sd_admin_contacts", "update_contacts", {"order_id": dom_ord,
      "contact_email": "new@cap24.local", "contact_first_name": "New",
      "contact_last_name": "Name", "contact_city": "Dallas"})
    A("sd_admin_privacy_on", "enable_privacy_protection", {"order_id": dom_ord})
    A("sd_admin_privacy_off", "disable_privacy_protection", {"order_id": dom_ord})
    A("sd_admin_sync", "sync", {"order_id": dom_ord})
    A("sd_admin_transfer_code", "get_transfer_code", {"order_id": dom_ord})
    A("sd_admin_lock", "lock", {"order_id": dom_ord})
    A("sd_admin_unlock", "unlock", {"order_id": dom_ord})
    A("sd_admin_batch_sync", "batch_sync_expiration_dates", {})

    # --- servicedomain admin TLD ---
    A("sd_tld_list", "tld_get_list", {})
    A("sd_tld_list_sort", "tld_get_list", {"sort": "tld", "direction": "DESC"})
    A("sd_tld_get", "tld_get", {"tld": ".com"})
    A("sd_tld_get_missing", "tld_get", {})
    A("sd_tld_get_notfound", "tld_get", {"tld": ".nosuchtld"})
    A("sd_tld_get_id", "tld_get_id", {"id": 1})
    A("sd_tld_get_id_notfound", "tld_get_id", {"id": 99999})
    A("sd_tld_create", "tld_create", {"tld": ".cap24", "tld_registrar_id": 1,
      "price_registration": 7.5, "price_renew": 8.5, "price_transfer": 6.5,
      "allow_register": 1, "allow_transfer": 1, "active": 1, "min_years": 1})
    A("sd_tld_create_dup", "tld_create", {"tld": ".com", "tld_registrar_id": 1,
      "price_registration": 1, "price_renew": 1, "price_transfer": 1})
    A("sd_tld_create_missing", "tld_create", {"tld": ".cap24b"})
    A("sd_tld_update", "tld_update", {"tld": ".cap24", "price_registration": 7.75})
    A("sd_tld_update_notfound", "tld_update", {"tld": ".nosuchtld", "price_registration": 1})
    A("sd_tld_delete_used", "tld_delete", {"tld": ".com"})
    A("sd_tld_delete", "tld_delete", {"tld": ".cap24"})
    A("sd_tld_delete_notfound", "tld_delete", {"tld": ".cap24"})

    # --- servicedomain admin registrars ---
    A("sd_reg_list", "registrar_get_list", {})
    A("sd_reg_pairs", "registrar_get_pairs", {})
    A("sd_reg_available", "registrar_get_available", {})
    A("sd_reg_install_installed", "registrar_install", {"code": "Custom"})
    A("sd_reg_install_unknown", "registrar_install", {"code": "Nosuchreg"})
    A("sd_reg_install_missing", "registrar_install", {})
    reg_nc = A("sd_reg_install_namecheap", "registrar_install", {"code": "Namecheap"})["result"]
    nc_id = None
    if isinstance(reg_nc, int):
        nc_id = reg_nc
    else:
        row = d.execute("SELECT id FROM tld_registrar WHERE registrar = 'Namecheap'"
                        " ORDER BY id DESC LIMIT 1").fetchone()
        nc_id = row[0] if row else None
    A("sd_reg_get", "registrar_get", {"id": 1})
    A("sd_reg_get_notfound", "registrar_get", {"id": 99999})
    if nc_id:
        A("sd_reg_get_nc", "registrar_get", {"id": nc_id})
        A("sd_reg_update_nc", "registrar_update", {"id": nc_id, "title": "Cap24 Namecheap"})
        A("sd_reg_copy_nc", "registrar_copy", {"id": nc_id})
        copy_row = d.execute("SELECT id FROM tld_registrar WHERE name LIKE 'Cap24 Namecheap%'"
                             " AND id != ? ORDER BY id DESC LIMIT 1", (nc_id,)).fetchone()
        if copy_row:
            A("sd_reg_delete_copy", "registrar_delete", {"id": copy_row[0]})
        A("sd_reg_delete_nc", "registrar_delete", {"id": nc_id})
    A("sd_reg_delete_notfound", "registrar_delete", {"id": 99999})
    A("sd_reg_update_notfound", "registrar_update", {"id": 99999, "title": "X"})

    # --- servicedomain client + guest ---
    C("sd_client_ns", "update_nameservers", {"order_id": dom_ord, "ns1": "ns1.cap24.local",
      "ns2": "ns2.cap24.local"})
    C("sd_client_ns_other", "update_nameservers", {"order_id": dom_ord_client2,
      "ns1": "ns1.cap24.local", "ns2": "ns2.cap24.local"})
    C("sd_client_ns_inactive", "update_nameservers", {"order_id": dom_ord_inactive,
      "ns1": "ns1.cap24.local", "ns2": "ns2.cap24.local"})
    C("sd_client_ns_missing", "update_nameservers", {})
    C("sd_client_contacts", "update_contacts", {"order_id": dom_ord,
      "contact_email": "client@cap24.local"})
    C("sd_client_privacy_on", "enable_privacy_protection", {"order_id": dom_ord})
    C("sd_client_privacy_off", "disable_privacy_protection", {"order_id": dom_ord})
    C("sd_client_sync", "sync", {"order_id": dom_ord})
    C("sd_client_transfer_code", "get_transfer_code", {"order_id": dom_ord})
    C("sd_client_lock", "lock", {"order_id": dom_ord})
    C("sd_client_unlock", "unlock", {"order_id": dom_ord})
    G("sd_guest_tlds", "tlds", {})
    G("sd_guest_tlds_reg", "tlds", {"allow_register": 1})
    G("sd_guest_tlds_trans", "tlds", {"allow_transfer": 1})
    G("sd_guest_pricing", "pricing", {"tld": ".com"})
    G("sd_guest_pricing_notfound", "pricing", {"tld": ".nosuchtld"})
    G("sd_guest_pricing_missing", "pricing", {})
    G("sd_guest_check", "check", {"sld": "cap24available", "tld": ".com"})
    G("sd_guest_check_invalid", "check", {"sld": "bad sld!", "tld": ".com"})
    G("sd_guest_check_notld", "check", {"sld": "cap24available", "tld": ".nosuchtld"})
    G("sd_guest_check_inactive", "check", {"sld": "cap24available", "tld": ".cap24inactive"})
    G("sd_guest_check_missing", "check", {"sld": "cap24available"})
    G("sd_guest_transfer", "can_be_transferred", {"sld": "cap24domain", "tld": ".com"})
    G("sd_guest_transfer_notld", "can_be_transferred", {"sld": "cap24domain", "tld": ".nosuchtld"})
    G("sd_guest_transfer_inactive", "can_be_transferred", {"sld": "cap24domain",
      "tld": ".cap24inactive"})

    HA = lambda n, m, p=None: call(op_a, cj_a, n, "admin", "servicehosting", m, p)
    HC = lambda n, m, p=None: call(op_c, cj_c, n, "client", "servicehosting", m, p)
    HG = lambda n, m, p=None: call(op_a, cj_a, n, "guest", "servicehosting", m, p)

    # --- servicehosting admin account actions (Hestia server, unreachable) ---
    HA("sh_admin_change_plan", "change_plan", {"order_id": host_ord, "plan_id": hp1})
    HA("sh_admin_change_plan_missing", "change_plan", {"order_id": host_ord})
    HA("sh_admin_change_plan_notfound", "change_plan", {"order_id": host_ord, "plan_id": 99999})
    HA("sh_admin_change_plan_wrongtype", "change_plan", {"order_id": 1, "plan_id": hp1})
    HA("sh_admin_change_username", "change_username", {"order_id": host_ord,
      "username": "cap24user2"})
    HA("sh_admin_change_ip", "change_ip", {"order_id": host_ord, "ip": "192.0.2.99"})
    HA("sh_admin_change_domain", "change_domain", {"order_id": host_ord, "sld": "cap24new",
      "tld": ".com"})
    HA("sh_admin_change_password", "change_password", {"order_id": host_ord,
      "password": "NewCap24Pass!1", "password_confirm": "NewCap24Pass!1"})
    HA("sh_admin_change_password_mismatch", "change_password", {"order_id": host_ord,
      "password": "NewCap24Pass!1", "password_confirm": "Different!2"})
    HA("sh_admin_change_password_noconfirm", "change_password", {"order_id": host_ord,
      "password": "NewCap24Pass!1"})
    HA("sh_admin_sync", "sync", {"order_id": host_ord})
    HA("sh_admin_update", "update", {"order_id": host_ord, "username": "cap24user3",
      "ip": "192.0.2.21"})
    HA("sh_admin_update_missing", "update", {})
    HA("sh_admin_update_notfound", "update", {"order_id": 99999})
    HA("sh_admin_getservice", "_getService", {"order_id": host_ord})
    HA("sh_admin_getservice_missing", "_getService", {})
    HA("sh_manager_pairs", "manager_get_pairs", {})
    HA("sh_server_pairs", "server_get_pairs", {})
    HA("sh_server_list", "server_get_list", {})
    HA("sh_server_list_sort", "server_get_list", {"sort": "name", "direction": "DESC"})
    HA("sh_account_list", "account_get_list", {})
    HA("sh_account_list_server", "account_get_list", {"server_id": srv_hestia})

    # --- servicehosting admin server CRUD ---
    srv_new = HA("sh_server_create", "server_create", {"name": "Cap24 New", "ip": "192.0.2.13",
      "hostname": "new.cap24.local", "manager": "Custom", "username": "u", "password": "p",
      "port": "8083", "secure": 0, "active": 1, "ns1": "ns1.cap24.local"})["result"]
    HA("sh_server_create_missing", "server_create", {"name": "NoManager"})
    if isinstance(srv_new, int):
        HA("sh_server_get", "server_get", {"id": srv_new})
        HA("sh_server_update", "server_update", {"id": srv_new, "name": "Cap24 Renamed",
          "active": 0})
        HA("sh_server_update_badmanager", "server_update", {"id": srv_new,
          "manager": "Nosuchmanager"})
        HA("sh_server_test_custom", "server_test_connection", {"id": srv_new})
        HA("sh_server_delete", "server_delete", {"id": srv_new})
        HA("sh_server_get_after_delete", "server_get", {"id": srv_new})
    HA("sh_server_get_notfound", "server_get", {"id": 99999})
    HA("sh_server_test_hestia", "server_test_connection", {"id": srv_hestia})
    HA("sh_server_test_notfound", "server_test_connection", {"id": 99999})
    HA("sh_server_delete_inuse", "server_delete", {"id": srv_hestia})
    HA("sh_server_delete_orphan_noforce", "server_delete", {"id": srv_del})
    HA("sh_server_delete_orphan_force", "server_delete", {"id": srv_del, "force": 1})
    HA("sh_server_delete_orphan_after", "server_get", {"id": srv_del})

    # --- servicehosting admin hp CRUD ---
    hp_new = HA("sh_hp_create", "hp_create", {"name": "Cap24 Plan", "quota": "2000",
      "bandwidth": "20000", "max_ftp": "10"})["result"]
    HA("sh_hp_create_missing", "hp_create", {})
    HA("sh_hp_pairs", "hp_get_pairs", {})
    HA("sh_hp_list", "hp_get_list", {})
    if isinstance(hp_new, int):
        HA("sh_hp_get", "hp_get", {"id": hp_new})
        HA("sh_hp_update", "hp_update", {"id": hp_new, "name": "Cap24 Plan Renamed"})
        HA("sh_hp_delete", "hp_delete", {"id": hp_new})
        HA("sh_hp_get_after_delete", "hp_get", {"id": hp_new})
    HA("sh_hp_get_notfound", "hp_get", {"id": 99999})
    HA("sh_hp_delete_inuse", "hp_delete", {"id": hp1})
    HA("sh_hp_delete_orphan_noforce", "hp_delete", {"id": hp_del})
    HA("sh_hp_delete_orphan_force", "hp_delete", {"id": hp_del, "force": 1})
    HA("sh_hp_delete_orphan_after", "hp_get", {"id": hp_del})

    # --- servicehosting client + guest ---
    HC("sh_client_username", "change_username", {"order_id": host_ord, "username": "cap24cuser"})
    HC("sh_client_username_other", "change_username", {"order_id": dom_ord_client2,
      "username": "x"})
    HC("sh_client_username_inactive", "change_username", {"order_id": host_ord_inactive,
      "username": "x"})
    HC("sh_client_domain", "change_domain", {"order_id": host_ord, "sld": "cap24client",
      "tld": ".com"})
    HC("sh_client_password", "change_password", {"order_id": host_ord,
      "password": "ClientPass!2", "password_confirm": "ClientPass!2"})
    HC("sh_client_password_mismatch", "change_password", {"order_id": host_ord,
      "password": "ClientPass!2", "password_confirm": "Other!3"})
    HC("sh_client_hp_pairs", "hp_get_pairs", {})
    HC("sh_client_login_url", "get_login_url", {"order_id": host_ord})
    HC("sh_client_getservice", "_getService", {"order_id": host_ord})
    HC("sh_client_getservice_missing", "_getService", {})
    HG("sh_guest_free_tlds", "free_tlds", {"product_id": prod_host})
    HG("sh_guest_free_tlds_custom", "free_tlds", {"product_id": 2})
    HG("sh_guest_free_tlds_missing", "free_tlds", {})
    HG("sh_guest_free_tlds_notfound", "free_tlds", {"product_id": 99999})

    DA = lambda n, m, p=None: call(op_a, cj_a, n, "admin", "servicedownloadable", m, p)
    DC = lambda n, m, p=None: call(op_c, cj_c, n, "client", "servicedownloadable", m, p)
    DRA = lambda n, m, p=None: raw(op_a, cj_a, n, "admin", "servicedownloadable", m, p)
    DRC = lambda n, m, p=None: raw(op_c, cj_c, n, "client", "servicedownloadable", m, p)

    # --- servicedownloadable (upload/update need multipart: no-file pins only) ---
    DA("dl_admin_upload_nofile", "upload", {"id": 2})
    DA("dl_admin_upload_missing", "upload", {})
    DA("dl_admin_update_nofile", "update", {"order_id": dl_ord})
    DA("dl_admin_update_notfound", "update", {"order_id": 99999})
    DA("dl_admin_update_wrongtype", "update", {"order_id": 1})
    DA("dl_admin_file_update", "file_update", {"id": 2, "file_id": PKEY1,
      "label": "Cap24 prod renamed", "description": "Renamed desc"})
    DA("dl_admin_file_update_badkey", "file_update", {"id": 2, "file_id": "zz",
      "label": "X"})
    DA("dl_admin_file_update_missing", "file_update", {"id": 2})
    DA("dl_admin_config_save", "config_save", {"id": 2, "update_orders": 1})
    DA("dl_admin_config_save_missing", "config_save", {})
    DRA("dl_admin_send_file", "send_file", {"id": 2, "file_id": PKEY1})
    DRA("dl_admin_send_file_missing_stored", "send_file", {"id": 2, "file_id": PKEY2})
    DRA("dl_admin_send_file_badkey", "send_file", {"id": 2, "file_id": "zz"})
    DRA("dl_admin_send_file_notfound", "send_file", {"id": 99999, "file_id": PKEY1})
    DRA("dl_admin_send_order_file", "send_order_file", {"order_id": dl_ord,
      "file_id": dl_file_real})
    DRA("dl_admin_send_order_file_missing", "send_order_file", {"order_id": dl_ord,
      "file_id": 99999})
    DRA("dl_admin_send_order_file_notfound", "send_order_file", {"order_id": 99999,
      "file_id": dl_file_real})
    DA("dl_admin_file_update_notfound_product", "file_update", {"id": 99999,
      "file_id": PKEY1, "label": "X"})
    DA("dl_admin_file_update_longlabel", "file_update", {"id": 2, "file_id": PKEY1,
      "label": "L" * 256})
    DA("dl_admin_file_update_longdesc", "file_update", {"id": 2, "file_id": PKEY1,
      "description": "D" * 1001})
    DA("dl_admin_file_delete_notfound_product", "file_delete", {"id": 99999,
      "file_id": PKEY1})
    DA("dl_admin_config_save_notfound_product", "config_save", {"id": 99999})
    DA("dl_admin_order_file_delete_wrongtype", "order_file_delete", {"order_id": 1,
      "file_id": dl_file_real})
    DA("dl_admin_file_delete", "file_delete", {"id": 2, "file_id": PKEY2})
    DA("dl_admin_file_delete_again", "file_delete", {"id": 2, "file_id": PKEY2})
    DA("dl_admin_file_delete_cascade", "file_delete", {"id": 2, "file_id": CKEY})
    DRA("dl_admin_send_order_file_cascade_gone", "send_order_file", {"order_id": dl_ord,
      "file_id": dl_file_cascade})
    DA("dl_admin_order_file_delete", "order_file_delete", {"order_id": dl_ord,
      "file_id": dl_file_missing})
    DA("dl_admin_order_file_delete_again", "order_file_delete", {"order_id": dl_ord,
      "file_id": dl_file_missing})
    DRC("dl_client_send_file", "send_file", {"order_id": dl_ord, "file_id": dl_file_real})
    DRC("dl_client_send_file_other", "send_file", {"order_id": dom_ord_client2,
      "file_id": dl_file_real})
    DRC("dl_client_send_file_inactive", "send_file", {"order_id": dl_ord_inactive,
      "file_id": dl_file_real})
    DRC("dl_client_send_file_missing", "send_file", {"order_id": dl_ord, "file_id": 99999})

    LA = lambda n, m, p=None: call(op_a, cj_a, n, "admin", "servicelicense", m, p)
    LC = lambda n, m, p=None: call(op_c, cj_c, n, "client", "servicelicense", m, p)
    LG = lambda n, m, p=None: call(op_a, cj_a, n, "guest", "servicelicense", m, p)

    # --- servicelicense ---
    LA("lic_admin_plugin_pairs", "plugin_get_pairs", {})
    LA("lic_admin_update", "update", {"order_id": lic_ord, "validate_ip": 0,
      "validate_host": 0, "ips": "192.0.2.31\n192.0.2.32", "hosts": "other.cap24.local"})
    LA("lic_admin_update_array", "update", {"order_id": lic_ord,
      "ips": ["192.0.2.31"]})
    LA("lic_admin_update_missing", "update", {})
    LA("lic_admin_update_wrongtype", "update", {"order_id": 1})
    LA("lic_admin_reset", "reset", {"order_id": lic_ord})
    LA("lic_admin_getservice", "_getService", {"order_id": lic_ord})
    LA("lic_admin_getservice_missing", "_getService", {})
    LC("lic_client_reset", "reset", {"order_id": lic_ord})
    LC("lic_client_reset_other", "reset", {"order_id": dom_ord_client2})
    LC("lic_client_reset_inactive", "reset", {"order_id": lic_ord_inactive})
    LC("lic_client_getservice", "_getService", {"order_id": lic_ord})
    LG("lic_guest_check", "check", {"license": "CAP24-OPEN-1", "host": "any.cap24.local",
      "version": "1.0", "path": "/var/www"})
    LG("lic_guest_check_badhost", "check", {"license": "CAP24-STRICT-1",
      "host": "other.cap24.local", "version": "1.0", "path": "/var/www"})
    LG("lic_guest_check_badip", "check", {"license": "CAP24-STRICT-1",
      "host": "cap24host.local", "version": "1.0", "path": "/var/www"})
    LG("lic_guest_check_inactive", "check", {"license": "CAP24-KEY-2",
      "host": "any.cap24.local", "version": "1.0", "path": "/var/www"})
    LG("lic_guest_check_noversion", "check", {"license": "CAP24-OPEN-1",
      "host": "any.cap24.local", "path": "/var/www"})
    LG("lic_guest_check_unknown", "check", {"license": "CAP24-NOPE",
      "host": "any.cap24.local", "version": "1.0", "path": "/var/www"})
    LG("lic_guest_check_missing", "check", {})
    LG("lic_guest_check_format2", "check", {"license": "CAP24-OPEN-1",
      "host": "any.cap24.local", "version": "1.0", "path": "/var/www", "format": 2})
    LG("lic_guest_check_format2_bad", "check", {"license": "CAP24-NOPE",
      "host": "any.cap24.local", "version": "1.0", "path": "/var/www", "format": 2})

    SA = lambda n, m, p=None: call(op_a, cj_a, n, "admin", "servicecustom", m, p)
    SC = lambda n, m, p=None: call(op_c, cj_c, n, "client", "servicecustom", m, p)

    # --- servicecustom ---
    SA("sc_admin_update", "update", {"order_id": 1, "config": {"cap24field": "cap24value"}})
    SA("sc_admin_update_missing", "update", {})
    SA("sc_admin_update_notfound", "update", {"order_id": 99999,
      "config": {"cap24field": "x"}})
    SA("sc_admin_update_badconfig", "update", {"order_id": 1, "config": "not-an-array"})
    SA("sc_admin_bogus_method", "bogus_method", {"order_id": 1})
    SA("sc_admin_forbidden_method", "delete", {"order_id": 1})
    SA("sc_admin_bogus_missing", "bogus_method", {})
    SC("sc_client_call", "call", {"order_id": 1, "method": "bogus_method"})
    SC("sc_client_call_forbidden", "call", {"order_id": 1, "method": "suspend"})
    SC("sc_client_call_missing_method", "call", {"order_id": 1})
    SC("sc_client_call_missing_order", "call", {"method": "bogus_method"})
    SC("sc_client_call_notfound", "call", {"order_id": 99999, "method": "bogus_method"})

    # --- teardown: restore snapshots, remove seeded upload file ---
    for t in tables:
        rows, cols = snaps[t]
        d.execute(f"DELETE FROM {t}")
        ph = ",".join("?" * len(cols))
        d.executemany(f"INSERT INTO {t} ({','.join(cols)}) VALUES ({ph})", rows)
    d.commit()
    up = pathlib.Path(UPLOADS, REALHEX)
    if up.exists():
        up.unlink()
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"cases: {len(manifest)}, ok: {sum(1 for m in manifest if m['ok'])},"
          f" err: {sum(1 for m in manifest if not m['ok'])}")


if __name__ == "__main__":
    main()
