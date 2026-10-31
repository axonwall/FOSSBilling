#!/usr/bin/env python3
"""R6c capture49 — LAST-CHANCE PHP-tree record, taken BEFORE any relocation
or deletion. This is the last batch that CAN capture from the live PHP tree.

Sections (all written to captures49/capture49.json):
  A. Vendored-file manifest: sha256 + size + PHP-tree relpath for EVERY file
     R6c vendors (52 email templates, Page client templates, theme client
     html tree, Servicelicense Plugin, content.sql, 2 GeoIP .mmdb files).
     parity46 verifies vendored copies against this manifest (and against
     `git show <parent>:src/...`); if a vendored file later proves wrong,
     this manifest is how anyone checks it.
  B. Email template parsed blocks: subject/content extracted with the EXACT
     regexes TS parseDefaultFile uses (emailDefaults.ts:78-79), so the
     vendored copies can be re-parsed and compared block-for-block.
  C. Live :3001 outputs with the PHP tree still in place (TS login via the
     R6a prime pattern): admin page get_pairs, servicelicense plugin pairs,
     security generalCheck (run_check), ip_lookup over the 8-shape R5i set.
     These are the "before" values parity46's relocation proof compares
     against the vendored-default outputs.
  D. Disposable installer fresh-state fingerprint with the CURRENT installer
     (PHP-tree content.sql via FOSSBILLING_PHP_SRC): tables, seeded rows,
     per-table counts of the 86 fresh rows, config keys (salt/instance_id
     presence + shape ONLY, never values), GeoIP copy report. Disposable
     root + DB only; the reference DB/config are never touched (read-only
     for §C; §D targets are deleted in finally).

Read-only vs the reference except §D's disposable targets. Secrets (admin
password, salt, instance_id) are NEVER printed or stored.
"""
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request

REPO = pathlib.Path("/home/hatch/scratch/fossbilling/repo")
SRC = REPO / "src"
OUTDIR = REPO / "docs" / "nextjs-strangler" / "phase5" / "captures49"
APP = REPO / "apps" / "nextjs"
TS = "http://127.0.0.1:3001/api/fb"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
LOGDIR = pathlib.Path("/home/hatch/scratch/fossbilling/r5-logs")

SUBJECT_RE = re.compile(r"\{%-?\s*block subject\s*-?%\}([^\n]*?)\{%-?\s*endblock\s*-?%\}")
CONTENT_RE = re.compile(r"\{%-?\s*block content\s*-?%\}((?:.*\n)+?)\{%-?\s*endblock\s*-?%\}")

IP_SET = ["127.0.0.1", "10.0.0.5", "192.168.1.1", "1.1.1.1",
          "8.8.8.8", "::ffff:8.8.8.8", "::1", "2001:4860:4860::8888"]


def sha256_of(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest_entry(p):
    return {"php_rel": str(p.relative_to(SRC)), "sha256": sha256_of(p),
            "size": p.stat().st_size}


def make_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), cj


def ts_call(op, cj, role, module, method, params=None):
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    body = dict(params or {})
    if csrf:
        body["CSRFToken"] = csrf
    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(f"{TS}/{role}/{module}/{method}", data=data, method="POST")
    with op.open(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def ts_login(op, cj):
    with op.open(urllib.request.Request(f"{TS}/__prime"), timeout=30) as resp:
        assert resp.status == 200, "__prime failed"
    csrf = None
    for c in cj:
        if c.name == "fossbilling_csrf":
            csrf = c.value
    body = {"email": SUPER_EMAIL, "password": SUPER_PASS}
    if csrf:
        body["CSRFToken"] = csrf
    data = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(f"{TS}/guest/staff/login", data=data, method="POST")
    with op.open(req, timeout=60) as resp:
        parsed = json.loads(resp.read().decode())
    assert parsed.get("error") is None, f"TS login failed: {parsed}"
    return parsed


def main():
    OUTDIR.mkdir(parents=True, exist_ok=True)
    out = {}

    # ---- §A manifest ----
    manifest = []
    email_templates = sorted((SRC / "modules").glob("*/templates/email/*.html.twig"))
    assert len(email_templates) == 52, f"expected 52 email templates, got {len(email_templates)}"
    for p in email_templates:
        manifest.append(manifest_entry(p))
    page_client = sorted((SRC / "modules" / "Page" / "templates" / "client").iterdir())
    for p in page_client:
        if p.is_file():
            manifest.append(manifest_entry(p))
    theme_html = sorted((SRC / "themes" / "default" / "client" / "html").rglob("*"))
    for p in theme_html:
        if p.is_file():
            manifest.append(manifest_entry(p))
    plugin_dir = SRC / "modules" / "Servicelicense" / "Plugin"
    for p in sorted(plugin_dir.iterdir()):
        if p.is_file():
            manifest.append(manifest_entry(p))
    manifest.append(manifest_entry(SRC / "install" / "sql" / "content.sql"))
    for name in ("CC0-Country.mmdb", "PDDL-ASN.mmdb"):
        manifest.append(manifest_entry(
            SRC / "library" / "FOSSBilling" / "GeoIP" / "Databases" / name))
    out["manifest"] = manifest
    theme_mod_pages = [m for m in manifest
                       if m["php_rel"].startswith("themes/default/client/html")
                       and pathlib.Path(m["php_rel"]).name.startswith("mod_page_")]
    out["theme_html_mod_page_count"] = len(theme_mod_pages)
    print(f"§A manifest: {len(manifest)} files; theme html mod_page files: {len(theme_mod_pages)}")

    # ---- §B parsed template blocks ----
    blocks = {}
    for p in email_templates:
        text = p.read_text()
        sm = SUBJECT_RE.search(text)
        cm = CONTENT_RE.search(text)
        blocks[str(p.relative_to(SRC))] = {
            "subject": sm.group(1) if sm else None,
            "content_len": len(cm.group(1)) if cm else None,
            "content_head": (cm.group(1)[:200] if cm else None),
        }
    out["template_blocks"] = blocks
    print(f"§B parsed blocks for {len(blocks)} templates")

    # ---- §C live :3001 outputs (PHP tree still in place) ----
    op, cj = make_opener()
    ts_login(op, cj)
    live = {}
    live["page_get_pairs"] = ts_call(op, cj, "admin", "page", "get_pairs")
    live["plugin_get_pairs"] = ts_call(op, cj, "admin", "servicelicense", "plugin_get_pairs")
    live["general_check"] = ts_call(op, cj, "admin", "security", "run_check",
                                    {"id": "generalCheck"})
    live["ip_lookup"] = {}
    for ip in IP_SET:
        live["ip_lookup"][ip] = ts_call(op, cj, "admin", "security", "ip_lookup", {"ip": ip})
    out["live_before"] = live
    print(f"§C live: get_pairs keys={list(live['page_get_pairs'].get('result', {}).keys())} "
          f"plugin_pairs={live['plugin_get_pairs'].get('result')} "
          f"generalCheck result={live['general_check'].get('result', {}).get('result') if isinstance(live['general_check'].get('result'), dict) else live['general_check']}")

    # ---- §D disposable installer fingerprint (current code, PHP-tree content.sql) ----
    dispo = LOGDIR / "capture49-disposable"
    if dispo.exists():
        shutil.rmtree(dispo)
    dispo.mkdir(parents=True)
    try:
        env = dict(os.environ, FOSSBILLING_PHP_SRC=str(SRC),
                   FB_INSTALL_ADMIN_PASSWORD="Cap49-Disposable!1")
        r = subprocess.run(["node", "scripts/run-install.mjs",
                            "--install-root", str(dispo),
                            "--url", "https://cap49.example/billing/",
                            "--admin-name", "Cap Admin",
                            "--admin-email", "cap49@example.com",
                            "--db-driver", "pdo_sqlite",
                            "--db-path", str(dispo / "cap49.sqlite"),
                            "--json"],
                           cwd=APP, capture_output=True, text=True, env=env, timeout=300)
        assert r.returncode == 0, f"installer failed: {r.stdout[-1000:]} {r.stderr[-1000:]}"
        report = json.loads(r.stdout)
        db = sqlite3.connect(dispo / "cap49.sqlite")
        tables = [row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {t: db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
                  for t in tables if db.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] > 0}
        cfg_text = (dispo / "config.php").read_text()
        out["installer_before"] = {
            "tables": len(tables),
            "seeded_rows": report.get("seededRows"),
            "nonempty_counts": counts,
            "total_rows": sum(counts.values()),
            "config_keys": sorted(re.findall(r"'([A-Za-z0-9_]+)' =>", cfg_text)),
            "salt_present_shape": bool(re.search(r"'salt' => '[0-9a-f]{32}'", cfg_text)),
            "geoip": report.get("geoip"),
        }
        print(f"§D installer: {len(tables)} tables, {sum(counts.values())} rows, "
              f"geoip copied={report.get('geoip', {}).get('copied')}")
    finally:
        shutil.rmtree(dispo, ignore_errors=True)

    with open(OUTDIR / "capture49.json", "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
    print(f"WROTE {OUTDIR / 'capture49.json'} ({len(manifest)} manifest entries)")


if __name__ == "__main__":
    main()
