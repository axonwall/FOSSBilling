import Link from "next/link";
import { guest } from "@/lib/fossbilling";

export const dynamic = "force-dynamic";

/**
 * Client-area home (Phase 1). Renders live data from the PHP API through
 * the typed dispatcher client — guest/system/company — so this page is also
 * the smoke test that the strangler seam is wired up.
 */
export default async function ClientHome() {
  let company: Record<string, unknown> | null = null;
  let apiError: string | null = null;
  try {
    company = (await guest.company()) as Record<string, unknown>;
  } catch (e) {
    apiError = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Client area</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Next.js frontend on the FOSSBilling PHP API (Scope B strangler, Phase 1).
      </p>

      {company ? (
        <section className="mt-6 rounded-lg border bg-white p-4">
          <h2 className="font-medium">{String(company.name ?? "Company")}</h2>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
            {["email", "phone", "address", "country"].map((k) =>
              company[k] ? (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd>{String(company[k])}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </section>
      ) : (
        <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          PHP API unreachable{apiError ? `: ${apiError}` : ""}. Start FOSSBilling and set
          FOSSBILLING_URL.
        </p>
      )}

      <nav className="mt-6 flex gap-4 text-sm text-blue-700 underline">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/invoices">My invoices</Link>
        <Link href="/login">Sign in</Link>
        <Link href="/signup">Create account</Link>
        <Link href="/admin">Admin</Link>
      </nav>
    </main>
  );
}
