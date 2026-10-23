import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import StaffReply from "./StaffReply";

export const dynamic = "force-dynamic";

interface Msg {
  id: number;
  content?: string;
  created_at?: string;
  author?: { name?: string; role?: string };
}

interface Ticket {
  id: number;
  subject?: string;
  status?: string;
  created_at?: string;
  first?: Msg;
  messages?: Msg[];
}

export default async function AdminTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let ticket: Ticket | null = null;
  let error: string | null = null;
  try {
    ticket = (await adminApi.ticketGet(id, opts)) as Ticket;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const thread: Msg[] = ticket
    ? [ticket.first, ...(ticket.messages ?? [])].filter(
        (m, i, arr): m is Msg => !!m && arr.findIndex((x) => x?.id === m.id) === i,
      )
    : [];
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/tickets" className="text-sm text-blue-700 underline">
        ← Tickets
      </Link>
      {error || !ticket ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error ?? "Ticket not found."}</p>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{ticket.subject}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {ticket.status} · opened {ticket.created_at}
          </p>
          <div className="mt-6 space-y-4">
            {thread.map((m) => (
              <article key={m.id} className="rounded-lg border bg-white p-4">
                <p className="text-xs text-zinc-500">
                  {m.author?.name ?? ""} ({m.author?.role ?? ""}) · {m.created_at}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm">{m.content}</p>
              </article>
            ))}
          </div>
          <StaffReply ticketId={ticket.id} />
        </>
      )}
    </main>
  );
}
