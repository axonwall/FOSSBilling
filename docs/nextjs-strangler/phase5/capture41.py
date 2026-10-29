#!/usr/bin/env python3
"""R5e capture corpus (pre-fix): PHP-prod vs PHP-dev vs TS batch_sendmail.

Proves, before the fix:
- PHP-prod (:8081, APP_ENV unset -> production) DELIVERS queued mail
  through the mock SMTP sink (:18025): row deleted, activity log row
  written (when log_enabled), wire message captured.
- PHP-dev (:8080, APP_ENV=dev) SKIPS sending (non-production skip):
  rows stay 'sending', no wire message. This is why the PHP oracle
  for parity38 must be :8081, not :8080.
- TS pre-fix FLIPS pending -> 'sending' and returns null: no wire
  message, rows left 'sending'.
- PHP failure states: missing SMTP host, unknown mailer, 550 reject
  (all -> failed / tries+1 / priority-1, row kept).
- PHP wire shapes: attachment MIME, Reply-To header, Bcc envelope
  (valid only, invalid skipped), From/To display names.

Secrets: the crafted SMTP password is a DUMMY value. It is NEVER
printed, logged, or stored in captures: captures hold shapes, row
states, and mock messages (the mock itself never records AUTH
credentials). Config values are compared by key set only.
"""
import glob
import hashlib
import http.cookiejar
import json
import pathlib
import shutil
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP_DEV = "http://127.0.0.1:8080"
PHP_PROD = "http://127.0.0.1:8081"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
MOCK = "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"
OUT = pathlib.Path(__file__).parent / "captures41"
OUT.mkdir(exist_ok=True)

SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
NOW = "2026-10-29 12:00:00"

CHECKS = 0
FAILURES = []


def check(name, cond, detail=""):
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"PASS {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def login(opener, base, email, password):
    resp = opener.open(base + "/login")
    page = resp.read().decode("utf-8", "replace")
    token = page.split('name="CSRFToken" value="')[1].split('"')[0]
    body = urllib.parse.urlencode(
        {"CSRFToken": token, "email": email, "password": password}).encode()
    req = urllib.request.Request(base + "/api/guest/staff/login", data=body, method="POST")
    env = json.loads(opener.open(req).read())
    assert env.get("error") is None, str(env)[:200]
    return token


def call(opener, token, base, role, module, method, params=None, as_json=False):
    if as_json:
        payload = {"CSRFToken": token} if token else {}
        payload.update(params or {})
        body = json.dumps(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base in (PHP_DEV, PHP_PROD) else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    else:
        payload = dict(params or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base in (PHP_DEV, PHP_PROD) else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
    try:
        raw = opener.open(req, timeout=60).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
    return json.loads(raw)


def clear_php_app_cache():
    for pool in glob.glob("/home/hatch/scratch/fossbilling/runtime/src/data/cache/sf_cache_*"):
        shutil.rmtree(pool, ignore_errors=True)


def read_mock():
    try:
        return [json.loads(l) for l in pathlib.Path(MOCK).read_text().splitlines() if l.strip()]
    except FileNotFoundError:
        return []


def truncate_mock():
    pathlib.Path(MOCK).write_text("")


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
    cfg_hash = hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()
    base_activity = d.execute("SELECT COUNT(*) FROM activity_client_email").fetchone()[0]

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
        clear_php_app_cache()

    def qrow(qid):
        r = d.execute(
            "SELECT id, recipient, sender, subject, status, priority, tries,"
            " attachment_name, attachment_mime FROM email_queue WHERE id = ?", (qid,)).fetchone()
        return dict(r) if r else None

    def qcount():
        return d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0]

    def acount():
        return d.execute("SELECT COUNT(*) FROM activity_client_email").fetchone()[0]

    def craft(recipient, subject, content, priority=1, tries=0, status="pending",
              attachment=None, to_name="Rcpt Name", from_name="Send Name"):
        cur = d.execute(
            "INSERT INTO email_queue (recipient, sender, subject, content, to_name, from_name,"
            " client_id, admin_id, priority, tries, status, attachment_name, attachment_content,"
            " attachment_mime, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (recipient, "sender@example.com", subject, content, to_name, from_name, None, 1,
             priority, tries, status,
             attachment["name"] if attachment else None,
             attachment["content"] if attachment else None,
             attachment["mime"] if attachment else None, NOW, NOW))
        d.commit()
        return cur.lastrowid

    def set_config(opener, token, base, cfg):
        # Full-replace config_save through the stack's own API (R4a
        # path); config_save expects the full $data incl ext key.
        payload = dict(cfg)
        payload["ext"] = "mod_email"
        env = call(opener, token, base, "admin", "extension", "config_save", payload, as_json=True)
        assert env.get("error") is None, f"config_save failed on {base}: {str(env)[:300]}"
        clear_php_app_cache()

    def get_config(opener, token, base):
        env = call(opener, token, base, "admin", "extension", "config_get", {"ext": "mod_email"})
        assert env.get("error") is None, f"config_get failed on {base}: {str(env)[:300]}"
        return env["result"]

    base_cfg = {
        "mailer": "smtp", "smtp_host": "127.0.0.1", "smtp_port": "18025",
        "smtp_username": "dummy-user", "smtp_password": "dummy-pass",
        "log_enabled": "1", "queue_once": "0", "time_limit": "5", "cancel_after": "5",
    }

    corpus = {"php_prod": {}, "php_dev": {}, "ts_prefix": {}}
    try:
        # ---------- PHP-PROD run ----------
        op = make_opener()
        tok = login(op, PHP_PROD, SUPER_EMAIL, SUPER_PASS)
        set_config(op, tok, PHP_PROD, base_cfg)
        got = get_config(op, tok, PHP_PROD)
        check("php-prod config keys", set(base_cfg) <= set(got), f"keys={sorted(got)}")
        truncate_mock()
        q1 = craft("user@example.com", "R5e basic", "<p>Hello basic</p>")
        q2 = craft("att@example.com", "R5e attach", "<p>See attached</p>",
                   attachment={"name": "invoice.pdf", "content": b"%PDF-FAKE-BYTES", "mime": "application/pdf"})
        due_before = d.execute(
            "SELECT COUNT(*) FROM email_queue WHERE status IN ('pending','unsent','failed')").fetchone()[0]
        env = call(op, tok, PHP_PROD, "admin", "email", "batch_sendmail", {})
        check("php-prod batch returns null", env.get("result") is None and env.get("error") is None,
              f"{str(env)[:200]}")
        mock = read_mock()
        corpus["php_prod"]["basic"] = {"qrow": qrow(q1), "mock": [m for m in mock if "user@example.com" in m.get("rcptTo", [])]}
        corpus["php_prod"]["attach"] = {"qrow": qrow(q2), "mock": [m for m in mock if "att@example.com" in m.get("rcptTo", [])]}
        corpus["php_prod"]["queue_count"] = qcount()
        corpus["php_prod"]["activity_count"] = acount()
        check("php-prod basic row deleted", qrow(q1) is None, f"{qrow(q1)}")
        check("php-prod attach row deleted", qrow(q2) is None, f"{qrow(q2)}")
        check("php-prod mock got basic", len(corpus["php_prod"]["basic"]["mock"]) == 1,
              f"mock={len(mock)}")
        check("php-prod mock got attach", len(corpus["php_prod"]["attach"]["mock"]) == 1)
        check("php-prod activity logged all due", acount() == base_activity + due_before,
              f"activity={acount()} base={base_activity} due={due_before}")
        restore()

        # ---------- PHP-PROD reply-to/bcc + failures ----------
        op = make_opener()
        tok = login(op, PHP_PROD, SUPER_EMAIL, SUPER_PASS)
        cfg2 = dict(base_cfg, reply_to="reply@example.com",
                    bcc_email="bcc1@example.com, not-an-email, bcc2@example.com")
        set_config(op, tok, PHP_PROD, cfg2)
        truncate_mock()
        q3 = craft("bcc@example.com", "R5e bcc", "<p>Bcc case</p>")
        call(op, tok, PHP_PROD, "admin", "email", "batch_sendmail", {})
        mock = read_mock()
        corpus["php_prod"]["bcc"] = {"qrow": qrow(q3), "mock": [m for m in mock if "bcc@example.com" in m.get("rcptTo", [])]}
        check("php-prod bcc row deleted", qrow(q3) is None)
        # 550 reject: row kept, failed, tries 1, priority 0.
        q4 = craft("fail@example.com", "R5e fail", "<p>Will 550</p>")
        call(op, tok, PHP_PROD, "admin", "email", "batch_sendmail", {})
        corpus["php_prod"]["fail550"] = {"qrow": qrow(q4)}
        check("php-prod 550 state", qrow(q4) and qrow(q4)["status"] == "failed"
              and qrow(q4)["tries"] == 1 and qrow(q4)["priority"] == 0, f"{qrow(q4)}")
        # Missing host: config without smtp_host -> failed/tries+1.
        cfg3 = dict(base_cfg, smtp_host="")
        set_config(op, tok, PHP_PROD, cfg3)
        q5 = craft("nohost@example.com", "R5e nohost", "<p>No host</p>")
        call(op, tok, PHP_PROD, "admin", "email", "batch_sendmail", {})
        corpus["php_prod"]["nohost"] = {"qrow": qrow(q5)}
        check("php-prod nohost state", qrow(q5) and qrow(q5)["status"] == "failed"
              and qrow(q5)["tries"] == 1, f"{qrow(q5)}")
        # Unknown mailer -> failed/tries+1.
        cfg4 = dict(base_cfg, mailer="pigeon")
        set_config(op, tok, PHP_PROD, cfg4)
        q6 = craft("pigeon@example.com", "R5e pigeon", "<p>Unknown mailer</p>")
        call(op, tok, PHP_PROD, "admin", "email", "batch_sendmail", {})
        corpus["php_prod"]["unknown_mailer"] = {"qrow": qrow(q6)}
        check("php-prod unknown-mailer state", qrow(q6) and qrow(q6)["status"] == "failed"
              and qrow(q6)["tries"] == 1, f"{qrow(q6)}")
        restore()

        # ---------- PHP-DEV skip ----------
        op = make_opener()
        tok = login(op, PHP_DEV, SUPER_EMAIL, SUPER_PASS)
        set_config(op, tok, PHP_DEV, base_cfg)
        truncate_mock()
        q7 = craft("devskip@example.com", "R5e devskip", "<p>Dev skip</p>")
        call(op, tok, PHP_DEV, "admin", "email", "batch_sendmail", {})
        corpus["php_dev"]["skip"] = {"qrow": qrow(q7), "mock": read_mock()}
        check("php-dev row stays sending", qrow(q7) and qrow(q7)["status"] == "sending",
              f"{qrow(q7)}")
        check("php-dev mock empty", read_mock() == [], f"mock={read_mock()}")
        restore()

        # ---------- TS pre-fix ----------
        op = make_opener()
        tok = login(op, PHP_DEV, SUPER_EMAIL, SUPER_PASS)  # shared session table
        set_config(op, tok, TS, base_cfg)
        truncate_mock()
        q8 = craft("tsuser@example.com", "R5e ts", "<p>TS prefix</p>")
        env = call(op, tok, TS, "admin", "email", "batch_sendmail", {})
        corpus["ts_prefix"]["flip"] = {"qrow": qrow(q8), "mock": read_mock(),
                                        "envelope": env}
        check("ts prefix returns null", env.get("result") is None and env.get("error") is None,
              f"{str(env)[:200]}")
        check("ts prefix row sending", qrow(q8) and qrow(q8)["status"] == "sending",
              f"{qrow(q8)}")
        check("ts prefix mock empty", read_mock() == [], f"mock={read_mock()}")
    finally:
        restore()
        truncate_mock()

    # Invariants + config hash after.
    inv = {
        "invoice": d.execute("SELECT COUNT(*) FROM invoice").fetchone()[0],
        "email_queue": qcount(),
        "activity": acount(),
        "extension_meta": d.execute("SELECT COUNT(*) FROM extension_meta").fetchone()[0],
    }
    check("invariants after", inv == {"invoice": 323, "email_queue": 67, "activity": base_activity,
                                       "extension_meta": 3}, f"got={inv} base_activity={base_activity}")
    check("config hash after", hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)
    # Bodies are test strings (no secrets); store the full corpus.
    (OUT / "corpus.json").write_text(json.dumps(corpus, default=str, indent=1))
    print(f"\n{CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILURES:", FAILURES)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
