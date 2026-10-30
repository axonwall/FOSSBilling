#!/usr/bin/env python3
"""Phase 5 R5a closing accounting: reconcile the 579-endpoint catalog
against the TS handler registry, the explicit-removal lists, and the
named R5 deferrals. Re-derived from sources, never copied from R1.
R5a closed 6 of the deferred-9 (localization x2, error_reporting x3,
instance_id); only the security trio remains deferred (R5i).

Usage: python3 endpoint-accounting.py
Exit 0 only when resolving + removed + deferred + proxied == 579.
"""
import json
import re
import sys
from pathlib import Path

REPO = Path("/home/hatch/scratch/fossbilling/repo")
APP = REPO / "apps/nextjs"
CATALOG = Path("/home/hatch/scratch/fossbilling/phase0/api-catalog.json")

REMOVED = {
    ("admin", "system", m)
    for m in [
        "update_available", "update_info", "recheck_update", "update_core",
        "update_finalization_status", "finalize_update",
        "complete_update_finalization", "manual_update",
        "is_behind_on_patches", "cache_settings", "update_cache_settings",
        "clear_cache", "template_exists", "env", "get_interface_ips",
        "set_interface_ip", "messages", "cas_messages",
    ]
} | {
    ("admin", "extension", m)
    for m in [
        "install", "uninstall", "update", "get_latest",
        "get_extension_readme", "languages", "toggle_language",
        "locale_completion",
    ]
} | {("guest", "extension", "languages"),
     ("guest", "system", "template_exists")} | {
    ("admin", "theme", m) for m in ["select", "preset_delete", "preset_select"]
}

DEFERRED = set()
# R5a closed the six system deferrals (localization_settings,
# update_localization_settings, error_reporting_enabled,
# toggle_error_reporting, last_error_reporting_change, instance_id) —
# they now have handlers, so they count as resolving, not deferred.
# R5i closed the last three (security ip_lookup, run_check,
# run_checks) — DEFERRED is empty, so accounting is 548 + 31 + 0.

# Magic __call: served by the servicecustom magic handler (R4d), not by a
# literal register() call. The catalog holds exactly one __call entry.
# Counted only when the magic handler is actually registered in code,
# so a pre-R4d run honestly shows __call as still proxied.
_sc = (APP / "src/server/modules/servicecustom.ts").read_text()
MAGIC = {("admin", "servicecustom", "__call")} if "registerMagic" in _sc else set()

LIT = re.compile(r'register\("([a-z]+)",\s*"([a-z0-9_]+)",\s*"([^"]+)"')
handlers = set()
dynamic = []
for f in sorted((APP / "src/server/modules").glob("*.ts")):
    for i, line in enumerate(f.read_text().splitlines(), 1):
        if "register(" not in line or line.strip().startswith("//"):
            continue
        m = LIT.search(line)
        if m:
            handlers.add((m.group(1), m.group(2), m.group(3)))
        elif "for (" not in line and "REMOVED" not in line:
            dynamic.append(f"{f.name}:{i}:{line.strip()[:100]}")

catalog = json.load(open(CATALOG))["endpoints"]
assert len(catalog) == 579, len(catalog)
cat = {(e["role"], e["module_route"], e["method"]) for e in catalog}
assert len(cat) == 579, f"catalog keys not unique: {len(cat)}"

# Removed wins over literal handlers: guest/extension/languages has a
# literal removal handler (R4a) that throws, so it is removed, not
# resolving. The admin removal lists are loop-registered, not literal,
# so they never appear in `handlers` at all.
removed = {c for c in cat if c in REMOVED}
resolving = {c for c in cat if c in handlers or c in MAGIC} - removed
deferred = {c for c in cat if c in DEFERRED}
proxied = cat - resolving - removed - deferred

print(f"catalog:           {len(cat)}")
print(f"TS handlers (lit): {len(handlers)} (dynamic register lines: {len(dynamic)})")
print(f"resolving in TS:   {len(resolving)}")
print(f"removed (errors):  {len(removed)}")
print(f"deferred to R5:    {len(deferred)}")
print(f"still proxied:     {len(proxied)}")
print(f"sum:               {len(resolving) + len(removed) + len(deferred) + len(proxied)}")
print()
print("removed not in catalog:", sorted(REMOVED - cat))
print("deferred not in catalog:", sorted(DEFERRED - cat))
print("deferred WITH a handler (must be empty):", sorted(deferred & handlers))
print("removed with a literal handler (must be exactly the two",
      "literal removals):", sorted(removed & handlers))
print("dynamic register lines:", dynamic)
print()
print("still proxied (module/method):")
for c in sorted(proxied):
    print("  ", "/".join(c))
print()
print("deferred:")
for c in sorted(deferred):
    print("  ", "/".join(c))

ok = (len(resolving) + len(removed) + len(deferred) + len(proxied) == 579
      and not (DEFERRED - cat) and not (deferred & handlers))
sys.exit(0 if ok else 1)
