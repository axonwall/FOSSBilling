"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Staff create — admin/staff/create via the proxy. The API requires
 *  email + password + name + group_id and enforces its own hierarchy
 *  rules (a non-super actor can only create into descendant groups);
 *  its exact errors surface here. The form defaults status to active;
 *  the API itself defaults to inactive when status is omitted. */
export default function NewStaffForm({ groups }: { groups: Record<string, string> }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string | number> = {};
    for (const [k, v] of data.entries()) {
      const s = String(v).trim();
      if (s !== "") params[k] = s;
    }
    setMessage(null);
    setBusy(true);
    try {
      const id = await fbPost<number>("admin", "staff", "create", params);
      router.push(`/admin/staff/${id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <label className="block text-sm">
        <span className="text-zinc-500">Email</span>
        <input className={input} name="email" type="email" required />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Name</span>
        <input className={input} name="name" required />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Password</span>
        <input className={input} name="password" type="password" required />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Group</span>
        <select className={input} name="group_id" required defaultValue="">
          <option value="" disabled>
            Select a group
          </option>
          {Object.entries(groups).map(([id, path]) => (
            <option key={id} value={id}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Status</span>
        <select className={input} name="status" defaultValue="active">
          <option value="active">active</option>
          <option value="inactive">inactive</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Signature</span>
        <input className={input} name="signature" />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Timezone</span>
        <input className={input} name="timezone" placeholder="e.g. America/Chicago" />
      </label>
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Create staff member
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
