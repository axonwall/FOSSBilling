// Extension registry — Phase 5 R4a.
//
// The single source of per-module metadata for the Extension admin API
// (get_list, activate/deactivate eligibility, guest settings). It
// replaces PHP manifest loading (FOSSBilling\Module::getManifest):
// each entry transcribes one module's manifest.json at the 0.8.9
// freeze, plus two facts PHP derives from the module tree — whether a
// settings template exists (templates/admin/mod_<id>_settings.html.twig,
// i.e. hasSettingsPage()) and whether an admin controller exists
// (Controller/Admin.php, i.e. hasAdminController(), the activate
// `redirect` flag). The registry does NOT load code: modules stay
// statically imported by modules/index.ts, exactly as before.
//
// Field semantics mirror getManifest() exactly, as verified against the
// live reference install (2026-10-28): manifest values win when the
// key is present, otherwise PHP's defaults apply at render time in
// extension.ts (homepage_url 'https://fossbilling.org/', author
// 'FOSSBilling', author_url 'https://extensions.fossbilling.org/',
// license 'N/A', version '1.0', project_url
// 'https://extensions.fossbilling.org/'; description/icon_url/
// download_url and the version bounds stay null). Most manifests omit
// the four author/license keys entirely, so those entries are null
// here and render as defaults; antispam is the one registry module
// with a manifest project_url, and massmailer is a minimal manifest
// (id/type/name/icon/description/version only).
//
// Modules outside this registry are not extensions of the TS product:
// a get_list installed row for such a module (branding on the
// reference install) is skipped, mirroring PHP's skip when a manifest
// fails to decode. Theme, orderbutton, and api are core modules with
// no TS module; they appear in PHP's active-mode core list but not in
// the TS one (documented in findings-r4a.md).
//
// MANAGE_SETTINGS_MODULES transcribes the modules whose getModulePermissions
// declaration (Extension/Service.php) includes a `manage_settings` key.
// Extension/Service::hasManagePermission throws 'You do not have
// permission to perform this action' for every other target module,
// regardless of identity — including for super-admins — so this set
// must stay exact. It is deliberately wider than the registry (it
// includes orderbutton and theme, which can be config targets without
// being TS modules).

export interface RegistryModule {
  /** Lowercase module id (extension.name, manifest id). */
  id: string;
  /** Module directory name (Ucfirst(id)), used in icon paths. */
  dir: string;
  /** Manifest `name` (falls back to id if a manifest ever lacks it). */
  name: string | null;
  description: string | null;
  homepageUrl: string | null;
  author: string | null;
  authorUrl: string | null;
  license: string | null;
  /** Manifest `project_url` (null = PHP default, see header). */
  projectUrl: string | null;
  /** Manifest `version` (null only if a manifest ever lacks it). */
  version: string | null;
  /** Manifest `icon_url` basename (null = no icon; renders the cog). */
  iconUrl: string | null;
  /** Whether modules/<Dir>/<iconUrl> exists in the tree. */
  hasIcon: boolean;
  /** Whether templates/admin/mod_<id>_settings.html.twig exists. */
  hasSettings: boolean;
  /** Whether Controller/Admin.php exists (activate `redirect`). */
  hasAdminController: boolean;
}

/**
 * The 34 TS modules, in modules/index.ts import order. The get_list
 * available list is sorted alphabetically by id at render time (the
 * observed PHP Finder order); this array's order is only the
 * declaration order.
 */
export const REGISTRY: RegistryModule[] = [
  { id: "system", dir: "System", name: "System", description: "Configures global system behavior including localization, company details, caching and other settings.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "currency", dir: "Currency", name: "Currency", description: "Manages currencies, exchange rates, formatting, and default billing currency settings.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "client", dir: "Client", name: "Client", description: "Manages client accounts, profiles, authentication settings, and client-facing account preferences.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "staff", dir: "Staff", name: "Staff", description: "Manages staff accounts, roles, permissions, authentication, and administrative access settings.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "activity", dir: "Activity", name: "Activity", description: "Tracks and displays system activity logs for staff, clients, orders, invoices, and other administrative events.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "news", dir: "News", name: "News", description: "News module for FOSSBilling", homepageUrl: "https://github.com/FOSSBilling", author: "FOSSBilling", authorUrl: "http://extensions.fossbilling.org/", license: "https://github.com/FOSSBilling/FOSSBilling/blob/main/LICENSE", projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "custompages", dir: "Custompages", name: "Custom Pages", description: "This module allows you to create custom pages.", homepageUrl: "https://fossbilling.org/", author: "FOSSBilling", authorUrl: "https://fossbilling.org/", license: "GPL version 2 or later - http://www.gnu.org/licenses/old-licenses/gpl-2.0.html", projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "product", dir: "Product", name: "Product", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: true },
  { id: "cart", dir: "Cart", name: "Shopping cart", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: false },
  { id: "invoice", dir: "Invoice", name: "Invoices", description: "Controls invoice numbering, tax behavior, payment gateways, and billing document preferences.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "order", dir: "Order", name: "Orders", description: "Configures ordering behavior, fraud checks, order activation, and checkout-related preferences.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "cron", dir: "Cron", name: "Scheduled Tasks", description: "Configures scheduled task execution and automation used for recurring system maintenance.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: false },
  { id: "email", dir: "Email", name: "Email", description: "Configures outgoing mail delivery, email queue processing, and message logging for system notifications.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "support", dir: "Support", name: "Support", description: "Provides support ticket departments, helpdesk settings, knowledge base controls, and client support tools.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: true },
  { id: "extension", dir: "Extension", name: "Extensions", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: true },
  { id: "profile", dir: "Profile", name: "Profile", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: false },
  { id: "stats", dir: "Stats", name: "Statistics", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: false },
  { id: "massmailer", dir: "Massmailer", name: "Mass Mail Tool", description: "Send batch email to filtered clients", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "notification", dir: "Notification", name: "Notification Center", description: "Important messages for staff members", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "servicecustom", dir: "Servicecustom", name: "Custom product type", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: false },
  { id: "servicelicense", dir: "Servicelicense", name: "License product", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: false },
  { id: "servicedownloadable", dir: "Servicedownloadable", name: "Downloadable product type", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: true },
  { id: "servicehosting", dir: "Servicehosting", name: "Hosting product type", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: true },
  { id: "servicedomain", dir: "Servicedomain", name: "Domain product type", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: true },
  { id: "formbuilder", dir: "Formbuilder", name: "Form Builder", description: "Adds ability to create custom forms to be used anywhere", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: false },
  { id: "security", dir: "Security", name: "Security", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "redirect", dir: "Redirect", name: "Redirect", description: "Creates and manages URL redirects within FOSSBilling.", homepageUrl: null, author: "FOSSBilling", authorUrl: "https://www.fossbilling.org", license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: false },
  { id: "antispam", dir: "Antispam", name: "Anti-Spam", description: "Used to prevent spam using reCAPTCHA, StopForumSpam.com, disposable email domain blocking, honeypot fields, and IP blocking.", homepageUrl: "https://fossbilling.org/", author: "FOSSBilling", authorUrl: "https://fossbilling.org/", license: "Free for commercial and non-commercial use (Apache License or GPL 2)", projectUrl: "https://docs.fossbilling.org/admin-guide/anti-spam/", version: "4.23.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: false },
  { id: "widgets", dir: "Widgets", name: "Widgets", description: "Widget system for FOSSBilling. Allows modules to register widgets that can be rendered in designated slots.", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "seo", dir: "Seo", name: "SEO Tools", description: "Ping your sitemap to the search engines.", homepageUrl: null, author: null, authorUrl: null, license: "Apache-2.0", projectUrl: null, version: "0.4.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: true, hasAdminController: false },
  { id: "serviceapikey", dir: "Serviceapikey", name: "API Key Product", description: "A simple product type to allow you to generate and sell API keys for use in your applications", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: false },
  { id: "cookieconsent", dir: "Cookieconsent", name: "Cookie Consent", description: "Show cookie consent message to comply with European Cookie Law", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: "icon.svg", hasIcon: true, hasSettings: false, hasAdminController: true },
  { id: "page", dir: "Page", name: "Page", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: false },
  { id: "index", dir: "Index", name: "Index page module", description: "FOSSBilling core module", homepageUrl: null, author: null, authorUrl: null, license: null, projectUrl: null, version: "1.0.0", iconUrl: null, hasIcon: false, hasSettings: false, hasAdminController: true },
];

export const REGISTRY_BY_ID: Map<string, RegistryModule> = new Map(
  REGISTRY.map((m) => [m.id, m]),
);

/**
 * Modules declaring a `manage_settings` permission (Extension
 * Service::getModulePermissions, 0.8.9). See the header note: every
 * other target throws from hasManagePermission regardless of identity.
 */
export const MANAGE_SETTINGS_MODULES: ReadonlySet<string> = new Set([
  "activity",
  "antispam",
  "client",
  "cookieconsent",
  "cron",
  "currency",
  "email",
  "extension",
  "formbuilder",
  "invoice",
  "massmailer",
  "order",
  "orderbutton",
  "redirect",
  "seo",
  "staff",
  "support",
  "system",
  "theme",
]);
