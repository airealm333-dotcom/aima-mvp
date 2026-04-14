"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  sender_name: string | null;
  sender_address: string | null;
  document_date: string | null;
  odoo_contact_name: string | null;
  dispatched_at: string | null;
};

type ReviewDoc = {
  id: string;
  drid: string;
  file_path: string;
  created_at: string;
  ocr_clients_items: OcrSplitItem[] | null;
  ocr_clients_status: string | null;
};

type OdooPartner = {
  id: number;
  name: string;
  uen: string | null;
  legalName: string | null;
  email: string | null;
};

type OdooUser = {
  id: number;
  name: string;
  email: string;
};

type DocSummary = {
  id: string;
  drid: string;
  created_at: string;
  totalItems: number;
  reviewCount: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 70;

function reviewReasons(item: OcrSplitItem): string[] {
  const r: string[] = [];
  if (item.confidence != null && item.confidence < CONFIDENCE_THRESHOLD)
    r.push(`Low confidence (${Math.round(item.confidence)}%)`);
  if (!item.odoo_match_status || item.odoo_match_status === "error")
    r.push("Match not run");
  if (item.odoo_match_status === "no_match") r.push("No Odoo match");
  if (item.odoo_match_status === "ambiguous") r.push("Ambiguous match");
  if (item.odoo_match_status === "matched" && !item.odoo_contact_email)
    r.push("No contact email");
  if (item.UEN === "Null" && item.odoo_match_status !== "matched")
    r.push("UEN missing");
  if (item.pdfError) r.push("PDF error");
  return r;
}

function matchStatusColor(status: string | null) {
  if (status === "matched") return "bg-green-900/40 text-green-300";
  if (status === "no_match") return "bg-red-900/40 text-red-300";
  if (status === "ambiguous") return "bg-yellow-900/40 text-yellow-300";
  if (status === "error") return "bg-red-900/40 text-red-300";
  return "bg-zinc-800 text-zinc-400";
}

function confColor(score: number) {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  return "text-red-400";
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReviewDetailPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [doc, setDoc] = useState<ReviewDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Document switcher
  const [needsReviewDocs, setNeedsReviewDocs] = useState<DocSummary[]>([]);
  const [processedDocs, setProcessedDocs] = useState<DocSummary[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  // Selected item (index into ALL items, not just review items)
  const [selectedItemIndex, setSelectedItemIndex] = useState(0);

  // PDF viewer
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfMode, setPdfMode] = useState<"split" | "full">("split");

  // Odoo search
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<OdooPartner[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedPartner, setSelectedPartner] = useState<OdooPartner | null>(null);
  const [matchExpanded, setMatchExpanded] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Contact editor
  const [contactEmail, setContactEmail] = useState("");
  const [contactSaving, setContactSaving] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);

  // Accounting manager dropdown
  const [odooUsers, setOdooUsers] = useState<OdooUser[]>([]);
  const [selectedManagerId, setSelectedManagerId] = useState<number | "">("");

  // Manual match
  const [matchSaving, setMatchSaving] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchSuccess, setMatchSuccess] = useState(false);

  // Matched partner name (fetched from Odoo when item has a partner_id)
  const [matchedPartnerName, setMatchedPartnerName] = useState<string | null>(null);
  // All partner names for the item list sidebar
  const [partnerNames, setPartnerNames] = useState<Record<number, string>>({});

  // ── Fetch doc ──
  useEffect(() => {
    setLoading(true);
    const itemParam = Number(searchParams.get("item") ?? "0");
    setSelectedItemIndex(Number.isFinite(itemParam) && itemParam >= 0 ? itemParam : 0);
    fetch(`/api/dashboard/review/${documentId}`)
      .then((r) => r.json())
      .then((d: { doc?: ReviewDoc; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setDoc(d.doc ?? null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [documentId]);

  // ── Fetch all docs (for switcher) ──
  useEffect(() => {
    fetch("/api/dashboard/review")
      .then((r) => r.json())
      .then((d: { needsReview?: DocSummary[]; processed?: DocSummary[] }) => {
        setNeedsReviewDocs(d.needsReview ?? []);
        setProcessedDocs(d.processed ?? []);
      })
      .catch(() => {});
  }, []);

  // ── Fetch Odoo users for manager dropdown ──
  useEffect(() => {
    fetch("/api/dashboard/review/odoo-users")
      .then((r) => r.json())
      .then((d: { users?: OdooUser[] }) => {
        setOdooUsers(d.users ?? []);
      })
      .catch(() => {});
  }, []);

  // ── Close switcher on outside click ──
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node))
        setSwitcherOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const allItems = doc?.ocr_clients_items ?? [];
  const currentItem = allItems[selectedItemIndex] ?? null;
  const totalReviewCount = allItems.filter((i) => reviewReasons(i).length > 0).length;

  // ── Sync state with selected item ──
  useEffect(() => {
    setContactEmail(currentItem?.odoo_contact_email ?? "");
    setContactSaved(false);
    setSelectedPartner(null);
    setSearchQ("");
    setSearchResults(null);
    setMatchError(null);
    setMatchSuccess(false);
    setMatchExpanded(false);
    setMatchedPartnerName(null);
    // Preselect manager if current item's email matches an Odoo user
    const mgrEmail = currentItem?.odoo_accounting_manager_email;
    if (mgrEmail && odooUsers.length > 0) {
      const u = odooUsers.find((x) => x.email === mgrEmail);
      setSelectedManagerId(u ? u.id : "");
    } else {
      setSelectedManagerId("");
    }
  }, [currentItem, odooUsers]);

  // ── Fetch all partner names for matched items (for sidebar) ──
  useEffect(() => {
    if (!doc?.ocr_clients_items) return;
    const ids = [...new Set(
      doc.ocr_clients_items
        .filter((it) => it.odoo_partner_id != null)
        .map((it) => it.odoo_partner_id as number)
    )];
    if (ids.length === 0) return;
    Promise.all(
      ids.map((id) =>
        fetch(`/api/dashboard/review/odoo-search?id=${id}`)
          .then((r) => r.json())
          .then((d: { partner?: OdooPartner | null }) => ({ id, name: d.partner?.name ?? null }))
          .catch(() => ({ id, name: null }))
      )
    ).then((results) => {
      const map: Record<number, string> = {};
      for (const { id, name } of results) if (name) map[id] = name;
      setPartnerNames(map);
    });
  }, [doc]);

  // ── Sync matched partner name for details panel ──
  useEffect(() => {
    const partnerId = currentItem?.odoo_partner_id;
    if (!partnerId) { setMatchedPartnerName(null); return; }
    if (partnerNames[partnerId]) { setMatchedPartnerName(partnerNames[partnerId]); return; }
    fetch(`/api/dashboard/review/odoo-search?id=${partnerId}`)
      .then((r) => r.json())
      .then((d: { partner?: OdooPartner | null }) => setMatchedPartnerName(d.partner?.name ?? null))
      .catch(() => setMatchedPartnerName(null));
  }, [currentItem?.odoo_partner_id, partnerNames]);

  // ── Load PDF ──
  const loadPdf = useCallback(
    async (mode: "split" | "full", item: OcrSplitItem | null) => {
      if (!item) return;
      setPdfLoading(true);
      setPdfUrl(null);
      const path = mode === "split" && item.split_path ? item.split_path : undefined;
      const url = `/api/dashboard/review/${documentId}/signed-url${path ? `?path=${encodeURIComponent(path)}` : ""}`;
      try {
        const res = await fetch(url);
        const d = (await res.json()) as { url?: string; error?: string };
        setPdfUrl(d.url ?? null);
      } catch {
        setPdfUrl(null);
      } finally {
        setPdfLoading(false);
      }
    },
    [documentId],
  );

  useEffect(() => {
    if (currentItem) {
      const mode = currentItem.split_path ? "split" : "full";
      setPdfMode(mode);
      loadPdf(mode, currentItem);
    }
  }, [currentItem, loadPdf]);

  // ── Odoo search ──
  const handleSearch = useCallback((q: string) => {
    setSearchQ(q);
    setSelectedPartner(null);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!q.trim()) { setSearchResults(null); return; }
    searchDebounce.current = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const res = await fetch(`/api/dashboard/review/odoo-search?q=${encodeURIComponent(q)}`);
        const d = (await res.json()) as { partners?: OdooPartner[]; error?: string };
        if (d.error) { setSearchError(d.error); return; }
        setSearchResults(d.partners ?? []);
      } catch (e) {
        setSearchError(String(e));
      } finally {
        setSearchLoading(false);
      }
    }, 400);
  }, []);

  // ── Manual match ──
  const handleManualMatch = useCallback(async () => {
    if (!selectedPartner || !currentItem) return;
    setMatchSaving(true);
    setMatchError(null);
    setMatchSuccess(false);
    try {
      const res = await fetch(
        `/api/dashboard/review/${documentId}/items/${currentItem.index}/manual-match`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partnerId: selectedPartner.id }),
        },
      );
      const d = (await res.json()) as { item?: OcrSplitItem; error?: string };
      if (d.error) { setMatchError(d.error); return; }
      if (d.item && doc) {
        const updatedItems = doc.ocr_clients_items?.map((it) =>
          it.index === currentItem.index ? (d.item as OcrSplitItem) : it,
        ) ?? null;
        setDoc({ ...doc, ocr_clients_items: updatedItems });
        setContactEmail(d.item.odoo_contact_email ?? "");
        setSearchResults(null);
        setSearchQ("");
        setSelectedPartner(null);
        setMatchExpanded(false);
        setMatchSuccess(true);
        setTimeout(() => setMatchSuccess(false), 4000);
      }
    } catch (e) {
      setMatchError(String(e));
    } finally {
      setMatchSaving(false);
    }
  }, [selectedPartner, currentItem, documentId, doc]);

  // ── Contact save ──
  const handleSaveContact = useCallback(async () => {
    if (!currentItem) return;
    setContactSaving(true);
    setContactSaved(false);
    try {
      const selectedMgr =
        typeof selectedManagerId === "number"
          ? odooUsers.find((u) => u.id === selectedManagerId)
          : null;
      const res = await fetch(
        `/api/dashboard/review/${documentId}/items/${currentItem.index}/contact`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: contactEmail,
            accountingManagerName: selectedMgr?.name ?? "",
            accountingManagerEmail: selectedMgr?.email ?? "",
          }),
        },
      );
      const d = (await res.json()) as { item?: OcrSplitItem; error?: string };
      if (d.item && doc) {
        const updatedItems = doc.ocr_clients_items?.map((it) =>
          it.index === currentItem.index ? (d.item as OcrSplitItem) : it,
        ) ?? null;
        setDoc({ ...doc, ocr_clients_items: updatedItems });
        setContactSaved(true);
        setTimeout(() => setContactSaved(false), 3000);
      }
    } finally {
      setContactSaving(false);
    }
  }, [currentItem, contactEmail, selectedManagerId, odooUsers, documentId, doc]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const allDocCount = needsReviewDocs.length + processedDocs.length;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        Loading…
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950 text-zinc-400">
        <p className="text-red-400">{error ?? "Document not found"}</p>
        <Link href="/dashboard" className="text-sm text-blue-400 underline">← Back to dashboard</Link>
      </div>
    );
  }

  const item = currentItem;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">

      {/* ── Top bar ── */}
      <header className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-900 px-6 py-3">
        <Link href="/dashboard" className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          ← Dashboard
        </Link>
        <div className="h-4 w-px bg-zinc-700" />

        {/* Document switcher */}
        <div ref={switcherRef} className="relative">
          <button
            onClick={() => setSwitcherOpen((o) => !o)}
            className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-sm font-mono text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            {doc.drid}
            {allDocCount > 0 && <span className="text-zinc-500">▾</span>}
          </button>

          {switcherOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl">

              {needsReviewDocs.length > 0 && (
                <>
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-500">
                    ⚠ Needs Review
                  </p>
                  {needsReviewDocs.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => { setSwitcherOpen(false); router.push(`/dashboard/review/${d.id}`); }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800 ${d.id === documentId ? "text-amber-300" : "text-zinc-300"}`}
                    >
                      <span className="font-mono">{d.drid}</span>
                      <span className="ml-3 flex-shrink-0 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-400">
                        {d.reviewCount}/{d.totalItems} flagged
                      </span>
                    </button>
                  ))}
                </>
              )}

              {processedDocs.length > 0 && (
                <>
                  <div className="my-1 border-t border-zinc-800" />
                  <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-green-500">
                    ✓ Processed
                  </p>
                  {processedDocs.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => { setSwitcherOpen(false); router.push(`/dashboard/review/${d.id}`); }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800 ${d.id === documentId ? "text-green-300" : "text-zinc-300"}`}
                    >
                      <span className="font-mono">{d.drid}</span>
                      <span className="ml-3 flex-shrink-0 rounded bg-green-900/40 px-1.5 py-0.5 text-[10px] text-green-400">
                        {d.totalItems} item{d.totalItems !== 1 ? "s" : ""}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {totalReviewCount > 0 ? (
            <span className="rounded bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-300">
              ⚠ {totalReviewCount} item{totalReviewCount !== 1 ? "s" : ""} need review
            </span>
          ) : (
            <span className="rounded bg-green-900/40 px-2 py-0.5 text-xs font-medium text-green-300">
              ✓ All items processed
            </span>
          )}
        </div>
      </header>

      {/* ── Main split: item list | details | pdf ── */}
      {item ? (
        <div className="flex flex-1 overflow-hidden">

          {/* Column 1 — vertical item list */}
          <nav className="flex w-56 flex-shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950">
            <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              {allItems.length} item{allItems.length !== 1 ? "s" : ""}
            </div>
            {allItems.map((it, i) => {
              const reasons = reviewReasons(it);
              const hasReview = reasons.length > 0;
              const isActive = i === selectedItemIndex;
              return (
                <button
                  key={it.index}
                  onClick={() => setSelectedItemIndex(i)}
                  className={`group flex w-full flex-col gap-0.5 border-l-2 px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? hasReview
                        ? "border-amber-500 bg-amber-950/40 text-amber-200"
                        : "border-blue-500 bg-blue-950/40 text-blue-200"
                      : hasReview
                        ? "border-transparent text-amber-400 hover:border-amber-700 hover:bg-zinc-900"
                        : "border-transparent text-zinc-400 hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
                >
                  <span className="block truncate text-xs font-medium leading-snug">
                    {it.name || `Item ${it.index + 1}`}
                  </span>
                  <span className="text-[10px] opacity-60">pp. {it.page_range}</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {/* Match status pill */}
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                      it.odoo_match_status === "matched"
                        ? "bg-green-900/50 text-green-400"
                        : it.odoo_match_status === "no_match"
                          ? "bg-red-900/50 text-red-400"
                          : it.odoo_match_status === "ambiguous"
                            ? "bg-yellow-900/50 text-yellow-400"
                            : "bg-zinc-800 text-zinc-500"
                    }`}>
                      {it.odoo_match_status ?? "—"}
                    </span>
                    {/* Review reason badges */}
                    {hasReview && reasons.slice(0, 2).map((r) => (
                      <span key={r} className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[9px] text-amber-400">
                        {r}
                      </span>
                    ))}
                    {reasons.length > 2 && (
                      <span className="text-[9px] text-amber-500">+{reasons.length - 2}</span>
                    )}
                  </div>
                  {/* Show matched company name in sidebar */}
                  {it.odoo_match_status === "matched" && it.odoo_partner_id && partnerNames[it.odoo_partner_id] && (
                    <span className="mt-0.5 block truncate text-[10px] text-green-400 opacity-80">
                      {partnerNames[it.odoo_partner_id]}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Column 2 — details panel */}
          <aside className="flex w-[380px] flex-shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-800 p-5">

            {/* Client info */}
            <section>
              <h2 className="mb-1 text-lg font-semibold leading-tight">{item.name || "—"}</h2>
              {reviewReasons(item).length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1">
                  {reviewReasons(item).map((r) => (
                    <span key={r} className="rounded bg-amber-900/40 px-2 py-0.5 text-xs text-amber-300">
                      ⚠ {r}
                    </span>
                  ))}
                </div>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-zinc-500">UEN</dt>
                <dd className="font-mono text-zinc-200">
                  {item.UEN === "Null" ? <span className="text-zinc-500">—</span> : item.UEN}
                </dd>
                <dt className="text-zinc-500">Pages</dt>
                <dd className="text-zinc-200">{item.page_range}</dd>
                <dt className="text-zinc-500">Confidence</dt>
                <dd className={`font-medium ${confColor(item.confidence)}`}>{Math.round(item.confidence)}%</dd>
                <dt className="text-zinc-500">Type</dt>
                <dd className="text-zinc-200">{item.document_type || item.classification || "—"}</dd>
                {item.sender_name && (
                  <>
                    <dt className="text-zinc-500">Sender</dt>
                    <dd className="text-zinc-200">{item.sender_name}</dd>
                  </>
                )}
                {item.sender_address && (
                  <>
                    <dt className="text-zinc-500">Sender Address</dt>
                    <dd className="text-zinc-200 text-xs">{item.sender_address}</dd>
                  </>
                )}
                {item.pdfError && (
                  <>
                    <dt className="text-zinc-500">PDF Error</dt>
                    <dd className="text-xs text-red-400">{item.pdfError}</dd>
                  </>
                )}
              </dl>
            </section>

            <hr className="border-zinc-800" />

            {/* Odoo match */}
            <section>
              <h3 className="mb-2 text-sm font-semibold text-zinc-300">Odoo Match</h3>

              {/* Matched company name — the main thing users want to see */}
              {item.odoo_match_status === "matched" && (
                <div className="mb-3 rounded-lg border border-green-800/50 bg-green-950/30 px-3 py-2">
                  {matchedPartnerName ? (
                    <p className="text-sm font-semibold text-green-300">{matchedPartnerName}</p>
                  ) : (
                    <p className="text-sm text-zinc-500 italic">Loading…</p>
                  )}
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    Partner ID {item.odoo_partner_id}
                    {item.odoo_match_method ? ` · ${item.odoo_match_method}` : ""}
                    {item.odoo_match_score != null ? ` · score ${item.odoo_match_score}` : ""}
                  </p>
                </div>
              )}

              <div className="mb-3 flex items-center gap-2 flex-wrap">
                <span className={`rounded px-2 py-0.5 font-mono text-[11px] uppercase ${matchStatusColor(item.odoo_match_status)}`}>
                  {item.odoo_match_status ?? "not run"}
                </span>
                {item.odoo_match_status !== "matched" && item.odoo_match_method && (
                  <span className="text-xs text-zinc-500">{item.odoo_match_method}</span>
                )}
                {item.odoo_match_status !== "matched" && item.odoo_match_score != null && (
                  <span className="text-xs text-zinc-500">score {item.odoo_match_score}</span>
                )}
                {matchSuccess && (
                  <span className="text-xs text-green-400">✓ Matched</span>
                )}
              </div>

              {/* Change match — always available */}
              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
                <button
                  onClick={() => setMatchExpanded((o) => !o)}
                  className="flex w-full items-center justify-between text-xs font-medium text-zinc-400 hover:text-zinc-200"
                >
                  <span>{item.odoo_match_status === "matched" ? "Change match" : "Match manually"}</span>
                  <span>{matchExpanded ? "▲" : "▼"}</span>
                </button>

                {matchExpanded && (
                  <div className="mt-3">
                    <input
                      type="text"
                      value={searchQ}
                      onChange={(e) => handleSearch(e.target.value)}
                      placeholder="Search by name or UEN…"
                      className="w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-amber-500"
                    />
                    {searchError && <p className="mt-1 text-xs text-red-400">{searchError}</p>}
                    {searchLoading && <p className="mt-2 text-xs text-zinc-500">Searching…</p>}
                    {searchResults && searchResults.length === 0 && !searchLoading && (
                      <p className="mt-2 text-xs text-zinc-500">No results.</p>
                    )}
                    {searchResults && searchResults.length > 0 && (
                      <ul className="mt-2 max-h-48 overflow-y-auto rounded border border-zinc-700">
                        {searchResults.map((p) => (
                          <li key={p.id}>
                            <button
                              onClick={() => setSelectedPartner((prev) => prev?.id === p.id ? null : p)}
                              className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                                selectedPartner?.id === p.id
                                  ? "bg-amber-700/30 text-amber-200"
                                  : "text-zinc-300 hover:bg-zinc-800"
                              }`}
                            >
                              <span className="block font-medium">{p.name}</span>
                              <span className="block text-[11px] text-zinc-500">
                                {p.uen ? `UEN: ${p.uen}` : p.legalName ?? ""}
                                {p.email ? ` · ${p.email}` : ""}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {selectedPartner && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="flex-1 truncate text-xs text-amber-300">
                          Selected: {selectedPartner.name}
                        </span>
                        <button
                          onClick={handleManualMatch}
                          disabled={matchSaving}
                          className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                        >
                          {matchSaving ? "Matching…" : "Confirm"}
                        </button>
                      </div>
                    )}
                    {matchError && <p className="mt-1 text-xs text-red-400">{matchError}</p>}
                  </div>
                )}
              </div>
            </section>

            <hr className="border-zinc-800" />

            {/* Contact email + accounting manager */}
            <section>
              <h3 className="mb-2 text-sm font-semibold text-zinc-300">Contact Email</h3>
              {item.odoo_resolution_method && (
                <p className="mb-1 text-xs text-zinc-500">
                  Resolved via: <span className="text-zinc-400">{item.odoo_resolution_method}</span>
                </p>
              )}
              <input
                type="email"
                value={contactEmail}
                onChange={(e) => { setContactEmail(e.target.value); setContactSaved(false); }}
                placeholder="contact@example.com"
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500"
              />

              <label className="mt-3 mb-1 block text-xs font-medium text-zinc-400">
                Accounting Manager
              </label>
              <select
                value={selectedManagerId === "" ? "" : String(selectedManagerId)}
                onChange={(e) => {
                  const v = e.target.value;
                  setSelectedManagerId(v === "" ? "" : Number(v));
                  setContactSaved(false);
                }}
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
              >
                <option value="">— Select manager —</option>
                {odooUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </option>
                ))}
              </select>

              {(() => {
                const alreadyDispatched = Boolean(item.dispatched_at);
                const alreadyMatched = item.odoo_match_status === "matched";
                const missingInputs = !contactEmail.trim() || selectedManagerId === "";

                if (alreadyDispatched) {
                  return (
                    <p className="mt-3 rounded border border-green-800/50 bg-green-950/30 px-3 py-2 text-xs text-green-300">
                      ✓ Email already dispatched — no further action needed.
                    </p>
                  );
                }

                return (
                  <>
                    <button
                      onClick={handleSaveContact}
                      disabled={contactSaving || missingInputs}
                      className="mt-3 w-full rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                    >
                      {contactSaving
                        ? "Saving…"
                        : contactSaved
                          ? "✓ Saved — will dispatch"
                          : alreadyMatched
                            ? "Update contact / manager"
                            : "Save & mark as matched"}
                    </button>
                    {missingInputs && !alreadyMatched && (
                      <p className="mt-1 text-[11px] text-zinc-500">
                        Both contact email and accounting manager are required to mark as matched.
                      </p>
                    )}
                  </>
                );
              })()}
            </section>

          </aside>

          {/* Column 3 — PDF viewer */}
          <main className="flex flex-1 flex-col bg-zinc-900">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2">
              <span className="min-w-0 truncate text-xs text-zinc-500">
                {pdfMode === "split" ? `Pages ${item.page_range} — ${item.name}` : `Full document — ${doc.drid}`}
              </span>
              <div className="flex flex-shrink-0 items-center gap-3">
                {/* Split / Full toggle */}
                {item.split_path && (
                  <div className="flex gap-0.5 rounded border border-zinc-700 p-0.5">
                    {(["split", "full"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => { setPdfMode(m); loadPdf(m, item); }}
                        className={`rounded px-2.5 py-0.5 text-xs font-medium transition-colors ${
                          pdfMode === m ? "bg-zinc-600 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {m === "split" ? `pp. ${item.page_range}` : "Full doc"}
                      </button>
                    ))}
                  </div>
                )}
                {pdfUrl && (
                  <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">
                    Open ↗
                  </a>
                )}
              </div>
            </div>
            <div className="relative flex-1">
              {pdfLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 text-sm text-zinc-400">
                  Loading PDF…
                </div>
              )}
              {!pdfLoading && !pdfUrl && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                  PDF not available
                </div>
              )}
              {pdfUrl && (
                <iframe src={pdfUrl} className="h-full w-full border-0" title="Document PDF" />
              )}
            </div>
          </main>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-zinc-500">
          No items in this document.
        </div>
      )}
    </div>
  );
}
