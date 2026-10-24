#!/usr/bin/env python3
"""Phase 3 shadow-run fixture harness.

Replays stack-agnostic money fixtures (fixtures/*.json) against a
DISPOSABLE copy of the reference install and checks the expectations.
The same fixtures are the Phase 3 cutover gate: PHP produces the
baseline (results-php.json); a TS implementation must replay them
with zero differing expectations before it may serve money traffic.

Usage:
  python3 run-fixtures.py [--stack php] [fixture-file ...]

Mechanics:
- Builds ~/scratch/fossbilling/disposable/ (app copy + vendor symlink,
  config rewritten to its own SQLite), serves it on :8081.
- Snapshots the reference DB once; restores it before EVERY fixture,
  so fixtures are order-independent and repeat runs are deterministic.
- Per fixture: seed_sql / clone_client ops run first, then API steps
  (form encoding by default; "json": true sends a JSON body, which
  PHP's typed entity setters require for bool/int params), then
  expectations: dotted paths into step results, or scalar SQL.
"""
import json, os, pathlib, shutil, signal, socket, sqlite3, subprocess, sys, time
import urllib.request, urllib.parse, http.cookiejar

SCRATCH = pathlib.Path(os.environ.get("FB_SCRATCH", str(pathlib.Path.home() / "scratch" / "fossbilling")))
RUNTIME_SRC = SCRATCH / "runtime" / "src"
DISPO = SCRATCH / "disposable"
PORT = 8081
BASE = f"http://127.0.0.1:{PORT}"
HERE = pathlib.Path(__file__).parent
SNAPSHOT = DISPO / "snapshot.sqlite"

ADMIN = {"email": "admin@phase0.local", "password": "Phase1-Admin!42"}
CLIENT = {"email": "phase0.client@example.com", "password": "Phase0-Client!42"}

VOLATILE_KEYS = {"hash", "hash_expires_at", "created_at", "updated_at", "due_at",
                 "paid_at", "reminded_at", "__cart_family"}


def wait_ready(proc, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"disposable PHP exited early ({proc.returncode})")
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                return
        except OSError:
            time.sleep(0.3)
    raise SystemExit("disposable PHP did not start")


def setup_disposable():
    if DISPO.exists():
        shutil.rmtree(DISPO)
    DISPO.mkdir(parents=True)
    src = DISPO / "src"
    shutil.copytree(RUNTIME_SRC, src, ignore=shutil.ignore_patterns("vendor", "data", "cache"))
    # Hardlink copy, NOT a symlink: PHP resolves __DIR__ through symlinks,
    # so a symlinked vendor makes Composer autoload the ORIGINAL tree's
    # classes alongside the copy's ("class already in use" fatals).
    subprocess.run(["cp", "-al", str(RUNTIME_SRC / "vendor"), str(src / "vendor")],
                   check=True)
    # The whole data dir matters: update-finalization.json in a completed
    # state is what keeps the app out of maintenance mode.
    data = src / "data"
    subprocess.run(["cp", "-al", str(RUNTIME_SRC / "data"), str(data)], check=True)
    (data / "fossbilling.sqlite").unlink()
    shutil.copy(RUNTIME_SRC / "data" / "fossbilling.sqlite", SNAPSHOT)
    shutil.copy(SNAPSHOT, data / "fossbilling.sqlite")
    config = src / "config.php"
    text = config.read_text()
    text = text.replace(str(RUNTIME_SRC / "data"), str(data))
    text = text.replace(str(RUNTIME_SRC / "data" / "fossbilling.sqlite"),
                        str(data / "fossbilling.sqlite"))
    config.write_text(text)
    shutil.copy(RUNTIME_SRC / "data" / ".jwt_secret", data / ".jwt_secret") \
        if (RUNTIME_SRC / "data" / ".jwt_secret").exists() else None
    env = dict(os.environ, APP_ENV="dev")
    proc = subprocess.Popen(
        [str(SCRATCH.parent.parent / "scratch" / "php83bulk" / "php"), "-S",
         f"127.0.0.1:{PORT}", "-t", "."],
        cwd=src, env=env, stdout=open("/tmp/php-dispo.log", "w"),
        stderr=subprocess.STDOUT)
    wait_ready(proc)
    return proc


def restore_db():
    shutil.copy(SNAPSHOT, DISPO / "src" / "data" / "fossbilling.sqlite")


def db():
    return sqlite3.connect(DISPO / "src" / "data" / "fossbilling.sqlite")


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
    def __init__(self):
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))

    def csrf(self):
        for c in self.cj:
            if c.name == "fossbilling_csrf":
                return c.value
        return None

    def call(self, route, params=None, as_json=False):
        role, module, method = route.split("/")
        url = f"{BASE}/api/{role}/{module}/{method}"
        if as_json:
            body = json.dumps(params or {}).encode()
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            tok = self.csrf()
            if tok:
                # PHP's API accepts the token via this header when the
                # params carry no CSRFToken field (JSON bodies).
                req.add_header("X-CSRF-TOKEN", tok)
        else:
            payload = flatten(dict(params or {}))
            tok = self.csrf()
            if tok:
                payload["CSRFToken"] = tok
            req = urllib.request.Request(
                url, data=urllib.parse.urlencode(payload).encode(), method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with self.op.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())


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


def num_eq(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return round(float(a), 2) == round(float(b), 2)
    return a == b


def scrub(v):
    if isinstance(v, dict):
        return {k: ("*" if k in VOLATILE_KEYS else scrub(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


def run_fixture(fx):
    restore_db()
    con = db()
    saved = {}
    for stmt in fx.get("seed_sql", []):
        con.execute(stmt)
    for op in fx.get("seed_ops", []):
        if "clone_client" in op:
            spec = op["clone_client"]
            saved[spec["save"]] = clone_client(con, spec["from"], spec["set"])
    con.commit()
    con.close()

    jar = Jar()
    jar.op.open(f"{BASE}/login", timeout=20).read()
    logged = set()
    steps_out = []
    failures = []

    def subst(v):
        if isinstance(v, str) and v.startswith("$"):
            return saved[v[1:]]
        if isinstance(v, dict):
            return {k: subst(x) for k, x in v.items()}
        if isinstance(v, list):
            return [subst(x) for x in v]
        return v

    for i, step in enumerate(fx["steps"]):
        who = step.get("as", "anon")
        if who in ("admin", "client") and who not in logged:
            creds = ADMIN if who == "admin" else CLIENT
            route = "guest/staff/login" if who == "admin" else "guest/client/login"
            jar.call(route, creds)
            logged.add(who)
        env = jar.call(step["call"], subst(step.get("params", {})),
                       as_json=step.get("json", False))
        steps_out.append(env)
        for name, path in (step.get("save") or {}).items():
            saved[name] = dig(env, path)
        if env.get("error") and not step.get("allow_error"):
            failures.append(f"step {i} ({step['call']}) errored: {env['error']}")

    con = db()
    for exp in fx.get("expect", []):
        if "db" in exp:
            got = con.execute(exp["db"]).fetchone()
            got = got[0] if got else None
        else:
            got = dig(steps_out[exp["step"]], exp["path"])
        if "present" in exp:
            ok = (got is not None) == exp["present"]
        else:
            ok = num_eq(got, exp["eq"])
        if not ok:
            failures.append(
                f"expect {exp.get('path', exp.get('db'))}: got {got!r}, want {exp.get('eq', exp.get('present'))!r}")
    con.close()
    return failures, steps_out, saved


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    files = [pathlib.Path(a) for a in args] or sorted((HERE / "fixtures").glob("*.json"))
    corpus = []
    for f in files:
        corpus.extend(json.loads(f.read_text())["fixtures"])
    proc = setup_disposable()
    results = {}
    total_fail = 0
    try:
        for fx in corpus:
            failures, steps_out, saved = run_fixture(fx)
            status = "PASS" if not failures else "FAIL"
            total_fail += len(failures)
            print(f"{status} {fx['id']}")
            for f_ in failures:
                print(f"     {f_}")
            results[fx["id"]] = {
                "status": status,
                "failures": failures,
                "saved": saved,
                "steps": [scrub(s) for s in steps_out],
            }
    finally:
        proc.send_signal(signal.SIGTERM)
    out = HERE / "results-php.json"
    out.write_text(json.dumps(results, indent=2))
    print(f"\n{sum(1 for r in results.values() if r['status'] == 'PASS')}/{len(results)} fixtures pass; results -> {out}")
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
