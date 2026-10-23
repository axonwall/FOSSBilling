import Link from "next/link";
import { clientApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface OrderRow {
  id: number;
  title?: string;
  price?: string | number;
  currency?: string;
  status?: string;
  expires_at?: string;
}

export default async function OrdersPage() {
  const opts = await sessionOpts();
  let rows: OrderRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<OrderRow>(await clientApi.orderList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">My orders</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error}</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Service</th>
              <th>Price</th>
              <th>Status</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/orders/${o.id}`}>
                    {o.title ?? `Order ${o.id}`}
                  </Link>
                </td>
                <td>
                  {o.price ?? ""} {o.currency ?? ""}
                </td>
                <td>{o.status ?? ""}</td>
                <td>{o.expires_at ?? ""}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="py-3 text-zinc-500" colSpan={4}>
                  No orders.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
