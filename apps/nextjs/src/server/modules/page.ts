import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "../db";
import { register, requireAdmin } from "../dispatch";

/**
 * Page module — TS port of Page/Api/Admin.php::get_pairs (+
 * Service::getPairs). Pairs come from scanning the current client
 * theme's html dir and the Page module's client templates for
 * mod_page_*.html.twig files; the label is ucwords() of the
 * basename with '-' and '_' turned into spaces. PHP's Finder
 * order is readdir order; the TS scan sorts filenames so the
 * result is deterministic (it matches the captured order on the
 * reference install). Scans the vendored theme + Page template dirs
 * (R6c: apps/nextjs/vendor/php-themes + vendor/php-modules); an
 * explicit FOSSBILLING_PHP_SRC override still wins when its dirs
 * exist (operators with custom template trees). Missing dirs are
 * skipped, as before.
 */

function labelFor(fileName: string): string {
  const base = fileName.replace(/\.html\.twig$/, "");
  return base
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

register("admin", "page", "get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const theme = await getSetting("theme");
  const themeCode = theme && theme !== "" ? theme : "default/client";
  const src = process.env.FOSSBILLING_PHP_SRC ?? "";
  const themeOverride = src ? join(src, "themes", themeCode, "html") : "";
  const pageOverride = src ? join(src, "modules", "Page", "templates", "client") : "";
  const dirs = [
    themeOverride && existsSync(themeOverride)
      ? themeOverride
      : join(process.cwd(), "vendor", "php-themes", themeCode, "html"),
    pageOverride && existsSync(pageOverride)
      ? pageOverride
      : join(process.cwd(), "vendor", "php-modules", "Page", "templates", "client"),
  ];
  const out: Record<string, string> = {};
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("mod_page_") && f.endsWith(".html.twig"))
      .sort();
    for (const f of files) {
      const key = f.replace(/\.html\.twig$/, "");
      out[key] = labelFor(f);
    }
  }
  return out;
});
