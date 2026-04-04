import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";

export const CLASSIFICATION_LABELS = [
  "IRAS",
  "ACRA",
  "MOM",
  "BANK_FINANCIAL",
  "LEGAL",
  "UTILITY_PROPERTY",
  "GENERAL",
  "UNKNOWN",
] as const;

export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

/** Same contract as `scripts/extract-ocr-clients.ts` / Claude system prompt. */
export const OCR_CLIENT_EXTRACT_SYSTEM_PROMPT = `You are a document analysis assistant. Extract all distinct clients/entities from the provided document text.
Return ONLY a valid JSON array with no additional text, explanation, or markdown formatting.
Each object must follow this exact structure:
{"name": "", "UEN": "", "document_type": "", "page_range": "", "classification": ""}

Rules:
- If UEN is not found, use "Null"
- page_range should be in format "1-5" or "18" for single pages
- document_type should be concise but descriptive
- Include one entry per distinct document per entity
- classification must be exactly one of: IRAS, ACRA, MOM, BANK_FINANCIAL, LEGAL, UTILITY_PROPERTY, GENERAL, UNKNOWN
  - IRAS: tax notices, income tax assessments, GST filings, IRAS correspondence
  - ACRA: business registration, incorporation, annual returns, ACRA notices
  - MOM: work passes, employment passes, MOM letters, CPF notices
  - BANK_FINANCIAL: bank statements, loan documents, financial statements, investment reports
  - LEGAL: contracts, agreements, court documents, legal notices
  - UTILITY_PROPERTY: utility bills, property tax, tenancy agreements, SP services
  - GENERAL: general business correspondence, invoices, receipts not covered above
  - UNKNOWN: cannot determine the document type`;

export type OcrClientExtractRow = {
  name: string;
  UEN: string;
  document_type: string;
  page_range: string;
  classification: ClassificationLabel;
};

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseModelJsonArray(raw: string): unknown {
  return JSON.parse(stripJsonFences(raw)) as unknown;
}

export function normalizeOcrClientExtractRows(
  parsed: unknown,
): OcrClientExtractRow[] {
  if (!Array.isArray(parsed)) {
    throw new Error("Model output is not a JSON array.");
  }
  const out: OcrClientExtractRow[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const row = parsed[i];
    if (!row || typeof row !== "object") {
      throw new Error(`Invalid row at index ${i}: not an object.`);
    }
    const r = row as Record<string, unknown>;
    const name = r.name != null ? String(r.name).trim() : "";
    let UEN = r.UEN != null ? String(r.UEN).trim() : "";
    if (!UEN || UEN.toLowerCase() === "null") UEN = "Null";
    const document_type =
      r.document_type != null ? String(r.document_type).trim() : "";
    const page_range = r.page_range != null ? String(r.page_range).trim() : "";
    const rawClassification =
      r.classification != null ? String(r.classification).trim().toUpperCase() : "";
    const classification: ClassificationLabel =
      (CLASSIFICATION_LABELS as readonly string[]).includes(rawClassification)
        ? (rawClassification as ClassificationLabel)
        : "UNKNOWN";
    out.push({ name, UEN, document_type, page_range, classification });
  }
  return out;
}

function resolveAnthropicModel(): string {
  return (
    process.env.ANTHROPIC_OCR_CLIENT_EXTRACT_MODEL?.trim() ||
    process.env.ANTHROPIC_ENTITY_MODEL?.trim() ||
    "claude-sonnet-4-6"
  );
}

/**
 * Calls Claude with the same prompt as `npm run extract-ocr-clients`.
 */
export async function extractOcrClientRowsFromDocumentText(
  documentText: string,
  options?: { apiKey?: string },
): Promise<OcrClientExtractRow[]> {
  const trimmed = documentText.trim();
  if (!trimmed) {
    throw new Error("Document text is empty.");
  }
  const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY.");
  }

  const userMessage = `Extract all distinct clients, UEN, document type and page range from the following document text:

${trimmed}`;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: resolveAnthropicModel(),
    max_tokens: 8192,
    temperature: 0,
    system: OCR_CLIENT_EXTRACT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content[0];
  const text = block?.type === "text" ? block.text : "";
  if (!text.trim()) {
    throw new Error("Empty response from model.");
  }

  return normalizeOcrClientExtractRows(parseModelJsonArray(text));
}

/**
 * Parse `page_range` from the model (1-based inclusive PDF pages).
 * Supports "18", "1-5", unicode dashes; clamps to [1, totalPages].
 */
export function parsePageRangeString(
  raw: string,
  totalPages: number,
): { start: number; end: number } | null {
  if (totalPages < 1) return null;
  const s = raw.trim().replace(/–|—/g, "-");
  if (!s) return null;

  const single = /^(\d+)$/.exec(s);
  if (single) {
    const p = Number(single[1]);
    if (!Number.isFinite(p) || p < 1 || p > totalPages) return null;
    return { start: p, end: p };
  }

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (range) {
    let start = Number(range[1]);
    let end = Number(range[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end) [start, end] = [end, start];
    if (start < 1) start = 1;
    if (end > totalPages) end = totalPages;
    if (start > end) return null;
    return { start, end };
  }

  return null;
}

/**
 * Copy inclusive 1-based page range from a PDF into a new PDF buffer.
 */
export async function slicePdfBufferByOneBasedPageRange(
  sourceBuffer: Buffer,
  startPage: number,
  endPage: number,
): Promise<Buffer> {
  if (startPage < 1 || endPage < startPage) {
    throw new Error(`Invalid page range: ${startPage}-${endPage}`);
  }
  const src = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
  const n = src.getPageCount();
  if (startPage > n || endPage > n) {
    throw new Error(
      `Range ${startPage}-${endPage} outside PDF (${n} page(s)).`,
    );
  }
  const out = await PDFDocument.create();
  const zeroIndices: number[] = [];
  for (let p = startPage - 1; p <= endPage - 1; p += 1) {
    zeroIndices.push(p);
  }
  const copied = await out.copyPages(src, zeroIndices);
  for (const page of copied) {
    out.addPage(page);
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}
