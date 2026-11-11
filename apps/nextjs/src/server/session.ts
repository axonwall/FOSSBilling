import { randomBytes } from "node:crypto";
import { findSession, getDb, insertSession } from "./db";
import { parseSessionContent, phpSerialize } from "./php-serialize";
import { FbError, timingSafeTokenEqual, type CallContext } from "./dispatch";

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
  /** The fossbilling_csrf cookie (or legacy csrf_token cookie) the
   * browser presented with this request, when one was sent. PHP's
   * _checkCSRFToken validates a non-empty CSRF cookie against the
   * session token (B-H1); readSession captures it here because the
   * seam otherwise never sees the raw cookie header. */
  csrfCookie?: string;
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
  // PHP reads the CSRF cookie first, falling back to the legacy name
  // (CookieNames::CSRF ?? CookieNames::LEGACY_CSRF); ?? keeps a
  // present-but-empty cookie instead of falling through to legacy.
  const csrfCookie = cookieValue(cookieHeader, "fossbilling_csrf") ?? cookieValue(cookieHeader, "csrf_token");
  if (csrfCookie !== undefined) info.csrfCookie = csrfCookie;
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
  ctx.session = { id, csrfToken: token, csrfCookie: token, admin: { id: admin.id, email: admin.email, name: admin.name } };
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
  ctx.session = { id, csrfToken: token, csrfCookie: token };
  return ctx.session;
}

/**
 * PHP Api\Controller\Client::tryParseBasicAuthHeader, transcribed:
 * `Basic base64("<username>:<password>")`, case-insensitive scheme,
 * strict base64, and a colon separating the two parts. Returns null
 * for anything else (absent header, non-Basic scheme, undecodable
 * base64, no colon) — PHP treats those as "no token login attempted"
 * and falls back to session auth. The password may itself contain
 * colons (explode with limit 2); it may be empty (the caller maps
 * that to PHP getAuth's 206).
 */
export function parseBasicAuth(
  authorization: string | undefined,
): { username: string; password: string } | null {
  if (!authorization) return null;
  const header = authorization.trim();
  if (header.slice(0, 6).toLowerCase() !== "basic ") return null;
  const encoded = header.slice(6).trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const decoded = Buffer.from(encoded, "base64");
  // Strict decode: a lenient re-encode must round-trip exactly.
  if (decoded.toString("base64") !== encoded) return null;
  const text = decoded.toString("utf-8");
  const sep = text.indexOf(":");
  if (sep < 0) return null;
  return { username: text.slice(0, sep), password: text.slice(sep + 1) };
}

/**
 * PHP Api\Controller\Client::_tryTokenLogin, transcribed (B-H2).
 * `Basic base64("<role>:<api_token>")` establishes a session
 * identity for the call, skipping session CSRF (the seam runs this
 * in place of enforceCsrf). Role/token lookup mirrors PHP exactly:
 *   - client: client row with matching api_token and status active
 *     (ClientEntity::ACTIVE); sets session client_id.
 *   - admin: admin row with matching api_token and status active,
 *     excluding the cron admin (Admin::isCron, system_name 'cron');
 *     sets session admin {id, email, name}.
 * Failure codes mirror PHP getAuth/_tryTokenLogin: 206 empty token,
 * 204 client token not found, 205 admin token not found / cron.
 * (PHP's 202 "no password" is a server-var shape with no header
 * equivalent; the cli-server oracle shows 202 for an empty password
 * because its SAPI drops the empty PHP_AUTH_PW var, while
 * FOSSBilling's own code gives 206 when the var is set — this port
 * follows the code, 206.)
 *
 * Comparison is constant-time: every active token-holder row for the
 * role is compared with timingSafeTokenEqual and no early exit, so
 * the lookup does not leak which row (if any) matched. PHP itself
 * does a DB equality lookup; the constant-time loop is this port's
 * hardening of that step, per the fix brief.
 *
 * The token identity is MERGED into the existing session bag (PHP
 * keeps the bag, setting only its own key), and the session id is
 * kept when one exists. When there is no prior session the identity
 * is in-memory only for this call (synthetic id `token:<role>:<id>`):
 * PHP does persist a Symfony session row and set its cookie, but
 * that session carries no csrf_token, so a cookie-only follow-up
 * still 403s on PHP (probed 2026-11-05) — persisting here would buy
 * nothing and would write a session row on every external API call.
 * Callers that need the token identity alone (the post-auth rate
 * limiter, whose subject PHP selects by route role — see
 * seam-call.ts) use the returned session as-is.
 */
export async function loginWithApiToken(
  ctx: CallContext,
  role: "admin" | "client",
  password: string,
): Promise<SessionInfo> {
  if (password === "") throw new FbError("Authentication Failed", 206);
  if (role === "client") {
    const rows = (await getDb()
      .prepare("SELECT id, api_token FROM client WHERE api_token IS NOT NULL AND status = 'active'")
      .all()) as unknown as { id: number; api_token: string | null }[];
    let match: { id: number } | undefined;
    for (const row of rows) {
      if (!match && typeof row.api_token === "string" && timingSafeTokenEqual(password, row.api_token)) {
        match = row;
      }
    }
    if (!match) throw new FbError("Authentication Failed", 204);
    const session: SessionInfo = {
      ...(ctx.session ?? { id: `token:client:${match.id}` }),
      client: { id: match.id },
    };
    ctx.session = session;
    return session;
  }
  const rows = (await getDb()
    .prepare(
      "SELECT id, email, name, api_token, system_name FROM admin WHERE api_token IS NOT NULL AND status = 'active'",
    )
    .all()) as unknown as {
    id: number;
    email: string;
    name: string | null;
    api_token: string | null;
    system_name: string | null;
  }[];
  let match: { id: number; email: string; name: string | null } | undefined;
  for (const row of rows) {
    // Cron admin (system_name 'cron') can never token-login (PHP
    // rejects isCron() and, separately, the cron-admin id).
    if (row.system_name === "cron") continue;
    if (!match && typeof row.api_token === "string" && timingSafeTokenEqual(password, row.api_token)) {
      match = row;
    }
  }
  if (!match) throw new FbError("Authentication Failed", 205);
  const session: SessionInfo = {
    ...(ctx.session ?? { id: `token:admin:${match.id}` }),
    admin: { id: match.id, email: match.email, name: match.name ?? undefined },
  };
  ctx.session = session;
  return session;
}
