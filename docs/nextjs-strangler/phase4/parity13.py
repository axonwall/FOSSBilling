#!/usr/bin/env python3
"""Phase 4 batch 4 parity: Support + Extension APIs through the TS
stack, checked against the PHP oracle corpus captures16/ and pinned
expectations (status transitions, counts, exact error strings).
Volatile fields (ids, timestamps, hashes, ips) are normalized out
of shape comparisons. Cleans up its own tickets/articles."""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
HERE = pathlib.Path(__file__).parent
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
results = []
created = {"tickets": [], "kb": [], "kbcat": []}
VOLATILE = {"id", "created_at", "updated_at", "hash", "access_hash", "ip",
            "support_ticket_id", "kb_article_category_id"}


def report(name, ok, detail=""):
    results.append((name, ok))
    print(("MATCH" if ok else "DIFF "), name, detail if not ok else "")


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def call(cj, role, module, method, data=None):
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    payload = flatten(dict(data or {}))
    if csrf:
        payload["CSRFToken"] = csrf
    req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                 data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with opener.open(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def login(email, password, module="client"):
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(cj, "guest", module, "login", {"email": email, "password": password})
    assert r.get("error") is None, r
    return cj


def norm(v, keep=()):
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items() if k not in VOLATILE or k in keep}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


def oracle(name):
    return json.loads((HERE / "captures16" / f"{name}.json").read_text())["result"]


def err(r):
    return (r.get("error") or {}).get("message")


def main():
    cj_c = login("phase0.client@example.com", "Phase0-Client!42")
    cj_a = login("admin@phase0.local", "Phase1-Admin!42", module="staff")
    d = sqlite3.connect(DBP)
    hd = d.execute("SELECT id FROM support_helpdesk ORDER BY id LIMIT 1").fetchone()[0]

    # --- reads vs oracle shapes ---
    r = call(cj_a, "admin", "support", "helpdesk_get_list")
    report("helpdesk_get_list", norm(r["result"]) == norm(oracle("admin_helpdesk_get_list")))
    r = call(cj_a, "admin", "support", "helpdesk_get_pairs")
    report("helpdesk_get_pairs", r["result"] == oracle("admin_helpdesk_get_pairs"))
    r = call(cj_a, "admin", "support", "helpdesk_get", {"id": 1})
    report("helpdesk_get", norm(r["result"]) == norm(oracle("admin_helpdesk_get")))
    r = call(cj_a, "admin", "support", "ticket_get_statuses")
    st = r["result"]
    report("ticket_get_statuses", set(st) == {"total", "open", "closed", "on_hold"} and st["total"] == st["open"] + st["closed"] + st["on_hold"])
    r = call(cj_a, "admin", "support", "ticket_get_statuses", {"titles": 1})
    report("ticket_get_statuses_titles", r["result"] == {"open": "Open", "on_hold": "On Hold", "closed": "Closed"})
    r = call(cj_a, "admin", "support", "canned_pairs")
    report("canned_pairs", r["result"] == oracle("admin_canned_pairs"))
    r = call(cj_a, "admin", "support", "canned_category_pairs")
    report("canned_category_pairs", r["result"] == oracle("admin_canned_category_pairs"))
    r = call(cj_a, "admin", "support", "canned_get", {"id": 2})
    report("canned_get", norm(r["result"]) == norm(oracle("admin_canned_get")))
    r = call(cj_a, "admin", "extension", "config_get", {"ext": "support"})
    report("extension_config_get", r["result"] == {"ext": "support"})
    r = call(cj_a, "admin", "extension", "config_get", {})
    report("extension_config_get_missing", err(r) == 'Parameter "ext" was not passed')

    # --- client ticket lifecycle ---
    r = call(cj_c, "client", "support", "ticket_create",
             {"subject": "Parity13 help", "content": "Parity13 widget down.", "support_helpdesk_id": hd})
    tid = r.get("result")
    report("client_ticket_create", isinstance(tid, int), str(r))
    created["tickets"].append(tid)
    r = call(cj_c, "client", "support", "ticket_get", {"id": tid})
    t = r["result"]
    report("client_ticket_get", t["status"] == "open" and t["subject"] == "Parity13 help"
           and t["replies"] == 1 and t["first"]["content"] == "Parity13 widget down."
           and t["helpdesk"]["name"] == "General" and t["author"]["role"] == "client"
           and "priority" not in t and "support_helpdesk_id" not in t, str(t)[:200])
    r = call(cj_c, "client", "support", "ticket_reply", {"id": tid, "content": "Still down."})
    report("client_ticket_reply", r["result"] is True, str(r))
    r = call(cj_a, "admin", "support", "ticket_reply", {"id": tid, "content": "Looking into it."})
    amid = r.get("result")
    report("admin_ticket_reply", isinstance(amid, int), str(r))
    r = call(cj_a, "admin", "support", "ticket_get", {"id": tid})
    t = r["result"]
    report("admin_ticket_get", t["status"] == "on_hold" and t["replies"] == 3
           and t["priority"] == 100 and t["rel_status"] == "complete"
           and len(t["messages"]) == 3 and t["notes"] == [], str({k: t.get(k) for k in ("status", "replies", "priority", "rel_status")}))
    r = call(cj_a, "admin", "support", "ticket_update", {"id": tid, "subject": "Parity13 help (upd)", "priority": 2})
    report("admin_ticket_update", r["result"] is True, str(r))
    r = call(cj_a, "admin", "support", "ticket_message_update", {"id": amid, "content": "Looking into it. (edited)"})
    report("admin_ticket_message_update", r["result"] is True, str(r))
    r = call(cj_a, "admin", "support", "ticket_message_history_get_list", {"id": amid})
    hist = r["result"]
    report("admin_ticket_message_history", len(hist) == 1 and hist[0]["content"] == "Looking into it.", str(hist)[:200])
    r = call(cj_a, "admin", "support", "ticket_message_update", {"id": amid, "content": "Looking into it. (edited)"})
    report("admin_ticket_message_update_noop", r["result"] is True, str(r))
    first_client_msg = d.execute("SELECT id FROM support_ticket_message WHERE support_ticket_id = ? AND admin_id IS NULL ORDER BY id LIMIT 1", (tid,)).fetchone()[0]
    r = call(cj_a, "admin", "support", "ticket_message_update", {"id": first_client_msg, "content": "edit?"})
    report("admin_ticket_message_update_client_refused", err(r) == "Only admin replies can be edited", str(r))
    r = call(cj_a, "admin", "support", "note_create", {"ticket_id": tid, "note": "Parity13 note"})
    nid = r.get("result")
    report("admin_note_create", isinstance(nid, int), str(r))
    r = call(cj_a, "admin", "support", "note_delete", {"id": nid})
    report("admin_note_delete", r["result"] is True, str(r))
    r = call(cj_a, "admin", "support", "task_complete", {"id": tid})
    report("admin_task_complete", r["result"] is True, str(r))
    r = call(cj_c, "client", "support", "ticket_close", {"id": tid})
    report("client_ticket_close", r["result"] is True, str(r))
    r = call(cj_a, "admin", "support", "ticket_close", {"id": tid})
    report("admin_ticket_close_idempotent", r["result"] is True, str(r))
    r = call(cj_c, "client", "support", "ticket_reply", {"id": tid, "content": "Broke again."})
    report("client_ticket_reopen_refused", err(r) == "Ticket cannot be reopened.", str(r))
    r = call(cj_a, "admin", "support", "ticket_get", {"id": tid})
    report("ticket_stays_closed", r["result"]["status"] == "closed" and r["result"]["priority"] == 2, str(r["result"]["status"]))

    # --- admin create + auto-close ---
    r = call(cj_a, "admin", "support", "ticket_create",
             {"client_id": 1, "subject": "Parity13 admin ticket", "content": "By admin.", "support_helpdesk_id": hd})
    atid = r.get("result")
    report("admin_ticket_create", isinstance(atid, int), str(r))
    created["tickets"].append(atid)
    d.execute("UPDATE support_ticket SET status = 'on_hold', updated_at = datetime('now', '-30 days') WHERE id = ?", (atid,))
    d.commit()
    r = call(cj_a, "admin", "support", "batch_ticket_auto_close")
    st = d.execute("SELECT status FROM support_ticket WHERE id = ?", (atid,)).fetchone()[0]
    report("batch_ticket_auto_close", r["result"] is True and st == "closed", st)

    # --- error pins ---
    r = call(cj_a, "admin", "support", "ticket_get", {})
    report("admin_ticket_get_missing", err(r) == "Ticket ID is missing", str(r))
    r = call(cj_c, "client", "support", "ticket_create", {"content": "x", "support_helpdesk_id": hd})
    report("client_ticket_create_missing_subject", err(r) == "Ticket subject required", str(r))
    r = call(cj_c, "client", "support", "ticket_create", {"subject": "x", "content": "y", "support_helpdesk_id": 99999})
    report("client_ticket_create_bad_helpdesk", err(r) == "Helpdesk invalid", str(r))
    r = call(cj_c, "client", "support", "ticket_get", {"id": 99999})
    report("client_ticket_get_foreign", err(r) == "Ticket not found", str(r))

    # --- guest lifecycle ---
    cj_g = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj_g))
    opener.open(f"{NEXT}/api/fb/__prime", timeout=20).read()
    r = call(cj_g, "guest", "support", "ticket_create",
             {"name": "Guest Parity", "email": "parity13.guest@example.com", "subject": "Guest parity13",
              "content": "Guest needs help.", "support_helpdesk_id": hd})
    ghash = r.get("result")
    report("guest_ticket_create", isinstance(ghash, str) and len(ghash) >= 30, str(r))
    gt = d.execute("SELECT id FROM support_ticket WHERE access_hash = ?", (ghash,)).fetchone()
    if gt:
        created["tickets"].append(gt[0])
    r = call(cj_g, "guest", "support", "ticket_get", {"hash": ghash})
    report("guest_ticket_get", r["result"]["subject"] == "Guest parity13" and r["result"]["hash"] == ghash
           and r["result"]["author"]["role"] == "guest", str(r)[:200])
    r = call(cj_g, "guest", "support", "ticket_reply", {"hash": ghash, "content": "Guest follow-up."})
    report("guest_ticket_reply", isinstance(r["result"], int), str(r))
    r = call(cj_g, "guest", "support", "ticket_close", {"hash": ghash})
    report("guest_ticket_close", r["result"] is True, str(r))
    r = call(cj_g, "guest", "support", "ticket_get", {"hash": "deadbeef"})
    report("guest_ticket_get_bad_hash", err(r) == "Guest ticket not found", str(r))
    r = call(cj_g, "guest", "support", "ticket_create",
             {"email": "x@example.com", "subject": "s", "content": "long enough", "support_helpdesk_id": hd})
    report("guest_ticket_create_no_name", err(r) == "Please enter your name", str(r))

    # --- KB admin CRUD + guest views ---
    r = call(cj_a, "admin", "support", "kb_category_create",
             {"title": "Parity13 KB cat", "description": "For parity13", "slug": "parity13-kb-cat"})
    kbc = r.get("result")
    report("admin_kb_category_create", isinstance(kbc, int), str(r))
    created["kbcat"].append(kbc)
    r = call(cj_a, "admin", "support", "kb_article_create",
             {"title": "Parity13 KB article", "content": "Parity13 body.", "slug": "parity13-kb-article",
              "status": "active", "kb_article_category_id": kbc})
    kba = r.get("result")
    report("admin_kb_article_create", isinstance(kba, int), str(r))
    created["kb"].append(kba)
    r = call(cj_a, "admin", "support", "kb_article_get", {"id": kba})
    report("admin_kb_article_get", r["result"]["title"] == "Parity13 KB article" and r["result"]["views"] == 0, str(r)[:200])
    r = call(cj_a, "admin", "support", "kb_article_update", {"id": kba, "title": "Parity13 KB article (upd)"})
    report("admin_kb_article_update", r["result"] is True, str(r))
    r = call(cj_g, "guest", "support", "kb_article_get", {"id": kba})
    report("guest_kb_article_get_views", r["result"]["views"] == 1 and r["result"]["title"] == "Parity13 KB article (upd)", str(r)[:200])
    r = call(cj_g, "guest", "support", "kb_article_get_list")
    report("guest_kb_article_get_list", r["result"]["total"] >= 1, str(r["result"]["total"]))
    r = call(cj_a, "admin", "support", "kb_article_delete", {"id": kba})
    report("admin_kb_article_delete", r["result"] is True, str(r))
    created["kb"].remove(kba)
    r = call(cj_a, "admin", "support", "kb_category_delete", {"id": kbc})
    report("admin_kb_category_delete", r["result"] is True, str(r))
    created["kbcat"].remove(kbc)

    # --- cleanup ---
    for t in created["tickets"]:
        d.execute("DELETE FROM support_ticket_message WHERE support_ticket_id = ?", (t,))
        d.execute("DELETE FROM support_ticket_note WHERE support_ticket_id = ?", (t,))
        d.execute("DELETE FROM support_ticket WHERE id = ?", (t,))
    for k in created["kb"]:
        d.execute("DELETE FROM support_kb_article WHERE id = ?", (k,))
    for k in created["kbcat"]:
        d.execute("DELETE FROM support_kb_article_category WHERE id = ?", (k,))
    d.commit()
    n = sum(1 for _, ok in results if ok)
    print(f"\nparity Phase4-4: {n}/{len(results)} match")
    return 0 if n == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
