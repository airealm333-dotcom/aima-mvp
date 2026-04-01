import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { fromPath } from "pdf2pic";

type VisionPageEntities = {
  recipientName?: string | null;
  recipientUEN?: string | null;
  recipientAddress?: string | null;
  senderName?: string | null;
  contactPersonName?: string | null;
  organizationName?: string | null;
  documentDate?: string | null;
  referenceNumber?: string | null;
  deadlineDate?: string | null;
  subjectLine?: string | null;
  claimantName?: string | null;
  claimantEmail?: string | null;
  respondentName?: string | null;
  respondentEmail?: string | null;
  accountName?: string | null;
};

type VisionPageResult = {
  fullText?: string;
  isNewDocument?: boolean;
  documentType?: string;
  entities?: VisionPageEntities;
  pageIndicator?: string | null;
  confidence?: number;
};

type VisionSplitSection = {
  startPage: number;
  endPage: number;
  sectionType: string;
  confidence: number;
  reason: string;
};

function getVisionPrompt(prevResult?: VisionPageResult | null) {
  const contextLine = prevResult
    ? `CONTEXT: The previous page was a ${prevResult.documentType ?? "UNKNOWN"} document (isNewDocument was ${prevResult.isNewDocument}, confidence ${prevResult.confidence ?? "?"}). Sender was "${prevResult.entities?.senderName ?? "unknown"}".`
    : "CONTEXT: This is the FIRST page of the PDF. isNewDocument must be true.";

  return `${contextLine}

Extract ALL available information from this document page.
Return JSON only:
{
  "fullText": "complete OCR text from this page",
  "isNewDocument": true/false,
  "documentType": "LEGAL|IRAS|ACRA|MOM|BANK_FINANCIAL|UTILITY|UNKNOWN",
  "entities": {
    "recipientName": "company the letter is addressed TO (top address block, after 'To:') or null",
    "recipientUEN": "9-digit UEN or null",
    "recipientAddress": "full recipient address block or null",
    "senderName": "company/person who SENT the letter (letterhead/logo/signature block) or null",
    "contactPersonName": "person in Attention/Attn line or null",
    "organizationName": "company in Attention line (e.g. in parentheses) if different from recipient, else null",
    "subjectLine": "RE line, subject line, or document title or null",
    "documentDate": "YYYY-MM-DD or null",
    "referenceNumber": "ref number or null",
    "deadlineDate": "YYYY-MM-DD or null",
    "claimantName": "for legal docs or null",
    "claimantEmail": "email or null",
    "respondentName": "for legal docs or null",
    "respondentEmail": "email or null",
    "accountName": "for bank/utility docs or null"
  },
  "pageIndicator": "Page X of Y or null",
  "confidence": 0-100
}

NEW document: new letterhead, "Page 1 of X", different sender
CONTINUATION: same letterhead, "Page 2 of X", content continues

Directionality rules (strict):
- The RECIPIENT is the company in the address block at the top (after "To:").
- The SENDER is the company on the letterhead/logo or signature block.
- contactPersonName is the named individual in "Attention:".
- organizationName is the company in the Attention line when distinct from recipient.
- recipientName and senderName should usually be different companies.
- Do NOT confuse sender with recipient.`;
}

function extractTextContent(
  response: Awaited<ReturnType<Anthropic["messages"]["create"]>>,
): string {
  if (!("content" in response) || !Array.isArray(response.content)) return "";
  return response.content
    .filter((block: { type: string; text?: string }) => block.type === "text")
    .map((block: { type: string; text?: string }) => block.text ?? "")
    .join("\n")
    .trim();
}

function normalizeJson(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseVisionPageResult(raw: string): VisionPageResult | null {
  try {
    const parsed = JSON.parse(normalizeJson(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    return {
      fullText: typeof obj.fullText === "string" ? obj.fullText : "",
      isNewDocument:
        typeof obj.isNewDocument === "boolean" ? obj.isNewDocument : false,
      documentType:
        typeof obj.documentType === "string" ? obj.documentType : "UNKNOWN",
      entities:
        obj.entities && typeof obj.entities === "object"
          ? (obj.entities as VisionPageEntities)
          : {},
      pageIndicator:
        typeof obj.pageIndicator === "string" ? obj.pageIndicator : null,
      confidence:
        typeof obj.confidence === "number"
          ? Math.max(0, Math.min(100, Math.round(obj.confidence)))
          : 0,
    };
  } catch {
    return null;
  }
}

function buildSectionsFromStarts(
  startPages: number[],
  pageResults: VisionPageResult[],
  totalPages: number,
): VisionSplitSection[] {
  const sections: VisionSplitSection[] = [];
  const sortedStarts = Array.from(new Set(startPages)).sort((a, b) => a - b);
  for (let i = 0; i < sortedStarts.length; i += 1) {
    const start = sortedStarts[i];
    const nextStart = sortedStarts[i + 1];
    const end = nextStart ? nextStart - 1 : totalPages;
    if (start > end) continue;
    const pageMeta = pageResults[start - 1] ?? {};
    const sectionType = (pageMeta.documentType ?? "UNKNOWN").toLowerCase();
    const conf = Math.max(0, Math.min(100, pageMeta.confidence ?? 70));
    const reasonParts = [
      pageMeta.isNewDocument ? "isNewDocument=true" : "new_doc_inferred",
      pageMeta.pageIndicator ? `pageIndicator=${pageMeta.pageIndicator}` : null,
      pageMeta.entities?.referenceNumber
        ? `ref=${pageMeta.entities.referenceNumber}`
        : null,
    ].filter(Boolean);
    sections.push({
      startPage: start,
      endPage: end,
      sectionType,
      confidence: conf,
      reason: reasonParts.join("; "),
    });
  }
  return sections;
}

async function renderPdfPagesAsPngBase64(
  buffer: Buffer,
  totalPages: number,
): Promise<string[]> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "aima-vision-split-"),
  );
  const pdfPath = path.join(tempRoot, `${randomUUID()}.pdf`);
  const outputDir = path.join(tempRoot, "pages");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(pdfPath, buffer);

  try {
    const converter = fromPath(pdfPath, {
      density: Number(process.env.PDF_VISION_SPLIT_DPI ?? 180),
      format: "png",
      width: Number(process.env.PDF_VISION_SPLIT_WIDTH ?? 1800),
      height: Number(process.env.PDF_VISION_SPLIT_HEIGHT ?? 2400),
      savePath: outputDir,
      saveFilename: "page",
    });
    const images: string[] = [];
    for (let page = 1; page <= totalPages; page += 1) {
      const result = (await converter(page, {
        responseType: "base64",
      })) as { base64?: string };
      if (!result?.base64) {
        throw new Error(`png_render_failed_page_${page}`);
      }
      images.push(result.base64);
    }
    return images;
  } finally {
    await fs
      .rm(tempRoot, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

export async function splitPdfWithClaudeVision(input: {
  buffer: Buffer;
  totalPages: number;
  debugEnabled?: boolean;
}): Promise<{
  sections: VisionSplitSection[] | null;
  model: string;
  reason: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const model =
    process.env.ANTHROPIC_SPLIT_VISION_MODEL?.trim() ||
    "claude-sonnet-4-6";
  if (!apiKey) {
    return {
      sections: null,
      model,
      reason: "vision_split_unavailable_no_api_key",
    };
  }

  let pageBase64: string[];
  try {
    pageBase64 = await renderPdfPagesAsPngBase64(
      input.buffer,
      input.totalPages,
    );
  } catch (error) {
    return {
      sections: null,
      model,
      reason: `vision_png_render_failed:${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  const client = new Anthropic({ apiKey });
  const pageResults: VisionPageResult[] = [];

  for (let i = 0; i < pageBase64.length; i += 1) {
    const prevResult = i > 0 ? (pageResults[i - 1] ?? null) : null;
    const prompt = getVisionPrompt(prevResult);
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: pageBase64[i],
                },
              },
              {
                type: "text",
                text: `${prompt}\n\nThis is page ${i + 1} of ${pageBase64.length}.`,
              },
            ],
          },
        ],
      });
      const parsed = parseVisionPageResult(extractTextContent(response));
      pageResults.push(parsed ?? { isNewDocument: false, confidence: 0 });
      if (input.debugEnabled) {
        console.info("[pdf-vision-split] page_result", {
          page: i + 1,
          parsed,
        });
      }
    } catch (error) {
      pageResults.push({ isNewDocument: false, confidence: 0 });
      if (input.debugEnabled) {
        console.info("[pdf-vision-split] page_error", {
          page: i + 1,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }

  function extractCoreNumber(ref: string): string {
    const nums = ref.match(/\d+/g) ?? [];
    if (nums.length === 0) return ref.toLowerCase().replace(/\W/g, "");
    return nums.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  const startPages = [1];
  let currentRef = pageResults[0]?.entities?.referenceNumber ?? null;
  for (let i = 1; i < pageResults.length; i += 1) {
    const p = pageResults[i];
    const pageRef = p.entities?.referenceNumber ?? null;
    const refChanged =
      pageRef !== null &&
      currentRef !== null &&
      extractCoreNumber(pageRef) !== extractCoreNumber(currentRef);
    if (p.isNewDocument || refChanged) {
      startPages.push(i + 1);
    }
    if (pageRef !== null) {
      currentRef = pageRef;
    }
  }

  const sections = buildSectionsFromStarts(
    startPages,
    pageResults,
    input.totalPages,
  );
  if (input.debugEnabled) {
    console.info("[pdf-vision-split] start_pages", startPages);
    console.info("[pdf-vision-split] sections", sections);
  }
  if (sections.length === 0) {
    return {
      sections: null,
      model,
      reason: "vision_split_no_sections",
    };
  }
  return { sections, model, reason: "vision_split_detected_boundaries" };
}

export async function buildChunksFromSections(
  source: PDFDocument,
  sections: VisionSplitSection[],
): Promise<
  Array<{
    buffer: Buffer;
    pageStart: number;
    pageEnd: number;
    index: number;
    total: number;
    sectionType: string;
    reason: string;
    confidence: number;
  }>
> {
  const chunks: Array<{
    buffer: Buffer;
    pageStart: number;
    pageEnd: number;
    index: number;
    total: number;
    sectionType: string;
    reason: string;
    confidence: number;
  }> = [];
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const out = await PDFDocument.create();
    const pageIndexes = Array.from(
      { length: section.endPage - section.startPage + 1 },
      (_, idx) => section.startPage - 1 + idx,
    );
    const copied = await out.copyPages(source, pageIndexes);
    for (const page of copied) out.addPage(page);
    const bytes = await out.save();
    chunks.push({
      buffer: Buffer.from(bytes),
      pageStart: section.startPage,
      pageEnd: section.endPage,
      index: i + 1,
      total: sections.length,
      sectionType: section.sectionType,
      reason: section.reason,
      confidence: section.confidence,
    });
  }
  return chunks;
}
