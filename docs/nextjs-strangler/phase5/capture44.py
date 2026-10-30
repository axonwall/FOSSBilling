#!/usr/bin/env python3
"""R5h capture44: PHP antispam behavior OBSERVED (prod oracle + dev split).

WHY TWO STACKS: on the :8081 prod oracle, guest signup / guest ticket
email validation runs Egulias DNSCheckValidation (production-only), and
sandbox DNS answers no MX/A records, so EVERY prod signup/ticket dies
with 'Email address is invalid' BEFORE any antispam check runs; the
prod client_signup budget (5/hour/IP) is also shared by all attempts.
Both are sandbox artifacts, not antispam behavior. The antispam code
path (Antispam/Service.php + the event dispatch in Client/Support
services) is identical on dev and prod, so:
- prod oracle (:8081): recaptcha defaults, blocked-IP on login
  (client + admin), blocked-IP on client profile update, blocked-IP
  on admin client update, admin-profile-update NOT gated (all clean:
  login validates with checkDNS=false, profile tests send no email).
- dev (:8080, limiter bypassed, RFC-only email validation): ALL
  signup / ticket / captcha / SFS / temp-email observations.

Config is crafted via PHP's own admin extension config_save (setConfig
REPLACES the whole config, so every config_save posts the full desired
config). Baseline extension_meta MUST be 3 rows at suite end: the
mod_antispam row is deleted in finally (capture19 pattern). Crafted
clients/tickets/cart rows are removed in finally; seeded client/admin
names are snapshot-restored.

NOT constructible in the sandbox (recorded as code-only, never faked):
- temp-email BLOCK message (live list fetch TLS-fails, so the list is
  never populated; the transport-error behavior IS observed instead),
- SFS flagged messages (SFS fetch never succeeds),
- captcha verify success / v3 score+action (verify POST never succeeds).

Oracle logins are kept minimal (api_login 10/hour enforced on :8081):
admin logs in ONCE via dev and the session is reused on the oracle
(shared session storage); the client persona logs in ONCE on the oracle
before any block is active, and that session is reused for profile tests.
"""
import http.cookiejar
import json
import os
import pathlib
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ORACLE = "http://127.0.0.1:8081"
DEV = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures44"
OUT.mkdir(exist_ok=True)
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SRC = "/home/hatch/scratch/fossbilling/runtime/src"
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PW = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PW = "Phase0-Client!42"
PW = "Cap44-Pass!42"

manifest = []
oracle_proc = None


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


def fresh(base):
    """One opener + its own jar, primed with the /login page (CSRF cookie)."""
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.open(f"{base}/login", timeout=30).read()
    return op, cj


def csrf_of(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return None


def call(base, op, cj, name, role, module, method, data=None):
    payload = dict(data or {})
    tok = csrf_of(cj)
    if tok:
        payload["CSRFToken"] = tok
    req = urllib.request.Request(
        f"{base}/api/{role}/{module}/{method}",
        data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=90) as resp:
            st, body = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        st, body = e.code, e.read()
    try:
        parsed = json.loads(body.decode())
        if not name.startswith("tmp_"):
            (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
            err = (parsed.get("error") or {})
            manifest.append({"name": name, "http": st, "error": err.get("message"),
                             "code": err.get("code"),
                             "result": str(parsed.get("result"))[:120]})
        print(f"{name}: http={st} err={(parsed.get('error') or {}).get('message')!r} "
              f"code={(parsed.get('error') or {}).get('code')} result={str(parsed.get('result'))[:80]}")
        return st, parsed
    except Exception:
        (OUT / f"{name}.txt").write_bytes(body)
        manifest.append({"name": name, "http": st, "error": None,
                         "raw": body[:200].decode("utf-8", "replace")})
        print(f"{name}: http={st} RAW {body[:200]!r}")
        return st, {"_raw": body[:200].decode("utf-8", "replace")}


def login(op, cj, base, api, email, password):
    payload = {"email": email, "password": password}
    tok = csrf_of(cj)
    if tok:
        payload["CSRFToken"] = tok
    req = urllib.request.Request(
        f"{base}/api/guest/{api}/login",
        data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=60) as resp:
            env = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        env = json.loads(e.read())
    assert env.get("error") is None, f"login failed for {email}: {env}"
    print(f"login ok: {email} via {base}")
    return env


def config_save(base, op, cj, cfg):
    data = {"ext": "mod_antispam"}
    data.update(cfg)
    _, env = call(base, op, cj, "tmp_config_save", "admin", "extension", "config_save", data)
    assert env.get("error") is None, f"config_save failed: {env}"


def signup(base, email, extra=None):
    op, cj = fresh(base)
    data = {"email": email, "first_name": "Cap44", "password": PW, "password_confirm": PW}
    data.update(extra or {})
    return call(base, op, cj, f"signup_{email.split('@')[0]}", "guest", "client", "create", data)


def ticket(base, email, subject, extra=None):
    op, cj = fresh(base)
    data = {"name": "Cap44", "email": email, "subject": subject, "content": "ticket body here"}
    data.update(extra or {})
    safe = subject.replace(" ", "_")
    return call(base, op, cj, f"ticket_{safe}", "guest", "support", "ticket_create", data)


def start_oracle():
    global oracle_proc
    env = dict(os.environ)
    env.pop("APP_ENV", None)
    oracle_proc = subprocess.Popen(
        ["/home/hatch/scratch/bin/php", "-S", "127.0.0.1:8081"],
        cwd=SRC, env={**env, "PHP_CLI_SERVER_WORKERS": "4"},
        stdout=open("/home/hatch/scratch/fossbilling/r5-logs/php-8081-r5h-capture.log", "w"),
        stderr=subprocess.STDOUT)
    for _ in range(30):
        try:
            urllib.request.urlopen(ORACLE + "/login", timeout=3).read()
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("oracle :8081 did not come up")


def main():
    global oracle_proc
    cart_ids = {r["id"] for r in q("SELECT id FROM cart")}
    cart_seq = q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"]
    client_row = q("SELECT id, first_name FROM client WHERE email = ?", (CLIENT_EMAIL,))[0]
    admin_row = q("SELECT id, name FROM admin WHERE email = ?", (ADMIN_EMAIL,))[0]
    print(f"snapshot: client {client_row} admin {admin_row} cart {len(cart_ids)} seq {cart_seq}")
    start_oracle()
    try:
        # ---------- PROD ORACLE: non-email-validated endpoints ----------
        op_a, cj_a = fresh(DEV)
        login(op_a, cj_a, DEV, "staff", ADMIN_EMAIL, ADMIN_PW)
        st, env = call(ORACLE, op_a, cj_a, "prod_admin_session_reuse", "admin", "antispam", "get_config")
        if env.get("error") is not None:
            print("dev session NOT reusable on oracle; logging in on oracle directly")
            op_a, cj_a = fresh(ORACLE)
            login(op_a, cj_a, ORACLE, "staff", ADMIN_EMAIL, ADMIN_PW)
        op_c, cj_c = fresh(ORACLE)
        login(op_c, cj_c, ORACLE, "client", CLIENT_EMAIL, CLIENT_PW)
        op_g, cj_g = fresh(ORACLE)
        call(ORACLE, op_g, cj_g, "prod_recaptcha_defaults", "guest", "antispam", "recaptcha")
        config_save(ORACLE, op_a, cj_a, {"block_ips": 1, "blocked_ips": "127.0.0.1"})
        op_x, cj_x = fresh(ORACLE)
        call(ORACLE, op_x, cj_x, "prod_client_login_blocked", "guest", "client", "login",
             {"email": CLIENT_EMAIL, "password": CLIENT_PW})
        op_x2, cj_x2 = fresh(ORACLE)
        call(ORACLE, op_x2, cj_x2, "prod_admin_login_blocked", "guest", "staff", "login",
             {"email": ADMIN_EMAIL, "password": ADMIN_PW})
        call(ORACLE, op_c, cj_c, "prod_client_profile_blocked", "client", "profile", "update",
             {"first_name": client_row["first_name"]})
        call(ORACLE, op_a, cj_a, "prod_admin_client_update_blocked", "admin", "client", "update",
             {"id": client_row["id"], "first_name": client_row["first_name"]})
        call(ORACLE, op_a, cj_a, "prod_admin_profile_blocked_ok", "admin", "profile", "update",
             {"name": admin_row["name"]})
        # Prod signup/ticket attempts are DNS-masked (run 1 recorded
        # 'Email address is invalid' for both; the budget then 429ed).
        # They are NOT repeated here: the block must be lifted before
        # any fresh login, and the dev section below covers them.
        config_save(ORACLE, op_a, cj_a, {"check_temp_emails": 0})

        # ---------- DEV: all signup / ticket / captcha / SFS / temp ----------
        # Reuse the already-logged-in sessions (shared session storage):
        # op_a is admin (dev login, oracle-reused), op_c is the client.
        op_d, cj_d = op_a, cj_a
        op_dc, cj_dc = op_c, cj_c

        # Blocked IP (dev REMOTE_ADDR is also 127.0.0.1).
        config_save(DEV, op_d, cj_d, {"block_ips": 1, "blocked_ips": "127.0.0.1"})
        signup(DEV, "cap44blocked@example.com")
        op_m, cj_m = fresh(DEV)
        call(DEV, op_m, cj_m, "signup_blocked_missing_first", "guest", "client", "create",
             {"email": "cap44blocked2@example.com", "password": PW, "password_confirm": PW})
        call(DEV, op_dc, cj_dc, "dev_client_profile_blocked", "client", "profile", "update",
             {"first_name": client_row["first_name"]})
        call(DEV, op_d, cj_d, "dev_admin_client_update_blocked", "admin", "client", "update",
             {"id": client_row["id"], "first_name": client_row["first_name"]})
        ticket(DEV, "cap44blocked@example.com", "cap44 blocked")
        call(DEV, op_d, cj_d, "dev_admin_profile_blocked_ok", "admin", "profile", "update",
             {"name": admin_row["name"]})
        call(DEV, op_d, cj_d, "dev_admin_client_create_blocked_ok", "admin", "client", "create",
             {"email": "cap44admincreated@example.com", "first_name": "Cap44",
              "password": PW, "send_welcome_email": 0})

        # Honeypot (temp check off so it cannot mask).
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0})
        op_h, cj_h = fresh(DEV)
        call(DEV, op_h, cj_h, "signup_honeypot_filled", "guest", "client", "create",
             {"email": "cap44honey@example.com", "first_name": "Cap44", "password": PW,
              "password_confirm": PW, "bio": "spammy bot text"})
        signup(DEV, "cap44honey0@example.com", {"bio": "0"})
        signup(DEV, "cap44honeyabsent@example.com")
        ticket(DEV, "cap44ticket@example.com", "cap44 honeypot ticket", {"bio": "spammy bot text"})
        # Blocked + existing email -> true (event never fires for existing accounts).
        config_save(DEV, op_d, cj_d, {"block_ips": 1, "blocked_ips": "127.0.0.1",
                                      "check_temp_emails": 0})
        signup(DEV, "cap44honeyabsent@example.com")

        # Captcha pre-network errors.
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0, "captcha_enabled": 1,
                                      "captcha_provider": "recaptcha_v2"})
        signup(DEV, "cap44capnokey@example.com")
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0, "captcha_enabled": 1,
                                      "captcha_provider": "recaptcha_v2",
                                      "captcha_recaptcha_privatekey": "dummy-test-key"})
        signup(DEV, "cap44capnotoken@example.com")
        signup(DEV, "cap44capverifytls@example.com", {"g-recaptcha-response": "dummy-test-token"})
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0, "captcha_enabled": 1,
                                      "captcha_provider": "turnstile"})
        signup(DEV, "cap44turnnosecret@example.com")
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0, "captcha_enabled": 1,
                                      "captcha_provider": "turnstile",
                                      "turnstile_secret_key": "dummy-test-key"})
        signup(DEV, "cap44turnnotoken@example.com")
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0, "captcha_enabled": 1,
                                      "captcha_provider": "hcaptcha"})
        signup(DEV, "cap44hcapnosecret@example.com")
        call(DEV, *fresh(DEV), "client_resetpw_captcha_nokey",
             "guest", "client", "reset_password", {"email": CLIENT_EMAIL})
        call(DEV, *fresh(DEV), "staff_resetpw_captcha_nokey",
             "guest", "staff", "passwordreset", {"email": ADMIN_EMAIL})

        # SFS transport behavior.
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0, "sfs": 1})
        signup(DEV, "cap44sfs@example.com")

        # Ordering: captcha-before-blocked (signup) vs blocked-first (ticket).
        config_save(DEV, op_d, cj_d, {"block_ips": 1, "blocked_ips": "127.0.0.1",
                                      "check_temp_emails": 0, "captcha_enabled": 1,
                                      "captcha_provider": "recaptcha_v2",
                                      "captcha_recaptcha_privatekey": "dummy-test-key"})
        signup(DEV, "cap44order@example.com", {"g-recaptcha-response": "dummy-test-token"})
        ticket(DEV, "cap44order@example.com", "cap44 order ticket",
               {"g-recaptcha-response": "dummy-test-token"})

        # Temp-email transport anchor: NO config row = all defaults.
        exec_sql("DELETE FROM extension_meta WHERE extension = 'mod_antispam'")
        signup(DEV, "cap44tempanchor@example.com")
        # Captcha-disabled default: token-less signup passes (temp check off).
        config_save(DEV, op_d, cj_d, {"check_temp_emails": 0})
        signup(DEV, "cap44captchadisabled@example.com")
    finally:
        try:
            exec_sql("DELETE FROM extension_meta WHERE extension = 'mod_antispam'")
            exec_sql("DELETE FROM client WHERE email LIKE 'cap44%@example.com'")
            exec_sql("DELETE FROM support_ticket_message WHERE support_ticket_id IN "
                     "(SELECT id FROM support_ticket WHERE subject LIKE 'cap44%')")
            exec_sql("DELETE FROM support_ticket WHERE subject LIKE 'cap44%'")
            new_cart = {r["id"] for r in q("SELECT id FROM cart")} - cart_ids
            for cid in new_cart:
                exec_sql("DELETE FROM cart WHERE id = ?", (cid,))
            exec_sql("UPDATE sqlite_sequence SET seq = ? WHERE name = 'cart'", (cart_seq,))
            exec_sql("UPDATE client SET first_name = ? WHERE id = ?",
                     (client_row["first_name"], client_row["id"]))
            exec_sql("UPDATE admin SET name = ? WHERE id = ?",
                     (admin_row["name"], admin_row["id"]))
            exec_sql("DELETE FROM client_password_reset WHERE client_id IN "
                     "(SELECT id FROM client WHERE email LIKE 'cap44%@example.com')")
            exec_sql("DELETE FROM email_queue WHERE recipient LIKE 'cap44%@example.com'")
        except Exception as e:
            print("RESTORE ERROR:", e)
        if oracle_proc is not None:
            try:
                oracle_proc.send_signal(signal.SIGTERM)
                oracle_proc.wait(timeout=10)
            except Exception:
                try:
                    oracle_proc.kill()
                except Exception:
                    pass
        print("extension_meta after restore:",
              q("SELECT extension, COUNT(*) c FROM extension_meta GROUP BY extension"))
        print("cart after restore:", q("SELECT COUNT(*) c FROM cart")[0]["c"],
              "seq:", q("SELECT seq FROM sqlite_sequence WHERE name = 'cart'")[0]["seq"])
        print("cap44 clients left:",
              q("SELECT COUNT(*) c FROM client WHERE email LIKE 'cap44%@example.com'")[0]["c"])
        print("cap44 tickets left:",
              q("SELECT COUNT(*) c FROM support_ticket WHERE subject LIKE 'cap44%'")[0]["c"])
        (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(f"manifest: {len(manifest)} calls -> {OUT}/manifest.json")


if __name__ == "__main__":
    main()
