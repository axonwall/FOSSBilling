import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Summary {
  clients_total?: number;
  clients_today?: number;
  orders_total?: number;
  orders_today?: number;
  invoices_total?: number;
  invoices_today?: number;
  tickets_total?: number;
}

/** Admin dashboard: admin/stats summary + order-status breakdown. */
export default async function AdminHome() {
  const opts = await sessionOpts();
  let summary: Summary | null = null;
  let statuses: Record<string, number> | null = null;
  let staff: { name?: string; email?: string } | null = null;
  let error: string | null = null;
  try {
    staff = (await adminApi.profile(opts)) as { name?: string; email?: string };
    summary = (await adminApi.statsSummary(opts)) as Summary;
    statuses = (await adminApi.statsOrderStatuses(opts)) as Record<string, number>;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !summary) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Not signed in."} Please{" "}
          <Link className="underline" href="/admin/login">
            sign in as staff
          </Link>
          .
        </p>
      </main>
    );
  }

  const cards: [string, number | undefined, number | undefined][] = [
    ["Clients", summary.clients_total, summary.clients_today],
    ["Orders", summary.orders_total, summary.orders_today],
    ["Invoices", summary.invoices_total, summary.invoices_today],
  ];
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Admin dashboard</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Signed in as {staff?.name} ({staff?.email})
      </p>
      <div className="mt-6 grid grid-cols-3 gap-4">
        {cards.map(([label, total, today]) => (
          <div key={label} className="rounded-lg border bg-white p-4">
            <div className="text-2xl font-semibold">{total ?? "—"}</div>
            <div className="text-sm text-zinc-500">
              {label} · {today ?? 0} today
            </div>
          </div>
        ))}
      </div>
      {statuses && (
        <div className="mt-6 rounded-lg border bg-white p-4">
          <h2 className="text-sm font-semibold text-zinc-500">Orders by status</h2>
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            {Object.entries(statuses).map(([k, v]) => (
              <span key={k}>
                {k}: <strong>{v}</strong>
              </span>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
