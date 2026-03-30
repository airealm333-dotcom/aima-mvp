import { Storage } from "@google-cloud/storage";
import vision from "@google-cloud/vision";
import { PDFDocument } from "pdf-lib";
import { PDFParse } from "pdf-parse";

type ImageAnnotatorClient = InstanceType<typeof vision.ImageAnnotatorClient>;
type StorageClient = InstanceType<typeof Storage>;
type VisionCredentials = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

/** When Vision segment count ≠ pdf-lib page count (after alignment). */
export type OcrPageAlignment = {
  pdfPages: number;
  ocrSegmentsBeforeAlign: number;
  paddedBlankPages?: number;
  droppedOcrSegments?: number;
};

export type OcrResult = {
  text: string;
  /** Always the PDF’s real page count (pdf-lib) when the buffer is a readable PDF; otherwise OCR segment count. */
  pageCount: number;
  textLength: number;
  provider: "google-vision" | "pdf-parse";
  pageAlignment?: OcrPageAlignment;
  /** One string per PDF page (same order as the file). Only set when `returnPages: true`. */
  pages?: string[];
};

/** Optional behavior; used by `scripts/ocr-pdf.ts` only — intake keeps default merged text. */
export type ExtractPdfTextOptions = {
  /** Prefix each PDF page with `=== PDF page i / n ===` before its OCR text. */
  labelPdfPages?: boolean;
  /** Return `pages` aligned 1:1 with PDF page indices (0 = page 1). */
  returnPages?: boolean;
};

async function getPdfPageCountFromBuffer(buffer: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

/** Pad or trim OCR segments so length === PDF page count (pdf-lib is source of truth for `n`). */
function alignOcrSegmentsToPdfPages(
  ocrPages: string[],
  pdfPageCount: number,
): string[] {
  if (pdfPageCount <= 0) return ocrPages;
  if (ocrPages.length === pdfPageCount) return ocrPages;
  if (ocrPages.length < pdfPageCount) {
    return [...ocrPages, ...Array(pdfPageCount - ocrPages.length).fill("")];
  }
  return ocrPages.slice(0, pdfPageCount);
}

function buildPageAlignment(
  ocrBefore: number,
  pdfPageCount: number,
): OcrPageAlignment | undefined {
  if (ocrBefore === pdfPageCount) return undefined;
  return {
    pdfPages: pdfPageCount,
    ocrSegmentsBeforeAlign: ocrBefore,
    paddedBlankPages:
      ocrBefore < pdfPageCount ? pdfPageCount - ocrBefore : undefined,
    droppedOcrSegments:
      ocrBefore > pdfPageCount ? ocrBefore - pdfPageCount : undefined,
  };
}

function joinPdfPageTexts(
  pageTexts: string[],
  labelPages: boolean,
  pdfTotalPages: number,
): string {
  if (pageTexts.length === 0) return "";
  const total =
    pdfTotalPages > 0 ? pdfTotalPages : Math.max(1, pageTexts.length);
  if (!labelPages) return pageTexts.join("\n\n");
  return pageTexts
    .map((t, i) => {
      const body = t.trim().length > 0 ? t : "(no OCR text for this PDF page)";
      return `=== PDF page ${i + 1} / ${total} ===\n${body}`;
    })
    .join("\n\n");
}

function splitPdfParseTextIntoPages(
  rawText: string,
  pageCount: number,
): string[] {
  const byFormFeed = rawText
    .split("\f")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (pageCount > 0 && byFormFeed.length === pageCount) return byFormFeed;
  if (byFormFeed.length > 1) return byFormFeed;
  const trimmed = rawText.trim();
  return trimmed ? [trimmed] : [];
}

function isVisionStrictMode() {
  return process.env.GOOGLE_VISION_STRICT === "true";
}

function normalizeContentType(contentType: string) {
  return contentType.split(";")[0]?.trim().toLowerCase() || "";
}

function getVisionCredentials(): VisionCredentials | null {
  const credentialsJson = process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  if (!credentialsJson) {
    if (isVisionStrictMode()) {
      throw new Error(
        "Google Vision strict mode is enabled but GOOGLE_VISION_CREDENTIALS_JSON is missing.",
      );
    }
    return null;
  }

  try {
    return JSON.parse(credentialsJson) as VisionCredentials;
  } catch {
    if (isVisionStrictMode()) {
      throw new Error(
        "Google Vision strict mode is enabled but GOOGLE_VISION_CREDENTIALS_JSON is invalid JSON.",
      );
    }
    return null;
  }
}

function getVisionClient() {
  const credentials = getVisionCredentials();
  if (!credentials) return null;
  return new vision.ImageAnnotatorClient({ credentials });
}

function getStorageClient(): StorageClient | null {
  const credentials = getVisionCredentials();
  if (!credentials) return null;
  return new Storage({ credentials, projectId: credentials.project_id });
}

function getVisionGcsConfig() {
  const inputBucket = process.env.GOOGLE_VISION_GCS_INPUT_BUCKET?.trim();
  const outputBucket = process.env.GOOGLE_VISION_GCS_OUTPUT_BUCKET?.trim();
  const prefixBase =
    process.env.GOOGLE_VISION_GCS_PREFIX?.trim() || "vision-ocr";

  if (!inputBucket || !outputBucket) {
    if (isVisionStrictMode()) {
      throw new Error(
        "Google Vision strict mode is enabled but GOOGLE_VISION_GCS_INPUT_BUCKET or GOOGLE_VISION_GCS_OUTPUT_BUCKET is missing.",
      );
    }
    return null;
  }

  return { inputBucket, outputBucket, prefixBase };
}

function randomKeyPart() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Opt-in only: rebuild text from block/paragraph geometry.
 * Default is flat `fullTextAnnotation.text` per page — geometric sorting often scrambles
 * multi-column leaflets, tables, and forms worse than Vision's own concatenation.
 * Set `GOOGLE_VISION_LAYOUT_TEXT=true` only if you are experimenting on simple layouts.
 */
function isVisionLayoutTextEnabled(): boolean {
  return process.env.GOOGLE_VISION_LAYOUT_TEXT?.trim() === "true";
}

type VisionVertex = { x?: number; y?: number };
type VisionPoly = {
  vertices?: VisionVertex[];
  normalizedVertices?: VisionVertex[];
};

type VisionSymbol = {
  text?: string;
  property?: {
    detectedBreak?: { type?: string | number };
  };
};

type VisionWord = {
  symbols?: VisionSymbol[];
  boundingPoly?: VisionPoly;
  boundingBox?: VisionPoly;
  property?: { detectedBreak?: { type?: string | number } };
};

type VisionParagraph = {
  words?: VisionWord[];
  boundingPoly?: VisionPoly;
  boundingBox?: VisionPoly;
};

type VisionBlock = {
  paragraphs?: VisionParagraph[];
  boundingPoly?: VisionPoly;
  boundingBox?: VisionPoly;
};

type VisionPage = { blocks?: VisionBlock[] };

type VisionFullTextAnnotation = {
  text?: string;
  pages?: VisionPage[];
};

function visionPoly(
  box: { boundingPoly?: VisionPoly; boundingBox?: VisionPoly } | undefined,
): VisionPoly | undefined {
  return box?.boundingPoly ?? box?.boundingBox;
}

function polyMinY(poly: VisionPoly | undefined): number {
  const verts = poly?.vertices?.length
    ? poly.vertices
    : poly?.normalizedVertices;
  if (!verts?.length) return 0;
  return Math.min(...verts.map((v) => v.y ?? 0));
}

function polyMinX(poly: VisionPoly | undefined): number {
  const verts = poly?.vertices?.length
    ? poly.vertices
    : poly?.normalizedVertices;
  if (!verts?.length) return 0;
  return Math.min(...verts.map((v) => v.x ?? 0));
}

function sortByReadingOrder<
  T extends { boundingPoly?: VisionPoly; boundingBox?: VisionPoly },
>(items: T[], lineTolerance: number): T[] {
  return [...items].sort((a, b) => {
    const pa = visionPoly(a);
    const pb = visionPoly(b);
    const ya = polyMinY(pa);
    const yb = polyMinY(pb);
    if (Math.abs(ya - yb) > lineTolerance) return ya - yb;
    return polyMinX(pa) - polyMinX(pb);
  });
}

function breakAfterWord(lastSymbol: VisionSymbol | undefined): string {
  const bt =
    lastSymbol?.property?.detectedBreak?.type ??
    (undefined as string | number | undefined);
  if (bt === "LINE_BREAK" || bt === 5) return "\n";
  if (bt === "EOL_SURE_SPACE" || bt === 3) return "\n";
  if (bt === "HYPHEN" || bt === 4) return "";
  return " ";
}

function wordChars(word: VisionWord): string {
  return (word.symbols ?? []).map((s) => s.text ?? "").join("");
}

function joinWordsInParagraph(words: VisionWord[]): string {
  const sorted = sortByReadingOrder(words, 6);
  if (sorted.length === 0) return "";
  let out = "";
  for (let i = 0; i < sorted.length; i += 1) {
    out += wordChars(sorted[i]);
    const syms = sorted[i].symbols;
    const lastSym = syms?.[syms.length - 1];
    let sep = breakAfterWord(lastSym);
    const wordBreak = sorted[i].property?.detectedBreak?.type;
    if (
      sep === " " &&
      (wordBreak === "LINE_BREAK" ||
        wordBreak === 5 ||
        wordBreak === "EOL_SURE_SPACE" ||
        wordBreak === 3)
    ) {
      sep = "\n";
    }
    if (i < sorted.length - 1) {
      out += sep;
    } else if (sep === "\n") {
      out += "\n";
    }
  }
  return out;
}

function layoutTextFromPage(page: VisionPage): string {
  const blocks = sortByReadingOrder(page.blocks ?? [], 32);
  const blockParts: string[] = [];
  for (const block of blocks) {
    const paras = sortByReadingOrder(block.paragraphs ?? [], 18);
    const paraTexts = paras
      .map((p) => joinWordsInParagraph(p.words ?? []).trim())
      .filter((t) => t.length > 0);
    if (paraTexts.length > 0) {
      blockParts.push(paraTexts.join("\n"));
    }
  }
  return blockParts.join("\n\n").trim();
}

/**
 * Prefer geometry-based layout when `pages[]` is present; fall back to flat `text` if
 * reconstruction looks truncated vs. Vision's own concatenation.
 */
function annotationToPageText(
  ann: VisionFullTextAnnotation | undefined,
): string {
  const flat = ann?.text?.trim() ?? "";
  if (!ann || !isVisionLayoutTextEnabled()) return flat;
  const pages = ann.pages;
  if (!pages?.length) return flat;
  const layoutParts = pages.map((p) => layoutTextFromPage(p));
  const layout = layoutParts.join("\n\n").trim();
  if (!layout) return flat;
  if (flat.length > 400 && layout.length < flat.length * 0.3) {
    return flat;
  }
  return layout;
}

/**
 * One entry per Vision `responses[]` element, in PDF page order within that shard.
 * Empty pages must stay as "" so page indices stay aligned with the physical PDF;
 * skipping them previously shifted every following "Page N" label in CLI output.
 */
async function parseVisionAsyncOutputJson(buffer: Buffer): Promise<string[]> {
  const parsed = JSON.parse(buffer.toString("utf-8")) as {
    responses?: Array<{
      fullTextAnnotation?: VisionFullTextAnnotation;
      error?: { message?: string };
    }>;
  };
  const responses = parsed.responses ?? [];
  const pages: string[] = [];
  for (const response of responses) {
    if (response.error?.message) {
      pages.push("");
      continue;
    }
    const ann = response.fullTextAnnotation;
    const text = annotationToPageText(ann);
    pages.push(text);
  }
  return pages;
}

/** Vision async PDF shards are named `output-<start>-to-<end>.json`; lexical sort puts e.g. `11` before `6`. */
const VISION_OUTPUT_JSON_RE = /output-(\d+)-to-(\d+)\.json$/i;

function parseVisionOutputJsonPageRange(
  gcsObjectName: string,
): { start: number; end: number } | null {
  const m = gcsObjectName.match(VISION_OUTPUT_JSON_RE);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function compareVisionOutputJsonFiles(
  a: { name: string },
  b: { name: string },
): number {
  const ka = parseVisionOutputJsonPageRange(a.name);
  const kb = parseVisionOutputJsonPageRange(b.name);
  if (ka && kb) {
    if (ka.start !== kb.start) return ka.start - kb.start;
    return ka.end - kb.end;
  }
  if (ka && !kb) return -1;
  if (!ka && kb) return 1;
  return a.name.localeCompare(b.name);
}

async function extractPdfWithGoogleVision(
  client: ImageAnnotatorClient,
  buffer: Buffer,
): Promise<{ pageTexts: string[] } | null> {
  const storage = getStorageClient();
  const gcsConfig = getVisionGcsConfig();
  if (!storage || !gcsConfig) return null;

  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H1",
      location: "src/lib/ocr.ts:extractPdfWithGoogleVision:entry",
      message: "Starting async Vision OCR upload flow",
      data: {
        inputBucket: gcsConfig.inputBucket,
        outputBucket: gcsConfig.outputBucket,
        prefixBase: gcsConfig.prefixBase,
        bufferBytes: buffer.length,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  const inputObjectPath = `${gcsConfig.prefixBase}/input/${Date.now()}-${randomKeyPart()}.pdf`;
  const outputPrefix = `${gcsConfig.prefixBase}/output/${Date.now()}-${randomKeyPart()}`;
  const outputUri = `gs://${gcsConfig.outputBucket}/${outputPrefix}/`;

  const inputFile = storage.bucket(gcsConfig.inputBucket).file(inputObjectPath);
  await inputFile.save(buffer, {
    resumable: false,
    contentType: "application/pdf",
  });

  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H1",
      location: "src/lib/ocr.ts:extractPdfWithGoogleVision:afterInputSave",
      message: "Uploaded PDF to input bucket",
      data: {
        inputObjectPath,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  try {
    const [operation] = await client.asyncBatchAnnotateFiles({
      requests: [
        {
          inputConfig: {
            gcsSource: {
              uri: `gs://${gcsConfig.inputBucket}/${inputObjectPath}`,
            },
            mimeType: "application/pdf",
          },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          outputConfig: {
            gcsDestination: { uri: outputUri },
            batchSize: 5,
          },
        },
      ],
    });

    await operation.promise();

    const [outputFiles] = await storage
      .bucket(gcsConfig.outputBucket)
      .getFiles({ prefix: `${outputPrefix}/` });
    const sortedFiles = outputFiles.sort(compareVisionOutputJsonFiles);

    // #region agent log
    fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "392735",
      },
      body: JSON.stringify({
        sessionId: "392735",
        runId: "pre-fix",
        hypothesisId: "H2",
        location: "src/lib/ocr.ts:extractPdfWithGoogleVision:afterOutputList",
        message: "Listed Vision OCR output objects",
        data: {
          outputPrefix,
          outputFileCount: sortedFiles.length,
          outputJsonCount: sortedFiles.filter((f) => f.name.endsWith(".json"))
            .length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    const pageTexts: string[] = [];
    for (const file of sortedFiles) {
      if (!file.name.endsWith(".json")) continue;
      const [content] = await file.download();
      const pages = await parseVisionAsyncOutputJson(content);
      pageTexts.push(...pages);
    }

    if (pageTexts.length === 0) return null;
    return { pageTexts };
  } finally {
    await inputFile.delete({ ignoreNotFound: true }).catch(() => undefined);
  }
}

async function extractImageWithGoogleVision(
  client: ImageAnnotatorClient,
  buffer: Buffer,
): Promise<string | null> {
  const [result] = await client.documentTextDetection({
    image: { content: buffer },
  });

  const text = result.fullTextAnnotation?.text?.trim() ?? "";
  if (!text) return null;
  return text;
}

async function extractWithGoogleVision(
  buffer: Buffer,
  contentType: string,
): Promise<{ pageTexts: string[] } | null> {
  const client = getVisionClient();
  if (!client) return null;

  try {
    if (contentType === "application/pdf") {
      return await extractPdfWithGoogleVision(client, buffer);
    }
    const imageText = await extractImageWithGoogleVision(client, buffer);
    if (!imageText) return null;
    return { pageTexts: [imageText] };
  } catch (error) {
    // #region agent log
    fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "392735",
      },
      body: JSON.stringify({
        sessionId: "392735",
        runId: "pre-fix",
        hypothesisId: "H3",
        location: "src/lib/ocr.ts:extractWithGoogleVision:catch",
        message: "Google Vision OCR threw exception",
        data: {
          contentType,
          error:
            error instanceof Error
              ? error.message
              : "Unknown Google Vision error",
          strictMode: isVisionStrictMode(),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    if (isVisionStrictMode()) {
      const detail =
        error instanceof Error ? error.message : "Unknown Google Vision error";
      throw new Error(
        `Google Vision OCR failed while strict mode is enabled. contentType=${contentType} detail=${detail}`,
      );
    }
    return null;
  }
}

export async function extractPdfText(
  fileBuffer: Buffer,
  contentType = "application/pdf",
  options?: ExtractPdfTextOptions,
): Promise<OcrResult> {
  const normalizedContentType = normalizeContentType(contentType);
  const labelPdfPages = options?.labelPdfPages === true;
  const returnPages = options?.returnPages === true;

  const pdfLibPageCount =
    normalizedContentType === "application/pdf"
      ? await getPdfPageCountFromBuffer(fileBuffer)
      : 0;

  const visionBundle = await extractWithGoogleVision(
    fileBuffer,
    normalizedContentType,
  );
  if (visionBundle) {
    const ocrBefore = visionBundle.pageTexts.length;
    const aligned =
      pdfLibPageCount > 0
        ? alignOcrSegmentsToPdfPages(visionBundle.pageTexts, pdfLibPageCount)
        : visionBundle.pageTexts;
    const pageCount =
      pdfLibPageCount > 0 ? pdfLibPageCount : Math.max(1, aligned.length);
    const text = joinPdfPageTexts(aligned, labelPdfPages, pageCount);
    return {
      text,
      pageCount,
      textLength: text.length,
      provider: "google-vision",
      pageAlignment:
        pdfLibPageCount > 0
          ? buildPageAlignment(ocrBefore, pdfLibPageCount)
          : undefined,
      pages: returnPages ? [...aligned] : undefined,
    };
  }

  if (normalizedContentType !== "application/pdf") {
    const visionConfigured = Boolean(
      process.env.GOOGLE_VISION_CREDENTIALS_JSON,
    );
    throw new Error(
      [
        "Google Vision OCR returned no text for this image format.",
        `rawContentType=${contentType}`,
        `normalizedContentType=${normalizedContentType}`,
        `visionStrict=${process.env.GOOGLE_VISION_STRICT === "true"}`,
        `visionConfigured=${visionConfigured}`,
      ].join(" "),
    );
  }

  // Last-resort fallback for PDFs only when Vision is not strict.
  const parser = new PDFParse({ data: fileBuffer });
  const parsed = await parser.getText();
  const raw = parsed.text ?? "";
  const parsedReportedPages = parsed.total ?? 0;
  const targetPages =
    pdfLibPageCount > 0
      ? pdfLibPageCount
      : Math.max(1, parsedReportedPages || 1);
  const splitParts = splitPdfParseTextIntoPages(
    raw,
    parsedReportedPages || targetPages,
  );
  const aligned = alignOcrSegmentsToPdfPages(splitParts, targetPages);
  const text = joinPdfPageTexts(aligned, labelPdfPages, targetPages).trim();
  await parser.destroy();

  return {
    text,
    pageCount: targetPages,
    textLength: text.length,
    provider: "pdf-parse",
    pageAlignment:
      pdfLibPageCount > 0
        ? buildPageAlignment(splitParts.length, targetPages)
        : undefined,
    pages: returnPages ? [...aligned] : undefined,
  };
}
