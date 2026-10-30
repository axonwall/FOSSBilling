/**
 * Vendored disposable-domain SEED for the R5h antispam temp-email check.
 *
 * Seed date: 2026-10-30. This is a SMALL, hand-written seed of
 * well-known disposable domains — it is NOT the full fakefilter list
 * (which holds thousands of domains). Production deployments get the
 * full list via fetch + 86400s cache from
 * https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt;
 * the seed is consulted ONLY when a fetch fails (non-200 or transport
 * error), per the R5h snapshot resolution in findings-r5h.md: on fetch
 * failure, a seed-listed domain still blocks, and any other domain is
 * allowed (fail-open). That makes TS a deliberate third behavior:
 * stronger than PHP's non-200 allow for seed-listed domains, weaker
 * than a live fetch — and unlike PHP it never fails a signup outright
 * on a transport error. Never present this seed as the complete list.
 */
export const TEMP_EMAIL_SEED: readonly string[] = [
  "10minutemail.com",
  "10minutemail.net",
  "dispostable.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailinator.org",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "mytemp.email",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmailaddress.com",
  "throwaway.email",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
  "yopmail.net",
];
