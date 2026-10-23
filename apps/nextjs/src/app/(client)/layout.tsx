import Link from "next/link";
import LogoutButton from "@/components/LogoutButton";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <header className="border-b bg-white">
        <nav className="mx-auto flex max-w-3xl items-center gap-4 p-4 text-sm">
          <Link href="/" className="font-semibold">
            FOSSBilling
          </Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/orders">Orders</Link>
          <Link href="/invoices">Invoices</Link>
          <Link href="/support">Support</Link>
          <span className="ml-auto flex gap-4">
            <Link href="/login">Sign in</Link>
            <LogoutButton />
          </span>
        </nav>
      </header>
      {children}
    </div>
  );
}
