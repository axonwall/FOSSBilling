#!/usr/bin/env python3
"""R4d parity: servicecustom plugin runtime (admin __call + client call).

Sections:
  A. Baselines + invariants before.
  B. Admin __call, both stacks, REAL rows (empty-plugin registry):
     empty params -> 'Order ID is required' (see the 7103 note below),
     forbidden-7 loop (all seven, 403 + exact substituted message),
     empty-plugin -> null (orders 1, 2, 3), not-found, no-service
     (orders 4, 167), literal __call -> 9998 via proxy (both stacks
     proxy, so full-envelope equality holds).
  C. Client call, both stacks (client 1): empty-plugin null, forbidden,
     missing method, missing order_id, not-found, no-service, plus
     logged-out 201s (client call and admin __call).
  D. Crafted rows (snapshot-restored): named-but-unregistered plugin
     -> null both stacks; suspended-with-service -> client 'Order is
     not activated' while admin -> null (the asymmetry case);
     expired-active-with-service -> client 'Subscription expired'
     while admin -> null; ownership rejection via a crafted client;
     permission denials (no-manage staff -> 403, support-only -> 725).
  E. 7103 documentation + secret scan over captured envelopes.
  F. Restore proof (snapshot restore + invariants + service_custom 17
     + crafted rows gone).

7103 NOTE (probed live 2026-10-28): 7103 'API call is missing
arguments' is UNREACHABLE via HTTP. PHP's dispatcher always wraps
[$data], so arguments[0] is always set; empty params yield 'Order ID
is required' (9999), never 7103. Faithful TS behavior: the HTTP
handler never throws 7103 (empty params -> order_id error, matching
PHP); the 7103 branch exists in dispatchCustomCall for callers passing
no arguments object at all and is proven at unit level only
(scripts/plugin-dispatch-test.mjs, P6). This suite asserts the
PHP-equivalent empty-params behavior on both stacks and documents the
correction; it does NOT force a 7103 on empty params (that would
diverge from live PHP).

Also documented: TS lowercases path segments, so a mixed-case spelling
of a forbidden method is refused by TS (403) while PHP would dispatch
it case-insensitively to the adapter. Inherited seam property, not an
R4d divergence for realistic (lowercase) usage; not asserted here.

Exit 0 only when every check passes.
"""
import http.cookiejar
import json
import re
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request

DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
CHECKS = 0
FAILURES = []
ENVELOPES = []
PERSONA_PASS = "Parity33-Persona!42"
FIXED_TS = "2026-10-28 12:00:00"


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def check_env(name, got, want):
    check(name, got == want, f"got={got} want={want}")


def find_secret_keys(obj, path="$"):
    hits = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if any(s in str(k).lower() for s in ("pass", "token", "salt", "secret", "api_key")):
                hits.append(f"{path}.{k}")
            hits += find_secret_keys(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits += find_secret_keys(v, f"{path}[{i}]")
    return hits


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(opener, email, password):
    resp = opener.open(PHP + "/login")
    token = re.search(rb'name="CSRFToken" value="([^"]+)"', resp.read()).group(1).decode()
    data = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password,
         "guest": json.dumps({"email": email, "password": password})}
    ).encode()
    req = urllib.request.Request(PHP + "/api/guest/client/login",
                                 data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def staff_login(opener, email, password):
    # The admin login page 404s under the PHP built-in server in this
    # runtime; the CSRF token is session-scoped, so /login's token
    # works for staff login too (probe-sc pattern).
    resp = opener.open(PHP + "/login")
    token = re.search(rb'name="CSRFToken" value="([^"]+)"', resp.read()).group(1).decode()
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(PHP + "/api/guest/staff/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def call(opener, token, base, role, module, method, params):
    # URLENCODED (parity31 pattern): PHP's CSRF check reads form
    # bodies, not JSON bodies. HTTPError-tolerant: PHP returns real
    # HTTP statuses for CSRF/auth failures while the envelope still
    # carries the comparable error.
    payload = dict(params)
    if token:
        payload["CSRFToken"] = token
    body = urllib.parse.urlencode(payload).encode()
    url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
    req = urllib.request.Request(url, data=body, method="POST")
    try:
        raw = opener.open(req).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    env = json.loads(raw)
    ENVELOPES.append(env)
    return env


def bcrypt_hash(password):
    return subprocess.run(
        ["node", "-e",
         "const b=require('bcryptjs');console.log(b.hashSync(process.argv[1],12))", password],
        cwd="/home/hatch/scratch/fossbilling/repo/apps/nextjs",
        capture_output=True, text=True, check=True).stdout.strip()


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    snaps = {}
    for t in tables:
        cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
    seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()

    def restore():
        for t in tables:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            d.executemany(
                f'INSERT INTO "{t}" (' + ",".join(cols) + ") VALUES (" + ",".join("?" * len(cols)) + ")",
                [tuple(r) for r in rows])
        d.execute("DELETE FROM sqlite_sequence")
        d.executemany("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", seq)
        d.commit()

    def invariants():
        q = lambda s: d.execute(s).fetchone()[0]
        got = (
            q("SELECT COUNT(*) FROM tld"), q("SELECT COUNT(*) FROM tld_registrar"),
            q("SELECT COUNT(*) FROM service_domain"), q("SELECT COUNT(*) FROM email_queue"),
            d.execute("SELECT value FROM setting WHERE id=52").fetchone()[0],
            q("SELECT COUNT(*) FROM invoice"), q("SELECT COUNT(*) FROM client_order"),
            q("SELECT COUNT(*) FROM admin"), q("SELECT COUNT(*) FROM admin_group"),
            q("SELECT COUNT(*) FROM admin_group_member"), q("SELECT COUNT(*) FROM support_ticket"),
            q("SELECT COUNT(*) FROM client"), q("SELECT COUNT(*) FROM service_downloadable"),
        )
        want = (1, 3, 0, 67, "2026-10-26 03:24:56", 323, 11, 2, 3, 1, 2, 3, 0)
        return got, want

    def ext_rows_set():
        return sorted(tuple(r) for r in d.execute(
            "SELECT type, name, status, version FROM extension"))

    def meta_keys():
        return sorted(tuple(r) for r in d.execute(
            "SELECT extension, meta_key FROM extension_meta"))

    def sc_rows():
        return d.execute("SELECT id, plugin FROM service_custom ORDER BY id").fetchall()

    try:
        # ---- A. baselines ----
        got, want = invariants()
        check("A invariants-before", got == want, f"got={got}")
        ext_before = ext_rows_set()
        check("A extension-rows-before", len(ext_before) == 6, str(ext_before))
        meta_before = meta_keys()
        check("A meta-keys-before", len(meta_before) == 3, str(meta_before))
        sc_before = sc_rows()
        check("A service_custom-17", len(sc_before) == 17, str(len(sc_before)))
        check("A service_custom-all-empty-plugin",
              all(r[1] in (None, "") for r in sc_before),
              str([tuple(r) for r in sc_before if r[1] not in (None, "")]))

        # ---- B. admin __call, both stacks, real rows ----
        op = make_opener()
        stok = staff_login(op, "admin@phase0.local", "Phase1-Admin!42")
        env_p = call(op, stok, PHP, "admin", "servicecustom", "probe_method", {})
        env_t = call(op, stok, TS, "admin", "servicecustom", "probe_method", {})
        check_env("B empty-params-php", env_p, {"result": None, "error": {"message": "Order ID is required", "code": 9999}})
        check_env("B empty-params-ts", env_t, {"result": None, "error": {"message": "Order ID is required", "code": 9999}})
        for m in ["delete", "cancel", "uncancel", "suspend", "unsuspend", "renew", "activate"]:
            for stack, base in (("php", PHP), ("ts", TS)):
                env = call(op, stok, base, "admin", "servicecustom", m,
                           {"order_id": "1"})
                check_env(f"B forbidden-{m}-{stack}", env,
                          {"result": None, "error": {"message": f"Custom plugin method {m} is forbidden", "code": 403}})
        for oid in ("1", "2", "3"):
            for stack, base in (("php", PHP), ("ts", TS)):
                env = call(op, stok, base, "admin", "servicecustom", "do_thing",
                           {"order_id": oid})
                check_env(f"B empty-plugin-order{oid}-{stack}", env, {"result": None, "error": None})
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(op, stok, base, "admin", "servicecustom", "do_thing",
                       {"order_id": "999999"})
            check_env(f"B not-found-{stack}", env, {"result": None, "error": {"message": "Order not found", "code": 9999}})
        for oid in ("4", "167"):
            for stack, base in (("php", PHP), ("ts", TS)):
                env = call(op, stok, base, "admin", "servicecustom", "do_thing",
                           {"order_id": oid})
                check_env(f"B no-service-order{oid}-{stack}", env,
                          {"result": None, "error": {"message": "Order is not activated", "code": 9999}})
        env_p = call(op, stok, PHP, "admin", "servicecustom", "__call", {"order_id": "1"})
        env_t = call(op, stok, TS, "admin", "servicecustom", "__call", {"order_id": "1"})
        check_env("B literal-__call-php", env_p, env_t)
        check("B literal-__call-9998",
              env_p.get("error", {}).get("code") == 9998
              and env_p.get("error", {}).get("message", "").startswith("Too few arguments"),
              str(env_p)[:300])

        # ---- C. client call, both stacks, client 1 ----
        opc = make_opener()
        ctok = login(opc, "phase0.client@example.com", "Phase0-Client!42")
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(opc, ctok, base, "client", "servicecustom", "call",
                       {"order_id": "1", "method": "do_thing"})
            check_env(f"C empty-plugin-{stack}", env, {"result": None, "error": None})
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(opc, ctok, base, "client", "servicecustom", "call",
                       {"order_id": "1", "method": "cancel"})
            check_env(f"C forbidden-client-{stack}", env,
                      {"result": None, "error": {"message": "Custom plugin method cancel is forbidden", "code": 403}})
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(opc, ctok, base, "client", "servicecustom", "call", {"order_id": "1"})
            check_env(f"C missing-method-{stack}", env,
                      {"result": None, "error": {"message": "Method is required", "code": 9999}})
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(opc, ctok, base, "client", "servicecustom", "call", {"method": "do_thing"})
            check_env(f"C missing-order-{stack}", env,
                      {"result": None, "error": {"message": "Order ID is required", "code": 9999}})
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(opc, ctok, base, "client", "servicecustom", "call",
                       {"order_id": "999999", "method": "do_thing"})
            check_env(f"C not-found-{stack}", env, {"result": None, "error": {"message": "Order not found", "code": 9999}})
        for oid in ("4", "167"):
            for stack, base in (("php", PHP), ("ts", TS)):
                env = call(opc, ctok, base, "client", "servicecustom", "call",
                           {"order_id": oid, "method": "do_thing"})
                check_env(f"C no-service-order{oid}-{stack}", env,
                          {"result": None, "error": {"message": "Order is not activated", "code": 9999}})
        # Logged-out 201s. Fresh opener PER STACK: a PHP call primes
        # the jar with an anonymous session cookie, which would make
        # the TS call fail CSRF (403) instead of returning 201.
        for stack, base in (("php", PHP), ("ts", TS)):
            op_anon = make_opener()
            env = call(op_anon, "x", base, "client", "servicecustom", "call",
                       {"order_id": "1", "method": "do_thing"})
            check_env(f"C logged-out-client-{stack}", env,
                      {"result": None, "error": {"message": "Authentication Failed", "code": 201}})
        for stack, base in (("php", PHP), ("ts", TS)):
            op_anon = make_opener()
            env = call(op_anon, "x", base, "admin", "servicecustom", "do_thing",
                       {"order_id": "1"})
            check_env(f"C logged-out-admin-{stack}", env,
                      {"result": None, "error": {"message": "Authentication Failed", "code": 201}})

        # ---- D. crafted rows + personas ----
        pw_hash = bcrypt_hash(PERSONA_PASS)
        cur = d.execute(
            "INSERT INTO admin_group (name, permissions) VALUES (?, ?)",
            ("R33 SC Access", json.dumps({"servicecustom": {"access": True}})))
        g_nom = cur.lastrowid
        cur = d.execute(
            "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
            ("r33-scaccess@example.local", pw_hash, "R33 SC Access"))
        a_nom = cur.lastrowid
        d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                  (a_nom, g_nom))
        cur = d.execute(
            "INSERT INTO admin (system_name, email, pass, name, status) VALUES (NULL, ?, ?, ?, 'active')",
            ("r33-support@example.local", pw_hash, "R33 Support"))
        a_sup = cur.lastrowid
        d.execute("INSERT INTO admin_group_member (admin_id, admin_group_id) VALUES (?, ?)",
                  (a_sup, 3))
        cur = d.execute(
            "INSERT INTO client (email, pass, first_name, last_name) VALUES (?, ?, ?, ?)",
            ("r33-owner@example.local", pw_hash, "R33", "Owner"))
        crafted_client = cur.lastrowid

        def mk_order(status, expires, plugin, plugin_config):
            cur = d.execute(
                "INSERT INTO service_custom (client_id, plugin, plugin_config, config, created_at, updated_at)"
                " VALUES (1, ?, ?, '{}', ?, ?)", (plugin, plugin_config, FIXED_TS, FIXED_TS))
            sid = cur.lastrowid
            cur = d.execute(
                "INSERT INTO client_order (client_id, product_id, title, currency, price, period, quantity,"
                " status, service_type, service_id, config, expires_at, created_at, updated_at)"
                " VALUES (1, 2, 'R33 crafted', 'USD', 10, '1M', 1, ?, 'custom', ?, '{}', ?, ?, ?)",
                (status, sid, expires, FIXED_TS, FIXED_TS))
            return cur.lastrowid

        oid_missing = mk_order("active", None, "R4dMissingPlugin", "{}")
        oid_susp = mk_order("suspended", None, "", "{}")
        oid_exp = mk_order("active", "2020-01-01 00:00:00", "", "{}")
        d.commit()

        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(op, stok, base, "admin", "servicecustom", "do_thing",
                       {"order_id": str(oid_missing)})
            check_env(f"D missing-plugin-admin-{stack}", env, {"result": None, "error": None})
            env = call(opc, ctok, base, "client", "servicecustom", "call",
                       {"order_id": str(oid_missing), "method": "do_thing"})
            check_env(f"D missing-plugin-client-{stack}", env, {"result": None, "error": None})
            env = call(op, stok, base, "admin", "servicecustom", "do_thing",
                       {"order_id": str(oid_susp)})
            check_env(f"D suspended-admin-null-{stack}", env, {"result": None, "error": None})
            env = call(opc, ctok, base, "client", "servicecustom", "call",
                       {"order_id": str(oid_susp), "method": "do_thing"})
            check_env(f"D suspended-client-not-activated-{stack}", env,
                      {"result": None, "error": {"message": "Order is not activated", "code": 9999}})
            env = call(op, stok, base, "admin", "servicecustom", "do_thing",
                       {"order_id": str(oid_exp)})
            check_env(f"D expired-admin-null-{stack}", env, {"result": None, "error": None})
            env = call(opc, ctok, base, "client", "servicecustom", "call",
                       {"order_id": str(oid_exp), "method": "do_thing"})
            check_env(f"D expired-client-expired-{stack}", env,
                      {"result": None, "error": {"message": "Subscription expired", "code": 9999}})

        # Ownership rejection via the crafted client.
        op_own = make_opener()
        otok = login(op_own, "r33-owner@example.local", PERSONA_PASS)
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(op_own, otok, base, "client", "servicecustom", "call",
                       {"order_id": "1", "method": "do_thing"})
            check_env(f"D ownership-{stack}", env, {"result": None, "error": {"message": "Order not found", "code": 9999}})

        # Permission denials.
        op_nom = make_opener()
        ntok = staff_login(op_nom, "r33-scaccess@example.local", PERSONA_PASS)
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(op_nom, ntok, base, "admin", "servicecustom", "do_thing",
                       {"order_id": "1"})
            check_env(f"D nomange-403-{stack}", env,
                      {"result": None, "error": {"message": 'You need the "servicecustom.manage" permission to perform this action',
                                 "code": 403}})
        op_sup = make_opener()
        sutok = staff_login(op_sup, "r33-support@example.local", PERSONA_PASS)
        for stack, base in (("php", PHP), ("ts", TS)):
            env = call(op_sup, sutok, base, "admin", "servicecustom", "do_thing",
                       {"order_id": "1"})
            check_env(f"D supportonly-725-{stack}", env,
                      {"result": None, "error": {"message": "You do not have access to the servicecustom module", "code": 725}})

        # ---- E. secret scan ----
        hits = []
        for env in ENVELOPES:
            hits += find_secret_keys(env)
        check("E no-secret-keys-in-envelopes", hits == [], str(hits[:5]))
    finally:
        restore()
        got, want = invariants()
        check("F invariants-after-restore", got == want, f"got={got}")
        check("F extension-rows-after", ext_rows_set() == ext_before, str(ext_rows_set()))
        check("F meta-keys-after", meta_keys() == meta_before, str(meta_keys()))
        check("F service_custom-17-after", len(sc_rows()) == 17, str(len(sc_rows())))
        check("F crafted-rows-gone",
              d.execute("SELECT COUNT(*) FROM service_custom WHERE plugin='R4dMissingPlugin'").fetchone()[0] == 0
              and d.execute("SELECT COUNT(*) FROM client WHERE email='r33-owner@example.local'").fetchone()[0] == 0
              and d.execute("SELECT COUNT(*) FROM admin WHERE email LIKE 'r33-%'").fetchone()[0] == 0,
              "crafted rows remain")

    print(f"\nparity33: {CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("failures:", ", ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
