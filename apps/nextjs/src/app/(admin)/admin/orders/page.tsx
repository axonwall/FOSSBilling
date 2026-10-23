import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface OrderRow {
  id: number;
  title?: string;
  status?: string;
  price?: string | number;
  currency?: string;
  client?: { first_name?: string; last_name?: string; email?: string };
  client_id?: number;
  created_at?: string;
}

export default async function AdminOrdersPage() {
  const opts = await sessionOpts();
  let rows: OrderRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<OrderRow>(await adminApi.orderList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Orders</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error}</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Order</th>
              <th>Client</th>
              <th>Price</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/admin/orders/${o.id}`}>
                    {o.title ?? `Order ${o.id}`}
                  </Link>
                </td>
                <td>{o.client ? `${o.client.first_name ?? ""} ${o.client.last_name ?? ""}`.trim() || o.client.email : o.client_id}</td>
                <td>
                  {o.price} {o.currency}
                </td>
                <td>{o.status}</td>
                <td>{o.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
