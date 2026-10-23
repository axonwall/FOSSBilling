# FOSSBilling — Next.js strangler frontend

Scope B (strangler) conversion of FOSSBilling to Next.js, per
`fossbilling-nextjs-conversion-plan-2026-10-23.md` (decisions D1–D8 taken with
recommended defaults unless Josh directs otherwise).

- **Phase 0 (done, 2026-10-23):** contract capture against a live PHP 0.8.9
  reference instance. Artifacts live in `docs/nextjs-strangler/phase0/` of
  this repo: the full API catalog (506 unique dispatcher methods / 1,054 route
  entries), the Doctrine schema map (66 entities / 64 tables), auth &
  password-portability findings (bcrypt `$2y$` cost 12 for both clients and
  staff — existing passwords carry over), the cron inventory, and a live
  capture corpus (guest → signup → login → order → invoice → paid).
- **Phase 1 (this app):** Next.js 15 / React 19 / TypeScript frontend that
  owns no billing state. All data flows through the typed dispatcher client
  in `src/lib/fossbilling.ts` (server-side) or the same-origin proxy in
  `src/app/api/fb/[...path]/route.ts` (browser), both targeting the PHP API
  at `FOSSBILLING_URL` (default `http://127.0.0.1:8080`).

## Run

```bash
# 1. Run FOSSBilling PHP (existing install) on :8080
# 2. Then:
npm install
FOSSBILLING_URL=http://127.0.0.1:8080 npm run dev   # http://localhost:3001
```

## Pages

- `/` — client area home; renders `guest/system/company` live (smoke test
  for the seam).
- `/invoices` — client invoice list (`client/invoice/get_list`, session
  cookie forwarded server-side).
- `/login` — client sign-in via the proxy to `guest/client/login`
  (CSRF: `fossbilling_csrf` cookie → `CSRFToken` field).
- `/admin` — placeholder; the PHP admin theme stays authoritative until
  admin modules are ported in later Scope B phases.

## Auth facts (verified live, Phase 0)

- Token login: HTTP Basic with username literally `admin` or `client` and
  the API token as the password (NOT `email:token`).
- Sessions are server-side rows in the `session` table; user passwords are
  bcrypt `$2y$` cost 12 and verify in Node with the `$2y$`→`$2b$` prefix swap
  (or any `$2y$`-capable verifier).
