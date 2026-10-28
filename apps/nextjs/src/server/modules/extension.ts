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
import { getDb } from "../db";
import { decryptV2 } from "../crypt";
import { hasPermission } from "../permissions";

register("admin", "extension", "config_get", (ctx) => {
  requireAdmin(ctx);
  const ext = ctx.params["ext"] ?? "";
  if (!ext) throw new FbError("Parameter \"ext\" was not passed");
  return { ext };
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
// URIs are absolute against the PHP origin (FOSSBILLING_URL), as
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
  const base = (process.env.FOSSBILLING_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
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
