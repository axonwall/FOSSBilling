import { isIP } from "node:net";
import { readExtensionConfig, writeExtensionConfig } from "../crypt";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";

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
