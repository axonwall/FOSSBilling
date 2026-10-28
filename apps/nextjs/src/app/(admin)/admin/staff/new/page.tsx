import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";
import NewStaffForm from "./NewStaffForm";

export const dynamic = "force-dynamic";

export default async function AdminStaffNewPage() {
  const opts = await sessionOpts();
  let pairs: Record<string, string> = {};
  let error: string | null = null;
  try {
    pairs = (await adminApi.staffGroupPairs(opts)) as Record<string, string>;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/admin/staff" className="text-sm text-blue-700 underline">
        ← Staff
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">New staff member</h1>
      {error ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">{error} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.</p>
      ) : (
        <NewStaffForm groups={pairs} />
      )}
    </main>
  );
}
