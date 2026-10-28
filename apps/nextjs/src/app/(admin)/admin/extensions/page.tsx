import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import { REGISTRY_BY_ID } from "@/server/extension-registry";
import ExtensionActions from "./ExtensionActions";

export const dynamic = "force-dynamic";

/**
 * Extension list, Phase 5 R4b. Read path (deliberate): the page reads
 * via fbCall to the PHP origin — the established page-read pattern, so
 * PHP's guards apply on reads — then filters in-process to the TS
 * registry. PHP's get_list includes modules the TS seam cannot manage
 * (branding installed; embed available; api/orderbutton/theme core),
 * and the UI manages in-tree modules ONLY (D4-6): filtering here is
 * what guarantees no action button is ever offered for a PHP-only
 * module. No single get_list mode covers all three states, so the page
 * merges two calls: active=1 (core + installed) then default
 * (installed + available), deduplicated by id.
 *
 * NO install/upload UI exists on this page, by design (D4-6):
 * installing external code is abolished with remote installs.
 */
interface ExtensionEntry {
  id: string;
  name: string;
  description?: string | null;
  version?: string | null;
  status: string | null;
  has_settings?: boolean;
}

function statusLabel(status: string | null): string {
  if (status === "core") return "Core";
  if (status === "installed") return "Installed";
  return "Available";
}

export default async function ExtensionsPage() {
  const opts = await sessionOpts();
  let entries: ExtensionEntry[] | null = null;
  let error: string | null = null;
  try {
    const active = (await adminApi.extensionGetList({ active: 1 }, opts)) as ExtensionEntry[];
    const def = (await adminApi.extensionGetList({}, opts)) as ExtensionEntry[];
    const seen = new Set<string>();
    const merged: ExtensionEntry[] = [];
    for (const e of [...active, ...def]) {
      if (!REGISTRY_BY_ID.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    entries = merged;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !entries) {
    const session = await readSession(opts.cookieHeader ?? null);
    return (
      <main className="mx-auto max-w-4xl p-8">
        <h1 className="text-2xl font-semibold">Extensions</h1>
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

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Extensions</h1>
      <p className="mt-1 text-sm text-zinc-600">
        This page manages in-tree modules only. Modules installed from
        PHP that have no Next.js port (for example branding) are not
        shown here and cannot be activated, deactivated, or configured
        from this page. There is no install or upload action: installing
        external code is abolished with remote installs.
      </p>
      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 pr-4">Module</th>
            <th className="py-2 pr-4">Version</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t align-top">
              <td className="py-2 pr-4">
                <Link className="font-medium text-blue-700 underline" href={`/admin/extensions/${e.id}`}>
                  {e.name}
                </Link>
                {e.description ? <div className="text-zinc-600">{e.description}</div> : null}
              </td>
              <td className="py-2 pr-4">{e.version ?? ""}</td>
              <td className="py-2 pr-4">{statusLabel(e.status)}</td>
              <td className="py-2">
                <ExtensionActions id={e.id} status={e.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
