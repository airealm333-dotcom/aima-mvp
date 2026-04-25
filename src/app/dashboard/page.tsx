"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  classification: string;
  confidence: number;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  split_path: string | null;
  pdfError: string | null;
  odoo_match_status: string | null;
  odoo_partner_id: number | null;
  odoo_match_score: number | null;
  odoo_match_method: string | null;
  odoo_contact_email: string | null;
  odoo_resolution_method: string | null;
  odoo_accounting_manager_email: string | null;
  odoo_accounting_manager_name: string | null;
  deferred_at: string | null;
  dispatched_at: string | null;
  closed_at: string | null;
};

type OcrSummary = {
  pageCount?: number;
  textLength?: number;
  provider?: string;
  overall_confidence?: number;
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
  ocr_clients_ocr_summary?: OcrSummary | null;
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
  ingested_at?: string | null;
  created_at: string;
};

type OverviewResponse = {
  gmailUnprocessed: GmailQueueRow[];
  gmailInProgress: GmailQueueRow[];
  gmailProcessed: GmailQueueRow[];
  gmailQueueHint?: string;
  processing: DashboardDoc[];
  processed: DashboardDoc[];
};

// Flat item enriched with its parent doc context
type FlatClientItem = {
  docId: string;
  drid: string;
  classificationLabel: string | null;
  overallConfidence: number | null;
  item: OcrSplitItem;
  reviewReasons: string[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 70;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(val: number | string | null | undefined): string {
  const ts = typeof val === "string" ? new Date(val).getTime() : val;
  if (!ts || !Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function mailItem(doc: DashboardDoc): MailItemEmbed {
  const mi = doc.mail_items;
  if (mi && !Array.isArray(mi)) return mi;
  if (Array.isArray(mi) && mi[0]) return mi[0] as MailItemEmbed;
  return null;
}

function reviewReasons(item: OcrSplitItem): string[] {
  if (item.dispatched_at) return [];
  if (item.deferred_at) return [];
  if (item.closed_at) return [];
  const r: string[] = [];
  if (item.confidence != null && item.confidence < CONFIDENCE_THRESHOLD)
    r.push(`Low confidence (${item.confidence}%)`);
  if (!item.odoo_match_status || item.odoo_match_status === "error")
    r.push("Match not run");
  if (item.odoo_match_status === "no_match") r.push("No Odoo match");
  if (item.odoo_match_status === "ambiguous") r.push("Ambiguous match");
  if (item.odoo_match_status === "matched" && !item.odoo_contact_email)
    r.push("No contact email");
  if (item.UEN === "Null" && item.odoo_match_status !== "matched")
    r.push("UEN missing");
  if (item.pdfError) r.push("PDF slice error");
  return r;
}

function flattenClientItems(docs: DashboardDoc[]): FlatClientItem[] {
  const result: FlatClientItem[] = [];
  for (const doc of docs) {
    const items = Array.isArray(doc.ocr_clients_items)
      ? doc.ocr_clients_items
      : [];
    for (const item of items) {
      result.push({
        docId: doc.id,
        drid: doc.drid,
        classificationLabel: doc.classification_label ?? null,
        overallConfidence:
          doc.ocr_clients_ocr_summary?.overall_confidence ?? null,
        item,
        reviewReasons: reviewReasons(item),
      });
    }
  }
  return result;
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Badge({
  label,
  color = "zinc",
}: {
  label: string;
  color?: "zinc" | "green" | "yellow" | "red" | "blue" | "amber";
}) {
  const cls: Record<string, string> = {
    zinc: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    green: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    yellow: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  };
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${cls[color]}`}
    >
      {label}
    </span>
  );
}

function ConfPill({ score }: { score: number }) {
  const color =
    score >= 80
      ? "text-green-600 dark:text-green-400"
      : score >= 50
        ? "text-yellow-600 dark:text-yellow-400"
        : "text-red-600 dark:text-red-400";
  return <span className={`text-xs font-semibold ${color}`}>{score}%</span>;
}

function OdooBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const map: Record<string, "green" | "yellow" | "red" | "zinc"> = {
    matched: "green",
    ambiguous: "yellow",
    no_match: "red",
    skipped: "zinc",
    error: "red",
  };
  return <Badge label={status} color={map[status] ?? "zinc"} />;
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="py-8 text-center text-xs text-zinc-400 dark:text-zinc-600">
      {text}
    </p>
  );
}

// ─── Kanban Column ────────────────────────────────────────────────────────────

function KanbanCol({
  title,
  count,
  accent,
  grow,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 ${grow ? "min-w-64 flex-1" : "w-52 shrink-0"}`}>
      <div
        className={`flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 ${accent}`}
      >
        <span className="text-sm font-semibold">{title}</span>
        <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-bold shadow-sm dark:bg-zinc-800">
          {count}
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">{children}</div>
    </div>
  );
}

// ─── Inbox card (unprocessed email) ──────────────────────────────────────────

function InboxCard({ row }: { row: GmailQueueRow }) {
  const isFailed = row.status === "failed";
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-1 flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {row.attachment_filename ?? row.subject ?? "No subject"}
        </span>
        <Badge label={row.status} color={isFailed ? "red" : "zinc"} />
      </div>
      {row.subject && row.attachment_filename ? (
        <p className="mb-1 truncate text-xs text-zinc-500">{row.subject}</p>
      ) : null}
      {row.snippet ? (
        <p className="mb-2 line-clamp-2 text-xs text-zinc-400 dark:text-zinc-500">
          {row.snippet}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 text-xs text-zinc-400">
        <span>{relativeTime(row.internal_date_ms)}</span>
        {row.attachment_mime ? (
          <span className="truncate">{row.attachment_mime}</span>
        ) : (
          <span className="text-amber-600 dark:text-amber-400">No attachment</span>
        )}
      </div>
      {row.error_message ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {row.error_message}
        </p>
      ) : null}
    </article>
  );
}

// ─── Processing cards ─────────────────────────────────────────────────────────

function GmailProcessingCard({ row }: { row: GmailQueueRow }) {
  return (
    <article className="rounded-lg border border-amber-200 bg-white p-3 shadow-sm dark:border-amber-900/50 dark:bg-zinc-900">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {row.attachment_filename ?? row.subject ?? "Ingesting…"}
        </span>
        <Badge label="intake" color="amber" />
      </div>
      {row.subject ? (
        <p className="truncate text-xs text-zinc-500">{row.subject}</p>
      ) : null}
      <p className="mt-1 text-xs text-zinc-400">
        Started {relativeTime(row.processing_started_at ?? row.created_at)}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-amber-400" />
      </div>
    </article>
  );
}

// ─── Processed email card (Column 3) ─────────────────────────────────────────

function InlineClientItem({
  flat,
  onOpenSplit,
}: {
  flat: FlatClientItem;
  onOpenSplit: (docId: string, index: number) => void;
}) {
  const { item, reviewReasons: reasons } = flat;
  const needsReview = reasons.length > 0;
  return (
    <div
      className={`rounded border p-2 text-xs ${
        needsReview
          ? "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10"
          : "border-zinc-100 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40"
      }`}
    >
      <Link href={`/dashboard/review/${flat.docId}?item=${item.index}`} className="block">
        <div className="flex items-start gap-2 hover:opacity-80">
          <span className="min-w-0 flex-1 truncate font-medium">
            {item.name || "—"}
          </span>
          {item.confidence != null ? <ConfPill score={item.confidence} /> : null}
          <OdooBadge status={item.odoo_match_status} />
        </div>
      </Link>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-500">
        <span>UEN: {item.UEN}</span>
        <span>pp. {item.page_range}</span>
        {item.classification ? (
          <Badge label={item.classification} color="blue" />
        ) : null}
        {item.odoo_contact_email ? (
          <span className="truncate">{item.odoo_contact_email}</span>
        ) : null}
      </div>
      {needsReview ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {reasons.map((r) => (
            <span
              key={r}
              className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            >
              {r}
            </span>
          ))}
        </div>
      ) : null}
      {item.split_path ? (
        <button
          type="button"
          onClick={() => onOpenSplit(flat.docId, item.index)}
          className="mt-1 text-blue-600 underline dark:text-blue-400"
        >
          View PDF
        </button>
      ) : null}
    </div>
  );
}

function ProcessedDocCard({
  doc,
  onOpenSplit,
}: {
  doc: DashboardDoc;
  onOpenSplit: (docId: string, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const flatItems = useMemo(() => flattenClientItems([doc]), [doc]);
  const hasItems = flatItems.length > 0;
  const mi = mailItem(doc);
  const needsReviewCount = flatItems.filter((f) => f.reviewReasons.length > 0).length;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      <Link href={`/dashboard/review/${doc.id}`} className="block">
        <div className="mb-1 flex items-start gap-2 hover:opacity-80">
          <span className="min-w-0 flex-1 truncate font-medium">
            {mi?.sender ?? doc.file_path?.split("/").pop() ?? doc.drid}
          </span>
          <Badge label="done" color="green" />
        </div>
      </Link>
      {doc.classification_label ? (
        <div className="mb-1 flex items-center gap-1.5">
          <Badge label={doc.classification_label} color="blue" />
          {doc.classification_confidence != null ? (
            <ConfPill score={doc.classification_confidence} />
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-zinc-400">
        <span>{relativeTime(doc.ocr_clients_completed_at ?? doc.created_at)}</span>
        {needsReviewCount > 0 ? (
          <Link href={`/dashboard/review/${doc.id}`} className="text-amber-500 hover:underline">
            {needsReviewCount} need review
          </Link>
        ) : null}
        {hasItems ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="ml-auto text-blue-600 hover:underline dark:text-blue-400"
          >
            {expanded
              ? "Hide items"
              : `${flatItems.length} client${flatItems.length === 1 ? "" : "s"} →`}
          </button>
        ) : null}
      </div>
      {expanded && hasItems ? (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {flatItems.map((flat) => (
            <InlineClientItem
              key={`${flat.docId}-${flat.item.index}`}
              flat={flat}
              onOpenSplit={onOpenSplit}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

// ─── Review card (Column 4) ───────────────────────────────────────────────────

function ReviewCard({ flat }: { flat: FlatClientItem }) {
  const { item, drid, docId, reviewReasons: reasons } = flat;
  const isDeferred = Boolean(item.deferred_at);
  return (
    <Link href={`/dashboard/review/${docId}?item=${item.index}`} className="block">
      <article className="cursor-pointer rounded-lg border border-amber-200 bg-white p-3 shadow-sm transition-colors hover:border-amber-400 hover:bg-amber-50 dark:border-amber-900/50 dark:bg-zinc-900 dark:hover:border-amber-600 dark:hover:bg-zinc-800">
        <div className="mb-1 flex items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.name || "—"}
          </span>
          <OdooBadge status={item.odoo_match_status} />
        </div>
        {!isDeferred && (
          <div className="mb-2 flex flex-wrap gap-1">
            {reasons.map((r) => (
              <span
                key={r}
                className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              >
                {r}
              </span>
            ))}
          </div>
        )}
        {isDeferred && (item.odoo_accounting_manager_name || item.odoo_accounting_manager_email) && (
          <div className="mb-2 rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            <span className="font-medium">Manager:</span>{" "}
            {item.odoo_accounting_manager_name ?? "—"}
            {item.odoo_accounting_manager_email ? (
              <span className="text-zinc-500"> · {item.odoo_accounting_manager_email}</span>
            ) : null}
          </div>
        )}
        {isDeferred && item.odoo_contact_email && (
          <div className="mb-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            Contact: <span className="text-zinc-700 dark:text-zinc-300">{item.odoo_contact_email}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-400">
          <span>UEN: {item.UEN}</span>
          <span>pp. {item.page_range}</span>
          {item.confidence != null ? <ConfPill score={item.confidence} /> : null}
          {item.classification ? (
            <Badge label={item.classification} color="zinc" />
          ) : null}
        </div>
        <p className="mt-1 font-mono text-[10px] text-zinc-400">{drid}</p>
      </article>
    </Link>
  );
}


// ─── Stat pill ────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center rounded-lg border px-4 py-2 ${
        warn && value > 0
          ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      <span
        className={`text-xl font-bold ${
          warn && value > 0 ? "text-amber-700 dark:text-amber-300" : ""
        }`}
      >
        {value}
      </span>
      <span className="text-xs text-zinc-500">{label}</span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [globalError, setGlobalError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (syncGmail = false) => {
    if (syncGmail) setSyncing(true);
    else setLoading((prev) => (prev || !data ? true : false));
    setError(null);
    try {
      if (syncGmail) {
        try {
          await fetch("/api/dashboard/gmail-queue/sync", { method: "POST" });
          // Trigger one intake poll tick so queued emails start processing immediately
          fetch("/api/dashboard/gmail-queue/process", { method: "POST" }).catch(() => {});
        } catch {
          /* best-effort */
        }
      }
      const res = await fetch("/api/dashboard/overview");
      const json: unknown = await res.json();
      if (!res.ok) {
        const o = json as { error?: string; detail?: string; hint?: string };
        setError(
          [o.error, o.detail, o.hint].filter(Boolean).join(" — ") ||
            "Failed to load.",
        );
        setData(null);
        return;
      }
      const overview = json as OverviewResponse;
      if (!Array.isArray(overview.gmailUnprocessed))
        overview.gmailUnprocessed = [];
      if (!Array.isArray(overview.gmailInProgress))
        overview.gmailInProgress = [];
      if (!Array.isArray(overview.gmailProcessed)) overview.gmailProcessed = [];
      setData(overview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
      setData(null);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Auto-refresh every 15s when something is active
  useEffect(() => {
    if (!data) return;
    const hasActive =
      data.gmailInProgress.length > 0 ||
      data.processing.some((d) => d.ocr_clients_status === "processing") ||
      runningIds.size > 0;
    if (hasActive) {
      intervalRef.current = setInterval(() => load(false), 15_000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [data, load, runningIds]);

  async function openSplitPdf(docId: string, index: number) {
    try {
      const res = await fetch(
        `/api/dashboard/documents/${docId}/splits/${index}/signed-url`,
      );
      const json = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !json.url) {
        setGlobalError(json.error ?? "Could not open PDF.");
        return;
      }
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setGlobalError(e instanceof Error ? e.message : "Open PDF failed.");
    }
  }

  const allClientItems = useMemo(
    () => flattenClientItems(data?.processed ?? []),
    [data],
  );
  const reviewCount = allClientItems.filter(
    (f) => f.reviewReasons.length > 0,
  ).length;
  const deferredItems = allClientItems.filter((f) => f.item.deferred_at);
  const deferredCount = deferredItems.length;


  const isActive =
    (data?.gmailInProgress.length ?? 0) > 0 ||
    (data?.processing ?? []).some((d) => d.ocr_clients_status === "processing");

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* ── Header ── */}
      <header className="flex shrink-0 flex-wrap items-center gap-4 border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h1 className="mt-1 text-xl font-bold">Dashboard</h1>
        </div>

        {data ? (
          <div className="flex flex-wrap gap-3 ml-4">
            <Stat label="Inbox" value={data.gmailUnprocessed.length} />
            <Stat
              label="Processing"
              value={data.gmailInProgress.length}
              warn
            />
            <Stat label="Processed" value={data.processed.length} />
            <Stat label="Needs Review" value={reviewCount} warn />
            <Stat label="Deferred" value={deferredCount} />
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          {isActive ? (
            <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              Live
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading || syncing}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-600"
          >
            {syncing ? "Syncing…" : loading ? "Loading…" : "Sync Gmail + Refresh"}
          </button>
        </div>
      </header>

      {/* ── Error banner ── */}
      {(error ?? globalError) ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error ?? globalError}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => {
              setError(null);
              setGlobalError(null);
            }}
          >
            dismiss
          </button>
        </div>
      ) : null}

      {data?.gmailQueueHint ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {data.gmailQueueHint}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          Loading…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* ── 4-column Kanban ── */}
          <div className="flex gap-4 overflow-x-auto p-4" style={{ minHeight: 320, maxHeight: "calc(100vh - 140px)" }}>
            {/* Column 1 — Inbox */}
            <KanbanCol
              title="📥 Inbox"
              count={data?.gmailUnprocessed.length ?? 0}
              accent="text-zinc-700 dark:text-zinc-200"
            >
              {data?.gmailUnprocessed.length === 0 ? (
                <EmptyState text="No unprocessed emails. Use Sync to pull from Gmail." />
              ) : (
                data?.gmailUnprocessed.map((row) => (
                  <InboxCard key={row.id} row={row} />
                ))
              )}
            </KanbanCol>

            {/* Column 2 — Processing */}
            <KanbanCol
              title="⚙️ Processing"
              count={data?.gmailInProgress.length ?? 0}
              accent="text-amber-700 dark:text-amber-300"
            >
              {(data?.gmailInProgress.length ?? 0) === 0 ? (
                <EmptyState text="Nothing processing right now." />
              ) : null}
              {data?.gmailInProgress.map((row) => (
                <GmailProcessingCard key={row.id} row={row} />
              ))}
            </KanbanCol>

            {/* Column 3 — Processed Documents */}
            <KanbanCol
              title="✅ Processed"
              count={data?.processed.length ?? 0}
              accent="text-green-700 dark:text-green-300"
              grow
            >
              {(data?.processed.length ?? 0) === 0 ? (
                <EmptyState text="No processed documents yet." />
              ) : (
                data?.processed.map((doc) => (
                  <ProcessedDocCard
                    key={doc.id}
                    doc={doc}
                    onOpenSplit={openSplitPdf}
                  />
                ))
              )}
            </KanbanCol>

            {/* Column 4 — Needs Review */}
            <KanbanCol
              title="⚠️ Needs Review"
              count={reviewCount}
              accent="text-amber-700 dark:text-amber-300"
              grow
            >
              {reviewCount === 0 ? (
                <EmptyState text="No items flagged for review." />
              ) : (
                allClientItems
                  .filter((f) => f.reviewReasons.length > 0)
                  .map((f) => (
                    <ReviewCard
                      key={`${f.docId}-${f.item.index}`}
                      flat={f}
                    />
                  ))
              )}
            </KanbanCol>

            {/* Column 5 — Deferred */}
            <KanbanCol
              title="⏸ Deferred"
              count={deferredCount}
              accent="text-zinc-700 dark:text-zinc-300"
              grow
            >
              {deferredCount === 0 ? (
                <EmptyState text="No items deferred." />
              ) : (
                deferredItems.map((f) => (
                  <ReviewCard
                    key={`${f.docId}-${f.item.index}`}
                    flat={f}
                  />
                ))
              )}
            </KanbanCol>
          </div>
        </div>
      )}
    </div>
  );
}
