"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/**
 * Currency refresh — admin/currency/update_rates via the proxy.
 * The updater pins the default currency to 1.0, skips manual-rate
 * currencies, and fetches the rest from the configured provider.
 * On this install there is no provider config, so a refresh with a
 * non-manual currency attempts the open ExchangeRate-API endpoint;
 * whatever the API returns (true, or its exact error) surfaces here.
 */
export default function RefreshRatesButton() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost<boolean>("admin", "currency", "update_rates", {});
      setMessage("Rates refreshed.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button
        className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        type="button"
        disabled={busy}
        onClick={refresh}
      >
        Refresh rates
      </button>
      {message ? <span className="ml-3 text-sm">{message}</span> : null}
    </span>
  );
}
