"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Ticket actions beyond reply — admin/support/ticket_close,
 *  ticket_update (reopen) and ticket_delete via the proxy. */
export default function TicketActions({ ticketId, status }: { ticketId: number; status: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(method: string, params: Record<string, string | number> = {}, after?: () => void) {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "support", method, { id: ticketId, ...params });
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
    if (!window.confirm("Delete this ticket? This cannot be undone.")) return;
    void run("ticket_delete", {}, () => router.push("/admin/tickets"));
  }

  const btn = "rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50";
  return (
    <div className="mt-6 flex flex-wrap gap-2">
      {status !== "closed" && (
        <button className={btn} disabled={busy} onClick={() => run("ticket_close")}>
          Close ticket
        </button>
      )}
      {status === "closed" && (
        <button className={btn} disabled={busy} onClick={() => run("ticket_update", { status: "open" })}>
          Reopen ticket
        </button>
      )}
      <button className={btn} disabled={busy} onClick={del}>
        Delete ticket
      </button>
      {message && <p className="w-full text-sm text-zinc-700">{message}</p>}
    </div>
  );
}
