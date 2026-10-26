import { register, requireAdmin } from "../dispatch";

/**
 * Widgets module — TS port of Widgets/Api/Admin.php + Service.php.
 * The registry is built by scanning active modules for services
 * implementing WidgetProviderInterface; among core + active modules
 * only Branding provides one (client.theme.footer.end /
 * mod_branding_footer, default priority 10). The TS seam computes
 * this fixed registry instead of caching it — rebuild is therefore
 * a no-op that still returns true, and there is no Symfony cache
 * file for it to invalidate. If a future module adds widgets, this
 * list must grow with it.
 */

const REGISTRY = [
  {
    slot: "client.theme.footer.end",
    widgets: [{ module: "branding", template: "mod_branding_footer", priority: 10 }],
    count: 1,
  },
];

register("admin", "widgets", "list", (ctx) => {
  requireAdmin(ctx);
  return REGISTRY;
});

register("admin", "widgets", "rebuild", (ctx) => {
  requireAdmin(ctx);
  return true;
});
