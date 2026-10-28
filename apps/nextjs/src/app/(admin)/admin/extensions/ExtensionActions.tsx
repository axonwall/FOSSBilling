"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/**
 * Activate / deactivate buttons for one extension row. The seam enforces
 * (extension/manage_extensions); the buttons only hide actions the page
 * already knows are inapplicable: core modules get no Deactivate button
 * (they have no extension row, so the seam would answer 'Extension not
 * found'), available modules get Activate only, installed modules get
 * Deactivate only.
 */
export default function ExtensionActions({
  id,
  status,
}: {
  id: string;
  status: string | null;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(method: "activate" | "deactivate") {
    setMessage(null);
    setBusy(true);
    try {
      await fbPost("admin", "extension", method, { id, type: "mod" });
      setMessage(method === "activate" ? "Activated." : "Deactivated.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50";
  return (
    <span className="inline-flex items-center gap-2">
      {status === null && (
        <button className={btn} disabled={busy} onClick={() => run("activate")}>
          Activate
        </button>
      )}
      {status === "installed" && (
        <button className={btn} disabled={busy} onClick={() => run("deactivate")}>
          Deactivate
        </button>
      )}
      {message && <span className="text-sm text-zinc-600">{message}</span>}
    </span>
  );
}
