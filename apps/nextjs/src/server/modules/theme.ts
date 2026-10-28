// Theme module — Phase 5 R4c: the intentional divergence (D4-3).
//
// PHP's Theme Service manages theme files, presets, settings, and
// CSS/JS regeneration for admin + client areas, and its reads return
// one entry per theme directory on disk (the reference install ships
// only the `default` package: default/client + default/admin).
// The Next app has no theme files, no presets, no settings system,
// and no CSS/JS regeneration (styling is build-time Tailwind), so
// returning PHP's theme list from static data would be fiction.
// Instead the four reads all describe the single built-in Next theme
// below, and the three writes throw removal errors (R1 pattern).
//
// Guard map (Theme Api/Admin.php checkPermissions, R2a-style):
//   get_list, get_admin_list, get_current, get -> theme/view
//   (static ADMIN_GUARDS entries; the dispatcher 725 module-access
//   gate fires first, exactly as for every admin module — theme is
//   core, so activation passes unconditionally, but module access
//   still gates non-super personas).
//   select, preset_delete, preset_select -> theme/manage in PHP,
//   but all three are REMOVED, so the removal error throws before
//   any auth check and they need no guard entry (R4a logic).
//
// Single-theme entry: every field is documented as PHP-mirrored
// (same field name as PHP's buildThemeConfig entry) or TS-defined.
//   code: "next" — TS-defined. The one built-in theme identifier.
//     It is deliberately NOT "default/client" or "default/admin":
//     claiming a PHP theme name while rendering Tailwind would be
//     the same fiction D4-3 rejects for the list.
//   name: "Next" — TS-defined.
//   version: "0.1.0" — from apps/nextjs/package.json (the app's
//     version, not a theme file's).
//   description: "Built-in Next.js theme" — TS-defined.
//   author: "FOSSBilling" — PHP's manifest fallback default (the
//     value PHP uses when a theme manifest omits author).
//   author_url: "https://www.fossbilling.org/" — PHP's manifest
//     fallback default.
//   icon: null — TS-defined. No screenshot file exists for the
//     built-in theme; claiming "screenshot.jpg" would be fiction.
//   markdown_attributes: {} — TS-defined. The Next theme carries
//     no CommonMark class mapping (PHP's entries inherit one from
//     their manifests).
//   url: "/" — TS-defined. The Next app root serves the theme;
//     no /themes/<code>/ URL exists in the Next app.
//   paths: [] — TS-defined. No Twig template paths exist in the
//     Next app, and PHP's absolute server paths must not be
//     reproduced (they would leak server layout and point at Twig
//     directories the Next app never renders).
//   hasSettings: false — TS-defined. No theme settings system
//     exists in the Next app (no config dir, no settings page).
//
// Collapses (documented, not hidden):
//   - get_list (client themes) and get_admin_list (admin themes)
//     both return the single entry: the Next app has one theme for
//     admin + client alike, so the area distinction collapses.
//   - get_current returns the single entry OBJECT in PHP's
//     get_current return shape (PHP returns the theme-config
//     object, not a name string). The `client` param is validated
//     exactly as PHP validates it (invalid -> 9999 'Invalid
//     "client" parameter.') but ignored for the result, since
//     both areas share the one theme.
//   - get with the single code ("next") returns the entry; any
//     other code (including PHP's "default/client" and
//     "default/admin") returns PHP's not-found shape: code 9999
//     with a message starting 'Theme was not found in path '.
//     PHP embeds its server themes path after that prefix; TS
//     names the requested code instead (it has no themes dir
//     to name). Parity32 asserts code + prefix, not the suffix.

import type { CallContext } from "../dispatch";
import { FbError, register, requireAdmin, requireParam } from "../dispatch";

export const NEXT_THEME_CODE = "next";

export const NEXT_THEME_ENTRY = {
  author: "FOSSBilling",
  author_url: "https://www.fossbilling.org/",
  code: NEXT_THEME_CODE,
  description: "Built-in Next.js theme",
  hasSettings: false,
  icon: null,
  markdown_attributes: {},
  name: "Next",
  paths: [],
  url: "/",
  version: "0.1.0",
} as const;

/**
 * PHP Theme Api/Admin::isInvalidClientParameter + Tools::normalizeBoolean,
 * mirrored: null/bool/int/float are valid; a string must be one of
 * filter_var's boolean spellings (case-insensitive: 1/true/on/yes,
 * 0/false/off/no/""); anything else (arrays, objects, other strings)
 * is invalid. Returns the normalized boolean; the caller ignores it
 * (both areas share the single theme) but the validation itself is
 * PHP-equivalent, so an invalid value errors exactly as PHP errors.
 */
function normalizeClientParam(ctx: CallContext): boolean {
  const raw = ctx.rawParams["client"];
  const v = raw !== undefined ? raw : ctx.params["client"];
  if (v === undefined || v === null) return true;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new FbError('Invalid "client" parameter.', 9999);
    return v !== 0;
  }
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    if (["1", "true", "on", "yes"].includes(lower)) return true;
    if (["0", "false", "off", "no", ""].includes(lower)) return false;
    throw new FbError('Invalid "client" parameter.', 9999);
  }
  throw new FbError('Invalid "client" parameter.', 9999);
}

// --- Phase 5 R4c: single-theme reads. ---

register("admin", "theme", "get_list", (ctx) => {
  requireAdmin(ctx);
  return { list: [NEXT_THEME_ENTRY] };
});

register("admin", "theme", "get_admin_list", (ctx) => {
  requireAdmin(ctx);
  return { list: [NEXT_THEME_ENTRY] };
});

register("admin", "theme", "get_current", (ctx) => {
  requireAdmin(ctx);
  // Validated exactly as PHP validates it; the area distinction
  // collapses (both areas share the single theme).
  normalizeClientParam(ctx);
  return NEXT_THEME_ENTRY;
});

register("admin", "theme", "get", (ctx) => {
  requireAdmin(ctx);
  const code = requireParam(ctx.params, "code", "Theme code was not passed");
  if (code !== NEXT_THEME_CODE) {
    // PHP: 'Theme was not found in path <server themes path>/<code>'.
    // TS has no themes dir; the requested code is named instead.
    throw new FbError(`Theme was not found in path ${code}`, 9999);
  }
  return NEXT_THEME_ENTRY;
});

// --- Phase 5 R4c: removed writes (R1 pattern, never proxied). ---

/** Admin theme endpoints removed in the Next.js port. */
export const REMOVED_THEME_ADMIN = ["select", "preset_delete", "preset_select"];

for (const m of REMOVED_THEME_ADMIN) {
  register("admin", "theme", m, () => {
    throw new FbError(`Endpoint admin/theme/${m} was removed in the Next.js port.`);
  });
}
