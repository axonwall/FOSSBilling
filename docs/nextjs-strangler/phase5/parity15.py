#!/usr/bin/env python3
"""Phase 5 R1 batch 2 parity: Stats endpoints through the TS
stack, checked against captures18/.

Default-window Flot series timestamps embed the run's
time-of-day (PHP steps from strtotime('-1 month'), i.e. now
minus a month), so default series are compared by calendar
day + value, not raw timestamp. Dated series (midnight
bounds) are compared exactly."""
import datetime, json, pathlib, urllib.request, urllib.parse, http.cookiejar

NEXT = "http://127.0.0.1:3001"
CAP = pathlib.Path(__file__).parent / "captures18"
results = []


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


def main():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.open(f"{NEXT}/api/fb/__prime", timeout=20).read()

    def call(role, module, method, data=None):
        payload = flatten(dict(data or {}))
        for c in cj:
            if c.name == "fossbilling_csrf":
                payload["CSRFToken"] = c.value
        req = urllib.request.Request(f"{NEXT}/api/fb/{role}/{module}/{method}",
                                     data=urllib.parse.urlencode(payload).encode(), method="POST")
        try:
            with op.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def oracle(name):
        return json.load(open(CAP / f"{name}.json"))["result"]

    def by_day(series):
        return {datetime.datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%d"): v for ts, v in series}

    r = call("guest", "staff", "login", {"email": "admin@phase0.local", "password": "Phase1-Admin!42"})
    assert r.get("error") is None, r

    # Exact-equality endpoints (no series timestamps).
    cases = [
        ("get_summary", None, "stats_summary"),
        ("get_summary_income", None, "stats_summary_income"),
        ("get_orders_statuses", None, "stats_orders_statuses"),
        ("get_product_summary", None, "stats_product_summary"),
        ("get_product_sales", None, "stats_product_sales"),
        ("get_product_sales", {"date_from": "2026-10-01", "date_to": "2026-10-25"}, "stats_product_sales_dated"),
        ("get_income_vs_refunds", None, "stats_income_vs_refunds"),
        ("client_countries", None, "stats_client_countries"),
        ("client_countries", {"limit": 2}, "stats_client_countries_limit2"),
        ("sales_countries", None, "stats_sales_countries"),
        ("sales_countries", {"limit": 2}, "stats_sales_countries_limit2"),
    ]
    for method, data, cap in cases:
        r = call("admin", "stats", method, data)
        want = oracle(cap)
        label = f"{method} {data or ''}".strip()
        report(label, r.get("result") == want, f"got {str(r.get('result'))[:200]} want {str(want)[:200]}")

    # Dated series: exact (midnight bounds).
    for method, cap in [("get_refunds", "stats_refunds_dated"), ("get_income", "stats_income_dated"),
                        ("get_orders", "stats_orders_dated")]:
        r = call("admin", "stats", method, {"date_from": "2026-10-01", "date_to": "2026-10-25"})
        want = oracle(cap)
        report(f"{method} dated", r.get("result") == want,
               f"got {str(r.get('result'))[:200]} want {str(want)[:200]}")

    # Default series: compare by calendar day + value.
    for method, cap in [("get_refunds", "stats_refunds"), ("get_income", "stats_income"),
                        ("get_orders", "stats_orders"), ("get_clients", "stats_clients"),
                        ("get_invoices", "stats_invoices"), ("get_tickets", "stats_tickets")]:
        r = call("admin", "stats", method)
        want = oracle(cap)
        got_days, want_days = by_day(r.get("result") or []), by_day(want)
        report(f"{method} default (by day)", got_days == want_days,
               f"got {str(got_days)[:200]} want {str(want_days)[:200]}")

    n = sum(1 for _, ok in results if ok)
    print(f"\nparity Phase5-R1b2: {n}/{len(results)} match")
    return 0 if n == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
