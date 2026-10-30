// Extension module — Phase 5 R4a: the in-tree module registry replaces
// PHP manifest loading. get_list, activate, deactivate, config_save,
// and guest is_on/settings are served from the static registry
// (../extension-registry.ts) joined with the extension table; the nine
// endpoints that manage external code, remote directories, or
// translation files throw removal errors (R1 pattern) instead of
// proxying to PHP. config_get now decrypts via crypt.ts — the Phase 4
// stub returned {ext} unconditionally, which made config round-trips
// unverifiable. get_navigation (R2a) below is unchanged.
//
// Guard map (Extension Api/Admin|Guest.php checkPermissions, R2a-style):
//   get_list -> extension/view (static table); activate, deactivate ->
//   extension/manage_extensions (static table); config_get, config_save
//   -> in-handler hasManagePermission (conditional: inactive target
//   needs extension/manage_extensions; active target needs target
//   access, a declared manage_settings key, then target
//   manage_settings); install -> extension/manage_extensions and
//   uninstall -> extension/uninstall_extensions in PHP, but both are
//   REMOVED, so the removal error throws before any auth check and
//   they need no guard entry; update, get_latest, get_extension_readme,
//   languages, toggle_language, locale_completion -> view or
//   manage_extensions in PHP, likewise REMOVED with no entry; guest
//   is_on, settings, languages are PHP-unguarded (guest role) and stay
//   unguarded — languages is REMOVED, the other two are implemented.

import type { CallContext } from "../dispatch";
import { FbError, register, requireAdmin } from "../dispatch";
import { getDb, getDbWrite } from "../db";
import { decryptV2, readExtensionConfig, writeExtensionConfig } from "../crypt";
import { hasPermission, requirePermission } from "../permissions";
import { CORE_MODULES } from "../guards";
import { publicOrigin } from "../public-url";
import {
  MANAGE_SETTINGS_MODULES,
  REGISTRY,
  REGISTRY_BY_ID,
  type RegistryModule,
} from "../extension-registry";

// --- Phase 5 R4a: registry-backed Extension API. ---

/** PHP empty() for request params: missing, "", or "0" count as empty. */
function phpEmpty(v: string | undefined): boolean {
  return v === undefined || v === "" || v === "0";
}

/** PHP filter truthiness (!empty): "1"/"true"/anything non-empty is true. */
function phpTruthy(v: string | undefined): boolean {
  return !phpEmpty(v);
}

/**
 * Port of Extension Service::hasManagePermission. The $ext argument may
 * carry a `mod_` prefix, which PHP strips before the checks.
 * Order matters and is preserved exactly:
 *  1. Target not active (not core, no installed row) -> the caller
 *     needs extension/manage_extensions (R2a denial message, 403).
 *  2. Target active -> the caller needs target-module access, else
 *     'You do not have permission to access the <target> module' (403).
 *  3. The target module must declare a manage_settings key, else
 *     'You do not have permission to perform this action' (403) —
 *     this throw does NOT consult identity, so even super-admins get
 *     it for modules like news (verified live against PHP).
 *  4. The caller needs target manage_settings (R2a denial message, 403).
 */
async function requireManageExtensionConfig(ctx: CallContext, extParam: string): Promise<void> {
  const target = extParam.startsWith("mod_") ? extParam.slice(4) : extParam;
  const active =
    CORE_MODULES.has(target) ||
    !!(await getDb()
      .prepare("SELECT 1 AS x FROM extension WHERE type = ? AND name = ? AND status = ? LIMIT 1")
      .get("mod", target, "installed"));
  if (!active) {
    await requirePermission(ctx, "extension", "manage_extensions");
    return;
  }
  const adminId = ctx.session?.admin?.id;
  if (!adminId) throw new FbError("Authentication Failed", 201);
  if (!(await hasPermission(adminId, target))) {
    throw new FbError(`You do not have permission to access the ${target} module`, 403);
  }
  if (!MANAGE_SETTINGS_MODULES.has(target)) {
    throw new FbError("You do not have permission to perform this action", 403);
  }
  await requirePermission(ctx, target, "manage_settings");
}

/**
 * One get_list entry: getManifest() defaults applied to null manifest
 * values, then the version/status overrides PHP applies afterwards.
 * The version argument is used VERBATIM: installed rows carry the DB
 * version even when it is null (PHP overwrites the manifest version
 * with the row version unconditionally), while core/available callers
 * pass the manifest version (defaulted to '1.0' by the caller when a
 * manifest ever lacks one). icon_url reproduces PHP's concatenation
 * SYSTEM_URL (trailing slash) + '/modules/<Dir>/<icon>' yields the
 * double slash seen live ('http://127.0.0.1:8080//modules/News/icon.svg');
 * modules without an icon render 'assets/icons/cog.svg' and carry no
 * icon_path key at all. Available (uninstalled, non-core) entries
 * additionally carry has_settings_routes=false and settings_routes=[].
 */
function manifestEntry(
  m: RegistryModule,
  status: string | null,
  version: string | null,
  hasSettings: boolean,
  available: boolean,
): Record<string, unknown> {
  const origin = publicOrigin();
  const entry: Record<string, unknown> = {
    id: m.id,
    type: "mod",
    name: m.name ?? m.id,
    description: m.description,
    homepage_url: m.homepageUrl ?? "https://fossbilling.org/",
    author: m.author ?? "FOSSBilling",
    author_url: m.authorUrl ?? "https://extensions.fossbilling.org/",
    license: m.license ?? "N/A",
    version,
    icon_url: m.iconUrl ? `${origin}//modules/${m.dir}/${m.iconUrl}` : "assets/icons/cog.svg",
    download_url: null,
    project_url: m.projectUrl ?? "https://extensions.fossbilling.org/",
    minimum_fossbilling_version: null,
    maximum_fossbilling_version: null,
    status,
    has_settings: hasSettings,
  };
  if (m.hasIcon && m.iconUrl) entry.icon_path = `mod_${m.dir}_${m.iconUrl}`;
  if (available) {
    entry.has_settings_routes = false;
    entry.settings_routes = [];
  }
  return entry;
}

interface ExtensionRow {
  id: number;
  type: string;
  name: string;
  status: string;
  version: string | null;
}

register("admin", "extension", "get_list", async (ctx) => {
  requireAdmin(ctx);
  const p = ctx.params;
  const installedOnly = phpTruthy(p["installed"]);
  const activeOnly = phpTruthy(p["active"]);
  const hasSettingsOnly = phpTruthy(p["has_settings"]);
  const search = p["search"];
  const typeFilter = p["type"];
  // Installed rows in DB id order. The type filter applies to this
  // query only (PHP); the core and available lists ignore it.
  let sql = "SELECT id, type, name, status, version FROM extension WHERE status = 'installed'";
  const args: unknown[] = [];
  if (typeFilter !== undefined && typeFilter !== "") {
    sql += " AND type = ?";
    args.push(typeFilter);
  }
  sql += " ORDER BY id";
  const rows = (await getDb().prepare(sql).all(...args)) as ExtensionRow[];
  const installedIds = new Set<string>();
  const installedEntries: Record<string, unknown>[] = [];
  for (const row of rows) {
    // Non-mod rows have no manifest model in the registry, and rows
    // for modules outside the registry (branding) are skipped —
    // mirroring PHP's skip when a manifest fails to load. TS never
    // prunes rows on a read (PHP's removeNotExistingModules deletes
    // them); the listing just omits them.
    if (row.type !== "mod") continue;
    const m = REGISTRY_BY_ID.get(row.name);
    if (!m) continue;
    installedIds.add(m.id);
    installedEntries.push(manifestEntry(m, row.status, row.version, m.hasSettings, false));
  }
  let entries: Record<string, unknown>[];
  if (activeOnly) {
    // Core modules first, in CORE_MODULES order, then installed rows.
    // api, orderbutton, and theme are core but not TS modules, so the
    // TS active list omits them (documented in findings-r4a.md).
    const coreEntries: Record<string, unknown>[] = [];
    for (const id of CORE_MODULES) {
      const m = REGISTRY_BY_ID.get(id);
      if (!m) continue;
      coreEntries.push(manifestEntry(m, "core", m.version ?? "1.0", m.hasSettings, false));
    }
    entries = [...coreEntries, ...installedEntries];
  } else {
    entries = [...installedEntries];
    if (!installedOnly) {
      // Non-core registry modules without installed rows, status null,
      // alphabetical by id (the observed PHP Finder order).
      const available = REGISTRY.filter((m) => !CORE_MODULES.has(m.id) && !installedIds.has(m.id)).sort(
        (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const m of available) {
        entries.push(manifestEntry(m, null, m.version ?? "1.0", false, true));
      }
    }
  }
  if (hasSettingsOnly) entries = entries.filter((e) => e.has_settings === true);
  if (search !== undefined && search !== "") {
    const needle = search.toLowerCase();
    entries = entries.filter((e) => String(e.name).toLowerCase().includes(needle));
  }
  return entries;
});

register("admin", "extension", "activate", async (ctx) => {
  requireAdmin(ctx);
  const id = ctx.params["id"] ?? "";
  const type = ctx.params["type"] ?? "";
  if (!id) throw new FbError("Extension ID was not passed");
  if (!type) throw new FbError("Extension type was not passed");
  // Method guard (extension/manage_extensions) already ran in
  // enforceDispatcherGates before this handler.
  if (type === "mod") {
    const m = REGISTRY_BY_ID.get(id);
    if (!m) {
      throw new FbError(
        `Cannot activate the ${id} module: its manifest file is missing or invalid. The extension files may be incomplete, please reinstall the extension.`,
        5897,
      );
    }
    const db = getDbWrite();
    const row = (await getDb()
      .prepare("SELECT id FROM extension WHERE type = ? AND name = ?")
      .get("mod", id)) as { id: number } | undefined;
    if (row) {
      await db.prepare("UPDATE extension SET status = 'installed', version = ? WHERE id = ?").run(m.version, row.id);
    } else {
      await db
        .prepare("INSERT INTO extension (type, name, status, version) VALUES ('mod', ?, 'installed', ?)")
        .run(id, m.version);
    }
    return { id, type, redirect: m.hasAdminController, has_settings: m.hasSettings };
  }
  // Non-mod types skip the manifest check in PHP (activate() only
  // handles TYPE_MOD specially); the row is created or re-installed
  // with redirect/has_settings false.
  const db = getDbWrite();
  const row = (await getDb()
    .prepare("SELECT id FROM extension WHERE type = ? AND name = ?")
    .get(type, id)) as { id: number } | undefined;
  if (row) {
    await db.prepare("UPDATE extension SET status = 'installed' WHERE id = ?").run(row.id);
  } else {
    await db
      .prepare("INSERT INTO extension (type, name, status, version) VALUES (?, ?, 'installed', NULL)")
      .run(type, id);
  }
  return { id, type, redirect: false, has_settings: false };
});

register("admin", "extension", "deactivate", async (ctx) => {
  requireAdmin(ctx);
  const id = ctx.params["id"] ?? "";
  const type = ctx.params["type"] ?? "";
  if (!id) throw new FbError("Extension ID was not passed");
  if (!type) throw new FbError("Extension type was not passed");
  // Method guard (extension/manage_extensions) already ran in
  // enforceDispatcherGates before this handler.
  const row = (await getDb()
    .prepare("SELECT id FROM extension WHERE type = ? AND name = ?")
    .get(type, id)) as { id: number } | undefined;
  if (!row) throw new FbError("Extension not found");
  // Core check AFTER the row lookup (PHP Api order: _getExtension
  // first, then Service::deactivate refuses core modules). Unreachable
  // via the API for core modules in practice — they have no rows —
  // but the order is preserved.
  if (type === "mod" && CORE_MODULES.has(id)) {
    throw new FbError("Core modules are an integral part of the FOSSBilling system and cannot be deactivated.");
  }
  // There is NO deactivated status value: PHP Service::deactivate()
  // deletes the row. The R2a gate fails for a deleted row, which is
  // what makes activation toggling enforce.
  await getDbWrite().prepare("DELETE FROM extension WHERE id = ?").run(row.id);
  return true;
});

register("admin", "extension", "config_get", async (ctx) => {
  requireAdmin(ctx);
  const ext = ctx.params["ext"] ?? "";
  if (!ext) throw new FbError('Parameter "ext" was not passed');
  await requireManageExtensionConfig(ctx, ext);
  // No row, undecryptable row, or non-object JSON all yield {} here,
  // so the result is {ext} — exactly PHP's decrypted-config-or-[] +
  // ext behavior. (Phase 4 returned {ext} unconditionally, which was
  // right only for the no-row case.)
  const cfg = await readExtensionConfig(ext);
  return { ...cfg, ext };
});

register("admin", "extension", "config_save", async (ctx) => {
  requireAdmin(ctx);
  const ext = ctx.params["ext"] ?? "";
  if (!ext) throw new FbError('Parameter "ext" was not passed');
  await requireManageExtensionConfig(ctx, ext);
  // PHP stores the full $data (including ext) v2-encrypted. JSON
  // posts carry real types in rawParams; urlencoded posts carry
  // strings in params — prefer rawParams when the body was JSON, so
  // both content types mirror PHP. CSRFToken is stripped before
  // dispatch in PHP (verified live: a saved config held only ext +
  // the test flag, never the token), so it is stripped here too.
  const raw = ctx.rawParams;
  const source: Record<string, unknown> =
    raw && Object.keys(raw).length > 0 ? raw : (ctx.params as unknown as Record<string, unknown>);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k !== "CSRFToken") data[k] = v;
  }
  const ok = await writeExtensionConfig(ext, data);
  if (!ok) throw new FbError("Failed to encrypt extension configuration");
  return true;
});

register("guest", "extension", "is_on", async (ctx) => {
  const mod = ctx.params["mod"];
  const id = ctx.params["id"];
  const type = ctx.params["type"];
  // PHP: mod non-empty -> isExtensionActive('mod', mod); else id+type
  // non-empty -> isExtensionActive(type, id); else true. Core modules
  // are active only for type 'mod'; other types always need a row.
  const isActive = async (t: string, name: string): Promise<boolean> => {
    if (t === "mod" && CORE_MODULES.has(name)) return true;
    const row = await getDb()
      .prepare("SELECT 1 AS x FROM extension WHERE type = ? AND name = ? AND status = ? LIMIT 1")
      .get(t, name, "installed");
    return !!row;
  };
  if (!phpEmpty(mod)) return isActive("mod", mod as string);
  if (!phpEmpty(id) && !phpEmpty(type)) return isActive(type as string, id as string);
  return true;
});

register("guest", "extension", "settings", async (ctx) => {
  const ext = ctx.params["ext"] ?? "";
  if (!ext) throw new FbError("Parameter ext is missing");
  // Note the message: no quotes around ext, unlike config_get's
  // 'Parameter "ext" was not passed'.
  const module = ext.startsWith("mod_") ? ext.slice(4) : ext;
  const coreOrActive =
    CORE_MODULES.has(module) ||
    !!(await getDb()
      .prepare("SELECT 1 AS x FROM extension WHERE type = ? AND name = ? AND status = ? LIMIT 1")
      .get("mod", module, "installed"));
  if (!coreOrActive) return [];
  // The config row is looked up by the RAW ext (prefix included), as
  // in PHP's getConfig($ext); only the `public` subset is returned,
  // and only when it is an array/object — PHP's is_array covers both
  // JSON arrays and JSON objects.
  const cfg = await readExtensionConfig(ext);
  const pub = cfg["public"];
  return pub !== null && typeof pub === "object" ? pub : [];
});

// --- Phase 5 R4a: explicit removals (R1 pattern). ---
// These endpoints manage external code, remote directories, or
// translation files, all abolished by the in-tree model (or owned by
// R5 localization): install downloads and extracts a remote package;
// uninstall removes module files; update re-downloads; get_latest and
// get_extension_readme read a remote directory/README; languages,
// toggle_language, and locale_completion manage translation files.
// The route skips ALL gates for these methods, so the removal error
// throws before any auth check, for every caller.
/** Admin extension endpoints removed in the Next.js port. */
export const REMOVED_EXTENSION_ADMIN = [
  "install",
  "uninstall",
  "update",
  "get_latest",
  "get_extension_readme",
  "languages",
  "toggle_language",
  "locale_completion",
];
/** Guest extension endpoints removed in the Next.js port. */
export const REMOVED_EXTENSION_GUEST = ["languages"];

for (const m of REMOVED_EXTENSION_ADMIN) {
  register("admin", "extension", m, () => {
    throw new FbError(`Endpoint admin/extension/${m} was removed in the Next.js port.`);
  });
}
register("guest", "extension", "languages", () => {
  throw new FbError("Endpoint guest/extension/languages was removed in the Next.js port.");
});

// --- Phase 5 R2a: get_navigation. ---
// Port of Extension Service::getAdminNavigation + the 19 modules'
// Controller/Admin::fetchNavigation() declarations. The declarations
// are static (English labels, en_US install); the module iteration
// order mirrors PHP exactly: core modules in CORE_MODULES order, then
// installed non-core modules in extension-id order, so per-group
// attach order (and therefore the sorted subpage key numbering) matches
// PHP. A module contributes only if it is core or installed AND the
// caller has permission for it (hasPermission, key null); subpages
// attach to their location's group only when that group exists —
// e.g. a staff member with only support access sees no activity
// group, so staff/email/client activity subpages drop with it.
// URIs are absolute against the public origin (FB_PUBLIC_URL / config url), as
// PHP's Url::adminLink builds them from the install base URI.
// Serialization note: PHP json_encode emits a group's subpages as a
// JSON object (not array) when the index-sorted keys are not 0..n-1
// sequential (activity, system); JS reorders integer-like keys
// numerically on stringify, so the TS wire order for those two groups
// differs from PHP's while the parsed key/value sets are identical.
// Parity compares parsed JSON, as in all prior batches.

interface NavSubDecl {
  location: string;
  label: string;
  path: string;
  index: number;
  cls: string;
}

interface NavGroupDecl {
  location: string;
  index: number;
  label: string;
  path?: string;
  cls: string;
}

/** Declaring modules in CORE_MODULES order (servicecustom and friends declare none). */
const CORE_DECLARING = [
  "activity",
  "client",
  "email",
  "extension",
  "invoice",
  "order",
  "product",
  "security",
  "servicedomain",
  "servicehosting",
  "staff",
  "support",
  "system",
  "widgets",
];

/** Declaring modules that are not core: included only when installed. */
const NONCORE_DECLARING = ["cookieconsent", "custompages", "embed", "massmailer", "news"];

const NAV_DECLS: Record<string, { group?: NavGroupDecl; subpages: NavSubDecl[] }> = {
  activity: {
    group: { location: "activity", index: 700, label: "Activity", cls: "chart-bar" },
    subpages: [
      { location: "activity", label: "System Activity", path: "activity", index: 100, cls: "" },
    ],
  },
  client: {
    group: { location: "client", index: 200, label: "Clients", path: "client", cls: "address-book" },
    subpages: [
      { location: "client", label: "Overview", path: "client", index: 100, cls: "" },
      { location: "activity", label: "Client Login History", path: "client/logins", index: 900, cls: "" },
    ],
  },
  cookieconsent: {
    subpages: [
      { location: "extensions", label: "Cookie Consent", path: "cookieconsent", index: 2000, cls: "" },
    ],
  },
  custompages: {
    subpages: [
      { location: "extensions", label: "Custom Pages", path: "custompages", index: 2000, cls: "" },
    ],
  },
  email: {
    subpages: [
      { location: "activity", label: "Email History", path: "email/history", index: 200, cls: "" },
    ],
  },
  embed: {
    subpages: [
      { location: "extensions", label: "Embed and Integrate", path: "embed", index: 1500, cls: "" },
    ],
  },
  extension: {
    group: { location: "extensions", index: 1000, label: "Extensions", cls: "iPlugin" },
    subpages: [
      { location: "extensions", label: "Overview", path: "extension", index: 100, cls: "" },
      { location: "extensions", label: "Languages", path: "extension/languages", index: 200, cls: "" },
    ],
  },
  invoice: {
    group: { location: "invoice", index: 400, label: "Invoices", path: "invoice", cls: "receipt" },
    subpages: [
      { location: "invoice", label: "Overview", path: "invoice", index: 100, cls: "" },
      { location: "invoice", label: "Subscriptions", path: "invoice/subscriptions", index: 300, cls: "" },
      { location: "invoice", label: "Transactions", path: "invoice/transactions", index: 400, cls: "" },
      { location: "invoice", label: "Failed Items", path: "invoice/failed-items", index: 500, cls: "" },
      { location: "system", label: "Tax Rules", path: "invoice/tax", index: 180, cls: "" },
      { location: "system", label: "Payment Gateways", path: "invoice/gateways", index: 160, cls: "" },
    ],
  },
  massmailer: {
    subpages: [
      { location: "extensions", label: "Mass Mailer", path: "massmailer", index: 4000, cls: "" },
    ],
  },
  news: {
    subpages: [
      { location: "support", label: "Announcements", path: "news", index: 900, cls: "" },
    ],
  },
  order: {
    group: { location: "order", index: 300, label: "Orders", path: "order", cls: "package" },
    subpages: [{ location: "order", label: "Overview", path: "order", index: 100, cls: "" }],
  },
  product: {
    group: { location: "products", index: 401, label: "Products", path: "products", cls: "photo" },
    subpages: [
      { location: "products", label: "Products & Services", path: "product", index: 110, cls: "" },
      { location: "products", label: "Product Addons", path: "product/addons", index: 120, cls: "" },
      { location: "products", label: "Product Promotions", path: "product/promos", index: 130, cls: "" },
    ],
  },
  security: {
    group: { location: "security", index: 650, label: "Security", cls: "lock" },
    subpages: [
      { location: "security", label: "Security Dashboard", path: "security", index: 100, cls: "" },
      { location: "security", label: "IP Lookup", path: "security/iplookup", index: 200, cls: "" },
      { location: "security", label: "Rate Limits", path: "security/rate-limits", index: 300, cls: "" },
    ],
  },
  servicedomain: {
    subpages: [
      { location: "system", label: "Domain Registration", path: "servicedomain", index: 150, cls: "" },
    ],
  },
  servicehosting: {
    subpages: [
      { location: "system", label: "Hosting Plans and Servers", path: "servicehosting", index: 140, cls: "" },
    ],
  },
  staff: {
    subpages: [
      { location: "activity", label: "Staff Login History", path: "staff/logins", index: 400, cls: "" },
    ],
  },
  support: {
    group: { location: "support", index: 500, label: "Support", cls: "headset" },
    subpages: [
      { location: "support", label: "Support Tickets", path: "support?status=open", index: 100, cls: "" },
      { location: "support", label: "Canned Responses", path: "support/canned-responses", index: 400, cls: "" },
    ],
  },
  system: {
    group: { location: "system", index: 600, label: "System", cls: "settings" },
    subpages: [
      { location: "system", label: "Settings", path: "system", index: 100, cls: "" },
      { location: "system", label: "Update FOSSBilling", path: "system/update", index: 100, cls: "" },
    ],
  },
  widgets: {
    subpages: [
      { location: "extensions", label: "Widgets", path: "widgets", index: 500, cls: "" },
    ],
  },
};

/** Support Service::kbEnabled: mod_support config kb_enable, default true. */
async function supportKbEnabled(): Promise<boolean> {
  let cfg: Record<string, unknown> = {};
  try {
    const row = await getDb()
      .prepare("SELECT meta_value FROM extension_meta WHERE extension = ? AND meta_key = ? LIMIT 1")
      .get("mod_support", "config") as { meta_value: string | null } | undefined;
    const plain = decryptV2(row?.meta_value ?? null);
    if (plain) {
      const parsed = JSON.parse(plain) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cfg = parsed as Record<string, unknown>;
      }
    }
  } catch {
    cfg = {};
  }
  const v = cfg["kb_enable"];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    if (["1", "true", "on", "yes"].includes(v.toLowerCase())) return true;
    if (["0", "false", "off", "no", ""].includes(v.toLowerCase())) return false;
  }
  return true;
}

/** PHP parse_url path + rtrim('/') for active-page comparison. */
function phpUrlPath(uri: string | null | undefined): string | null {
  if (!uri) return null;
  let path = uri;
  const scheme = path.indexOf("://");
  if (scheme >= 0) {
    const rest = path.slice(scheme + 3);
    const slash = rest.indexOf("/");
    path = slash >= 0 ? rest.slice(slash) : "/";
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

/**
 * Pure nav builder behind the get_navigation handler, shared with the
 * admin layout: server components cannot fetch the seam relatively,
 * and their fbCall helper posts to the PHP dispatcher directly, so the
 * sidebar renders by calling this builder in-process with the admin id
 * from the session cookie — the same code and data as the endpoint,
 * not a second implementation.
 */
export async function buildAdminNavigation(adminId: number, urlParam?: string | null) {
  const base = publicOrigin();
  const adminLink = (path: string) => `${base}/admin/${path}`;
  const installed = (
    (await getDb()
      .prepare("SELECT name FROM extension WHERE type = ? AND status = ? ORDER BY id")
      .all("mod", "installed")) as { name: string }[]
  ).map((r) => r.name);
  const modules = [
    ...CORE_DECLARING,
    ...installed.filter((m) => NONCORE_DECLARING.includes(m)),
  ];
  const kb = await supportKbEnabled();
  interface BuiltSub {
    orig: number;
    label: string;
    uri: string;
    index: number;
    cls: string;
    active: boolean;
  }
  const groups = new Map<
    string,
    { index: number; label: string; path?: string; cls: string; subs: BuiltSub[] }
  >();
  const currentPath = urlParam ? phpUrlPath(urlParam) : null;
  // Two phases, exactly like PHP getAdminNavigation: first create all
  // groups and collect every subpage flat (in module order), then
  // attach subpages to their location's group. Attaching during the
  // module loop would drop cross-group subpages whose group module
  // comes later (invoice tax/gateways and hosting/domain pages target
  // the system group, declared after them).
  const flatSubs: { location: string; label: string; uri: string; index: number; cls: string }[] =
    [];
  for (const mod of modules) {
    if (!await hasPermission(adminId, mod)) continue;
    const decl = NAV_DECLS[mod];
    if (!decl) continue;
    if (decl.group && !groups.has(decl.group.location)) {
      groups.set(decl.group.location, {
        index: decl.group.index,
        label: decl.group.label,
        path: decl.group.path,
        cls: decl.group.cls,
        subs: [],
      });
    }
    let subs = decl.subpages;
    if (mod === "support" && kb) {
      subs = [
        ...subs,
        { location: "support", label: "Knowledge Base", path: "support/kb", index: 500, cls: "" },
      ];
    }
    for (const s of subs) {
      flatSubs.push({
        location: s.location,
        label: s.label,
        uri: adminLink(s.path),
        index: s.index,
        cls: s.cls,
      });
    }
  }
  for (const s of flatSubs) {
    const g = groups.get(s.location);
    if (!g) continue;
    g.subs.push({
      orig: g.subs.length,
      label: s.label,
      uri: s.uri,
      index: s.index,
      cls: s.cls,
      active: currentPath !== null && phpUrlPath(s.uri) === currentPath,
    });
  }
  // Groups sorted by index (PHP sortByOneKey = stable asort); subpages
  // stable-sorted by index within each group, keeping attach order.
  const sortedGroups = [...groups.entries()].sort((a, b) => a[1].index - b[1].index);
  const out: Record<string, unknown> = {};
  for (const [location, g] of sortedGroups) {
    const sorted = [...g.subs].sort((a, b) => a.index - b.index);
    const sequential = sorted.every((s, i) => s.orig === i);
    const subpages: unknown = sequential
      ? sorted.map((s) => ({ label: s.label, uri: s.uri, index: s.index, class: s.cls, active: s.active }))
      : Object.fromEntries(
          sorted.map((s) => [
            String(s.orig),
            { label: s.label, uri: s.uri, index: s.index, class: s.cls, active: s.active },
          ]),
        );
    const groupActive = sorted.some((s) => s.active);
    out[location] = {
      index: g.index,
      label: g.label,
      uri: g.path ? adminLink(g.path) : (sorted[0]?.uri ?? null),
      class: g.cls,
      active: groupActive,
      subpages,
    };
  }
  // PHP returns a bare array here; json_encode([]) is [], not {}.
  return Object.keys(out).length > 0 ? out : [];
}

register("admin", "extension", "get_navigation", async (ctx) => {
  requireAdmin(ctx);
  return await buildAdminNavigation(ctx.session!.admin!.id, ctx.params["url"] ?? null);
});
