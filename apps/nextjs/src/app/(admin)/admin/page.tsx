export const dynamic = "force-dynamic";

/**
 * Admin home placeholder (Phase 1). Admin pages will call the admin role of
 * the dispatcher through the same typed client, using session cookies
 * forwarded by the /api/fb proxy (browser) or api_token Basic auth
 * (server-side jobs). No admin surface is ported yet.
 */
export default function AdminHome() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Admin area</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Placeholder for the Scope B strangler: the PHP admin theme remains the working
        admin surface until admin modules are ported phase by phase.
      </p>
    </main>
  );
}
