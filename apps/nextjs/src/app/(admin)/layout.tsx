import Link from "next/link";
import AdminLogoutButton from "@/components/AdminLogoutButton";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import { buildAdminNavigation } from "@/server/modules/extension";

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
  try {
    const opts = await sessionOpts();
    const session = readSession(opts.cookieHeader ?? null);
    if (session?.admin) {
      nav = buildAdminNavigation(session.admin.id) as Record<string, NavGroup>;
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
