"use client";

import { useState } from "react";

/**
 * Client sign-in (Phase 1). Posts through the same-origin /api/fb proxy to
 * guest/client/login on the PHP side, which sets the PHP session cookie.
 * The CSRF token is read from the `fossbilling_csrf` cookie set by any PHP
 * page/API response and sent as the CSRFToken form field, per the
 * dispatcher's double-submit check (verified live in Phase 0).
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const csrf = document.cookie
      .split("; ")
      .find((c) => c.startsWith("fossbilling_csrf="))
      ?.split("=")[1];
    const form = new URLSearchParams({ email, password });
    if (csrf) form.set("CSRFToken", decodeURIComponent(csrf));
    const res = await fetch("/api/fb/guest/client/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const json = await res.json().catch(() => null);
    setMessage(
      json?.error?.message ??
        (res.ok ? "Signed in. Session cookie set by the PHP API." : `HTTP ${res.status}`),
    );
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form onSubmit={submit} className="mt-6 space-y-3">
        <input
          className="w-full rounded border px-3 py-2"
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded border px-3 py-2"
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="w-full rounded bg-zinc-900 py-2 text-white" type="submit">
          Sign in
        </button>
      </form>
      {message && <p className="mt-4 text-sm text-zinc-600">{message}</p>}
    </main>
  );
}
