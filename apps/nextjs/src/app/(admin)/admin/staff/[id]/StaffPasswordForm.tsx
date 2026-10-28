"use client";

import { useState } from "react";
import { fbPost } from "@/lib/browser";

/** Staff password change — admin/staff/change_password via the proxy.
 *  The API enforces strength, match, and hierarchy rules; its exact
 *  errors surface here. */
export default function StaffPasswordForm({ staffId }: { staffId: number }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", "change_password", {
        id: staffId,
        password: String(data.get("password") ?? ""),
        password_confirm: String(data.get("password_confirm") ?? ""),
      });
      setMessage("Password changed.");
      e.currentTarget.reset();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  return (
    <form onSubmit={submit} className="mt-8 space-y-3">
      <h2 className="text-lg font-semibold">Change password</h2>
      <label className="block text-sm">
        <span className="text-zinc-500">New password</span>
        <input className={input} name="password" type="password" required />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-500">Confirm password</span>
        <input className={input} name="password_confirm" type="password" required />
      </label>
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Change password
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
