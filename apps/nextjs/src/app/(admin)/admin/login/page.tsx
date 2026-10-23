"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Staff sign-in — guest/staff/login via the proxy (CSRF primed by fbPost). */
export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fbPost("guest", "staff", "login", { email, password });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-semibold">Staff sign in</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input className="w-full rounded border px-3 py-2" type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full rounded border px-3 py-2" type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="w-full rounded bg-zinc-900 py-2 text-white" type="submit">
          Sign in
        </button>
      </form>
      {message && <p className="mt-4 text-sm text-red-700">{message}</p>}
    </main>
  );
}
