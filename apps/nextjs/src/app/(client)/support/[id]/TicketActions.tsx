"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Reply + close actions for a ticket (client/support/ticket_reply, ticket_close). */
export default function TicketActions({ ticketId, status }: { ticketId: number; status: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const closed = status === "closed";

  async function reply(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fbPost("client", "support", "ticket_reply", { id: ticketId, content });
      setContent("");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function close() {
    try {
      await fbPost("client", "support", "ticket_close", { id: ticketId });
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (closed) return <p className="mt-6 text-sm text-zinc-500">This ticket is closed.</p>;
  return (
    <div className="mt-6">
      <form onSubmit={reply} className="space-y-3">
        <textarea
          className="w-full rounded border px-3 py-2"
          rows={4}
          placeholder="Reply…"
          required
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex gap-3">
          <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white" type="submit">
            Reply
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded border px-4 py-2 text-sm"
          >
            Close ticket
          </button>
        </div>
      </form>
      {message && <p className="mt-3 text-sm text-red-700">{message}</p>}
    </div>
  );
}
