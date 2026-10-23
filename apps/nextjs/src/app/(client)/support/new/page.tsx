"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** New support ticket — client/support/ticket_create via the proxy. */
export default function NewTicketPage() {
  const router = useRouter();
  const [helpdesks, setHelpdesks] = useState<Record<string, string>>({});
  const [helpdeskId, setHelpdeskId] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/fb/client/support/helpdesk_get_pairs", { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.result) {
          setHelpdesks(j.result);
          const first = Object.keys(j.result)[0];
          if (first) setHelpdeskId(first);
        }
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const id = await fbPost<number>("client", "support", "ticket_create", {
        support_helpdesk_id: helpdeskId,
        subject,
        content,
      });
      router.push(`/support/${id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-semibold">New ticket</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <select
          className="w-full rounded border px-3 py-2"
          value={helpdeskId}
          onChange={(e) => setHelpdeskId(e.target.value)}
          required
        >
          {Object.entries(helpdesks).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input
          className="w-full rounded border px-3 py-2"
          placeholder="Subject"
          required
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <textarea
          className="w-full rounded border px-3 py-2"
          placeholder="How can we help?"
          required
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <button className="rounded bg-zinc-900 px-4 py-2 text-white" type="submit">
          Open ticket
        </button>
      </form>
      {message && <p className="mt-4 text-sm text-red-700">{message}</p>}
    </main>
  );
}
