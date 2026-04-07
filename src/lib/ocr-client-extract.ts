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
Return ONLY a valid JSON object with no additional text, explanation, or markdown formatting.
The object must follow this exact structure:
{
  "overall_confidence": 0,
  "items": [
    {"name": "", "UEN": "", "document_type": "", "page_range": "", "classification": "", "confidence": 0, "sender_name": "", "sender_address": "", "document_date": ""}
  ]
}

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
  - UNKNOWN: cannot determine the document type
- sender_name: the organisation or authority that issued/sent the document (e.g. "Inland Revenue Authority of Singapore", "DBS Bank", "Drew & Napier LLC"). Use "Null" if not found.
- sender_address: the sender's address as printed on the document. Use "Null" if not found.
- document_date: the date printed on the document (e.g. issue date, statement date, receipt date). Use ISO format YYYY-MM-DD if possible, otherwise use the date as printed. Use "Null" if not found.

Confidence scoring (integer 0-100):
- confidence (per item): how certain you are about the extracted fields for that specific document split — consider name clarity, UEN presence, page boundary sharpness, and text quality for those pages
- overall_confidence: how confident you are in the completeness and accuracy of the entire extraction — penalise for poor OCR quality, overlapping page ranges, ambiguous boundaries, or missing entities`;

export type OcrClientExtractRow = {
  name: string;
  UEN: string;
  document_type: string;
  page_range: string;
  classification: ClassificationLabel;
  confidence: number;
  sender_name: string;
  sender_address: string;
  document_date: string;
};

export type OcrClientExtractResult = {
  overall_confidence: number;
  items: OcrClientExtractRow[];
};

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseModelJson(raw: string): unknown {
  return JSON.parse(stripJsonFences(raw)) as unknown;
}

function clampConfidence(v: unknown): number {
  const n = v != null && typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.round(Math.min(100, Math.max(0, n)));
}

export function normalizeOcrClientExtractResult(
  parsed: unknown,
): OcrClientExtractResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model output is not a JSON object.");
  }
  const root = parsed as Record<string, unknown>;

  const overall_confidence = clampConfidence(root.overall_confidence ?? 50);

  const rawItems = root.items;
  if (!Array.isArray(rawItems)) {
    throw new Error('Model output missing "items" array.');
  }

  const items: OcrClientExtractRow[] = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const row = rawItems[i];
    if (!row || typeof row !== "object") {
      throw new Error(`Invalid item at index ${i}: not an object.`);
    }
    const r = row as Record<string, unknown>;
    const name = r.name != null ? String(r.name).trim() : "";
    let UEN = r.UEN != null ? String(r.UEN).trim() : "";
    if (!UEN || UEN.toLowerCase() === "null") UEN = "Null";
    const document_type =
      r.document_type != null ? String(r.document_type).trim() : "";
    const page_range = r.page_range != null ? String(r.page_range).trim() : "";
    const rawClassification =
      r.classification != null
        ? String(r.classification).trim().toUpperCase()
        : "";
    const classification: ClassificationLabel = (
      CLASSIFICATION_LABELS as readonly string[]
    ).includes(rawClassification)
      ? (rawClassification as ClassificationLabel)
      : "UNKNOWN";
    const confidence = clampConfidence(r.confidence ?? 50);
    let sender_name = r.sender_name != null ? String(r.sender_name).trim() : "Null";
    if (!sender_name || sender_name.toLowerCase() === "null") sender_name = "Null";
    let sender_address = r.sender_address != null ? String(r.sender_address).trim() : "Null";
    if (!sender_address || sender_address.toLowerCase() === "null") sender_address = "Null";
    let document_date = r.document_date != null ? String(r.document_date).trim() : "Null";
    if (!document_date || document_date.toLowerCase() === "null") document_date = "Null";
    items.push({ name, UEN, document_type, page_range, classification, confidence, sender_name, sender_address, document_date });
  }

  return { overall_confidence, items };
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
): Promise<OcrClientExtractResult> {
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

  const { input_tokens, output_tokens } = response.usage;
  console.log(
    `[ocr-client-extract] tokens — input: ${input_tokens}, output: ${output_tokens}, total: ${input_tokens + output_tokens} | model: ${response.model}`,
  );

  const block = response.content[0];
  const text = block?.type === "text" ? block.text : "";
  if (!text.trim()) {
    throw new Error("Empty response from model.");
  }

  return normalizeOcrClientExtractResult(parseModelJson(text));
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
