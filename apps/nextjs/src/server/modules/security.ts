import { isIP } from "node:net";
import { FbError, register, requireAdmin, requireParam } from "../dispatch";
import { isLimiterEnabled, listIpCounters, resetAll, resetIp } from "../ratelimit";

/**
 * Security module — partial TS port of Security/Api/Admin.php.
 * Ported: list_checks (static check metadata) and the rate_limit_*
 * family. R5g: the limiter endpoints are REAL now (they read the
 * DB-backed counters in server/ratelimit.ts); before R5g they were
 * disabled-state reporters, which also matched PHP on the reference
 * install (APP_ENV=dev disables the limiter there). On a dev-default
 * TS server the limiter is still bypassed, so status reports
 * enabled: false and the list is empty — same as PHP on dev.
 *
 * NOT ported (left on the PHP proxy by design): ip_lookup needs a
 * MaxMind MMDB reader — public IPs return real country/ASN records
 * (see captures26 sec_ip_public) that the seam cannot reproduce
 * without a new dependency; run_check/run_checks probe the PHP
 * runtime itself (config.php flags, the PHP version via php.watch,
 * PHP's disable_functions list), which the TS seam does not run.
 * Registering them would hardcode the reference install's answers.
 */

const CHECKS = [
  {
    id: "dangerousFunctions",
    name: "Dangerous PHP functions",
    description: "Checks to see if potentially dangerous PHP functions are enabled.",
  },
  {
    id: "generalCheck",
    name: "General Check",
    description: "Checks general information such as the FOSSBilling configuration.",
  },
  {
    id: "phpVersion",
    name: "PHP Version Check",
    description: "Checks if the PHP version FOSSBilling is running on is still receiving security support.",
  },
  {
    id: "webserver",
    name: "Webserver Check",
    description: "Performs simple checks to validate your if webserver blocks access to sensitive files.",
  },
];

function validateIp(ip: string): void {
  if (isIP(ip) === 0) {
    throw new FbError("The provided input was not a valid IP address.");
  }
}

register("admin", "security", "list_checks", (ctx) => {
  requireAdmin(ctx);
  return CHECKS;
});

register("admin", "security", "rate_limit_status", (ctx) => {
  requireAdmin(ctx);
  return { enabled: isLimiterEnabled() };
});

register("admin", "security", "rate_limit_get_list", async (ctx) => {
  requireAdmin(ctx);
  const ip = ctx.params["ip"];
  if (ip !== undefined) validateIp(ip);
  const counters = await listIpCounters(ip ?? null);
  const search = ctx.params["search"];
  if (search === undefined || search === "") return counters;
  const needle = search.toLowerCase();
  return counters.filter(
    (c) => c.ip.toLowerCase().includes(needle) || c.policy.toLowerCase().includes(needle),
  );
});

register("admin", "security", "rate_limit_reset_ip", async (ctx) => {
  requireAdmin(ctx);
  const ip = requireParam(ctx.params, "ip", "You must specify an IP address to reset.");
  validateIp(ip);
  const removed = await resetIp(ip, ctx.params["policy"] ?? null);
  return { ip, policy: ctx.params["policy"] ?? null, removed };
});

register("admin", "security", "rate_limit_reset_all", async (ctx) => {
  requireAdmin(ctx);
  return { cleared: await resetAll() };
});
