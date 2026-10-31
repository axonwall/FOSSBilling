# Vendored PHP-tree files (R6c)

These files were copied from the upstream FOSSBilling 0.8.9 PHP tree
(`src/` at the R6c parent commit) when the fork's `src/` tree was
deleted. They are the runtime data the TypeScript server still needs:

- `geoip/` — GeoIP country + ASN databases (CC0-Country.mmdb,
  PDDL-ASN.mmdb, 15.3 MB). Read by `server/geoip.ts` for `ip_lookup`;
  copied into new installs by the installer.
- `php-modules/` — the PHP `modules/` dir, restricted to what the
  TS server reads: `<Module>/templates/email/*.html.twig` (52 email
  templates, D6-10 exact parity), `Page/templates/client/*` (page
  picker pairs), `Servicelicense/Plugin/*` (plugin pairs).
- `php-themes/default/client/html/` — the default theme's client
  html tree (scanned for page picker pairs alongside the Page
  templates; today it contributes zero `mod_page_*` files — see
  findings-r6c.md §1.5 — but the scan path is kept faithful).
- `content.sql` — the installer seed file (schema + seed rows).

## Provenance + byte identity

Copied at R6c, byte-identical to the parent commit's `src/` tree.
Proof: `docs/nextjs-strangler/phase5/captures49/capture49.json`
`manifest` (sha256 + size for all 77 files, taken from the live PHP
tree before deletion), re-verified by `parity46.py` §1 against both
the manifest and `git show <parent>:src/...`. If a file here ever
looks wrong, captures49 is the record to check it against.

## DO NOT HAND-EDIT

These are upstream data files, not source. To refresh them, copy
from the parent commit (`git show <parent>:src/...`) and re-verify
against the manifest; never transcribe or "fix" a template by hand
(that is exactly the drift D6-10 forbids).

## Override rule (uniform across resolvers)

An explicit env override applies ONLY if the directory exists;
otherwise the vendored default applies. `FOSSBILLING_PHP_SRC` is
retained as the legacy override name for template/pairs dirs
(operators with custom template trees keep working); the installer
no longer consults it. `FB_GEOIP_DB_DIR` is the exception: when
set, it must exist — a missing dir errors loudly instead of
falling back silently.
