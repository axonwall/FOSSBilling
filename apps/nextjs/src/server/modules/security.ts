import { isIP } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { FbError, register, requireAdmin, requireParam } from "../dispatch";
import { getConfigProperty } from "../config-store";
import { lookupGeoip } from "../geoip";
import { isLimiterEnabled, listIpCounters, resetAll, resetIp } from "../ratelimit";

/**
 * Security module — TS port of Security/Api/Admin.php.
 * Ported: list_checks (static check metadata), the rate_limit_*
 * family (R5g: REAL now, reading the DB-backed counters in
 * server/ratelimit.ts), and — R5i — the last three deferred:
 * ip_lookup (MaxMind reader over the PHP tree's bundled DBs, see
 * server/geoip.ts), run_check / run_checks (static registry;
 * generalCheck + webserver ported, phpVersion + dangerousFunctions
 * retired-marked, never fabricated). Permission guards live in
 * server/guards.ts (ip_lookup/list_checks: security.view;
 * run_check/run_checks: security.run_checks — the service-layer
 * re-check collapses to that single guard entry, per the R5 scope).
 * R5g note: on a dev-default TS server the limiter is still
 * bypassed, so status reports enabled: false and the list is empty
 * — same as PHP on dev.
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

/** PHP truthiness for config scalars (false/0/""/"0"/null/[] are falsy). */
function phpTruthy(v: unknown): boolean {
  return (
    v !== undefined &&
    v !== null &&
    v !== false &&
    v !== 0 &&
    v !== "" &&
    v !== "0" &&
    !(Array.isArray(v) && v.length === 0)
  );
}

// ---------------------------------------------------------------- checks
// Mirror of SecurityCheckResult + SecurityCheckResultEnum: result is
// 'passed' | 'warning' | 'failed'. run_check attaches id only;
// run_checks attaches id + name. Retired entries keep the enum value
// ('failed' — conservative, never a fabricated pass) and add
// retired: true + a message starting 'Retired:' so a consumer can
// distinguish retirement from a genuine failure.

type CheckOutcome = {
  result: "passed" | "warning" | "failed";
  message: string;
  retired?: true;
};

const RETIRED_PHP_VERSION: CheckOutcome = {
  result: "failed",
  message:
    "Retired: PHP version checks have no meaning on the TypeScript server; there is no PHP runtime version to check.",
  retired: true,
};

const RETIRED_DANGEROUS_FUNCTIONS: CheckOutcome = {
  result: "failed",
  message:
    "Retired: PHP function availability has no meaning on the TypeScript server; there is no PHP function list to check.",
  retired: true,
};

/**
 * Mirror of Checks/generalCheck.php performCheck, in PHP order.
 * Config reads use the R5a config store (same config.php PHP reads);
 * a MISSING key behaves as PHP's direct array access does (warning +
 * null): falsy for the flag probes, warning for update_branch.
 * isPreviewVersion mirrors Version::isPreviewVersion: preview =
 * (version === '0.0.1' OR not valid semver). The version is read
 * from the PHP tree's Version.php (same constant PHP reads); if the
 * file is unreadable, preview defaults true (conservative warn).
 */
function isPreviewVersion(): boolean {
  const phpSrc = process.env.FOSSBILLING_PHP_SRC;
  if (phpSrc === undefined || phpSrc === "") return true;
  try {
    const src = fs.readFileSync(
      path.join(phpSrc, "library", "FOSSBilling", "Version.php"),
      "utf8",
    );
    const m = /VERSION\s*=\s*'([^']+)'/.exec(src);
    if (!m) return true;
    const version = m[1]!;
    if (version === "0.0.1") return true;
    return !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(
      version,
    );
  } catch {
    return true;
  }
}

function generalCheck(): CheckOutcome {
  let status = 0; // 0 okay, 1 warn, 2 fail (max wins, as in PHP)
  let message = "";
  const warn = (line: string) => {
    message += `- ${line}\n`;
    if (status < 1) status = 1;
  };
  const fail = (line: string) => {
    message += `- ${line}\n`;
    status = 2;
  };
  if (!phpTruthy(getConfigProperty("security.perform_session_fingerprinting", false))) {
    warn("Warning: Prevention against session hijacking is disabled.");
  }
  if (!phpTruthy(getConfigProperty("security.force_https", false))) {
    fail("Fail: HTTPS is not enforced.");
  }
  if (!phpTruthy(getConfigProperty("api.CSRFPrevention", false))) {
    warn("Warning: CSRF prevention is not enabled for the API.");
  }
  if (phpTruthy(getConfigProperty("twig.debug", false))) {
    warn("Warning: Debug mode is enabled for the Twig templating engine.");
  }
  if (phpTruthy(getConfigProperty("debug_and_monitoring.debug", false))) {
    warn("Warning: Debug mode is enabled for your FOSSBilling installation.");
  }
  if (getConfigProperty<string>("update_branch", "") !== "release") {
    warn("Warning: FOSSBilling is configured to update to non-release versions of FOSSBilling.");
  }
  if (isPreviewVersion()) {
    warn("Warning: You appear to be using a non-release version of FOSSBilling.");
  }
  if (message === "") message = "No detected issues.";
  return {
    result: status === 0 ? "passed" : status === 1 ? "warning" : "failed",
    message,
  };
}

/**
 * Mirror of Checks/webserver.php performCheck: fetch the three probe
 * URIs against the system origin and fail for each HTTP 200.
 * Origin = SYSTEM_URL semantics (src/load.php:365): scheme from
 * config security.force_https (load.php default TRUE — note this
 * differs from generalCheck's missing-key-falsy rule; each mirrors
 * its own PHP code path) plus the config url with any scheme
 * stripped. TS ensures exactly one trailing slash; PHP concatenates
 * raw (the reference url already ends in '/', so parity on the
 * reference is exact — the normalization only matters for a
 * slash-less config url, where PHP would build a broken URL).
 * A transport error propagates as PHP's generic 9999 (PHP's
 * http_client throws; the webserver check does not catch).
 */
const WEBSERVER_PROBES = ["config.php", "data/log/php_error.log", "vendor/autoload.php"];

function systemOrigin(): string {
  const scheme = phpTruthy(getConfigProperty("security.force_https", true))
    ? "https://"
    : "http://";
  const raw = String(getConfigProperty("url", ""));
  const stripped = raw.replaceAll("https://", "").replaceAll("http://", "");
  return `${scheme}${stripped.replace(/\/+$/, "")}/`;
}

async function webserverCheck(): Promise<CheckOutcome> {
  const origin = systemOrigin();
  let isOkay = true;
  let result = "";
  for (const uri of WEBSERVER_PROBES) {
    let status: number;
    try {
      const res = await fetch(`${origin}${uri}`, { signal: AbortSignal.timeout(10000) });
      status = res.status;
    } catch {
      throw new FbError("An unexpected error occurred. Please try again later.");
    }
    if (status === 200) {
      isOkay = false;
      result += `${origin}${uri} returned HTTP 200 when it shouldn't have.\n`;
    }
  }
  if (result === "") result = "All tested URLs were inaccessible.";
  return { result: isOkay ? "passed" : "failed", message: result };
}

type CheckPerformer = () => CheckOutcome | Promise<CheckOutcome>;

/** Static registry (NOT filesystem discovery, per the R5 scope). */
const CHECK_REGISTRY: Record<string, CheckPerformer> = {
  dangerousFunctions: () => RETIRED_DANGEROUS_FUNCTIONS,
  generalCheck: () => generalCheck(),
  phpVersion: () => RETIRED_PHP_VERSION,
  webserver: () => webserverCheck(),
};

async function runOneCheck(id: string): Promise<CheckOutcome & { id: string }> {
  const performer = CHECK_REGISTRY[id];
  if (performer === undefined) {
    throw new FbError(`The check ${id} does not exist.`);
  }
  const outcome = await performer();
  return { ...outcome, id };
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

// R5i: the last three deferred endpoints.
register("admin", "security", "ip_lookup", async (ctx) => {
  requireAdmin(ctx);
  const ip = requireParam(ctx.params, "ip", "You must specify an IP address to lookup.");
  validateIp(ip);
  const type = isIP(ip) === 4 ? "IPv4" : "IPv6";
  const locale = String(getConfigProperty("i18n.locale", "en_US"));
  return await lookupGeoip(ip, type, locale);
});

register("admin", "security", "run_check", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "You must specify a check ID to run.");
  return await runOneCheck(id);
});

register("admin", "security", "run_checks", async (ctx) => {
  requireAdmin(ctx);
  const results = [];
  for (const check of CHECKS) {
    const outcome = await runOneCheck(check.id);
    results.push({ ...outcome, name: check.name });
  }
  return results;
});
