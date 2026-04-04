"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type MailItemEmbed = {
  mrid?: string | null;
  received_at?: string | null;
  sender?: string | null;
  addressee?: string | null;
} | null;

type OcrSplitItem = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  split_path: string | null;
  pdfError: string | null;
};

type DashboardDoc = {
  id: string;
  drid: string;
  status: string;
  file_path: string;
  created_at: string;
  mail_item_id: string | null;
  classification_label?: string | null;
  classification_confidence?: number | null;
  ocr_clients_status?: string | null;
  ocr_clients_items?: OcrSplitItem[] | null;
  ocr_clients_ocr_summary?: Record<string, unknown> | null;
  ocr_clients_completed_at?: string | null;
  ocr_clients_error?: string | null;
  split_index?: number | null;
  split_total?: number | null;
  split_parent_ref?: string | null;
  mail_items?: MailItemEmbed;
};

type GmailQueueRow = {
  id: string;
  gmail_message_id: string;
  subject: string | null;
  subject_mrid: string | null;
  subject_drid: string | null;
  snippet: string | null;
  internal_date_ms: number | null;
  attachment_filename: string | null;
  attachment_mime: string | null;
  status: string;
  error_message: string | null;
  processing_started_at: string | null;
  created_at: string;
};

type OverviewResponse = {
  gmailUnprocessed: GmailQueueRow[];
  gmailInProgress: GmailQueueRow[];
  gmailQueueHint?: string;
  processing: DashboardDoc[];
  processed: DashboardDoc[];
};

type Tab = "unprocessed" | "in_progress" | "processed";

function mailItem(doc: DashboardDoc): MailItemEmbed {
  const mi = doc.mail_items;
  if (mi && !Array.isArray(mi)) return mi;
  if (Array.isArray(mi) && mi[0]) return mi[0] as MailItemEmbed;
  return null;
}

function formatQueueDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "—";
  }
}

function GmailQueueCard({ row }: { row: GmailQueueRow }) {
  const mid = row.gmail_message_id;
  const downloadHref = `/api/dashboard/gmail-queue/${encodeURIComponent(mid)}/download`;
  const mridShow =
    row.subject_mrid ??
    "— (not in subject; assigned when intake runs)";
  const dridShow =
    row.subject_drid ??
    "— (not in subject; assigned when intake runs)";

  return (
    <article className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <div className="text-xs text-zinc-500">
            Gmail ID{" "}
            <code className="rounded bg-zinc-100 px-1 text-[11px] dark:bg-zinc-900">
              {mid}
            </code>
            <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] uppercase dark:bg-zinc-700">
              {row.status}
            </span>
          </div>
          {row.subject ? (
            <div>
              <span className="text-zinc-500">Subject</span> {row.subject}
            </div>
          ) : null}
          <div>
            <span className="text-zinc-500">MRID (from subject)</span>{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">
              {mridShow}
            </code>
          </div>
          <div>
            <span className="text-zinc-500">DRID (from subject)</span>{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">
              {dridShow}
            </code>
          </div>
          <div className="text-xs text-zinc-500">
            Internal date: {formatQueueDate(row.internal_date_ms)}
          </div>
          {row.attachment_filename ? (
            <div className="text-xs text-zinc-500">
              Attachment: {row.attachment_filename}
              {row.attachment_mime ? ` (${row.attachment_mime})` : ""}
            </div>
          ) : (
            <div className="text-xs text-amber-700 dark:text-amber-400">
              No supported PDF/image attachment detected in metadata.
            </div>
          )}
          {row.snippet ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {row.snippet}
            </p>
          ) : null}
          {row.error_message ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              {row.error_message}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <a
            href={downloadHref}
            className="rounded border border-zinc-300 px-3 py-1.5 text-center text-sm dark:border-zinc-600"
          >
            Download attachment
          </a>
        </div>
      </div>
    </article>
  );
}

export default function DashboardPage() {
  const [tab, setTab] = useState<Tab>("unprocessed");
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async (syncGmail = false) => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeoutMs = 45_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (syncGmail) {
        try {
          await fetch("/api/dashboard/gmail-queue/sync", { method: "POST" });
        } catch {
          /* sync is best-effort before overview */
        }
      }
      const res = await fetch("/api/dashboard/overview", {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const json: unknown = await res.json();
      if (!res.ok) {
        const o = json as { error?: string; detail?: string; hint?: string };
        setError(
          [o.error, o.detail, o.hint].filter(Boolean).join(" — ") ||
            "Failed to load dashboard.",
        );
        setData(null);
        return;
      }
      const overview = json as OverviewResponse;
      if (!Array.isArray(overview.gmailUnprocessed)) {
        overview.gmailUnprocessed = [];
      }
      if (!Array.isArray(overview.gmailInProgress)) {
        overview.gmailInProgress = [];
      }
      setData(overview);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError(
          `Request timed out after ${timeoutMs / 1000}s. The overview API or Supabase may be unreachable from the server.`,
        );
      } else {
        setError(e instanceof Error ? e.message : "Load failed.");
      }
      setData(null);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  async function runOcrClients(documentId: string) {
    setRunningId(documentId);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/documents/${documentId}/run-ocr-clients`,
        { method: "POST" },
      );
      const json: unknown = await res.json();
      if (!res.ok) {
        const o = json as { error?: string; detail?: string };
        setError(
          [o.error, o.detail].filter(Boolean).join(": ") || "Pipeline failed.",
        );
        return;
      }
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pipeline failed.");
    } finally {
      setRunningId(null);
    }
  }

  async function openSplitPdf(documentId: string, index: number) {
    try {
      const res = await fetch(
        `/api/dashboard/documents/${documentId}/splits/${index}/signed-url`,
      );
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setError(json.error ?? "Could not open PDF.");
        return;
      }
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Open PDF failed.");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm">
            <Link
              href="/"
              className="text-zinc-600 underline dark:text-zinc-400"
            >
              ← Intake
            </Link>
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Production dashboard</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
            <strong>Unprocessed</strong>: Gmail messages in the Unprocessed
            label mirrored into the queue (refresh pulls from Gmail). MRID/DRID
            show when the subject matches the pipe-separated ROS format;
            otherwise IDs are assigned when intake runs. <strong>In progress</strong>:
            one Gmail message is ingested at a time per cron tick; documents here
            await or run OCR→clients. <strong>Processed</strong>: OCR→clients
            completed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-600"
        >
          Refresh
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      ) : null}

      {data?.gmailQueueHint ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          {data.gmailQueueHint}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        {(
          [
            ["unprocessed", "Unprocessed"],
            ["in_progress", "In progress"],
            ["processed", "Processed"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-t px-3 py-2 text-sm font-medium ${
              tab === key
                ? "bg-zinc-200 dark:bg-zinc-800"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            }`}
          >
            {label}
            {data && key === "unprocessed"
              ? ` (${data.gmailUnprocessed.length})`
              : null}
            {data && key === "in_progress"
              ? ` (${data.gmailInProgress.length + data.processing.length})`
              : null}
            {data && key === "processed" ? ` (${data.processed.length})` : null}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : null}

      {data && tab === "unprocessed" ? (
        <section className="space-y-4">
          {data.gmailUnprocessed.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No queued Gmail messages. Use Refresh (syncs from Gmail) or wait
              for cron <code className="text-xs">/api/cron/intake-email</code>.
            </p>
          ) : null}
          {data.gmailUnprocessed.map((row) => (
            <GmailQueueCard key={row.id} row={row} />
          ))}
        </section>
      ) : null}

      {data && tab === "in_progress" ? (
        <section className="space-y-6">
          {data.gmailInProgress.length > 0 ? (
            <div>
              <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Gmail intake (running)
              </h2>
              <div className="space-y-4">
                {data.gmailInProgress.map((row) => (
                  <GmailQueueCard key={row.id} row={row} />
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <h2 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Documents — OCR→clients
            </h2>
            {data.processing.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No documents in this bucket. After a message is ingested, rows
                appear here until OCR→clients completes.
              </p>
            ) : null}
            <div className="space-y-4">
              {data.processing.map((doc) => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  runningId={runningId}
                  onRun={() => runOcrClients(doc.id)}
                  onOpenSplit={(idx) => openSplitPdf(doc.id, idx)}
                />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {data && tab === "processed" ? (
        <section className="space-y-4">
          {data.processed.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No documents have completed the OCR→clients pipeline yet.
            </p>
          ) : null}
          {data.processed.map((doc) => (
            <DocCard
              key={doc.id}
              doc={doc}
              runningId={runningId}
              onRun={() => runOcrClients(doc.id)}
              onOpenSplit={(idx) => openSplitPdf(doc.id, idx)}
              showRerun
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function DocCard({
  doc,
  runningId,
  onRun,
  onOpenSplit,
  showRerun,
}: {
  doc: DashboardDoc;
  runningId: string | null;
  onRun: () => void;
  onOpenSplit: (index: number) => void;
  showRerun?: boolean;
}) {
  const mi = mailItem(doc);
  const mrid = mi?.mrid ?? "—";
  const items = Array.isArray(doc.ocr_clients_items)
    ? doc.ocr_clients_items
    : [];
  const busy = runningId === doc.id;
  const canRun =
    doc.ocr_clients_status !== "processing" &&
    doc.file_path?.toLowerCase().endsWith(".pdf");

  return (
    <article className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <div>
            <span className="text-zinc-500">MRID</span>{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">
              {mrid}
            </code>
          </div>
          <div>
            <span className="text-zinc-500">DRID</span>{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">
              {doc.drid}
            </code>
          </div>
          <div className="text-zinc-600 dark:text-zinc-400">
            Doc status: {doc.status}
            {doc.ocr_clients_status
              ? ` · OCR→clients: ${doc.ocr_clients_status}`
              : ""}
          </div>
          {doc.classification_label ? (
            <div>
              D2 label: {doc.classification_label}
              {doc.classification_confidence != null
                ? ` (${doc.classification_confidence}%)`
                : ""}
            </div>
          ) : null}
          {doc.split_total != null && doc.split_total > 1 ? (
            <div className="text-xs text-zinc-500">
              Intake split segment {doc.split_index ?? "?"}/{doc.split_total}
            </div>
          ) : null}
          {doc.ocr_clients_error ? (
            <div className="text-red-600 dark:text-red-400">
              Last error: {doc.ocr_clients_error}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {canRun ? (
            <button
              type="button"
              disabled={busy}
              onClick={onRun}
              className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy
                ? "Running…"
                : showRerun
                  ? "Re-run OCR→clients"
                  : "Run OCR→clients"}
            </button>
          ) : (
            <span className="text-xs text-zinc-500">
              {doc.ocr_clients_status === "processing"
                ? "Pipeline running…"
                : "Not a PDF — cannot run pipeline."}
            </span>
          )}
        </div>
      </div>

      {doc.ocr_clients_ocr_summary &&
      typeof doc.ocr_clients_ocr_summary === "object" ? (
        <div className="mt-2 text-xs text-zinc-500">
          OCR summary:{" "}
          {JSON.stringify(doc.ocr_clients_ocr_summary).slice(0, 200)}…
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-700">
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Name</th>
                <th className="py-2 pr-2">UEN</th>
                <th className="py-2 pr-2">Type</th>
                <th className="py-2 pr-2">Pages</th>
                <th className="py-2">Split PDF</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr
                  key={it.index}
                  className="border-b border-zinc-100 dark:border-zinc-800"
                >
                  <td className="py-2 pr-2">{it.index}</td>
                  <td className="py-2 pr-2">{it.name || "—"}</td>
                  <td className="py-2 pr-2">{it.UEN || "—"}</td>
                  <td className="py-2 pr-2">{it.document_type || "—"}</td>
                  <td className="py-2 pr-2">
                    {it.pageStart != null && it.pageEnd != null
                      ? `${it.pageStart}–${it.pageEnd} (${it.page_range})`
                      : it.page_range}
                  </td>
                  <td className="py-2">
                    {it.split_path ? (
                      <button
                        type="button"
                        onClick={() => onOpenSplit(it.index)}
                        className="text-sm text-blue-600 underline dark:text-blue-400"
                      >
                        Open
                      </button>
                    ) : it.pdfError ? (
                      <span className="text-red-600 text-xs dark:text-red-400">
                        {it.pdfError}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </article>
  );
}
