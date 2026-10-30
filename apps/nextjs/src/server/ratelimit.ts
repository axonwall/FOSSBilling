import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { FbError } from "./dispatch";
import { getDb, getDbWrite } from "./db";
import { getConfigProperty, phpNormalizeBoolean } from "./config-store";

/**
 * TS rate limiter (Phase 5 R5g) — port of
 * src/library/FOSSBilling/Security/RateLimiter.php + the enforcement
 * structure of src/modules/Api/Controller/Client.php `_apiCall`.
 *
 * PHP backend is a Symfony CacheStorage over the `rate_limit_cache`
 * pool (FilesystemAdapter under data/cache/rate_limit_* by default,
 * CacheFactory.php NAMESPACE_RATE_LIMIT = 'rate_limit', di.php:274).
 * The TS backend is DELIBERATELY different: DB-backed counters in the
 * shared database (table `rate_limit_counter`, created lazily via
 * CREATE TABLE IF NOT EXISTS on first limiter use — never a migration
 * that rewrites the reference schema, never a change to existing
 * tables). Rationale: the shared DB is the only store that survives
 * restarts AND shares across Next instances without new
 * infrastructure (in-memory fails both; file-backed would duplicate
 * PHP's cache-dir coupling and need locking the DB already provides).
 * This table is a TS-only schema addition, listed explicitly as an
 * installer delta (R5j scope).
 *
 * Policy table: the FULL 31-policy default table from
 * RateLimiter.php getDefaultConfig() (lines ~57-90), transcribed
 * verbatim below (name, policy type, limit, interval). Config:
 * config.php `rate_limiter` merged over these defaults with
 * array_replace_recursive semantics (objects merge per key; an empty
 * `policies` array does NOT remove defaults — the reference config
 * ships `'policies' => []` and still enforces all 31).
 *
 * Subjects are HMAC-SHA256 hashed with key order info.salt ->
 * info.instance_id -> literal 'fossbilling-rate-limiter'
 * (RateLimiter.php getHashKey), over lower(trim(subject)). The raw
 * subject is stored ONLY when it is an IP address (subject_display),
 * because PHP's admin list/reset surface is IP-keyed (the ip index);
 * account/email/hash subjects are stored hashed-only, exactly as
 * PHP stores only hashes in its cache keys.
 *
 * Counter semantics, mirroring Symfony's FixedWindowLimiter /
 * TokenBucketLimiter (vendor/symfony/rate-limiter/Policy/):
 * - Fixed window: the window starts at the FIRST consume (timer =
 *   first-call time, NOT calendar-aligned). N calls pass; the (N+1)th
 *   trips. Rejected consumes still increment the hit count (debt,
 *   carried across window rolls in whole-window multiples), so
 *   retry_after extends only after 2N hits — the Symfony
 *   calculateTimeForTokens formula, reproduced here.
 * - Token bucket: the bucket starts FULL (limit tokens) and refills
 *   in WHOLESALE batches — floor(elapsed / interval) * limit tokens
 *   (Rate::calculateNewTokensDuringInterval), NOT continuously: for
 *   api_guest 100/60s nothing refills until a full 60s elapse, then
 *   the bucket refills to full. The bucket timer advances by whole
 *   intervals only, so its phase is anchored at bucket creation
 *   (unlike the fixed window, whose timer jumps to the rollover call
 *   time). N calls drain it; the (N+1)th trips. Rejected consumes
 *   drive the token balance negative (debt), so refills pay the debt
 *   first. Retry-after for a bucket is whole cycles:
 *   ceil(needed / limit) * interval — for an ordinary trip that is
 *   ONE full interval (e.g. 60s for api_guest, 3600s for
 *   api_authenticated_*), even though the next token would
 *   conceptually arrive sooner; that is Symfony's
 *   Rate::calculateTimeForTokens arithmetic, reproduced here.
 * - Zero-token probes never consume; limited iff remaining < 1
 *   (RateLimiter.php consume(), tokens === 0 branch).
 * - Failed-auth attempts DO count: PHP's pre-auth IP check runs
 *   before session/token auth and its post-auth login check runs
 *   before the login body validates credentials (Client.php
 *   _apiCall order), so a wrong password still consumes api_login.
 *
 * Concurrency: consumes are serialized per-process through a promise
 * mutex and run inside a DB transaction, so a counter increment is
 * atomic within one Next instance. Two Next instances sharing one DB
 * can race a single increment under exact simultaneity (documented
 * limitation; parity runs are sequential, so it cannot affect them).
 *
 * Rendering (settled from code, NOT habit — R5 scope §6 open
 * question 1): Client.php tryCall catches every exception and
 * renderJson()s it through ApiResponseFactory, whose error() sets
 * HTTP status from the exception code (429 in the 400-599 range maps
 * to itself) AND sets a `Retry-After` header in whole SECONDS (not an
 * HTTP-date) when the exception is a RateLimitException with a retry
 * time. The envelope body carries NO retry field. The TS mirror is
 * therefore a REAL HTTP 429 + `Retry-After: <seconds>` header + the
 * same envelope body — NOT a 200-envelope. The seam route converts
 * RateLimitError to that response; every other FbError keeps the
 * seam's HTTP-200 envelope convention.
 *
 * Dev bypass (PHP: RateLimiter.php isEnabled()): enabled === false
 * (strict boolean false only) -> off; else APP_ENV === 'dev' without
 * enforce_in_development === true (strict boolean true only) -> off.
 * TS ADAPTATION: an UNSET APP_ENV also counts as development. PHP
 * resolves unset APP_ENV to production, but the Next seam in the
 * harness runs with no APP_ENV set; treating unset as production
 * would throttle the dev harness — the exact outcome the bypass
 * exists to prevent. Explicit APP_ENV=prod (or test) enforces.
 * Force flag FB_RATE_LIMIT_ENFORCE (env, truthy per
 * phpNormalizeBoolean: 1/true/on/yes, default unset -> not forced)
 * forces enforcement even in dev, and is what parity runs use — a
 * limiter case on a dev-default server proves nothing (R2e lesson).
 */

export class RateLimitError extends FbError {
  constructor(
    readonly retryAfterSeconds: number,
  ) {
    super("Rate limit exceeded. Please try again later.", 429);
  }
}

export interface RateLimitOutcome {
  policy: string;
  limited: boolean;
  limit: number | null;
  remaining: number | null;
  retryAfterSeconds: number;
}

interface PolicyDef {
  policy: "token_bucket" | "fixed_window";
  limit: number;
  intervalSeconds: number;
}

/** Transcribed from RateLimiter.php getDefaultConfig(). */
export const DEFAULT_POLICIES: Record<string, PolicyDef> = {
  api_guest: { policy: "token_bucket", limit: 100, intervalSeconds: 60 },
  api_authenticated_ip: { policy: "token_bucket", limit: 1000, intervalSeconds: 3600 },
  api_authenticated_account: { policy: "token_bucket", limit: 1000, intervalSeconds: 3600 },
  api_login: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  client_password_reset_ip: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  client_password_reset_email: { policy: "fixed_window", limit: 3, intervalSeconds: 3600 },
  client_password_reset_confirm_ip: { policy: "fixed_window", limit: 20, intervalSeconds: 60 },
  client_password_reset_confirm_post_ip: { policy: "fixed_window", limit: 20, intervalSeconds: 60 },
  client_email_confirm_ip: { policy: "fixed_window", limit: 20, intervalSeconds: 60 },
  staff_password_reset_ip: { policy: "fixed_window", limit: 5, intervalSeconds: 3600 },
  staff_password_reset_email: { policy: "fixed_window", limit: 3, intervalSeconds: 3600 },
  staff_password_reset_confirm_ip: { policy: "fixed_window", limit: 20, intervalSeconds: 60 },
  staff_password_reset_confirm_post_ip: { policy: "fixed_window", limit: 20, intervalSeconds: 60 },
  client_signup: { policy: "fixed_window", limit: 5, intervalSeconds: 3600 },
  client_signup_email: { policy: "fixed_window", limit: 5, intervalSeconds: 3600 },
  guest_ticket_create: { policy: "fixed_window", limit: 3, intervalSeconds: 3600 },
  order_generation_ip: { policy: "fixed_window", limit: 15, intervalSeconds: 3600 },
  domain_lookup_ip: { policy: "fixed_window", limit: 60, intervalSeconds: 3600 },
  invoice_payment_ip: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  invoice_payment_hash: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  invoice_pdf_ip: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  invoice_pdf_hash: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  invoice_get_ip: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  invoice_get_hash: { policy: "fixed_window", limit: 30, intervalSeconds: 3600 },
  cart_promo_apply_ip: { policy: "fixed_window", limit: 10, intervalSeconds: 3600 },
  client_email_verification_resend_ip: { policy: "fixed_window", limit: 30, intervalSeconds: 3600 },
  client_email_verification_resend_account: { policy: "fixed_window", limit: 3, intervalSeconds: 3600 },
  client_email_resend_ip: { policy: "fixed_window", limit: 30, intervalSeconds: 3600 },
  client_email_resend_account: { policy: "fixed_window", limit: 5, intervalSeconds: 3600 },
  profile_password_change_ip: { policy: "fixed_window", limit: 30, intervalSeconds: 3600 },
  profile_password_change_account: { policy: "fixed_window", limit: 5, intervalSeconds: 3600 },
};

export const RATE_LIMIT_TABLE = "rate_limit_counter";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${RATE_LIMIT_TABLE} (` +
  `policy TEXT NOT NULL, subject_hash TEXT NOT NULL, subject_display TEXT, ` +
  `window_start_ms REAL NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, ` +
  `tokens REAL NOT NULL DEFAULT 0, updated_ms REAL NOT NULL DEFAULT 0, ` +
  `PRIMARY KEY (policy, subject_hash))`;

type RawConfig = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** array_replace_recursive for plain objects; arrays replace wholesale. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isObject(base) && isObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(override)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return override === undefined ? base : override;
}

function parseIntervalSeconds(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d+)\s*(seconds?|minutes?|hours?|days?)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      if (unit.startsWith("second")) return n;
      if (unit.startsWith("minute")) return n * 60;
      if (unit.startsWith("hour")) return n * 3600;
      if (unit.startsWith("day")) return n * 86400;
    }
  }
  return fallback;
}

export interface LimiterConfig {
  enabled: boolean;
  enforceInDevelopment: boolean;
  whitelistIps: string[];
  policies: Record<string, PolicyDef>;
}

export function loadLimiterConfig(): LimiterConfig {
  const raw = getConfigProperty<RawConfig>("rate_limiter", {});
  const merged = (isObject(raw) ? deepMerge(
    {
      enabled: true,
      enforce_in_development: false,
      whitelist_ips: [],
      policies: Object.fromEntries(
        Object.entries(DEFAULT_POLICIES).map(([name, p]) => [
          name,
          {
            policy: p.policy,
            limit: p.limit,
            interval: p.intervalSeconds >= 3600 ? "1 hour" : "60 seconds",
          },
        ]),
      ),
    },
    raw,
  ) : {}) as RawConfig;
  const policies: Record<string, PolicyDef> = {};
  const rawPolicies = isObject(merged["policies"]) ? merged["policies"] : {};
  for (const [name, def] of Object.entries(DEFAULT_POLICIES)) {
    const over = isObject(rawPolicies[name]) ? rawPolicies[name] : {};
    const policy = over["policy"] === "fixed_window" || over["policy"] === "token_bucket"
      ? over["policy"]
      : def.policy;
    const limit = typeof over["limit"] === "number" && over["limit"] > 0
      ? Math.floor(over["limit"])
      : def.limit;
    policies[name] = {
      policy,
      limit,
      intervalSeconds: parseIntervalSeconds(over["interval"], def.intervalSeconds),
    };
  }
  // Config-only policies (not in defaults) are honored with the same
  // parsing, mirroring PHP's merged-config lookup.
  for (const [name, over] of Object.entries(rawPolicies)) {
    if (policies[name] || !isObject(over)) continue;
    const limit = typeof over["limit"] === "number" && over["limit"] > 0 ? Math.floor(over["limit"]) : 60;
    policies[name] = {
      policy: over["policy"] === "fixed_window" ? "fixed_window" : "token_bucket",
      limit,
      intervalSeconds: parseIntervalSeconds(over["interval"], 60),
    };
  }
  return {
    // PHP strictness: only boolean false disables, only boolean true opts in.
    enabled: merged["enabled"] !== false,
    enforceInDevelopment: merged["enforce_in_development"] === true,
    whitelistIps: Array.isArray(merged["whitelist_ips"])
      ? (merged["whitelist_ips"] as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    policies,
  };
}

/** TS dev condition: APP_ENV=dev OR unset/empty (adaptation, see header). */
export function isDevelopmentServer(): boolean {
  const env = process.env.APP_ENV;
  return env === undefined || env === "" || env === "dev";
}

/**
 * FB_RATE_LIMIT_ENFORCE: the env force flag. Truthy per
 * phpNormalizeBoolean (1/true/on/yes, case-insensitive); default
 * unset -> not forced. Forces enforcement even on a dev server.
 */
export function isForceEnforced(): boolean {
  return phpNormalizeBoolean(process.env.FB_RATE_LIMIT_ENFORCE, false);
}

export function isLimiterEnabled(cfg?: LimiterConfig): boolean {
  const c = cfg ?? loadLimiterConfig();
  if (!c.enabled) return false;
  if (isDevelopmentServer() && !c.enforceInDevelopment && !isForceEnforced()) return false;
  return true;
}

function hashKey(): string {
  return process.env.FB_INFO_SALT
    ?? process.env.FB_CALLBACK_SALT
    ?? (getConfigProperty<string | null>("info.salt", null) as string | null)
    ?? (getConfigProperty<string | null>("info.instance_id", null) as string | null)
    ?? "fossbilling-rate-limiter";
}

export function hashSubject(subject: string): string {
  return createHmac("sha256", hashKey()).update(subject.toLowerCase().trim()).digest("hex");
}

function ipToBigInt(ip: string): bigint | null {
  if (isIP(ip) === 4) {
    return ip.split(".").reduce((acc, part) => (acc << 8n) + BigInt(parseInt(part, 10)), 0n);
  }
  if (isIP(ip) === 6) {
    // Expand :: compression, then accumulate 16-bit groups.
    const [head, tail] = ip.split("::");
    const headParts = head ? head.split(":").filter(Boolean) : [];
    const tailParts = tail !== undefined && tail !== "" ? tail.split(":").filter(Boolean) : [];
    const missing = 8 - headParts.length - tailParts.length;
    const parts = [...headParts, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...tailParts];
    if (parts.length !== 8) return null;
    return parts.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part, 16)), 0n);
  }
  return null;
}

function cidrContains(cidr: string, ip: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) return false;
  const base = cidr.slice(0, slash);
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isFinite(bits) || bits < 0) return false;
  const baseNum = ipToBigInt(base);
  const ipNum = ipToBigInt(ip);
  if (baseNum === null || ipNum === null) return false;
  const total = isIP(ip) === 4 ? 32 : 128;
  if (bits > total) return false;
  const mask = total === bits ? (1n << BigInt(total)) - 1n : (((1n << BigInt(bits)) - 1n) << BigInt(total - bits));
  return (baseNum & mask) === (ipNum & mask);
}

/** PHP IpUtils::checkIp: exact match or CIDR (range form unsupported). */
export function isWhitelistedIp(ip: string, whitelist: string[]): boolean {
  if (!ip) return false;
  for (const entry of whitelist) {
    if (entry.includes("/")) {
      if (cidrContains(entry, ip)) return true;
    } else if (entry === ip) {
      return true;
    }
  }
  return false;
}

interface CounterRow {
  policy: string;
  subject_hash: string;
  subject_display: string | null;
  window_start_ms: number;
  count: number;
  tokens: number;
  updated_ms: number;
}

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await getDbWrite().exec(CREATE_TABLE_SQL);
  tableReady = true;
}

/** In-process serialization for counter increments (see header). */
let mutex: Promise<unknown> = Promise.resolve();
function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function policyOrThrow(cfg: LimiterConfig, name: string): PolicyDef {
  const p = cfg.policies[name];
  if (!p) throw new FbError(`Rate limiter policy ${name} is not defined or invalid`);
  return p;
}

/** Effective fixed-window count after whole-window rollover (no write). */
function effectiveCount(row: CounterRow | undefined, def: PolicyDef, nowMs: number): { count: number; windowStartMs: number } {
  if (!row || row.window_start_ms <= 0) return { count: 0, windowStartMs: nowMs };
  const elapsed = (nowMs - row.window_start_ms) / 1000;
  if (elapsed <= def.intervalSeconds) return { count: row.count, windowStartMs: row.window_start_ms };
  const windows = Math.floor(elapsed / def.intervalSeconds);
  return { count: Math.max(0, row.count - windows * def.limit), windowStartMs: nowMs };
}

/**
 * Token-bucket availability, mirroring TokenBucket::getAvailableTokens:
 * integer tokens, wholesale refill of `limit` tokens per whole elapsed
 * interval, timer advanced by whole intervals only. For bucket rows,
 * updated_ms IS the bucket timer (not a last-seen stamp); for fixed
 * rows it is the last-consume time. No write here (probes must not
 * persist the timer advance — Symfony saves only on tokens !== 0).
 */
function bucketAvailable(row: CounterRow | undefined, def: PolicyDef, nowMs: number): { available: number; timerMs: number } {
  if (!row || row.updated_ms <= 0) return { available: def.limit, timerMs: nowMs };
  const elapsedSec = Math.max(0, (nowMs - row.updated_ms) / 1000);
  const cycles = Math.floor(elapsedSec / def.intervalSeconds);
  const timerMs = row.updated_ms + cycles * def.intervalSeconds * 1000;
  return { available: Math.min(def.limit, row.tokens + cycles * def.limit), timerMs };
}

function fixedRetryAfter(countBeforeAdd: number, def: PolicyDef, windowStartMs: number, nowMs: number): number {
  // Symfony Window::calculateTimeForTokens(1, now), hitCount pre-add
  // (rejected and probe paths).
  const inWindow = Math.ceil((countBeforeAdd + 1) / def.limit) - 1;
  return Math.max(0, Math.ceil((windowStartMs + def.intervalSeconds * 1000 * inWindow - nowMs) / 1000));
}

function fixedRetryAfterPostAdd(countAfterAdd: number, def: PolicyDef, windowStartMs: number, nowMs: number): number {
  // Accepted-and-drained path: calculateTimeForTokens uses the
  // post-add hitCount.
  const inWindow = Math.ceil((countAfterAdd + 1) / def.limit) - 1;
  return Math.max(0, Math.ceil((windowStartMs + def.intervalSeconds * 1000 * inWindow - nowMs) / 1000));
}

/** Bucket retry: whole cycles of `interval` (see header). */
function bucketRetryAfter(availableBefore: number, def: PolicyDef): number {
  const cycles = Math.ceil((1 - availableBefore) / def.limit);
  return Math.max(0, cycles * def.intervalSeconds);
}

function disabledOutcome(policy: string): RateLimitOutcome {
  return { policy, limited: false, limit: null, remaining: null, retryAfterSeconds: 0 };
}

export interface ConsumeOptions {
  /** Request IP for the whitelist check (PHP checks the REQUEST ip, not the subject). */
  requestIp: string;
}

/**
 * Mirror of RateLimiter::consume(). tokens = 0 probes without consuming.
 * Disabled/whitelisted -> not limited, null limit/remaining (PHP shape).
 */
export async function consume(
  policyName: string,
  subject: string,
  opts: ConsumeOptions,
  tokens = 1,
): Promise<RateLimitOutcome> {
  const cfg = loadLimiterConfig();
  if (!isLimiterEnabled(cfg)) return disabledOutcome(policyName);
  const def = policyOrThrow(cfg, policyName);
  if (opts.requestIp && isWhitelistedIp(opts.requestIp, cfg.whitelistIps)) {
    return { policy: policyName, limited: false, limit: null, remaining: null, retryAfterSeconds: 0 };
  }
  const subjectHash = hashSubject(subject);
  const display = isIP(subject) !== 0 ? subject : null;
  await ensureTable();
  if (tokens === 0) {
    const row = await getDb().prepare(
      `SELECT * FROM ${RATE_LIMIT_TABLE} WHERE policy = ? AND subject_hash = ?`,
    ).get(policyName, subjectHash) as CounterRow | undefined;
    const nowMs = Date.now();
    if (def.policy === "fixed_window") {
      const { count } = effectiveCount(row, def, nowMs);
      const remaining = Math.max(0, def.limit - count);
      return {
        policy: policyName,
        limited: remaining < 1,
        limit: def.limit,
        remaining,
        retryAfterSeconds: remaining < 1
          ? fixedRetryAfter(count, def, row?.window_start_ms ?? nowMs, nowMs)
          : 0,
      };
    }
    const { available } = bucketAvailable(row, def, nowMs);
    const remaining = Math.max(0, available);
    return {
      policy: policyName,
      limited: remaining < 1,
      limit: def.limit,
      remaining,
      retryAfterSeconds: remaining < 1 ? bucketRetryAfter(available, def) : 0,
    };
  }
  return withMutex(async () => {
    const nowMs = Date.now();
    return getDbWrite().withTransaction(async (tx) => {
      const row = await tx.prepare(
        `SELECT * FROM ${RATE_LIMIT_TABLE} WHERE policy = ? AND subject_hash = ?`,
      ).get(policyName, subjectHash) as CounterRow | undefined;
      if (def.policy === "fixed_window") {
        const { count: effCount, windowStartMs } = effectiveCount(row, def, nowMs);
        if (effCount >= def.limit) {
          // Rejected: debt increment, Symfony-style retry_after.
          const retry = fixedRetryAfter(effCount, def, windowStartMs, nowMs);
          await tx.prepare(
            `INSERT INTO ${RATE_LIMIT_TABLE} (policy, subject_hash, subject_display, window_start_ms, count, tokens, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ` +
            `ON CONFLICT(policy, subject_hash) DO UPDATE SET subject_display = excluded.subject_display, window_start_ms = excluded.window_start_ms, count = excluded.count, updated_ms = excluded.updated_ms`,
          ).run(policyName, subjectHash, display, windowStartMs, effCount + 1, 0, nowMs);
          return { policy: policyName, limited: true, limit: def.limit, remaining: 0, retryAfterSeconds: retry };
        }
        const newCount = effCount + 1;
        const drained = newCount === def.limit;
        await tx.prepare(
          `INSERT INTO ${RATE_LIMIT_TABLE} (policy, subject_hash, subject_display, window_start_ms, count, tokens, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT(policy, subject_hash) DO UPDATE SET subject_display = excluded.subject_display, window_start_ms = excluded.window_start_ms, count = excluded.count, updated_ms = excluded.updated_ms`,
        ).run(policyName, subjectHash, display, windowStartMs, newCount, 0, nowMs);
        return {
          policy: policyName,
          limited: false,
          limit: def.limit,
          remaining: def.limit - newCount,
          retryAfterSeconds: drained ? fixedRetryAfterPostAdd(newCount, def, windowStartMs, nowMs) : 0,
        };
      }
      // Token bucket (integer tokens, wholesale refill).
      const { available, timerMs } = bucketAvailable(row, def, nowMs);
      if (available >= 1) {
        const newTokens = available - 1;
        await tx.prepare(
          `INSERT INTO ${RATE_LIMIT_TABLE} (policy, subject_hash, subject_display, window_start_ms, count, tokens, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT(policy, subject_hash) DO UPDATE SET subject_display = excluded.subject_display, tokens = excluded.tokens, updated_ms = excluded.updated_ms`,
        ).run(policyName, subjectHash, display, 0, 0, newTokens, timerMs);
        return {
          policy: policyName,
          limited: false,
          limit: def.limit,
          remaining: newTokens,
          retryAfterSeconds: available === 1 ? def.intervalSeconds : 0,
        };
      }
      const newTokens = available - 1;
      await tx.prepare(
        `INSERT INTO ${RATE_LIMIT_TABLE} (policy, subject_hash, subject_display, window_start_ms, count, tokens, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT(policy, subject_hash) DO UPDATE SET subject_display = excluded.subject_display, tokens = excluded.tokens, updated_ms = excluded.updated_ms`,
      ).run(policyName, subjectHash, display, 0, 0, newTokens, timerMs);
      return {
        policy: policyName,
        limited: true,
        limit: def.limit,
        remaining: 0,
        retryAfterSeconds: bucketRetryAfter(available, def),
      };
    });
  });
}

/** Mirror of RateLimiter::consumeOrThrow(). */
export async function consumeOrThrow(
  policyName: string,
  subject: string,
  opts: ConsumeOptions,
  tokens = 1,
): Promise<RateLimitOutcome> {
  const result = await consume(policyName, subject, opts, tokens);
  if (result.limited) throw new RateLimitError(result.retryAfterSeconds);
  return result;
}

export interface IpCounter {
  policy: string;
  ip: string;
  last_seen: string;
  limit: number;
  remaining: number;
  limited: boolean;
  retry_after: string | null;
  retry_after_seconds: number;
}

function toAtom(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/**
 * Mirror of RateLimiter::listIpCounters(): only currently-limited IP
 * entries, sorted by [ip, policy]. Counter rows themselves are NOT
 * pruned here (PHP prunes its ip INDEX, but TS counters must persist
 * for window continuity — the index-vs-counter distinction is inherent
 * to the DB-backed adaptation).
 */
export async function listIpCounters(ip: string | null): Promise<IpCounter[]> {
  if (ip !== null && isIP(ip) === 0) {
    throw new FbError("The provided input was not a valid IP address.");
  }
  await ensureTable();
  const cfg = loadLimiterConfig();
  const stmt = ip === null
    ? getDb().prepare(`SELECT * FROM ${RATE_LIMIT_TABLE} WHERE subject_display IS NOT NULL`)
    : getDb().prepare(`SELECT * FROM ${RATE_LIMIT_TABLE} WHERE subject_display = ?`);
  const rows = (ip === null ? await stmt.all() : await stmt.all(ip)) as unknown as CounterRow[];
  const nowMs = Date.now();
  const out: IpCounter[] = [];
  for (const row of rows) {
    const def = cfg.policies[row.policy];
    if (!def) continue;
    let remaining: number;
    let retry = 0;
    if (def.policy === "fixed_window") {
      const { count, windowStartMs } = effectiveCount(row, def, nowMs);
      remaining = Math.max(0, def.limit - count);
      if (remaining < 1) retry = fixedRetryAfter(count, def, windowStartMs, nowMs);
    } else {
      const { available } = bucketAvailable(row, def, nowMs);
      remaining = Math.max(0, available);
      if (remaining < 1) retry = bucketRetryAfter(available, def);
    }
    if (remaining >= 1) continue;
    out.push({
      policy: row.policy,
      ip: row.subject_display as string,
      last_seen: toAtom(row.updated_ms),
      limit: def.limit,
      remaining,
      limited: true,
      retry_after: retry > 0 ? toAtom(nowMs + retry * 1000) : null,
      retry_after_seconds: retry,
    });
  }
  out.sort((a, b) => (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : a.policy < b.policy ? -1 : a.policy > b.policy ? 1 : 0));
  return out;
}

/**
 * Mirror of RateLimiter::resetIp(): resets every policy counter keyed
 * by the IP string, returns the number of INDEX entries removed — i.e.
 * the currently-limited ones (PHP counts index entries, not raw
 * counters). All rows for the IP are deleted either way.
 */
export async function resetIp(ip: string, policyName: string | null): Promise<number> {
  if (isIP(ip) === 0) throw new FbError("The provided input was not a valid IP address.");
  await ensureTable();
  const before = await listIpCounters(ip);
  const removed = before.filter((c) => policyName === null || c.policy === policyName).length;
  const hash = hashSubject(ip);
  if (policyName === null) {
    await getDbWrite().prepare(
      `DELETE FROM ${RATE_LIMIT_TABLE} WHERE subject_display = ? OR subject_hash = ?`,
    ).run(ip, hash);
  } else {
    await getDbWrite().prepare(
      `DELETE FROM ${RATE_LIMIT_TABLE} WHERE policy = ? AND (subject_display = ? OR subject_hash = ?)`,
    ).run(policyName, ip, hash);
  }
  return removed;
}

/** Mirror of RateLimiter::resetAll(): clears every counter. */
export async function resetAll(): Promise<boolean> {
  await ensureTable();
  await getDbWrite().exec(`DELETE FROM ${RATE_LIMIT_TABLE}`);
  return true;
}

/** Raw counter rows (parity introspection only — not an admin surface). */
export async function readCounterRows(): Promise<CounterRow[]> {
  await ensureTable();
  return (await getDb().prepare(`SELECT * FROM ${RATE_LIMIT_TABLE}`).all()) as unknown as CounterRow[];
}

/** Delete every counter row (parity cleanup only). */
export async function clearAllCounters(): Promise<void> {
  await ensureTable();
  await getDbWrite().exec(`DELETE FROM ${RATE_LIMIT_TABLE}`);
}

/* ------------------------------------------------------------------ */
/* Seam enforcement — mirrors Client.php _apiCall order.              */
/*                                                                    */
/* PHP order: allowedIps -> referer -> roleAllowed -> PRE-AUTH check  */
/* (non-guest only, IP subject) -> session/token auth -> update-      */
/* finalization -> POST-AUTH check (guest: post-auth only) -> guest   */
/* auth -> dispatcher (RequiredParams, permissions) -> method body    */
/* (per-endpoint consumes, mostly first in body).                     */
/*                                                                    */
/* TS order in the seam route: pre-auth check BEFORE CSRF (matching   */
/* PHP's pre-auth-before-CSRF), then CSRF, then the identity half of  */
/* the dispatcher gates (201 when the role has no session — PHP's     */
/* post-auth check runs only after successful auth, so an             */
/* unauthenticated non-guest caller must 201, never 429), then the    */
/* post-auth check, then the full dispatcher gates, then per-endpoint */
/* consumes, then the handler. Two documented order divergences:      */
/* (1) TS CSRF precedes the GUEST post-auth check while PHP's guest-  */
/* auth CSRF follows it — a CSRF-invalid guest call consumes in PHP   */
/* but not in TS; (2) TS per-endpoint consumes precede handler        */
/* validation, while a few PHP bodies validate first (support ticket */
/* content length, profile password-match) — a call that is BOTH      */
/* invalid AND limited gets 429 from TS but the validation error     */
/* from PHP. Both are precedence-only; the counted policies,          */
/* subjects, and boundary behavior are identical.                     */
/*                                                                    */
/* methodKey is PHP's $method: class_method, e.g. 'client_login' for  */
/* guest/client/login and 'staff_login' for guest/staff/login.        */
/* ------------------------------------------------------------------ */

export interface SeamIdentity {
  ip: string;
  session: { admin?: { id: number }; client?: { id: number } } | null;
  params: Record<string, string>;
}

function isLoginMethod(methodKey: string): boolean {
  return methodKey === "staff_login" || methodKey === "client_login";
}

/** Pre-auth generic check: non-guest roles only, IP subject. */
export async function enforcePreAuthLimit(role: string, methodKey: string, ctx: SeamIdentity): Promise<void> {
  if (role === "guest") return;
  const policy = isLoginMethod(methodKey) && role !== "admin" ? "api_login" : "api_authenticated_ip";
  await consumeOrThrow(policy, ctx.ip, { requestIp: ctx.ip });
}

/** Post-auth generic check: guest gets post-auth only; others need a session. */
export async function enforcePostAuthLimit(role: string, methodKey: string, ctx: SeamIdentity): Promise<void> {
  if (role === "guest") {
    const policy = isLoginMethod(methodKey) ? "api_login" : "api_guest";
    await consumeOrThrow(policy, ctx.ip, { requestIp: ctx.ip });
    return;
  }
  if (!ctx.session) return; // Identity gate 201s below; PHP never reaches post-auth unauthenticated.
  if (isLoginMethod(methodKey) && role !== "admin") {
    await consumeOrThrow("api_login", ctx.ip, { requestIp: ctx.ip });
    return;
  }
  if (ctx.session.client) {
    await consumeOrThrow("api_authenticated_account", `client:${ctx.session.client.id}`, { requestIp: ctx.ip });
  } else if (ctx.session.admin) {
    await consumeOrThrow("api_authenticated_account", `admin:${ctx.session.admin.id}`, { requestIp: ctx.ip });
  }
}

type EndpointPolicy = { policy: string; subject: (ctx: SeamIdentity) => string | null };

/**
 * Per-endpoint consumes, transcribed from the PHP Api method bodies
 * (consumeOrThrow sites only; the silent-return password-reset request
 * paths and the signup-email probe flow are wired in-handler — see
 * client.ts / staff.ts — because they return true instead of 429).
 * Page-level policies (client_email_confirm_ip,
 * client_password_reset_confirm_ip, staff_password_reset_confirm_ip)
 * are web-controller checks with no API equivalent and are NOT
 * enforced here; their API post variants ARE (…_post_ip rows above).
 */
const PER_ENDPOINT: Record<string, EndpointPolicy[]> = {
  "guest/client/update_password": [{ policy: "client_password_reset_confirm_post_ip", subject: (c) => c.ip }],
  "guest/staff/update_password": [{ policy: "staff_password_reset_confirm_post_ip", subject: (c) => c.ip }],
  "guest/support/ticket_create": [{ policy: "guest_ticket_create", subject: (c) => c.ip }],
  "guest/servicedomain/check": [{ policy: "domain_lookup_ip", subject: (c) => c.ip }],
  "guest/servicedomain/can_be_transferred": [{ policy: "domain_lookup_ip", subject: (c) => c.ip }],
  "guest/invoice/get": [
    { policy: "invoice_get_ip", subject: (c) => c.ip },
    { policy: "invoice_get_hash", subject: (c) => c.params["hash"] ?? null },
  ],
  "guest/invoice/payment": [
    { policy: "invoice_payment_ip", subject: (c) => c.ip },
    { policy: "invoice_payment_hash", subject: (c) => c.params["hash"] ?? null },
  ],
  "guest/invoice/pdf": [
    { policy: "invoice_pdf_ip", subject: (c) => c.ip },
    { policy: "invoice_pdf_hash", subject: (c) => c.params["hash"] ?? null },
  ],
  "guest/cart/apply_promo": [{ policy: "cart_promo_apply_ip", subject: (c) => c.ip }],
  "client/cart/checkout": [{ policy: "order_generation_ip", subject: (c) => c.ip }],
  "client/email/resend": [
    { policy: "client_email_resend_ip", subject: (c) => c.ip },
    { policy: "client_email_resend_account", subject: (c) => (c.session?.client ? `client:${c.session.client.id}` : null) },
  ],
  "guest/client/create": [{ policy: "client_signup", subject: (c) => c.ip }],
};

export async function enforcePerEndpointLimit(role: string, module: string, method: string, ctx: SeamIdentity): Promise<void> {
  const entries = PER_ENDPOINT[`${role}/${module}/${method}`];
  if (!entries) return;
  for (const entry of entries) {
    const subject = entry.subject(ctx);
    if (subject === null || subject === "") continue;
    await consumeOrThrow(entry.policy, subject, { requestIp: ctx.ip });
  }
}
