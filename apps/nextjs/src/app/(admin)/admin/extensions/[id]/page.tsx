import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import { readSession } from "@/server/session";
import { REGISTRY_BY_ID } from "@/server/extension-registry";
import ExtensionActions from "../ExtensionActions";
import ConfigForm from "../ConfigForm";

export const dynamic = "force-dynamic";

/** Extension detail + config, Phase 5 R4b. Same read path as the list
 * page (fbCall to PHP, merged active + default modes, filtered to the
 * registry); an unknown id renders an error box, never a crash. The
 * config editor appears only for modules that declare a settings page
 * (has_settings from PHP's render); for those, the current config is
 * read via config_get and edited as a full-config JSON document (see
 * ConfigForm for why a field-subset editor would be destructive). A
 * config read that fails (for example a 403 from the seam's
 * hasManagePermission) renders its message inline instead of the form
 * — the seam, not UI hiding, is the enforcement point. */
interface ExtensionEntry {
  id: string;
  name: string;
  description?: string | null;
  homepage_url?: string | null;
  author?: string | null;
  license?: string | null;
  version?: string | null;
  status: string | null;
  has_settings?: boolean;
}

function statusLabel(status: string | null): string {
  if (status === "core") return "Core";
  if (status === "installed") return "Installed";
  return "Available";
}

export default async function ExtensionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let entry: ExtensionEntry | null = null;
  let error: string | null = null;
  try {
    const active = (await adminApi.extensionGetList({ active: 1 }, opts)) as ExtensionEntry[];
    const def = (await adminApi.extensionGetList({}, opts)) as ExtensionEntry[];
    const seen = new Set<string>();
    for (const e of [...active, ...def]) {
      if (!REGISTRY_BY_ID.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.id === id) entry = e;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !entry) {
    const session = await readSession(opts.cookieHeader ?? null);
    return (
      <main className="mx-auto max-w-4xl p-8">
        <Link href="/admin/extensions" className="text-sm text-blue-700 underline">
          ← Extensions
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Extension</h1>
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? `Unknown extension: ${id}.`}
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

  const e = entry;
  let config: Record<string, unknown> | null = null;
  let configError: string | null = null;
  if (e.has_settings) {
    try {
      const cfg = (await adminApi.extensionConfigGet(`mod_${e.id}`, opts)) as Record<string, unknown>;
      const { ext: _ext, ...rest } = cfg;
      void _ext;
      config = rest;
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/extensions" className="text-sm text-blue-700 underline">
        ← Extensions
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">{e.name}</h1>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="font-medium">Status</dt>
        <dd>{statusLabel(e.status)}</dd>
        <dt className="font-medium">Version</dt>
        <dd>{e.version ?? ""}</dd>
        <dt className="font-medium">Author</dt>
        <dd>{e.author ?? ""}</dd>
        <dt className="font-medium">License</dt>
        <dd>{e.license ?? ""}</dd>
        <dt className="font-medium">Description</dt>
        <dd>{e.description ?? ""}</dd>
      </dl>
      <div className="mt-6">
        <ExtensionActions id={e.id} status={e.status} />
      </div>
      <section className="mt-10">
        <h2 className="text-lg font-semibold">Configuration</h2>
        {!e.has_settings ? (
          <p className="mt-2 text-sm text-zinc-600">
            This module declares no settings page, so there is no
            configuration to edit here.
          </p>
        ) : configError ? (
          <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{configError}</p>
        ) : config !== null ? (
          <>
            <p className="mt-2 text-sm text-zinc-600">
              The full configuration as one JSON document. Saving
              replaces the stored configuration wholesale, so every key
              must be present — nothing is merged.
            </p>
            <ConfigForm ext={`mod_${e.id}`} initial={config} />
          </>
        ) : null}
      </section>
    </main>
  );
}
