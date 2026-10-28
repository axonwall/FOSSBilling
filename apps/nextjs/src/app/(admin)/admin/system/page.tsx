import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import { EDITABLE_PARAM_NAMES } from "@/lib/system-settings-fields";
import SettingsForm from "./SettingsForm";

export const dynamic = "force-dynamic";

/** System settings: admin/system/get_params + the R2e edit form. */
export default async function SystemSettingsPage() {
  const opts = await sessionOpts();
  let params: Record<string, string | null> | null = null;
  let error: string | null = null;
  try {
    params = (await adminApi.systemGetParams(opts)) as Record<string, string | null>;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !params) {
    const session = await readSession(opts.cookieHeader ?? null);
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">System settings</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Not signed in."}
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

  const editable = new Set(EDITABLE_PARAM_NAMES);
  const readonly = Object.entries(params)
    .filter(([k]) => !editable.has(k))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">System settings</h1>
      <p className="mt-1 text-sm text-zinc-600">
        <Link className="underline" href="/admin/system/currencies">
          Currencies
        </Link>{" "}
        ·{" "}
        <Link className="underline" href="/admin/system/stats">
          Statistics
        </Link>
      </p>
      <SettingsForm initial={params} />
      <section className="mt-10">
        <h2 className="text-lg font-semibold">System-managed values (read-only)</h2>
        <p className="mt-1 text-sm text-zinc-600">
          These rows are maintained by the system (install state, sync
          timestamps, theme) and are not edited by this form.
        </p>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {readonly.map(([k, v]) => (
              <tr key={k} className="border-t">
                <td className="py-2 pr-4 align-top font-medium">{k}</td>
                <td className="py-2 break-all text-zinc-600">{v ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="mt-8 text-sm text-zinc-600">
        Locale, cache, and extension settings live in config.php and are
        managed by the installer (Phase 5 R5); they are intentionally
        not editable here. Extension install and configuration UI is
        deferred to Phase 5 R4, which replaces the extension mechanism.
      </p>
    </main>
  );
}
