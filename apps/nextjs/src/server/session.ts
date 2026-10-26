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

export function readSession(cookieHeader: string | null): SessionInfo | null {
  const sid = cookieValue(cookieHeader, "fossbilling_session");
  if (!sid) return null;
  const row = findSession(sid);
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
export function loginAsAdmin(ctx: CallContext, admin: Identity): SessionInfo {
  const old = ctx.session;
  const attrs: Record<string, string | number | Record<string, string | number | null>> = {};
  if (old?.csrfToken) attrs["csrf_token"] = old.csrfToken;
  attrs["admin"] = { id: admin.id, email: admin.email ?? null, name: admin.name ?? null };
  const id = randomBytes(16).toString("hex");
  const empty = phpSerialize({});
  const content = `_sf2_attributes|${phpSerialize(attrs)}_symfony_flashes|${empty}_sf2_meta|${empty}`;
  insertSession(id, content, Math.floor(Date.now() / 1000) + 86400);
  // Deliberately no deleteSessionRow(old.id): PHP leaves the old row.
  ctx.setCookies.push(`fossbilling_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  ctx.session = { id, csrfToken: old?.csrfToken, admin: { id: admin.id, email: admin.email, name: admin.name } };
  return ctx.session;
}
export function ensureSession(ctx: CallContext): SessionInfo {
  if (ctx.session) return ctx.session;
  const id = randomBytes(16).toString("hex");
  const empty = phpSerialize({});
  const content = `_sf2_attributes|${empty}_symfony_flashes|${empty}_sf2_meta|${empty}`;
  insertSession(id, content, Math.floor(Date.now() / 1000) + 86400);
  ctx.setCookies.push(`fossbilling_session=${id}; Path=/; HttpOnly; SameSite=Lax`);
  ctx.session = { id };
  return ctx.session;
}
