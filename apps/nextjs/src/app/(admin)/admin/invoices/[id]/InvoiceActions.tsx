"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Invoice actions — admin/invoice/* via the proxy. Buttons are shown by
 *  status/flags from the detail payload; the API itself enforces. */
export default function InvoiceActions({
  invoiceId,
  status,
  deletable,
}: {
  invoiceId: number;
  status: string;
  deletable: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(method: string, params: Record<string, string | number> = {}, after?: () => void) {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "invoice", method, { id: invoiceId, ...params });
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
    if (!window.confirm("Delete this invoice? This cannot be undone.")) return;
    void run("delete", {}, () => router.push("/admin/invoices"));
  }

  const btn = "rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50";
  return (
    <div className="mt-8 flex flex-wrap gap-2">
      {status !== "paid" && (
        <button className={btn} disabled={busy} onClick={() => run("mark_as_paid")}>
          Mark as paid
        </button>
      )}
      {status === "paid" && (
        <button className={btn} disabled={busy} onClick={() => run("refund")}>
          Refund
        </button>
      )}
      {status !== "paid" && status !== "canceled" && (
        <button className={btn} disabled={busy} onClick={() => run("send_reminder")}>
          Send reminder
        </button>
      )}
      {status === "unpaid" && (
        <button className={btn} disabled={busy} onClick={() => run("cancel")}>
          Cancel invoice
        </button>
      )}
      {deletable && (
        <button className={btn} disabled={busy} onClick={del}>
          Delete
        </button>
      )}
      {message && <p className="w-full text-sm text-zinc-700">{message}</p>}
    </div>
  );
}
