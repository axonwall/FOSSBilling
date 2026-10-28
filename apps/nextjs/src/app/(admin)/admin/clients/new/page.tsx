import Link from "next/link";
import NewClientForm from "./NewClientForm";

export const dynamic = "force-dynamic";

export default function AdminClientNewPage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/clients" className="text-sm text-blue-700 underline">
        ← Clients
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">New client</h1>
      <NewClientForm />
    </main>
  );
}
