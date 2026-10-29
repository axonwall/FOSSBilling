#!/usr/bin/env python3
"""R5e parity38: SMTP transport + queue state machine, PHP-prod vs TS.

PHP oracle is :8081 (APP_ENV unset -> production -> actually sends);
:8080 (APP_ENV=dev) skips sending and is NOT the oracle here (capture41
proved the skip). TS is :3001/api/fb on the fresh R5e build.
Mock SMTP sink on :18025 (smtp-mock-server.mjs); recipient-pattern
scripted failures: fail@ -> 550, flaky@ -> 451 once then accept,
drop@ -> socket destroyed after DATA.

Comparison rules (R5c lesson + wire reality): compare DECODED bodies
(QP/base64 per MIME part), envelope, and headers — never raw DATA
bytes (Symfony vs nodemailer MIME encodings may differ). Message-ID
and Date are nondeterministic on both stacks and are masked, not
compared. AUTH mechanism is compared as-observed (Symfony picked
LOGIN; nodemailer may pick PLAIN or LOGIN — both authenticate; the
gate is delivery + envelope + body, not the mechanism choice).

Baseline trap (capture41 lesson): the reference queue holds 5 pending
rows that ARE due and will be sent by any batch run. Assertions are
therefore relative (deltas, crafted-recipient filters, crafted
priority-99 ordering) — never absolute queue counts mid-run. Full
snapshot restore in finally (all tables incl. email_queue,
extension_meta, activity_client_email, email_template).

Credentials: the crafted SMTP password is a DUMMY value. It is NEVER
printed, logged, or stored: the mock never records AUTH credentials,
and this suite prints shapes, states, and hashes only.
"""
import email as email_lib
import glob
import socket
import subprocess
import time
import hashlib
import http.cookiejar
import json
import pathlib
import shutil
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP_PROD = "http://127.0.0.1:8081"
PHP_DEV = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
MOCK = "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"

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
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP_PROD else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
    else:
        payload = dict(params or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP_PROD else f"{base}/{role}/{module}/{method}"
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


def parse_data(data):
    """Decoded wire message: headers + decoded html body + attachments."""
    msg = email_lib.message_from_string(data)
    html = None
    atts = []
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/html" and html is None:
                html = part.get_payload(decode=True).decode("utf-8", "replace")
            elif part.get_content_disposition() == "attachment":
                atts.append((part.get_filename(),
                             part.get_payload(decode=True),
                             part.get_content_type()))
    else:
        html = msg.get_payload(decode=True).decode("utf-8", "replace")
    return {"from": msg.get("From"), "to": msg.get("To"), "subject": msg.get("Subject"),
            "reply_to": msg.get("Reply-To"), "bcc_header": msg.get("Bcc"),
            "content_type": msg.get_content_type(), "charset": msg.get_content_charset(),
            "html": html, "atts": atts,
            "has_msgid": msg.get("Message-ID") is not None,
            "has_date": msg.get("Date") is not None}


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
    # Fresh mock: kill any leaked :18025 listener, start our own, kill
    # it in finally (a leaked mock breaks the next batch's §E the same
    # way leaked :3001 listeners have before).
    subprocess.run(["fuser", "-k", "18025/tcp"], capture_output=True)
    for _ in range(50):
        probe = socket.socket()
        if probe.connect_ex(("127.0.0.1", 18025)) != 0:
            probe.close()
            break
        probe.close()
        time.sleep(0.1)
    mock_log = open("/home/hatch/scratch/fossbilling/r5-logs/smtp-mock-server.log", "ab")
    mock_proc = subprocess.Popen(["node", "smtp-mock-server.mjs", "18025",
                                  "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl"],
                                 cwd=str(pathlib.Path(__file__).parent),
                                 stdout=mock_log, stderr=subprocess.STDOUT)
    for _ in range(50):
        probe = socket.socket()
        if probe.connect_ex(("127.0.0.1", 18025)) == 0:
            probe.close()
            break
        probe.close()
        time.sleep(0.1)
    # One shared admin session for the whole suite (see note above).
    # restore() re-logs in after every snapshot restore, because the
    # restore wipes the session row the login created (sessions live
    # in the snapshotted `session` table).
    SESS = {"op": None, "tok": None}

    def refresh_session():
        op = make_opener()
        SESS["op"] = op
        SESS["tok"] = login(op, PHP_DEV, SUPER_EMAIL, SUPER_PASS)

    refresh_session()

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
        refresh_session()

    def qrow(qid):
        r = d.execute(
            "SELECT id, recipient, status, priority, tries, content FROM email_queue WHERE id = ?", (qid,)).fetchone()
        return dict(r) if r else None

    def craft(recipient, subject, content, priority=1, tries=0, status="pending", attachment=None):
        cur = d.execute(
            "INSERT INTO email_queue (recipient, sender, subject, content, to_name, from_name,"
            " client_id, admin_id, priority, tries, status, attachment_name, attachment_content,"
            " attachment_mime, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (recipient, "sender@example.com", subject, content, "Rcpt Name", "Send Name", None, 1,
             priority, tries, status,
             attachment["name"] if attachment else None,
             attachment["content"] if attachment else None,
             attachment["mime"] if attachment else None, NOW, NOW))
        d.commit()
        return cur.lastrowid

    def set_config(opener, token, base, cfg):
        payload = dict(cfg)
        payload["ext"] = "mod_email"
        env = call(opener, token, base, "admin", "extension", "config_save", payload, as_json=True)
        assert env.get("error") is None, f"config_save failed on {base}: {str(env)[:300]}"
        clear_php_app_cache()

    def batch(opener, token, base):
        env = call(opener, token, base, "admin", "email", "batch_sendmail", {})
        assert env.get("error") is None and env.get("result") is None, f"batch failed on {base}: {str(env)[:300]}"

    def mock_for(recipient):
        return [m for m in read_mock() if m.get("type") == "accepted" and recipient in (m.get("rcptTo") or [])]

    def mock_rejected(recipient):
        return [m for m in read_mock() if m.get("type") == "rejected"
                and recipient in (m.get("rcptTo") or [])]

    base_cfg = {
        "mailer": "smtp", "smtp_host": "127.0.0.1", "smtp_port": "18025",
        "smtp_username": "", "smtp_password": "",
        "log_enabled": "1", "queue_once": "0", "time_limit": "5", "cancel_after": "5",
    }
    auth_cfg = dict(base_cfg, smtp_username="dummy-user", smtp_password="dummy-pass")

    # One stack run: set config, craft rows, batch, return observations.
    # `spec` = list of row dicts; returns {rows: [qrow|None], mock, activity}.
    def run_stack(base, cfg, spec):
        # Shared session (dev-created) works for prod + TS: same host,
        # port-independent cookies, same DB session rows.
        op, tok = SESS["op"], SESS["tok"]
        set_config(op, tok, base, cfg)
        truncate_mock()
        ids = [craft(**s) for s in spec]
        act_before = d.execute("SELECT MAX(id) FROM activity_client_email").fetchone()[0]
        batch(op, tok, base)
        # Activity rows created by this run: ids greater than act_before.
        act = [dict(r) for r in d.execute(
            "SELECT client_id, sender, recipients, subject, content_html, content_text,"
            " attachment_name, attachment_mime FROM activity_client_email"
            + (" WHERE id > ?" if act_before is not None else "") + " ORDER BY id",
            (act_before,) if act_before is not None else ())]
        return {"ids": ids, "rows": [qrow(i) for i in ids], "mock": read_mock(), "activity": act,
                "op": op, "tok": tok}

    results = {}
    try:
        # ---------- A1: basic delivery, no auth ----------
        spec = [{"recipient": "a1@example.com", "subject": "R5e A1", "content": "<p>A1 body</p>"}]
        for label, base, cfg in (("php", PHP_PROD, base_cfg), ("ts", TS, base_cfg)):
            r = run_stack(base, cfg, spec)
            results[f"a1_{label}"] = r
            acc = [m for m in r["mock"] if m.get("type") == "accepted"
                   and "a1@example.com" in (m.get("rcptTo") or [])]
            check(f"a1 {label} row deleted", r["rows"][0] is None, f"{r['rows'][0]}")
            check(f"a1 {label} mock accepted", len(acc) == 1, f"acc={len(acc)}")
            check(f"a1 {label} activity 1+", len(r["activity"]) >= 1, f"activity={len(r['activity'])}")
            restore()
        # Re-derive from stored runs: mock lists were captured per-run.
        php_data = [m for m in results["a1_php"]["mock"] if m.get("type") == "accepted"
                    and "a1@example.com" in (m.get("rcptTo") or [])][0]["data"]
        ts_data = [m for m in results["a1_ts"]["mock"] if m.get("type") == "accepted"
                   and "a1@example.com" in (m.get("rcptTo") or [])][0]["data"]
        pm, tm = parse_data(php_data), parse_data(ts_data)
        for f in ("from", "to", "subject", "content_type", "charset", "html"):
            check(f"a1 wire {f} equal", pm[f] == tm[f], f"php={pm[f]!r} ts={tm[f]!r}")
        check("a1 wire no Bcc header", pm["bcc_header"] is None and tm["bcc_header"] is None)
        check("a1 wire has msgid+date", pm["has_msgid"] and pm["has_date"] and tm["has_msgid"] and tm["has_date"])
        check("a1 wire body has appended newline", pm["html"] == "<p>A1 body</p>\r\n" and tm["html"] == "<p>A1 body</p>\r\n",
              f"php={pm['html']!r} ts={tm['html']!r}")
        check("a1 php no auth", results["a1_php"]["mock"][0].get("auth") is None)
        check("a1 ts no auth", [m for m in results["a1_ts"]["mock"] if m.get("type") == "accepted"][0].get("auth") is None)
        php_act = [a for a in results["a1_php"]["activity"] if a["recipients"] == "a1@example.com"]
        ts_act = [a for a in results["a1_ts"]["activity"] if a["recipients"] == "a1@example.com"]
        check("a1 activity equal", len(php_act) == 1 and len(ts_act) == 1 and all(
            php_act[0][k] == ts_act[0][k] for k in
            ("client_id", "sender", "recipients", "subject", "content_html", "content_text",
             "attachment_name", "attachment_mime")), f"php={php_act} ts={ts_act}")

        # ---------- A2: auth delivery ----------
        spec = [{"recipient": "a2@example.com", "subject": "R5e A2", "content": "<p>A2 auth</p>"}]
        for label, base in (("php", PHP_PROD), ("ts", TS)):
            r = run_stack(base, auth_cfg, spec)
            results[f"a2_{label}"] = r
            acc = [m for m in r["mock"] if m.get("type") == "accepted" and "a2@example.com" in (m.get("rcptTo") or [])]
            check(f"a2 {label} delivered + auth attempted", len(acc) == 1 and acc[0].get("auth") in ("PLAIN", "LOGIN"),
                  f"acc={len(acc)} auth={[m.get('auth') for m in acc]}")
            restore()
        php_data = [m for m in results["a2_php"]["mock"] if m.get("type") == "accepted"
                    and "a2@example.com" in (m.get("rcptTo") or [])][0]["data"]
        ts_data = [m for m in results["a2_ts"]["mock"] if m.get("type") == "accepted"
                   and "a2@example.com" in (m.get("rcptTo") or [])][0]["data"]
        pm, tm = parse_data(php_data), parse_data(ts_data)
        check("a2 wire body equal", pm["html"] == tm["html"] == "<p>A2 auth</p>\r\n")
        check("a2 wire headers equal", pm["from"] == tm["from"] and pm["to"] == tm["to"]
              and pm["subject"] == tm["subject"], f"php={pm} ts={tm}")

        # ---------- B: attachment ----------
        att = {"name": "invoice.pdf", "content": b"%PDF-FAKE-BYTES", "mime": "application/pdf"}
        spec = [{"recipient": "b@example.com", "subject": "R5e B", "content": "<p>See attached</p>",
                 "attachment": att}]
        for label, base in (("php", PHP_PROD), ("ts", TS)):
            r = run_stack(base, base_cfg, spec)
            results[f"b_{label}"] = r
            acc = [m for m in r["mock"] if m.get("type") == "accepted" and "b@example.com" in (m.get("rcptTo") or [])]
            check(f"b {label} row deleted", r["rows"][0] is None)
            check(f"b {label} mock accepted", len(acc) == 1)
            restore()
        pm = parse_data([m for m in results["b_php"]["mock"] if m.get("type") == "accepted"
                         and "b@example.com" in (m.get("rcptTo") or [])][0]["data"])
        tm = parse_data([m for m in results["b_ts"]["mock"] if m.get("type") == "accepted"
                         and "b@example.com" in (m.get("rcptTo") or [])][0]["data"])
        check("b body equal", pm["html"] == tm["html"] == "<p>See attached</p>\r\n")
        check("b attachment equal", pm["atts"] == tm["atts"] and len(pm["atts"]) == 1
              and pm["atts"][0][0] == "invoice.pdf" and pm["atts"][0][1] == b"%PDF-FAKE-BYTES"
              and pm["atts"][0][2] == "application/pdf", f"php={pm['atts']} ts={tm['atts']}")

        # ---------- C: reply-to + bcc ----------
        cfg_c = dict(base_cfg, reply_to="reply@example.com",
                     bcc_email="bcc1@example.com, not-an-email, bcc2@example.com")
        spec = [{"recipient": "c@example.com", "subject": "R5e C", "content": "<p>C case</p>"}]
        for label, base in (("php", PHP_PROD), ("ts", TS)):
            r = run_stack(base, cfg_c, spec)
            results[f"c_{label}"] = r
            acc = [m for m in r["mock"] if m.get("type") == "accepted"]
            mine = [m for m in acc if "c@example.com" in (m.get("rcptTo") or [])]
            check(f"c {label} envelope includes valid bcc only",
                  len(mine) == 1 and sorted(mine[0]["rcptTo"]) == ["bcc1@example.com", "bcc2@example.com", "c@example.com"],
                  f"rcpt={mine[0]['rcptTo'] if mine else []}")
            restore()
        pm = parse_data([m for m in results["c_php"]["mock"] if m.get("type") == "accepted"
                         and "c@example.com" in (m.get("rcptTo") or [])][0]["data"])
        tm = parse_data([m for m in results["c_ts"]["mock"] if m.get("type") == "accepted"
                         and "c@example.com" in (m.get("rcptTo") or [])][0]["data"])
        check("c reply-to equal", pm["reply_to"] == tm["reply_to"] == "reply@example.com")
        check("c no Bcc header", pm["bcc_header"] is None and tm["bcc_header"] is None)

        # ---------- D: invalid reply-to ----------
        cfg_d = dict(base_cfg, reply_to="not-an-email")
        spec = [{"recipient": "d@example.com", "subject": "R5e D", "content": "<p>D case</p>"}]
        for label, base in (("php", PHP_PROD), ("ts", TS)):
            r = run_stack(base, cfg_d, spec)
            results[f"d_{label}"] = r
            acc = [m for m in r["mock"] if m.get("type") == "accepted" and "d@example.com" in (m.get("rcptTo") or [])]
            check(f"d {label} delivered, no reply-to", len(acc) == 1
                  and parse_data(acc[0]["data"])["reply_to"] is None)
            restore()

        # ---------- E: transient flaky -> retry then success ----------
        # Distinct recipients per stack: the mock's flakySeen set is
        # per-recipient and persists for the mock process lifetime.
        for label, base, rcpt in (("php", PHP_PROD, "pflaky@example.com"),
                                  ("ts", TS, "tflaky@example.com")):
            op, tok = SESS["op"], SESS["tok"]
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            qid = craft(rcpt, "R5e E", "<p>Flaky</p>")
            batch(op, tok, base)
            st1 = qrow(qid)
            rej = mock_rejected(rcpt)
            check(f"e {label} first attempt failed/tries1", st1 and st1["status"] == "failed"
                  and st1["tries"] == 1 and st1["priority"] == 0, f"{st1}")
            check(f"e {label} mock 451 once", len(rej) == 1 and rej[0]["code"] == 451, f"rej={rej}")
            batch(op, tok, base)
            check(f"e {label} second attempt deleted", qrow(qid) is None)
            acc = mock_for(rcpt)
            check(f"e {label} mock accepted on retry", len(acc) == 1)
            restore()

        # ---------- F: cancel_after boundary ----------
        for label, base in (("php", PHP_PROD), ("ts", TS)):
            op, tok = SESS["op"], SESS["tok"]
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            # fail@ forces the failure path deterministically; tries=4
            # survives (5 > 5 false), tries=5 is dropped (6 > 5).
            q_keep2 = craft("pfail@example.com" if label == "php" else "tfail@example.com",
                            "R5e F keep2", "<p>F keep2</p>", tries=4)
            q_drop2 = craft("pfail2@example.com" if label == "php" else "tfail2@example.com",
                            "R5e F drop2", "<p>F drop2</p>", tries=5)
            batch(op, tok, base)
            check(f"f {label} fail tries4 kept failed/tries5",
                  qrow(q_keep2) and qrow(q_keep2)["status"] == "failed" and qrow(q_keep2)["tries"] == 5,
                  f"{qrow(q_keep2)}")
            check(f"f {label} fail tries5 dropped (tries6>5)",
                  qrow(q_drop2) is None, f"{qrow(q_drop2)}")
            restore()

        # ---------- G: connection drop ----------
        for label, base, rcpt in (("php", PHP_PROD, "pdrop@example.com"),
                                  ("ts", TS, "tdrop@example.com")):
            op, tok = SESS["op"], SESS["tok"]
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            qid = craft(rcpt, "R5e G", "<p>Drop</p>")
            batch(op, tok, base)
            st = qrow(qid)
            rej = mock_rejected(rcpt)
            check(f"g {label} drop -> failed/tries1", st and st["status"] == "failed" and st["tries"] == 1,
                  f"{st}")
            check(f"g {label} mock drop recorded", len(rej) == 1 and rej[0]["code"] == "drop", f"rej={rej}")
            restore()

        # ---------- H: config errors -> failure state ----------
        for name, cfg_h in (("nohost", dict(base_cfg, smtp_host="")),
                            ("badport", dict(base_cfg, smtp_port="abc")),
                            ("unknown", dict(base_cfg, mailer="pigeon")),
                            ("sendmail", dict(base_cfg, mailer="sendmail"))):
            for label, base in (("php", PHP_PROD), ("ts", TS)):
                op, tok = SESS["op"], SESS["tok"]
                set_config(op, tok, base, cfg_h)
                truncate_mock()
                qid = craft(f"h{name}@example.com", f"R5e H {name}", "<p>H case</p>")
                batch(op, tok, base)
                st = qrow(qid)
                check(f"h {name} {label} failed/tries1/prio0", st and st["status"] == "failed"
                      and st["tries"] == 1 and st["priority"] == 0, f"{st}")
                restore()

        # ---------- I: queue_once + priority order + time_limit ----------
        for label, base in (("php", PHP_PROD), ("ts", TS)):
            op, tok = SESS["op"], SESS["tok"]
            set_config(op, tok, base, dict(base_cfg, queue_once="2"))
            truncate_mock()
            ids = [craft(f"i{label}{n}@example.com", f"R5e I {n}", "<p>I</p>", priority=99)
                   for n in (1, 2, 3)]
            batch(op, tok, base)
            states = [qrow(i) for i in ids]
            check(f"i queue_once {label} sends exactly 2, leaves highest id",
                  states[0] is None and states[1] is None and states[2] is not None
                  and states[2]["status"] == "pending", f"{states}")
            restore()
            op, tok = SESS["op"], SESS["tok"]  # restore() refreshed the session
            # Priority order: relative order of crafted recipients in mock.
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            craft(f"ip{label}1@example.com", "R5e IP1", "<p>IP</p>", priority=1)
            craft(f"ip{label}5@example.com", "R5e IP5", "<p>IP</p>", priority=5)
            craft(f"ip{label}3@example.com", "R5e IP3", "<p>IP</p>", priority=3)
            batch(op, tok, base)
            order = [m["rcptTo"][0] for m in read_mock() if m.get("type") == "accepted"
                     and m["rcptTo"][0].startswith(f"ip{label}")]
            check(f"i priority order {label}", order == [f"ip{label}5@example.com", f"ip{label}3@example.com",
                                                          f"ip{label}1@example.com"], f"order={order}")
            restore()
            op, tok = SESS["op"], SESS["tok"]  # restore() refreshed the session
            # time_limit=-1: exactly 1 send per batch call.
            set_config(op, tok, base, dict(base_cfg, time_limit="-1"))
            truncate_mock()
            ids = [craft(f"it{label}{n}@example.com", f"R5e IT {n}", "<p>IT</p>", priority=99)
                   for n in (1, 2)]
            batch(op, tok, base)
            states = [qrow(i) for i in ids]
            check(f"i time_limit -1 {label} sends exactly 1",
                  states[0] is None and states[1] is not None, f"{states}")
            restore()

        # ---------- J: send_now via template_send ----------
        # A brand-new code would create a DISABLED template on both
        # stacks (PHP _getDefaults leaves enabled=0), and template_send
        # returns false without queueing — so craft an ENABLED custom
        # template row first (snapshot-restored in finally).
        def craft_template():
            d.execute(
                "INSERT INTO email_template (action_code, category, enabled, is_custom, is_overridden,"
                " subject, content, description) VALUES (?,?,?,?,?,?,?,?)",
                ("test_r5e_sendnow", "test", 1, 1, 0, "R5e sendnow", "<p>Sendnow body</p>", ""))
            d.commit()

        for label, base in (("php", PHP_PROD), ("ts", TS)):
            op, tok = SESS["op"], SESS["tok"]
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            craft_template()
            env = call(op, tok, base, "admin", "email", "template_send", {
                "code": "test_r5e_sendnow", "to": f"j{label}@example.com",
                "send_now": True}, as_json=True)
            check(f"j send_now {label} returns true", env.get("result") is True, f"{str(env)[:200]}")
            acc = mock_for(f"j{label}@example.com")
            check(f"j send_now {label} delivered", len(acc) == 1)
            if acc:
                check(f"j send_now {label} body", parse_data(acc[0]["data"])["html"] == "<p>Sendnow body</p>\r\n")
            qleft = d.execute("SELECT COUNT(*) FROM email_queue WHERE recipient = ?",
                              (f"j{label}@example.com",)).fetchone()[0]
            check(f"j send_now {label} no queue row left", qleft == 0, f"qleft={qleft}")
            restore()
            op, tok = SESS["op"], SESS["tok"]  # restore() refreshed the session
            # send_now absent -> row stays pending.
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            craft_template()
            env = call(op, tok, base, "admin", "email", "template_send", {
                "code": "test_r5e_sendnow", "to": f"j2{label}@example.com"}, as_json=True)
            check(f"j queue-only {label} returns true", env.get("result") is True, f"{str(env)[:200]}")
            qleft = d.execute("SELECT COUNT(*) FROM email_queue WHERE recipient = ? AND status = 'pending'",
                              (f"j2{label}@example.com",)).fetchone()[0]
            check(f"j queue-only {label} row pending", qleft == 1, f"qleft={qleft}")
            check(f"j queue-only {label} mock empty", mock_for(f"j2{label}@example.com") == [])
            restore()
            op, tok = SESS["op"], SESS["tok"]  # restore() refreshed the session
            # throw_exceptions + missing host -> exact validation message.
            set_config(op, tok, base, dict(base_cfg, smtp_host=""))
            truncate_mock()
            craft_template()
            env = call(op, tok, base, "admin", "email", "template_send", {
                "code": "test_r5e_sendnow", "to": f"j3{label}@example.com",
                "send_now": True, "throw_exceptions": True}, as_json=True)
            check(f"j throw {label} exact message",
                  env.get("error") and env["error"].get("message") == "SMTP host or port is not configured",
                  f"{str(env)[:300]}")
            qleft = d.execute("SELECT status, tries FROM email_queue WHERE recipient = ?",
                              (f"j3{label}@example.com",)).fetchone()
            check(f"j throw {label} row failed/tries1", qleft and qleft[0] == "failed" and qleft[1] == 1,
                  f"{qleft}")
            restore()
            op, tok = SESS["op"], SESS["tok"]  # restore() refreshed the session
            # String send_now: PHP strict-bool param 9998s, TS sends.
            # Pinned divergence (TS is more permissive here by design:
            # the seam is stringly-typed; the JSON-bool path matches).
            set_config(op, tok, base, base_cfg)
            truncate_mock()
            craft_template()
            env = call(op, tok, base, "admin", "email", "template_send", {
                "code": "test_r5e_sendnow", "to": f"j4{label}@example.com",
                "send_now": "1"}, as_json=True)
            if label == "php":
                check("j string send_now php 9998",
                      env.get("error") and env["error"].get("code") == 9998
                      and "must be of type bool" in env["error"].get("message", ""),
                      f"{str(env)[:300]}")
            else:
                check("j string send_now ts sends",
                      env.get("result") is True and len(mock_for(f"j4{label}@example.com")) == 1,
                      f"{str(env)[:200]}")
            restore()
    finally:
        restore()
        truncate_mock()
        mock_proc.terminate()
        try:
            mock_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock_proc.kill()

    inv = {
        "invoice": d.execute("SELECT COUNT(*) FROM invoice").fetchone()[0],
        "email_queue": d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0],
        "activity": d.execute("SELECT COUNT(*) FROM activity_client_email").fetchone()[0],
        "extension_meta": d.execute("SELECT COUNT(*) FROM extension_meta").fetchone()[0],
        "email_template": d.execute("SELECT COUNT(*) FROM email_template").fetchone()[0],
    }
    base_templates = [r[0] for r in snaps["email_template"][0]]
    check("invariants after", inv["invoice"] == 323 and inv["email_queue"] == 67
          and inv["activity"] == base_activity and inv["extension_meta"] == 3
          and inv["email_template"] == len(base_templates), f"got={inv}")
    check("config hash after", hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest() == cfg_hash)
    print(f"\n{CHECKS} checks, {len(FAILURES)} failures")
    if FAILURES:
        print("FAILURES:", FAILURES)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
