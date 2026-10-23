import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ClientDetail {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
  company?: string;
  status?: string;
  balance?: string | number;
  currency?: string;
  created_at?: string;
  country?: string;
  city?: string;
}

export default async function AdminClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let c: ClientDetail | null = null;
  let error: string | null = null;
  try {
    c = (await adminApi.clientGet(id, opts)) as ClientDetail;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/clients" className="text-sm text-blue-700 underline">
        ← Clients
      </Link>
      {error || !c ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error ?? "Client not found."}</p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">
            {c.first_name} {c.last_name}
          </h1>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {(
              [
                ["Email", c.email],
                ["Company", c.company],
                ["Status", c.status],
                ["Balance", `${c.balance ?? ""} ${c.currency ?? ""}`],
                ["Location", [c.city, c.country].filter(Boolean).join(", ")],
                ["Client since", c.created_at],
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
