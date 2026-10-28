"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Group members — admin/staff/group_member_add/remove via the proxy.
 *  In readOnly mode (protected groups) the list renders without any
 *  mutation controls. */
export default function GroupMembersForm({
  groupId,
  members,
  staffPairs,
  readOnly = false,
}: {
  groupId: number;
  members: { id: number; name?: string; email?: string }[];
  staffPairs?: Record<string, string>;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const memberIds = new Set(members.map((m) => m.id));
  const addable = Object.entries(staffPairs ?? {}).filter(([id]) => !memberIds.has(Number(id)));

  async function run(method: string, adminId: number) {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", method, { admin_id: adminId, group_id: groupId });
      setMessage("Done.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      <h2 className="text-lg font-semibold">Members</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3">
            <span>
              {m.name} ({m.email})
            </span>
            {!readOnly && (
              <button
                className="rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                disabled={busy}
                onClick={() => run("group_member_remove", m.id)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
        {members.length === 0 && <li className="text-zinc-500">No members.</li>}
      </ul>
      {!readOnly && addable.length > 0 && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void run("group_member_add", Number(data.get("admin_id")));
          }}
        >
          <select className="w-full rounded border px-3 py-2" name="admin_id" required defaultValue="">
            <option value="" disabled>
              Add member
            </option>
            {addable.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
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
