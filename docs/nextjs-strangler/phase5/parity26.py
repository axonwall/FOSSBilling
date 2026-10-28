#!/usr/bin/env python3
"""Phase 5 R2b parity: admin pages + actions, compared live on PHP (:8080)
vs TS (:3001/api/fb).

Sections:
  A. Page smoke (TS pages only, super-admin session): every new/changed
     route returns 200 with the sidebar and its expected markers; the
     invoice detail for a missing id renders the not-found box.
  B. Logged-out smoke: invoice detail shows the login link and no
     sidebar; the new-client form renders without the sidebar.
  C. Action equivalence: each R2b action is run against PHP, its
     envelope + resulting record state recorded, the DB restored, then
     run against TS and compared. Crafted rows (suspended/canceled
     orders, open/closed tickets, draft invoice) are re-crafted
     identically per stack; sqlite_sequence is restored so created-row
     ids match across stacks.
Only envelopes are compared, never HTTP status: TS error envelopes are
always HTTP 200 by seam convention while PHP answers 4xx with the same
envelope, documented not hidden.
"""
import json
import pathlib
import re
import sqlite3
import urllib.request
import urllib.parse
import urllib.error
import http.cookiejar

PHP = "http://127.0.0.1:8080"
TS = "http://127.0.0.1:3001/api/fb"
TS_PAGES = "http://127.0.0.1:3001"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"

FAILURES = []
CHECKS = 0
STATUS_NOTES = []


def scrub(v):
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    if isinstance(v, str):
        v = re.sub(r"\b[0-9a-f]{64}\b", "<hex64>", v)
        v = re.sub(r"\b[0-9a-f]{32}\b", "<hex32>", v)
        v = re.sub(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", "<ts>", v)
        return v
    return v


def check(name, php_val, ts_val):
    global CHECKS
    CHECKS += 1
    a, b = scrub(php_val), scrub(ts_val)
    if a != b:
        FAILURES.append((name, a, b))
        print("FAIL", name)
    else:
        print("ok  ", name)


def check_raw(name, php_val, ts_val):
    """Unscrubbed comparison, for values that must match exactly (e.g. a
    renewed expiry computed deterministically from the stored expiry)."""
    global CHECKS
    CHECKS += 1
    if php_val != ts_val:
        FAILURES.append((name, php_val, ts_val))
        print("FAIL", name)
    else:
        print("ok  ", name)


def main():
    global CHECKS
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

    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    m = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page)
    token = m.group(1) if m else None

    def call(base, role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        url = f"{base}/api/{role}/{module}/{method}" if base == PHP else f"{base}/{role}/{module}/{method}"
        req = urllib.request.Request(url, data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                raw, status = resp.read(), resp.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        try:
            parsed = json.loads(raw.decode())
        except Exception:
            parsed = {"_raw": raw[:200].decode("utf-8", "replace")}
        return parsed, status

    def both(role, module, method, data=None):
        p, p_status = call(PHP, role, module, method, data)
        t, t_status = call(TS, role, module, method, data)
        if p_status != t_status:
            STATUS_NOTES.append((f"{role}/{module}/{method}", p_status, t_status))
        return p, t

    def login():
        payload = {"email": SUPER_EMAIL, "password": SUPER_PASS}
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/guest/staff/login", data=body, method="POST")
        with op.open(req, timeout=60) as resp:
            parsed = json.loads(resp.read().decode())
        assert parsed.get("error") is None, f"login failed: {parsed}"

    def craft_order_copy(status):
        cols = [r[1] for r in d.execute("PRAGMA table_info(client_order)") if r[1] != "id"]
        col_list = ",".join(cols)
        d.execute(f"INSERT INTO client_order ({col_list}) SELECT {col_list} FROM client_order WHERE id = 1")
        nid = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("UPDATE client_order SET status = ? WHERE id = ?", (status, nid))
        d.commit()
        return nid

    def craft_ticket_copy(status):
        cols = [r[1] for r in d.execute("PRAGMA table_info(support_ticket)") if r[1] != "id"]
        col_list = ",".join(cols)
        d.execute(f"INSERT INTO support_ticket ({col_list}) SELECT {col_list} FROM support_ticket WHERE id = 1")
        nid = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("UPDATE support_ticket SET status = ? WHERE id = ?", (status, nid))
        d.commit()
        return nid

    def craft_draft_invoice():
        import secrets
        cols = [r[1] for r in d.execute("PRAGMA table_info(invoice)") if r[1] not in ("id", "hash")]
        col_list = ",".join(cols)
        d.execute(f"INSERT INTO invoice ({col_list}, hash) SELECT {col_list}, ? FROM invoice WHERE id = 2",
                  (secrets.token_hex(24),))
        nid = d.execute("SELECT last_insert_rowid()").fetchone()[0]
        d.execute("UPDATE invoice SET issued = 0, status = 'unpaid' WHERE id = ?", (nid,))
        d.commit()
        return nid

    try:
        login()
        # Snapshot AFTER login so the session row survives restores.
        for t in tables:
            cols = [r[1] for r in d.execute(f'PRAGMA table_info("{t}")')]
            snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(), cols)
        seq = d.execute("SELECT name, seq FROM sqlite_sequence").fetchall()

        # ---- A. page smoke ----
        op_pages = urllib.request.build_opener()
        cookie_hdr = "; ".join(f"{c.name}={c.value}" for c in cj)

        def smoke(path, needles, aside=True):
            global CHECKS
            CHECKS += 1
            req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
            req.add_header("Cookie", cookie_hdr)
            try:
                with op_pages.open(req, timeout=60) as resp:
                    body, status = resp.read().decode("utf-8", "replace"), resp.status
            except urllib.error.HTTPError as e:
                body, status = e.read().decode("utf-8", "replace"), e.code
            missing = [n for n in needles if n not in body]
            has_aside = "<aside" in body
            if status != 200 or missing or has_aside != aside:
                FAILURES.append((f"page_{path}", {"status": status, "missing": missing, "aside": has_aside},
                                 f"200+needles+aside={aside}"))
                print("FAIL", f"page_{path}", status, missing, has_aside)
            else:
                print("ok  ", f"page_{path}")

        smoke("/admin/invoices/1", ["FOSS00001", "Lines", "Refund", "PDF"])
        smoke("/admin/invoices/2", ["Mark as paid", "Send reminder", "Lines"])
        smoke("/admin/invoices/999999", ["Invoice was not found"])
        smoke("/admin/clients/new", ["New client", 'name="email"', 'name="first_name"'])
        smoke("/admin/clients/1", ["Edit", "phase0.client@example.com"])
        smoke("/admin/orders/1", ["Suspend", "Renew", "Cancel", "Reason"])
        smoke("/admin/orders/4", ["Activate", "Cancel"])
        smoke("/admin/tickets/1", ["Reopen ticket", "Delete ticket", "Reply as staff"])

        # ---- B. logged-out smoke ----
        op_anon = urllib.request.build_opener()
        for path, needles in [("/admin/invoices/1", ["Sign in as staff"]),
                              ("/admin/clients/new", ["New client"])]:
            CHECKS += 1
            req = urllib.request.Request(f"{TS_PAGES}{path}", method="GET")
            with op_anon.open(req, timeout=60) as resp:
                body, status = resp.read().decode("utf-8", "replace"), resp.status
            missing = [n for n in needles if n not in body]
            if status != 200 or missing or "<aside" in body:
                FAILURES.append((f"page_anon_{path}", {"status": status, "missing": missing,
                                                       "aside": "<aside" in body}, "200+needles+no-aside"))
                print("FAIL", f"page_anon_{path}", status, missing, "<aside" in body)
            else:
                print("ok  ", f"page_anon_{path}")

        # ---- C. action equivalence ----
        def run_case(name, craft, action, state, raw_state=False):
            """action(ids) -> (role, module, method, data); state(ids, base) -> value.
            Runs on PHP, restores, re-crafts, runs on TS, compares envelope + state."""
            restore()
            ids = craft() if craft else {}
            p_env, _ = call(PHP, *action(ids))
            p_state = state(ids, PHP)
            restore()
            ids = craft() if craft else {}
            t_env, _ = call(TS, *action(ids))
            t_state = state(ids, TS)
            check(f"{name}_env", p_env, t_env)
            (check_raw if raw_state else check)(f"{name}_state", p_state, t_state)

        def get(base, role, module, method, data):
            return call(base, role, module, method, data)[0]

        run_case("inv_markpaid", None,
                 lambda _: ("admin", "invoice", "mark_as_paid", {"id": "2"}),
                 lambda _, b: get(b, "admin", "invoice", "get", {"id": "2"}).get("result", {}).get("status"))
        run_case("inv_markpaid_ok", None,
                 lambda _: ("admin", "invoice", "mark_as_paid",
                            {"id": "2", "gateway_id": "1", "transactionId": "R2B-TXN-1"}),
                 lambda _, b: get(b, "admin", "invoice", "get", {"id": "2"}).get("result", {}).get("status"))
        run_case("inv_refund", None,
                 lambda _: ("admin", "invoice", "refund", {"id": "1"}),
                 lambda _, b: (lambda r: (r.get("status"), r.get("refund")))(
                     get(b, "admin", "invoice", "get", {"id": "1"}).get("result", {})))
        run_case("inv_cancel", None,
                 lambda _: ("admin", "invoice", "cancel", {"id": "3"}),
                 lambda _, b: get(b, "admin", "invoice", "get", {"id": "3"}).get("result", {}).get("status"))
        run_case("inv_delete", lambda: {"id": craft_draft_invoice()},
                 lambda ids: ("admin", "invoice", "delete", {"id": str(ids["id"])}),
                 lambda ids, b: get(b, "admin", "invoice", "get", {"id": str(ids["id"])}))
        run_case("inv_reminder", None,
                 lambda _: ("admin", "invoice", "send_reminder", {"id": "4"}),
                 lambda _, b: {"reminded": bool(get(b, "admin", "invoice", "get", {"id": "4"}).get("result", {}).get("reminded_at")),
                             "queue": d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0]})
        run_case("inv_get_missing", None,
                 lambda _: ("admin", "invoice", "get", {"id": "999999"}),
                 lambda _, b: {})
        run_case("client_create", None,
                 lambda _: ("admin", "client", "create",
                            {"email": "r2b-new@example.local", "first_name": "R2b", "last_name": "New",
                             "send_welcome_email": "0", "password": "R2b-Client!42"}),
                 lambda _, b: (lambda r: (r.get("email"), r.get("first_name"), r.get("status")))(
                     get(b, "admin", "client", "get", {"email": "r2b-new@example.local"}).get("result", {})))
        run_case("client_create_dup", None,
                 lambda _: ("admin", "client", "create",
                            {"email": "phase0.client@example.com", "first_name": "Dup"}),
                 lambda _, b: {})
        run_case("client_create_missing", None,
                 lambda _: ("admin", "client", "create", {}),
                 lambda _, b: {})
        run_case("client_update", None,
                 lambda _: ("admin", "client", "update", {"id": "1", "city": "R2b City"}),
                 lambda _, b: get(b, "admin", "client", "get", {"id": "1"}).get("result", {}).get("city"))
        run_case("client_update_dup", None,
                 lambda _: ("admin", "client", "update", {"id": "1", "email": "phase1.diag@example.com"}),
                 lambda _, b: {})
        run_case("client_update_currency", None,
                 lambda _: ("admin", "client", "update", {"id": "1", "currency": "EUR"}),
                 lambda _, b: {})
        run_case("order_activate", None,
                 lambda _: ("admin", "order", "activate", {"id": "4"}),
                 lambda _, b: get(b, "admin", "order", "get", {"id": "4"}).get("result", {}).get("status"))
        run_case("order_suspend", None,
                 lambda _: ("admin", "order", "suspend", {"id": "1", "reason": "R2b test"}),
                 lambda _, b: get(b, "admin", "order", "get", {"id": "1"}).get("result", {}).get("status"))
        run_case("order_unsuspend", lambda: {"id": craft_order_copy("suspended")},
                 lambda ids: ("admin", "order", "unsuspend", {"id": str(ids["id"])}),
                 lambda ids, b: get(b, "admin", "order", "get", {"id": str(ids["id"])}).get("result", {}).get("status"))
        run_case("order_cancel", None,
                 lambda _: ("admin", "order", "cancel", {"id": "2", "reason": "R2b test"}),
                 lambda _, b: get(b, "admin", "order", "get", {"id": "2"}).get("result", {}).get("status"))
        run_case("order_uncancel", lambda: {"id": craft_order_copy("canceled")},
                 lambda ids: ("admin", "order", "uncancel", {"id": str(ids["id"])}),
                 lambda ids, b: get(b, "admin", "order", "get", {"id": str(ids["id"])}).get("result", {}).get("status"))
        run_case("order_renew", None,
                 lambda _: ("admin", "order", "renew", {"id": "3"}),
                 lambda _, b: (lambda r: (r.get("status"), r.get("expires_at")))(
                     get(b, "admin", "order", "get", {"id": "3"}).get("result", {})),
                 raw_state=True)
        run_case("order_delete", lambda: {"id": craft_order_copy("pending_setup")},
                 lambda ids: ("admin", "order", "delete", {"id": str(ids["id"])}),
                 lambda ids, b: get(b, "admin", "order", "get", {"id": str(ids["id"])}))
        run_case("order_get_missing", None,
                 lambda _: ("admin", "order", "get", {"id": "999999"}),
                 lambda _, b: {})
        run_case("ticket_close", lambda: {"id": craft_ticket_copy("open")},
                 lambda ids: ("admin", "support", "ticket_close", {"id": str(ids["id"])}),
                 lambda ids, b: get(b, "admin", "support", "ticket_get", {"id": str(ids["id"])}).get("result", {}).get("status"))
        run_case("ticket_reopen", lambda: {"id": craft_ticket_copy("closed")},
                 lambda ids: ("admin", "support", "ticket_update", {"id": str(ids["id"]), "status": "open"}),
                 lambda ids, b: get(b, "admin", "support", "ticket_get", {"id": str(ids["id"])}).get("result", {}).get("status"))
        run_case("ticket_update_subject", lambda: {"id": craft_ticket_copy("open")},
                 lambda ids: ("admin", "support", "ticket_update", {"id": str(ids["id"]), "subject": "R2b subject"}),
                 lambda ids, b: get(b, "admin", "support", "ticket_get", {"id": str(ids["id"])}).get("result", {}).get("subject"))
        run_case("ticket_delete", lambda: {"id": craft_ticket_copy("open")},
                 lambda ids: ("admin", "support", "ticket_delete", {"id": str(ids["id"])}),
                 lambda ids, b: get(b, "admin", "support", "ticket_get", {"id": str(ids["id"])}))
        run_case("ticket_get_missing", None,
                 lambda _: ("admin", "support", "ticket_get", {"id": "999999"}),
                 lambda _, b: {})
    finally:
        restore()
        print("reference DB restored")

    print(f"\nparity26: {CHECKS} checks, {len(FAILURES)} failures")
    if STATUS_NOTES:
        print("HTTP-status-only notes (envelopes compared, statuses differ by seam convention):")
        for name, ps, ts in sorted(set(STATUS_NOTES)):
            print(f"  {name}: php={ps} ts={ts}")
    if FAILURES:
        for name, a, b in FAILURES:
            print("DIFF", name, "\n  php:", json.dumps(a)[:600], "\n  ts: ", json.dumps(b)[:600])
        raise SystemExit(1)
    print("parity26: ALL GREEN")


if __name__ == "__main__":
    main()
