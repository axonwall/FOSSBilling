// Extension module — config_get only (Phase 4 batch 4).
// The rest of the Extension admin API stays on the PHP proxy:
// get_list/get_navigation read module manifests from disk,
// languages/locale_completion read translation catalogs, and
// activate/deactivate/install/uninstall/update/config_save
// execute PHP module code or write encrypted config. Stored
// extension config is encrypted at rest with the install salt,
// which the TS side cannot decrypt — so config_get returns the
// stored config only when no encrypted row exists (the common
// case, e.g. support -> {ext: 'support'}); a present encrypted
// row is a documented gap, not silently fabricated.

import { FbError, register, requireAdmin } from "../dispatch";

register("admin", "extension", "config_get", (ctx) => {
  requireAdmin(ctx);
  const ext = ctx.params["ext"] ?? "";
  if (!ext) throw new FbError("Parameter \"ext\" was not passed");
  return { ext };
});
