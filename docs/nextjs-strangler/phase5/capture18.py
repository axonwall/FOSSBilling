#!/usr/bin/env python3
"""Phase 5 R1 batch 2 capture corpus: Stats endpoints against PHP.
Read-only: no state is mutated, so no restores are needed."""
import json, pathlib, urllib.request, urllib.parse, http.cookiejar

BASE = "http://127.0.0.1:8080"
OUT = pathlib.Path(__file__).parent / "captures18"
OUT.mkdir(exist_ok=True)
manifest = []


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}[{k}]" if prefix else k
        if isinstance(v, dict):
            out.update(flatten(v, key))
        else:
            out[key] = v
    return out


def main():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.open(f"{BASE}/login", timeout=20).read()

    def call(name, role, module, method, data=None):
        payload = flatten(dict(data or {}))
        for c in cj:
            if c.name == "fossbilling_csrf":
                payload["CSRFToken"] = c.value
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

    call("tmp_staff_login", "guest", "staff", "login",
         {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})

    call("stats_summary", "admin", "stats", "get_summary")
    call("stats_summary_income", "admin", "stats", "get_summary_income")
    call("stats_orders_statuses", "admin", "stats", "get_orders_statuses")
    call("stats_product_summary", "admin", "stats", "get_product_summary")
    call("stats_product_sales", "admin", "stats", "get_product_sales")
    call("stats_product_sales_dated", "admin", "stats", "get_product_sales",
         {"date_from": "2026-10-01", "date_to": "2026-10-25"})
    call("stats_income_vs_refunds", "admin", "stats", "get_income_vs_refunds")
    call("stats_refunds", "admin", "stats", "get_refunds")
    call("stats_refunds_dated", "admin", "stats", "get_refunds",
         {"date_from": "2026-10-01", "date_to": "2026-10-25"})
    call("stats_income", "admin", "stats", "get_income")
    call("stats_income_dated", "admin", "stats", "get_income",
         {"date_from": "2026-10-01", "date_to": "2026-10-25"})
    call("stats_orders", "admin", "stats", "get_orders")
    call("stats_orders_dated", "admin", "stats", "get_orders",
         {"date_from": "2026-10-01", "date_to": "2026-10-25"})
    call("stats_clients", "admin", "stats", "get_clients")
    call("stats_invoices", "admin", "stats", "get_invoices")
    call("stats_tickets", "admin", "stats", "get_tickets")
    call("stats_client_countries", "admin", "stats", "client_countries")
    call("stats_client_countries_limit2", "admin", "stats", "client_countries", {"limit": 2})
    call("stats_sales_countries", "admin", "stats", "sales_countries")
    call("stats_sales_countries_limit2", "admin", "stats", "sales_countries", {"limit": 2})

    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{sum(1 for m in manifest if m['ok'])}/{len(manifest)} OK")


if __name__ == "__main__":
    main()
