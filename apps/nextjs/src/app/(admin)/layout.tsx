import Link from "next/link";
import AdminLogoutButton from "@/components/AdminLogoutButton";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="border-b bg-zinc-900 text-zinc-100">
        <nav className="mx-auto flex max-w-4xl items-center gap-4 p-4 text-sm">
          <Link href="/admin" className="font-semibold">
            FOSSBilling Admin
          </Link>
          <Link href="/admin/clients">Clients</Link>
          <Link href="/admin/orders">Orders</Link>
          <Link href="/admin/invoices">Invoices</Link>
          <Link href="/admin/tickets">Tickets</Link>
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
