import Link from "next/link";
import { clientApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Profile {
  first_name?: string;
  last_name?: string;
  email?: string;
  balance?: string | number;
  currency?: string;
}

/** Authenticated client dashboard: profile + headline counts. */
export default async function DashboardPage() {
  const opts = await sessionOpts();
  let profile: Profile | null = null;
  let error: string | null = null;
  let counts = { invoices: 0, orders: 0, tickets: 0 };
  try {
    profile = (await clientApi.profile(opts)) as Profile;
    const [inv, ord, tic] = await Promise.all([
      clientApi.invoiceList({ page: 1, per_page: 1 }, opts),
      clientApi.orderList({ page: 1, per_page: 1 }, opts),
      clientApi.ticketList({ page: 1, per_page: 1 }, opts),
    ]);
    counts = { invoices: listOf(inv).total, orders: listOf(ord).total, tickets: listOf(tic).total };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !profile) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Not signed in."} Please <Link className="underline" href="/login">sign in</Link>.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">
        Welcome, {profile.first_name} {profile.last_name}
      </h1>
      <p className="mt-1 text-sm text-zinc-600">{profile.email}</p>
      <div className="mt-6 grid grid-cols-3 gap-4">
        {[
          ["Orders", counts.orders, "/orders"],
          ["Invoices", counts.invoices, "/invoices"],
          ["Support tickets", counts.tickets, "/support"],
        ].map(([label, n, href]) => (
          <Link key={href as string} href={href as string} className="rounded-lg border bg-white p-4">
            <div className="text-2xl font-semibold">{n as number}</div>
            <div className="text-sm text-zinc-500">{label as string}</div>
          </Link>
        ))}
      </div>
      {profile.balance !== undefined && (
        <p className="mt-4 text-sm">
          Balance: {String(profile.balance)} {profile.currency ?? ""}
        </p>
      )}
    </main>
  );
}
