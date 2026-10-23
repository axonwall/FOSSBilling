"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/**
 * Client signup — guest/client/create via the proxy. Required fields per
 * the endpoint's #[RequiredParams]: email, first_name, password,
 * password_confirm. On success FOSSBilling auto-logs-in (default config),
 * so we land on the dashboard.
 */
export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", first_name: "", last_name: "", password: "", password_confirm: "" });
  const [message, setMessage] = useState<string | null>(null);

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fbPost("guest", "client", "create", form);
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-semibold">Create account</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input className="w-full rounded border px-3 py-2" type="email" required placeholder="Email" value={form.email} onChange={set("email")} />
        <input className="w-full rounded border px-3 py-2" required placeholder="First name" value={form.first_name} onChange={set("first_name")} />
        <input className="w-full rounded border px-3 py-2" placeholder="Last name" value={form.last_name} onChange={set("last_name")} />
        <input className="w-full rounded border px-3 py-2" type="password" required placeholder="Password" value={form.password} onChange={set("password")} />
        <input className="w-full rounded border px-3 py-2" type="password" required placeholder="Confirm password" value={form.password_confirm} onChange={set("password_confirm")} />
        <button className="w-full rounded bg-zinc-900 py-2 text-white" type="submit">
          Sign up
        </button>
      </form>
      {message && <p className="mt-4 text-sm text-red-700">{message}</p>}
    </main>
  );
}
