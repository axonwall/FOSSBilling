/**
 * Permission catalog for the staff group editor, extracted from
 * FOSSBilling 0.8.9 Service.php::getModulePermissions() in each module
 * (see docs/nextjs-strangler/phase5/extract-perms.py).
 *
 * Static by design, like the R2a nav declarations: the key sets are
 * PHP source structure, not runtime data. Modules with
 * hide_permissions (api, branding, cart, page, profile) are excluded,
 * matching the PHP group template's filter; page/profile are also
 * can_always_access, so they never render an access checkbox anyway.
 * At 0.8.9 every key is a bool checkbox — the template supports
 * select-type permissions, but no module defines one.
 *
 * Matrix module list (MATRIX_MODULES): CORE_MODULES minus index,
 * minus hidden modules, plus every other catalogued module. That is
 * a superset of the PHP form on installs where an extension module
 * is not installed (e.g. seo/serviceapikey/cookieconsent here):
 * keys posted for an inactive module are inert — the dispatcher
 * 715-gates inactive modules before permissions are consulted —
 * and apply if the module is later installed, exactly as if they
 * had been set while it was active.
 */
export interface PermissionKeyDef {
  key: string;
  display: string;
}

export const PERMISSION_CATALOG: Record<string, PermissionKeyDef[]> = {
  activity: [
    { key: 'view', display: 'View activity log' },
    { key: 'manage', display: 'Log activity' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  antispam: [
    { key: 'view', display: 'View antispam settings' },
    { key: 'manage', display: 'Manage antispam settings' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  client: [
    { key: 'view', display: 'View Client Details' },
    { key: 'create', display: 'Create Clients' },
    { key: 'edit_profile', display: 'Edit Client Profiles' },
    { key: 'impersonate_login', display: 'Login as Client' },
    { key: 'manage_api_keys', display: 'Manage Client API Keys' },
    { key: 'change_password', display: 'Change Client Passwords' },
    { key: 'manage_balance', display: 'Manage Client Balance' },
    { key: 'view_login_history', display: 'View Client Login History' },
    { key: 'manage_groups', display: 'Manage Client Groups' },
    { key: 'delete', display: 'Delete Clients' },
    { key: 'bulk_delete', display: 'Bulk Delete Clients' },
    { key: 'export', display: 'Export Clients' },
    { key: 'manage_settings', display: 'Manage Client Settings' },
  ],
  cookieconsent: [
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  cron: [
    { key: 'view', display: 'View cron information' },
    { key: 'manage', display: 'Run cron jobs' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  currency: [
    { key: 'view', display: 'View currencies' },
    { key: 'create', display: 'Create Currencies' },
    { key: 'edit', display: 'Edit Currencies' },
    { key: 'delete', display: 'Delete Currencies' },
    { key: 'set_default', display: 'Set Default Currency' },
    { key: 'update_rates', display: 'Update Currency Rates' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  custompages: [
    { key: 'view', display: 'View custom pages' },
    { key: 'manage', display: 'Manage custom pages' },
  ],
  email: [
    { key: 'view_email_history', display: 'View email history' },
    { key: 'delete_email_history', display: 'Delete email history' },
    { key: 'send_emails', display: 'Send emails' },
    { key: 'view_templates', display: 'View email templates' },
    { key: 'manage_templates', display: 'Manage email templates' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  extension: [
    { key: 'view', display: 'View extensions' },
    { key: 'manage_extensions', display: 'Manage extensions' },
    { key: 'uninstall_extensions', display: 'Uninstall extensions' },
  ],
  formbuilder: [
    { key: 'view', display: 'View forms' },
    { key: 'manage', display: 'Manage forms' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  invoice: [
    { key: 'view', display: 'View invoices' },
    { key: 'manage_invoices', display: 'Manage invoices' },
    { key: 'manage_transactions', display: 'Manage transactions' },
    { key: 'manage_gateways', display: 'Manage payment gateways' },
    { key: 'manage_subscriptions', display: 'Manage subscriptions' },
    { key: 'manage_tax', display: 'Manage tax rules' },
    { key: 'export', display: 'Export invoice data' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  massmailer: [
    { key: 'view', display: 'View mass mail messages' },
    { key: 'create_and_edit', display: 'Create and edit mass mail messages' },
    { key: 'send', display: 'Send mass mail' },
    { key: 'delete', display: 'Delete mass mail messages' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  news: [
    { key: 'view', display: 'View news' },
    { key: 'manage', display: 'Manage news' },
  ],
  notification: [
    { key: 'view', display: 'View notifications' },
    { key: 'manage', display: 'Manage notifications' },
  ],
  order: [
    { key: 'view', display: 'View orders' },
    { key: 'manage', display: 'Manage orders' },
    { key: 'export', display: 'Export orders' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  orderbutton: [
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  product: [
    { key: 'view', display: 'View products' },
    { key: 'manage_products', display: 'Manage products' },
    { key: 'manage_categories', display: 'Manage product categories' },
    { key: 'manage_promos', display: 'Manage promotions' },
  ],
  redirect: [
    { key: 'view', display: 'View redirects' },
    { key: 'create_and_edit', display: 'Create and edit redirects' },
    { key: 'delete', display: 'Delete redirects' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  security: [
    { key: 'view', display: 'View security information' },
    { key: 'run_checks', display: 'Run security checks' },
    { key: 'manage_rate_limits', display: 'Manage rate limits' },
  ],
  seo: [
    { key: 'view', display: 'View SEO information' },
    { key: 'manage', display: 'Manage SEO' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  serviceapikey: [
    { key: 'manage', display: 'Manage API keys' },
  ],
  servicecustom: [
    { key: 'manage', display: 'Manage custom services' },
  ],
  servicedomain: [
    { key: 'manage_domains', display: 'Manage domains' },
    { key: 'manage_tlds', display: 'Manage TLDs' },
    { key: 'manage_registrars', display: 'Manage registrars' },
  ],
  servicedownloadable: [
    { key: 'manage', display: 'Manage downloadable products' },
  ],
  servicehosting: [
    { key: 'manage_accounts', display: 'Manage hosting accounts' },
    { key: 'view_servers', display: 'View hosting servers' },
    { key: 'manage_servers', display: 'Manage hosting servers' },
    { key: 'manage_plans', display: 'Manage hosting plans' },
  ],
  servicelicense: [
    { key: 'manage', display: 'Manage licenses' },
  ],
  staff: [
    { key: 'view', display: 'View staff details' },
    { key: 'create_and_edit_staff', display: 'Create and edit staff members' },
    { key: 'delete_staff', display: 'Delete staff members' },
    { key: 'reset_staff_password', display: 'Reset staff passwords' },
    { key: 'manage_groups', display: 'Manage groups' },
    { key: 'manage_settings', display: 'Manage settings' },
  ],
  stats: [
    { key: 'view', display: 'View statistics' },
  ],
  support: [
    { key: 'view', display: 'View support tickets' },
    { key: 'manage_tickets', display: 'Manage tickets' },
    { key: 'manage_helpdesk', display: 'Manage helpdesks' },
    { key: 'manage_canned', display: 'Manage canned responses' },
    { key: 'manage_kb', display: 'Manage knowledge base' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  system: [
    { key: 'view', display: 'View System Information' },
    { key: 'manage_settings', display: 'Manage System Settings' },
    { key: 'manage_company_details', display: 'Manage Company Details' },
    { key: 'manage_company_legal', display: 'Manage Company Legal' },
    { key: 'update_params', display: 'Update System Parameters' },
    { key: 'invalidate_cache', display: 'Invalidate Cache' },
    { key: 'system_update', display: 'Update FOSSBilling' },
    { key: 'recheck_update', display: 'Recheck for Updates' },
    { key: 'toggle_error_reporting', display: 'Toggle Error Reporting' },
    { key: 'manage_network_interface', display: 'Manage the Network Interface' },
  ],
  theme: [
    { key: 'view', display: 'View themes' },
    { key: 'manage', display: 'Manage themes' },
    { key: 'manage_settings', display: 'manage_settings' },
  ],
  widgets: [
    { key: 'view', display: 'View widgets' },
    { key: 'manage', display: 'Manage widgets' },
  ],
};

export const MATRIX_MODULES: string[] = [
  'activity',
  'antispam',
  'client',
  'cron',
  'currency',
  'email',
  'extension',
  'invoice',
  'order',
  'security',
  'servicecustom',
  'servicedomain',
  'servicedownloadable',
  'servicehosting',
  'servicelicense',
  'staff',
  'stats',
  'support',
  'system',
  'theme',
  'orderbutton',
  'formbuilder',
  'widgets',
  'cookieconsent',
  'custompages',
  'massmailer',
  'news',
  'notification',
  'product',
  'redirect',
  'seo',
  'serviceapikey',
];
