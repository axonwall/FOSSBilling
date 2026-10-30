#!/usr/bin/env python3
"""R5i parity42: TS security homes vs PHP (capture45 corpus).

TS sections run on the reference server (:3001, fresh R5i build).
PHP sections run on dev (:8080, limiter bypassed). No prod oracle:
no trio behavior differs by environment (webserver probes the config
url on both stacks — :8080 here — so TS and PHP probe the same origin
and must agree exactly). The missing-DB proof runs on a suite-owned
TS instance (:3004) with FB_GEOIP_DB_DIR pointed at scratch dirs —
NEVER by renaming/deleting the reference DB files.

TS error envelopes are HTTP 200 by seam convention — parity compares
envelopes (message + code), never HTTP status, EXCEPT the R5g
limiter's real 429. PHP returns real HTTP 403 for permission denials;
TS returns the HTTP-200 envelope with code 403 (seam convention, same
as R5h's blocked-IP 403) — envelopes are compared, not HTTP status.

DIVERGENCES (labeled, never faked — see findings-r5i.md §4):
- dangerousFunctions / phpVersion: TS returns retired-marked entries;
  PHP returns live values. Asserted separately, never equalized.
- ip_lookup missing DB: PHP surfaces the generic 9999 (constructor
  exception sanitized, filename hidden); TS names the file explicitly
  (R5-8 spec improvement).
"""
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PHP_DEV = "http://127.0.0.1:8080"
TS_DEV = "http://127.0.0.1:3001/api/fb"
TS_NODB = "http://127.0.0.1:3004/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
APP = "/home/hatch/scratch/fossbilling/repo/apps/nextjs"
ACCT = "/home/hatch/scratch/fossbilling/repo/docs/nextjs-strangler/phase5/endpoint-accounting.py"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
PW = "Par42-Pass!42"
MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,custompages,email,extension,"
           "formbuilder,index,invoice,massmailer,news,notification,order,page,product,profile,redirect,"
           "security,seo,serviceapikey,servicecustom,servicedomain,servicedownloadable,servicehosting,"
           "servicelicense,staff,stats,support,system,theme,widgets")

checks = []
failures = []


def check(name, ok, detail=""):
    checks.append(name)
    if ok:
        print(f"PASS {name}")
    else:
        failures.append(name)
        print(f"FAIL {name} :: {detail}")


def q(sql, args=()):
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    rows = d.execute(sql, args).fetchall()
    d.close()
    return [dict(r) for r in rows]


def exec_sql(sql, args=()):
    d = sqlite3.connect(DBP)
    d.execute(sql, args)
    d.commit()
    d.close()


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def fresh(base):
    op, cj = make_opener()
    op.open(f"{base}/login", timeout=30).read()
    return op, cj


def csrf(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return None


def _post(op, cj, url, data=None):
    payload = dict(data or {})
    tok = csrf(cj)
    if tok:
        payload["CSRFToken"] = tok
    req = urllib.request.Request(
        url, data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=90) as resp:
            st, body = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        st, body = e.code, e.read()
    return st, json.loads(body.decode())


def call(base, op, cj, role, module, method, data=None):
    """PHP-style URL: {base}/api/{role}/{module}/{method}."""
    return _post(op, cj, f"{base}/api/{role}/{module}/{method}", data)


def ts_call(op, cj, base, role, module, method, data=None):
    """TS seam URL: {base}/{role}/{module}/{method} (base already ends in /api/fb)."""
    return _post(op, cj, f"{base}/{role}/{module}/{method}", data)


def login(op, cj, base, email, pw, api="staff"):
    st, env = call(base, op, cj, "guest", api, "login", {"email": email, "password": pw})
    assert env.get("error") is None, f"login failed for {email}: {env}"
    return env


def is_err(env, message, code):
    e = env.get("error") or {}
    return e.get("message") == message and e.get("code") == code


def bcrypt_hash(pw):
    js = ("const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
          f"console.log(b.hashSync({pw!r}, 10));")
    return subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout.strip()


def ts_env(extra):
    salt = re.search(r"'salt' => '([^']+)'", pathlib.Path(CFG).read_text()).group(1)
    env = dict(os.environ)
    env.update({"TZ": "UTC", "FB_TS_MODULES": MODULES, "FB_DATABASE_PATH": DBP,
                "FOSSBILLING_URL": PHP_DEV, "FB_PAYPAL_SKIP_VERIFY": "1",
                "FB_CALLBACK_SALT": salt, "FOSSBILLING_PHP_SRC": "/home/hatch/scratch/fossbilling/repo/src"})
    env.update(extra)
    return env


def fuser_kill(port):
    subprocess.run(["fuser", "-k", f"{port}/tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)


def start_nodb_ts(port, dbdir):
    fuser_kill(port)
    proc = subprocess.Popen(
        ["npx", "next", "start", "-p", str(port)], cwd=APP,
        env=ts_env({"FB_GEOIP_DB_DIR": dbdir}),
        stdout=open(f"/home/hatch/scratch/fossbilling/r5-logs/next-{port}-parity42.log", "w"),
        stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}/api/fb"
    for _ in range(40):
        if proc.poll() is not None:
            raise SystemExit(f"nodb TS :{port} died during startup")
        try:
            op, cj = make_opener()
            st, env = ts_call(op, cj, base, "guest", "antispam", "recaptcha")
            if st == 200:
                return proc, base
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"nodb TS :{port} did not come up")


def inv_snapshot():
    snap = {}
    for t in ("invoice", "client_order", "email_queue", "service_custom", "extension", "extension_meta",
              "setting", "admin", "admin_group", "admin_group_member", "currency", "client",
              "support_ticket", "tld", "activity_client_email", "invoice_event", "client_order_meta", "cart"):
        snap[t] = q(f"SELECT COUNT(*) AS c FROM {t}")[0]["c"]
    snap["cart_seq"] = q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"]
    try:
        snap["counters"] = q("SELECT COUNT(*) AS c FROM rate_limit_counter")[0]["c"]
    except Exception:
        snap["counters"] = None
    snap["config_hash"] = hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()[:16]
    snap["queue_split"] = sorted(
        (r["status"], r["c"]) for r in q("SELECT status, COUNT(*) AS c FROM email_queue GROUP BY status"))
    return snap


def main():
    inv_before = inv_snapshot()
    cart_ids_start = {r["id"] for r in q("SELECT id FROM cart")}
    cart_seq_start = inv_before["cart_seq"]
    nodb_proc = None
    nodb_dir_empty = "/home/hatch/scratch/fossbilling/r5-logs/nodb-empty"
    nodb_dir_country = "/home/hatch/scratch/fossbilling/r5-logs/nodb-country-only"
    staff_ids, group_ids = [], []
    try:
        php_op, php_cj = fresh(PHP_DEV)
        login(php_op, php_cj, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
        ts_op, ts_cj = fresh(PHP_DEV)  # session via PHP dev, reused on TS (shared DB)
        login(ts_op, ts_cj, PHP_DEV, SUPER_EMAIL, SUPER_PASS)

        # ---------- (i) ip_lookup parity ----------
        ips = [
            ("missing", None), ("invalid_text", "not-an-ip"), ("invalid_num", "999.1.1.1"),
            ("empty", ""), ("loopback", "127.0.0.1"), ("private10", "10.0.0.5"),
            ("private192", "192.168.1.1"), ("public_google", "8.8.8.8"),
            ("public_cloudflare", "1.1.1.1"), ("v6loopback", "::1"),
            ("v6public", "2001:4860:4860::8888"), ("v4mapped", "::ffff:8.8.8.8"),
            ("leading_zero", "010.0.0.1"), ("too_many_octets", "1.2.3.4.5"),
        ]
        for name, ip in ips:
            data = {} if ip is None else {"ip": ip}
            _, php_env = call(PHP_DEV, php_op, php_cj, "admin", "security", "ip_lookup", data)
            _, ts_env_ = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "ip_lookup", data)
            check(f"ip_lookup {name} ts==php", ts_env_ == php_env,
                  f"php={json.dumps(php_env)[:300]} ts={json.dumps(ts_env_)[:300]}")
        # Spot-shape assertions on the DB-decided records (from capture45).
        _, ts_pub = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
        pub_res = ts_pub.get("result") or {}
        check("ip_lookup 8.8.8.8 US/GOOGLE",
              (pub_res.get("country") or {}).get("name") == "United States"
              and pub_res.get("asn") == {"asnNumber": 15169, "asnOrg": "GOOGLE"},
              str(ts_pub)[:300])
        _, ts_priv = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "ip_lookup", {"ip": "192.168.1.1"})
        priv_res = ts_priv.get("result") or {}
        check("ip_lookup 192.168.1.1 AU country, empty asn (DB-decided, not private-empty)",
              (priv_res.get("country") or {}).get("name") == "Australia"
              and priv_res.get("asn") == [],
              str(ts_priv)[:300])

        # ---------- (ii) missing-DB errors (suite-owned :3004) ----------
        os.makedirs(nodb_dir_empty, exist_ok=True)
        for f in os.listdir(nodb_dir_empty):
            os.unlink(os.path.join(nodb_dir_empty, f))
        os.makedirs(nodb_dir_country, exist_ok=True)
        for f in os.listdir(nodb_dir_country):
            os.unlink(os.path.join(nodb_dir_country, f))
        real_db = "/home/hatch/scratch/fossbilling/repo/src/library/FOSSBilling/GeoIP/Databases"
        os.symlink(os.path.join(real_db, "CC0-Country.mmdb"),
                   os.path.join(nodb_dir_country, "CC0-Country.mmdb"))
        nodb_proc, nodb_base = start_nodb_ts(3004, nodb_dir_empty)
        _, env = ts_call(ts_op, ts_cj, nodb_base, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
        check("missing-DB empty dir names CC0-Country.mmdb",
              (env.get("error") or {}).get("message", "").find("CC0-Country.mmdb") >= 0
              and (env.get("error") or {}).get("code") == 9999, str(env)[:300])
        # Country-only dir: country opens, ASN file missing -> names PDDL-ASN.mmdb.
        nodb_proc.send_signal(signal.SIGTERM)
        try:
            nodb_proc.wait(timeout=10)
        except Exception:
            nodb_proc.kill()
        fuser_kill(3004)
        nodb_proc, nodb_base = start_nodb_ts(3004, nodb_dir_country)
        _, env = ts_call(ts_op, ts_cj, nodb_base, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
        check("missing-DB country-only dir names PDDL-ASN.mmdb",
              (env.get("error") or {}).get("message", "").find("PDDL-ASN.mmdb") >= 0
              and (env.get("error") or {}).get("code") == 9999, str(env)[:300])

        # ---------- (iii) run_check per check ----------
        _, php_gen = call(PHP_DEV, php_op, php_cj, "admin", "security", "run_check", {"id": "generalCheck"})
        _, ts_gen = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {"id": "generalCheck"})
        check("run_check generalCheck ts==php", ts_gen == php_gen,
              f"php={json.dumps(php_gen)[:300]} ts={json.dumps(ts_gen)[:300]}")
        _, php_web = call(PHP_DEV, php_op, php_cj, "admin", "security", "run_check", {"id": "webserver"})
        _, ts_web = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {"id": "webserver"})
        check("run_check webserver ts==php (same config-url origin)", ts_web == php_web,
              f"php={json.dumps(php_web)[:400]} ts={json.dumps(ts_web)[:400]}")
        _, ts_ret_pv = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {"id": "phpVersion"})
        check("run_check phpVersion retired shape",
              (ts_ret_pv.get("result") or {}).get("retired") is True
              and (ts_ret_pv.get("result") or {}).get("id") == "phpVersion"
              and "name" not in (ts_ret_pv.get("result") or {})
              and ((ts_ret_pv.get("result") or {}).get("message", "").startswith("Retired:")),
              str(ts_ret_pv)[:300])
        _, ts_ret_df = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {"id": "dangerousFunctions"})
        check("run_check dangerousFunctions retired shape",
              (ts_ret_df.get("result") or {}).get("retired") is True
              and (ts_ret_df.get("result") or {}).get("id") == "dangerousFunctions"
              and ((ts_ret_df.get("result") or {}).get("message", "").startswith("Retired:")),
              str(ts_ret_df)[:300])
        _, php_unk = call(PHP_DEV, php_op, php_cj, "admin", "security", "run_check", {"id": "nope"})
        _, ts_unk = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {"id": "nope"})
        check("run_check unknown ts==php", ts_unk == php_unk, f"php={php_unk} ts={ts_unk}")
        _, php_case = call(PHP_DEV, php_op, php_cj, "admin", "security", "run_check", {"id": "GeneralCheck"})
        _, ts_case = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {"id": "GeneralCheck"})
        check("run_check case-variant ts==php (case-sensitive)", ts_case == php_case,
              f"php={php_case} ts={ts_case}")
        _, php_mid = call(PHP_DEV, php_op, php_cj, "admin", "security", "run_check", {})
        _, ts_mid = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_check", {})
        check("run_check missing id ts==php", ts_mid == php_mid, f"php={php_mid} ts={ts_mid}")

        # ---------- (iv) run_checks full map ----------
        _, php_all = call(PHP_DEV, php_op, php_cj, "admin", "security", "run_checks", {})
        _, ts_all = ts_call(ts_op, ts_cj, TS_DEV, "admin", "security", "run_checks", {})
        php_list, ts_list = php_all.get("result") or [], ts_all.get("result") or []
        check("run_checks order + ids",
              [e.get("id") for e in ts_list] == [e.get("id") for e in php_list]
              == ["dangerousFunctions", "generalCheck", "phpVersion", "webserver"],
              f"php={[e.get('id') for e in php_list]} ts={[e.get('id') for e in ts_list]}")
        check("run_checks names match",
              [e.get("name") for e in ts_list] == [e.get("name") for e in php_list],
              f"php={[e.get('name') for e in php_list]} ts={[e.get('name') for e in ts_list]}")
        by_id_ts = {e.get("id"): e for e in ts_list}
        by_id_php = {e.get("id"): e for e in php_list}
        check("run_checks generalCheck entry ts==php",
              by_id_ts.get("generalCheck") == by_id_php.get("generalCheck"),
              f"php={by_id_php.get('generalCheck')} ts={by_id_ts.get('generalCheck')}")
        check("run_checks webserver entry ts==php",
              by_id_ts.get("webserver") == by_id_php.get("webserver"),
              f"php={by_id_php.get('webserver')} ts={by_id_ts.get('webserver')}")
        check("run_checks retired entries present + marked",
              by_id_ts.get("phpVersion", {}).get("retired") is True
              and by_id_ts.get("dangerousFunctions", {}).get("retired") is True
              and len(ts_list) == 4,
              str(by_id_ts.get("phpVersion"))[:200])

        # ---------- (v) permissions ----------
        op_u, cj_u = make_opener()
        _, env = ts_call(op_u, cj_u, TS_DEV, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
        check("perm unauthenticated admin call 201 (TS)",
              is_err(env, "Authentication Failed", 201), str(env)[:200])
        op_c, cj_c = fresh(PHP_DEV)
        login(op_c, cj_c, PHP_DEV, "phase0.client@example.com", "Phase0-Client!42", api="client")
        # Client-role session calling the admin role: TS gate 1 -> 201.
        _, ts_env_c = ts_call(op_c, cj_c, TS_DEV, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
        check("perm client-role admin call 201 (TS)", is_err(ts_env_c, "Authentication Failed", 201),
              str(ts_env_c)[:200])
        h = bcrypt_hash(PW)
        crafted = []
        for name, perms in (("nosec", {"support": {"access": True, "view": True}}),
                            ("access", {"security": {"access": True}}),
                            ("view", {"security": {"access": True, "view": True}})):
            exec_sql("INSERT INTO admin_group (name, system_name, permissions, protected, parent_id, created_at, updated_at)"
                     " VALUES (?, ?, ?, 0, NULL, datetime('now'), datetime('now'))",
                     (f"Par42 {name}", f"par42_{name}", json.dumps(perms)))
            gid = q("SELECT id FROM admin_group WHERE system_name = ?", (f"par42_{name}",))[0]["id"]
            group_ids.append(gid)
            exec_sql("INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
                     " VALUES (?, ?, ?, 'active', '', 'UTC', datetime('now'), datetime('now'))",
                     (f"par42{name}@example.com", h, f"Par42 {name}"))
            sid = q("SELECT id FROM admin WHERE email = ?", (f"par42{name}@example.com",))[0]["id"]
            staff_ids.append(sid)
            crafted.append((name, sid, gid))
            exec_sql("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at)"
                     " VALUES (?, ?, datetime('now'))", (sid, gid))
        for name, sid, gid in crafted:
            for stack in ("php", "ts"):
                oo, cc = fresh(PHP_DEV)
                login(oo, cc, PHP_DEV, f"par42{name}@example.com", PW)
                if stack == "php":
                    _, e_ip = call(PHP_DEV, oo, cc, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
                    _, e_rc = call(PHP_DEV, oo, cc, "admin", "security", "run_check", {"id": "generalCheck"})
                else:
                    _, e_ip = ts_call(oo, cc, TS_DEV, "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
                    _, e_rc = ts_call(oo, cc, TS_DEV, "admin", "security", "run_check", {"id": "generalCheck"})
                if name == "nosec":
                    check(f"perm {name} ip_lookup 725 ({stack})",
                          is_err(e_ip, "You do not have access to the security module", 725), str(e_ip)[:200])
                    check(f"perm {name} run_check 725 ({stack})",
                          is_err(e_rc, "You do not have access to the security module", 725), str(e_rc)[:200])
                elif name == "access":
                    check(f"perm {name} ip_lookup 403 view ({stack})",
                          is_err(e_ip, 'You need the "security.view" permission to perform this action', 403),
                          str(e_ip)[:200])
                    check(f"perm {name} run_check 403 run_checks ({stack})",
                          is_err(e_rc, 'You need the "security.run_checks" permission to perform this action', 403),
                          str(e_rc)[:200])
                else:
                    check(f"perm {name} ip_lookup ok ({stack})", e_ip.get("error") is None, str(e_ip)[:200])
                    check(f"perm {name} run_check 403 run_checks ({stack})",
                          is_err(e_rc, 'You need the "security.run_checks" permission to perform this action', 403),
                          str(e_rc)[:200])

        # ---------- (vi) accounting ----------
        acct = subprocess.run(["python3", ACCT], capture_output=True, text=True)
        m = {}
        for line in acct.stdout.splitlines():
            mm = re.match(r"(resolving in TS|removed \(errors\)|deferred to R5|still proxied):\s+(\d+)", line)
            if mm:
                m[mm.group(1)] = int(mm.group(2))
        check("accounting 548+31+0 exit 0",
              acct.returncode == 0 and m.get("resolving in TS") == 548
              and m.get("removed (errors)") == 31 and m.get("deferred to R5") == 0
              and m.get("still proxied") == 0,
              f"rc={acct.returncode} {m} {acct.stdout[:200]}")
    finally:
        for sid in staff_ids:
            exec_sql("DELETE FROM admin_group_member WHERE admin_id = ?", (sid,))
            exec_sql("DELETE FROM admin WHERE id = ?", (sid,))
        for gid in group_ids:
            exec_sql("DELETE FROM admin_group WHERE id = ?", (gid,))
        for cid in ({r["id"] for r in q("SELECT id FROM cart")} - cart_ids_start):
            exec_sql("DELETE FROM cart WHERE id = ?", (cid,))
        exec_sql("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cart'", (cart_seq_start,))
        if nodb_proc is not None:
            try:
                nodb_proc.send_signal(signal.SIGTERM)
                nodb_proc.wait(timeout=10)
            except Exception:
                try:
                    nodb_proc.kill()
                except Exception:
                    pass
        fuser_kill(3004)
        for d in (nodb_dir_empty, nodb_dir_country):
            try:
                for f in os.listdir(d):
                    p = os.path.join(d, f)
                    if os.path.islink(p) or os.path.isfile(p):
                        os.unlink(p)
                os.rmdir(d)
            except Exception:
                pass

    # ---------- (vii) restore ----------
    inv_after = inv_snapshot()
    for k in ("invoice", "client_order", "email_queue", "service_custom", "extension", "extension_meta",
              "setting", "admin", "admin_group", "admin_group_member", "currency", "client",
              "support_ticket", "tld", "activity_client_email", "invoice_event", "client_order_meta",
              "cart", "cart_seq", "counters", "config_hash"):
        check(f"inv-after {k}", inv_after[k] == inv_before[k], f"before={inv_before[k]} after={inv_after[k]}")
    check("inv-after queue split", inv_after["queue_split"] == inv_before["queue_split"],
          f"{inv_after['queue_split']}")
    try:
        op, cj = make_opener()
        st, _ = ts_call(op, cj, TS_DEV, "guest", "antispam", "recaptcha")
        check("ts :3001 still answers", st == 200, str(st))
    except Exception as e:
        check("ts :3001 still answers", False, str(e))
    for port in (8081, 18025, 18026, 3003, 3004):
        try:
            op, cj = make_opener()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/", method="GET")
            with op.open(req, timeout=3) as resp:
                check(f"port {port} down", False, f"answered {resp.status}")
        except Exception:
            check(f"port {port} down", True)

    print(f"\nparity42: {len(checks) - len(failures)}/{len(checks)} passed")
    if failures:
        print(f"FAILURES: {failures}")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
