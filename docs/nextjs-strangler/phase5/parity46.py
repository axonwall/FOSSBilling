#!/usr/bin/env python3
"""R6c parity46 — relocation + deletion proof suite.

Sections:
  A. Relocation proof: every vendored file present + byte-identical to
     the captures49 manifest (taken from the live PHP tree before
     deletion) AND to `git show HEAD:src/...` when the parent commit
     still carries src/ (auto-detected; manifest-only mode is labeled
     when run after the R6c commit lands).
  B. Independence proof: a FRESH disposable TS instance (:3011,
     disposable DB + config copies) with FOSSBILLING_PHP_SRC UNSET
     serves get_pairs, plugin pairs, generalCheck, and all 8 ip_lookup
     shapes identically to captures49 live_before.
  C. Fresh-install smoke with NO PHP tree: a scratch copy of apps/
     nextjs (real vendor/ copy, node_modules/.next symlinked, NO repo
     src/ sibling, FOSSBILLING_PHP_SRC unset) runs the TS installer
     (SQLite), boots, serves, and answers ip_lookup. pg-mem structural
     proof is NOT re-run here — parity43 §B (installer-test F2) covers
     it in-chain; labeled SKIP, R3c rides separately.
  D. Build-clean-with-src/-gone proof: repo/src absent on disk;
     tsc --noEmit + npm run build run HERE (exit 0 required); :3001
     is killed for the build and restarted from the fresh build in
     finally, so the suite never leaves a stale server behind.
  E. Oracle proof: :8080 answers AND its php workers' cwd is
     runtime/src (read from /proc) — the oracle is the frozen oracle,
     not repo src/ (which no longer exists on disk).
  F. Restore: reference invariants + config hash identical before
     AND after; :8080 + :3001 answering at the end; all disposable
     targets deleted in finally.

Read-only vs the reference DB except TS logins (session rows only —
session count is not an invariant). No :8081 prod oracle use: no prod
logins are burned anywhere in this suite.
"""
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request

REPO = pathlib.Path("/home/hatch/scratch/fossbilling/repo")
APP = REPO / "apps" / "nextjs"
PHASE5 = REPO / "docs" / "nextjs-strangler" / "phase5"
CAP = json.load(open(PHASE5 / "captures49" / "capture49.json"))
RUNTIME = pathlib.Path("/home/hatch/scratch/fossbilling/runtime")
RUNTIME_SRC = RUNTIME / "src"
DBP = RUNTIME_SRC / "data" / "fossbilling.sqlite"
CFGP = RUNTIME_SRC / "config.php"
LOGDIR = pathlib.Path("/home/hatch/scratch/fossbilling/r5-logs")
TS = "http://127.0.0.1:3001/api/fb"
PHP = "http://127.0.0.1:8080"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
FB_TS_MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,"
                 "custompages,email,extension,formbuilder,index,invoice,"
                 "massmailer,news,notification,order,page,product,profile,"
                 "redirect,security,seo,serviceapikey,servicecustom,"
                 "servicedomain,servicedownloadable,servicehosting,"
                 "servicelicense,staff,stats,support,system,theme,widgets")

passed = []
failed = []
skipped = []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" {extra}"))


def skip(name, reason):
    skipped.append(name)
    print(f"SKIP {name} ({reason})")


def sha256_of(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def invariants():
    db = sqlite3.connect(DBP)
    out = {}
    for t in ("invoice", "invoice_event", "client_order", "client_order_meta",
              "email_queue", "service_custom", "extension", "extension_meta",
              "setting", "admin", "admin_group", "admin_group_member",
              "currency", "client", "support_ticket", "tld",
              "activity_client_email", "cart", "rate_limit_counter"):
        out[t] = db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
    out["cart_seq"] = db.execute(
        "SELECT seq FROM sqlite_sequence WHERE name='cart'").fetchone()[0]
    out["config_hash"] = hashlib.sha256(CFGP.read_bytes()).hexdigest()[:16]
    db.close()
    return out


def callback_salt():
    m = re.search(r"'salt'\s*=>\s*'([^']+)'", CFGP.read_text())
    assert m, "salt not found in runtime config"
    return m.group(1)


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def ts_login(op, cj, base, email=SUPER_EMAIL, password=SUPER_PASS):
    with op.open(urllib.request.Request(f"{base}/__prime"), timeout=30) as resp:
        assert resp.status == 200, "__prime failed"
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    body = {"email": email, "password": password}
    if csrf:
        body["CSRFToken"] = csrf
    data = urllib.parse.urlencode(body).encode()
    with op.open(urllib.request.Request(f"{base}/guest/staff/login", data=data,
                                       method="POST"), timeout=60) as resp:
        parsed = json.loads(resp.read().decode())
    assert parsed.get("error") is None, f"TS login failed: {parsed}"


def ts_call(op, cj, base, role, module, method, params=None):
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    body = dict(params or {})
    if csrf:
        body["CSRFToken"] = csrf
    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(f"{base}/{role}/{module}/{method}", data=data, method="POST")
    with op.open(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def wait_port(port, timeout=60):
    import socket, time
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                return True
        except OSError:
            time.sleep(1)
    return False


def port_pid(port):
    r = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if f":{port} " in line or f":{port}\t" in line:
            m = re.search(r"pid=(\d+)", line)
            if m:
                return int(m.group(1))
    return None


def start_next(port, dbpath, cfgpath, extra_env=None, cwd=None):
    env = dict(os.environ)
    env.pop("FOSSBILLING_PHP_SRC", None)
    env.update({
        "TZ": "UTC", "FB_TS_MODULES": FB_TS_MODULES,
        "FB_DATABASE_PATH": str(dbpath), "FB_CONFIG_PATH": str(cfgpath),
        "FB_PAYPAL_SKIP_VERIFY": "1", "FB_CALLBACK_SALT": callback_salt(),
    })
    if extra_env:
        env.update(extra_env)
    log = open(LOGDIR / f"parity46-next-{port}.log", "w")
    proc = subprocess.Popen(["npx", "next", "start", "-p", str(port)],
                            cwd=cwd or APP, env=env, stdout=log, stderr=subprocess.STDOUT)
    assert wait_port(port, 90), f"next on :{port} did not start"
    return proc


def kill_port(port):
    pid = port_pid(port)
    if pid:
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        import time
        for _ in range(15):
            time.sleep(1)
            if port_pid(port) is None:
                break


def stop_next(proc, port):
    """Terminate an npx next start parent AND any orphaned next-server
    child still holding the port (npx does not forward the signal)."""
    try:
        proc.terminate()
        proc.wait(timeout=30)
    except Exception:
        pass
    kill_port(port)


def disposable_db_copy(d):
    d.mkdir(parents=True, exist_ok=True)
    (d / "data").mkdir(exist_ok=True)
    src = sqlite3.connect(DBP)
    dst = sqlite3.connect(d / "data" / "fossbilling.sqlite")
    src.backup(dst)
    dst.close()
    src.close()
    shutil.copy(CFGP, d / "config.php")
    return d / "data" / "fossbilling.sqlite", d / "config.php"


def main():
    before = invariants()
    dispo_dirs = []
    procs = []
    try:
        # ---- A: relocation proof ----
        manifest = CAP["manifest"]
        r = subprocess.run(["git", "cat-file", "-e", "HEAD:src"],
                           cwd=REPO, capture_output=True)
        git_mode = r.returncode == 0
        if not git_mode:
            skip("A0 git-show cross-check (HEAD has no src/ — post-R6c-commit run)",
                 "manifest-only mode; captures49 is the record")
        bad = []
        for e in manifest:
            rel = e["php_rel"]
            if rel.startswith("modules/"):
                v = APP / "vendor" / "php-modules" / rel[len("modules/"):]
            elif rel.startswith("themes/"):
                v = APP / "vendor" / "php-themes" / rel[len("themes/"):]
            elif rel.startswith("library/FOSSBilling/GeoIP/Databases/"):
                v = APP / "vendor" / "geoip" / pathlib.Path(rel).name
            elif rel == "install/sql/content.sql":
                v = APP / "vendor" / "content.sql"
            else:
                bad.append((rel, "unmapped"))
                continue
            if not v.exists() or sha256_of(v) != e["sha256"] or v.stat().st_size != e["size"]:
                bad.append((rel, "vendored mismatch"))
                continue
            if git_mode:
                g = subprocess.run(["git", "show", f"HEAD:src/{rel}"],
                                   cwd=REPO, capture_output=True, timeout=60)
                if g.returncode != 0 or hashlib.sha256(g.stdout).hexdigest() != e["sha256"]:
                    bad.append((rel, "git-show mismatch"))
        check(f"A1 all {len(manifest)} vendored files byte-identical "
              f"(manifest{' + git show HEAD:src' if git_mode else ' only'})",
              not bad, str(bad[:5]))
        check("A2 vendored README present",
              (APP / "vendor" / "README.md").exists())

        # ---- B: independence proof (fresh disposable :3011, var UNSET) ----
        d = LOGDIR / "parity46-disposable-b"
        dispo_dirs.append(d)
        if d.exists():
            shutil.rmtree(d)
        dbpath, cfgpath = disposable_db_copy(d)
        proc = start_next(3011, dbpath, cfgpath)
        procs.append(proc)
        op, cj = make_opener()
        ts_login(op, cj, "http://127.0.0.1:3011/api/fb")
        b = "http://127.0.0.1:3011/api/fb"
        check("B1 get_pairs == captures49 (var unset)",
              ts_call(op, cj, b, "admin", "page", "get_pairs") == CAP["live_before"]["page_get_pairs"])
        check("B2 plugin pairs == captures49 (var unset)",
              ts_call(op, cj, b, "admin", "servicelicense", "plugin_get_pairs") == CAP["live_before"]["plugin_get_pairs"])
        check("B3 generalCheck == captures49 (var unset)",
              ts_call(op, cj, b, "admin", "security", "run_check", {"id": "generalCheck"}) == CAP["live_before"]["general_check"])
        ip_bad = []
        for ip, want in CAP["live_before"]["ip_lookup"].items():
            got = ts_call(op, cj, b, "admin", "security", "ip_lookup", {"ip": ip})
            if got != want:
                ip_bad.append(ip)
        check("B4 all 8 ip_lookup shapes == captures49 (var unset)", not ip_bad, str(ip_bad))
        stop_next(proc, 3011)
        procs.remove(proc)

        # ---- C: fresh-install smoke with NO PHP tree ----
        scratch = LOGDIR / "parity46-fresh"
        dispo_dirs.append(scratch)
        if scratch.exists():
            shutil.rmtree(scratch)
        scratch.mkdir(parents=True)
        # Real copy of the app minus build/node_modules (symlinked) —
        # crucially, NO repo src/ sibling exists under scratch/.
        for item in os.listdir(APP):
            if item in (".next", "node_modules", ".git"):
                continue
            s = APP / item
            (shutil.copytree if s.is_dir() else shutil.copy2)(s, scratch / item)
        os.symlink(APP / "node_modules", scratch / "node_modules")
        os.symlink(APP / ".next", scratch / ".next")
        install_root = scratch / "install-root"
        install_root.mkdir()
        env = {k: v for k, v in os.environ.items() if k != "FOSSBILLING_PHP_SRC"}
        env["FB_INSTALL_ADMIN_PASSWORD"] = "Par46-Fresh!1"
        r = subprocess.run(["node", "scripts/run-install.mjs",
                            "--install-root", str(install_root),
                            "--url", "https://par46.example/billing/",
                            "--admin-name", "Par Admin",
                            "--admin-email", "par46@example.com",
                            "--db-driver", "pdo_sqlite",
                            "--db-path", str(install_root / "fresh.sqlite"),
                            "--json"],
                           cwd=scratch, capture_output=True, text=True, env=env, timeout=300)
        check("C1 installer exit 0 with NO PHP tree (vendored defaults)",
              r.returncode == 0, r.stdout[-500:] + r.stderr[-500:])
        report = json.loads(r.stdout) if r.returncode == 0 else {}
        if r.returncode == 0:
            db = sqlite3.connect(install_root / "fresh.sqlite")
            tables = [row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
            total = sum(db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables)
            db.close()
            check("C2 fresh install 64 tables", len(tables) == 64, str(len(tables)))
            check("C3 fresh install 86 rows", total == 86, str(total))
            check("C4 fresh install geoip copied", report.get("geoip", {}).get("copied") is True,
                  str(report.get("geoip")))
            # Boot the fresh install from the scratch copy and prove serving.
            fresh_salt = re.search(r"'salt'\s*=>\s*'([^']+)'",
                                   (install_root / "config.php").read_text()).group(1)
            proc = start_next(3012, install_root / "fresh.sqlite",
                              install_root / "config.php",
                              extra_env={"FB_CALLBACK_SALT": fresh_salt}, cwd=scratch)
            procs.append(proc)
            op2, cj2 = make_opener()
            # Fresh install's OWN admin (not the reference admin):
            # installer ran with --admin-email par46@example.com.
            ts_login(op2, cj2, "http://127.0.0.1:3012/api/fb",
                     email="par46@example.com", password="Par46-Fresh!1")
            got = ts_call(op2, cj2, "http://127.0.0.1:3012/api/fb",
                          "admin", "security", "ip_lookup", {"ip": "8.8.8.8"})
            check("C5 fresh install serves + ip_lookup works",
                  got.get("error") is None and got.get("result", {}).get("ip", {}).get("address") == "8.8.8.8",
                  str(got)[:300])
            stop_next(proc, 3012)
            procs.remove(proc)
        skip("C6 pg-mem structural proof",
             "covered by parity43 §B (installer-test F2) in-chain; R3c rides separately")

        # ---- D: build-clean-with-src/-gone proof ----
        check("D1 repo src/ absent on disk", not (REPO / "src").exists())
        kill_port(3001)
        r = subprocess.run(["npx", "tsc", "--noEmit"], cwd=APP,
                           capture_output=True, text=True, timeout=300)
        check("D2 tsc --noEmit exit 0 on deleted tree", r.returncode == 0,
              r.stdout[-500:] + r.stderr[-500:])
        r = subprocess.run(["npm", "run", "build"], cwd=APP,
                           capture_output=True, text=True, timeout=600)
        check("D3 npm run build exit 0 on deleted tree", r.returncode == 0,
              (r.stdout + r.stderr)[-500:])
        proc = start_next(3001, DBP, CFGP)
        procs.append(proc)
        check("D4 :3001 restarted from fresh build answers",
              urllib.request.urlopen(TS + "/__prime", timeout=30).status == 200)

        # ---- E: oracle proof ----
        # E1 probes the PHP login page (GET /login, 200 — the same
        # prime parity44's PHP login uses), not an API route: the
        # point is that :8080 ANSWERS as a PHP app; E2 is the proof
        # of WHERE it serves from.
        with urllib.request.urlopen(PHP + "/login", timeout=30) as resp:
            login_status = resp.status
        check("E1 :8080 answers PHP login page", login_status == 200,
              str(login_status))
        pid = port_pid(8080)
        cwd = os.readlink(f"/proc/{pid}/cwd") if pid else ""
        check("E2 :8080 php worker cwd == runtime/src (frozen oracle)",
              cwd == str(RUNTIME_SRC), f"pid={pid} cwd={cwd}")
        check("E3 repo src/ still absent (oracle cannot be repo src/)",
              not (REPO / "src").exists())

        # ---- F: restore ----
        after = invariants()
        diffs = [k for k in before if before[k] != after[k]]
        check("F1 reference invariants + config hash unchanged", not diffs,
              "; ".join(f"{k}: {before[k]} -> {after[k]}" for k in diffs))
        check("F2 :8080 answering at end",
              urllib.request.urlopen(PHP + "/", timeout=30).status == 200)
        check("F3 :3001 answering at end",
              urllib.request.urlopen(TS + "/__prime", timeout=30).status == 200)
    finally:
        for proc in procs:
            try:
                proc.terminate()
                proc.wait(timeout=30)
            except Exception:
                pass
        kill_port(3011)
        kill_port(3012)
        # :3001 must be left answering (restart it if the suite killed it).
        try:
            urllib.request.urlopen(TS + "/__prime", timeout=10)
        except Exception:
            try:
                start_next(3001, DBP, CFGP)
            except Exception as e:
                print(f"WARNING: could not restart :3001 in finally: {e}")
        for d in dispo_dirs:
            shutil.rmtree(d, ignore_errors=True)
        print(f"\nparity46: {len(passed)} passed, {len(failed)} failed, {len(skipped)} skipped")
        if failed:
            print("FAILURES: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback
        traceback.print_exc()
        print("parity46 CRASHED (finally already restored servers + disposables)")
        sys.exit(1)
