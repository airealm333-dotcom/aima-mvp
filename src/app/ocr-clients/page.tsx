"use client";

import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type OcrSummary = {
  pageCount: number;
  textLength: number;
  provider: string;
  pageAlignment: {
    pdfPages: number;
    ocrSegmentsBeforeAlign: number;
    paddedBlankPages?: number;
    droppedOcrSegments?: number;
  } | null;
};

type ClientItem = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  pdfBase64: string | null;
  pdfError: string | null;
};

type SuccessPayload = {
  fileName: string;
  ocr: OcrSummary;
  items: ClientItem[];
};

function base64ToBlobUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "application/pdf" });
  return URL.createObjectURL(blob);
}

export default function OcrClientsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuccessPayload | null>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const previewUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      for (const u of previewUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      previewUrlsRef.current = [];
    };
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      for (const u of previewUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      previewUrlsRef.current = [];
      setPreviewUrls([]);

      if (!file) {
        setError("Choose a PDF file.");
        return;
      }

      setLoading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/ocr-clients", {
          method: "POST",
          body: formData,
        });

        const json: unknown = await response.json();
        if (!response.ok) {
          const o = json as { error?: string; detail?: string };
          const msg = [o.error, o.detail].filter(Boolean).join(": ");
          setError(msg || "Request failed.");
          return;
        }

        const payload = json as SuccessPayload;
        setResult(payload);

        const urls: string[] = [];
        for (const item of payload.items) {
          if (item.pdfBase64) {
            try {
              urls.push(base64ToBlobUrl(item.pdfBase64));
            } catch {
              urls.push("");
            }
          } else {
            urls.push("");
          }
        }
        previewUrlsRef.current = urls;
        setPreviewUrls(urls);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unexpected error.");
      } finally {
        setLoading(false);
      }
    },
    [file],
  );

  const jsonPreview = useMemo(() => {
    if (!result) return "";
    const slim = {
      fileName: result.fileName,
      ocr: result.ocr,
      items: result.items.map(
        ({
          index,
          name,
          UEN,
          document_type,
          page_range,
          pageStart,
          pageEnd,
          pdfError,
        }) => ({
          index,
          name,
          UEN,
          document_type,
          page_range,
          pageStart,
          pageEnd,
          pdfBase64: "(omitted)",
          pdfError,
        }),
      ),
    };
    return JSON.stringify(slim, null, 2);
  }, [result]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href="/" className="text-zinc-600 underline dark:text-zinc-400">
            ← Back to intake
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">OCR → clients + PDF splits</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Upload a PDF. The server runs the same OCR pipeline as{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            npm run ocr-pdf
          </code>{" "}
          (
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            extractPdfText
          </code>
          , labeled pages), then{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            extract-ocr-clients
          </code>{" "}
          (Claude) for{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            name
          </code>
          ,{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">UEN</code>
          ,{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            document_type
          </code>
          ,{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
            page_range
          </code>
          . Each row is sliced into a sub-PDF from that range.
        </p>
      </header>

      <form
        className="grid gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        onSubmit={handleSubmit}
      >
        <label className="grid gap-1 text-sm">
          PDF file
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="text-sm"
            onChange={(ev) => {
              const f = ev.target.files?.[0] ?? null;
              setFile(f);
            }}
          />
        </label>
        <button
          type="submit"
          disabled={loading || !file}
          className="w-fit rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {loading ? "Running OCR + extraction…" : "Run pipeline"}
        </button>
      </form>

      {error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {result ? (
        <section className="space-y-4">
          <div className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <h2 className="mb-2 font-medium">OCR summary</h2>
            <ul className="list-inside list-disc text-zinc-600 dark:text-zinc-400">
              <li>File: {result.fileName}</li>
              <li>Pages: {result.ocr.pageCount}</li>
              <li>Provider: {result.ocr.provider}</li>
              <li>Text length: {result.ocr.textLength}</li>
              {result.ocr.pageAlignment ? (
                <li>
                  Alignment note: OCR segments before align ={" "}
                  {result.ocr.pageAlignment.ocrSegmentsBeforeAlign} (see server
                  logs / JSON)
                </li>
              ) : null}
            </ul>
          </div>

          <div className="space-y-6">
            <h2 className="text-lg font-medium">
              Extracted items ({result.items.length})
            </h2>
            {result.items.map((item, i) => {
              const src = previewUrls[i] ?? "";
              return (
                <article
                  key={`${i}-${item.index}-${item.page_range}`}
                  className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
                >
                  <div className="grid gap-2 border-b border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        <strong>Name:</strong> {item.name || "—"}
                      </span>
                      <span>
                        <strong>UEN:</strong> {item.UEN || "—"}
                      </span>
                    </div>
                    <div>
                      <strong>Document type:</strong>{" "}
                      {item.document_type || "—"}
                    </div>
                    <div>
                      <strong>page_range (model):</strong> {item.page_range}
                      {item.pageStart != null && item.pageEnd != null ? (
                        <span className="text-zinc-600 dark:text-zinc-400">
                          {" "}
                          → PDF pages {item.pageStart}–{item.pageEnd}
                        </span>
                      ) : null}
                    </div>
                    {item.pdfError ? (
                      <p className="text-red-600 dark:text-red-400">
                        PDF slice: {item.pdfError}
                      </p>
                    ) : null}
                  </div>
                  {src ? (
                    <iframe
                      title={`Split PDF ${item.index + 1}`}
                      src={`${src}#toolbar=1`}
                      className="h-[min(70vh,640px)] w-full bg-zinc-100 dark:bg-zinc-950"
                    />
                  ) : !item.pdfError ? (
                    <p className="p-4 text-sm text-zinc-500">
                      No preview (missing PDF data).
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>

          <details className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <summary className="cursor-pointer text-sm font-medium">
              JSON shape (base64 omitted)
            </summary>
            <pre className="mt-3 max-h-96 overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
              {jsonPreview}
            </pre>
          </details>
        </section>
      ) : null}
    </div>
  );
}
