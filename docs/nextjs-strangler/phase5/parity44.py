#!/usr/bin/env python3
"""Phase 5 R6a parity: seam cutover — TS 740, TS-native __prime,
PHP-down proof, page smoke with PHP down, FB_PUBLIC_URL repointing,
FB_PARITY removal.

Compares PHP (:8080, oracle) vs TS (:3001, /api/fb) envelopes — HTTP
status is NEVER compared (seam convention: TS envelopes are always
HTTP 200 except the R5g real 429; PHP renders 740 as 404, 201 as 401,
879 as 400).

PHP-DOWN sections (§2, §3, §4, §6) each stop :8080 in a try/finally
that restarts it (APP_ENV=dev, workers=4) and verifies 200 before
returning — the suite must NEVER leave :8080 down. The :3011
FB_PUBLIC_URL instance and the :18025 mock SMTP sink are likewise
suite-owned and killed in finally.

Mutations are narrow and cleaned by id SETS (R5h lesson — never
id-range deletes): logins (session + PHP-login cart rows), one
restricted staff persona (+ membership), one probe email template
(+ queue rows), one mod_email config row (absent on the reference).
Invariants + config hash are asserted before AND after.
"""
import hashlib
import http.cookiejar
import json
import pathlib
import re
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001"
TS_API = TS + "/api/fb"
TS3011 = "http://127.0.0.1:3011"
TS3011_API = TS3011 + "/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
CLIENT_EMAIL = "phase0.client@example.com"
CLIENT_PASS = "Phase0-Client!42"
STAFF_EMAIL = "par44-staff@example.local"
STAFF_PASS = "Par44-Staff!42"
FIXED_TS = "2026-10-30 12:00:00"
MOCK_LOG = "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"
MOCK_PROC_LOG = "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock-server.log"
NEXT_LOG = "/home/hatch/scratch/fossbilling/r5-logs/next-3011-r6a.log"
PHP_LOG = "/home/hatch/scratch/fossbilling/r5-logs/php-8080-r6a.log"
REPO = "/home/hatch/scratch/fossbilling/repo"
RUNTIME_SRC = "/home/hatch/scratch/fossbilling/runtime/src"
FB_TS_MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,"
                 "custompages,email,extension,formbuilder,index,invoice,"
                 "massmailer,news,notification,order,page,product,profile,"
                 "redirect,security,seo,serviceapikey,servicecustom,"
                 "servicedomain,servicedownloadable,servicehosting,"
                 "servicelicense,staff,stats,support,system,theme,widgets")

CHECKS = 0
FAILURES = []


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"ok   {name}", flush=True)
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}", flush=True)


def check_env(name, php_env, ts_env):
    """Envelope equality (result + error), ignoring HTTP status."""
    check(name, php_env == ts_env,
          f"\n  php: {json.dumps(php_env, default=str)[:400]}"
          f"\n  ts : {json.dumps(ts_env, default=str)[:400]}")


def make_opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op._cj = cj  # login_ts reads the jar off the opener
    return op, cj


def jar_cookies(cj):
    return {c.name: c.value for c in cj}


def raw_headers(opener, url, method="GET", data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=headers or {})
    try:
        with opener.open(req, timeout=60) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def call(opener, token, base, role, module, method, data=None):
    """POST an API call. base=PHP uses /api, TS bases use /api/fb."""
    payload = dict(data or {})
    if token:
        payload["CSRFToken"] = token
    body = urllib.parse.urlencode(payload).encode()
    prefix = "/api" if base == PHP else "/api/fb"
    url = f"{base}{prefix}/{role}/{module}/{method}"
    try:
        with opener.open(urllib.request.Request(url, data=body, method="POST"),
                         timeout=60) as resp:
            raw, status = resp.read(), resp.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    try:
        parsed = json.loads(raw.decode())
    except Exception:
        parsed = {"_raw": raw[:200].decode("utf-8", "replace")}
    if not isinstance(parsed, dict):
        parsed = {"_non_dict": parsed}
    return parsed, status


def login_php(opener, email, password):
    """PHP login REQUIRES priming (capture47 lesson): GET /login first
    to seed session + csrf cookies, then POST presenting that token."""
    page = opener.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
    token = m.group(1) if m else ""
    payload = {"email": email, "password": password}
    if token:
        payload["CSRFToken"] = token
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST") \
        if "@phase0.local" in email or "par44" in email else \
        urllib.request.Request(f"{PHP}/api/guest/client/login", data=body, method="POST")
    with opener.open(req, timeout=60) as resp:
        parsed = json.loads(resp.read().decode())
    assert parsed.get("error") is None, f"PHP login failed for {email}: {parsed}"
    return token


def prime_ts(opener):
    """TS-native __prime: returns (status, headers, body)."""
    return raw_headers(opener, f"{TS_API}/__prime")


def login_ts(opener, email, password):
    """TS login via the primed csrf cookie: prime first (as the
    fixture runner and ensureCsrf do), then POST presenting it."""
    status, _headers, _ = prime_ts(opener)
    assert status == 200, f"__prime failed: {status}"
    csrf = None
    for c in opener._cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    payload = {"email": email, "password": password}
    if csrf:
        payload["CSRFToken"] = csrf
    body = urllib.parse.urlencode(payload).encode()
    endpoint = "guest/staff/login" if ("phase0.local" in email or "par44" in email) \
        else "guest/client/login"
    with opener.open(urllib.request.Request(f"{TS_API}/{endpoint}", data=body,
                                            method="POST"), timeout=60) as resp:
        parsed = json.loads(resp.read().decode())
    assert parsed.get("error") is None, f"TS login failed for {email}: {parsed}"
    # After login the jar holds the session csrf; return it for calls.
    for c in opener._cj:
        if c.name == "fossbilling_csrf":
            return c.value
    return csrf


def page(opener, base, path):
    return raw_headers(opener, f"{base}{path}")


def port_up(port):
    s = socket.socket()
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def wait_port(port, want_up, tries=60):
    for _ in range(tries):
        if port_up(port) == want_up:
            return True
        time.sleep(0.25)
    return port_up(port) == want_up


def php_pids():
    out = subprocess.run(["fuser", "8080/tcp"], capture_output=True, text=True)
    return [p for p in out.stdout.split() if p.isdigit()]


def stop_php():
    for pid in php_pids():
        subprocess.run(["kill", pid], capture_output=True)
    assert wait_port(8080, False), ":8080 did not stop"
    # PHP's OPcache-delayed config reads are irrelevant here; the
    # danger is a stale listener, so require the port actually free.
    time.sleep(0.5)


def start_php():
    log = open(PHP_LOG, "ab")
    subprocess.Popen(
        ["/home/hatch/scratch/bin/php", "-S", "127.0.0.1:8080"],
        cwd=RUNTIME_SRC, stdout=log, stderr=subprocess.STDOUT,
        env={"APP_ENV": "dev", "PHP_CLI_SERVER_WORKERS": "4",
             "PATH": "/usr/local/bin:/usr/bin:/bin"})
    assert wait_port(8080, True), ":8080 did not restart"
    # The dev server must answer, not just listen.
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{PHP}/login", timeout=5) as resp:
                if resp.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise AssertionError(":8080 restarted but /login never answered 200")


class PhpDown:
    """Stop :8080 on entry, restart + verify 200 on exit, always."""

    def __enter__(self):
        stop_php()
        return self

    def __exit__(self, *exc):
        start_php()
        return False


def callback_salt():
    src = pathlib.Path(CFG).read_text()
    m = re.search(r"'salt'\s*=>\s*'([^']+)'", src)
    assert m, "salt not found in config.php"
    return m.group(1)


def start_next(port, extra_env):
    import os
    env = dict(os.environ)
    env.update({
        "TZ": "UTC",
        "FB_TS_MODULES": FB_TS_MODULES,
        "FB_DATABASE_PATH": DBP,
        "FB_PAYPAL_SKIP_VERIFY": "1",
        "FB_CALLBACK_SALT": callback_salt(),
        "FOSSBILLING_PHP_SRC": REPO + "/src",
    })
    env.update(extra_env)
    log = open(NEXT_LOG, "ab")
    proc = subprocess.Popen(["npx", "next", "start", "-p", str(port)],
                            cwd=REPO + "/apps/nextjs", stdout=log,
                            stderr=subprocess.STDOUT, env=env)
    assert wait_port(port, True), f":{port} did not start"
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.25)
    proc.kill()
    raise AssertionError(f":{port} started but / never answered 200")


def start_mock_smtp():
    subprocess.run(["fuser", "-k", "18025/tcp"], capture_output=True)
    assert wait_port(18025, False), ":18025 did not free"
    pathlib.Path(MOCK_LOG).write_text("")
    log = open(MOCK_PROC_LOG, "ab")
    proc = subprocess.Popen(["node", "smtp-mock-server.mjs", "18025", MOCK_LOG],
                            cwd=REPO + "/docs/nextjs-strangler/phase5",
                            stdout=log, stderr=subprocess.STDOUT)
    assert wait_port(18025, True), ":18025 mock did not start"
    return proc


def read_mock():
    out = []
    p = pathlib.Path(MOCK_LOG)
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def mock_for(recipient):
    return [m for m in read_mock()
            if m.get("type") == "accepted" and recipient in (m.get("rcptTo") or [])]


def bcrypt_hash(pw):
    out = subprocess.run(
        ["node", "-e",
         "const b=require('/home/hatch/scratch/fossbilling/repo/apps/nextjs/node_modules/bcryptjs');"
         f"console.log(b.hashSync({json.dumps(pw)}, 12))"],
        capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def invariants(d):
    q = lambda s: d.execute(s).fetchone()[0]
    return {
        "invoice": q("SELECT COUNT(*) FROM invoice"),
        "invoice_event": q("SELECT COUNT(*) FROM invoice_event"),
        "client_order": q("SELECT COUNT(*) FROM client_order"),
        "client_order_meta": q("SELECT COUNT(*) FROM client_order_meta"),
        "email_queue": q("SELECT COUNT(*) FROM email_queue"),
        "service_custom": q("SELECT COUNT(*) FROM service_custom"),
        "extension": q("SELECT COUNT(*) FROM extension"),
        "extension_meta": q("SELECT COUNT(*) FROM extension_meta"),
        "setting": q("SELECT COUNT(*) FROM setting"),
        "admin": q("SELECT COUNT(*) FROM admin"),
        "admin_group": q("SELECT COUNT(*) FROM admin_group"),
        "admin_group_member": q("SELECT COUNT(*) FROM admin_group_member"),
        "currency": q("SELECT COUNT(*) FROM currency"),
        "client": q("SELECT COUNT(*) FROM client"),
        "support_ticket": q("SELECT COUNT(*) FROM support_ticket"),
        "tld": q("SELECT COUNT(*) FROM tld"),
        "activity_client_email": q("SELECT COUNT(*) FROM activity_client_email"),
        "cart": q("SELECT COUNT(*) FROM cart"),
        "rate_limit_counter": q("SELECT COUNT(*) FROM rate_limit_counter"),
        "queue_pending": q("SELECT COUNT(*) FROM email_queue WHERE status='pending'"),
        "queue_sending": q("SELECT COUNT(*) FROM email_queue WHERE status='sending'"),
        "cart_seq": q("SELECT seq FROM sqlite_sequence WHERE name='cart'"),
        "starting_number": d.execute(
            "SELECT value FROM setting WHERE param='invoice_starting_number'").fetchone()[0],
        "overdue": d.execute(
            "SELECT value FROM setting WHERE param='invoice_overdue_invoked'").fetchone()[0],
        "last_cron": q("SELECT COUNT(*) FROM setting WHERE param='last_cron_exec'"),
        "config_hash": hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()[:16],
    }


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row

    def idset(table, col="id"):
        return {r[0] for r in d.execute(f"SELECT {col} FROM {table}")}

    def clean_new_rows():
        """Delete only rows created during this run (id-set diff)."""
        for table, ids in (("session", SESS_IDS), ("cart", CART_IDS),
                           ("admin", ADMIN_IDS),
                           ("admin_group_member", MEMBER_IDS),
                           ("email_template", TPL_IDS),
                           ("email_queue", QUEUE_IDS),
                           ("activity_client_email", ACT_IDS),
                           ("extension_meta", EXTMETA_IDS)):
            now = idset(table)
            for rid in sorted(now - ids):
                d.execute(f"DELETE FROM {table} WHERE id = ?", (rid,))
        d.commit()

    SESS_IDS = idset("session")
    CART_IDS = idset("cart")
    ADMIN_IDS = idset("admin")
    MEMBER_IDS = idset("admin_group_member")
    TPL_IDS = idset("email_template")
    QUEUE_IDS = idset("email_queue")
    ACT_IDS = idset("activity_client_email")
    EXTMETA_IDS = idset("extension_meta")

    inv_before = invariants(d)
    print("invariants-before:", json.dumps(inv_before), flush=True)
    check("§0 invariants-before counts",
          all(inv_before[k] == v for k, v in {
              "invoice": 323, "invoice_event": 776, "client_order": 11,
              "client_order_meta": 0, "email_queue": 67, "service_custom": 17,
              "extension": 6, "extension_meta": 3, "setting": 38, "admin": 2,
              "admin_group": 3, "admin_group_member": 1, "currency": 1,
              "client": 3, "support_ticket": 2, "tld": 1,
              "activity_client_email": 0, "cart": 283,
              "rate_limit_counter": 0, "queue_pending": 5, "queue_sending": 62,
              "starting_number": "358",
              "overdue": "2026-10-24 05:31:25", "last_cron": 0}.items()),
          json.dumps(inv_before))
    check("§0 config hash before", inv_before["config_hash"] == "6e3c529673c1d089",
          inv_before["config_hash"])
    print(f"§0 cart seq before: {inv_before['cart_seq']} "
          "(high-water mark; count 283 is the invariant)", flush=True)

    try:
        # ---------- §1: 740s + precedence (oracle comparison) ----------
        op_php, _ = make_opener()
        tok_php = login_php(op_php, SUPER_EMAIL, SUPER_PASS)
        op_ts, _ = make_opener()
        tok_ts = login_ts(op_ts, SUPER_EMAIL, SUPER_PASS)
        op_client_ts, _ = make_opener()
        tok_client_ts = login_ts(op_client_ts, CLIENT_EMAIL, CLIENT_PASS)
        op_anon_php, _ = make_opener()
        op_anon_ts, _ = make_opener()

        def both(role, module, method, opener_php, tok_p, opener_ts, tok_t, data=None):
            p_env, p_status = call(opener_php, tok_p, PHP, role, module, method, data)
            t_env, t_status = call(opener_ts, tok_t, TS, role, module, method, data)
            return p_env, t_env, p_status, t_status

        # 740 per role, exact PHP message shapes. Each role uses its
        # OWN session: an admin session calling a client-role endpoint
        # gets PHP 201 (identity/role mismatch), not 740.
        op_client_php0, _ = make_opener()
        tok_client_php0 = login_php(op_client_php0, CLIENT_EMAIL, CLIENT_PASS)
        op_client_ts0, _ = make_opener()
        tok_client_ts0 = login_ts(op_client_ts0, CLIENT_EMAIL, CLIENT_PASS)
        for role, op_p, tok_p, op_t, tok_t in (
                ("admin", op_php, tok_php, op_ts, tok_ts),
                ("client", op_client_php0, tok_client_php0,
                 op_client_ts0, tok_client_ts0),
                ("guest", op_anon_php, None, op_anon_ts, None)):
            mod = "invoice" if role != "guest" else "system"
            p_env, t_env, p_st, _ = both(role, mod, "zzz_nope", op_p, tok_p, op_t, tok_t)
            check_env(f"§1 740 {role}/{mod}/zzz_nope", p_env, t_env)
            check(f"§1 740 {role} code 740", t_env.get("error", {}).get("code") == 740,
                  str(t_env)[:200])
            role_title = {"admin": "Admin", "client": "Client", "guest": "Guest"}[role]
            check(f"§1 740 {role} message shape",
                  t_env.get("error", {}).get("message") ==
                  f"{role_title} API call zzz_nope does not exist in module {mod}",
                  str(t_env.get("error"))[:200])
            check(f"§1 740 {role} php http 404 (status divergence only)",
                  p_st == 404, f"php status {p_st}")
        # Bare method: PHP prefixes class_ so dispatch sees invoice_foo.
        p_env, t_env, _, _ = both("admin", "invoice", "foo", op_php, tok_php, op_ts, tok_ts)
        check_env("§1 bare method foo -> 740 stripped", p_env, t_env)
        check("§1 bare method message", t_env.get("error", {}).get("message") ==
              "Admin API call foo does not exist in module invoice", str(t_env)[:200])
        # Unknown / inactive module -> 715, NOT 740 (activation precedes
        # method existence in Dispatcher order).
        for mod in ("nosuchmod", "embed"):
            p_env, t_env, _, _ = both("admin", mod, "zzz_nope", op_php, tok_php, op_ts, tok_ts)
            check_env(f"§1 unknown/inactive module {mod} -> 715", p_env, t_env)
            check(f"§1 {mod} code 715", t_env.get("error", {}).get("code") == 715,
                  str(t_env)[:200])
        # Removal preempts 740 on TS (route hoist). PHP still implements
        # these, so PHP's shape is recorded, not compared.
        for role, mod, meth in (("admin", "system", "update_available"),
                                ("admin", "extension", "install"),
                                ("admin", "theme", "select"),
                                ("guest", "extension", "languages")):
            op_p, tok_p = (op_php, tok_php) if role == "admin" else (op_anon_php, None)
            op_t, tok_t = (op_ts, tok_ts) if role == "admin" else (op_anon_ts, None)
            p_env, t_env, _, _ = both(role, mod, meth, op_p, tok_p, op_t, tok_t)
            check(f"§1 removed {role}/{mod}/{meth} ts removal error",
                  t_env.get("error", {}).get("message") ==
                  f"Endpoint {role}/{mod}/{meth} was removed in the Next.js port.",
                  str(t_env)[:200])
            print(f"     php shape for removed {role}/{mod}/{meth}: "
                  f"{json.dumps(p_env)[:200]}", flush=True)
        # Handler-only exception: guest/system/template_exists is NOT
        # route-hoisted (stays a removal handler, gates run first).
        p_env, t_env, _, _ = both("guest", "system", "template_exists",
                                  op_anon_php, None, op_anon_ts, None)
        check("§1 template_exists ts removal error",
              t_env.get("error", {}).get("message") ==
              "Endpoint guest/system/template_exists was removed in the Next.js port.",
              str(t_env)[:200])
        print(f"     php shape for template_exists: {json.dumps(p_env)[:200]}", flush=True)
        # Literal __call -> 9998, NOT 740 (PHP crashes calling it).
        p_env, t_env, _, _ = both("admin", "servicecustom", "__call",
                                  op_php, tok_php, op_ts, tok_ts)
        check("§1 literal __call code 9998 both",
              p_env.get("error", {}).get("code") == 9998 and
              t_env.get("error", {}).get("code") == 9998,
              f"php={p_env.get('error')} ts={t_env.get('error')}")
        check("§1 literal __call ts message (path omitted)",
              "__call" in str(t_env.get("error", {}).get("message")) and
              "exactly 2 expected" in str(t_env.get("error", {}).get("message")),
              str(t_env.get("error"))[:300])
        # Magic fallback: unknown servicecustom method runs the handler.
        p_env, t_env, _, _ = both("admin", "servicecustom", "zzz_nope",
                                  op_php, tok_php, op_ts, tok_ts)
        check_env("§1 magic servicecustom unknown -> handler, not 740", p_env, t_env)
        # 201 preempts 740: client session on an admin call; anonymous
        # admin call. (Client login on PHP creates a cart row; cleaned
        # by id-set diff in finally.)
        op_client_php, _ = make_opener()
        tok_client_php = login_php(op_client_php, CLIENT_EMAIL, CLIENT_PASS)
        p_env, t_env, _, _ = both("admin", "invoice", "zzz_nope",
                                  op_client_php, tok_client_php,
                                  op_client_ts, tok_client_ts)
        check_env("§1 client session on admin call -> 201, not 740", p_env, t_env)
        p_env, t_env, _, _ = both("admin", "invoice", "zzz_nope",
                                  op_anon_php, None, op_anon_ts, None)
        check_env("§1 anonymous admin call -> 201, not 740", p_env, t_env)
        # Restricted staff (group 3 = support-only): 725 preempts 740
        # on an inaccessible module; 740 still fires on an accessible
        # one; 403 fires for a known guarded method it lacks.
        h = bcrypt_hash(STAFF_PASS)
        cur = d.cursor()
        cur.execute(
            "INSERT INTO admin (email, pass, name, status, signature, timezone, created_at, updated_at)"
            " VALUES (?, ?, ?, 'active', NULL, NULL, ?, ?)",
            (STAFF_EMAIL, h, "Par44 Staff", FIXED_TS, FIXED_TS))
        staff_id = cur.lastrowid
        cur.execute("INSERT INTO admin_group_member (admin_id, admin_group_id, created_at)"
                    " VALUES (?, 3, ?)", (staff_id, FIXED_TS))
        d.commit()
        op_staff_php, _ = make_opener()
        tok_staff_php = login_php(op_staff_php, STAFF_EMAIL, STAFF_PASS)
        op_staff_ts, _ = make_opener()
        tok_staff_ts = login_ts(op_staff_ts, STAFF_EMAIL, STAFF_PASS)
        p_env, t_env, _, _ = both("admin", "invoice", "zzz_nope",
                                  op_staff_php, tok_staff_php,
                                  op_staff_ts, tok_staff_ts)
        check_env("§1 restricted staff invoice unknown -> 725, not 740", p_env, t_env)
        p_env, t_env, _, _ = both("admin", "support", "zzz_nope",
                                  op_staff_php, tok_staff_php,
                                  op_staff_ts, tok_staff_ts)
        check_env("§1 restricted staff support unknown -> 740 (gates pass)", p_env, t_env)
        # With VALID params: PHP RequiredParams pass, then the method's
        # checkPermissions denies (403). With missing params PHP 9999s
        # at Dispatcher validation BEFORE the method's permission check
        # — a pre-existing TS/PHP ordering divergence (TS guards run
        # before handler param validation), so the probe MUST pass
        # params to compare the guard itself.
        p_env, t_env, _, _ = both("admin", "support", "canned_create",
                                  op_staff_php, tok_staff_php,
                                  op_staff_ts, tok_staff_ts,
                                  {"title": "Par44 probe", "category_id": 1})
        check_env("§1 restricted staff canned_create -> 403 (known method)", p_env, t_env)
        # Negative control: guest/system/version is NOT a PHP endpoint
        # (no version method in System Guest.php, not in the catalog) —
        # both stacks 740 it identically. (An earlier draft of this
        # suite wrongly expected a version string here.)
        p_env, t_env, _, _ = both("guest", "system", "version",
                                  op_anon_php, None, op_anon_ts, None)
        check_env("§1 guest/system/version -> 740 both (not an endpoint)", p_env, t_env)
        # Non-3-segment / invalid-role paths -> 879 on TS (PHP router
        # behavior; TS keeps HTTP-200 envelope per seam convention).
        for path in (["admin", "invoice"], ["admin", "invoice", "get_list", "extra"],
                     ["unknown"], ["root", "invoice", "get_list"]):
            status, _, raw = raw_headers(op_ts, f"{TS_API}/{'/'.join(path)}")
            try:
                env = json.loads(raw.decode())
            except Exception:
                env = {"_raw": raw[:200].decode("utf-8", "replace")}
            check(f"§1 879 /{'/'.join(path)}",
                  env.get("error", {}).get("code") == 879 and
                  env.get("error", {}).get("message") == f"Unknown API call {'/'.join(path)}",
                  f"status={status} env={str(env)[:200]}")

        # ---------- §2: __prime WITHOUT PHP ----------
        with PhpDown():
            op_prime, cj_prime = make_opener()
            status, headers, raw = prime_ts(op_prime)
            body = json.loads(raw.decode())
            cookies = jar_cookies(cj_prime)
            check("§2 prime status 200 + primed true",
                  status == 200 and body == {"primed": True}, f"{status} {body}")
            check("§2 prime sets fossbilling_csrf",
                  "fossbilling_csrf" in cookies and len(cookies["fossbilling_csrf"]) == 32,
                  str(cookies))
            check("§2 prime sets NO session cookie (csrf-only)",
                  "fossbilling_session" not in cookies, str(cookies))
            # The cookie must be browser-readable: no HttpOnly flag.
            set_cookie = ""
            # urllib hides raw Set-Cookie; re-fetch with a capturing opener.
            class Cap(urllib.request.BaseHandler):
                def http_response(self, req, resp):
                    self.captured = resp.headers.get_all("Set-Cookie") or []
                    return resp
            cap = Cap()
            op_cap = urllib.request.build_opener(cap)
            op_cap.open(f"{TS_API}/__prime", timeout=20)
            set_cookie = " ".join(cap.captured)
            check("§2 prime cookie browser-readable (no HttpOnly, Path=/)",
                  "HttpOnly" not in set_cookie and "Path=/" in set_cookie, set_cookie)
            # Primed login succeeds with PHP down (runner path).
            op_login, _ = make_opener()
            tok_login = login_ts(op_login, SUPER_EMAIL, SUPER_PASS)
            env, _ = call(op_login, tok_login, TS, "admin", "client", "get_list",
                          {"per_page": 1})
            check("§2 primed login + authenticated call with PHP down",
                  env.get("error") is None and isinstance(env.get("result"), dict),
                  str(env)[:200])
            # Browser path: prime, then a CSRF-header POST works.
            op_b, _ = make_opener()
            prime_ts(op_b)
            csrf = next(c.value for c in op_b._cj if c.name == "fossbilling_csrf")
            tok_b = login_ts(op_b, SUPER_EMAIL, SUPER_PASS)
            env, _ = call(op_b, tok_b, TS, "admin", "invoice", "get_list",
                          {"per_page": 1})
            check("§2 browser-pattern prime->login->POST with PHP down",
                  env.get("error") is None, str(env)[:200])
        check("§2 :8080 restarted after prime section", port_up(8080)
              and urllib.request.urlopen(f"{PHP}/login", timeout=10).status == 200)

        # ---------- §3: PHP-DOWN TS-only subset ----------
        with PhpDown():
            op_s, _ = make_opener()
            env, _ = call(op_s, None, TS, "guest", "system", "company", {})
            check("§3 guest company with PHP down",
                  env.get("error") is None and env.get("result", {}).get("www"),
                  str(env)[:200])
            env, _ = call(op_s, None, TS, "guest", "system", "locale", {})
            check("§3 guest locale with PHP down",
                  env.get("error") is None and env.get("result") is not None,
                  str(env)[:200])
            env, _ = call(op_s, None, TS, "guest", "system", "version", {})
            check("§3 guest version 740s with PHP down (not an endpoint)",
                  env.get("error", {}).get("code") == 740, str(env)[:200])
            tok_s = login_ts(op_s, SUPER_EMAIL, SUPER_PASS)
            env, _ = call(op_s, tok_s, TS, "admin", "client", "get_list", {"per_page": 2})
            check("§3 admin client get_list with PHP down",
                  env.get("error") is None and len(env.get("result", {}).get("list", [])) == 2,
                  str(env)[:300])
            env, _ = call(op_s, tok_s, TS, "admin", "invoice", "get_list", {"per_page": 2})
            check("§3 admin invoice get_list with PHP down",
                  env.get("error") is None and len(env.get("result", {}).get("list", [])) == 2,
                  str(env)[:300])
            env, _ = call(op_s, tok_s, TS, "admin", "order", "get_list", {"per_page": 2})
            check("§3 admin order get_list with PHP down",
                  env.get("error") is None and len(env.get("result", {}).get("list", [])) == 2,
                  str(env)[:300])
            env, _ = call(op_s, tok_s, TS, "admin", "invoice", "gateway_get", {"id": 1})
            check("§3 gateway_get with PHP down",
                  env.get("error") is None and "callback" in (env.get("result") or {}),
                  str(env)[:300])
            env, _ = call(op_s, tok_s, TS, "admin", "extension", "get_navigation", {})
            check("§3 get_navigation with PHP down",
                  env.get("error") is None and env.get("result") is not None,
                  str(env)[:300])
            env, _ = call(op_s, tok_s, TS, "admin", "invoice", "zzz_nope", {})
            check("§3 740 with PHP down",
                  env.get("error", {}).get("code") == 740, str(env)[:200])
            env, _ = call(op_s, tok_s, TS, "admin", "system", "update_available", {})
            check("§3 removal error with PHP down",
                  "was removed in the Next.js port" in str(env.get("error", {}).get("message")),
                  str(env)[:200])

        # ---------- §4: page smoke with PHP down ----------
        # Markers are matched against TAG-STRIPPED text: raw HTML splits
        # counts across elements ("323</strong> Invoices"), so a raw
        # substring search misses markers the page visibly renders
        # (capture47's probe stripped tags for the same reason).
        def visible(html):
            text = re.sub(r"<[^>]+>", " ", html)
            return re.sub(r"\s+", " ", text)
        with PhpDown():
            op_p, _ = make_opener()
            tok_p = login_ts(op_p, SUPER_EMAIL, SUPER_PASS)
            for path, markers in (
                    ("/admin/clients", ["Clients"]),
                    ("/admin", ["Admin dashboard", "323 Invoices"]),
                    ("/admin/invoices", ["Invoices"])):
                status, _, raw = page(op_p, TS, path)
                text = visible(raw.decode("utf-8", "replace"))
                check(f"§4 page {path} 200 + markers (PHP down)",
                      status == 200 and all(m in text for m in markers),
                      f"status={status} len={len(text)}")
            op_c, _ = make_opener()
            login_ts(op_c, CLIENT_EMAIL, CLIENT_PASS)
            status, _, raw = page(op_c, TS, "/dashboard")
            text = visible(raw.decode("utf-8", "replace"))
            check("§4 page /dashboard 200 + markers (PHP down)",
                  status == 200 and all(m in text for m in ("Dashboard", "Invoices", "Orders")),
                  f"status={status} len={len(text)}")
        check("§4 :8080 restarted after page smoke", port_up(8080)
              and urllib.request.urlopen(f"{PHP}/login", timeout=10).status == 200)

        # ---------- §5: FB_PUBLIC_URL repointing ----------
        # Unset case on the reference :3001 (SYSTEM_URL fallback).
        # Guest calls use an anonymous opener: attaching an admin
        # session's token to a guest call would CSRF-gate it.
        op_u, _ = make_opener()
        tok_u = login_ts(op_u, SUPER_EMAIL, SUPER_PASS)
        op_u_anon, _ = make_opener()
        env, _ = call(op_u_anon, None, TS, "guest", "system", "company", {})
        check("§5 unset: company www falls back to SYSTEM_URL :8080",
              (env.get("result") or {}).get("www") == "http://127.0.0.1:8080/",
              str(env.get("result"))[:200])
        env, _ = call(op_u, tok_u, TS, "admin", "invoice", "gateway_get", {"id": 1})
        check("§5 unset: gateway callback falls back to :8080",
              (env.get("result") or {}).get("callback") ==
              "http://127.0.0.1:8080/ipn.php?gateway_id=1",
              str(env.get("result"))[:200])
        env, _ = call(op_u, tok_u, TS, "admin", "extension", "get_navigation", {})
        nav = env.get("result") or {}
        nav_links = [v.get("uri") for v in
                     (nav.get("admin") if isinstance(nav, dict) else []) or []]
        # Navigation shape: dict of groups; collect every uri string.
        def collect_uris(node):
            out = []
            if isinstance(node, dict):
                for k, v in node.items():
                    if k == "uri" and isinstance(v, str):
                        out.append(v)
                    else:
                        out.extend(collect_uris(v))
            elif isinstance(node, list):
                for v in node:
                    out.extend(collect_uris(v))
            return out
        uris = collect_uris(nav)
        check("§5 unset: nav links fall back to :8080",
              len(uris) > 0 and all(u.startswith("http://127.0.0.1:8080/admin/")
                                    for u in uris),
              f"{len(uris)} uris, sample {uris[:3]}")
        # Set case on a separate :3011 instance (reference untouched).
        proc3011 = start_next(3011, {"FB_PUBLIC_URL": "http://127.0.0.1:3011"})
        mock_proc = None
        try:
            # login_ts primes against :3001; for :3011 prime directly.
            op_3, cj_3 = make_opener()
            status, _, raw = raw_headers(op_3, f"{TS3011_API}/__prime")
            assert status == 200, f":3011 prime failed: {status}"
            csrf3 = next(c.value for c in cj_3 if c.name == "fossbilling_csrf")
            body = urllib.parse.urlencode(
                {"email": SUPER_EMAIL, "password": SUPER_PASS,
                 "CSRFToken": csrf3}).encode()
            with op_3.open(urllib.request.Request(f"{TS3011_API}/guest/staff/login",
                                                 data=body, method="POST"),
                           timeout=60) as resp:
                parsed = json.loads(resp.read().decode())
            assert parsed.get("error") is None, f":3011 login failed: {parsed}"
            tok_3 = next(c.value for c in cj_3 if c.name == "fossbilling_csrf")
            op_3_anon, _ = make_opener()
            env, _ = call(op_3_anon, None, TS3011, "guest", "system", "company", {})
            check("§5 set: company www points at Next :3011",
                  (env.get("result") or {}).get("www") == "http://127.0.0.1:3011/",
                  str(env.get("result"))[:200])
            env, _ = call(op_3, tok_3, TS3011, "admin", "invoice", "gateway_get",
                          {"id": 1})
            check("§5 set: gateway callback points at Next :3011",
                  (env.get("result") or {}).get("callback") ==
                  "http://127.0.0.1:3011/ipn.php?gateway_id=1",
                  str(env.get("result"))[:200])
            env, _ = call(op_3, tok_3, TS3011, "admin", "extension", "get_navigation", {})
            uris = collect_uris(env.get("result"))
            check("§5 set: nav links point at Next :3011",
                  len(uris) > 0 and all(u.startswith("http://127.0.0.1:3011/admin/")
                                        for u in uris),
                  f"{len(uris)} uris, sample {uris[:3]}")
            env, _ = call(op_3, tok_3, TS3011, "admin", "extension", "get_list", {})
            icons = []
            res = env.get("result")
            items = res if isinstance(res, list) else \
                (res.get("list") if isinstance(res, dict) else [])
            for it in items or []:
                if isinstance(it, dict) and it.get("icon_url"):
                    icons.append(it["icon_url"])
            check("§5 set: extension icon_urls point at Next :3011",
                  len(icons) > 0 and all(u.startswith("http://127.0.0.1:3011//modules/")
                                         for u in icons),
                  f"{len(icons)} icons, sample {icons[:2]}")
            # Email probe: enabled custom template rendering both
            # origins, sent via mock SMTP, MIME must carry :3011.
            mock_proc = start_mock_smtp()
            cfg_payload = {"mailer": "smtp", "smtp_host": "127.0.0.1",
                           "smtp_port": "18025", "smtp_username": "",
                           "smtp_password": "", "log_enabled": "1",
                           "queue_once": "0", "time_limit": "5", "cancel_after": "5",
                           "ext": "mod_email"}
            env, _ = call(op_3, tok_3, TS3011, "admin", "extension", "config_save",
                          cfg_payload)
            assert env.get("error") is None, f"config_save failed: {env}"
            d.execute(
                "INSERT INTO email_template (action_code, category, enabled, is_custom,"
                " is_overridden, subject, content, description) VALUES (?,?,?,?,?,?,?,?)",
                ("par44_probe", "test", 1, 1, 0, "Par44 probe",
                 "{{ guest.system_company.www}}|{{ __baseUrl}}", ""))
            d.commit()
            env, _ = call(op_3, tok_3, TS3011, "admin", "email", "template_send",
                          {"code": "par44_probe", "to": "par44probe@example.com",
                           "send_now": True})
            check("§5 set: email probe template_send returns true",
                  env.get("result") is True, str(env)[:200])
            acc = mock_for("par44probe@example.com")
            check("§5 set: email probe delivered to mock",
                  len(acc) == 1, f"accepted={len(acc)}")
            blob = acc[0]["data"] if acc else ""
            check("§5 set: email MIME carries Next :3011 origin (both vars)",
                  blob.count("http://127.0.0.1:3011/") >= 2, blob[:400])
            check("§5 set: email MIME carries NO :8080 origin",
                  "127.0.0.1:8080" not in blob, blob[:400])
        finally:
            if mock_proc:
                mock_proc.kill()
                subprocess.run(["fuser", "-k", "18025/tcp"], capture_output=True)
            proc3011.kill()
            subprocess.run(["fuser", "-k", "3011/tcp"], capture_output=True)
            wait_port(3011, False)
            wait_port(18025, False)

        # ---------- §6: FB_PARITY disposition ----------
        out = subprocess.run(["grep", "-rn", "process.env.FB_PARITY",
                              REPO + "/apps/nextjs/src"],
                             capture_output=True, text=True)
        check("§6 no process.env.FB_PARITY reader left in src", out.stdout.strip() == "",
              out.stdout[:300])
        proc_par = start_next(3011, {"FB_PARITY": "1"})
        try:
            with PhpDown():
                op_par, cj_par = make_opener()
                status, _, _ = raw_headers(op_par, f"{TS3011_API}/__prime")
                csrf = next(c.value for c in cj_par if c.name == "fossbilling_csrf")
                body = urllib.parse.urlencode(
                    {"email": SUPER_EMAIL, "password": SUPER_PASS,
                     "CSRFToken": csrf}).encode()
                with op_par.open(urllib.request.Request(
                        f"{TS3011_API}/guest/staff/login", data=body,
                        method="POST"), timeout=60) as resp:
                    parsed = json.loads(resp.read().decode())
                assert parsed.get("error") is None, f":3011 parity login failed: {parsed}"
                tok_par = next(c.value for c in cj_par if c.name == "fossbilling_csrf")
                env, _ = call(op_par, tok_par, TS3011, "admin", "invoice",
                              "get_list", {"per_page": 1})
                check("§6 FB_PARITY=1 + PHP down: TS call still succeeds",
                      env.get("error") is None, str(env)[:200])
        finally:
            proc_par.kill()
            subprocess.run(["fuser", "-k", "3011/tcp"], capture_output=True)
            wait_port(3011, False)
        check("§6 :8080 restarted after FB_PARITY probe", port_up(8080)
              and urllib.request.urlopen(f"{PHP}/login", timeout=10).status == 200)
    finally:
        # ---------- §7: restore ----------
        clean_new_rows()
        inv_after = invariants(d)
        print("invariants-after:", json.dumps(inv_after), flush=True)
        same = all(inv_after[k] == inv_before[k]
                   for k in inv_before if k != "cart_seq")
        check("§7 invariants-after == before (counts + hash)",
              same and inv_after["config_hash"] == "6e3c529673c1d089",
              json.dumps({k: (inv_before[k], inv_after[k])
                          for k in inv_before
                          if k != "cart_seq" and inv_before[k] != inv_after[k]}))
        print(f"§7 cart seq before {inv_before['cart_seq']} after {inv_after['cart_seq']} "
              "(may advance from cleaned login rows; count must stay 283)", flush=True)
        check("§7 :8080 + :3001 answering",
              port_up(8080) and port_up(3001)
              and urllib.request.urlopen(f"{PHP}/login", timeout=10).status == 200
              and urllib.request.urlopen(f"{TS}/", timeout=10).status == 200)
        check("§7 :3011 + :18025 down",
              not port_up(3011) and not port_up(18025))
        d.close()

    print(f"\nparity44: {CHECKS - len(FAILURES)}/{CHECKS} passed", flush=True)
    if FAILURES:
        print("FAILURES:", FAILURES, flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
