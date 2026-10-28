"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Group details — admin/staff/group_update via the proxy. Parent
 *  options exclude the group itself and its descendants (paths under
 *  the group's own path), mirroring PHP's getParentPairs exclusion;
 *  an empty parent posts as null. */
export default function GroupDetailsForm({
  groupId,
  initialName,
  parentId,
  pairs,
  selfPath,
}: {
  groupId: number;
  initialName: string;
  parentId: number | null;
  pairs: Record<string, string>;
  selfPath: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = Object.entries(pairs).filter(
    ([id, path]) => Number(id) !== groupId && !path.startsWith(`${selfPath} / `),
  );

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string | number> = { id: groupId };
    const name = String(data.get("name") ?? "").trim();
    if (name !== "") params["name"] = name;
    const parent = String(data.get("parent_id") ?? "").trim();
    params["parent_id"] = parent;
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", "group_update", params);
      setMessage("Saved.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  return (
    <form onSubmit={submit} className="mt-8 space-y-3">
      <h2 className="text-lg font-semibold">Details</h2>
      <label className="block text-sm">
        <span className="text-zinc-500">Name</span>
        <input className={input} name="name" required defaultValue={initialName} />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Parent group</span>
        <select className={input} name="parent_id" defaultValue={parentId === null ? "" : String(parentId)}>
          <option value="">No parent</option>
          {options.map(([id, path]) => (
            <option key={id} value={id}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Save details
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
