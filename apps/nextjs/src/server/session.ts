import { randomBytes } from "node:crypto";
import { findSession, insertSession } from "./db";
import { parseSessionContent, phpSerialize } from "./php-serialize";
import type { CallContext } from "./dispatch";

/**
 * PHP-session authentication for TS-ported modules.
 *
 * FOSSBilling sessions are rows in the `session` table whose `content`
 * is Symfony-serialized data; the `_sf2_attributes` bag carries
 * `csrf_token` plus the caller's identity. The identity encoding is
 * asymmetric in PHP itself (verified against live rows, Phase 2):
 * staff login stores an `admin` array ({id, email, name}), while the
 * client API login stores a bare `client_id` integer and the PHP API
 * layer hydrates the client per request. Both forms are accepted here
 * (and the `client` array form, which the web login flow writes).
 */

export interface Identity {
  id: number;
  email?: string;
  name?: string;
}

export interface SessionInfo {
  id: string;
  csrfToken?: string;
  admin?: Identity;
  client?: Identity;
}

function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function readSession(cookieHeader: string | null): Promise<SessionInfo | null> {
  const sid = cookieValue(cookieHeader, "fossbilling_session");
  if (!sid) return null;
  const row = await findSession(sid);
  if (!row) return null;
  if (row.lifetime && row.lifetime < Math.floor(Date.now() / 1000)) return null;
  let attrs: Record<string, unknown> = {};
  try {
    const segments = parseSessionContent(row.content);
    attrs = (segments["_sf2_attributes"] ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const info: SessionInfo = { id: sid };
  if (typeof attrs["csrf_token"] === "string") info.csrfToken = attrs["csrf_token"];
  for (const key of ["admin", "client"] as const) {
    const raw = attrs[key] as { id?: unknown; email?: unknown; name?: unknown } | undefined;
    if (raw && typeof raw.id === "number") {
      info[key] = {
        id: raw.id,
        email: typeof raw.email === "string" ? raw.email : undefined,
        name: typeof raw.name === "string" ? raw.name : undefined,
      };
    } else if (typeof attrs[`${key}_id`] === "number") {
      // Bare-id form (what the client API login writes).
      info[key] = { id: attrs[`${key}_id`] as number };
    }
  }
  return info;
}

/**
 * Staff\Service::login, session half: Symfony regenerateId() mints a
 * fresh id, keeps the attribute bag (so the CSRF token survives), then
 * sets `admin`. Observed live 2026-10-26: the old row is NOT deleted
 * by the PHP login path (it persists until session GC), so the TS
 * login leaves it in place too — deleting it was a parity diff. The
 * new session cookie is queued on the context for the route to attach
 * to the response.
 */
export async function loginAsAdmin(ctx: CallContext, admin: Identity): Promise<SessionInfo> {
  const old = ctx.session;
  // R6a: the session MUST carry a csrf_token AND the response MUST set
  // the fossbilling_csrf cookie — mirroring loginClientSession. Before
  // this fix, a fresh staff login (no prior session) stored no token
  // and set no csrf cookie, so every subsequent authenticated call
  // from that session failed enforceCsrf with 403. The defect was
  // masked for years because every suite and browser flow logged in
  // via PHP, whose sessions always carry csrf_token; with the PHP
  // proxy deleted, the TS staff login must yield a working session
  // on its own (the runner + browser prime->login proofs in
  // parity44 §2 exercise exactly this).
  const token = old?.csrfToken ?? randomBytes(16).toString("hex");
  const attrs: Record<string, string | number | Record<string, string | number | null>> = {
    csrf_token: token,
  };
  attrs["admin"] = { id: admin.id, email: admin.email ?? null, name: admin.name ?? null };
  const id = randomBytes(16).toString("hex");
  const empty = phpSerialize({});
  const content = `_sf2_attributes|${phpSerialize(attrs)}_symfony_flashes|${empty}_sf2_meta|${empty}`;
  await insertSession(id, content, Math.floor(Date.now() / 1000) + 86400);
  // Deliberately no deleteSessionRow(old.id): PHP leaves the old row.
  ctx.setCookies.push(`fossbilling_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  ctx.setCookies.push(`fossbilling_csrf=${token}; Path=/`);
  ctx.session = { id, csrfToken: token, admin: { id: admin.id, email: admin.email, name: admin.name } };
  return ctx.session;
}
export async function ensureSession(ctx: CallContext): Promise<SessionInfo> {
  if (ctx.session) return ctx.session;
  // R6a: a minted session MUST carry a csrf_token and the response
  // MUST set the matching fossbilling_csrf cookie — same invariant as
  // both login paths. Before this fix, guest-cart flows (which mint
  // their session here) got a token-less session, so every subsequent
  // call on that jar failed enforceCsrf with 403. Pre-R6a the old
  // __prime relayed a PHP /login session (which always carries
  // csrf_token), masking the hole; the TS-native prime is csrf-only
  // by design, so the minting path itself must issue the token.
  const token = randomBytes(16).toString("hex");
  const id = randomBytes(16).toString("hex");
  const empty = phpSerialize({});
  const content = `_sf2_attributes|${phpSerialize({ csrf_token: token })}_symfony_flashes|${empty}_sf2_meta|${empty}`;
  await insertSession(id, content, Math.floor(Date.now() / 1000) + 86400);
  ctx.setCookies.push(`fossbilling_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  ctx.setCookies.push(`fossbilling_csrf=${token}; Path=/`);
  ctx.session = { id, csrfToken: token };
  return ctx.session;
}
