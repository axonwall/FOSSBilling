import { cookies } from "next/headers";
import type { CallOptions } from "./fossbilling";

/**
 * Server-side session options for the current request: forwards the PHP
 * session cookie and the fossbilling_csrf cookie value (the dispatcher's
 * CSRF check compares it against the CSRFToken form field / header).
 */
export async function sessionOpts(): Promise<CallOptions> {
  const jar = await cookies();
  const csrf = jar.get("fossbilling_csrf")?.value;
  return {
    cookieHeader: jar.toString(),
    csrfToken: csrf ? decodeURIComponent(csrf) : undefined,
  };
}

/** Extract the paginated `list` (and total) from a FOSSBilling list result. */
export function listOf<T>(data: unknown): { list: T[]; total: number } {
  if (Array.isArray(data)) return { list: data as T[], total: data.length };
  const d = (data ?? {}) as { list?: T[]; total?: number };
  return { list: d.list ?? [], total: d.total ?? (d.list ?? []).length };
}
