"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Staff delete — admin/staff/delete via the proxy. Buttons are
 *  presentation gating only; the API itself enforces (cron accounts
 *  and hierarchy refusals surface verbatim). */
export default function StaffDeleteButton({ staffId }: { staffId: number }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function del() {
    if (!window.confirm("Delete this staff member? This cannot be undone.")) return;
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "staff", "delete", { id: staffId });
      router.push("/admin/staff");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8">
      <button className="rounded bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy} onClick={() => void del()}>
        Delete staff member
      </button>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
    </div>
  );
}
