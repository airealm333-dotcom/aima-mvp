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
  error?: string;
  detail?: string;
};

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
  const [result, setResult] = useState<IntakeResponse | null>(null);
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
    setResult(null);

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

      const json = (await response.json()) as IntakeResponse;
      if (!response.ok) {
        const detail = json.detail?.trim();
        const err = json.error?.trim();
        const msg =
          detail && err && detail !== err
            ? `${err}: ${detail}`
            : (detail ?? err ?? "Upload failed.");
        setError(msg);
        return;
      }

      setResult(json);
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

      {manualIntakeEnabled && result ? (
        <section className="grid gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
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
                <strong>Classification:</strong> {result.classification.label} (
                {result.classification.confidence}% via{" "}
                {result.classification.method})
              </div>
              <div className="text-zinc-700 dark:text-zinc-300">
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
              <strong>Warning:</strong> Low OCR text coverage, exception queued.
            </div>
          ) : null}
          <div>
            <strong>SHA256:</strong> {result.file.sha256}
          </div>
          {result.ocr ? (
            <>
              <div>
                <strong>Pages:</strong> {result.ocr.pageCount} |{" "}
                <strong>Text length:</strong> {result.ocr.textLength}
              </div>
              <div>
                <strong>OCR Provider:</strong> {result.ocr.provider}
              </div>
              <div className="max-h-56 overflow-auto rounded border border-zinc-300 bg-white p-3 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900">
                {result.ocr.text || "(No text extracted)"}
              </div>
            </>
          ) : (
            <div className="text-zinc-600 dark:text-zinc-400">
              OCR/classification reused from canonical duplicate document.
            </div>
          )}
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
