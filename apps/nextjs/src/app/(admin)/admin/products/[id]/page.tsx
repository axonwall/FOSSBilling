import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Product {
  id: number;
  title?: string;
  slug?: string;
  type?: string;
  description?: string;
  unit?: string;
  status?: string;
  hidden?: boolean;
  setup?: string;
  stock_control?: boolean;
  quantity_in_stock?: number | null;
  suspension_grace_days?: number | null;
  price_starting_from?: string | number;
  category?: { id: number; title: string };
  pricing?: { type?: string; once?: { price?: unknown; setup?: unknown }; recurrent?: Record<string, { price?: unknown; setup?: unknown; title?: string }> | unknown[] };
  config?: Record<string, unknown> | unknown[];
  addons?: { id: number; title?: string }[];
  form_id?: number | null;
  created_at?: string;
  updated_at?: string;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default async function AdminProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let p: Product | null = null;
  let error: string | null = null;
  try {
    p = (await adminApi.productGet(id, opts)) as Product;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/products" className="text-sm text-blue-700 underline">
        ← Products
      </Link>
      {error || !p ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error ?? "Product not found."}</p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{p.title ?? `Product ${p.id}`}</h1>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Slug", p.slug],
                ["Type", p.type],
                ["Unit", p.unit],
                ["Status", p.status],
                ["Hidden", p.hidden ? "Yes" : "No"],
                ["Setup", p.setup],
                ["Category", p.category?.title],
                ["Starting from", p.price_starting_from],
                ["Stock control", p.stock_control ? "Yes" : "No"],
                ["Quantity in stock", p.quantity_in_stock],
                ["Suspension grace days", p.suspension_grace_days],
                ["Form", p.form_id],
                ["Created", p.created_at],
                ["Updated", p.updated_at],
              ] as [string, unknown][]
            )
              .filter(([, v]) => v !== undefined && v !== null && v !== "")
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{fmt(v)}</dd>
                </div>
              ))}
          </dl>
          {p.description ? <p className="mt-4 text-sm text-zinc-700">{p.description}</p> : null}
          {p.pricing ? (
            <section className="mt-6">
              <h2 className="text-lg font-semibold">Pricing ({p.pricing.type})</h2>
              {p.pricing.type === "recurrent" && p.pricing.recurrent && !Array.isArray(p.pricing.recurrent) ? (
                <table className="mt-2 w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-zinc-500">
                      <th className="py-2">Period</th>
                      <th>Price</th>
                      <th>Setup</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(p.pricing.recurrent).map(([code, r]) => (
                      <tr key={code} className="border-b">
                        <td className="py-2">{r.title ?? code}</td>
                        <td>{fmt(r.price)}</td>
                        <td>{fmt(r.setup)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-2 text-sm">
                  Price {fmt(p.pricing.once?.price)}, setup {fmt(p.pricing.once?.setup)}
                </p>
              )}
            </section>
          ) : null}
          {p.config && typeof p.config === "object" && !Array.isArray(p.config) && Object.keys(p.config).length > 0 ? (
            <section className="mt-6">
              <h2 className="text-lg font-semibold">Configuration</h2>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                {Object.entries(p.config).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-zinc-500">{k}</dt>
                    <dd>{fmt(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {p.addons && p.addons.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-lg font-semibold">Addons</h2>
              <ul className="mt-2 list-inside list-disc text-sm">
                {p.addons.map((a) => (
                  <li key={a.id}>{a.title ?? a.id}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="mt-6 text-sm text-zinc-500">View-only in R2c; product create/edit/delete UI is a later batch.</p>
        </>
      )}
    </main>
  );
}
