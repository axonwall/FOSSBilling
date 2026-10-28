"use client";

import { useState } from "react";
import { fbPostJson } from "@/lib/browser";

/**
 * Full-config JSON editor. config_save is FULL-REPLACE (PHP setConfig
 * stores the entire $data), so a field-subset editor would DELETE every
 * unshown key on save — including nested values and any secret a module
 * stores in config. This editor therefore round-trips the whole config:
 * the textarea holds the complete config object (minus the ext row key,
 * which is metadata, not data), and the save posts the parsed object
 * back as a JSON body so value types survive (a urlencoded post would
 * stringify numbers, booleans, nested objects and arrays).
 *
 * Invalid JSON is rejected in the browser and never posted; on the
 * server side, an invalid JSON body fails the route's JSON.parse
 * before dispatch, so the seam writes nothing either. After a
 * successful save the form keeps showing the saved text rather than
 * re-reading: PHP's getConfig caches for up to an hour, so a re-read
 * through PHP could show the pre-save value (R4a findings §3.5).
 */
export default function ConfigForm({
  ext,
  initial,
}: {
  ext: string;
  initial: Record<string, unknown>;
}) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setMessage(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setMessage("Invalid JSON: nothing was saved. Fix the JSON and try again.");
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setMessage("Configuration must be a JSON object. Nothing was saved.");
      return;
    }
    setBusy(true);
    try {
      await fbPostJson("admin", "extension", "config_save", {
        ...(parsed as Record<string, unknown>),
        ext,
      });
      setText(JSON.stringify(parsed, null, 2));
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50";
  return (
    <div className="mt-4">
      <textarea
        className="w-full rounded border p-2 font-mono text-sm"
        rows={12}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="mt-2 flex items-center gap-2">
        <button className={btn} disabled={busy} onClick={save}>
          Save configuration
        </button>
        {message && <span className="text-sm text-zinc-600">{message}</span>}
      </div>
    </div>
  );
}
