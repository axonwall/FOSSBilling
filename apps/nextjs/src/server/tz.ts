// Timezone resolution + zone-calendar math for TS stats (Phase 5 R5d).
//
// PHP's chain (the truth): load.php:343 runs
// date_default_timezone_set(Config::getProperty('i18n.timezone', 'UTC'))
// on every request, so PHP stats buckets by the CONFIGURED zone's
// calendar days. TS stats previously used process-local midnights,
// which only matched while the process ran TZ=UTC.
//
// Resolution (R5-7): env override > config store `i18n.timezone` >
// UTC. The env name is `TZ` — the process standard, which Node's
// Intl already honors, and the container convention the scope's
// "env override exists for container-pinned processes" rationale
// points at. Only IANA names are honored (PHP's
// i18n.php::getTimezoneList is DateTimeZone::listIdentifiers()).
// An invalid/empty env value falls through to config (it is treated
// as unset, not as a hard error); an invalid/empty/non-string
// config value falls through to UTC. That matches PHP's EFFECTIVE
// date behavior: date_default_timezone_set() with an invalid ID
// returns false with a Notice and leaves the default (UTC) in
// place (proven against the reference PHP, 2026-10-29). PHP's
// dev-setup side effect — the Notice output breaking session
// headers — is deliberately NOT mirrored: stats must not 500 for
// a bad TZ string. A null config value would fatal PHP at load
// (TypeError); TS falls back to UTC instead, same reasoning.
//
// Freshness: resolved PER CALL (per stats request), never cached.
// The config store itself reads fresh every call (R5a), so a
// config edit takes effect on the next stats call with no restart.
// (Caveat on the PHP side, proven 2026-10-29: PHP's Config uses
// `include PATH_CONFIG`, and the PHP server runs OPcache with
// revalidate_freq=2s per worker — a config edit is NOT visible to
// all PHP workers immediately. Suites that flip config.php must
// wait past the window AND poll PHP until a TZ-sensitive read
// proves the new zone. TS has no such lag.)
//
// Zone math is Intl-based, no new dependency. All helpers take the
// zone explicitly and never touch the process default zone, so a
// process running TZ=UTC still buckets by config zone, and a
// process running TZ=<other> still honors the resolver's answer.
//
// DST semantics: day/month arithmetic is CALENDAR arithmetic in
// the zone (wall time preserved), matching PHP's strtotime('+1
// day') / modify('+1 month'), NOT 24h epoch stepping — a naive
// +24h step drifts a day across a DST transition. Ambiguous wall
// times (fall-back repeated hour) resolve to the FIRST occurrence
// (PHP's strtotime behavior); nonexistent wall times (spring-
// forward gap) resolve forward to the later instant (also PHP's
// behavior). Both are handled by the zonedTimeToUtc iteration
// below (converge, else take the latest guess).

import { getConfigProperty } from "./config-store";

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** R5-7 precedence: TZ env > config i18n.timezone > UTC. */
export function resolveZone(): string {
  const env = process.env.TZ;
  if (env && isValidZone(env)) return env;
  const cfg = getConfigProperty<string>("i18n.timezone", "UTC");
  if (typeof cfg === "string" && cfg !== "" && isValidZone(cfg)) return cfg;
  return "UTC";
}

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Calendar parts of an instant in the zone (hourCycle h23). */
export function zoneParts(tz: string, ms: number): ZoneParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** (Wall time read as UTC) minus instant = zone offset at instant. */
function zoneOffsetMs(tz: string, ms: number): number {
  const p = zoneParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * Wall time in the zone -> UTC instant. Iterates the offset because
 * the offset depends on the instant (DST). Converges except across
 * a spring-forward gap, where guesses oscillate between the two
 * sides; taking the latest guess then matches PHP's forward
 * normalization. Fall-back ambiguous times converge on the FIRST
 * occurrence, matching PHP's strtotime.
 */
export function zonedTimeToUtcMs(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wallAsUtc;
  let prev = Number.NaN;
  for (let i = 0; i < 4; i++) {
    const next = wallAsUtc - zoneOffsetMs(tz, guess);
    if (next === guess) return guess;
    prev = guess;
    guess = next;
  }
  // Oscillating (gap): forward normalization = latest guess.
  return Math.max(guess, prev);
}

/** Epoch ms of 00:00:00 in the zone on the zone-calendar date of ms. */
export function zoneMidnightMs(tz: string, ms: number): number {
  const p = zoneParts(tz, ms);
  return zonedTimeToUtcMs(tz, p.year, p.month, p.day, 0, 0, 0);
}

/** Epoch ms of 00:00:00 on the 1st of the zone-calendar month of ms. */
export function zoneMonthStartMs(tz: string, ms: number): number {
  const p = zoneParts(tz, ms);
  return zonedTimeToUtcMs(tz, p.year, p.month, 1, 0, 0, 0);
}

/** Add n calendar days in the zone, preserving wall time. */
export function addZoneDays(tz: string, ms: number, n: number): number {
  const p = zoneParts(tz, ms);
  const norm = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return zonedTimeToUtcMs(
    tz,
    norm.getUTCFullYear(),
    norm.getUTCMonth() + 1,
    norm.getUTCDate(),
    p.hour,
    p.minute,
    p.second,
  );
}

/** Add n calendar months in the zone, preserving wall time and day
 * (JS Date.UTC overflow semantics, same as the old setMonth code;
 * stats uses day-1 anchors, where no overflow can occur). */
export function addZoneMonths(tz: string, ms: number, n: number): number {
  const p = zoneParts(tz, ms);
  const norm = new Date(Date.UTC(p.year, p.month - 1 + n, p.day));
  return zonedTimeToUtcMs(
    tz,
    norm.getUTCFullYear(),
    norm.getUTCMonth() + 1,
    norm.getUTCDate(),
    p.hour,
    p.minute,
    p.second,
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" in the zone. */
export function formatZoneDate(tz: string, ms: number): string {
  const p = zoneParts(tz, ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DD HH:MM:SS" in the zone. */
export function formatZoneDateTime(tz: string, ms: number): string {
  const p = zoneParts(tz, ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/**
 * Parse a stats date input in the zone, mirroring PHP's strtotime:
 * "YYYY-MM-DD" -> zone midnight; "YYYY-MM-DD HH:MM:SS" (or T
 * separator) -> that wall time in the zone. Returns null for
 * anything else (caller falls back to Date.parse / epoch 0).
 */
export function parseZoneDateTime(tz: string, value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return null;
  return zonedTimeToUtcMs(
    tz,
    parseInt(m[1], 10),
    parseInt(m[2], 10),
    parseInt(m[3], 10),
    m[4] ? parseInt(m[4], 10) : 0,
    m[5] ? parseInt(m[5], 10) : 0,
    m[6] ? parseInt(m[6], 10) : 0,
  );
}
