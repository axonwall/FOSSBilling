"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Staff reply — admin/support/ticket_reply via the proxy. */
export default function StaffReply({ ticketId }: { ticketId: number }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fbPost("admin", "support", "ticket_reply", { id: ticketId, content });
      setContent("");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <textarea
        className="w-full rounded border px-3 py-2"
        rows={4}
        placeholder="Reply as staff…"
        required
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white" type="submit">
        Reply
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
