import { createRequire } from "node:module";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  type Result,
  RGBLuminanceSource,
} from "@zxing/library";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

type BarcodeEvidence = {
  page: number;
  value: string;
  format: string;
  region: "top" | "full";
};

export type BarcodeScanResult = {
  startPages: number[];
  evidence: BarcodeEvidence[];
  reason: string;
};

type BarcodeScanConfig = {
  enabled: boolean;
  dpi: number;
  topRatio: number;
  minValueLength: number;
  formats: BarcodeFormat[];
};

function parsePositiveInt(
  raw: string | undefined,
  fallbackValue: number,
): number {
  const n = Number(raw ?? "");
  return Number.isInteger(n) && n > 0 ? n : fallbackValue;
}

function parseRatio(raw: string | undefined, fallbackValue: number): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n)) return fallbackValue;
  return Math.max(0.1, Math.min(1, n));
}

function parseEnabled(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() !== "false";
}

function parseFormats(raw: string | undefined): BarcodeFormat[] {
  const allowed = (raw ?? "CODE128,CODE39,QR_CODE,DATA_MATRIX")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  const byName: Record<string, BarcodeFormat> = {
    AZTEC: BarcodeFormat.AZTEC,
    CODABAR: BarcodeFormat.CODABAR,
    CODE39: BarcodeFormat.CODE_39,
    CODE93: BarcodeFormat.CODE_93,
    CODE128: BarcodeFormat.CODE_128,
    DATAMATRIX: BarcodeFormat.DATA_MATRIX,
    DATA_MATRIX: BarcodeFormat.DATA_MATRIX,
    EAN8: BarcodeFormat.EAN_8,
    EAN13: BarcodeFormat.EAN_13,
    ITF: BarcodeFormat.ITF,
    MAXICODE: BarcodeFormat.MAXICODE,
    PDF417: BarcodeFormat.PDF_417,
    QR: BarcodeFormat.QR_CODE,
    QR_CODE: BarcodeFormat.QR_CODE,
    RSS14: BarcodeFormat.RSS_14,
    RSSEXPANDED: BarcodeFormat.RSS_EXPANDED,
    UPCA: BarcodeFormat.UPC_A,
    UPCE: BarcodeFormat.UPC_E,
    UPCEAN_EXTENSION: BarcodeFormat.UPC_EAN_EXTENSION,
  };

  const formats = allowed
    .map((name) => byName[name])
    .filter((fmt): fmt is BarcodeFormat => typeof fmt === "number");
  return formats.length > 0 ? formats : [BarcodeFormat.CODE_128];
}

function getConfig(): BarcodeScanConfig {
  return {
    enabled: parseEnabled(process.env.PDF_BARCODE_SCAN_ENABLED),
    dpi: parsePositiveInt(process.env.PDF_BARCODE_DPI, 180),
    topRatio: parseRatio(process.env.PDF_BARCODE_TOP_RATIO, 0.38),
    minValueLength: parsePositiveInt(process.env.PDF_BARCODE_MIN_LENGTH, 6),
    formats: parseFormats(process.env.PDF_BARCODE_ACCEPT_FORMATS),
  };
}

function buildReader(formats: BarcodeFormat[]) {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

function decodeFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  reader: MultiFormatReader,
): Result | null {
  try {
    const luminance = new RGBLuminanceSource(rgba, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(luminance));
    const decoded = reader.decode(bitmap);
    reader.reset();
    return decoded ?? null;
  } catch {
    reader.reset();
    return null;
  }
}

function isLikelyBoundaryBarcode(value: string, minLength: number): boolean {
  const v = value.trim();
  if (v.length < minLength) return false;
  return /[A-Z0-9]/i.test(v);
}

type CanvasModule = {
  createCanvas: (
    width: number,
    height: number,
  ) => {
    getContext: (contextId: "2d") => CanvasRenderingContext2D;
  };
};

async function loadCanvasModule(): Promise<CanvasModule | null> {
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const moduleName = ["@napi-rs", "canvas"].join("/");
    const mod = runtimeRequire(moduleName) as CanvasModule;
    return mod;
  } catch {
    return null;
  }
}

export async function scanPdfBarcodeStartPages(
  pdfBuffer: Buffer,
): Promise<BarcodeScanResult> {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { startPages: [], evidence: [], reason: "barcode_scan_disabled" };
  }
  const canvasModule = await loadCanvasModule();
  if (!canvasModule) {
    return {
      startPages: [],
      evidence: [],
      reason: "barcode_scan_unavailable_canvas_module",
    };
  }

  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const reader = buildReader(cfg.formats);
  const evidence: BarcodeEvidence[] = [];
  const boundaryPages = new Set<number>();

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: cfg.dpi / 72 });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = canvasModule.createCanvas(width, height);
      const context = canvas.getContext("2d");

      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        // pdfjs expects a compatible CanvasRenderingContext2D-like target.
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const topHeight = Math.max(1, Math.floor(height * cfg.topRatio));
      const topImage = context.getImageData(0, 0, width, topHeight);
      const fullImage = context.getImageData(0, 0, width, height);

      const topDecoded = decodeFromRgba(
        topImage.data,
        width,
        topHeight,
        reader,
      );
      const fullDecoded = topDecoded
        ? null
        : decodeFromRgba(fullImage.data, width, height, reader);
      const decoded = topDecoded ?? fullDecoded;
      const region: "top" | "full" = topDecoded ? "top" : "full";

      if (!decoded) continue;
      const value = decoded.getText()?.trim() ?? "";
      if (!isLikelyBoundaryBarcode(value, cfg.minValueLength)) continue;

      boundaryPages.add(pageNumber);
      evidence.push({
        page: pageNumber,
        value,
        format: BarcodeFormat[decoded.getBarcodeFormat()] ?? "UNKNOWN",
        region,
      });
    }
  } finally {
    await pdf.destroy();
    loadingTask.destroy();
  }

  const startPages = Array.from(boundaryPages).sort((a, b) => a - b);
  return {
    startPages,
    evidence,
    reason:
      startPages.length > 0 ? "barcode_image_detected" : "barcode_not_found",
  };
}
