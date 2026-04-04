import { extractPdfText, type OcrResult } from "@/lib/ocr";
import {
  type ClassificationLabel,
  extractOcrClientRowsFromDocumentText,
  parsePageRangeString,
  slicePdfBufferByOneBasedPageRange,
} from "@/lib/ocr-client-extract";

export type OcrClientsPipelineItemInternal = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  classification: ClassificationLabel;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  pdfBuffer: Buffer | null;
  pdfError: string | null;
};

export type OcrClientsPipelineResult = {
  ocr: Pick<
    OcrResult,
    "pageCount" | "textLength" | "provider" | "pageAlignment"
  >;
  items: OcrClientsPipelineItemInternal[];
};

/**
 * Full OCR (labeled pages) + Claude client rows + PDF slice per page_range.
 * Used by POST /api/ocr-clients and POST /api/dashboard/documents/[id]/run-ocr-clients.
 */
export async function runOcrClientsPipelineOnPdfBuffer(
  pdfBuffer: Buffer,
): Promise<OcrClientsPipelineResult> {
  const ocr = await extractPdfText(pdfBuffer, "application/pdf", {
    labelPdfPages: true,
  });

  const rows = await extractOcrClientRowsFromDocumentText(ocr.text);

  const items = await Promise.all(
    rows.map(async (row, index) => {
      const pr = parsePageRangeString(row.page_range, ocr.pageCount);
      if (!pr) {
        return {
          index,
          name: row.name,
          UEN: row.UEN,
          document_type: row.document_type,
          classification: row.classification,
          page_range: row.page_range,
          pageStart: null as number | null,
          pageEnd: null as number | null,
          pdfBuffer: null as Buffer | null,
          pdfError: `Could not parse page_range "${row.page_range}" for a ${ocr.pageCount}-page PDF.`,
        };
      }
      try {
        const pdfBuf = await slicePdfBufferByOneBasedPageRange(
          pdfBuffer,
          pr.start,
          pr.end,
        );
        return {
          index,
          name: row.name,
          UEN: row.UEN,
          document_type: row.document_type,
          classification: row.classification,
          page_range: row.page_range,
          pageStart: pr.start,
          pageEnd: pr.end,
          pdfBuffer: pdfBuf,
          pdfError: null as string | null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          index,
          name: row.name,
          UEN: row.UEN,
          document_type: row.document_type,
          classification: row.classification,
          page_range: row.page_range,
          pageStart: pr.start,
          pageEnd: pr.end,
          pdfBuffer: null as Buffer | null,
          pdfError: msg,
        };
      }
    }),
  );

  return {
    ocr: {
      pageCount: ocr.pageCount,
      textLength: ocr.textLength,
      provider: ocr.provider,
      pageAlignment: ocr.pageAlignment,
    },
    items,
  };
}
