import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import RefreshRatesButton from "./RefreshRatesButton";

export const dynamic = "force-dynamic";

interface CurrencyRow {
  code?: string;
  name?: string;
  symbol?: string;
  conversion_rate?: number | string;
  is_rate_manual?: boolean;
  format_pattern?: string | null;
  fraction_digits?: number | null;
  default?: boolean;
}

/** Currency list + rates + refresh, from the TS currency endpoints. */
export default async function CurrenciesPage() {
  const opts = await sessionOpts();
  let list: CurrencyRow[] = [];
  let defaultCode: string | null = null;
  let error: string | null = null;
  try {
    const res = await adminApi.currencyList({ per_page: 100 }, opts);
    list = (res.list ?? []) as CurrencyRow[];
    const def = await adminApi.currencyGetDefault(opts);
    defaultCode = typeof def.code === "string" ? def.code : null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    const session = await readSession(opts.cookieHeader ?? null);
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Currencies</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error}
          {!session?.admin ? (
            <>
              {" "}
              Please{" "}
              <Link className="underline" href="/admin/login">
                sign in as staff
              </Link>
              .
            </>
          ) : null}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Currencies</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Default currency: {defaultCode ?? "—"}. Refresh pins the default
        to 1.0 and skips manual-rate currencies; the rest come from the
        configured rate provider.
      </p>
      <div className="mt-4">
        <RefreshRatesButton />
      </div>
      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 pr-4">Code</th>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Symbol</th>
            <th className="py-2 pr-4">Rate</th>
            <th className="py-2 pr-4">Manual</th>
            <th className="py-2 pr-4">Format</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.code} className="border-t">
              <td className="py-2 pr-4 font-medium">{c.code}</td>
              <td className="py-2 pr-4">{c.name}</td>
              <td className="py-2 pr-4">{c.symbol}</td>
              <td className="py-2 pr-4">{String(c.conversion_rate ?? "")}</td>
              <td className="py-2 pr-4">{c.is_rate_manual ? "yes" : "no"}</td>
              <td className="py-2 pr-4">{c.format_pattern ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-6 text-sm text-zinc-600">
        Currency create, edit, and delete UI is a later batch; the
        endpoints already exist.
      </p>
    </main>
  );
}
