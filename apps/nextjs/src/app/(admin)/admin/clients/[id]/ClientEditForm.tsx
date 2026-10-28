"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

export interface ClientEditable {
  email?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  company_vat?: string;
  company_number?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  phone_cc?: string;
  phone?: string;
  currency?: string;
  status?: string;
  lang?: string;
  timezone?: string;
  notes?: string;
}

const FIELDS: [keyof ClientEditable, string][] = [
  ["email", "Email"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["company", "Company"],
  ["company_vat", "Company VAT"],
  ["company_number", "Company number"],
  ["address_1", "Address 1"],
  ["address_2", "Address 2"],
  ["city", "City"],
  ["state", "State"],
  ["postcode", "Postcode"],
  ["country", "Country (2-letter)"],
  ["phone_cc", "Phone country code"],
  ["phone", "Phone"],
  ["currency", "Currency (3-letter)"],
  ["status", "Status"],
  ["lang", "Language"],
  ["timezone", "Timezone"],
  ["notes", "Notes"],
];

/** Client edit — admin/client/update via the proxy. Only non-empty
 *  fields are posted (clearing a field is not supported by this form);
 *  the API validates and its exact errors surface here. */
export default function ClientEditForm({ clientId, initial }: { clientId: number; initial: ClientEditable }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string | number> = { id: clientId };
    for (const [k, v] of data.entries()) {
      const s = String(v).trim();
      if (s !== "") params[k] = s;
    }
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "client", "update", params);
      setMessage("Saved.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  return (
    <form onSubmit={submit} className="mt-8 space-y-3">
      <h2 className="text-lg font-semibold">Edit</h2>
      {FIELDS.map(([name, label]) => (
        <label key={name} className="block text-sm">
          <span className="text-zinc-500">{label}</span>
          <input className={input} name={name} defaultValue={initial[name] ?? ""} />
        </label>
      ))}
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Save changes
      </button>
      {message && <p className="text-sm text-zinc-700">{message}</p>}
    </form>
  );
}
