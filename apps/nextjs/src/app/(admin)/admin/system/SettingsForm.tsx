"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";
import { EDITABLE_SETTINGS } from "@/lib/system-settings-fields";

/**
 * System settings form — admin/system/update_params via the proxy.
 * Posts EXACTLY the fields in EDITABLE_SETTINGS and nothing else;
 * update_params upserts every param it receives, so the field list
 * is the allowlist. Checkboxes always post "1" or "0" explicitly
 * (unchecked HTML checkboxes would otherwise vanish).
 */
export default function SettingsForm({
  initial,
}: {
  initial: Record<string, string | null>;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const params: Record<string, string> = {};
    for (const group of EDITABLE_SETTINGS) {
      for (const field of group.fields) {
        if (field.type === "checkbox") {
          params[field.name] = data.get(field.name) ? "1" : "0";
        } else {
          params[field.name] = String(data.get(field.name) ?? "");
        }
      }
    }
    setMessage(null);
    setBusy(true);
    try {
      await fbPost<boolean>("admin", "system", "update_params", params);
      setMessage("Settings saved.");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border px-3 py-2";
  return (
    <form onSubmit={submit} className="mt-6 space-y-8">
      {EDITABLE_SETTINGS.map((group) => (
        <section key={group.title}>
          <h2 className="text-lg font-semibold">{group.title}</h2>
          {group.note ? (
            <p className="mt-1 text-sm text-zinc-600">{group.note}</p>
          ) : null}
          <div className="mt-3 space-y-3">
            {group.fields.map((field) => {
              const value = initial[field.name] ?? "";
              if (field.type === "checkbox") {
                return (
                  <label key={field.name} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={field.name}
                      defaultChecked={value === "1" || value === "true"}
                    />
                    {field.label}
                  </label>
                );
              }
              if (field.type === "textarea") {
                return (
                  <label key={field.name} className="block text-sm">
                    <span className="text-zinc-500">{field.label}</span>
                    <textarea
                      className={input}
                      name={field.name}
                      defaultValue={value}
                      rows={3}
                    />
                  </label>
                );
              }
              if (field.type === "select") {
                return (
                  <label key={field.name} className="block text-sm">
                    <span className="text-zinc-500">{field.label}</span>
                    <select className={input} name={field.name} defaultValue={value}>
                      {(field.options ?? []).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              }
              return (
                <label key={field.name} className="block text-sm">
                  <span className="text-zinc-500">{field.label}</span>
                  <input
                    className={input}
                    name={field.name}
                    type={field.type === "number" ? "number" : "text"}
                    min={field.min}
                    defaultValue={value}
                  />
                </label>
              );
            })}
          </div>
        </section>
      ))}
      <button
        className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        Save settings
      </button>
      {message ? <p className="text-sm">{message}</p> : null}
    </form>
  );
}
