# Phase 0 — Live findings & errata (2026-10-23)

Established by standing up a real PHP 0.8.9 instance (static PHP 8.3.28,
SQLite, programmatic install via `SchemaInstaller` + `InstallSeeder` —
63 live tables) and running `capture.py` against it: **28 API calls,
full lifecycle guest → signup → login → product → order → invoice → paid**
(invoice: lines 60 + 40, subtotal 100, tax 0, total 100 USD, `mark_as_paid`
via the Custom gateway → `status: paid`, `paid_at` set).

## Corrections to the static recon (`auth-and-fixtures.md`)

1. **Token login username is the literal role name.** HTTP Basic for the
   token flow is `admin:<api_token>` / `client:<api_token>` — NOT
   `email:token` (§3 of the recon). Verified live; `email:token` returns
   `Authentication Failed (201)`.
2. **Required-param validation lives in `#[RequiredParams([...])]`
   attributes** on the Api methods (parsed by the dispatcher's
   `validateRequiredParams`), not in `checkRequiredParams()` calls (the
   catalog extractor found zero of those and §1/§2 of the recon + catalog
   should be read with this correction). Deeper validation still lives in
   the Service layer.
3. **CSRF cookie name is `fossbilling_csrf`**; the form field is
   `CSRFToken`. (The recon's CookieNames account is otherwise right.)
4. **Production email validation does a DNS check**
   (`Tools::validateAndSanitizeEmail` adds `DNSCheckValidation` when
   `Environment::isProduction()`), so signup rejects domains without
   resolvable MX/A records in production. Dev mode is RFC-only.

## Verified upstream defect at 0.8.9 (candidate fix for this fork)

**SQLite installs cannot start sessions.** `src/di.php` hardcodes
`'lock_mode' => PdoSessionHandler::LOCK_ADVISORY` for the PDO session
handler; Symfony's handler throws
`DomainException: SQLite does not support advisory locks` for the sqlite
driver, so every session-starting request (including guest API calls)
500s on an otherwise-supported SQLite install. No matching upstream issue
found on 2026-10-23. The Phase 0 runtime copy works around it locally
with `LOCK_NONE` on sqlite (runtime copy only — NOT in this branch).
A proper fix would select the lock mode by DB driver in `di.php`
(advisory on MySQL/PostgreSQL, none/transactional on SQLite).

## Sandbox/environment notes (not app defects)

- Guest signup fetches the Antispam disposable-domain list from
  `raw.githubusercontent.com` at runtime; through this sandbox's proxy
  that TLS fetch intermittently fails and signup returns a masked 500.
  Seeding fell back to `admin/client/create` (same client row), after
  which guest login + all client-role captures pass.
- `load.php` deletes `src/install/` on sight once `config.php` exists in
  production mode — expected upstream behavior; the programmatic install
  therefore ran before the web root was served and read `content.sql`
  from a preserved copy.
- In dev mode with debug on, `load.php` redirects to the installer when
  the DB has no tables (chicken-and-egg for CLI installs) — the
  programmatic install ran with `APP_ENV=production`, the server runs
  with `APP_ENV=dev` (RFC-only email validation, rate limiter bypassed).
