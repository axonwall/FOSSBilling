import Link from "next/link";
import { clientApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Order {
  id: number;
  title?: string;
  status?: string;
  price?: string | number;
  currency?: string;
  period?: string;
  quantity?: number;
  expires_at?: string;
  activated_at?: string;
  created_at?: string;
  service_type?: string;
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let order: Order | null = null;
  let error: string | null = null;
  try {
    order = (await clientApi.orderGet(id, opts)) as Order;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/orders" className="text-sm text-blue-700 underline">
        ← Orders
      </Link>
      {error || !order ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Order not found."}
        </p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{order.title ?? `Order ${order.id}`}</h1>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Status", order.status],
                ["Price", `${order.price ?? ""} ${order.currency ?? ""}`],
                ["Period", order.period],
                ["Quantity", order.quantity],
                ["Service type", order.service_type],
                ["Activated", order.activated_at],
                ["Expires", order.expires_at],
                ["Created", order.created_at],
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
