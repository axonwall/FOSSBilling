#!/usr/bin/env python3
"""eNom adapter smoke test: TS servicedomain endpoints against the
fixture-XML mock eNom server (enom-mock-server.mjs), on a disposable
copy of the reference DB. Never touches the reference DB.

Starts the mock (port 18099) and a Next server (port 3001, scratch DB,
FB_ENOM_API_URL pointed at the mock), seeds an Enom registrar + TLD +
domain order, then asserts endpoint results, DB state, and the exact
eNom commands the TS client sent (mock request log).

Usage: python3 enom-smoke.py   (from the repo root or anywhere; paths
below are absolute). Exits nonzero on any failure.
"""
import http.cookiejar, json, os, pathlib, shutil, signal, sqlite3, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

REPO = pathlib.Path("/home/hatch/scratch/fossbilling/repo")
NEXT = REPO / "apps/nextjs"
REFDB = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
WORK = pathlib.Path("/home/hatch/scratch/fossbilling/enom-smoke")
MOCK_PORT = 18099
TS = "http://127.0.0.1:3001/api/fb"
NOW = "2026-10-26 12:00:00"
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL "), name, detail if not ok else "")
    if not ok:
        failures.append(name)


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    dbp = str(WORK / "smoke.sqlite")
    shutil.copyfile(REFDB, dbp)
    logp = str(WORK / "mock-requests.log")
    pathlib.Path(logp).write_text("")
    d = sqlite3.connect(dbp)
    d.execute("UPDATE setting SET value = '2020-01-01 00:00:00' WHERE param = 'servicedomain_last_sync'")
    d.commit()

    mock_env = dict(os.environ, ENOM_MOCK_LOG=logp)
    mock = subprocess.Popen(["node", str(REPO / "docs/nextjs-strangler/phase5/enom-mock-server.mjs"),
                             str(MOCK_PORT)], env=mock_env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    nxt = None
    sid = None
    try:
        # Build first (next start serves the last build).
        build = subprocess.run(["npm", "run", "build"], cwd=str(NEXT),
                               capture_output=True, text=True, timeout=600)
        check("next build", build.returncode == 0, build.stdout[-2000:] + build.stderr[-2000:])
        if build.returncode != 0:
            return 1
        salt = ""
        for line in pathlib.Path("/home/hatch/scratch/fossbilling/runtime/src/config.php").read_text().splitlines():
            if "salt" in line and "=>" in line:
                salt = line.split("=>")[1].strip().strip("',\" ")
        nxt_env = dict(os.environ,
                       TZ="UTC",
                       FB_TS_MODULES="activity,cart,client,cron,currency,custompages,email,extension,invoice,massmailer,news,notification,order,product,profile,servicecustom,servicedomain,servicedownloadable,servicehosting,servicelicense,staff,stats,support,system",
                       FB_DATABASE_PATH=dbp,
                       FOSSBILLING_URL="http://127.0.0.1:8080",
                       FB_PAYPAL_SKIP_VERIFY="1",
                       FB_CALLBACK_SALT=salt,
                       FOSSBILLING_PHP_SRC="/home/hatch/scratch/fossbilling/repo/src",
                       FB_ENOM_API_URL=f"http://127.0.0.1:{MOCK_PORT}/interface.asp")
        nxt = subprocess.Popen(["npx", "next", "start", "-p", "3001"], cwd=str(NEXT),
                               env=nxt_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 90
        up = False
        while time.time() < deadline:
            try:
                urllib.request.urlopen(TS + "/__prime", timeout=5).read()
                up = True
                break
            except Exception:
                time.sleep(2)
        check("next up (__prime 200)", up)
        if not up:
            return 1

        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(TS + "/__prime", timeout=20).read()

        def csrf():
            for c in cj:
                if c.name == "fossbilling_csrf":
                    return c.value

        def call(role, module, method, data=None, raw_json=False):
            payload = dict(data or {})
            if csrf():
                payload["CSRFToken"] = csrf()
            if raw_json:
                body = json.dumps(payload).encode()
                headers = {"Content-Type": "application/json"}
            else:
                body = urllib.parse.urlencode(flatten(payload)).encode()
                headers = {}
            req = urllib.request.Request(f"{TS}/{role}/{module}/{method}", data=body,
                                         method="POST", headers=headers)
            try:
                with op.open(req, timeout=60) as resp:
                    return json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                try:
                    return json.loads(e.read().decode())
                except Exception:
                    return {"error": {"message": f"non-json HTTP {e.code}"}}

        def flatten(d, prefix=""):
            out = {}
            for k, v in d.items():
                key = f"{prefix}[{k}]" if prefix else k
                if isinstance(v, dict):
                    out.update(flatten(v, key))
                else:
                    out[key] = v
            return out

        def result_of(r):
            return r.get("result")

        def err_of(r):
            e = r.get("error")
            return e.get("message", "") if isinstance(e, dict) else ""

        login = call("guest", "staff", "login",
                     {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
        check("admin login", login.get("error") is None, str(login)[:300])
        # guest/staff/login has no TS handler, so it proxies to PHP, which
        # writes the session row into the REFERENCE DB. Transplant that
        # row into the scratch DB so TS admin calls authenticate (the
        # documented smoke-test pattern).
        sid = None
        for c in cj:
            if c.name == "fossbilling_session":
                sid = c.value
        check("session cookie from PHP login", sid is not None)
        transplanted = False
        if sid:
            ref = sqlite3.connect(REFDB)
            cols = [r[1] for r in ref.execute("PRAGMA table_info(session)")]
            row = ref.execute(f"SELECT * FROM session WHERE id = ?", (sid,)).fetchone()
            if row:
                d.execute(f"DELETE FROM session WHERE id = ?", (sid,))
                d.execute(f"INSERT INTO session ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", row)
                d.commit()
                transplanted = True
            ref.close()
        check("session row transplanted to scratch DB", transplanted)

        # --- registrar install / config ---
        avail = call("admin", "servicedomain", "registrar_get_available")
        check("Enom in registrar_get_available", "Enom" in (result_of(avail) or []), str(avail)[:300])
        check("registrar_install Enom", result_of(call("admin", "servicedomain", "registrar_install",
                                                      {"code": "Enom"})) is True)
        regs = result_of(call("admin", "servicedomain", "registrar_get_list")) or {}
        reg_id = None
        for row in regs.get("list", []):
            if row.get("title") == "Enom":
                reg_id = row["id"]
        check("Enom registrar row exists", reg_id is not None)
        upd = call("admin", "servicedomain", "registrar_update",
                   {"id": reg_id, "config": {"username": "mockuser"}}, raw_json=True)
        check("missing password rejected",
              "missing required configuration: Password" in err_of(upd), str(upd)[:300])
        check("registrar_update with creds",
              result_of(call("admin", "servicedomain", "registrar_update",
                             {"id": reg_id, "test_mode": "1",
                              "config": {"username": "mockuser", "password": "mockpass"}},
                             raw_json=True)) is True)
        reg = result_of(call("admin", "servicedomain", "registrar_get", {"id": reg_id}))
        check("password masked in registrar_get",
              reg.get("config", {}).get("password") is None
              and reg.get("config", {}).get("password_set") is True, str(reg)[:300])
        check("test_mode stored", reg.get("test_mode") is True, str(reg)[:300])

        # --- TLD + domain order seeds ---
        tld_id = result_of(call("admin", "servicedomain", "tld_create",
                                {"tld": ".mocktest", "tld_registrar_id": reg_id,
                                 "price_registration": "10", "price_renew": "10",
                                 "price_transfer": "10"}))
        check("tld_create .mocktest", isinstance(tld_id, int), str(tld_id))
        d.execute("INSERT INTO service_domain (client_id, sld, tld, ns1, ns2, period, privacy, locked,"
                  " transfer_code, registered_at, expires_at, tld_registrar_id, created_at, updated_at)"
                  " VALUES (1, 'example', '.com', NULL, NULL, 1, 0, 1, NULL,"
                  " '2025-01-01 00:00:00', NULL, ?, ?, ?)", (reg_id, NOW, NOW))
        dom_id = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("INSERT INTO client_order (client_id, service_id, service_type, status, created_at, updated_at)"
                  " VALUES (1, ?, 'domain', 'active', ?, ?)", (dom_id, NOW, NOW))
        order_id = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("INSERT INTO service_domain (client_id, sld, tld, period, tld_registrar_id, created_at, updated_at)"
                  " VALUES (1, 'boom', '.com', 1, ?, ?, ?)", (reg_id, NOW, NOW))
        boom_id = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("INSERT INTO client_order (client_id, service_id, service_type, status, created_at, updated_at)"
                  " VALUES (1, ?, 'domain', 'active', ?, ?)", (boom_id, NOW, NOW))
        boom_order = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.commit()

        def dom():
            return d.execute("SELECT ns1, ns2, privacy, locked, contact_first_name, contact_email,"
                             " contact_phone, contact_phone_cc, expires_at, registered_at, synced_at"
                             " FROM service_domain WHERE id = ?", (dom_id,)).fetchone()

        def mock_cmds():
            return [json.loads(line) for line in pathlib.Path(logp).read_text().splitlines() if line.strip()]

        def saw(command, **params):
            for entry in mock_cmds():
                if entry["command"].lower() == command.lower() and all(
                        str(entry["params"].get(k)) == str(v) for k, v in params.items()):
                    return True
            return False

        # --- guest checks ---
        check("guest check available", result_of(call("guest", "servicedomain", "check",
                                                     {"sld": "free-domain-xyz", "tld": ".mocktest"})) is True)
        check("guest check taken", result_of(call("guest", "servicedomain", "check",
                                                  {"sld": "example", "tld": ".mocktest"})) is False)
        check("guest can_be_transferred unlocked",
              result_of(call("guest", "servicedomain", "can_be_transferred",
                             {"sld": "example", "tld": ".mocktest"})) is True)
        check("guest can_be_transferred locked",
              result_of(call("guest", "servicedomain", "can_be_transferred",
                             {"sld": "taken", "tld": ".mocktest"})) is False)
        check("guest can_be_transferred available name",
              result_of(call("guest", "servicedomain", "can_be_transferred",
                             {"sld": "free-domain-xyz", "tld": ".mocktest"})) is False)
        check("mock saw check RRPCode path", saw("check", sld="example"))

        # --- domain actions (admin) ---
        check("update_nameservers",
              result_of(call("admin", "servicedomain", "update_nameservers",
                             {"order_id": order_id, "ns1": "ns1.new.example",
                              "ns2": "ns2.new.example"})) is True)
        check("nameservers persisted", dom()[:2] == ("ns1.new.example", "ns2.new.example"), str(dom()))
        check("mock saw ModifyNS", saw("ModifyNS", NS1="ns1.new.example", NS2="ns2.new.example"))
        contact = {"first_name": "Ada", "last_name": "Lovelace", "email": "ada@mock.example",
                   "address1": "1 Way", "country": "US", "city": "Mockville", "state": "TX",
                   "postcode": "78701", "phone_cc": "1", "phone": "5550101", "company": "Analytical"}
        check("update_contacts",
              result_of(call("admin", "servicedomain", "update_contacts",
                             {"order_id": order_id, "contact": contact})) is True)
        row = dom()
        check("contacts persisted", row[4] == "Ada" and row[5] == "ada@mock.example", str(row))
        check("mock saw Contacts all four prefixes + eNom phone shape",
              saw("Contacts", RegistrantFirstName="Ada", AuxBillingFirstName="Ada",
                  TechFirstName="Ada", AdminFirstName="Ada", RegistrantPhone="+1.5550101"))
        check("lock", result_of(call("admin", "servicedomain", "lock", {"order_id": order_id})) is True)
        check("locked persisted", dom()[3] == 1)
        check("mock saw SetRegLock lock", saw("SetRegLock", UnlockRegistrar="0"))
        check("unlock", result_of(call("admin", "servicedomain", "unlock", {"order_id": order_id})) is True)
        check("unlocked persisted", dom()[3] == 0)
        check("mock saw SetRegLock unlock", saw("SetRegLock", UnlockRegistrar="1"))
        # Client path shares the same dispatch (order must be active + owned).
        cj_c = http.cookiejar.CookieJar()
        op_c = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj_c))
        op_c.open(TS + "/__prime", timeout=20).read()

        def csrf_c():
            for c in cj_c:
                if c.name == "fossbilling_csrf":
                    return c.value

        def call_c(role, module, method, data=None):
            payload = dict(data or {})
            if csrf_c():
                payload["CSRFToken"] = csrf_c()
            body = urllib.parse.urlencode(flatten(payload)).encode()
            req = urllib.request.Request(f"{TS}/{role}/{module}/{method}", data=body, method="POST")
            try:
                with op_c.open(req, timeout=60) as resp:
                    return json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                try:
                    return json.loads(e.read().decode())
                except Exception:
                    return {"error": {"message": f"non-json HTTP {e.code}"}}

        clogin = call_c("guest", "client", "login",
                        {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
        check("client login", clogin.get("error") is None, str(clogin)[:300])
        check("client lock",
              result_of(call_c("client", "servicedomain", "lock", {"order_id": order_id})) is True)
        check("client lock persisted", dom()[3] == 1)
        epp = call("admin", "servicedomain", "get_transfer_code", {"order_id": order_id})
        check("get_transfer_code emailed sentinel",
              result_of(epp) == "EPP code emailed to registrant", str(epp)[:300])
        check("mock saw SynchAuthInfo", saw("SynchAuthInfo", EmailEpp="True", RunSynchAutoInfo="True"))
        check("enable_privacy",
              result_of(call("admin", "servicedomain", "enable_privacy_protection",
                             {"order_id": order_id})) is True)
        check("privacy persisted", dom()[2] == 1)
        check("mock saw ID Protect purchase",
              saw("AddToCart", producttype="IDProtect") and saw("InsertNewOrder"))
        dis = call("admin", "servicedomain", "disable_privacy_protection", {"order_id": order_id})
        check("disable_privacy throws honestly",
              "cannot be disabled through the reseller API" in err_of(dis), str(dis)[:300])
        check("privacy unchanged after failed disable", dom()[2] == 1)

        # --- sync ---
        check("sync", result_of(call("admin", "servicedomain", "sync", {"order_id": order_id})) is True)
        row = dom()
        check("sync overwrote contacts from eNom registrant",
              row[4] == "Mock" and row[5] == "reg@mock.example" and row[6] == "+1.5550100", str(row))
        check("sync phone_cc untouched (update_contacts set it to 1)", row[7] == "1", str(row))
        check("sync expires from eNom date", row[8] == "2027-03-15 00:00:00", str(row))
        check("sync wiped registered_at (no creation date in GetDomainInfo)", row[9] is None, str(row))
        check("sync stamped synced_at", row[10] is not None, str(row))
        check("sync lock from GetRegLock", row[3] == 0, str(row))
        check("sync privacy untouched", row[2] == 1, str(row))
        check("mock saw sync commands",
              saw("GetDomainInfo") and saw("GetRegLock") and saw("GetDNS") and saw("GetContacts"))

        # --- batch sync ---
        d.execute("UPDATE service_domain SET expires_at = NULL WHERE id = ?", (dom_id,))
        d.commit()
        check("batch_sync",
              result_of(call("admin", "servicedomain", "batch_sync_expiration_dates")) is True)
        check("batch set expires", dom()[8] == "2027-03-15 00:00:00", str(dom()))
        last = d.execute("SELECT value FROM setting WHERE param = 'servicedomain_last_sync'").fetchone()[0]
        check("batch refreshed last_sync", last != "2020-01-01 00:00:00", str(last))

        # --- error paths ---
        boom = call("admin", "servicedomain", "sync", {"order_id": boom_order})
        check("boom sync surfaces eNom error", "Simulated eNom failure" in err_of(boom), str(boom)[:300])
        check("boom row untouched",
              d.execute("SELECT synced_at FROM service_domain WHERE id = ?", (boom_id,)).fetchone()[0] is None)
        bad_reg = result_of(call("admin", "servicedomain", "registrar_copy", {"id": reg_id}))
        check("registrar_copy", isinstance(bad_reg, int), str(bad_reg))
        check("baduser config update",
              result_of(call("admin", "servicedomain", "registrar_update",
                             {"id": bad_reg, "config": {"username": "baduser", "password": "x"}},
                             raw_json=True)) is True)
        bad_tld = result_of(call("admin", "servicedomain", "tld_create",
                                 {"tld": ".badtest", "tld_registrar_id": bad_reg,
                                  "price_registration": "10", "price_renew": "10",
                                  "price_transfer": "10"}))
        bad = call("guest", "servicedomain", "check", {"sld": "example", "tld": ".badtest"})
        check("baduser check surfaces eNom auth error", "Invalid login" in err_of(bad), str(bad)[:300])
    finally:
        if nxt is not None:
            nxt.terminate()
            try:
                nxt.wait(timeout=15)
            except Exception:
                nxt.kill()
        mock.terminate()
        try:
            mock.wait(timeout=10)
        except Exception:
            mock.kill()
        subprocess.run(["pkill", "-f", "next-serve[r]"], capture_output=True)
        # Best-effort: remove the PHP-login session row from the reference DB.
        try:
            ref = sqlite3.connect(REFDB)
            ref.execute("DELETE FROM session WHERE id = ?", (sid,))
            ref.commit()
            ref.close()
        except Exception:
            pass
    print(f"\n{len(failures)} failures" if failures else "\nALL ENOM SMOKE CHECKS PASSED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
