"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type DispatchMode = "item_ready" | "document_complete";

export default function SettingsPage() {
  const [mode, setMode] = useState<DispatchMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings?key=dispatch_mode")
      .then((r) => r.json())
      .then((d: { value?: string }) => {
        setMode(d.value === "document_complete" ? "document_complete" : "item_ready");
      })
      .catch(() => setMode("item_ready"));
  }, []);

  async function handleToggle(checked: boolean) {
    const next: DispatchMode = checked ? "document_complete" : "item_ready";
    setMode(next);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "dispatch_mode", value: next }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!d.ok) { setError(d.error ?? "Save failed"); return; }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-4 border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-xs text-zinc-500 underline dark:text-zinc-400">
              ← Dashboard
            </Link>
          </div>
          <h1 className="mt-1 text-xl font-bold">Settings</h1>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-2xl px-6 py-8 space-y-8">

        {/* Dispatch section */}
        <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Email Dispatch</h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Controls when processed client items are automatically emailed after the OCR pipeline completes.
            </p>
          </div>

          <div className="px-5 py-5">
            {mode === null ? (
              <div className="text-sm text-zinc-400">Loading…</div>
            ) : (
              <label className="flex cursor-pointer items-start gap-4">
                <div className="relative mt-0.5 shrink-0">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={mode === "document_complete"}
                    disabled={saving}
                    onChange={(e) => handleToggle(e.target.checked)}
                  />
                  {/* Track */}
                  <div className="h-5 w-9 rounded-full bg-zinc-300 transition-colors peer-checked:bg-blue-500 peer-disabled:opacity-50 dark:bg-zinc-600 dark:peer-checked:bg-blue-500" />
                  {/* Knob */}
                  <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                    Only send emails when the entire document is fully processed
                  </p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {mode === "document_complete"
                      ? "Emails will only be sent if every item in the document passes review — if any item needs review, nothing is sent."
                      : "Emails are sent for each item that passes review, even if other items in the same document still need review."}
                  </p>
                </div>
              </label>
            )}

            {error && (
              <p className="mt-3 text-xs text-red-500">{error}</p>
            )}
            {saved && (
              <p className="mt-3 text-xs text-green-500">Saved.</p>
            )}
          </div>
        </section>

      </main>
    </div>
  );
}
