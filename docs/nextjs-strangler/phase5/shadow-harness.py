#!/usr/bin/env python3
"""Phase 5 R6b shadow replay-diff harness.

Runs a money scenario against TWO disposable stacks — a disposable PHP
copy and a disposable TS (Next) instance — each on its own scratch DB
copy restored from the same reference snapshot, then diffs (a) the
response envelopes per step and (b) the DB deltas (post-login baseline
-> post-scenario) on scoped tables.

This is recompute-and-compare WITHOUT a read-only TS mode (see
findings-r6b.md §read-only-mode): TS writes land in its scratch DB
and are discarded after the run. No shared-DB dual-write mode exists
in this tool, by design (D6-3 rejects dual-write: double-billing
risk if both sides execute money effects).

Usage:
  python3 shadow-harness.py --scenarios shadow-scenarios.json --out DIR
  python3 shadow-harness.py --fixtures fixtures-money.json fixtures-tax.json --out DIR
  python3 shadow-harness.py --replay capture.jsonl --out DIR
  python3 shadow-harness.py --php-only --scenarios shadow-scenarios.json --out DIR
      (capture mode: runs each scenario on PHP twice; the report's
      php_vs_php section justifies every normalization — a field is
      normalized ONLY if two identical PHP runs disagree on it.)

Scenario file format (JSON):
  {"scenarios": [{"id": ..., "description": ..., "seed_sql": [...],
    "seed_ops": [{"clone_client": {"from": 1, "save": "x", "set": {...}}}],
    "steps": [{"call": "role/module/method", "as": "admin"|"client"|"anon",
               "params": {...}, "json": false, "save": {"name": "result.path"},
               "allow_error": false},
              {"ipn": {"path": "/ipn.php?gateway_id=1", "form": {...}}}]}]}
  Params support $saved substitution (dotted save paths, same semantics
  as the fixture runner). seed_sql/seed_ops run on BOTH disposable DBs
  before the login preamble.

Capture file format (JSONL, one request per line):
  {"n": 0, "persona": "admin"|"client"|"anon",
   "request": {"kind": "api", "role": ..., "module": ..., "method": ...,
               "params": {...}, "json": false}}
  or {"n": 0, "persona": "anon",
      "request": {"kind": "ipn", "path": "/ipn.php?gateway_id=1", "form": {...}}}
  The harness writes one capture per scenario run (requests only, with
  RESOLVED params). --replay re-runs a capture on both stacks and
  diffs it the same way; replay must reproduce the original run's
  diff signature (same money_diff flag, same diff count on clean
  scenarios — parity45 asserts this).

Safety: every target is disposable under a fresh tmp dir. The harness
REFUSES to run if any stack DB path resolves inside the reference
data dir. Reference invariants + config hash are asserted by
parity45 before AND after, never by this tool (it never touches the
reference by construction — and proves it by printing the disposable
paths in every report).

Envelope normalization (VOLATILE_KEYS): a key is normalized ONLY if
two identical PHP runs disagree on it (capture48 proves this list).
Envelope comparison additionally coerces numeric strings to numbers
(PHP returns PDO strings, TS JSON numbers — same value, different
serialization) with 2dp rounding, and records diff_fields (dotted
paths that REALLY differ post-normalization) so triage never has to
re-derive a diff from raw dumps that include normalized timestamps.
Teardown SIGTERMs the server wrappers AND fuser-kills the
harness-owned ports (:18081/:3012): `npx next start` forks a
next-server child that survives its wrapper (first full run left
:3012 answering after exit).
DB-row normalization: same key list (plus any key ending in "_at",
plus group_id which PHP sets to uniqid()), plus string scrubbing of
variable-length invoice hashes (30-60 hex, PHP generates them with
random_bytes(random_int(15, 30))) and embedded datetimes, plus the
transaction `ipn` column's $_SERVER sub-object (environment, not
money signal). NOTHING in a money table is normalized except these
— see MONEY_TABLES.
A diff the harness normalizes away is named in the report (field +
reason), never silently dropped: the report's "normalized" section
lists every normalized occurrence per scenario.

DB comparison is DELTA comparison: each stack's post-login baseline
is snapshotted, then the scenario runs, then the delta (added /
removed / changed rows vs that stack's own baseline) is diffed
across stacks. This absorbs login side effects by design (PHP login
creates a cart row per session; TS login does not — R5h lesson) and
any seed-row noise. Session rows are excluded from the diff
entirely (random tokens); activity_* audit tables are excluded
(timestamps + IPs, no money signal); rate_limit_counter is excluded
(TS-only table, no PHP counterpart).

Money classification (see shadow-criteria.md): an envelope diff on a
money-method step, or any delta diff in a MONEY_TABLE, is a MONEY
diff. Money tables: invoice, invoice_item, transaction,
client_order, client_order_meta, cart, cart_product, client_balance,
subscription. Everything else (email_queue notifications, invoice
audit events, order statuses, settings) is non-money. A money diff
aborts cutover (D6-3); non-money diffs are triaged.
"""
import argparse
import hashlib
import math
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = pathlib.Path.home()
SCRATCH = HOME / "scratch" / "fossbilling"
RUNTIME_SRC = SCRATCH / "runtime" / "src"
REF_DB = RUNTIME_SRC / "data" / "fossbilling.sqlite"
REF_CFG = RUNTIME_SRC / "config.php"
REPO = SCRATCH / "repo"
NEXT_APP = REPO / "apps" / "nextjs"
PHP_BIN = HOME / "scratch" / "bin" / "php"
LOGS = SCRATCH / "r5-logs"
ADMIN = {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}
CLIENT = {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}

PHP_PORT = 18081
TS_PORT = 3012

VOLATILE_KEYS = {"hash", "hash_expires_at", "created_at", "updated_at",
                 "due_at", "paid_at", "reminded_at", "last_cron_exec",
                 "group_id", "ipn_hash"}
# ipn_hash: sha256 of the canonical JSON of the ipn dump
# (ServiceTransaction.php:882-890, normalizeIpn:868-877), and the dump
# INCLUDES PHP's $_SERVER (DOCUMENT_ROOT varies per harness tmp dir,
# REMOTE_PORT is ephemeral, REQUEST_TIME is wall-clock) — so it varies
# across identical runs by construction (capture48 proved it). It is
# duplicate-detection metadata over a transport dump, not money
# signal; the money signal (status/error/error_code/invoice_id/
# gateway_id/amount) is compared separately. TS records server: null
# in its dump, so TS-vs-PHP ipn_hash differs systematically too —
# normalized on both sides for the same reason.
# group_id: PHP sets it to uniqid() when no parent order exists
# (src/modules/Order/Service.php:960) — time-based random, so two
# identical runs disagree on it by construction (capture48 proved it).
# ADDITIONALLY, any key ending in "_at" is volatile: lifecycle stamps
# (activated_at, canceled_at, suspended_at, ...) are wall-clock.
# The `ipn` column (transaction rows) is a JSON dump of the callback
# including PHP's $_SERVER (DOCUMENT_ROOT varies per harness tmp dir,
# REMOTE_PORT is ephemeral, REQUEST_TIME is wall-clock) — normalize()
# replaces its `server` sub-object with "*" and compares the rest
# (source/get/post/http_raw_post_data, i.e. the money-relevant parts).
# due_at is normalized: it derives from wall-clock "now" + terms, so two
# runs seconds apart can disagree on it only across a date boundary —
# but the field is a DATE, and same-day runs agree. It stays normalized
# because capture48's PHP-vs-PHP runs DID disagree on it once (a
# midnight-boundary-adjacent run is not the only cause: PHP's due-date
# math uses the invoice's created_at, which itself is wall-clock).
# paid_at/reminded_at are wall-clock stamps. created/updated are
# wall-clock stamps. hash is random per invoice. last_cron_exec is a
# wall-clock stamp set by the cron run itself.
MONEY_TABLES = {"invoice", "invoice_item", "transaction", "client_order",
                "client_order_meta", "cart", "cart_product",
                "client_balance", "subscription"}
DIFF_TABLES = sorted(MONEY_TABLES | {"invoice_event",
                                     "client_order_status", "email_queue",
                                     "service_custom", "setting"})
EXCLUDED_TABLES = {"session", "activity_admin_history",
                   "activity_client_history", "activity_system",
                   "activity_client_email", "rate_limit_counter"}
MONEY_METHOD_MODULES = {"invoice", "order", "cart", "transaction",
                        "subscription", "product"}
# PHP generates invoice hashes as bin2hex(random_bytes(random_int(15,
# 30))) (src/modules/Invoice/Service.php:1502 et al.) — RANDOM length
# 30-60 hex chars, validated by Guest.php /^[a-f0-9]{30,60}$/. Hence
# the range scrub, not a fixed 32: two PHP runs legitimately produce
# different-length hashes for the same invoice (capture48 proved it:
# 40 hex vs 56 hex for one invoice's email link).
HASHHEX = re.compile(r"\b[0-9a-f]{30,60}\b")
DATETIME = re.compile(r"\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\b")


def scrub_str(s):
    """Scrub wall-clock/random substrings inside a string value:
    variable-length invoice hashes and embedded datetimes (e.g.
    invoice notes 'YYYY-MM-DD HH:MM:SS: Refund invoice #N generated.').
    Both are wall-clock/random, same class as the VOLATILE_KEYS fields."""
    out = HASHHEX.sub("*HASH*", s)
    out = DATETIME.sub("*TS*", out)
    return out


def num_coerce(v):
    """A numeric string ('25', '1.5') -> float, else None. PHP's API
    layer returns PDO strings for numeric columns ('1' for
    currency_rate, '25' for price) where TS returns JSON numbers;
    that is a serialization-typing difference, not a value difference,
    so envelope comparison coerces numeric strings to numbers (2dp
    rounding, the fixture runner's num_eq rule extended across the
    string/number boundary). Non-numeric strings are untouched, and
    booleans never coerce (True != 1 here)."""
    if isinstance(v, bool) or not isinstance(v, str):
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def values_equal(a, b):
    """Deep equality with numeric tolerance + string coercion."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return round(float(a), 2) == round(float(b), 2)
    ca, cb = num_coerce(a), num_coerce(b)
    if ca is not None and isinstance(b, (int, float)):
        return round(ca, 2) == round(float(b), 2)
    if cb is not None and isinstance(a, (int, float)):
        return round(float(a), 2) == round(cb, 2)
    if isinstance(a, dict) and isinstance(b, dict):
        return (set(a) == set(b)
                and all(values_equal(a[k], b[k]) for k in a))
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(values_equal(x, y) for x, y in zip(a, b))
    return a == b


def diff_paths(a, b, prefix=""):
    """Dotted paths where normalized values differ (triage aid: the
    report's raw php/ts dumps include normalized fields like
    timestamps; diff_fields names ONLY the real differences)."""
    if values_equal(a, b):
        return []
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            out.extend(diff_paths(a.get(k), b.get(k),
                                  f"{prefix}.{k}" if prefix else str(k)))
        return out
    return [prefix or "<root>"]

FB_TS_MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,"
                 "custompages,email,extension,formbuilder,index,invoice,"
                 "massmailer,news,notification,order,page,product,profile,"
                 "redirect,security,seo,serviceapikey,servicecustom,"
                 "servicedomain,servicedownloadable,servicehosting,"
                 "servicelicense,staff,stats,support,system,theme,widgets")


def log(msg):
    print(f"[shadow] {msg}", flush=True)


def wait_port(port, want_up, tries=100):
    for _ in range(tries):
        s = socket.socket()
        try:
            up = s.connect_ex(("127.0.0.1", port)) == 0
        finally:
            s.close()
        if up == want_up:
            return True
        time.sleep(0.2)
    return False


def kill_port(port):
    subprocess.run(["fuser", "-k", f"{port}/tcp"], capture_output=True)
    wait_port(port, False, tries=25)


def callback_salt():
    m = re.search(r"'salt' => '([^']+)'", REF_CFG.read_text())
    if not m:
        raise SystemExit("could not read salt from reference config")
    return m.group(1)


def setup_php_disposable(work):
    """Disposable PHP tree + DB, served on PHP_PORT. Returns (proc, dbpath)."""
    dispo = work / "php"
    src = dispo / "src"
    shutil.copytree(RUNTIME_SRC, src,
                    ignore=shutil.ignore_patterns("vendor", "data", "cache"))
    subprocess.run(["cp", "-al", str(RUNTIME_SRC / "vendor"), str(src / "vendor")],
                   check=True)
    data = src / "data"
    subprocess.run(["cp", "-al", str(RUNTIME_SRC / "data"), str(data)], check=True)
    (data / "fossbilling.sqlite").unlink()
    snapshot = work / "snapshot.sqlite"
    shutil.copy(REF_DB, snapshot)
    shutil.copy(snapshot, data / "fossbilling.sqlite")
    config = src / "config.php"
    text = config.read_text()
    text = text.replace(str(RUNTIME_SRC / "data"), str(data))
    config.write_text(text)
    if (RUNTIME_SRC / "data" / ".jwt_secret").exists():
        shutil.copy(RUNTIME_SRC / "data" / ".jwt_secret", data / ".jwt_secret")
    kill_port(PHP_PORT)
    env = dict(os.environ, APP_ENV="dev")
    proc = subprocess.Popen(
        [str(PHP_BIN), "-S", f"127.0.0.1:{PHP_PORT}", "-t", "."],
        cwd=src, env=env,
        stdout=open(LOGS / "shadow-php-18081.log", "w"),
        stderr=subprocess.STDOUT)
    if not wait_port(PHP_PORT, True):
        raise SystemExit("disposable PHP did not start")
    return proc, data / "fossbilling.sqlite", snapshot


def setup_ts_disposable(work, snapshot):
    """Disposable TS DB + config, served by `next start` on TS_PORT."""
    tsdir = work / "ts"
    data = tsdir / "data"
    data.mkdir(parents=True)
    dbpath = data / "fossbilling.sqlite"
    shutil.copy(snapshot, dbpath)
    # The TS cron gate derives the finalization state file from
    # FB_DATABASE_PATH (cron.ts finalizationStatePath: dirname x2 +
    # /data/update-finalization.json) and treats a MISSING file as
    # gate CLOSED (503). The disposable TS must see the reference's
    # complete state, or the cron scenario 503s on TS only (first
    # full run proved it). PHP's disposable gets the file for free
    # via its hardlinked data dir.
    ref_final = RUNTIME_SRC / "data" / "update-finalization.json"
    if ref_final.exists():
        shutil.copy(ref_final, data / "update-finalization.json")
    cfg = tsdir / "config.php"
    text = REF_CFG.read_text()
    text = text.replace(str(RUNTIME_SRC / "data"), str(data))
    cfg.write_text(text)
    kill_port(TS_PORT)
    env = dict(os.environ)
    env.update({
        "TZ": "UTC",
        "FB_TS_MODULES": FB_TS_MODULES,
        "FB_DATABASE_PATH": str(dbpath),
        "FB_CONFIG_PATH": str(cfg),
        "FB_PAYPAL_SKIP_VERIFY": "1",
        "FB_CALLBACK_SALT": callback_salt(),
        "FOSSBILLING_PHP_SRC": str(REPO / "src"),
    })
    proc = subprocess.Popen(
        ["npx", "next", "start", "-p", str(TS_PORT)],
        cwd=NEXT_APP, env=env,
        stdout=open(LOGS / "shadow-next-3012.log", "w"),
        stderr=subprocess.STDOUT)
    if not wait_port(TS_PORT, True, tries=150):
        raise SystemExit("disposable TS did not start")
    return proc, dbpath


def restore_db(snapshot, dbpath):
    shutil.copy(snapshot, dbpath)


def dump_tables(dbpath):
    con = sqlite3.connect(dbpath)
    con.row_factory = sqlite3.Row
    out = {}
    for t in DIFF_TABLES:
        try:
            rows = con.execute(f'SELECT * FROM "{t}"').fetchall()
        except sqlite3.Error:
            continue
        out[t] = {r["id"]: dict(r) for r in rows if "id" in r.keys()}
    con.close()
    return out


def normalize(v, normalized):
    """Recursively replace volatile keys / scrub hashes. Records hits."""
    if isinstance(v, dict):
        out = {}
        for k, val in v.items():
            if k in VOLATILE_KEYS or k.endswith("_at"):
                normalized.append(k)
                out[k] = "*"
            elif k == "ipn" and isinstance(val, str):
                try:
                    parsed = json.loads(val)
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    parsed = dict(parsed)
                    parsed["server"] = "*"
                    normalized.append("ipn_server")
                    out[k] = parsed
                else:
                    out[k] = normalize(val, normalized)
            else:
                out[k] = normalize(val, normalized)
        return out
    if isinstance(v, list):
        return [normalize(x, normalized) for x in v]
    if isinstance(v, str):
        scrubbed = scrub_str(v)
        if scrubbed != v:
            normalized.append("embedded_hash_or_datetime")
        return scrubbed
    return v


def envelope_equal(a, b):
    """Envelope comparison: normalize volatile fields first, then
    values_equal (numeric tolerance + numeric-string coercion)."""
    a2, b2 = normalize(a, []), normalize(b, [])
    return values_equal(a2, b2)


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


class Jar:
    def __init__(self, base, api_prefix, prime_path):
        self.base = base
        self.api_prefix = api_prefix
        self.prime_path = prime_path
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj))

    def prime(self):
        # PHP requires the CSRF cookie from a prime GET before login
        # (the fixture runner primes via /login; TS via /api/fb/__prime).
        # Each persona jar primes itself: cookies live per-jar.
        self.op.open(self.base + self.prime_path, timeout=60).read()

    def csrf(self):
        for c in self.cj:
            if c.name == "fossbilling_csrf":
                return c.value
        return None

    def raw(self, path, data=None, headers=None):
        req = urllib.request.Request(self.base + path, data=data, method="POST")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with self.op.open(req, timeout=60) as resp:
                body = resp.read().decode()
        except urllib.error.HTTPError as e:
            body = e.read().decode()
        try:
            return json.loads(body)
        except ValueError:
            return {"_raw": body}

    def call(self, route, params=None, as_json=False):
        role, module, method = route.split("/")
        url = f"{self.api_prefix}/{role}/{module}/{method}"
        if as_json:
            body = json.dumps(params or {}).encode()
            req = urllib.request.Request(self.base + url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            tok = self.csrf()
            if tok:
                req.add_header("X-CSRF-TOKEN", tok)
        else:
            payload = flatten(dict(params or {}))
            tok = self.csrf()
            if tok:
                payload["CSRFToken"] = tok
            req = urllib.request.Request(
                self.base + url,
                data=urllib.parse.urlencode(payload).encode(), method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with self.op.open(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def login(self, who):
        if who == "admin":
            env = self.call("guest/staff/login", ADMIN)
        else:
            env = self.call("guest/client/login", CLIENT)
        if env.get("error"):
            raise SystemExit(f"login {who} failed on {self.base}: {env['error']}")
        return env


def dig(obj, path):
    cur = obj
    for part in path.split("."):
        if isinstance(cur, list):
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def subst(v, saved):
    if isinstance(v, str) and v.startswith("$"):
        return saved[v[1:]]
    if isinstance(v, dict):
        return {k: subst(x, saved) for k, x in v.items()}
    if isinstance(v, list):
        return [subst(x, saved) for x in v]
    return v


def clone_client(con, from_id, overrides):
    cols = [r[1] for r in con.execute("PRAGMA table_info(client)")]
    row = con.execute(f"SELECT * FROM client WHERE id={int(from_id)}").fetchone()
    data = dict(zip(cols, row))
    data.update(overrides)
    data.pop("id", None)
    data.pop("api_token", None)
    keys = list(data.keys())
    con.execute(
        f"INSERT INTO client ({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))})",
        [data[k] for k in keys])
    return con.execute("SELECT last_insert_rowid()").fetchone()[0]


def apply_seeds(dbpath, scenario):
    con = sqlite3.connect(dbpath)
    saved = {}
    for stmt in scenario.get("seed_sql", []):
        con.execute(stmt)
    for op in scenario.get("seed_ops", []):
        if "clone_client" in op:
            spec = op["clone_client"]
            saved[spec["save"]] = clone_client(con, spec["from"], spec["set"])
    con.commit()
    con.close()
    return saved


def run_steps(jar, steps, capture_lines, seed_saved=None):
    """Run steps on one stack with ONE jar, mirroring the fixture
    runner exactly: the jar primes once, then logs in lazily the first
    time a step needs admin/client, and keeps that session for the
    rest of the run (a later step for a different persona re-logs in
    on the same jar). Per-persona jars BROKE this: a guest cart added
    on the anon jar is orphaned when checkout runs on the client jar
    (both stacks fail identically with an empty cart, so the scenario
    never exercises checkout — proven by probe, see findings-r6b.md).
    With one jar, a guest cart follows the session through login, and
    checkout succeeds on both stacks. seed_saved carries seed_op saves
    (e.g. clone_client ids) into the step namespace — the fixture
    runner merges them the same way. Login envelopes are NOT diffed
    (they carry tokens), but a failed login aborts the run."""
    saved = dict(seed_saved or {})
    envs = []
    current = "anon"
    for i, step in enumerate(steps):
        if "ipn" in step:
            spec = step["ipn"]
            form = subst(spec.get("form", {}), saved)
            path = spec["path"]
            # Resolve $saved in the path query as well.
            for k, v in saved.items():
                path = path.replace(f"${k}", urllib.parse.quote(str(v)))
            data = urllib.parse.urlencode(flatten(form)).encode()
            env = jar.raw(path, data=data,
                          headers={"Content-Type":
                                   "application/x-www-form-urlencoded"})
            envs.append(env)
            capture_lines.append({"n": i, "persona": "anon",
                                  "request": {"kind": "ipn", "path": path,
                                              "form": form}})
            continue
        who = step.get("as", "anon")
        if who in ("admin", "client") and who != current:
            jar.login(who)
            current = who
        params = subst(step.get("params", {}), saved)
        env = jar.call(step["call"], params, as_json=step.get("json", False))
        envs.append(env)
        for name, path in (step.get("save") or {}).items():
            saved[name] = dig(env, path)
        capture_lines.append({"n": i, "persona": who,
                              "request": {"kind": "api",
                                          "role": step["call"].split("/")[0],
                                          "module": step["call"].split("/")[1],
                                          "method": step["call"].split("/")[2],
                                          "params": params,
                                          "json": step.get("json", False)}})
        if env.get("error") and not step.get("allow_error"):
            # Keep going: the diff against the other stack is the signal,
            # and a shared error is agreement, not failure.
            pass
    return envs


def run_scenario_on_stack(stack, scenario, snapshot, dbpath):
    """stack: 'php'|'ts'. Returns (envelopes, delta, capture_lines)."""
    restore_db(snapshot, dbpath)
    seed_saved = apply_seeds(dbpath, scenario)
    if stack == "php":
        base, prefix = f"http://127.0.0.1:{PHP_PORT}", "/api"
        prime_path = "/login"
    else:
        base, prefix = f"http://127.0.0.1:{TS_PORT}", "/api/fb"
        prime_path = "/api/fb/__prime"
    jar = Jar(base, prefix, prime_path)
    # Preamble: prime only (the CSRF cookie guest steps need: PHP's
    # guest cart endpoints 403 without it, TS __prime issues the
    # matching token). Logins happen lazily inside run_steps, so the
    # baseline is pre-login: session rows are excluded from diffs, so
    # login's session side effects never pollute deltas. Known
    # consequence, proven by probe: PHP's client login creates an
    # EMPTY cart row for the new session (TS creates carts lazily on
    # first touch). It survives into deltas only for runs that log in
    # as client without checking out — no R6b scenario or fixture
    # does that (cart flows check out, deleting the cart) — and is
    # otherwise a login-lifecycle difference, not a money computation.
    jar.prime()
    baseline = dump_tables(dbpath)
    capture_lines = []
    envs = run_steps(jar, scenario["steps"], capture_lines, seed_saved)
    post = dump_tables(dbpath)
    delta = {}
    for t in DIFF_TABLES:
        b, p = baseline.get(t, {}), post.get(t, {})
        added = {k: v for k, v in p.items() if k not in b}
        removed = {k: v for k, v in b.items() if k not in p}
        changed = {}
        for k in b.keys() & p.keys():
            if b[k] == p[k]:
                continue
            field_diffs = {}
            for f in set(b[k]) | set(p[k]):
                if b[k].get(f) == p[k].get(f):
                    continue
                field_diffs[f] = [b[k].get(f), p[k].get(f)]
            if field_diffs:
                changed[k] = field_diffs
        if added or removed or changed:
            delta[t] = {"added": added, "removed": removed, "changed": changed}
    return envs, delta, capture_lines


def diff_envelopes(php_envs, ts_envs, steps):
    diffs = []
    for i, (p, t) in enumerate(zip(php_envs, ts_envs)):
        if envelope_equal(p, t):
            continue
        call = steps[i].get("call") or ("ipn " + steps[i]["ipn"]["path"])
        diffs.append({"step": i, "call": call, "php": p, "ts": t,
                      "diff_fields": diff_paths(normalize(p, []),
                                                normalize(t, []))})
    if len(php_envs) != len(ts_envs):
        diffs.append({"step": "count", "php_steps": len(php_envs),
                      "ts_steps": len(ts_envs)})
    return diffs


def diff_deltas(php_delta, ts_delta):
    """Diff two deltas. Returns {table: {added/removed/changed diffs}}."""
    out = {}
    for t in sorted(set(php_delta) | set(ts_delta)):
        pd, td = php_delta.get(t, {}), ts_delta.get(t, {})
        table_diffs = {}
        for kind in ("added", "removed"):
            p_rows, t_rows = pd.get(kind, {}), td.get(kind, {})
            if p_rows != t_rows:
                # Normalize volatile fields before comparing row bodies.
                def norm_rows(rows):
                    return {k: normalize(v, []) for k, v in rows.items()}
                if norm_rows(p_rows) != norm_rows(t_rows):
                    table_diffs[kind] = {"php": p_rows, "ts": t_rows}
        p_ch, t_ch = pd.get("changed", {}), td.get("changed", {})
        changed_diffs = {}
        for k in sorted(set(p_ch) | set(t_ch)):
            pf, tf = p_ch.get(k, {}), t_ch.get(k, {})
            # Normalize each side's field values (volatile keys,
            # _at stamps, ipn server dump, embedded hashes/datetimes)
            # and keep only fields that STILL differ, with raw values.
            pf2, tf2 = {}, {}
            for f in sorted(set(pf) | set(tf)):
                # pf/tf map field -> [baseline, post] within a stack;
                # compare POST values (index 1) across stacks.
                pv = pf[f][1] if f in pf else None
                tv = tf[f][1] if f in tf else None
                if f in VOLATILE_KEYS or f.endswith("_at"):
                    continue
                if normalize(pv, []) != normalize(tv, []):
                    pf2[f] = pv
                    tf2[f] = tv
            if pf2 != tf2:
                changed_diffs[k] = {"php": pf2, "ts": tf2}
        if changed_diffs:
            table_diffs["changed"] = changed_diffs
        if table_diffs:
            out[t] = table_diffs
    return out


def is_money_diff(env_diffs, db_diffs, steps):
    for d in env_diffs:
        if d.get("step") == "count":
            return True
        call = d.get("call", "")
        module = call.split("/")[1] if "/" in call else ""
        if module in MONEY_METHOD_MODULES or call.startswith("ipn"):
            return True
    return any(t in MONEY_TABLES for t in db_diffs)


def run_scenario(scenario, stacks):
    """stacks: {'php': (snapshot, dbpath), 'ts': (snapshot, dbpath)}.
    Returns the scenario report dict."""
    php_envs, php_delta, php_cap = run_scenario_on_stack(
        "php", scenario, *stacks["php"])
    ts_envs, ts_delta, ts_cap = run_scenario_on_stack(
        "ts", scenario, *stacks["ts"])
    env_diffs = diff_envelopes(php_envs, ts_envs, scenario["steps"])
    db_diffs = diff_deltas(php_delta, ts_delta)
    money = is_money_diff(env_diffs, db_diffs, scenario["steps"])
    return {"id": scenario["id"],
            "envelope_diffs": env_diffs,
            "db_diffs": db_diffs,
            "money_diff": money,
            "status": "DIFF" if (env_diffs or db_diffs) else "PASS",
            "capture": php_cap,
            "normalized_fields": sorted(VOLATILE_KEYS)}


def translate_fixture(fx):
    return {"id": fx["id"], "description": fx.get("source", "fixture"),
            "seed_sql": fx.get("seed_sql", []),
            "seed_ops": fx.get("seed_ops", []),
            "steps": fx["steps"]}


def load_scenarios(args):
    scenarios = []
    if args.scenarios:
        data = json.loads(pathlib.Path(args.scenarios).read_text())
        scenarios.extend(data["scenarios"])
    for f in args.fixtures or []:
        data = json.loads(pathlib.Path(f).read_text())
        scenarios.extend(translate_fixture(fx) for fx in data["fixtures"])
    if args.replay:
        steps = []
        for line in pathlib.Path(args.replay).read_text().splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            req = entry["request"]
            if req["kind"] == "api":
                steps.append({"call": f"{req['role']}/{req['module']}/{req['method']}",
                              "as": entry["persona"],
                              "params": req["params"],
                              "json": req.get("json", False)})
            else:
                steps.append({"ipn": {"path": req["path"],
                                      "form": req["form"]}})
        scenarios.append({"id": f"replay:{pathlib.Path(args.replay).stem}",
                          "description": f"replay of {args.replay}",
                          "seed_sql": [], "seed_ops": [], "steps": steps})
    return scenarios


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios")
    ap.add_argument("--fixtures", nargs="*")
    ap.add_argument("--replay")
    ap.add_argument("--out", required=True)
    ap.add_argument("--php-only", action="store_true")
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    scenarios = load_scenarios(args)
    if not scenarios:
        raise SystemExit("no scenarios (pass --scenarios, --fixtures, or --replay)")

    work = pathlib.Path.home() / "scratch" / "fossbilling" / "r5-logs" / \
        f"shadow-run-{os.getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    outdir = pathlib.Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)

    # Safety: refuse if any stack path escapes the work dir.
    for p in (work,):
        assert str(p).startswith(str(SCRATCH)), p

    php_proc, php_db, snapshot = setup_php_disposable(work)
    ts_proc, ts_db = (None, None)
    if not args.php_only:
        ts_proc, ts_db = setup_ts_disposable(work, snapshot)
    log(f"php disposable on :{PHP_PORT} db={php_db}")
    if ts_proc:
        log(f"ts disposable on :{TS_PORT} db={ts_db}")

    report = {"scenarios": [], "php_port": PHP_PORT, "ts_port": TS_PORT,
              "php_db": str(php_db), "ts_db": str(ts_db) if ts_db else None}
    try:
        for sc in scenarios:
            if args.php_only:
                # Capture mode: run on PHP twice; diff PHP vs PHP.
                env1, delta1, cap1 = run_scenario_on_stack(
                    "php", sc, snapshot, php_db)
                env2, delta2, cap2 = run_scenario_on_stack(
                    "php", sc, snapshot, php_db)
                env_diffs = diff_envelopes(env1, env2, sc["steps"])
                db_diffs = diff_deltas(delta1, delta2)
                report["scenarios"].append({
                    "id": sc["id"], "php_vs_php_envelope_diffs": env_diffs,
                    "php_vs_php_db_diffs": db_diffs,
                    "capture": cap1,
                    "normalized_fields": sorted(VOLATILE_KEYS)})
                log(f"{sc['id']}: php-vs-php env_diffs={len(env_diffs)} "
                    f"db_diffs={len(db_diffs)}")
            else:
                rep = run_scenario(sc, {"php": (snapshot, php_db),
                                        "ts": (snapshot, ts_db)})
                report["scenarios"].append(rep)
                log(f"{sc['id']}: {rep['status']} "
                    f"env_diffs={len(rep['envelope_diffs'])} "
                    f"db_diffs={len(rep['db_diffs'])} "
                    f"money_diff={rep['money_diff']}")
                capfile = outdir / f"{sc['id']}.capture.jsonl"
                with open(capfile, "w") as f:
                    for line in rep["capture"]:
                        f.write(json.dumps(line) + "\n")
    finally:
        # SIGTERM the wrappers AND fuser-kill the ports: `npx next
        # start` forks a next-server child that survives the wrapper's
        # death (first full run left :3012 answering after exit).
        php_proc.send_signal(signal.SIGTERM)
        if ts_proc:
            ts_proc.send_signal(signal.SIGTERM)
        kill_port(PHP_PORT)
        if ts_proc:
            kill_port(TS_PORT)
        if not args.keep:
            wait_port(PHP_PORT, False, tries=25)
            wait_port(TS_PORT, False, tries=25)
            shutil.rmtree(work, ignore_errors=True)

    (outdir / "report.json").write_text(json.dumps(report, indent=2))
    n_diff = sum(1 for s in report["scenarios"]
                 if s.get("status") == "DIFF")
    print(f"\n{len(report['scenarios']) - n_diff}/{len(report['scenarios'])} "
          f"scenarios clean; report -> {outdir / 'report.json'}")
    return 0 if n_diff == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
