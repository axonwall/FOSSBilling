#!/usr/bin/env python3
"""Phase 5 R1 leftovers sub-batch 1 parity: deferred cart (admin) +
staff (group pairs, login history get, guest login/password flows).

Runs the IDENTICAL sequence against PHP (:8080) and the TS seam
(:3001), with a full snapshot/restore between stacks so autoincrement
sequences align. Openers are always primed via the PHP /login page
(the session row lives in the shared DB, so the TS seam reads it).

Envelope + per-case DB-delta comparison. Scrubbed (never compared
literally): timestamps, reset hashes, invoice hashes (shape only),
__cart_family tokens, session ids/csrf values, bcrypt hash values
(cost compared instead), email_template vars (PHP encrypts send vars
with a random IV; TS does not stamp them).
"""
import json, re, sqlite3, urllib.request, urllib.parse, urllib.error, http.cookiejar

PHP = "http://127.0.0.1:8080"
NEXT = "http://127.0.0.1:3001"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
NOW = "2026-10-25 12:00:00"
ADMIN_EMAIL = "admin@phase0.local"
ADMIN_PASS = "Phase1-Admin!42"
CLIENT_ID = 1
# bcrypt cost-10 hash of 'Cap25-Rehash!99' (bcryptjs); login must rehash to cost 12.
REHASH_HASH = "$2b$10$LTvnJ7f79xBVbU5TU0pJS.YtaWj0SrHdc0klZC6tLtJcq3O/P8xWK"

TABLES = ["cart", "cart_product", "promo", "promo_redemption", "client_order",
          "client_order_status", "invoice", "invoice_item", "transaction",
          "email_queue", "email_template", "email_template_group",
          "admin_password_reset", "activity_admin_history", "session",
          "service_custom", "client_balance", "client", "product",
          "product_payment", "admin", "setting"]

DUMP_TABLES = ["cart", "cart_product", "promo", "promo_redemption",
               "client_order", "client_order_status", "invoice", "invoice_item",
               "transaction", "email_queue", "email_template",
               "admin_password_reset", "activity_admin_history",
               "service_custom", "client_balance"]

TS_COLS = {"created_at", "updated_at", "paid_at", "committed_at",
           "released_at", "due_at", "issued_at", "activated_at",
           "expires_at", "suspended_at", "canceled_at"}
HEX64 = re.compile(r"\b[0-9a-f]{64}\b")
# PHP invoice hashes are bin2hex(random_bytes(random_int(15, 30))):
# variable 30-60 hex. Family tokens and session ids are 32 hex, so one
# 30-64 rule covers every random hex value in these envelopes/dumps.
HEXVAR = re.compile(r"\b[0-9a-f]{30,64}\b")
DT = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}")
BCRYPT = re.compile(r"\$2[aby]\$(\d{2})\$")


def scrub(v):
    if isinstance(v, str):
        v = DT.sub("TS", v)
        v = HEXVAR.sub("HEX", v)
        v = BCRYPT.sub(r"$2X$\1$", v)
        return v
    if isinstance(v, dict):
        return {k: scrub(x) for k, x in v.items() if k != "vars"}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


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


class Run:
    def __init__(self, base):
        self.base = base
        # PHP serves the API at /api; the TS seam serves it at /api/fb.
        self.api = base + "/api" if base == PHP else base + "/api/fb"
        self.d = sqlite3.connect(DBP)
        self.d.row_factory = sqlite3.Row
        self.env = {}
        self.db = {}
        self.last_max = {}
        for t in DUMP_TABLES:
            try:
                self.last_max[t] = self.d.execute(
                    f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
            except Exception:
                self.last_max[t] = 0
        self.seen_sessions = set(r[0] for r in self.d.execute(
            "SELECT id FROM session").fetchall())
        self.setting_start = {r[0]: r[1] for r in self.d.execute(
            "SELECT id, value FROM setting").fetchall()}

    def ins(self, sql, params=()):
        self.d.execute(sql, params)
        self.d.commit()
        return self.d.execute("SELECT last_insert_rowid()").fetchone()[0]

    def opener(self):
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.open(f"{PHP}/login", timeout=20).read()
        return op, cj

    def csrf_of(self, cj):
        for c in cj:
            if c.name == "fossbilling_csrf":
                return c.value

    def call(self, op, cj, name, role, module, method, data=None,
             with_csrf=True, raw_body=None):
        if raw_body is not None:
            body = raw_body
        else:
            payload = flatten(dict(data or {}))
            if with_csrf and self.csrf_of(cj):
                payload["CSRFToken"] = self.csrf_of(cj)
            body = urllib.parse.urlencode(payload).encode()
        req = urllib.request.Request(
            f"{self.api}/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                parsed = json.loads(e.read().decode())
            except Exception:
                parsed = {"error": {"message": f"non-json HTTP {e.code}"}}
        self.env[name] = parsed
        return parsed

    def dump_delta(self, name):
        out = {}
        for t in DUMP_TABLES:
            cols = [r[1] for r in self.d.execute(f'PRAGMA table_info("{t}")')]
            rows = self.d.execute(
                f'SELECT * FROM "{t}" WHERE id > ?', (self.last_max[t],)).fetchall()
            new_max = self.d.execute(
                f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
            self.last_max[t] = max(self.last_max[t], new_max)
            if rows:
                out[t] = [dict(zip(cols, r)) for r in rows]
        # new sessions: summarize (id/csrf scrubbed, admin attrs kept)
        new_sess = []
        for (sid, content) in self.d.execute(
                "SELECT id, content FROM session").fetchall():
            if sid in self.seen_sessions:
                continue
            self.seen_sessions.add(sid)
            if isinstance(content, bytes):
                content = content.decode("utf-8", "replace")
            m = re.search(r's:5:"admin";a:\d+:\{s:2:"id";i:(\d+);'
                          r's:5:"email";s:\d+:"([^"]*)";s:4:"name";s:\d+:"([^"]*)"',
                          content or "")
            new_sess.append({
                "admin": [int(m.group(1)), m.group(2), m.group(3)] if m else None,
                "has_csrf": "csrf_token" in (content or ""),
            })
        if new_sess:
            # Session ids are random hex; only the multiset is meaningful.
            new_sess.sort(key=lambda s: json.dumps(s, sort_keys=True))
            out["session_new"] = new_sess
        self.db[name] = scrub(out)
        return out

    def dump_cap_carts(self, name):
        cols = [r[1] for r in self.d.execute("PRAGMA table_info(cart)")]
        carts = [dict(zip(cols, r)) for r in self.d.execute(
            "SELECT * FROM cart WHERE session_id LIKE 'cap25%'"
            " OR session_id = 'staff:1:1' ORDER BY id").fetchall()]
        pcols = [r[1] for r in self.d.execute("PRAGMA table_info(cart_product)")]
        lines = [dict(zip(pcols, r)) for r in self.d.execute(
            "SELECT * FROM cart_product WHERE cart_id IN (SELECT id FROM cart"
            " WHERE session_id LIKE 'cap25%' OR session_id = 'staff:1:1')"
            " ORDER BY id").fetchall()]
        self.db[name] = scrub({"cart": carts, "cart_product": lines})

    def dump_changed_settings(self, name):
        changed = {}
        for rid, val in self.d.execute("SELECT id, value FROM setting").fetchall():
            if self.setting_start.get(rid) != val:
                changed[rid] = val
        self.db[name] = changed


def run_sequence(base):
    r = Run(base)
    d = r.d
    # ---------- seeds (identical to capture25 + addons wiring + rehash admin) ----------
    prod_addon = r.ins("INSERT INTO product (title, slug, status, active, is_addon, setup, type,"
                       " product_payment_id, created_at, updated_at) VALUES ('Cap25 Addon',"
                       " 'cap25-addon', 'enabled', 1, 1, 'after_payment', 'custom', 1, ?, ?)",
                       (NOW, NOW))
    prod_disabled = r.ins("INSERT INTO product (title, slug, status, active, is_addon, setup, type,"
                          " product_payment_id, created_at, updated_at) VALUES ('Cap25 Disabled',"
                          " 'cap25-disabled', 'disabled', 1, 0, 'after_payment', 'custom', 1, ?, ?)",
                          (NOW, NOW))
    pay_free = r.ins("INSERT INTO product_payment (type, once_price, once_setup_price)"
                     " VALUES ('once', 0, 0)")
    prod_free = r.ins("INSERT INTO product (title, slug, status, active, is_addon, setup, type,"
                      " product_payment_id, created_at, updated_at) VALUES ('Cap25 Free',"
                      " 'cap25-free', 'enabled', 1, 0, 'after_payment', 'custom', ?, ?, ?)",
                      (pay_free, NOW, NOW))
    # product 2 lists the addon so the addon happy path is exercisable
    d.execute("UPDATE product SET addons = ? WHERE id = 2", (f"[{prod_addon}]",))
    d.commit()

    def promo(code, ptype, value, **kw):
        cols = ["code", "type", "value", "maxuses", "used", "freesetup", "once_per_client",
                "recurring", "active", "products", "periods", "client_groups",
                "requires_products", "start_at", "end_at", "auto_apply", "priority",
                "stackable", "created_at", "updated_at"]
        vals = {"code": code, "type": ptype, "value": value, "maxuses": 0, "used": 0,
                "freesetup": 0, "once_per_client": 0, "recurring": 0, "active": 1,
                "products": "[]", "periods": "[]", "client_groups": "[]",
                "requires_products": "[]", "start_at": "2020-01-01 00:00:00",
                "end_at": "2030-01-01 00:00:00", "auto_apply": 0, "priority": 0,
                "stackable": 0, "created_at": NOW, "updated_at": NOW}
        vals.update(kw)
        return r.ins(f"INSERT INTO promo ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                     tuple(vals[c] for c in cols))

    promo("CAP25PCT10", "percentage", 10)
    promo("CAP25ABS5", "absolute", 5)
    promo("CAP25EXP", "percentage", 10, end_at="2020-06-01 00:00:00")
    promo("CAP25INACT", "percentage", 10, active=0)
    promo("CAP25MAX", "percentage", 10, maxuses=2, used=2)
    p_once = promo("CAP25ONCE", "percentage", 10, once_per_client=1)
    promo("CAP25GRP", "percentage", 10, client_groups="[1]")
    promo("CAP25BUNDLE", "percentage", 10, requires_products=f"[{prod_free}]")
    promo("CAP25AUTO15", "percentage", 15, auto_apply=1, priority=10)
    promo("CAP25AUTOABS7", "absolute", 7, auto_apply=1, priority=20)
    promo("CAP25PCT100", "percentage", 100)
    promo("CAP25FREESETUP", "percentage", 10, freesetup=1)
    r.ins("INSERT INTO promo_redemption (promo_id, client_id, client_order_id, invoice_id,"
          " phase, status, discount_amount, currency, created_at, updated_at)"
          " VALUES (?, 1, NULL, NULL, 'checkout', 'committed', 1, 'USD', ?, ?)",
          (p_once, NOW, NOW))
    admin1_pass = d.execute("SELECT pass FROM admin WHERE id = 1").fetchone()[0]
    r.ins("INSERT INTO admin (email, pass, name, status, created_at, updated_at)"
          " VALUES ('cap25.inactive@example.com', ?, 'Cap25 Inactive',"
          " 'inactive', ?, ?)", (admin1_pass, NOW, NOW))
    r.ins("INSERT INTO admin (email, pass, name, status, created_at, updated_at)"
          " VALUES ('cap25.rehash@example.com', ?, 'Cap25 Rehash',"
          " 'active', ?, ?)", (REHASH_HASH, NOW, NOW))
    r.ins("INSERT INTO admin_password_reset (hash, ip, created_at, updated_at, admin_id)"
          " VALUES ('cap25expiredhash', '127.0.0.1', '2026-10-25 11:00:00', ?, 1)", (NOW,))
    r.ins("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at)"
          " VALUES ('cap25old', 1, NULL, '2026-10-15 12:00:00', '2026-10-15 12:00:00')")
    r.ins("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at)"
          " VALUES ('staff:1:1', 1, NULL, '2026-10-15 12:00:00', '2026-10-15 12:00:00')")
    old_cart = r.ins("INSERT INTO cart (session_id, currency_id, promo_id, created_at, updated_at)"
                     " VALUES ('cap25old2', 1, NULL, '2026-10-15 12:00:00', '2026-10-15 12:00:00')")
    r.ins("INSERT INTO cart_product (product_id, config, cart_id) VALUES (2, '{\"quantity\":1}', ?)",
          (old_cart,))
    # reset delta baselines AFTER seeding so seed rows never pollute dumps
    for t in DUMP_TABLES:
        r.last_max[t] = d.execute(
            f'SELECT COALESCE(MAX(id), 0) FROM "{t}"').fetchone()[0]
    r.seen_sessions = set(x[0] for x in d.execute("SELECT id FROM session").fetchall())

    # ---------- admin opener (primed via PHP /login, logged in via the stack) ----------
    op_a, cj_a = r.opener()
    r.call(op_a, cj_a, "tmp_staff_login", "guest", "staff", "login",
           {"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    op_n, cj_n = r.opener()

    # ---------- cart admin ----------
    r.call(op_n, cj_n, "cart_get_list_noauth", "admin", "cart", "get_list")
    r.call(op_a, cj_a, "cart_get_list_default", "admin", "cart", "get_list")
    r.call(op_a, cj_a, "cart_get_list_page", "admin", "cart", "get_list",
           {"per_page": 2, "page": 2})
    r.call(op_a, cj_a, "cart_get_list_desc", "admin", "cart", "get_list",
           {"per_page": 3, "sort": "id", "direction": "DESC"})
    r.call(op_a, cj_a, "cart_get_list_desclow", "admin", "cart", "get_list",
           {"per_page": 3, "sort": "id", "direction": "desc"})
    r.call(op_a, cj_a, "cart_get_list_asc", "admin", "cart", "get_list",
           {"per_page": 3, "sort": "id", "direction": "asc"})
    r.call(op_a, cj_a, "cart_get_list_badsort", "admin", "cart", "get_list",
           {"per_page": 3, "sort": "bogus", "direction": "DESC"})
    r.call(op_a, cj_a, "cart_get_list_page0", "admin", "cart", "get_list", {"page": 0})
    r.call(op_a, cj_a, "cart_get_list_page_abc", "admin", "cart", "get_list",
           {"page": "abc"})
    r.call(op_a, cj_a, "cart_get_list_perpage501", "admin", "cart", "get_list",
           {"per_page": 501})
    r.call(op_a, cj_a, "cart_get_list_perpage0", "admin", "cart", "get_list",
           {"per_page": 0})
    r.call(op_a, cj_a, "cart_get_list_perpage_abc", "admin", "cart", "get_list",
           {"per_page": "abc"})
    r.call(op_a, cj_a, "cart_get_missing", "admin", "cart", "get", {"id": 999999})
    r.call(op_a, cj_a, "cart_get_noid", "admin", "cart", "get")

    # ---------- staff basket: errors ----------
    r.call(op_a, cj_a, "sb_get_noclient", "admin", "cart", "staff_basket_get")
    r.call(op_a, cj_a, "sb_get_unknown_client", "admin", "cart", "staff_basket_get",
           {"client_id": 999})
    r.call(op_a, cj_a, "sb_get_empty", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_add_noclient", "admin", "cart", "staff_basket_add_item",
           {"id": 2})
    r.call(op_a, cj_a, "sb_add_noproduct", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_add_unknown_product", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 999})
    r.call(op_a, cj_a, "sb_add_recurrent_noperiod", "admin", "cart",
           "staff_basket_add_item", {"client_id": CLIENT_ID, "id": 9})
    r.call(op_a, cj_a, "sb_add_recurrent_badperiod", "admin", "cart",
           "staff_basket_add_item", {"client_id": CLIENT_ID, "id": 9, "period": "9Z"})
    r.call(op_a, cj_a, "sb_add_negprice", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "price": -1})
    r.call(op_a, cj_a, "sb_add_nanprice", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "price": "abc"})
    # addon as a top-level line is rejected even though it exists
    r.call(op_a, cj_a, "sb_add_addon", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": prod_addon})

    # ---------- staff basket: happy path + addons ----------
    r.call(op_a, cj_a, "sb_add_once", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "quantity": 2})
    r.call(op_a, cj_a, "sb_get_after_once", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_add_disabled", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": prod_disabled})
    r.call(op_a, cj_a, "sb_add_override", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "price": 25.5})
    r.call(op_a, cj_a, "sb_add_override_zero", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "price": 0})
    r.call(op_a, cj_a, "sb_add_recurrent", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 9, "period": "1M", "quantity": 1})
    r.call(op_a, cj_a, "sb_get_full", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    basket_id = d.execute(
        "SELECT id FROM cart WHERE session_id = 'staff:1:1'").fetchone()[0]
    r.call(op_a, cj_a, "cart_get_basket", "admin", "cart", "get", {"id": basket_id})
    # addon via JSON body, then via form-encoded brackets
    r.call(op_a, cj_a, "sb_add_with_addon_json", "admin", "cart",
           "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2,
            "addons": {str(prod_addon): {"selected": True}}})
    r.call(op_a, cj_a, "sb_get_with_addon", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    form = urllib.parse.urlencode({
        "client_id": CLIENT_ID, "id": 2,
        f"addons[{prod_addon}][selected]": "1",
        "CSRFToken": r.csrf_of(cj_a)}).encode()
    r.call(op_a, cj_a, "sb_add_with_addon_form", "admin", "cart",
           "staff_basket_add_item", raw_body=form)
    r.call(op_a, cj_a, "sb_get_with_addon2", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    # invalid addon: product 9 lists no addons
    r.call(op_a, cj_a, "sb_add_bad_addon", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 9, "period": "1M",
            "addons": {str(prod_addon): {"selected": True}}})

    # ---------- promo flows ----------
    r.call(op_a, cj_a, "sb_promo_unknown", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "NOPE"})
    r.call(op_a, cj_a, "sb_promo_expired", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25EXP"})
    r.call(op_a, cj_a, "sb_promo_inactive", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25INACT"})
    r.call(op_a, cj_a, "sb_promo_maxed", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25MAX"})
    r.call(op_a, cj_a, "sb_promo_once_used", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25ONCE"})
    r.call(op_a, cj_a, "sb_promo_group", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25GRP"})
    r.call(op_a, cj_a, "sb_promo_pct10", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})
    r.call(op_a, cj_a, "sb_get_promo", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_promo_again", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})
    r.call(op_a, cj_a, "sb_remove_promo", "admin", "cart", "staff_basket_remove_promo",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_get_nopromo", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_promo_bundle_unmet", "admin", "cart",
           "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25BUNDLE"})
    r.call(op_a, cj_a, "sb_promo_freesetup", "admin", "cart",
           "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25FREESETUP"})
    r.call(op_a, cj_a, "sb_get_freesetup", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_remove_promo2", "admin", "cart", "staff_basket_remove_promo",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_get_auto", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})

    # bundle condition MET: add the free product, then apply
    r.call(op_a, cj_a, "sb_add_free_for_bundle", "admin", "cart",
           "staff_basket_add_item", {"client_id": CLIENT_ID, "id": prod_free})
    r.call(op_a, cj_a, "sb_promo_bundle_met", "admin", "cart",
           "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25BUNDLE"})
    r.call(op_a, cj_a, "sb_get_bundle_met", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_remove_promo3", "admin", "cart", "staff_basket_remove_promo",
           {"client_id": CLIENT_ID})

    # remove-item cascade: parent line with domain_name + matching/other addons
    parent_line = r.ins("INSERT INTO cart_product (product_id, config, cart_id)"
                        " VALUES (2, ?, ?)",
                        ('{"quantity":1,"domain_name":"cap25.local"}', basket_id))
    r.ins("INSERT INTO cart_product (product_id, config, cart_id) VALUES (2, ?, ?)",
          ('{"quantity":1,"parent_id":2,"domain_name":"cap25.local"}', basket_id))
    r.ins("INSERT INTO cart_product (product_id, config, cart_id) VALUES (2, ?, ?)",
          ('{"quantity":1,"parent_id":2,"domain_name":"other.local"}', basket_id))
    r.call(op_a, cj_a, "sb_remove_missing", "admin", "cart", "staff_basket_remove_item",
           {"client_id": CLIENT_ID, "id": 999999})
    r.call(op_a, cj_a, "sb_remove_parent", "admin", "cart", "staff_basket_remove_item",
           {"client_id": CLIENT_ID, "id": parent_line})
    r.call(op_a, cj_a, "sb_get_after_remove", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_discard", "admin", "cart", "staff_basket_discard",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_get_after_discard", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_promo_empty", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})

    # ---------- domain adds (views only; domain checkout stays unwired) ----------
    r.call(op_a, cj_a, "sb_add_domain", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "register",
            "register_sld": "cap25domain", "register_tld": ".com", "register_years": 1})
    r.call(op_a, cj_a, "sb_get_domain", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_add_domain_dup", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "register",
            "register_sld": "CAP25DOMAIN", "register_tld": ".com", "register_years": 1})
    r.call(op_a, cj_a, "sb_add_domain_transfer", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "transfer",
            "transfer_sld": "cap25transfer", "transfer_tld": ".com"})
    r.call(op_a, cj_a, "sb_add_domain_own", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "owndomain",
            "owndomain_sld": "cap25own", "owndomain_tld": ".com"})
    r.call(op_a, cj_a, "sb_get_domains", "admin", "cart", "staff_basket_get",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_add_domain_noaction", "admin", "cart",
           "staff_basket_add_item", {"client_id": CLIENT_ID, "id": 1})
    r.call(op_a, cj_a, "sb_add_domain_badact", "admin", "cart",
           "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "bogus"})
    r.call(op_a, cj_a, "sb_add_domain_noyears", "admin", "cart",
           "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "register",
            "register_sld": "cap25x", "register_tld": ".com"})
    r.call(op_a, cj_a, "sb_add_domain_badsld", "admin", "cart",
           "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "register",
            "register_sld": "bad_sld!", "register_tld": ".com", "register_years": 1})
    r.call(op_a, cj_a, "sb_add_domain_badtld", "admin", "cart",
           "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 1, "action": "register",
            "register_sld": "cap25x", "register_tld": ".zzz", "register_years": 1})
    r.call(op_a, cj_a, "sb_discard2", "admin", "cart", "staff_basket_discard",
           {"client_id": CLIENT_ID})

    # ---------- checkouts ----------
    r.call(op_a, cj_a, "sb_checkout_empty", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID})
    r.call(op_a, cj_a, "sb_add_once2", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "quantity": 1})
    r.call(op_a, cj_a, "sb_checkout_simple", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1})
    r.dump_delta("sb_checkout_simple_db")
    r.call(op_a, cj_a, "sb_add_promo_checkout", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "quantity": 1})
    r.call(op_a, cj_a, "sb_promo_checkout", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25PCT10"})
    r.call(op_a, cj_a, "sb_checkout_promo", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1})
    r.dump_delta("sb_checkout_promo_db")
    r.call(op_a, cj_a, "sb_add_markpaid", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2})
    r.call(op_a, cj_a, "sb_checkout_markpaid_nogw", "admin", "cart",
           "staff_basket_checkout",
           {"client_id": CLIENT_ID, "mark_invoice_paid": 1})
    r.call(op_a, cj_a, "sb_checkout_markpaid_notx", "admin", "cart",
           "staff_basket_checkout",
           {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 1})
    r.call(op_a, cj_a, "sb_checkout_markpaid", "admin", "cart",
           "staff_basket_checkout",
           {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 1,
            "transactionId": "CAP25TX1"})
    r.dump_delta("sb_checkout_markpaid_db")
    # same txn id on a new invoice -> mismatch error (orders+invoice still created)
    r.call(op_a, cj_a, "sb_add_markpaid_dup", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2})
    r.call(op_a, cj_a, "sb_checkout_markpaid_duptx", "admin", "cart",
           "staff_basket_checkout",
           {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 1,
            "transactionId": "CAP25TX1"})
    r.dump_delta("sb_checkout_markpaid_duptx_db")
    r.call(op_a, cj_a, "sb_add_stripe", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2})
    r.call(op_a, cj_a, "sb_checkout_stripe_paid", "admin", "cart",
           "staff_basket_checkout",
           {"client_id": CLIENT_ID, "mark_invoice_paid": 1, "gateway_id": 3})
    r.dump_delta("sb_checkout_stripe_paid_db")
    r.call(op_a, cj_a, "sb_add_free", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": prod_free})
    r.call(op_a, cj_a, "sb_checkout_free", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1})
    r.dump_delta("sb_checkout_free_db")
    r.call(op_a, cj_a, "sb_add_pct100", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2})
    r.call(op_a, cj_a, "sb_promo_pct100", "admin", "cart", "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25PCT100"})
    r.call(op_a, cj_a, "sb_checkout_pct100", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1})
    r.dump_delta("sb_checkout_pct100_db")
    # disabled product checkout (staff allows disabled products)
    r.call(op_a, cj_a, "sb_add_disabled_checkout", "admin", "cart",
           "staff_basket_add_item", {"client_id": CLIENT_ID, "id": prod_disabled})
    r.call(op_a, cj_a, "sb_checkout_disabled", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1})
    r.dump_delta("sb_checkout_disabled_db")
    # activate=0: orders stay pending_setup, no activation emails
    r.call(op_a, cj_a, "sb_add_noactivate", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": prod_free})
    r.call(op_a, cj_a, "sb_checkout_noactivate", "admin", "cart",
           "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1, "activate": 0})
    r.dump_delta("sb_checkout_noactivate_db")
    # override line checkout: config must strip __price_override/__cart_family
    r.call(op_a, cj_a, "sb_add_override_checkout", "admin", "cart",
           "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2, "price": 33.33})
    r.call(op_a, cj_a, "sb_checkout_override", "admin", "cart", "staff_basket_checkout",
           {"client_id": CLIENT_ID, "gateway_id": 1})
    r.dump_delta("sb_checkout_override_db")
    r.call(op_a, cj_a, "sb_add_once_used", "admin", "cart", "staff_basket_add_item",
           {"client_id": CLIENT_ID, "id": 2})
    r.call(op_a, cj_a, "sb_promo_once_apply", "admin", "cart",
           "staff_basket_apply_promo",
           {"client_id": CLIENT_ID, "promocode": "CAP25ONCE"})
    r.call(op_a, cj_a, "sb_checkout_once_used", "admin", "cart",
           "staff_basket_checkout", {"client_id": CLIENT_ID, "gateway_id": 1})
    r.call(op_a, cj_a, "sb_discard3", "admin", "cart", "staff_basket_discard",
           {"client_id": CLIENT_ID})

    # ---------- batch_expire ----------
    r.call(op_a, cj_a, "cart_batch_expire", "admin", "cart", "batch_expire")
    r.call(op_a, cj_a, "cart_batch_expire2", "admin", "cart", "batch_expire")
    r.dump_cap_carts("cart_batch_expire_db")

    # ---------- staff admin ----------
    r.call(op_a, cj_a, "staff_group_get_pairs", "admin", "staff", "group_get_pairs")
    hist_id = d.execute("SELECT MAX(id) FROM activity_admin_history").fetchone()[0]
    r.call(op_a, cj_a, "staff_login_history_get", "admin", "staff", "login_history_get",
           {"id": hist_id})
    r.call(op_a, cj_a, "staff_login_history_get_missing", "admin", "staff",
           "login_history_get", {"id": 999999})
    r.call(op_a, cj_a, "staff_login_history_get_noid", "admin", "staff",
           "login_history_get")

    # ---------- staff guest: login ----------
    def guest_login_case(name, data, with_csrf=True):
        op_g, cj_g = r.opener()
        r.call(op_g, cj_g, name, "guest", "staff", "login", data,
               with_csrf=with_csrf)

    guest_login_case("staff_login_ok",
                     {"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    r.dump_delta("staff_login_ok_db")
    guest_login_case("staff_login_wrongpass",
                     {"email": ADMIN_EMAIL, "password": "WrongPass!99"})
    guest_login_case("staff_login_unknown",
                     {"email": "nobody@example.com", "password": "Whatever!99"})
    guest_login_case("staff_login_inactive",
                     {"email": "cap25.inactive@example.com", "password": ADMIN_PASS})
    guest_login_case("staff_login_cron",
                     {"email": "hn11BSSd@PMgLWIl2.com", "password": "x"})
    guest_login_case("staff_login_bademail",
                     {"email": "not-an-email", "password": "Whatever!99"})
    guest_login_case("staff_login_noemail", {"password": "Whatever!99"})
    guest_login_case("staff_login_nopass", {"email": ADMIN_EMAIL})
    guest_login_case("staff_login_nocsrf",
                     {"email": ADMIN_EMAIL, "password": ADMIN_PASS},
                     with_csrf=False)
    guest_login_case("staff_login_rehash",
                     {"email": "cap25.rehash@example.com", "password": "Cap25-Rehash!99"})
    r.dump_delta("staff_login_rehash_db")

    # ---------- staff guest: password reset request ----------
    def guest_pwreset_case(name, data):
        op_g, cj_g = r.opener()
        return r.call(op_g, cj_g, name, "guest", "staff", "passwordreset", data)

    guest_pwreset_case("staff_pwreset_ok", {"email": ADMIN_EMAIL})
    r.dump_delta("staff_pwreset_ok_db")
    reset_hash = d.execute(
        "SELECT hash FROM admin_password_reset WHERE admin_id = 1"
        " ORDER BY id DESC LIMIT 1").fetchone()[0]
    guest_pwreset_case("staff_pwreset_again", {"email": ADMIN_EMAIL})
    n_resets = d.execute(
        "SELECT COUNT(*) FROM admin_password_reset WHERE admin_id = 1").fetchone()[0]
    print(f"[{base}] resets after second request:", n_resets)
    reset_hash = d.execute(
        "SELECT hash FROM admin_password_reset WHERE admin_id = 1"
        " ORDER BY id DESC LIMIT 1").fetchone()[0]
    guest_pwreset_case("staff_pwreset_unknown", {"email": "nobody@example.com"})
    guest_pwreset_case("staff_pwreset_inactive",
                       {"email": "cap25.inactive@example.com"})
    guest_pwreset_case("staff_pwreset_noemail", {})
    guest_pwreset_case("staff_pwreset_bademail", {"email": "not-an-email"})

    # ---------- staff guest: password reset confirm ----------
    def guest_pwupdate_case(name, data):
        op_g, cj_g = r.opener()
        return r.call(op_g, cj_g, name, "guest", "staff", "update_password", data)

    guest_pwupdate_case("staff_pwupdate_mismatch",
                        {"code": reset_hash, "password": "Cap25-New!99",
                         "password_confirm": "Cap25-Other!99"})
    guest_pwupdate_case("staff_pwupdate_weak",
                        {"code": reset_hash, "password": "short",
                         "password_confirm": "short"})
    guest_pwupdate_case("staff_pwupdate_nocode",
                        {"password": "Cap25-New!99",
                         "password_confirm": "Cap25-New!99"})
    guest_pwupdate_case("staff_pwupdate_badcode",
                        {"code": "0" * 64, "password": "Cap25-New!99",
                         "password_confirm": "Cap25-New!99"})
    guest_pwupdate_case("staff_pwupdate_expired",
                        {"code": "cap25expiredhash", "password": "Cap25-New!99",
                         "password_confirm": "Cap25-New!99"})
    guest_pwupdate_case("staff_pwupdate_ok",
                        {"code": reset_hash, "password": "Cap25-New!99",
                         "password_confirm": "Cap25-New!99"})
    r.dump_delta("staff_pwupdate_ok_db")
    guest_login_case("staff_login_newpass",
                     {"email": ADMIN_EMAIL, "password": "Cap25-New!99"})
    guest_login_case("staff_login_oldpass",
                     {"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    r.dump_changed_settings("changed_settings")
    return {"env": scrub(r.env), "db": r.db}


def main():
    d = sqlite3.connect(DBP)
    d.row_factory = sqlite3.Row
    snaps = {}
    for t in TABLES:
        snaps[t] = (d.execute(f'SELECT * FROM "{t}"').fetchall(),
                    [x[1] for x in d.execute(f'PRAGMA table_info("{t}")')])
    seq_q = ", ".join("?" * len(TABLES))
    snap_seq = d.execute(
        f"SELECT name, seq FROM sqlite_sequence WHERE name IN ({seq_q})", TABLES).fetchall()

    def restore():
        d.execute(f"DELETE FROM sqlite_sequence WHERE name IN ({seq_q})", TABLES)
        for name, seq in snap_seq:
            d.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (name, seq))
        for t in TABLES:
            rows, cols = snaps[t]
            d.execute(f'DELETE FROM "{t}"')
            d.executemany(f'INSERT INTO "{t}" (' + ",".join(cols) + ") VALUES ("
                          + ",".join("?" * len(cols)) + ")",
                          [tuple(x) for x in rows])
        d.commit()

    try:
        php = run_sequence(PHP)
        restore()
        nxt = run_sequence(NEXT)
    finally:
        restore()
        print("reference DB restored")

    mismatches = []
    for name in sorted(set(php["env"]) | set(nxt["env"])):
        if php["env"].get(name) != nxt["env"].get(name):
            mismatches.append(("env", name, php["env"].get(name), nxt["env"].get(name)))
    for name in sorted(set(php["db"]) | set(nxt["db"])):
        if php["db"].get(name) != nxt["db"].get(name):
            mismatches.append(("db", name, php["db"].get(name), nxt["db"].get(name)))

    total_env = len(php["env"])
    total_db = len(php["db"])
    print(f"envelopes: {total_env - sum(1 for k, *_ in mismatches if k == 'env')}/{total_env} match")
    print(f"db dumps:  {total_db - sum(1 for k, *_ in mismatches if k == 'db')}/{total_db} match")
    import difflib
    for kind, name, a, b in mismatches:
        print(f"\n=== MISMATCH {kind} {name} ===")
        al = json.dumps(a, indent=2, default=str, sort_keys=True).splitlines()
        bl = json.dumps(b, indent=2, default=str, sort_keys=True).splitlines()
        diff = list(difflib.unified_diff(al, bl, "PHP", "NEXT", lineterm=""))
        print("\n".join(diff[:80]))
        if len(diff) > 80:
            print(f"... ({len(diff) - 80} more diff lines)")
    if not mismatches:
        print("PARITY22 ALL MATCH")


if __name__ == "__main__":
    main()
