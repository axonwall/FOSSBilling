import { isIP } from "node:net";
import { readExtensionConfig, writeExtensionConfig } from "../crypt";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { TEMP_EMAIL_SEED } from "../antispam-temp-seed";

/**
 * Antispam module — TS port of Antispam/Api/Admin.php + Guest.php.
 * Config lives in the encrypted extension_meta row for mod_antispam
 * (crypt.ts v2 interop); get_config applies the PHP defaults for
 * missing keys. Pinned by capture26.py.
 */

async function antispamConfig(): Promise<Record<string, unknown>> {
  return await readExtensionConfig("mod_antispam");
}

async function getConfigShape(): Promise<Record<string, unknown>> {
  const c = await antispamConfig();
  return {
    block_ips: c["block_ips"] ?? false,
    blocked_ips: c["blocked_ips"] ?? "",
    captcha_enabled: c["captcha_enabled"] ?? false,
    captcha_provider: c["captcha_provider"] ?? "recaptcha_v2",
    captcha_recaptcha_publickey: c["captcha_recaptcha_publickey"] ?? null,
    captcha_recaptcha_privatekey: c["captcha_recaptcha_privatekey"] ?? null,
    captcha_recaptcha_v3_threshold: c["captcha_recaptcha_v3_threshold"] ?? 0.5,
    turnstile_site_key: c["turnstile_site_key"] ?? null,
    turnstile_secret_key: c["turnstile_secret_key"] ?? null,
    hcaptcha_site_key: c["hcaptcha_site_key"] ?? null,
    hcaptcha_secret_key: c["hcaptcha_secret_key"] ?? null,
    sfs: c["sfs"] ?? false,
    check_temp_emails: c["check_temp_emails"] ?? true,
    honeypot_enabled: c["honeypot_enabled"] ?? true,
    honeypot_field: c["honeypot_field"] ?? "bio",
  };
}

function blockedIps(config: Record<string, unknown>): string[] {
  const raw = config["blocked_ips"];
  if (typeof raw !== "string" || raw === "") return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

async function saveBlockedIps(ips: string[], enabled: boolean): Promise<void> {
  const config = await antispamConfig();
  config["block_ips"] = enabled;
  config["blocked_ips"] = ips.join("\n");
  config["ext"] = "mod_antispam";
  await writeExtensionConfig("mod_antispam", config);
}

/** Raw value when JSON, else the string param (for the is_string check). */
function rawIp(ctx: CallContext): unknown {
  if (ctx.rawParams && "ip" in ctx.rawParams) return ctx.rawParams["ip"];
  return ctx.params["ip"];
}

function normalizeIp(ctx: CallContext): string {
  const ip = rawIp(ctx);
  if (typeof ip !== "string") throw new FbError("IP address is required");
  const trimmed = ip.trim();
  if (trimmed === "") throw new FbError("IP address is required");
  if (isIP(trimmed) === 0) throw new FbError("Invalid IP address");
  return trimmed;
}

/**
 * R5h enforcement layer — TS port of Antispam/Service.php's six event
 * listeners, wired inline at the handlers (TS has no event dispatcher).
 * Survey: findings-r5h.md §1 (all citations to src/modules/Antispam/
 * Service.php unless noted). Pinned by capture44.py.
 *
 * Listener → handler map (PHP event order preserved inside each):
 * - onBeforeClientSignUp: captcha is verified in Client/Api/Guest.php
 *   create() via checkCaptchaIfEnabled BEFORE the event fires; the
 *   event then runs blocked-IP → SFS → temp-email → honeypot. The
 *   event fires only for genuinely new signups (existing-email and
 *   rate-limited signups return early in Guest::create()).
 * - onBeforeGuestTicketCreate (guest role only): blocked-IP →
 *   captcha → SFS → temp-email. No honeypot on tickets.
 * - onBeforeClientProfileUpdate: blocked-IP only. This is the CLIENT
 *   profile event (Profile/Service.php updateClientProfile); the admin
 *   profile event (BeforeAdminProfileUpdateEvent) has NO antispam
 *   listener, so admin profile update is deliberately NOT gated.
 * - onBeforeAdminClientUpdate: blocked-IP only (admin updating a
 *   client record; admin CREATE dispatches a different event and is
 *   NOT gated — proven by capture44).
 * - onBeforeClientLogin / onBeforeAdminLogin: blocked-IP only, after
 *   email validation and before credential checks.
 * - Survey extra (scope doc omits it): checkCaptchaIfEnabled is also
 *   called by client reset_password (Client/Api/Guest.php:307) and
 *   staff passwordreset (Staff/Api/Guest.php:154) — captcha only, no
 *   blocked-IP. Both are wired here; password CHANGE / confirm
 *   endpoints have no antispam hook and are left alone.
 *
 * Config-read semantics: a missing or undecryptable mod_antispam row
 * yields {} here (crypt.ts) and [] in PHP (Extension/Service.php
 * getConfig), so both stacks apply the same defaults — there is no
 * separate "config error" path, and a missing row never disables a
 * block that a present config would impose, because the block itself
 * lives in the config (block_ips + blocked_ips).
 *
 * IP sourcing caveat (inherited from R5g, pre-existing seam
 * behavior): ctx.ip is the first X-Forwarded-For entry (else
 * 127.0.0.1), while PHP uses Symfony Request::getClientIp() =
 * REMOTE_ADDR unless trusted proxies are configured. The list
 * membership test is identical; the IP fed into it differs when a
 * proxy is in front. Matching is EXACT string equality after trim —
 * PHP uses in_array over a PHP_EOL-exploded, trimmed list; there is
 * no CIDR or subnet matching on either stack.
 *
 * Error codes: PHP InformationException defaults to code 0, which
 * ApiResponseFactory renders as envelope code 9999 (and HTTP 200) —
 * exactly the TS FbError default. Only the blocked-IP error carries
 * an explicit code (403): PHP returns real HTTP 403, TS returns the
 * seam-wide HTTP-200 envelope with code 403 (the R5g limiter's real
 * 429 is the seam's only non-200 error shape). Parity compares
 * envelopes, never HTTP status, for these errors.
 */
export type AntispamConfig = Record<string, unknown>;

export async function readAntispamConfig(): Promise<AntispamConfig> {
  return await getConfigShape();
}

/** PHP truthiness for config flags (0/"0"/""/false/null are falsy). */
function cfgTrue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && v !== "0";
}

function cfgString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Param lookup: string params first, JSON rawParams as fallback. */
function paramOf(ctx: CallContext, name: string): string {
  const p = ctx.params[name];
  if (typeof p === "string") return p;
  const r = ctx.rawParams?.[name];
  return typeof r === "string" ? r : "";
}

/** PHP empty() for a posted string: "", "0", missing all count as empty. */
function phpEmptyString(v: string | undefined): boolean {
  return v === undefined || v === "" || v === "0";
}

// ---------------------------------------------------------------- blocked IP

export async function checkBlockedIp(ctx: CallContext): Promise<void> {
  const c = await getConfigShape();
  if (!cfgTrue(c["block_ips"])) return;
  const raw = c["blocked_ips"];
  if (typeof raw !== "string") return;
  const list = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (list.includes(ctx.ip)) {
    throw new FbError(
      `Your IP address (${ctx.ip}) is blocked. Please contact our support to lift your block.`,
      403,
    );
  }
}

// ---------------------------------------------------------------- captcha

const RECAPTCHA_VERIFY_URL = "https://google.com/recaptcha/api/siteverify";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HCAPTCHA_VERIFY_URL = "https://hcaptcha.com/siteverify";

async function postVerify(url: string, fields: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  } catch {
    // Transport error. PHP lets it propagate (observed in capture44 as
    // the generic 'An unexpected error occurred...' 9999, signup
    // failing). TS fails CLOSED with the provider's verify-failed
    // error instead: the outcome (call rejected) matches PHP; only
    // the message differs (specific vs generic). A captcha that
    // cannot be verified must never pass — fail-open here would let
    // bots through whenever the provider is unreachable.
    return null;
  }
}

/**
 * Mirror of Antispam/Service.php checkCaptcha(). Single-use tokens are
 * enforced PROVIDER-side (Google/Cloudflare/hCaptcha reject a reused
 * token with success:false); TS stores no tokens. Parity41 proves the
 * reuse outcome through a mock that marks tokens used.
 * Unknown providers fall through silently in PHP and here.
 */
export async function checkCaptcha(ctx: CallContext): Promise<void> {
  const c = await getConfigShape();
  if (!cfgTrue(c["captcha_enabled"])) return;
  const provider = cfgString(c["captcha_provider"]) || "recaptcha_v2";
  const ip = ctx.ip;

  if (provider === "recaptcha_v2" || provider === "recaptcha_v3") {
    const secret = cfgString(c["captcha_recaptcha_privatekey"]);
    if (secret === "") {
      throw new FbError(
        "To use reCAPTCHA you must get an API key from <a href='https://www.google.com/recaptcha/admin/create'>here</a>",
      );
    }
    const response = paramOf(ctx, "g-recaptcha-response");
    if (response === "") {
      throw new FbError("You have to complete the CAPTCHA to continue");
    }
    const url = process.env.FB_ANTISPAM_RECAPTCHA_VERIFY_URL ?? RECAPTCHA_VERIFY_URL;
    const content = await postVerify(url, { secret, response, remoteip: ip });
    if (!content || content["success"] !== true) {
      throw new FbError("reCAPTCHA verification failed.");
    }
    if (provider === "recaptcha_v3") {
      let threshold = Number(c["captcha_recaptcha_v3_threshold"] ?? 0.5);
      if (!Number.isFinite(threshold)) threshold = 0.5;
      threshold = Math.min(1, Math.max(0, threshold));
      const score = typeof content["score"] === "number" ? content["score"] : 0;
      if (score < threshold) throw new FbError("reCAPTCHA verification failed.");
      const expectedAction = "fossbilling_submit";
      // PHP: $params['g-recaptcha-action'] ?? $expectedAction — a
      // missing action param does NOT fail; only a present-but-wrong
      // param, or a wrong response action, fails.
      const action = paramOf(ctx, "g-recaptcha-action") || expectedAction;
      if (action !== expectedAction || content["action"] !== expectedAction) {
        throw new FbError("reCAPTCHA verification failed.");
      }
    }
    return;
  }

  if (provider === "turnstile") {
    const secret = cfgString(c["turnstile_secret_key"]);
    if (secret === "") {
      throw new FbError("Cloudflare Turnstile secret key is not configured.");
    }
    const response = paramOf(ctx, "cf-turnstile-response");
    if (response === "") {
      throw new FbError("Please complete the CAPTCHA verification.");
    }
    const url = process.env.FB_ANTISPAM_TURNSTILE_VERIFY_URL ?? TURNSTILE_VERIFY_URL;
    const content = await postVerify(url, { secret, response, remoteip: ip });
    if (!content || content["success"] !== true) {
      throw new FbError("CAPTCHA verification failed. Please try again.");
    }
    return;
  }

  if (provider === "hcaptcha") {
    const secret = cfgString(c["hcaptcha_secret_key"]);
    if (secret === "") {
      throw new FbError("hCaptcha secret key is not configured.");
    }
    const response = paramOf(ctx, "h-captcha-response");
    if (response === "") {
      throw new FbError("Please complete the CAPTCHA verification.");
    }
    const url = process.env.FB_ANTISPAM_HCAPTCHA_VERIFY_URL ?? HCAPTCHA_VERIFY_URL;
    const content = await postVerify(url, { secret, response, remoteip: ip });
    if (!content || content["success"] !== true) {
      throw new FbError("CAPTCHA verification failed. Please try again.");
    }
    return;
  }
  // Unknown provider: PHP checkCaptcha does nothing. Fall through.
}

// ---------------------------------------------------------------- temp email

const TEMP_LIST_URL = "https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt";
const TEMP_LIST_TTL_SECONDS = 86400; // PHP: expiresAfter(86400); docblock says "1 week" but code wins
const TEMP_NEGATIVE_TTL_SECONDS = 3600; // PHP: non-200 / empty file -> expiresAfter(3600) + []

function tempListTtlSeconds(): number {
  const raw = process.env.FB_ANTISPAM_TEMP_LIST_TTL_SECONDS;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : TEMP_LIST_TTL_SECONDS;
}

function isDomainLike(s: string): boolean {
  // Approximation of PHP FILTER_VALIDATE_DOMAIN for list lines: labels
  // of alphanumerics/hyphens joined by dots, TLD of letters.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(s);
}

function parseTempList(body: string): { lines: string[]; domains: Set<string> } {
  const lines = body.split("\n").map((s) => s.trim().toLowerCase());
  const nonEmpty = lines.filter((s) => s !== "");
  const domains = new Set(
    nonEmpty.filter((s) => !s.startsWith("#") && isDomainLike(s)),
  );
  return { lines: nonEmpty, domains };
}

interface TempCacheEntry {
  domains: Set<string>;
  expiresAt: number;
  /** True when this entry records a failed fetch (non-200 / empty body). */
  fromFailure: boolean;
}

let tempCache: TempCacheEntry | null = null;

/**
 * Fetch + cache the throwaway-domain list (PHP getTempMailDomainDB).
 * PHP's cache is the Symfony cache pool (filesystem); TS's cache is
 * process-local in-memory with the same TTL semantics (a restart
 * refetches — durability differs, TTLs do not). PHP's tempEmailDB.txt
 * write/read/delete is only a transfer buffer, not the cache itself.
 * On a fetch FAILURE the vendored seed decides (R5h snapshot
 * resolution): seed-listed -> block, otherwise allow. A live list,
 * when available, is authoritative and the seed is not consulted.
 */
async function getTempDomains(): Promise<{ domains: Set<string>; fromSeed: boolean } | null> {
  const now = Date.now();
  if (tempCache && tempCache.expiresAt > now) {
    // A failed-fetch entry means "do not refetch for 3600s, and the
    // seed still decides" — NOT "allow everything" (the seed is the
    // fallback for the whole negative window, per the resolution).
    if (tempCache.fromFailure) return { domains: new Set(TEMP_EMAIL_SEED), fromSeed: true };
    return { domains: tempCache.domains, fromSeed: false };
  }
  const url = process.env.FB_ANTISPAM_TEMP_LIST_URL ?? TEMP_LIST_URL;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch {
    // Transport error: PHP does NOT cache this (it propagates and the
    // signup fails). TS does not cache it either — but unlike PHP it
    // consults the seed and fails OPEN for unlisted domains (R5-4).
    return { domains: new Set(TEMP_EMAIL_SEED), fromSeed: true };
  }
  if (!res.ok) {
    // PHP: expiresAfter(3600) + return [] (negative cache, fail-open).
    // TS: negative-cache the FAILURE for 3600s (no refetch in the
    // window — proven by mock hit counts), but the seed still decides
    // for seed-listed domains (the documented third behavior —
    // stronger than PHP's plain allow, weaker than a fetch).
    tempCache = { domains: new Set(), expiresAt: now + TEMP_NEGATIVE_TTL_SECONDS * 1000, fromFailure: true };
    return { domains: new Set(TEMP_EMAIL_SEED), fromSeed: true };
  }
  const body = await res.text();
  const { lines, domains } = parseTempList(body);
  if (lines.length === 0) {
    // PHP: file() falsy -> expiresAfter(3600) + []. Seed decides.
    tempCache = { domains: new Set(), expiresAt: now + TEMP_NEGATIVE_TTL_SECONDS * 1000, fromFailure: true };
    return { domains: new Set(TEMP_EMAIL_SEED), fromSeed: true };
  }
  tempCache = { domains, expiresAt: now + tempListTtlSeconds() * 1000, fromFailure: false };
  return { domains, fromSeed: false };
}

/**
 * Mirror of Antispam/Service.php isATempEmail($email, throw=true).
 * Matching is EXACT-domain only (EmailChecker ArrayAdapter isset on
 * the lowercased domain from parseEmailAddress) — subdomains of a
 * listed domain are NOT blocked unless listed themselves. An
 * unparseable address is treated as valid (PHP catches the parse
 * exception and returns false).
 */
export async function checkTempEmail(email: string): Promise<void> {
  const c = await getConfigShape();
  if (!cfgTrue(c["check_temp_emails"] ?? true)) return;
  const at = email.lastIndexOf("@");
  if (at === -1) return; // unparseable -> valid (fail-open, as PHP)
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!isDomainLike(domain)) return; // parse failure -> valid
  const got = await getTempDomains();
  if (!got) return;
  if (got.domains.has(domain)) {
    throw new FbError("Disposable email addresses are not allowed");
  }
}

// ---------------------------------------------------------------- SFS

const SFS_URL = "https://www.stopforumspam.com/api";

/**
 * Mirror of isInStopForumSpamDatabase() as called by checkSpam():
 * checkSpam sends ONLY ip + email — username is never populated on
 * this path (the username branch below is dead from these callers but
 * kept in PHP's check order for fidelity). PHP: non-object JSON or
 * success=false -> false (fail-open). Transport errors PROPAGATE in
 * PHP (observed in capture44 as the generic 9999 failure); TS
 * deliberately FAILS OPEN on transport errors per R5-4 ("SFS ported
 * fail-open") — a pinned deviation: PHP rejects the call, TS allows
 * it, when stopforumspam.com is unreachable.
 */
export async function checkStopForumSpam(ip: string, email: string): Promise<void> {
  const c = await getConfigShape();
  if (!cfgTrue(c["sfs"])) return;
  const base = process.env.FB_ANTISPAM_SFS_URL ?? SFS_URL;
  const qs = new URLSearchParams({ ip, email, f: "json" });
  let parsed: unknown;
  try {
    const res = await fetch(`${base}?${qs.toString()}`, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // non-object -> fail-open (PHP: json_decode non-object -> false)
    }
  } catch {
    return; // transport error -> TS fail-open (deviation from PHP fail-hard)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const obj = parsed as Record<string, unknown>;
  if (obj["success"] === false) return; // success=false -> fail-open
  const appears = (field: string): boolean => {
    // PHP: `isset($json->field->appears) && $json->field->appears` —
    // a TRUTHY check (real SFS returns 0/1), not === true.
    const v = obj[field];
    return !!v && typeof v === "object" && !!(v as Record<string, unknown>)["appears"];
  };
  if (appears("username")) {
    throw new FbError("Your username is blacklisted in the Stop Forum Spam database");
  }
  if (appears("email")) {
    throw new FbError("Your e-mail is blacklisted in the Stop Forum Spam database");
  }
  if (appears("ip")) {
    throw new FbError("Your IP address is blacklisted in the Stop Forum Spam database");
  }
}

// ---------------------------------------------------------------- honeypot

/**
 * Mirror of checkHoneypot(): enabled by default, field 'bio' by
 * default, PHP !empty() semantics (a '0' value counts as EMPTY and
 * passes — proven by capture44). Signup only; ticket create has no
 * honeypot check in PHP.
 */
export async function checkHoneypot(ctx: CallContext): Promise<void> {
  const c = await getConfigShape();
  if (!cfgTrue(c["honeypot_enabled"] ?? true)) return;
  const field = cfgString(c["honeypot_field"]) || "bio";
  const value = ctx.params[field] ?? (typeof ctx.rawParams?.[field] === "string" ? ctx.rawParams[field] : undefined);
  if (!phpEmptyString(typeof value === "string" ? value : undefined)) {
    throw new FbError("Registration failed.");
  }
}

// ---------------------------------------------------------------- composites

/** Event order for signup: blocked-IP -> SFS -> temp-email -> honeypot. */
export async function checkSignupAntispam(ctx: CallContext, email: string): Promise<void> {
  await checkBlockedIp(ctx);
  await checkStopForumSpam(ctx.ip, email);
  await checkTempEmail(email);
  await checkHoneypot(ctx);
}

/** Event order for guest tickets: blocked-IP -> captcha -> SFS -> temp-email. */
export async function checkGuestTicketAntispam(ctx: CallContext, email: string): Promise<void> {
  await checkBlockedIp(ctx);
  await checkCaptcha(ctx);
  await checkStopForumSpam(ctx.ip, email);
  await checkTempEmail(email);
}

register("admin", "antispam", "get_config", async (ctx) => {
  requireAdmin(ctx);
  return await getConfigShape();
});

register("guest", "antispam", "recaptcha", async () => {
  const c = await antispamConfig();
  return {
    publickey: c["captcha_recaptcha_publickey"] ?? null,
    enabled: c["captcha_enabled"] ?? false,
    version: c["captcha_version"] ?? null,
    captcha_provider: c["captcha_provider"] ?? "recaptcha_v2",
    recaptcha_v3_threshold: c["captcha_recaptcha_v3_threshold"] ?? 0.5,
    turnstile_site_key: c["turnstile_site_key"] ?? null,
    hcaptcha_site_key: c["hcaptcha_site_key"] ?? null,
  };
});

register("admin", "antispam", "block_ip", async (ctx) => {
  requireAdmin(ctx);
  const ip = normalizeIp(ctx);
  const config = await antispamConfig();
  const ips = blockedIps(config);
  if (ips.includes(ip)) throw new FbError(`${ip} is already blocked.`);
  if (ctx.ip === ip) {
    throw new FbError(`You cannot block ${ip} as it is the IP you are making requests from.`);
  }
  ips.push(ip);
  await saveBlockedIps(ips, true);
  return { result: true, ip };
});

register("admin", "antispam", "unblock_ip", async (ctx) => {
  requireAdmin(ctx);
  const ip = normalizeIp(ctx);
  const config = await antispamConfig();
  const ips = blockedIps(config);
  const idx = ips.indexOf(ip);
  if (idx === -1) throw new FbError(`${ip} is not currently blocked.`);
  ips.splice(idx, 1);
  await saveBlockedIps(ips, ips.length > 0);
  return { result: true, ip };
});

register("admin", "antispam", "get_blocked_ips", async (ctx) => {
  requireAdmin(ctx);
  const config = await antispamConfig();
  return { enabled: config["block_ips"] ?? false, ips: blockedIps(config) };
});
