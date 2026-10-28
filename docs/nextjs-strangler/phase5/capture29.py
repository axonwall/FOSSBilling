#!/usr/bin/env python3
"""Phase 5 R2b capture: PHP-only corpus for the admin action cases that
parity26 compares live (PHP direct vs TS seam).

Each case: snapshot the reference DB, run the action against PHP (:8080)
as super-admin, read back the resulting record state, restore. Output is
one JSON file per case under captures29/.

Page smoke has no PHP corpus: the admin pages are Next-only (R2b builds
no PHP pages), so parity26 asserts page status/chrome/needles live on
the TS stack only.
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
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
OUT = pathlib.Path(__file__).parent / "captures29"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"


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


def main():
    OUT.mkdir(exist_ok=True)
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

    def call(role, module, method, data=None):
        payload = dict(data or {})
        if token:
            payload["CSRFToken"] = token
        body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST")
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

        def run_case(name, craft, action, state):
            restore()
            ids = craft() if craft else {}
            env, _ = call(*action(ids))
            st = state(ids)
            (OUT / f"{name}.json").write_text(json.dumps(
                {"envelope": scrub(env), "state": scrub(st)}, indent=1, sort_keys=True))
            print("captured", name)

        run_case("inv_markpaid", None,
                 lambda _: ("admin", "invoice", "mark_as_paid", {"id": "2"}),
                 lambda _: call("admin", "invoice", "get", {"id": "2"})[0])
        run_case("inv_markpaid_ok", None,
                 lambda _: ("admin", "invoice", "mark_as_paid",
                            {"id": "2", "gateway_id": "1", "transactionId": "R2B-TXN-1"}),
                 lambda _: call("admin", "invoice", "get", {"id": "2"})[0])
        run_case("inv_refund", None,
                 lambda _: ("admin", "invoice", "refund", {"id": "1"}),
                 lambda _: call("admin", "invoice", "get", {"id": "1"})[0])
        run_case("inv_cancel", None,
                 lambda _: ("admin", "invoice", "cancel", {"id": "3"}),
                 lambda _: call("admin", "invoice", "get", {"id": "3"})[0])
        run_case("inv_delete", lambda: {"id": craft_draft_invoice()},
                 lambda ids: ("admin", "invoice", "delete", {"id": str(ids["id"])}),
                 lambda ids: call("admin", "invoice", "get", {"id": str(ids["id"])})[0])
        run_case("inv_reminder", None,
                 lambda _: ("admin", "invoice", "send_reminder", {"id": "4"}),
                 lambda _: {"reminded": bool(call("admin", "invoice", "get", {"id": "4"})[0].get("result", {}).get("reminded_at")),
                           "queue": d.execute("SELECT COUNT(*) FROM email_queue").fetchone()[0]})
        run_case("inv_get_missing", None,
                 lambda _: ("admin", "invoice", "get", {"id": "999999"}),
                 lambda _: {})
        run_case("client_create", None,
                 lambda _: ("admin", "client", "create",
                            {"email": "r2b-new@example.local", "first_name": "R2b", "last_name": "New",
                             "send_welcome_email": "0", "password": "R2b-Client!42"}),
                 lambda ids: call("admin", "client", "get", {"email": "r2b-new@example.local"})[0])
        run_case("client_create_dup", None,
                 lambda _: ("admin", "client", "create",
                            {"email": "phase0.client@example.com", "first_name": "Dup"}),
                 lambda _: {})
        run_case("client_create_missing", None,
                 lambda _: ("admin", "client", "create", {}),
                 lambda _: {})
        run_case("client_update", None,
                 lambda _: ("admin", "client", "update", {"id": "1", "city": "R2b City"}),
                 lambda _: call("admin", "client", "get", {"id": "1"})[0])
        run_case("client_update_dup", None,
                 lambda _: ("admin", "client", "update",
                            {"id": "1", "email": "phase1.diag@example.com"}),
                 lambda _: {})
        run_case("client_update_currency", None,
                 lambda _: ("admin", "client", "update", {"id": "1", "currency": "EUR"}),
                 lambda _: {})
        run_case("order_activate", None,
                 lambda _: ("admin", "order", "activate", {"id": "4"}),
                 lambda _: call("admin", "order", "get", {"id": "4"})[0])
        run_case("order_suspend", None,
                 lambda _: ("admin", "order", "suspend", {"id": "1", "reason": "R2b test"}),
                 lambda _: call("admin", "order", "get", {"id": "1"})[0])
        run_case("order_unsuspend", lambda: {"id": craft_order_copy("suspended")},
                 lambda ids: ("admin", "order", "unsuspend", {"id": str(ids["id"])}),
                 lambda ids: call("admin", "order", "get", {"id": str(ids["id"])})[0])
        run_case("order_cancel", None,
                 lambda _: ("admin", "order", "cancel", {"id": "2", "reason": "R2b test"}),
                 lambda _: call("admin", "order", "get", {"id": "2"})[0])
        run_case("order_uncancel", lambda: {"id": craft_order_copy("canceled")},
                 lambda ids: ("admin", "order", "uncancel", {"id": str(ids["id"])}),
                 lambda ids: call("admin", "order", "get", {"id": str(ids["id"])})[0])
        run_case("order_renew", None,
                 lambda _: ("admin", "order", "renew", {"id": "3"}),
                 lambda _: call("admin", "order", "get", {"id": "3"})[0])
        run_case("order_delete", lambda: {"id": craft_order_copy("pending_setup")},
                 lambda ids: ("admin", "order", "delete", {"id": str(ids["id"])}),
                 lambda ids: call("admin", "order", "get", {"id": str(ids["id"])})[0])
        run_case("order_get_missing", None,
                 lambda _: ("admin", "order", "get", {"id": "999999"}),
                 lambda _: {})
        run_case("ticket_close", lambda: {"id": craft_ticket_copy("open")},
                 lambda ids: ("admin", "support", "ticket_close", {"id": str(ids["id"])}),
                 lambda ids: call("admin", "support", "ticket_get", {"id": str(ids["id"])})[0])
        run_case("ticket_reopen", lambda: {"id": craft_ticket_copy("closed")},
                 lambda ids: ("admin", "support", "ticket_update", {"id": str(ids["id"]), "status": "open"}),
                 lambda ids: call("admin", "support", "ticket_get", {"id": str(ids["id"])})[0])
        run_case("ticket_update_subject", lambda: {"id": craft_ticket_copy("open")},
                 lambda ids: ("admin", "support", "ticket_update", {"id": str(ids["id"]), "subject": "R2b subject"}),
                 lambda ids: call("admin", "support", "ticket_get", {"id": str(ids["id"])})[0])
        run_case("ticket_delete", lambda: {"id": craft_ticket_copy("open")},
                 lambda ids: ("admin", "support", "ticket_delete", {"id": str(ids["id"])}),
                 lambda ids: call("admin", "support", "ticket_get", {"id": str(ids["id"])})[0])
        run_case("ticket_get_missing", None,
                 lambda _: ("admin", "support", "ticket_get", {"id": "999999"}),
                 lambda _: {})
    finally:
        restore()
        print("reference DB restored")


if __name__ == "__main__":
    main()
