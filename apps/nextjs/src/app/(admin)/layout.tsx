import Link from "next/link";
import AdminLogoutButton from "@/components/AdminLogoutButton";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import { buildAdminNavigation } from "@/server/modules/extension";
import { hasPermission } from "@/server/permissions";

/**
 * Admin chrome, Phase 5 R2a: a sidebar fed by the TS get_navigation
 * builder (same code as the admin/extension/get_navigation endpoint —
 * server components cannot fetch the seam relatively, so the layout
 * calls the builder in-process with the admin id from the session
 * cookie). Filtering to pages that actually exist happens HERE, not
 * in the endpoint: the endpoint stays PHP-faithful and lists every
 * permitted nav entry, while the sidebar drops entries with no Next
 * route (client/logins, invoice subpages, products, system, …).
 * Logged-out visitors (the login page lives under this layout) get
 * the old header-only chrome, since there is no nav to render.
 */

// PHP admin path (after /admin/) -> Next route, for pages that exist.
// R2c: product maps to /admin/products (the products group's
// "Products & Services" subpage). Service detail pages are
// order-addressed (/admin/services/[orderId]) and have no nav entry;
// they are reached from order pages and direct URLs, not the sidebar.
const NEXT_ROUTES: Record<string, string> = {
  client: "/admin/clients",
  order: "/admin/orders",
  invoice: "/admin/invoices",
  support: "/admin/tickets",
  product: "/admin/products",
  system: "/admin/system",
};

interface NavSub {
  label: string;
  uri: string;
  index: number;
  class: string;
  active: boolean;
}

interface NavGroup {
  label: string;
  uri: string | null;
  subpages: NavSub[] | Record<string, NavSub>;
}

function phpAdminPath(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    return path.replace(/^\/admin\//, "").replace(/^\/admin$/, "");
  } catch {
    return "";
  }
}

function fallbackChrome(children: React.ReactNode) {
  return (
    <div>
      <header className="border-b bg-zinc-900 text-zinc-100">
        <nav className="mx-auto flex max-w-4xl items-center gap-4 p-4 text-sm">
          <Link href="/admin" className="font-semibold">
            FOSSBilling Admin
          </Link>
          <span className="ml-auto flex gap-4">
            <Link href="/">Client area</Link>
            <AdminLogoutButton />
          </span>
        </nav>
      </header>
      {children}
    </div>
  );
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let nav: Record<string, NavGroup> | null = null;
  let sessionAdminId: number | null = null;
  try {
    const opts = await sessionOpts();
    const session = await readSession(opts.cookieHeader ?? null);
    if (session?.admin) {
      sessionAdminId = session.admin.id;
      nav = (await buildAdminNavigation(session.admin.id)) as Record<string, NavGroup>;
    }
  } catch {
    nav = null;
  }
  if (!nav) return fallbackChrome(children);

  const sections: { label: string; links: { label: string; href: string }[] }[] = [];
  for (const group of Object.values(nav)) {
    const subs = Array.isArray(group.subpages)
      ? group.subpages
      : Object.values(group.subpages);
    const surviving = subs
      .filter((s) => NEXT_ROUTES[phpAdminPath(s.uri)])
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ label: s.label, href: NEXT_ROUTES[phpAdminPath(s.uri)] }));
    if (surviving.length === 0) continue;
    // A section with a single surviving page links under the group
    // label ("Clients", not the generic "Overview"); multi-page
    // sections keep their subpage labels.
    sections.push({
      label: group.label,
      links:
        surviving.length === 1
          ? [{ label: group.label, href: surviving[0].href }]
          : surviving,
    });
  }

  // R2e: static Currencies + Statistics links under the System group.
  // Neither module declares a nav entry in PHP (currencies live under
  // system settings, stats are dashboard widgets), so they cannot map
  // through NEXT_ROUTES. They are appended to the System section only
  // when it renders — and it renders only for callers with system
  // module access — so the gating is the group's own, fail-closed.
  {
    const sys = sections.find((s) => s.label === "System");
    if (sys) {
      sys.links.push(
        { label: "Currencies", href: "/admin/system/currencies" },
        { label: "Statistics", href: "/admin/system/stats" },
      );
    }
  }

  // R2d: static Staff section. PHP's nav has no staff-management entry
  // (the Staff module only declares "Staff Login History" under
  // activity), so no nav subpage can map to /admin/staff through
  // NEXT_ROUTES. The section is therefore added here, filtered with
  // the same permission semantics the nav builder uses: the Staff link
  // requires staff module access, the Groups link additionally
  // requires the manage_groups key that gates the group list read.
  // Fail closed: if the permission lookup throws, no Staff section.
  if (sessionAdminId !== null) {
    try {
      if (await hasPermission(sessionAdminId, "staff")) {
        const links = [{ label: "Staff", href: "/admin/staff" }];
        if (await hasPermission(sessionAdminId, "staff", "manage_groups")) {
          links.push({ label: "Groups", href: "/admin/staff/groups" });
        }
        sections.push({ label: "Staff", links });
      }
    } catch {
      // No Staff section on permission-lookup failure.
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 bg-zinc-900 p-4 text-sm text-zinc-100">
        <Link href="/admin" className="block font-semibold">
          FOSSBilling Admin
        </Link>
        <nav className="mt-6 flex flex-col gap-6">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="text-xs font-semibold tracking-wide text-zinc-400">
                {section.label}
              </div>
              <div className="mt-2 flex flex-col gap-1">
                {section.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="rounded px-2 py-1 hover:bg-zinc-800"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-8 flex flex-col gap-2 border-t border-zinc-800 pt-4">
          <Link href="/" className="rounded px-2 py-1 hover:bg-zinc-800">
            Client area
          </Link>
          <AdminLogoutButton />
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
