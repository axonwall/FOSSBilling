"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Group membership — admin/staff/group_member_add/remove via the
 *  proxy. The API enforces its own hierarchy rules; its exact errors
 *  surface here. */
export default function StaffGroupsForm({
  staffId,
  groups,
  pairs,
}: {
  staffId: number;
  groups: { id: number; name?: string }[];
  pairs: Record<string, string>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const memberIds = new Set(groups.map((g) => g.id));
  const addable = Object.entries(pairs).filter(([id]) => !memberIds.has(Number(id)));

  async function run(method: string, groupId: number) {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", method, { admin_id: staffId, group_id: groupId });
      setMessage("Done.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  const btn = "rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50";
  return (
    <div className="mt-8">
      <h2 className="text-lg font-semibold">Groups</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {groups.map((g) => (
          <li key={g.id} className="flex items-center gap-3">
            <span>{g.name}</span>
            <button className={btn} disabled={busy} onClick={() => run("group_member_remove", g.id)}>
              Remove
            </button>
          </li>
        ))}
        {groups.length === 0 && <li className="text-zinc-500">No groups.</li>}
      </ul>
      {addable.length > 0 && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void run("group_member_add", Number(data.get("group_id")));
          }}
        >
          <select className={input} name="group_id" required defaultValue="">
            <option value="" disabled>
              Add to group
            </option>
            {addable.map(([id, path]) => (
              <option key={id} value={id}>
                {path}
              </option>
            ))}
          </select>
          <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
            Add
          </button>
        </form>
      )}
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
    </div>
  );
}
