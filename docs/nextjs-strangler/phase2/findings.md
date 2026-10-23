# Phase 2 (non-money backend) — batch 1: the TS module seam + System & Currency

Phase 2 of the plan ports backend modules to TypeScript **behind the same
`/api/:role/:module/:method` contract**, sharing the existing database.
This batch builds the seam and the first two modules.

## The seam

- `src/server/dispatch.ts` — a dispatcher speaking the exact PHP envelope
  (`{result, error}`; codes mirror PHP: 201 auth, 403 CSRF, 9999 domain).
- `src/server/db.ts` — data layer over the shared DB. Reference driver:
  SQLite via `node:sqlite` (`FB_DATABASE_PATH`), opened read-only with a
  5s busy timeout (PHP writes session rows concurrently; without the
  timeout, reads intermittently failed with "database is locked").
  MySQL/PostgreSQL drivers slot behind these helpers in later phases (D3).
- `src/server/session.ts` + `php-serialize.ts` — PHP-session auth in TS:
  the `session` table's `content` is Symfony-serialized data; its
  `_sf2_attributes` bag carries `csrf_token` and `admin`/`client`
  identity arrays. TS handlers read the same rows PHP writes, so a
  session created by PHP login is honored by TS modules and vice versa.
  Gotcha found live: Doctrine stores the content as a **blob**, so
  `node:sqlite` returns bytes — the layer decodes them to text.
- Routing lives in the existing `/api/fb` proxy: a call is served by TS
  only when its module is listed in `FB_TS_MODULES` **and** a handler is
  registered; everything else proxies to PHP. If the TS path cannot run
  (e.g. DB not configured), it falls back to PHP — the seam cannot take
  the API down. With `FB_TS_MODULES` unset (the default), behavior is
  exactly Phase 1.

## Ported in this batch (all read methods)

- `guest/system`: `company` (incl. the `hide_company_public` guest
  filtering, driven by the TS-parsed session), `periods`, `period_title`
  (incl. non-predefined codes, e.g. `2M` → "Every 2 months").
- `guest/currency`: `get_pairs`, `get`, `format` (conversion,
  `without_currency`, per-currency fraction digits, `format_pattern`
  with the `{amount}` placeholder).
- `admin/currency`: `get_list`, `get_pairs`, `get`, `get_default` —
  behind TS session auth (anonymous callers get PHP's exact
  `Authentication Failed` / 201).
- The currency code→name table is static reference data (Symfony Intl,
  en), vendored as JSON from the PHP implementation's own output in
  `captures/` — it changes only when upstream refreshes its Intl data.

## Parity

`FB_PARITY=1` makes every TS-served call also hit PHP and deep-compare
the parsed envelopes (mismatches logged as `[parity] MISMATCH`).
`parity2.py` replays the reference corpus (`capture5.py`) against the
Next origin: **16/16 responses identical to PHP**, including the
currency-not-found error and both format variants; the server parity log
agrees (16 `ok`, 0 mismatches).

Not yet ported: currency mutations (`create`/`update`/`delete`/
`set_default`/`update_rates`), the rest of System, and the remaining
Phase 2 modules (Client, Staff, Profile, Activity, News/Custompages) —
they follow the same seam in later batches.
