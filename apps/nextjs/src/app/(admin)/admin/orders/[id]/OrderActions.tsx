"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Order actions — admin/order/* via the proxy. Buttons shown follow the
 *  order's current status; the API itself enforces (e.g. suspend on a
 *  non-active order errors with its exact message). */
export default function OrderActions({ orderId, status }: { orderId: number; status: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(method: string, params: Record<string, string | number> = {}, after?: () => void) {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "order", method, { id: orderId, ...params });
      setMessage("Done.");
      after?.();
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function del() {
    if (!window.confirm("Delete this order? This cannot be undone.")) return;
    void run("delete", {}, () => router.push("/admin/orders"));
  }

  const btn = "rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50";
  return (
    <div className="mt-8 space-y-3">
      <div className="flex flex-wrap gap-2">
        {(status === "pending_setup" || status === "failed_setup") && (
          <button className={btn} disabled={busy} onClick={() => run("activate")}>
            Activate
          </button>
        )}
        {status === "active" && (
          <>
            <button className={btn} disabled={busy} onClick={() => run("suspend", reason ? { reason } : {})}>
              Suspend
            </button>
            <button className={btn} disabled={busy} onClick={() => run("renew")}>
              Renew
            </button>
          </>
        )}
        {status === "suspended" && (
          <button className={btn} disabled={busy} onClick={() => run("unsuspend")}>
            Unsuspend
          </button>
        )}
        {status !== "canceled" && (
          <button className={btn} disabled={busy} onClick={() => run("cancel", reason ? { reason } : {})}>
            Cancel
          </button>
        )}
        {status === "canceled" && (
          <button className={btn} disabled={busy} onClick={() => run("uncancel")}>
            Uncancel
          </button>
        )}
        <button className={btn} disabled={busy} onClick={del}>
          Delete
        </button>
      </div>
      <label className="block text-sm">
        <span className="text-zinc-500">Reason (suspend / cancel, optional)</span>
        <input
          className="w-full rounded border px-3 py-2"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {message && <p className="text-sm text-zinc-700">{message}</p>}
    </div>
  );
}
