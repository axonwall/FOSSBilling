#!/usr/bin/env python3
"""Phase 5 R6d parity: rollback artifact inputs + cutover checklist.

DOCS-ONLY batch proof — everything here is CHECKABLE in this sandbox:
- §A parent-commit artifact inputs (worktree, Dockerfile stages,
  COPY sources, parent tree contents, current-tree pointer).
- §B forward-only data claims (PHP ignores the TS limiter table,
  config writer unchanged since R5a, finalization file shared).
- §C checklist completeness (every scope §2 R6d + D6-5 + R6c
  findings §6 item appears in cutover-checklist.md with a status).
- §D deployment-note truth, proven with LIVE probes (not citations):
  FB_PUBLIC_URL-unset == SYSTEM_URL fallback; FB_CONFIG_PATH
  honored (distinguishing probe) and nonexistent path throws.
- §E drill status: doc states UNEXECUTED, and invariants clean
  before AND after prove no drill ran against the reference DB.
- §F restore: invariants + config hash unchanged, servers
  answering, worktree + disposables cleaned up, ports down.

NOT claimed here (and never faked): the docker image existing,
the staging drill running, the live window running, R3c proof.
Those are INFRA-TAP items in the checklist.

Fail fast if another parity suite is already running (R6b lesson).
The verification worktree lives OUTSIDE /tmp (~/scratch/...) and
is created by §A if missing and removed by §F — the suite is
re-runnable. Never touches runtime/ except read-only greps/reads.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = "/home/hatch/scratch/fossbilling/repo"
RUNTIME_SRC = "/home/hatch/scratch/fossbilling/runtime/src"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
TS = "http://127.0.0.1:3001"
TS_API = TS + "/api/fb"
WORKTREE = "/home/hatch/scratch/fossbilling/r6d-rollback-worktree"
PARENT_SHA = "51abaf1ef5747e84a503a39d9f99e4b238c7eef6"
PARENT_SHORT = "51abaf1"
CHECKLIST = REPO + "/docs/nextjs-strangler/phase5/cutover-checklist.md"
SCRATCH = "/home/hatch/scratch/fossbilling/r5-logs/parity47-scratch"
LOGDIR = "/home/hatch/scratch/fossbilling/r5-logs"
FB_TS_MODULES = ("activity,antispam,cart,client,cookieconsent,cron,currency,"
                 "custompages,email,extension,formbuilder,index,invoice,"
                 "massmailer,news,notification,order,page,product,profile,"
                 "redirect,security,seo,serviceapikey,servicecustom,"
                 "servicedomain,servicedownloadable,servicehosting,"
                 "servicelicense,staff,stats,support,system,theme,widgets")
EXPECTED_STAGES = ["php-base", "composer-base", "php-vendor", "php-dev-vendor",
                   "frontend-assets", "release-tree", "release-artifact",
                   "runtime", "test"]
# COPY context sources for the release-artifact dependency chain
# (php-vendor + frontend-assets + release-tree). External images
# (php:*, node:*, composer:*@sha256) are NOT context paths.
EXPECTED_COPY_SOURCES = [
    "composer.json", "composer.lock", "src/library", "src/modules",
    "package.json", "package-lock.json", "tsconfig.json",
    "src/themes/default/admin/package.json",
    "src/themes/default/client/package.json",
    "src/themes/default/admin", "src/themes/default/client",
    "frontend", "src", "README.md", "LICENSE",
]

CHECKS = 0
FAILURES = []
DISPOSABLE_PROCS = []


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"ok   {name}", flush=True)
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}", flush=True)


def port_up(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def wait_port(port, want_up, timeout=60):
    for _ in range(int(timeout / 0.5)):
        if port_up(port) == want_up:
            return True
        time.sleep(0.5)
    return False


def kill_port(port):
    subprocess.run(["fuser", "-k", f"{port}/tcp"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def invariants():
    d = sqlite3.connect(f"file:{DBP}?mode=ro", uri=True)
    out = {}
    for t in ("invoice", "client_order", "email_queue", "service_custom",
              "extension", "extension_meta", "setting", "admin",
              "admin_group", "admin_group_member", "currency", "client",
              "support_ticket", "tld", "activity_client_email",
              "invoice_event", "client_order_meta", "cart"):
        out[t] = d.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    out["queue"] = d.execute(
        "SELECT status, COUNT(*) FROM email_queue GROUP BY status").fetchall()
    out["cart_seq"] = d.execute(
        "SELECT seq FROM sqlite_sequence WHERE name='cart'").fetchall()
    try:
        out["counters"] = d.execute(
            "SELECT COUNT(*) FROM rate_limit_counter").fetchone()[0]
    except Exception:
        out["counters"] = "absent"
    out["config_hash"] = hashlib.sha256(
        pathlib.Path(CFG).read_bytes()).hexdigest()[:16]
    out["last_cron_exec"] = d.execute(
        "SELECT value FROM setting WHERE param='last_cron_exec'").fetchall()
    out["overdue"] = d.execute(
        "SELECT value FROM setting WHERE param='invoice_overdue_invoked'").fetchall()
    out["starting"] = d.execute(
        "SELECT value FROM setting WHERE param='invoice_starting_number'").fetchall()
    return out


def call_company(base):
    body = urllib.parse.urlencode({}).encode()
    url = f"{base}/api/fb/guest/system/company"
    try:
        with urllib.request.urlopen(
                urllib.request.Request(url, data=body, method="POST"),
                timeout=60) as resp:
            return json.loads(resp.read().decode()), resp.status
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode()), e.code
        except Exception:
            return {"_http_error": e.code}, e.code
    except Exception as e:
        return {"_exc": str(e)[:200]}, 0


def callback_salt():
    m = re.search(r"'salt'\s*=>\s*'([^']+)'", pathlib.Path(CFG).read_text())
    assert m, "salt not found in config.php"
    return m.group(1)


def start_disposable_next(port, extra_env, logname):
    env = dict(os.environ)
    env.update({
        "TZ": "UTC",
        "FB_TS_MODULES": FB_TS_MODULES,
        "FB_PAYPAL_SKIP_VERIFY": "1",
        "FB_CALLBACK_SALT": callback_salt(),
    })
    env.pop("FOSSBILLING_PHP_SRC", None)
    env.pop("FB_PUBLIC_URL", None)
    env.update(extra_env)
    log = open(f"{LOGDIR}/{logname}", "ab")
    proc = subprocess.Popen(["npx", "next", "start", "-p", str(port)],
                            cwd=REPO + "/apps/nextjs", stdout=log,
                            stderr=subprocess.STDOUT, env=env)
    DISPOSABLE_PROCS.append((port, proc))
    if not wait_port(port, True, timeout=60):
        raise AssertionError(f":{port} did not start")
    return proc


def git_show(rev, path):
    return subprocess.run(["git", "show", f"{rev}:{path}"],
                          cwd=REPO, capture_output=True, text=True,
                          check=True).stdout


def fn_body(src, fname):
    """Extract one exported function body (up to the next export)."""
    idx = src.find(f"export function {fname}")
    assert idx >= 0, f"{fname} not found"
    rest = src[idx:]
    nxt = rest.find("\nexport function ", 10)
    return rest if nxt < 0 else rest[:nxt]


def main():
    # ---- fail fast on a concurrent suite (R6b lesson) ----
    # pgrep -f matches the launching shell's command line too (it
    # contains "parity47.py"), so a candidate counts only if its
    # executable is a python interpreter AND it is not this process.
    out = subprocess.run(["pgrep", "-f", r"parity[0-9]+\.py"],
                         capture_output=True, text=True).stdout.strip()
    mine = os.getpid()
    others = []
    for p in out.split():
        try:
            pid = int(p)
        except ValueError:
            continue
        if pid == mine:
            continue
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
        except Exception:
            continue
        if "python" in exe:
            others.append(p)
    if others:
        print(f"STRAY SUITE RUNNING (pids {others}) - ABORT")
        return 1
    # ---- pre-checks ----
    check("pre :8080 answering", port_up(8080))
    check("pre :3001 answering", port_up(3001))
    for p in (8081, 18025, 18026, 3003, 3021, 3022):
        check(f"pre :{p} down", not port_up(p))
    inv_before = invariants()
    check("pre invariants sane (cart 283, invoice 323, queue 67)",
          inv_before["cart"] == 283 and inv_before["invoice"] == 323
          and inv_before["email_queue"] == 67
          and inv_before["config_hash"] == "6e3c529673c1d089",
          str({k: inv_before[k] for k in
               ("cart", "invoice", "email_queue", "config_hash")}))
    try:
        # ================= §A: parent-commit artifact inputs =================
        wt = pathlib.Path(WORKTREE)
        if not wt.exists():
            subprocess.run(["git", "worktree", "add", WORKTREE, PARENT_SHORT],
                           cwd=REPO, check=True, capture_output=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WORKTREE,
                              capture_output=True, text=True,
                              check=True).stdout.strip()
        check("§A worktree HEAD == 51abaf1 (full SHA)", head == PARENT_SHA, head)
        check("§A worktree clean", subprocess.run(
            ["git", "status", "--short"], cwd=WORKTREE,
            capture_output=True, text=True).stdout.strip() == "")
        dockerfile = (wt / "Dockerfile").read_text()
        stages = re.findall(r"^FROM\s+\S+\s+AS\s+(\S+)", dockerfile, re.M)
        check("§A stage list matches scope §0.7", stages == EXPECTED_STAGES,
              str(stages))
        m = re.search(r"^FROM scratch AS release-artifact\s*\n\s*\n?"
                      r"COPY --from=release-tree /app/src /",
                      dockerfile, re.M)
        check("§A release-artifact = FROM scratch + COPY --from=release-tree /app/src /",
              m is not None)
        missing = [p for p in EXPECTED_COPY_SOURCES
                   if not (wt / p).exists()]
        check("§A all 18 COPY context sources exist in parent tree",
              missing == [], str(missing))
        check("§A parent tree contains src/", (wt / "src").is_dir())
        check("§A parent tree contains composer.json + composer.lock",
              (wt / "composer.json").exists() and (wt / "composer.lock").exists())
        check("§A parent tree contains frontend/ (frontend-assets stage input)",
              (wt / "frontend").is_dir())
        check("§A src/vendor correctly ABSENT in parent tree (docker builds it)",
              not (wt / "src" / "vendor").exists())
        check("§A composer image pinned by digest (not floating tag)",
              "composer:2@sha256:" in dockerfile)
        pointer = (pathlib.Path(REPO) / "Dockerfile").read_text()
        check("§A current-tree pointer names release-artifact + parent SHA + Next Dockerfile",
              "release-artifact" in pointer and PARENT_SHORT in pointer
              and "apps/nextjs/Dockerfile" in pointer, pointer[:200])

        # ================= §B: forward-only claims =================
        pat = re.compile(r"rate_limit_counter\b")
        hits = []
        for root, _dirs, files in os.walk(RUNTIME_SRC):
            for f in files:
                if not f.endswith(".php"):
                    continue
                p = os.path.join(root, f)
                try:
                    if pat.search(pathlib.Path(p).read_text(
                            errors="ignore")):
                        hits.append(p)
                except Exception:
                    pass
        check("§B exact table name rate_limit_counter: ZERO refs in runtime/src PHP",
              hits == [], str(hits[:5]))
        # PHP's own limiter is cache-backed, not table-backed.
        rl = (pathlib.Path(RUNTIME_SRC) /
              "library/FOSSBilling/Security/RateLimiter.php").read_text()
        check("§B PHP limiter uses CacheStorage (different system, not the TS table)",
              "new CacheStorage(" in rl)
        old = git_show(PARENT_SHORT,
                       "apps/nextjs/src/server/config-store.ts")
        new = git_show("HEAD", "apps/nextjs/src/server/config-store.ts")
        diff = subprocess.run(["git", "diff", PARENT_SHORT, "HEAD", "--",
                               "apps/nextjs/src/server/config-store.ts"],
                              cwd=REPO, capture_output=True,
                              text=True).stdout
        # Count hunk headers by their "@@ " prefix: the first hunk
        # sits in the file-header comment, so git prints NO trailing
        # function name for it — matching trailing text undercounts.
        hunks = [ln for ln in diff.splitlines() if ln.startswith("@@ ")]
        check("§B config-store diff has exactly the 2 known hunks (comment + fallback)",
              len(hunks) == 2, str(hunks))
        check("§B serializeConfig body identical 51abaf1 -> HEAD",
              fn_body(old, "serializeConfig") == fn_body(new, "serializeConfig"))
        check("§B writeConfigFile body identical 51abaf1 -> HEAD",
              fn_body(old, "writeConfigFile") == fn_body(new, "writeConfigFile"))
        fin = json.loads((pathlib.Path(RUNTIME_SRC) /
                          "data/update-finalization.json").read_text())
        check("§B finalization file present, status complete, version 0.0.1",
              fin.get("status") == "complete" and fin.get("version") == "0.0.1",
              str(fin))
        ts_fin = (pathlib.Path(REPO) /
                  "apps/nextjs/src/server/update-finalization.ts").read_text()
        check("§B TS resolves the SAME finalization path (<installRoot>/data/update-finalization.json)",
              'path.join(installRoot, "data", "update-finalization.json")' in ts_fin)

        # ================= §C: checklist completeness =================
        doc = pathlib.Path(CHECKLIST).read_text()
        for gate in ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10"):
            check(f"§C checklist contains gate {gate}", gate in doc)
        for status in ("MET", "NOT-MET", "WAIVED-WITH-REASON", "INFRA-TAP"):
            check(f"§C checklist defines status {status}", status in doc)
        # Case-insensitive: the checklist writes the retention rule
        # in uppercase ("ONE FULL BILLING CYCLE").
        doc_lower = doc.lower()
        for item in ("D6-5", "D6-9", "D6-2", "D6-1", "forward-only",
                     "UNEXECUTED", "TZ=UTC", "fossbilling-php-rollback:51abaf1",
                     "one full billing cycle", "R3c", "Stripe", "eNom",
                     "currency refresh", "provider verification",
                     "invoice_event", "client_order_status",
                     "Order Placed", "send-status", "last_cron_exec",
                     "forced logout", "session", "FB_PUBLIC_URL",
                     "FB_CONFIG_PATH", "FB_GEOIP_DB_DIR", "src/public"):
            check(f"§C checklist mentions {item}", item.lower() in doc_lower)
        check("§C checklist states the image is NOT built (no existence claim)",
              "NOT built" in doc and "image was pushed" not in doc
              and "image has been" not in doc)
        g8 = doc[doc.find("## G8"):]
        check("§C G8 drill section states UNEXECUTED",
              "UNEXECUTED" in g8[:1500])

        # ================= §D: deployment-note truth (live) =================
        env, _st = call_company(TS)
        check("§D reference :3001 (FB_PUBLIC_URL unset): company www == SYSTEM_URL fallback :8080",
              (env.get("result") or {}).get("www") == "http://127.0.0.1:8080/",
              str(env)[:300])
        # Scratch config + scratch DB: url rewritten to :9999 so the
        # probe DISTINGUISHES the scratch config from the reference.
        pathlib.Path(SCRATCH).mkdir(parents=True, exist_ok=True)
        scratch_db = f"{SCRATCH}/fossbilling.sqlite"
        shutil.copyfile(DBP, scratch_db)
        cfg_src = pathlib.Path(CFG).read_text()
        assert cfg_src.count(
            "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite") == 1
        assert cfg_src.count("'127.0.0.1:8080/'") == 1
        scratch_cfg = cfg_src.replace(
            "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite",
            scratch_db).replace("'127.0.0.1:8080/'", "'127.0.0.1:9999/'")
        scratch_cfg_path = f"{SCRATCH}/config.php"
        pathlib.Path(scratch_cfg_path).write_text(scratch_cfg)
        start_disposable_next(3021, {
            "FB_DATABASE_PATH": scratch_db,
            "FB_CONFIG_PATH": scratch_cfg_path,
        }, "next-3021-r6d.log")
        env21, _ = call_company("http://127.0.0.1:3021")
        check("§D disposable :3021 (FB_CONFIG_PATH -> scratch config): www == :9999 (config actually honored)",
              (env21.get("result") or {}).get("www") == "http://127.0.0.1:9999/",
              str(env21)[:300])
        start_disposable_next(3022, {
            "FB_DATABASE_PATH": scratch_db,
            "FB_CONFIG_PATH": f"{SCRATCH}/does-not-exist.php",
        }, "next-3022-r6d.log")
        env22, _ = call_company("http://127.0.0.1:3022")
        check("§D disposable :3022 (FB_CONFIG_PATH -> nonexistent): errors, does NOT silently fall back to :8080",
              (env22.get("result") or {}).get("www") != "http://127.0.0.1:8080/"
              and (env22.get("error") is not None or "_exc" in env22 or "_http_error" in env22),
              str(env22)[:300])

        # ================= §E: drill status =================
        inv_after = invariants()
        check("§E invariants clean after (no drill ran against reference DB)",
              inv_after["cart"] == 283 and inv_after["invoice"] == 323
              and inv_after["email_queue"] == 67
              and inv_after["config_hash"] == "6e3c529673c1d089",
              str({k: inv_after[k] for k in
                   ("cart", "invoice", "email_queue", "config_hash")}))
        check("§E cart seq is a high-water mark only (count 283 holds)",
              inv_after["cart"] == 283)
    finally:
        # ================= §F: restore =================
        for port, proc in DISPOSABLE_PROCS:
            try:
                proc.terminate()
            except Exception:
                pass
            kill_port(port)
        for port in (3021, 3022):
            kill_port(port)
        time.sleep(2)
        shutil.rmtree(SCRATCH, ignore_errors=True)
        subprocess.run(["git", "worktree", "remove", "--force", WORKTREE],
                       cwd=REPO, capture_output=True)
        subprocess.run(["git", "worktree", "prune"], cwd=REPO,
                       capture_output=True)
        check("§F verification worktree removed",
              not pathlib.Path(WORKTREE).exists())
        check("§F scratch dir removed", not pathlib.Path(SCRATCH).exists())
        check("§F :3021 down", not port_up(3021))
        check("§F :3022 down", not port_up(3022))
        for p in (8081, 18025, 18026, 3003):
            check(f"§F :{p} down", not port_up(p))
        check("§F :8080 answering at end", port_up(8080))
        check("§F :3001 answering at end", port_up(3001))
        inv_end = invariants()
        check("§F invariants + config hash unchanged at end",
              inv_end["cart"] == 283 and inv_end["invoice"] == 323
              and inv_end["email_queue"] == 67
              and inv_end["config_hash"] == "6e3c529673c1d089"
              and inv_end["counters"] == 0,
              str({k: inv_end[k] for k in
                   ("cart", "invoice", "email_queue", "config_hash", "counters")}))
    # ---- accounting (unchanged: R6d touches no handler) ----
    acc = subprocess.run(["python3", REPO +
                          "/docs/nextjs-strangler/phase5/endpoint-accounting.py"],
                         capture_output=True, text=True)
    check("accounting exit 0", acc.returncode == 0, acc.stdout[:300])
    check("accounting 548+31+0=579",
          "548" in acc.stdout and "31" in acc.stdout and "579" in acc.stdout,
          acc.stdout[:300])
    print(f"\nparity47: {CHECKS - len(FAILURES)} passed, {len(FAILURES)} failed"
          + (f": {FAILURES}" if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
