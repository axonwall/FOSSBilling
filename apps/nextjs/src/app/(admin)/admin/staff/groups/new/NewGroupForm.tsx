"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Group create — admin/staff/group_create via the proxy. With no
 *  parent selected the API defaults the parent to the super-admin
 *  group; group creation itself is super-admin-only, and the API's
 *  exact refusal surfaces here. */
export default function NewGroupForm({ pairs }: { pairs: Record<string, string> }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string | number> = {};
    const name = String(data.get("name") ?? "").trim();
    if (name !== "") params["name"] = name;
    const parent = String(data.get("parent_id") ?? "").trim();
    if (parent !== "") params["parent_id"] = parent;
    setMessage(null);
    setBusy(true);
    try {
      const id = await fbPost<number>("admin", "staff", "group_create", params);
      router.push(`/admin/staff/groups/${id}`);
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
        <span className="text-zinc-500">Name</span>
        <input className={input} name="name" required />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Parent group</span>
        <select className={input} name="parent_id" defaultValue="">
          <option value="">Default (Super Administrator)</option>
          {Object.entries(pairs).map(([id, path]) => (
            <option key={id} value={id}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Create group
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
