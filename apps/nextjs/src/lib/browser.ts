"use client";

/** Read the FOSSBilling CSRF cookie (double-submit token) in the browser. */
export function csrfFromCookie(): string | undefined {
  const v = document.cookie
    .split("; ")
    .find((c) => c.startsWith("fossbilling_csrf="))
    ?.split("=")[1];
  return v ? decodeURIComponent(v) : undefined;
}

/**
 * Ensure the browser holds the fossbilling_csrf cookie. It is set only by
 * PHP web pages (never API responses), so the proxy's __prime route relays
 * the PHP login page's cookies to this origin on first use.
 */
export async function ensureCsrf(): Promise<void> {
  if (csrfFromCookie()) return;
  await fetch("/api/fb/__prime").catch(() => {});
}

/**
 * POST to the PHP dispatcher through the same-origin /api/fb proxy.
 * Returns the unwrapped result or throws with the API error message.
 */
export async function fbPost<T = unknown>(
  role: "guest" | "client" | "admin",
  module: string,
  method: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  await ensureCsrf();
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  const csrf = csrfFromCookie();
  if (csrf) form.set("CSRFToken", csrf);
  const res = await fetch(`/api/fb/${role}/${module}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) {
    throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  }
  return json.result as T;
}
