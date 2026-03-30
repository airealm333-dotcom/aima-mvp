import { NextResponse } from "next/server";
import { extractPdfText } from "@/lib/ocr";
import {
  extractOcrClientRowsFromDocumentText,
  parsePageRangeString,
  slicePdfBufferByOneBasedPageRange,
} from "@/lib/ocr-client-extract";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing file in form field 'file'." },
        { status: 400 },
      );
    }

    const ct = (file.type || "").toLowerCase();
    const lowerName = file.name.toLowerCase();
    if (!ct.includes("pdf") && !lowerName.endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const ocr = await extractPdfText(buffer, "application/pdf", {
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
            page_range: row.page_range,
            pageStart: null as number | null,
            pageEnd: null as number | null,
            pdfBase64: null as string | null,
            pdfError: `Could not parse page_range "${row.page_range}" for a ${ocr.pageCount}-page PDF.`,
          };
        }
        try {
          const pdfBuf = await slicePdfBufferByOneBasedPageRange(
            buffer,
            pr.start,
            pr.end,
          );
          return {
            index,
            name: row.name,
            UEN: row.UEN,
            document_type: row.document_type,
            page_range: row.page_range,
            pageStart: pr.start,
            pageEnd: pr.end,
            pdfBase64: pdfBuf.toString("base64"),
            pdfError: null as string | null,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            index,
            name: row.name,
            UEN: row.UEN,
            document_type: row.document_type,
            page_range: row.page_range,
            pageStart: pr.start,
            pageEnd: pr.end,
            pdfBase64: null as string | null,
            pdfError: msg,
          };
        }
      }),
    );

    return NextResponse.json({
      fileName: file.name,
      ocr: {
        pageCount: ocr.pageCount,
        textLength: ocr.textLength,
        provider: ocr.provider,
        pageAlignment: ocr.pageAlignment ?? null,
      },
      items,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json(
      { error: "OCR_CLIENT_PIPELINE_FAILED", detail },
      { status: 500 },
    );
  }
}
