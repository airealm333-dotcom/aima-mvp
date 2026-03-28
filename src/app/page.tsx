"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

type IntakeResponse = {
  mrid: string;
  drid: string;
  mailItemId: string;
  documentId: string;
  status: {
    mailItem: string;
    document: string;
  };
  flags?: {
    lowTextCoverage: boolean;
  };
  file: {
    name: string;
    size: number;
    sha256: string;
    path: string;
  };
  ocr: {
    text: string;
    pageCount: number;
    textLength: number;
    provider: "google-vision" | "pdf-parse";
  } | null;
  classification?: {
    label: string;
    confidence: number;
    method: string;
    rationale: string;
  };
  duplicate?: {
    duplicateOfDocumentId: string;
    duplicateOfDrid?: string | null;
    reason: string;
  };
  entitySummary?: {
    client_name: string | null;
    company_name: string | null;
    claimant_email: string | null;
    respondent_email: string | null;
  } | null;
  split?: {
    parentRef: string | null;
    index: number | null;
    total: number | null;
    method: string;
    confidence: number | null;
    suspectedMultiInvoice: boolean;
    sectionType: string | null;
    reason: string | null;
    model: string | null;
    pageStart: number | null;
    pageEnd: number | null;
  };
  error?: string;
  detail?: string;
};

type ManualIntakeSplitResponse = {
  split: true;
  sourceFileName: string;
  documents: IntakeResponse[];
  errors?: Array<{ chunkIndex: number; status: number; detail: string }>;
};

function isManualIntakeSplitPayload(
  v: unknown,
): v is ManualIntakeSplitResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.split === true &&
    typeof o.sourceFileName === "string" &&
    Array.isArray(o.documents)
  );
}

type RecentDocument = {
  id: string;
  drid: string;
  status: string;
  file_path: string;
  created_at: string;
  mail_item_id: string;
  classification_label?: string | null;
  classification_confidence?: number | null;
  classification_method?: string | null;
  classification_rationale?: string | null;
  is_duplicate?: boolean | null;
  duplicate_of_document_id?: string | null;
  duplicate_reason?: string | null;
  review_required?: boolean | null;
  review_status?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  split_parent_ref?: string | null;
  split_index?: number | null;
  split_total?: number | null;
  split_method?: string | null;
  split_confidence?: number | null;
  multi_invoice_suspected?: boolean | null;
  split_section_type?: string | null;
  split_reason?: string | null;
  split_model?: string | null;

  // D2.5: extracted entity fields (best-effort OCR -> rule-first extraction).
  entity_sender?: string | null;
  entity_addressee?: string | null;
  entity_organization_name?: string | null;
  entity_contact_person_name?: string | null;
  entity_reference_number?: string | null;
  entity_document_date?: string | null;
  entity_document_type?: string | null;

  entity_invoice_number?: string | null;
  entity_invoice_date?: string | null;
  entity_due_date?: string | null;
  entity_currency?: string | null;
  entity_total_amount?: string | null;
  entity_tax_amount?: string | null;
  entity_vendor_name?: string | null;
  entity_buyer_name?: string | null;
  entity_case_number?: string | null;
  entity_notice_date?: string | null;
  entity_authority?: string | null;
  entity_deadline?: string | null;
  entity_reference_legal?: string | null;
  entity_claimant_name?: string | null;
  entity_respondent_name?: string | null;
  entity_claimant_email?: string | null;
  entity_respondent_email?: string | null;
  entity_respondent_contact_name?: string | null;
  entity_employment_start_date?: string | null;
  entity_employment_end_date?: string | null;
  entity_employment_status?: string | null;
  entity_occupation?: string | null;
  entity_basic_salary_monthly?: string | null;
};

function pickUploadDetail(
  items: RecentDocument[],
  documentId: string,
): RecentDocument | undefined {
  return items.find((d) => d.id === documentId);
}

function hasInvoiceEntityFields(doc: RecentDocument | undefined): boolean {
  if (!doc) return false;
  const keys = [
    "entity_invoice_number",
    "entity_invoice_date",
    "entity_due_date",
    "entity_total_amount",
    "entity_tax_amount",
    "entity_currency",
    "entity_vendor_name",
  ] as const;
  return keys.some((k) => {
    const v = doc[k];
    return v != null && String(v).trim() !== "";
  });
}

type OpenException = {
  id: string;
  drid: string;
  type: string;
  status: string;
  root_cause: string | null;
  suggested_action: string | null;
  created_at: string;
};

type GmailDebugCounts = {
  userId: string;
  unprocessed: {
    id: string;
    name: string;
    messagesTotal: number;
    messagesUnread: number;
  } | null;
  processed: {
    id: string;
    name: string;
    messagesTotal: number;
    messagesUnread: number;
  } | null;
  error?: string;
  detail?: string;
};

type D3ReviewItem = {
  id: string;
  drid: string;
  file_path?: string | null;
  status: string;
  created_at: string;
  classification_label?: string | null;
  classification_confidence?: number | null;
  classification_method?: string | null;
  classification_rationale?: string | null;
  review_required?: boolean | null;
  review_status?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  is_duplicate?: boolean | null;
  duplicate_reason?: string | null;
  duplicate_of_document_id?: string | null;
  split_parent_ref?: string | null;
  split_index?: number | null;
  split_total?: number | null;
  split_method?: string | null;
  split_confidence?: number | null;
  multi_invoice_suspected?: boolean | null;
  split_section_type?: string | null;
  split_reason?: string | null;
  split_model?: string | null;
};

export default function Home() {
  const manualIntakeEnabled =
    process.env.NEXT_PUBLIC_MANUAL_INTAKE_ENABLED !== "false";

  const [mailSequence, setMailSequence] = useState("");
  const [docSequence, setDocSequence] = useState("");
  const [sender, setSender] = useState("");
  const [addressee, setAddressee] = useState("");
  const [mieName, setMieName] = useState("");
  const [envelopeCondition, setEnvelopeCondition] = useState("sealed");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadResults, setUploadResults] = useState<IntakeResponse[]>([]);
  const [splitUploadInfo, setSplitUploadInfo] = useState<{
    sourceFileName: string;
    errors: Array<{ chunkIndex: number; status: number; detail: string }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [gmailCountError, setGmailCountError] = useState<string | null>(null);
  const [gmailCounts, setGmailCounts] = useState<GmailDebugCounts | null>(null);
  const [recent, setRecent] = useState<RecentDocument[]>([]);
  const [openExceptions, setOpenExceptions] = useState<OpenException[]>([]);
  const [reviewQueue, setReviewQueue] = useState<D3ReviewItem[]>([]);
  const [openingDocId, setOpeningDocId] = useState<string | null>(null);
  const [reviewerName, setReviewerName] = useState("OPS_USER");
  const [reviewActionNote, setReviewActionNote] = useState("");
  const [reviewActionLabel, setReviewActionLabel] = useState("UNKNOWN");

  const loadRecentDocuments = useCallback(async () => {
    try {
      const response = await fetch("/api/documents/recent");
      if (!response.ok) {
        const json = await response
          .json()
          .catch(() => null as unknown as { error?: string; detail?: string });
        setSidebarError(
          `Failed to load recent documents: ${json?.detail ?? json?.error ?? response.statusText}`,
        );
        return;
      }
      const json = (await response.json()) as { items: RecentDocument[] };
      setRecent(json.items ?? []);
    } catch {
      setSidebarError("Failed to load recent documents.");
    }
  }, []);

  const loadOpenExceptions = useCallback(async () => {
    try {
      const response = await fetch("/api/exceptions/open");
      if (!response.ok) {
        const json = await response
          .json()
          .catch(() => null as unknown as { error?: string; detail?: string });
        setSidebarError(
          `Failed to load open exceptions: ${json?.detail ?? json?.error ?? response.statusText}`,
        );
        return;
      }
      const json = (await response.json()) as { items: OpenException[] };
      setOpenExceptions(json.items ?? []);
    } catch {
      setSidebarError("Failed to load open exceptions.");
    }
  }, []);

  const loadGmailCounts = useCallback(async () => {
    setGmailCountError(null);
    try {
      const response = await fetch("/api/debug/gmail-label-counts");
      const json = (await response.json()) as GmailDebugCounts;
      if (!response.ok) {
        setGmailCountError(
          json.detail ?? json.error ?? "Failed to load Gmail label counts.",
        );
        setGmailCounts(null);
        return;
      }
      setGmailCounts(json);
    } catch {
      setGmailCountError("Failed to load Gmail label counts.");
      setGmailCounts(null);
    }
  }, []);

  const loadReviewQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/review/queue");
      if (!response.ok) return;
      const json = (await response.json()) as { items: D3ReviewItem[] };
      setReviewQueue(json.items ?? []);
    } catch {
      // No-op for optional panel.
    }
  }, []);

  useEffect(() => {
    void loadRecentDocuments();
    void loadOpenExceptions();
    void loadReviewQueue();
  }, [loadOpenExceptions, loadRecentDocuments, loadReviewQueue]);

  async function runReviewAction(
    documentId: string,
    action: "approve" | "correct" | "needs_rescan",
  ) {
    const payload: Record<string, unknown> = {
      action,
      reviewer: reviewerName.trim() || "OPS_USER",
      note: reviewActionNote.trim() || undefined,
    };
    if (action === "correct") {
      payload.correctedLabel = reviewActionLabel;
      payload.correctedRationale =
        reviewActionNote.trim() || "Manual label correction in D3 review.";
    }

    const response = await fetch(`/api/review/document/${documentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as {
        error?: string;
        detail?: string;
      } | null;
      setSidebarError(
        `D3 action failed: ${json?.detail ?? json?.error ?? response.statusText}`,
      );
      return;
    }

    await loadReviewQueue();
    await loadRecentDocuments();
    await loadOpenExceptions();
  }

  async function openReviewDocument(documentId: string) {
    setOpeningDocId(documentId);
    try {
      const response = await fetch(`/api/review/document/${documentId}/open`);
      const json = (await response.json()) as {
        url?: string;
        error?: string;
        detail?: string;
      } | null;
      if (!response.ok || !json?.url) {
        setSidebarError(
          `Open document failed: ${json?.detail ?? json?.error ?? response.statusText}`,
        );
        return;
      }
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setSidebarError(
        `Open document failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setOpeningDocId(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUploadResults([]);
    setSplitUploadInfo(null);

    if (!file) {
      setError("Please choose a PDF or image file.");
      return;
    }

    const formData = new FormData();
    formData.append("mailSequence", mailSequence);
    formData.append("docSequence", docSequence);
    formData.append("sender", sender);
    formData.append("addressee", addressee);
    formData.append("mieName", mieName);
    formData.append("envelopeCondition", envelopeCondition);
    formData.append("file", file);

    setLoading(true);
    try {
      const response = await fetch("/api/intake", {
        method: "POST",
        body: formData,
      });

      const json: unknown = await response.json();
      if (!response.ok) {
        const j = json as { detail?: string; error?: string };
        const detail = j.detail?.trim();
        const err = j.error?.trim();
        const msg =
          detail && err && detail !== err
            ? `${err}: ${detail}`
            : (detail ?? err ?? "Upload failed.");
        setError(msg);
        return;
      }

      if (isManualIntakeSplitPayload(json)) {
        setUploadResults(json.documents);
        setSplitUploadInfo({
          sourceFileName: json.sourceFileName,
          errors: json.errors ?? [],
        });
      } else {
        setUploadResults([json as IntakeResponse]);
        setSplitUploadInfo(null);
      }
      await loadRecentDocuments();
      await loadOpenExceptions();
    } catch (submitError) {
      const detail =
        submitError instanceof Error ? submitError.message : "Unexpected error";
      setError(detail);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          AIMA Intake MVP (OCR + D2 classification)
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Production intake is email-based (SOP): scans arrive in a Gmail label
          and are polled via{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            /api/cron/intake-email
          </code>
          . Manual upload below is optional for testing.
        </p>
      </header>

      {sidebarError ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {sidebarError}
        </div>
      ) : null}

      {!manualIntakeEnabled ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Manual web upload is disabled (
          <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/50">
            NEXT_PUBLIC_MANUAL_INTAKE_ENABLED=false
          </code>
          ). Use Gmail intake and the cron endpoint instead.
        </div>
      ) : null}

      {manualIntakeEnabled ? (
        <form
          className="grid gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          onSubmit={handleSubmit}
        >
          <label className="grid gap-1 text-sm">
            Mail Sequence (optional debug override)
            <input
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={mailSequence}
              onChange={(e) => setMailSequence(e.target.value)}
              inputMode="numeric"
              placeholder="Auto-generated if empty"
            />
          </label>

          <label className="grid gap-1 text-sm">
            Document Sequence (optional debug override)
            <input
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={docSequence}
              onChange={(e) => setDocSequence(e.target.value)}
              inputMode="numeric"
              placeholder="Auto-generated if empty"
            />
          </label>

          <label className="grid gap-1 text-sm">
            Sender (optional)
            <input
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={sender}
              onChange={(e) => setSender(e.target.value)}
            />
          </label>

          <label className="grid gap-1 text-sm">
            Addressee (optional)
            <input
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={addressee}
              onChange={(e) => setAddressee(e.target.value)}
            />
          </label>

          <label className="grid gap-1 text-sm">
            MIE Name (optional)
            <input
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={mieName}
              onChange={(e) => setMieName(e.target.value)}
            />
          </label>

          <label className="grid gap-1 text-sm">
            Envelope Condition
            <select
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              value={envelopeCondition}
              onChange={(e) => setEnvelopeCondition(e.target.value)}
            >
              <option value="sealed">sealed</option>
              <option value="tampered">tampered</option>
              <option value="damaged">damaged</option>
            </select>
          </label>

          <label className="grid gap-1 text-sm">
            Document (PDF/PNG/JPG/WEBP)
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-60 dark:bg-white dark:text-black"
          >
            {loading ? "Processing..." : "Upload, OCR, and classify"}
          </button>
        </form>
      ) : null}

      {manualIntakeEnabled && error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {manualIntakeEnabled && uploadResults.length > 0 ? (
        <section className="grid gap-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-emerald-900 dark:text-emerald-100">
                Results
              </h2>
              {splitUploadInfo ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  PDF split from{" "}
                  <strong className="break-all">
                    {splitUploadInfo.sourceFileName}
                  </strong>{" "}
                  · {uploadResults.length} segment(s) ingested.
                </p>
              ) : null}
              {splitUploadInfo && splitUploadInfo.errors.length > 0 ? (
                <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <strong>Some segments failed:</strong>
                  <ul className="mt-1 list-inside list-disc">
                    {splitUploadInfo.errors.map((e) => (
                      <li key={e.chunkIndex}>
                        Chunk {e.chunkIndex} (HTTP {e.status}):{" "}
                        {e.detail.length > 240
                          ? `${e.detail.slice(0, 240)}…`
                          : e.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900"
              onClick={() => {
                setUploadResults([]);
                setSplitUploadInfo(null);
                setError(null);
              }}
            >
              Close
            </button>
          </div>

          {uploadResults.map((result, segIdx) => {
            const segmentDetail = pickUploadDetail(recent, result.documentId);
            return (
              <div
                key={result.documentId}
                className="grid gap-4 rounded-lg border border-emerald-200/90 bg-white/40 p-3 dark:border-emerald-800/60 dark:bg-emerald-950/25"
              >
                {uploadResults.length > 1 ? (
                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
                    Segment {segIdx + 1} of {uploadResults.length}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p
                      className="break-all font-medium text-zinc-900 dark:text-zinc-100"
                      title={result.file.name}
                    >
                      {result.file.name}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                      <strong>DRID:</strong> {result.drid}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                    disabled={openingDocId === result.documentId}
                    onClick={() => void openReviewDocument(result.documentId)}
                  >
                    {openingDocId === result.documentId
                      ? "Opening…"
                      : "View document"}
                  </button>
                </div>

                {splitUploadInfo ? (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    <strong>Source PDF:</strong>{" "}
                    <span className="break-all font-medium text-zinc-800 dark:text-zinc-200">
                      {splitUploadInfo.sourceFileName}
                    </span>
                  </p>
                ) : null}

                {result.split &&
                (splitUploadInfo != null ||
                  (result.split.total ?? 0) > 1) ? (
                  <div className="grid gap-1 rounded border border-zinc-200 bg-white/70 p-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950/40 dark:text-zinc-300">
                    <div className="font-medium text-zinc-800 dark:text-zinc-200">
                      PDF segment (split)
                    </div>
                    {result.split.total != null && result.split.total > 1 ? (
                      <div>
                        Split chunk {result.split.index ?? "?"}/
                        {result.split.total} via{" "}
                        {result.split.method ?? "unknown"}
                        {result.split.confidence != null
                          ? ` (${result.split.confidence}%)`
                          : ""}
                        {result.split.sectionType
                          ? ` · ${result.split.sectionType}`
                          : ""}
                      </div>
                    ) : (
                      <div>
                        Split analysis: single segment via{" "}
                        {result.split.method ?? "unknown"}
                        {result.split.confidence != null
                          ? ` (${result.split.confidence}%)`
                          : ""}
                        {result.split.sectionType
                          ? ` · ${result.split.sectionType}`
                          : ""}
                      </div>
                    )}
                    {result.split.pageStart != null &&
                    result.split.pageEnd != null ? (
                      <div>
                        <strong>Pages in original PDF:</strong>{" "}
                        {result.split.pageStart}–{result.split.pageEnd}
                      </div>
                    ) : null}
                    {result.split.reason ? (
                      <div>
                        <strong>Split reason:</strong> {result.split.reason}
                      </div>
                    ) : null}
                    {result.split.suspectedMultiInvoice ? (
                      <div className="text-amber-800 dark:text-amber-200">
                        Multi-invoice suspected — review recommended
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="grid gap-2 rounded border border-emerald-200/80 bg-white/80 p-3 text-zinc-800 dark:border-emerald-800/50 dark:bg-zinc-950/40 dark:text-zinc-200">
                  <div>
                    <strong>Document type (D2):</strong>{" "}
                    {result.classification?.label ?? "—"}
                    {result.classification != null
                      ? ` (${result.classification.confidence}% · ${result.classification.method})`
                      : null}
                  </div>
                  {segmentDetail?.entity_document_type &&
                  segmentDetail.entity_document_type !==
                    result.classification?.label ? (
                    <div>
                      <strong>Extracted document type:</strong>{" "}
                      {segmentDetail.entity_document_type}
                    </div>
                  ) : null}
                  <div>
                    <strong>Recipient (addressee):</strong>{" "}
                    {segmentDetail?.entity_addressee ??
                      result.entitySummary?.company_name ??
                      "—"}
                  </div>
                  <div>
                    <strong>Organization (client company):</strong>{" "}
                    {segmentDetail?.entity_organization_name ?? "—"}
                  </div>
                  <div>
                    <strong>Contact person:</strong>{" "}
                    {segmentDetail?.entity_contact_person_name ?? "—"}
                  </div>
                  <div>
                    <strong>Client / claimant:</strong>{" "}
                    {segmentDetail?.entity_claimant_name ??
                      result.entitySummary?.client_name ??
                      "—"}
                  </div>
                  {segmentDetail?.entity_sender &&
                  segmentDetail.entity_sender.trim() !==
                    (
                      segmentDetail.entity_claimant_name ??
                      result.entitySummary?.client_name ??
                      ""
                    ).trim() ? (
                    <div>
                      <strong>Sender:</strong> {segmentDetail.entity_sender}
                    </div>
                  ) : null}
                  <div>
                    <strong>Claimant email:</strong>{" "}
                    {segmentDetail?.entity_claimant_email ??
                      result.entitySummary?.claimant_email ??
                      "—"}
                  </div>
                  <div>
                    <strong>Respondent email:</strong>{" "}
                    {segmentDetail?.entity_respondent_email ??
                      result.entitySummary?.respondent_email ??
                      "—"}
                  </div>
                </div>

                {hasInvoiceEntityFields(segmentDetail) ? (
                  <div className="grid gap-1.5 rounded border border-emerald-200/80 bg-white/90 p-3 dark:border-emerald-800/50 dark:bg-zinc-950/50">
                    <div className="font-medium text-emerald-900 dark:text-emerald-100">
                      Invoice
                    </div>
                    {segmentDetail?.entity_vendor_name ? (
                      <div>
                        <strong>Account / vendor:</strong>{" "}
                        {segmentDetail.entity_vendor_name}
                      </div>
                    ) : null}
                    {segmentDetail?.entity_invoice_number ? (
                      <div>
                        <strong>Bill / invoice no.:</strong>{" "}
                        {segmentDetail.entity_invoice_number}
                      </div>
                    ) : null}
                    {segmentDetail?.entity_invoice_date ? (
                      <div>
                        <strong>Bill date:</strong>{" "}
                        {segmentDetail.entity_invoice_date}
                      </div>
                    ) : null}
                    {segmentDetail?.entity_due_date ? (
                      <div>
                        <strong>Due date:</strong>{" "}
                        {segmentDetail.entity_due_date}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {segmentDetail?.entity_total_amount ? (
                        <span>
                          <strong>Total:</strong>{" "}
                          {segmentDetail.entity_total_amount}{" "}
                          {segmentDetail.entity_currency ?? ""}
                        </span>
                      ) : null}
                      {segmentDetail?.entity_tax_amount ? (
                        <span>
                          <strong>GST / tax:</strong>{" "}
                          {segmentDetail.entity_tax_amount}
                        </span>
                      ) : null}
                      {segmentDetail?.entity_currency &&
                      !segmentDetail?.entity_total_amount ? (
                        <span>
                          <strong>Currency:</strong>{" "}
                          {segmentDetail.entity_currency}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <details className="rounded border border-zinc-200 bg-white/60 p-3 dark:border-zinc-700 dark:bg-zinc-950/30">
                  <summary className="cursor-pointer font-medium text-zinc-800 dark:text-zinc-200">
                    OCR text (click to expand)
                  </summary>
                  {result.ocr ? (
                    <div className="mt-3 grid gap-2">
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">
                        {result.ocr.pageCount} page(s) ·{" "}
                        {result.ocr.textLength} chars · {result.ocr.provider}
                      </div>
                      <div className="max-h-64 overflow-auto rounded border border-zinc-300 bg-white p-3 font-mono text-xs leading-relaxed dark:border-zinc-700 dark:bg-zinc-900">
                        {result.ocr.text || "(No text extracted)"}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-zinc-600 dark:text-zinc-400">
                      OCR/classification reused from canonical duplicate
                      document.
                    </div>
                  )}
                </details>

                <details className="rounded border border-zinc-200 bg-white/60 p-3 dark:border-zinc-700 dark:bg-zinc-950/30">
                  <summary className="cursor-pointer font-medium text-zinc-800 dark:text-zinc-200">
                    Technical details (IDs, rationale, SHA256)
                  </summary>
                  <div className="mt-3 grid gap-2 text-zinc-700 dark:text-zinc-300">
                    <div>
                      <strong>MRID:</strong> {result.mrid}
                    </div>
                    <div>
                      <strong>DRID:</strong> {result.drid}
                    </div>
                    <div>
                      <strong>Mail Item ID:</strong> {result.mailItemId}
                    </div>
                    <div>
                      <strong>Document ID:</strong> {result.documentId}
                    </div>
                    <div>
                      <strong>Status:</strong> {result.status.mailItem} /{" "}
                      {result.status.document}
                    </div>
                    {result.classification ? (
                      <div className="space-y-1">
                        <div>
                          <strong>Classification rationale:</strong>
                        </div>
                        <div className="text-zinc-600 dark:text-zinc-400">
                          {result.classification.rationale}
                        </div>
                      </div>
                    ) : null}
                    {result.duplicate ? (
                      <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                        <strong>Duplicate:</strong>{" "}
                        {result.duplicate.duplicateOfDrid
                          ? `same content as ${result.duplicate.duplicateOfDrid}`
                          : `same content as document ${result.duplicate.duplicateOfDocumentId}`}{" "}
                        ({result.duplicate.reason})
                      </div>
                    ) : null}
                    {result.flags?.lowTextCoverage ? (
                      <div>
                        <strong>Warning:</strong> Low OCR text coverage,
                        exception queued.
                      </div>
                    ) : null}
                    {result.split?.parentRef ? (
                      <div className="break-all">
                        <strong>Split parent ref:</strong>{" "}
                        <span className="font-mono text-xs">
                          {result.split.parentRef}
                        </span>
                      </div>
                    ) : null}
                    {result.split?.model ? (
                      <div>
                        <strong>Split model:</strong> {result.split.model}
                      </div>
                    ) : null}
                    <div>
                      <strong>SHA256:</strong> {result.file.sha256}
                    </div>
                  </div>
                </details>
              </div>
            );
          })}
        </section>
      ) : null}

      <section className="grid gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Recent Documents</h2>
        {recent.length === 0 ? (
          <p className="text-zinc-600 dark:text-zinc-400">No records yet.</p>
        ) : (
          recent.map((doc) => (
            <div
              key={doc.id}
              className="rounded border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div>
                <strong>DRID:</strong> {doc.drid}
              </div>
              {doc.is_duplicate ? (
                <div className="text-amber-700 dark:text-amber-300">
                  Duplicate
                  {doc.duplicate_of_document_id
                    ? ` · of ${doc.duplicate_of_document_id}`
                    : ""}
                  {doc.duplicate_reason ? ` · ${doc.duplicate_reason}` : ""}
                </div>
              ) : null}
              {doc.split_total && doc.split_total > 1 ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  Split chunk {doc.split_index ?? "?"}/{doc.split_total} via{" "}
                  {doc.split_method ?? "unknown"}
                  {doc.split_confidence != null
                    ? ` (${doc.split_confidence}%)`
                    : ""}
                  {doc.split_section_type ? ` · ${doc.split_section_type}` : ""}
                </div>
              ) : null}
              {doc.split_reason ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  Split reason: {doc.split_reason}
                </div>
              ) : null}
              {doc.multi_invoice_suspected ? (
                <div className="text-amber-700 dark:text-amber-300">
                  Multi-invoice suspected (single fallback) - review required
                </div>
              ) : null}
              {doc.classification_label != null &&
              doc.classification_label !== "" ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {doc.classification_label}
                  {doc.classification_confidence != null
                    ? ` · ${doc.classification_confidence}%`
                    : null}
                  {doc.classification_method != null &&
                  doc.classification_method !== ""
                    ? ` · ${doc.classification_method}`
                    : null}
                </div>
              ) : null}

              {doc.entity_reference_number ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  Reference: {doc.entity_reference_number}
                </div>
              ) : null}
              {doc.entity_invoice_number || doc.entity_total_amount ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {doc.entity_invoice_number
                    ? `Invoice: ${doc.entity_invoice_number}`
                    : null}
                  {doc.entity_total_amount
                    ? `${doc.entity_invoice_number ? " | " : ""}Total: ${
                        doc.entity_total_amount
                      }`
                    : null}
                </div>
              ) : null}
              {doc.entity_due_date ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  Due: {doc.entity_due_date}
                </div>
              ) : null}
              {doc.entity_case_number || doc.entity_authority ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {doc.entity_case_number
                    ? `Case: ${doc.entity_case_number}`
                    : null}
                  {doc.entity_authority
                    ? `${doc.entity_case_number ? " | " : ""}Authority: ${
                        doc.entity_authority
                      }`
                    : null}
                </div>
              ) : null}

              {doc.entity_claimant_name || doc.entity_respondent_name ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {doc.entity_claimant_name
                    ? `Claimant: ${doc.entity_claimant_name}`
                    : null}
                  {doc.entity_respondent_name
                    ? `${doc.entity_claimant_name ? " | " : ""}Respondent: ${
                        doc.entity_respondent_name
                      }`
                    : null}
                </div>
              ) : null}
              {doc.entity_claimant_email ||
              doc.entity_respondent_email ||
              doc.entity_respondent_contact_name ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {doc.entity_claimant_email
                    ? `Claimant email: ${doc.entity_claimant_email}`
                    : null}
                  {doc.entity_respondent_email
                    ? `${doc.entity_claimant_email ? " | " : ""}Respondent email: ${
                        doc.entity_respondent_email
                      }`
                    : null}
                  {doc.entity_respondent_contact_name
                    ? `${
                        doc.entity_claimant_email || doc.entity_respondent_email
                          ? " | "
                          : ""
                      }Respondent contact: ${doc.entity_respondent_contact_name}`
                    : null}
                </div>
              ) : null}
              {doc.entity_employment_status ||
              doc.entity_occupation ||
              doc.entity_employment_start_date ||
              doc.entity_employment_end_date ||
              doc.entity_basic_salary_monthly ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {[
                    doc.entity_employment_status
                      ? `Status: ${doc.entity_employment_status}`
                      : null,
                    doc.entity_occupation
                      ? `Role: ${doc.entity_occupation}`
                      : null,
                    doc.entity_employment_start_date || doc.entity_employment_end_date
                      ? `Employment: ${doc.entity_employment_start_date ?? "?"} → ${doc.entity_employment_end_date ?? "?"}`
                      : null,
                    doc.entity_basic_salary_monthly
                      ? `Basic salary/mo: ${doc.entity_basic_salary_monthly}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
              {doc.entity_deadline || doc.entity_reference_legal ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  {doc.entity_deadline
                    ? `Deadline: ${doc.entity_deadline}`
                    : null}
                  {doc.entity_reference_legal
                    ? `${doc.entity_deadline ? " | " : ""}Legal Ref: ${
                        doc.entity_reference_legal
                      }`
                    : null}
                </div>
              ) : null}

              <div>
                <strong>Status:</strong> {doc.status}
              </div>
              {doc.review_status ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  D3: {doc.review_status}
                  {doc.reviewed_by ? ` · by ${doc.reviewed_by}` : ""}
                  {doc.reviewed_at
                    ? ` · ${new Date(doc.reviewed_at).toLocaleString()}`
                    : ""}
                </div>
              ) : null}
              <div>
                <strong>Created:</strong>{" "}
                {new Date(doc.created_at).toLocaleString()}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="grid gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Open Exceptions</h2>
        {openExceptions.length === 0 ? (
          <p className="text-zinc-600 dark:text-zinc-400">
            No open exceptions.
          </p>
        ) : (
          openExceptions.map((exception) => (
            <div
              key={exception.id}
              className="rounded border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div>
                <strong>DRID:</strong> {exception.drid}
              </div>
              <div>
                <strong>Type:</strong> {exception.type}
              </div>
              <div>
                <strong>Root Cause:</strong>{" "}
                {exception.root_cause ?? "Not provided"}
              </div>
              <div>
                <strong>Suggested Action:</strong>{" "}
                {exception.suggested_action ?? "Not provided"}
              </div>
              <div>
                <strong>Created:</strong>{" "}
                {new Date(exception.created_at).toLocaleString()}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="grid gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Gmail Label Counts (Debug)</h2>
          <button
            type="button"
            onClick={() => void loadGmailCounts()}
            className="rounded border border-zinc-300 px-3 py-1 text-xs dark:border-zinc-700"
          >
            Refresh counts
          </button>
        </div>
        <p className="text-zinc-600 dark:text-zinc-400">
          Compare Gmail sidebar badge with API counts (`messagesTotal` /
          `messagesUnread`).
        </p>
        {gmailCountError ? (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {gmailCountError}
          </div>
        ) : null}
        {gmailCounts ? (
          <div className="grid gap-2">
            <div>
              <strong>User:</strong> {gmailCounts.userId}
            </div>
            <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
              <strong>Unprocessed:</strong>{" "}
              {gmailCounts.unprocessed
                ? `${gmailCounts.unprocessed.name} | total=${gmailCounts.unprocessed.messagesTotal}, unread=${gmailCounts.unprocessed.messagesUnread}`
                : "label not found"}
            </div>
            <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
              <strong>Processed:</strong>{" "}
              {gmailCounts.processed
                ? `${gmailCounts.processed.name} | total=${gmailCounts.processed.messagesTotal}, unread=${gmailCounts.processed.messagesUnread}`
                : "label not found"}
            </div>
          </div>
        ) : (
          <p className="text-zinc-600 dark:text-zinc-400">
            Click "Refresh counts" to fetch Gmail label totals.
          </p>
        )}
      </section>

      <section className="grid gap-3 rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <h2 className="text-lg font-semibold">D3 Review Queue</h2>
        <div className="grid gap-2 rounded border border-zinc-200 p-3 dark:border-zinc-800">
          <label className="grid gap-1">
            Reviewer
            <input
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              value={reviewerName}
              onChange={(e) => setReviewerName(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            Note (required for correction, recommended otherwise)
            <input
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              value={reviewActionNote}
              onChange={(e) => setReviewActionNote(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            Corrected label
            <select
              className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              value={reviewActionLabel}
              onChange={(e) => setReviewActionLabel(e.target.value)}
            >
              <option value="IRAS">IRAS</option>
              <option value="ACRA">ACRA</option>
              <option value="MOM">MOM</option>
              <option value="BANK_FINANCIAL">BANK_FINANCIAL</option>
              <option value="LEGAL">LEGAL</option>
              <option value="UTILITY_PROPERTY">UTILITY_PROPERTY</option>
              <option value="GENERAL">GENERAL</option>
              <option value="UNKNOWN">UNKNOWN</option>
            </select>
          </label>
        </div>
        {reviewQueue.length === 0 ? (
          <p className="text-zinc-600 dark:text-zinc-400">
            No documents currently require D3 review.
          </p>
        ) : (
          reviewQueue.map((item) => (
            <div
              key={item.id}
              className="grid gap-2 rounded border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div>
                <strong>DRID:</strong> {item.drid}
              </div>
              <div>
                <strong>Status:</strong> {item.status}
              </div>
              <div className="text-zinc-600 dark:text-zinc-400">
                {item.classification_label ?? "UNKNOWN"}
                {item.classification_confidence != null
                  ? ` · ${item.classification_confidence}%`
                  : ""}
                {item.classification_method
                  ? ` · ${item.classification_method}`
                  : ""}
              </div>
              {item.is_duplicate ? (
                <div className="text-amber-700 dark:text-amber-300">
                  Duplicate · {item.duplicate_reason ?? "sha256_match"}
                </div>
              ) : null}
              {item.split_total && item.split_total > 1 ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  Split chunk {item.split_index ?? "?"}/{item.split_total} via{" "}
                  {item.split_method ?? "unknown"}
                  {item.split_confidence != null
                    ? ` (${item.split_confidence}%)`
                    : ""}
                  {item.split_section_type
                    ? ` · ${item.split_section_type}`
                    : ""}
                </div>
              ) : null}
              {item.split_reason ? (
                <div className="text-zinc-600 dark:text-zinc-400">
                  Split reason: {item.split_reason}
                </div>
              ) : null}
              {item.multi_invoice_suspected ? (
                <div className="text-amber-700 dark:text-amber-300">
                  Multi-invoice suspected (single fallback)
                </div>
              ) : null}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                  disabled={openingDocId === item.id}
                  onClick={() => void openReviewDocument(item.id)}
                >
                  {openingDocId === item.id ? "Opening..." : "Open Document"}
                </button>
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                  onClick={() => void runReviewAction(item.id, "approve")}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                  onClick={() => void runReviewAction(item.id, "correct")}
                >
                  Correct Label
                </button>
                <button
                  type="button"
                  className="rounded border border-zinc-300 px-3 py-1 dark:border-zinc-700"
                  onClick={() => void runReviewAction(item.id, "needs_rescan")}
                >
                  Needs Rescan
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
