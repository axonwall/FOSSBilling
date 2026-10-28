"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

export interface StaffEditable {
  email?: string;
  name?: string;
  signature?: string | null;
  timezone?: string | null;
  status?: string;
}

/** Staff edit — admin/staff/update via the proxy. All fields are posted
 *  explicitly (signature may clear to empty); a blank timezone is
 *  omitted so it leaves the stored value unchanged. The API enforces
 *  its own hierarchy rules and the self-deactivation refusal; its
 *  exact errors surface here. */
export default function StaffEditForm({
  staffId,
  initial,
}: {
  staffId: number;
  initial: StaffEditable;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string | number> = { id: staffId };
    for (const k of ["email", "name", "signature", "status"]) {
      params[k] = String(data.get(k) ?? "");
    }
    const tz = String(data.get("timezone") ?? "").trim();
    if (tz !== "") params["timezone"] = tz;
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", "update", params);
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
      <h2 className="text-lg font-semibold">Edit staff member</h2>
      <label className="block text-sm">
        <span className="text-zinc-500">Email</span>
        <input className={input} name="email" type="email" required defaultValue={initial.email ?? ""} />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Name</span>
        <input className={input} name="name" required defaultValue={initial.name ?? ""} />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Signature</span>
        <input className={input} name="signature" defaultValue={initial.signature ?? ""} />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Timezone</span>
        <input className={input} name="timezone" defaultValue={initial.timezone ?? ""} />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Status</span>
        <select className={input} name="status" defaultValue={initial.status ?? "active"}>
          <option value="active">active</option>
          <option value="inactive">inactive</option>
        </select>
      </label>
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Save changes
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
