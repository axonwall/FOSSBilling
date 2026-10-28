import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import type { CallOptions } from "@/lib/fossbilling";

export const dynamic = "force-dynamic";

type Settled<T> = PromiseSettledResult<T>;

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function sectionError<T>(r: Settled<T>): string | null {
  return r.status === "rejected"
    ? r.reason instanceof Error
      ? r.reason.message
      : String(r.reason)
    : null;
}

function seriesTable(
  title: string,
  r: Settled<[number, number][]>,
): React.ReactNode {
  const err = sectionError(r);
  if (err) {
    return (
      <section className="mt-8">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-amber-700">{err}</p>
      </section>
    );
  }
  const points = (r as PromiseFulfilledResult<[number, number][]>).value;
  const last = points.slice(-14);
  const total = points.reduce((s, [, v]) => s + v, 0);
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Last 14 days of the default window; period total {total}.
      </p>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {last.map(([ts, v]) => (
            <tr key={ts} className="border-t">
              <td className="py-1 pr-4">{fmtDate(ts)}</td>
              <td className="py-1">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function mapTable(
  title: string,
  r: Settled<Record<string, number>>,
): React.ReactNode {
  const err = sectionError(r);
  if (err) {
    return (
      <section className="mt-8">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-amber-700">{err}</p>
      </section>
    );
  }
  const map = (r as PromiseFulfilledResult<Record<string, number>>).value;
  const rows = Object.entries(map).sort(([, a], [, b]) => b - a);
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{title}</h2>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t">
              <td className="py-1 pr-4">{k}</td>
              <td className="py-1">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Statistics: the deeper stats endpoints beyond the dashboard's
 * summary + order statuses. Default date window (last month → tomorrow)
 * throughout; no date picker in R2e.
 */
export default async function StatsPage() {
  const opts: CallOptions = await sessionOpts();
  const [
    incomeSummary,
    incomeVsRefunds,
    productSummary,
    productSales,
    incomeSeries,
    refundsSeries,
    ordersSeries,
    clientsSeries,
    invoicesSeries,
    ticketsSeries,
    clientCountries,
    salesCountries,
  ] = await Promise.allSettled([
    adminApi.statsSummaryIncome(opts),
    adminApi.statsIncomeVsRefunds(opts),
    adminApi.statsProductSummary(opts),
    adminApi.statsProductSales({}, opts),
    adminApi.statsIncome({}, opts),
    adminApi.statsRefunds({}, opts),
    adminApi.statsOrders({}, opts),
    adminApi.statsClients({}, opts),
    adminApi.statsInvoices({}, opts),
    adminApi.statsTickets({}, opts),
    adminApi.statsClientCountries({ limit: 10 }, opts),
    adminApi.statsSalesCountries({ limit: 10 }, opts),
  ]);

  // If every call failed, show one box instead of twelve error notes.
  // Logged-out viewers get the sign-in link; logged-in viewers without
  // stats access get the API error itself (a sign-in link would be
  // wrong for them — they are signed in, just denied).
  const session = await readSession(opts.cookieHeader ?? null);
  const allFailed = [
    incomeSummary,
    incomeVsRefunds,
    productSummary,
    productSales,
    incomeSeries,
    refundsSeries,
    ordersSeries,
    clientsSeries,
    invoicesSeries,
    ticketsSeries,
    clientCountries,
    salesCountries,
  ].every((r) => r.status === "rejected");
  if (allFailed) {
    const err = sectionError(incomeSummary);
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Statistics</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {err ?? "Not signed in."}
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

  const income =
    incomeSummary.status === "fulfilled"
      ? (incomeSummary.value as Record<string, number>)
      : null;
  const vsRefunds =
    incomeVsRefunds.status === "fulfilled"
      ? (incomeVsRefunds.value as { income?: number; refund?: number })
      : null;
  const products =
    productSummary.status === "fulfilled"
      ? (productSummary.value as { id?: number; title?: string; orders?: number }[])
      : null;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Statistics</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Income, products, per-day series, and country breakdowns. The
        dashboard already shows totals and order statuses.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Income summary</h2>
        {income ? (
          <table className="mt-3 w-full text-sm">
            <tbody>
              {Object.entries(income).map(([k, v]) => (
                <tr key={k} className="border-t">
                  <td className="py-1 pr-4">{k}</td>
                  <td className="py-1">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-sm text-amber-700">
            {sectionError(incomeSummary)}
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Income vs refunds</h2>
        {vsRefunds ? (
          <table className="mt-3 w-full text-sm">
            <tbody>
              <tr className="border-t">
                <td className="py-1 pr-4">income</td>
                <td className="py-1">{vsRefunds.income ?? ""}</td>
              </tr>
              <tr className="border-t">
                <td className="py-1 pr-4">refund</td>
                <td className="py-1">{vsRefunds.refund ?? ""}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-sm text-amber-700">
            {sectionError(incomeVsRefunds)}
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Products by active orders</h2>
        {products ? (
          <table className="mt-3 w-full text-sm">
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-1 pr-4">{p.title}</td>
                  <td className="py-1">{p.orders}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-sm text-amber-700">
            {sectionError(productSummary)}
          </p>
        )}
      </section>

      {mapTable("Product sales (default window)", productSales)}
      {seriesTable("Income per day", incomeSeries)}
      {seriesTable("Refunds per day", refundsSeries)}
      {seriesTable("Orders per day", ordersSeries)}
      {seriesTable("Clients per day", clientsSeries)}
      {seriesTable("Invoices per day", invoicesSeries)}
      {seriesTable("Tickets per day", ticketsSeries)}
      {mapTable("Clients by country", clientCountries)}
      {mapTable("Sales by country", salesCountries)}
    </main>
  );
}
