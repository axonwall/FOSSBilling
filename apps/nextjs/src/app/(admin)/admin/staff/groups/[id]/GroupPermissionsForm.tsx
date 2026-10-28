"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";
import { MATRIX_MODULES, PERMISSION_CATALOG } from "@/lib/permission-catalog";

type PermState = Record<string, Record<string, boolean>>;

/** Permissions matrix — admin/staff/group_update via the proxy. Like
 *  the PHP group form, only checked boxes are submitted (unchecked
 *  keys are omitted, which the permission check treats as denied).
 *  Permission entries for modules outside the matrix are preserved
 *  verbatim so saving never drops data the form cannot display. */
export default function GroupPermissionsForm({
  groupId,
  initial,
}: {
  groupId: number;
  initial: Record<string, Record<string, unknown>>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<PermState>(() => {
    const out: PermState = {};
    for (const mod of MATRIX_MODULES) {
      const cur = initial[mod] ?? {};
      const row: Record<string, boolean> = { access: cur["access"] === true };
      for (const def of PERMISSION_CATALOG[mod] ?? []) {
        row[def.key] = cur[def.key] === true;
      }
      out[mod] = row;
    }
    return out;
  });

  function toggle(mod: string, key: string) {
    setState((prev) => ({ ...prev, [mod]: { ...prev[mod], [key]: !prev[mod]?.[key] } }));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const out: Record<string, Record<string, boolean>> = {};
    for (const [mod, row] of Object.entries(initial)) {
      if (!MATRIX_MODULES.includes(mod)) {
        const kept: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(row)) {
          if (v === true) kept[k] = true;
        }
        if (Object.keys(kept).length > 0) out[mod] = kept;
      }
    }
    for (const mod of MATRIX_MODULES) {
      const row = state[mod] ?? {};
      const kept: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(row)) {
        if (v) kept[k] = true;
      }
      if (Object.keys(kept).length > 0) out[mod] = kept;
    }
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", "group_update", {
        id: groupId,
        permissions: JSON.stringify(out),
      });
      setMessage("Permissions saved.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-6">
      <h2 className="text-lg font-semibold">Permissions</h2>
      {MATRIX_MODULES.map((mod) => {
        const row = state[mod] ?? {};
        const defs = PERMISSION_CATALOG[mod] ?? [];
        return (
          <div key={mod} className="rounded border p-4">
            <div className="font-medium">{mod}</div>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={row["access"] === true} onChange={() => toggle(mod, "access")} />
              Module access
            </label>
            {defs.map((def) => (
              <label key={def.key} className="mt-1 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={row[def.key] === true} onChange={() => toggle(mod, def.key)} />
                {def.display}
              </label>
            ))}
          </div>
        );
      })}
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Save permissions
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
