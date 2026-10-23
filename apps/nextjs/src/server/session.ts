import { findSession } from "./db";
import { parseSessionContent } from "./php-serialize";

/**
 * PHP-session authentication for TS-ported modules.
 *
 * FOSSBilling sessions are rows in the `session` table whose `content`
 * is Symfony-serialized data; the `_sf2_attributes` bag carries
 * `csrf_token` plus an `admin` and/or `client` identity array
 * ({id, email, name}). Both identities can live in one session — the
 * same model the PHP dispatcher uses. Verified against live rows in
 * Phase 2 recon.
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
    }
  }
  return info;
}
