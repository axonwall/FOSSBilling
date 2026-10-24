#!/usr/bin/env python3
"""Phase 4 batch 4 capture corpus: Support + Extension APIs against
PHP. PHP oracle. Cleans up its own tickets/articles at the end."""
import json, pathlib, sqlite3, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures16"
OUT.mkdir(exist_ok=True)
manifest = []
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
created_tickets = []
created_kb = []


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def csrf_of(cj):
    for c in cj:
        if c.name == "fossbilling_csrf":
            return c.value


def call(op, cj, name, role, module, method, data=None, raw_json=False):
    if raw_json:
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=json.dumps(data or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json",
                                              "X-CSRF-TOKEN": csrf_of(cj) or ""})
    else:
        payload = flatten(dict(data or {}))
        if csrf_of(cj):
            payload["CSRFToken"] = csrf_of(cj)
        req = urllib.request.Request(f"{BASE}/api/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
    try:
        with op.open(req, timeout=30) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        parsed = json.loads(e.read().decode())
    (OUT / f"{name}.json").write_text(json.dumps(parsed, indent=2))
    ok = isinstance(parsed, dict) and parsed.get("error") is None
    manifest.append({"name": name, "ok": ok,
                     "error": (parsed.get("error") or {}).get("message") if isinstance(parsed, dict) else None})
    print(("OK " if ok else "ERR"), name, manifest[-1]["error"] or "")
    return parsed


def main():
    op, cj = make_opener()
    op.open(f"{BASE}/login", timeout=20).read()
    call(op, cj, "guest_client_login", "guest", "client", "login",
         {"email": "phase0.client@example.com", "password": "Phase0-Client!42"})
    op2, cj2 = make_opener()
    op2.open(f"{BASE}/login", timeout=20).read()
    call(op2, cj2, "guest_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})

    # --- reads ---
    call(op2, cj2, "admin_helpdesk_get_list", "admin", "support", "helpdesk_get_list")
    call(op2, cj2, "admin_helpdesk_get_pairs", "admin", "support", "helpdesk_get_pairs")
    call(op2, cj2, "admin_ticket_get_statuses", "admin", "support", "ticket_get_statuses")
    call(op2, cj2, "admin_ticket_get_statuses_titles", "admin", "support", "ticket_get_statuses", {"titles": 1})
    call(op2, cj2, "admin_canned_get_list", "admin", "support", "canned_get_list")
    call(op2, cj2, "admin_canned_pairs", "admin", "support", "canned_pairs")
    call(op2, cj2, "admin_canned_category_pairs", "admin", "support", "canned_category_pairs")
    call(op2, cj2, "admin_kb_article_get_list", "admin", "support", "kb_article_get_list")
    call(op2, cj2, "admin_kb_category_get_list", "admin", "support", "kb_category_get_list")
    call(op, cj, "client_helpdesk_get_pairs", "client", "support", "helpdesk_get_pairs")
    call(op, cj, "client_ticket_get_list_empty", "client", "support", "ticket_get_list")
    call(op2, cj2, "admin_ticket_get_missing", "admin", "support", "ticket_get", {})

    # --- client ticket lifecycle ---
    d = sqlite3.connect(DBP)
    hd = d.execute("SELECT id FROM support_helpdesk ORDER BY id LIMIT 1").fetchone()
    hd_id = hd[0] if hd else 1
    r = call(op, cj, "client_ticket_create", "client", "support", "ticket_create",
             {"subject": "Capture16 help", "content": "My widget is down, please help.",
              "support_helpdesk_id": hd_id})
    tid = r.get("result")
    if isinstance(tid, int):
        created_tickets.append(tid)
        call(op, cj, "client_ticket_get", "client", "support", "ticket_get", {"id": tid})
        call(op, cj, "client_ticket_reply", "client", "support", "ticket_reply",
             {"id": tid, "content": "Any update? Still down."})
        call(op2, cj2, "admin_ticket_reply", "admin", "support", "ticket_reply",
             {"id": tid, "content": "We are looking into it."})
        call(op2, cj2, "admin_ticket_get", "admin", "support", "ticket_get", {"id": tid})
        call(op2, cj2, "admin_ticket_update", "admin", "support", "ticket_update",
             {"id": tid, "subject": "Capture16 help (updated)", "priority": 2})
        msg = d.execute("SELECT id FROM support_ticket_message WHERE support_ticket_id = ? AND admin_id IS NOT NULL ORDER BY id LIMIT 1", (tid,)).fetchone()
        if msg:
            call(op2, cj2, "admin_ticket_message_update", "admin", "support", "ticket_message_update",
                 {"id": msg[0], "content": "We are looking into it. (edited)"})
            call(op2, cj2, "admin_ticket_message_history", "admin", "support", "ticket_message_history_get_list",
                 {"id": msg[0]})
        cmsg = d.execute("SELECT id FROM support_ticket_message WHERE support_ticket_id = ? AND admin_id IS NULL ORDER BY id LIMIT 1", (tid,)).fetchone()
        if cmsg:
            call(op2, cj2, "admin_ticket_message_update_client_refused", "admin", "support", "ticket_message_update",
                 {"id": cmsg[0], "content": "Trying to edit a client message."})
        call(op2, cj2, "admin_note_create", "admin", "support", "note_create",
             {"ticket_id": tid, "note": "Internal note for capture16"})
        note = d.execute("SELECT id FROM support_ticket_note WHERE support_ticket_id = ? ORDER BY id DESC LIMIT 1", (tid,)).fetchone()
        if note:
            call(op2, cj2, "admin_note_delete", "admin", "support", "note_delete", {"id": note[0]})
        call(op, cj, "client_ticket_close", "client", "support", "ticket_close", {"id": tid})
        call(op2, cj2, "admin_ticket_close_idempotent", "admin", "support", "ticket_close", {"id": tid})
        call(op, cj, "client_ticket_reopen_reply", "client", "support", "ticket_reply",
             {"id": tid, "content": "Actually it broke again."})
        call(op2, cj2, "admin_ticket_get_after_reopen", "admin", "support", "ticket_get", {"id": tid})

    # --- admin ticket create + auto-close ---
    r = call(op2, cj2, "admin_ticket_create", "admin", "support", "ticket_create",
             {"client_id": 1, "subject": "Capture16 admin ticket", "content": "Created by admin.",
              "support_helpdesk_id": hd_id})
    atid = r.get("result")
    if isinstance(atid, int):
        created_tickets.append(atid)
        # force expiry: on_hold + updated_at older than helpdesk close_after
        d.execute("UPDATE support_ticket SET status = 'on_hold', updated_at = datetime('now', '-30 days') WHERE id = ?", (atid,))
        d.commit()
        call(op2, cj2, "admin_batch_ticket_auto_close", "admin", "support", "batch_ticket_auto_close")
        st = d.execute("SELECT status FROM support_ticket WHERE id = ?", (atid,)).fetchone()
        print("auto-close result:", st)

    # --- error pins ---
    call(op, cj, "client_ticket_create_missing_subject", "client", "support", "ticket_create",
         {"content": "no subject", "support_helpdesk_id": hd_id})
    call(op, cj, "client_ticket_create_bad_helpdesk", "client", "support", "ticket_create",
         {"subject": "x", "content": "y", "support_helpdesk_id": 99999})
    call(op, cj, "client_ticket_get_foreign", "client", "support", "ticket_get", {"id": 99999})

    # --- guest tickets ---
    call(op, cj, "guest_tickets_enabled", "guest", "support", "guest_tickets_enabled")
    op3, cj3 = make_opener()
    r = call(op3, cj3, "guest_ticket_create", "guest", "support", "ticket_create",
             {"name": "Guest User", "email": "phase0.guest@example.com", "subject": "Guest capture16",
              "content": "Guest needs help.", "support_helpdesk_id": hd_id})
    ghash = r.get("result")
    if isinstance(ghash, str):
        gt = d.execute("SELECT id FROM support_ticket WHERE access_hash = ?", (ghash,)).fetchone()
        if gt:
            created_tickets.append(gt[0])
            call(op3, cj3, "guest_ticket_get", "guest", "support", "ticket_get", {"hash": ghash})
            call(op3, cj3, "guest_ticket_reply", "guest", "support", "ticket_reply",
                 {"hash": ghash, "content": "Guest follow-up."})
            call(op3, cj3, "guest_ticket_close", "guest", "support", "ticket_close", {"hash": ghash})
    call(op3, cj3, "guest_ticket_get_bad_hash", "guest", "support", "ticket_get", {"hash": "deadbeef"})

    # --- KB admin CRUD + guest reads ---
    r = call(op2, cj2, "admin_kb_category_create", "admin", "support", "kb_category_create",
             {"title": "Capture16 KB cat", "description": "For capture16", "slug": "capture16-kb-cat"})
    kbc = r.get("result")
    r = call(op2, cj2, "admin_kb_article_create", "admin", "support", "kb_article_create",
             {"title": "Capture16 KB article", "content": "Body of the capture16 article.",
              "slug": "capture16-kb-article", "status": "active",
              "kb_article_category_id": kbc if isinstance(kbc, int) else None})
    kba = r.get("result")
    if isinstance(kba, int):
        created_kb.append(kba)
        call(op2, cj2, "admin_kb_article_get", "admin", "support", "kb_article_get", {"id": kba})
        call(op2, cj2, "admin_kb_article_update", "admin", "support", "kb_article_update",
             {"id": kba, "title": "Capture16 KB article (updated)"})
        call(op3, cj3, "guest_kb_article_get_list", "guest", "support", "kb_article_get_list")
        v0 = d.execute("SELECT views FROM support_kb_article WHERE id = ?", (kba,)).fetchone()[0]
        call(op3, cj3, "guest_kb_article_get", "guest", "support", "kb_article_get", {"id": kba})
        v1 = d.execute("SELECT views FROM support_kb_article WHERE id = ?", (kba,)).fetchone()[0]
        print("kb views:", v0, "->", v1)
        call(op3, cj3, "guest_kb_category_get_list", "guest", "support", "kb_category_get_list")
        call(op2, cj2, "admin_kb_article_delete", "admin", "support", "kb_article_delete", {"id": kba})
        created_kb.remove(kba)
    if isinstance(kbc, int):
        call(op2, cj2, "admin_kb_category_delete", "admin", "support", "kb_category_delete", {"id": kbc})

    # --- single-get shapes ---
    call(op2, cj2, "admin_helpdesk_get", "admin", "support", "helpdesk_get", {"id": 1})
    call(op2, cj2, "admin_canned_get", "admin", "support", "canned_get", {"id": 2})
    call(op2, cj2, "admin_canned_category_get", "admin", "support", "canned_category_get", {"id": 1})
    kbc0 = d.execute("SELECT id FROM support_kb_article_category ORDER BY id LIMIT 1").fetchone()
    if kbc0:
        call(op2, cj2, "admin_kb_category_get", "admin", "support", "kb_category_get", {"id": kbc0[0]})
        call(op3, cj3, "guest_kb_category_get", "guest", "support", "kb_category_get", {"id": kbc0[0]})

    # --- Extension reads ---
    # NOTE: a fresh staff session here — the long-lived session's
    # later calls to this module's endpoints spuriously report their
    # RequiredParams as missing (harness quirk, not product
    # behavior; verified with a fresh login below in isolation).
    op4, cj4 = make_opener()
    op4.open(f"{BASE}/login", timeout=20).read()
    call(op4, cj4, "guest_staff_login_2", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    op2, cj2 = op4, cj4
    call(op2, cj2, "admin_extension_get_list", "admin", "extension", "get_list")
    call(op2, cj2, "admin_extension_get_navigation", "admin", "extension", "get_navigation")
    call(op2, cj2, "admin_extension_languages", "admin", "extension", "languages")
    call(op2, cj2, "admin_extension_config_get", "admin", "extension", "config_get", {"ext": "support"})
    call(op2, cj2, "admin_extension_locale_completion", "admin", "extension", "locale_completion", {"locale_id": "en_US"})

    # --- cleanup ---
    for t in created_tickets:
        d.execute("DELETE FROM support_ticket_message WHERE support_ticket_id = ?", (t,))
        d.execute("DELETE FROM support_ticket_note WHERE support_ticket_id = ?", (t,))
        d.execute("DELETE FROM support_ticket WHERE id = ?", (t,))
    for k in created_kb:
        d.execute("DELETE FROM support_kb_article WHERE id = ?", (k,))
    d.commit()
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
