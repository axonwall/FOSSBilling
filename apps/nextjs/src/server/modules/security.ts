import { isIP } from "node:net";
import { FbError, register, requireAdmin, requireParam } from "../dispatch";

/**
 * Security module — partial TS port of Security/Api/Admin.php.
 * Ported: list_checks (static check metadata) and the rate_limit_*
 * family. The TS seam runs no rate limiter, so the limiter endpoints
 * report the seam's own state: disabled, no counters, nothing to
 * remove — which is also exactly what PHP returns on the reference
 * install (APP_ENV=dev disables the limiter there).
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
  return { enabled: false };
});

register("admin", "security", "rate_limit_get_list", (ctx) => {
  requireAdmin(ctx);
  const ip = ctx.params["ip"];
  if (ip !== undefined) validateIp(ip);
  return [];
});

register("admin", "security", "rate_limit_reset_ip", (ctx) => {
  requireAdmin(ctx);
  const ip = requireParam(ctx.params, "ip", "You must specify an IP address to reset.");
  validateIp(ip);
  return { ip, policy: ctx.params["policy"] ?? null, removed: 0 };
});

register("admin", "security", "rate_limit_reset_all", (ctx) => {
  requireAdmin(ctx);
  return { cleared: true };
});
