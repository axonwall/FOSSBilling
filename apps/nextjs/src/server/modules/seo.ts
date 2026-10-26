import { readExtensionConfig } from "../crypt";
import { getSetting, isModuleActive, upsertSetting } from "../db";
import { FbError, register, requireAdmin } from "../dispatch";

/**
 * Seo module — TS port of Seo/Api/Admin.php + Service.php, behind
 * the module-active gate: on the reference install seo is NOT
 * installed, so PHP answers 715 and so does this handler. The real
 * logic behind the gate is implemented (info reads the system
 * param + mod_seo config; ping_all pings enabled engines best-
 * effort, then stamps the param) but cannot be parity-proven on
 * this install — it is unverified-live until seo is installed.
 */

function requireSeoActive(): void {
  if (!isModuleActive("seo")) {
    throw new FbError("FOSSBilling module seo is not installed/activated", 715);
  }
}

function phpBase(): string {
  return (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
}

register("admin", "seo", "info", (ctx) => {
  requireAdmin(ctx);
  requireSeoActive();
  const config = readExtensionConfig("mod_seo");
  return {
    sitemap_url: `${phpBase()}/sitemap.xml`,
    last_exec: getSetting("mod_seo_last_sitemap_submit"),
    engines: {
      google: {
        id: "google",
        name: "Google",
        enabled: config["sitemap_google"] === "on",
      },
    },
  };
});

register("admin", "seo", "ping_all", async (ctx) => {
  requireAdmin(ctx);
  requireSeoActive();
  const config = readExtensionConfig("mod_seo");
  // Forced ping (admin API passes $forced = true): the daily guard
  // is skipped. Each enabled engine is pinged best-effort; failures
  // are swallowed exactly like PHP's per-engine try/catch.
  if (config["sitemap_google"] === "on") {
    const url = `${phpBase()}/sitemap.xml`;
    const target = `https://www.google.com/ping?sitemap=${encodeURIComponent(url)}`;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      try {
        await fetch(target, { signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Swallowed: pingSitemap failures only get logged in PHP.
    }
  }
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  upsertSetting("mod_seo_last_sitemap_submit", now);
  return true;
});
