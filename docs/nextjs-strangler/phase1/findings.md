# Phase 1 — client core flows: live findings

Companion to `capture2.py` + `captures/` in this directory (15/16 calls OK;
the one "error" is the expected post-logout `Authentication Failed`, which
proves logout worked). All flows were additionally exercised end-to-end
through the Next app + `/api/fb` proxy on 2026-10-23.

## Findings

1. **The CSRF cookie is set only by PHP web pages, never by API
   responses.** A direct probe shows `POST /api/guest/system/company` sets
   only `fossbilling_session`, while `GET /login` (web) sets both
   `fossbilling_session` and `fossbilling_csrf`. The Phase 0 scaffold
   assumed any API response seeded the CSRF cookie — wrong: a browser that
   has only ever talked to the Next origin cannot log in ("CSRF token
   invalid", 403). Fix in this phase: the proxy gained a `GET
   /api/fb/__prime` route that relays the PHP login page's cookies, and
   `fbPost` primes on first use. Server components were unaffected (they
   read whatever cookies the browser already holds).

2. **Client-role invoice access is by `hash`, not `id`.**
   `client/invoice/get` requires `hash`; list items carry both. The PDF is
   not an API call at all — it is the session-authenticated web route
   `GET /invoice/pdf/<hash>`. The Next app streams it through
   `/invoices/[hash]/pdf` (verified: `application/pdf`, 28,808 bytes,
   `%PDF` magic — byte-size identical to the direct PHP capture).

3. **Replying to a closed ticket fails by design** when the helpdesk has
   `can_reopen: false` ("Ticket cannot be reopened.", code 9999) — the
   seeded "General" helpdesk is configured that way. The UI hides the
   reply form for closed tickets accordingly.

4. **Guest signup with an already-authenticated client session fails**
   with the sanitized guest error (`An unexpected error occurred`, 9999);
   the same payload succeeds from a fresh session and the new account is
   auto-logged-in (subsequent `client/profile/get` works). Observed via
   HTTP; the underlying exception is hidden by `sanitizeGuestError`, and
   the service-level call (`api_guest->client_create`) succeeds — so this
   is a session-state interaction in the web/API controller layer,
   recorded as an observation, not a defect claim.

5. **Ticket thread shape:** `ticket_get` returns `first` (the opening
   message) plus `messages` (subsequent replies); counts in `replies`
   exclude the opening message. The detail page merges and de-dupes them.

## Verified end-to-end through the Next origin (2026-10-23)

- Prime → login (seeded client) → dashboard renders profile + counts.
- Orders list/detail render the seeded order; invoice list links by hash;
  invoice detail renders lines/subtotal/tax/total; PDF route streams the
  real PDF.
- Mutations through the proxy: ticket create (#2) → reply → detail page
  shows both messages → close → logout → `profile/get` returns
  `Authentication Failed`.
- Signup from a fresh session succeeds and lands authenticated on the
  dashboard.
