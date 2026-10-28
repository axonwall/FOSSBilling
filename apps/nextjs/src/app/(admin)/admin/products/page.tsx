import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { listOf, sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ProductRow {
  id: number;
  title?: string;
  slug?: string;
  type?: string;
  status?: string;
  price_starting_from?: string | number;
}

export default async function AdminProductsPage() {
  const opts = await sessionOpts();
  let rows: ProductRow[] = [];
  let error: string | null = null;
  try {
    rows = listOf<ProductRow>(await adminApi.productList({ page: 1, per_page: 50 }, opts)).list;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Products</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.
        </p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b text-zinc-500">
              <th className="py-2">Title</th>
              <th>Type</th>
              <th>Status</th>
              <th>Starting from</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b">
                <td className="py-2">
                  <Link className="text-blue-700 underline" href={`/admin/products/${p.id}`}>
                    {p.title ?? p.id}
                  </Link>
                </td>
                <td>{p.type}</td>
                <td>{p.status}</td>
                <td>{p.price_starting_from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
