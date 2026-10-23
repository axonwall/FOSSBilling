import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Order {
  id: number;
  title?: string;
  status?: string;
  price?: string | number;
  currency?: string;
  period?: string;
  expires_at?: string;
  created_at?: string;
  client?: { first_name?: string; last_name?: string; email?: string };
}

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let o: Order | null = null;
  let error: string | null = null;
  try {
    o = (await adminApi.orderGet(id, opts)) as Order;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/orders" className="text-sm text-blue-700 underline">
        ← Orders
      </Link>
      {error || !o ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error ?? "Order not found."}</p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{o.title ?? `Order ${o.id}`}</h1>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Client", o.client ? `${o.client.first_name ?? ""} ${o.client.last_name ?? ""} (${o.client.email ?? ""})` : undefined],
                ["Status", o.status],
                ["Price", `${o.price ?? ""} ${o.currency ?? ""}`],
                ["Period", o.period],
                ["Expires", o.expires_at],
                ["Created", o.created_at],
              ] as [string, unknown][]
            )
              .filter(([, v]) => v !== undefined && v !== null && v !== "")
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
          </dl>
        </>
      )}
    </main>
  );
}
