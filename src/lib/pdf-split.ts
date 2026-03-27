import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { scanPdfBarcodeStartPages } from "@/lib/barcode-scan";
import { extractPdfText } from "@/lib/ocr";
import {
  buildChunksFromSections,
  splitPdfWithClaudeVision,
} from "@/lib/pdf-vision-split";

export type PdfChunk = {
  buffer: Buffer;
  pageStart: number;
  pageEnd: number;
  index: number;
  total: number;
  sectionType: string;
  reason: string;
  confidence: number;
};

export type PdfSplitResult = {
  chunks: PdfChunk[];
  method: "anthropic" | "barcode_rules" | "single";
  confidence: number;
  suspectedMultiInvoice: boolean;
  reason?: string;
  model?: string;
};

function splitPageText(rawText: string, pageCount: number): string[] {
  const byFormFeed = rawText
    .split("\f")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  if (byFormFeed.length === pageCount) return byFormFeed;
  if (byFormFeed.length > 1) return byFormFeed;
  return [rawText.trim()];
}

type ProposedSection = {
  startPage: number;
  endPage: number;
  sectionType: string;
  confidence: number;
  reason: string;
};

async function buildChunkBuffer(
  source: PDFDocument,
  pageStart: number,
  pageEnd: number,
): Promise<Buffer> {
  const out = await PDFDocument.create();
  const pageIndexes = Array.from(
    { length: pageEnd - pageStart + 1 },
    (_, idx) => pageStart + idx,
  );
  const copied = await out.copyPages(source, pageIndexes);
  for (const page of copied) out.addPage(page);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

function parseJsonArray(raw: string): ProposedSection[] | null {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed)) return null;
    const sections: ProposedSection[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const pages = Array.isArray(r.pages) ? r.pages : null;
      const startPage = Number(pages?.[0]);
      const endPage = Number(pages?.[1]);
      const sectionType = String(r.document_type ?? "unknown")
        .trim()
        .toLowerCase();
      const confidence = Math.round(Number(r.confidence));
      const reason = String(r.boundary_signal ?? "").trim();
      if (
        !Number.isInteger(startPage) ||
        !Number.isInteger(endPage) ||
        startPage < 1 ||
        endPage < startPage ||
        !Number.isFinite(confidence)
      ) {
        return null;
      }
      sections.push({
        startPage,
        endPage,
        sectionType: sectionType || "other",
        confidence: Math.max(0, Math.min(100, confidence)),
        reason: reason || "No reason provided by model.",
      });
    }
    return sections.length > 0 ? sections : null;
  } catch (_error) {
    return null;
  }
}

function validateAndNormalizeSections(
  proposed: ProposedSection[],
  pageCount: number,
): ProposedSection[] | null {
  const sorted = [...proposed].sort((a, b) => a.startPage - b.startPage);
  let previousEnd = 0;
  const normalized: ProposedSection[] = [];

  for (const section of sorted) {
    if (section.endPage > pageCount) return null;
    if (section.startPage <= previousEnd) return null;
    if (section.startPage > previousEnd + 1) {
      normalized.push({
        startPage: previousEnd + 1,
        endPage: section.startPage - 1,
        sectionType: "other",
        confidence: 40,
        reason: "Auto-filled uncovered page gap.",
      });
    }
    normalized.push(section);
    previousEnd = section.endPage;
  }

  if (previousEnd < pageCount) {
    normalized.push({
      startPage: previousEnd + 1,
      endPage: pageCount,
      sectionType: "other",
      confidence: 40,
      reason: "Auto-filled trailing uncovered pages.",
    });
  }
  return normalized;
}

function hasStrongBoundaryEvidence(reason: string): boolean {
  const normalizedReason = reason.toLowerCase();
  return /barcode|page\s*1\s*of|reference|case|account|policy|letterhead|new sender|tracking/.test(
    normalizedReason,
  );
}

function isOnePlusRestSplit(
  sections: ProposedSection[],
  totalPages: number,
): boolean {
  if (sections.length !== 2) return false;
  const sorted = [...sections].sort((a, b) => a.startPage - b.startPage);
  return (
    sorted[0].startPage === 1 &&
    sorted[0].endPage === 1 &&
    sorted[1].startPage === 2 &&
    sorted[1].endPage === totalPages
  );
}

function detectBarcodeStartPages(pageTexts: string[]): number[] {
  const barcodePages: number[] = [];

  for (let i = 0; i < pageTexts.length; i += 1) {
    const page = pageTexts[i]?.replace(/\s+/g, " ").trim() ?? "";
    if (!page) continue;

    // Strongest signal: explicit "barcode" + long numeric token.
    const hasBarcodeLabel = /\bbarcode\b/i.test(page);
    const hasLongDigits = /\b\d{6,}\b/.test(page);

    if (hasBarcodeLabel && hasLongDigits) {
      barcodePages.push(i + 1); // 1-indexed pages
    }
  }

  // Ensure strictly ascending unique values.
  return Array.from(new Set(barcodePages)).sort((a, b) => a - b);
}

function buildSectionsFromStartPages(
  startPages: number[],
  totalPages: number,
): ProposedSection[] {
  const sections: ProposedSection[] = [];
  for (let i = 0; i < startPages.length; i += 1) {
    const start = startPages[i];
    const nextStart = startPages[i + 1];
    const end = nextStart ? nextStart - 1 : totalPages;
    if (start > end) continue;
    sections.push({
      startPage: start,
      endPage: end,
      sectionType: "barcode_packet",
      confidence: 97,
      reason: `Barcode start page ${start}`,
    });
  }
  return sections;
}

export async function splitPdfIntoLogicalSections(
  buffer: Buffer,
): Promise<PdfSplitResult> {
  const source = await PDFDocument.load(buffer);
  const actualPdfPages = source.getPageCount();
  const debugEnabled = process.env.PDF_SPLIT_DEBUG === "true";

  // Primary path: render PDF pages and use Claude Vision page-level boundary detection.
  const visionSplit = await splitPdfWithClaudeVision({
    buffer,
    totalPages: actualPdfPages > 0 ? actualPdfPages : 1,
    debugEnabled,
  });
  if (visionSplit.sections && visionSplit.sections.length > 1) {
    const chunks = await buildChunksFromSections(source, visionSplit.sections);
    const avgConfidence =
      chunks.length > 0
        ? Math.round(
            chunks.reduce((sum, chunk) => sum + chunk.confidence, 0) /
              chunks.length,
          )
        : 0;
    if (debugEnabled) {
      console.info("[pdf-split] split_method", "anthropic_vision");
      console.info("[pdf-split] vision_sections", visionSplit.sections);
    }
    return {
      chunks,
      method: "anthropic",
      confidence: avgConfidence,
      suspectedMultiInvoice: false,
      reason: visionSplit.reason,
      model: visionSplit.model,
    };
  }
  if (debugEnabled) {
    console.info(
      "[pdf-split] vision_split_fallback_reason",
      visionSplit.reason,
    );
  }

  let imageBarcodeStartPages: number[] = [];
  let imageBarcodeReason = "barcode_scan_not_run";
  try {
    const scanned = await scanPdfBarcodeStartPages(buffer);
    imageBarcodeStartPages = scanned.startPages;
    imageBarcodeReason = scanned.reason;
    if (debugEnabled) {
      console.info("[pdf-split] image_barcode_scan_result", {
        startPages: scanned.startPages,
        reason: scanned.reason,
        evidence: scanned.evidence,
      });
    }
  } catch (error) {
    imageBarcodeReason = `barcode_scan_failed:${error instanceof Error ? error.message : "unknown"}`;
    if (debugEnabled) {
      console.info("[pdf-split] image_barcode_scan_error", imageBarcodeReason);
    }
  }

  if (imageBarcodeStartPages.length >= 2) {
    const barcodeSections = buildSectionsFromStartPages(
      imageBarcodeStartPages,
      actualPdfPages > 0 ? actualPdfPages : 1,
    );
    if (barcodeSections.length >= 2) {
      const chunks: PdfChunk[] = [];
      for (let i = 0; i < barcodeSections.length; i += 1) {
        const section = barcodeSections[i];
        const chunkBuffer = await buildChunkBuffer(
          source,
          section.startPage - 1,
          section.endPage - 1,
        );
        chunks.push({
          buffer: chunkBuffer,
          pageStart: section.startPage,
          pageEnd: section.endPage,
          index: i + 1,
          total: barcodeSections.length,
          sectionType: section.sectionType,
          reason: section.reason,
          confidence: section.confidence,
        });
      }

      if (debugEnabled) {
        console.info("[pdf-split] split_method", "barcode_rules");
        console.info("[pdf-split] barcode_sections", barcodeSections);
      }

      const avgConfidence =
        chunks.length > 0
          ? Math.round(
              chunks.reduce((sum, chunk) => sum + chunk.confidence, 0) /
                chunks.length,
            )
          : 0;

      return {
        chunks,
        method: "barcode_rules",
        confidence: avgConfidence,
        suspectedMultiInvoice: false,
        reason: imageBarcodeReason,
      };
    }
  }

  const extracted = await extractPdfText(buffer, "application/pdf");
  const rawText = extracted.text ?? "";
  const totalPages = actualPdfPages > 0 ? actualPdfPages : 1;

  // Avoid splitting on partial OCR coverage (e.g. Vision only returned first 5 pages
  // for a 20-page PDF). Running AI split on truncated text creates incorrect chunks.
  if (extracted.pageCount > 0 && extracted.pageCount < totalPages) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: `ocr_page_mismatch:${extracted.pageCount}/${totalPages}`,
      model:
        process.env.ANTHROPIC_SPLIT_MODEL?.trim() || "claude-3-7-sonnet-latest",
    };
  }
  if (!rawText.trim() || extracted.pageCount <= 0) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: "ocr_no_text_or_pages",
      model:
        process.env.ANTHROPIC_SPLIT_MODEL?.trim() || "claude-3-7-sonnet-latest",
    };
  }

  if (totalPages <= 1) {
    return {
      chunks: [],
      method: "single",
      confidence: 100,
      suspectedMultiInvoice: false,
      reason: "single_page_pdf",
    };
  }

  const pageTexts = splitPageText(rawText, totalPages);
  const barcodeStartPages = detectBarcodeStartPages(pageTexts);

  // Primary deterministic splitter: barcode start pages define packet boundaries.
  if (barcodeStartPages.length >= 2) {
    const barcodeSections = buildSectionsFromStartPages(
      barcodeStartPages,
      totalPages,
    );
    if (barcodeSections.length >= 2) {
      const chunks: PdfChunk[] = [];
      for (let i = 0; i < barcodeSections.length; i += 1) {
        const section = barcodeSections[i];
        const chunkBuffer = await buildChunkBuffer(
          source,
          section.startPage - 1,
          section.endPage - 1,
        );
        chunks.push({
          buffer: chunkBuffer,
          pageStart: section.startPage,
          pageEnd: section.endPage,
          index: i + 1,
          total: barcodeSections.length,
          sectionType: section.sectionType,
          reason: section.reason,
          confidence: section.confidence,
        });
      }

      if (process.env.PDF_SPLIT_DEBUG === "true") {
        console.info("[pdf-split] barcode_start_pages", barcodeStartPages);
        console.info("[pdf-split] barcode_sections", barcodeSections);
      }

      const avgConfidence =
        chunks.length > 0
          ? Math.round(
              chunks.reduce((sum, chunk) => sum + chunk.confidence, 0) /
                chunks.length,
            )
          : 0;

      return {
        chunks,
        method: "barcode_rules",
        confidence: avgConfidence,
        suspectedMultiInvoice: false,
        reason: "barcode_boundary_split",
      };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: "ai_split_unavailable_no_api_key",
    };
  }
  const model =
    process.env.ANTHROPIC_SPLIT_MODEL?.trim() || "claude-3-7-sonnet-latest";

  const ocrText = pageTexts
    .map((text, idx) => {
      const normalizedText = text.replace(/\s+/g, " ").trim();
      const head = normalizedText.slice(0, 2500);
      const tail = normalizedText.slice(-600);
      const signals = normalizedText.match(
        /\b(barcode|tracking|reference|ref\.?|case|account|policy|uen|page\s*1\s*of|invoice|notice|tribunal|court|acra|iras|mom|bank|utility)\b/gi,
      );
      const signalLine = signals?.length
        ? `Signals: ${Array.from(new Set(signals)).slice(0, 20).join(", ")}`
        : "Signals: none";
      return `Page ${idx + 1}:\n${signalLine}\n${head}\n[TAIL]\n${tail}`;
    })
    .join("\n\n");
  const prompt = `You are an expert document boundary detection system for a registered office 
mail handling service. Your job is to split a multi-page PDF (which is a 
batch scan of multiple physical mail items) into individual logical document 
packets.

DOCUMENT BOUNDARY RULES:
1. A NEW document starts when ANY of these signals appear on a page:
   - A new barcode or tracking number at the top of the page
   - A new letterhead or organization logo
   - A new addressee/company name
   - A new reference number, case number, or account number
   - A completely different document type begins (e.g. after a legal notice, 
     a utility bill starts)

2. CONTINUATION pages belong to the PRECEDING document:
   - Annexes, Appendices, Schedules (Annex A, Annex B, Schedule 1, etc.)
   - Explanatory notes, cover letters, instruction sheets
   - Page 2, Page 3 of the same form or letter
   - Supporting documents listed at the end of a main document
   - Terms and conditions pages
   - Any page that says "continued from previous page" or has no new header

3. SAME CLIENT, DIFFERENT DOCUMENTS:
   - If the same company receives 2 different letters (different reference 
     numbers, different senders, different topics), treat them as 
     SEPARATE documents even if the addressee is the same.

4. STRONGEST boundary signals (highest priority):
   - Barcode / tracking number at top of page
   - "Page 1 of X" reset (new document starting at page 1)
   - Completely new sender/issuing authority
   - New claim number, case number, UEN, account number, policy number

DOCUMENT TYPES YOU MAY ENCOUNTER:
- Legal notices (court, tribunal, employment claims)
- Government letters (ACRA, IRAS, MOM, CPF, HDB, LTA, MAS)
- Bank and financial institution letters
- Insurance documents
- Utility bills (electricity, water, telecom, internet)
- Demand letters and legal correspondence
- Audit confirmations
- Company secretarial notices
- General business correspondence

INSTRUCTIONS:
- Analyze the full OCR text page by page
- Group pages into logical document packets
- Each packet = one physical mail item received

DOCUMENT END SIGNALS (when the current packet closes):
- The NEXT barcode/tracking number appears on a new page
- A completely new letterhead from a different organization appears
- A new "Page 1 of X" header appears for a different document
- NEVER end a document just because the page content changes style
- NEVER treat a page with no header as a new document start

CRITICAL RULE:
The barcode marks where a new document BEGINS, not where the 
previous one ENDS. Everything between two barcodes = ONE document.

Example:
  Page 1: barcode 20349490 → Document 1 STARTS
  Pages 2-9: no new barcode → still Document 1
  Page 10: barcode 20349486 → Document 1 ENDS, Document 2 STARTS
  Pages 11-18: no new barcode → still Document 2

Return ONLY a valid JSON array, no explanation, no markdown:
[
  {
    "document_number": 1,
    "pages": [1, 3],
    "document_type": "LEGAL_NOTICE",
    "sender": "Employment Claims Tribunals",
    "addressee": "COMPANY NAME PTE. LTD.",
    "reference": "ECT/10227/2026",
    "boundary_signal": "New barcode 20349490 on page 1",
    "confidence": 98
  },
  {
    "document_number": 2,
    "pages": [4, 5],
    "document_type": "ACRA_CORRESPONDENCE",
    "sender": "ACRA",
    "addressee": "ANOTHER COMPANY PTE. LTD.",
    "reference": "UEN 202134636D",
    "boundary_signal": "New ACRA letterhead and new UEN on page 4",
    "confidence": 95
  }
]

FIELD DEFINITIONS:
- pages: [start_page, end_page] inclusive
- document_type: LEGAL_NOTICE | ACRA_CORRESPONDENCE | IRAS_CORRESPONDENCE | 
  MOM_CORRESPONDENCE | BANK_FINANCIAL | INSURANCE | UTILITY | 
  LEGAL_DEMAND | AUDIT_CONFIRMATION | GENERAL_BUSINESS | UNKNOWN
- sender: who sent the document
- addressee: who it is addressed to (company name)
- reference: the main reference/case/account number
- boundary_signal: what signal told you a new document started here
- confidence: 0-100 how confident you are in this split

PDF OCR TEXT (page by page):
${ocrText}`;

  const client = new Anthropic({ apiKey });
  let parsedSections: ProposedSection[] | null = null;
  const strictJsonInstruction = `
IMPORTANT:
- Return ONLY a raw JSON array.
- No markdown, no code fences, no explanation text.
- Use exactly the requested fields.
`.trim();
  const primaryPrompt = `${prompt}\n\n${strictJsonInstruction}`;
  const retryPrompt = `${prompt}

${strictJsonInstruction}

Your previous response was invalid or low-confidence.
Re-evaluate boundaries strictly using barcode/page-1-reset/reference-number changes.
Do not merge distinct packets.`;
  const extractTextContent = (
    response: Awaited<ReturnType<typeof client.messages.create>>,
  ) => {
    if (!("content" in response) || !Array.isArray(response.content)) {
      return "";
    }
    return response.content
      .filter((block: { type: string; text?: string }) => block.type === "text")
      .map((block: { type: string; text?: string }) => block.text ?? "")
      .join("\n")
      .trim();
  };
  const normalizeModelOutput = (rawOutput: string) =>
    rawOutput
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  try {
    const resp1 = await client.messages.create({
      model,
      max_tokens: 2600,
      temperature: 0,
      messages: [{ role: "user", content: primaryPrompt }],
    });
    let text = normalizeModelOutput(extractTextContent(resp1));
    parsedSections = parseJsonArray(text);
    if (debugEnabled) {
      console.info("[pdf-split] pass1_raw_model_output", text);
      console.info("[pdf-split] pass1_parsed_sections", parsedSections);
    }

    const avgConfidencePass1 =
      parsedSections && parsedSections.length > 0
        ? Math.round(
            parsedSections.reduce(
              (sum, section) => sum + section.confidence,
              0,
            ) / parsedSections.length,
          )
        : 0;
    const needsRetry =
      !parsedSections ||
      parsedSections.length === 0 ||
      avgConfidencePass1 < 65 ||
      (totalPages >= 8 && parsedSections.length === 1) ||
      (parsedSections
        ? isOnePlusRestSplit(parsedSections, totalPages) &&
          (!hasStrongBoundaryEvidence(parsedSections[0]?.reason ?? "") ||
            parsedSections[0].confidence < 75)
        : false);

    if (needsRetry) {
      const resp2 = await client.messages.create({
        model,
        max_tokens: 2600,
        temperature: 0,
        messages: [{ role: "user", content: retryPrompt }],
      });
      text = normalizeModelOutput(extractTextContent(resp2));
      const retryParsed = parseJsonArray(text);
      if (debugEnabled) {
        console.info("[pdf-split] pass2_raw_model_output", text);
        console.info("[pdf-split] pass2_parsed_sections", retryParsed);
      }
      if (retryParsed && retryParsed.length > 0) {
        parsedSections = retryParsed;
      }
    }
  } catch (error) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: `ai_split_failed:${error instanceof Error ? error.message : "unknown"}`,
      model,
    };
  }

  if (!parsedSections) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: "ai_split_invalid_json",
      model,
    };
  }

  const normalized = validateAndNormalizeSections(parsedSections, totalPages);
  if (!normalized || normalized.length === 0) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: "ai_split_invalid_ranges",
      model,
    };
  }
  if (debugEnabled) {
    console.info("[pdf-split] normalized_sections", normalized);
  }

  const suspiciousOnePlusRest =
    isOnePlusRestSplit(normalized, totalPages) &&
    (!hasStrongBoundaryEvidence(normalized[0]?.reason ?? "") ||
      normalized[0].confidence < 75);
  if (suspiciousOnePlusRest) {
    return {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: true,
      reason: "ai_split_suspicious_one_plus_rest",
      model,
    };
  }

  const chunks: PdfChunk[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const section = normalized[i];
    const chunkBuffer = await buildChunkBuffer(
      source,
      section.startPage - 1,
      section.endPage - 1,
    );
    chunks.push({
      buffer: chunkBuffer,
      pageStart: section.startPage,
      pageEnd: section.endPage,
      index: i + 1,
      total: normalized.length,
      sectionType: section.sectionType,
      reason: section.reason,
      confidence: section.confidence,
    });
  }

  const avgConfidence =
    chunks.length > 0
      ? Math.round(
          chunks.reduce((sum, chunk) => sum + chunk.confidence, 0) /
            chunks.length,
        )
      : 0;

  return {
    chunks,
    method: "anthropic",
    confidence: avgConfidence,
    suspectedMultiInvoice: chunks.length <= 1,
    model,
  };
}
