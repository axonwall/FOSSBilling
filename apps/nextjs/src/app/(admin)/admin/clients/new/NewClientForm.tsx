"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

const FIELDS: [string, string, string?][] = [
  ["email", "Email", "email"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["company", "Company"],
  ["address_1", "Address 1"],
  ["address_2", "Address 2"],
  ["city", "City"],
  ["state", "State"],
  ["postcode", "Postcode"],
  ["country", "Country (2-letter)"],
  ["phone_cc", "Phone country code"],
  ["phone", "Phone"],
  ["currency", "Currency (3-letter)"],
  ["password", "Password (optional)", "password"],
];

/** Client create — admin/client/create via the proxy. Only non-empty
 *  fields are posted; the API requires email + first_name and validates
 *  the rest, so its exact errors surface here. */
export default function NewClientForm() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string | number> = {};
    for (const [k, v] of data.entries()) {
      const s = String(v).trim();
      if (s !== "") params[k] = s;
    }
    // Checkbox unchecked => absent; checked => "1".
    params["send_welcome_email"] = data.get("send_welcome_email") ? "1" : "0";
    setMessage(null);
    setBusy(true);
    try {
      const id = await fbPost<number>("admin", "client", "create", params);
      router.push(`/admin/clients/${id}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      {FIELDS.map(([name, label, type]) => (
        <label key={name} className="block text-sm">
          <span className="text-zinc-500">{label}</span>
          <input
            className={input}
            name={name}
            type={type ?? "text"}
            required={name === "email" || name === "first_name"}
          />
        </label>
      ))}
      <label className="block text-sm">
        <span className="text-zinc-500">Status</span>
        <select className={input} name="status" defaultValue="active">
          <option value="active">active</option>
          <option value="suspended">suspended</option>
          <option value="canceled">canceled</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="send_welcome_email" defaultChecked />
        Send welcome email
      </label>
      <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50" type="submit" disabled={busy}>
        Create client
      </button>
      {message && <p className="text-sm text-red-700">{message}</p>}
    </form>
  );
}
