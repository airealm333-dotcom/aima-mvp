import { NextResponse } from "next/server";
import { runOcrClientsPipelineOnPdfBuffer } from "@/lib/ocr-clients-pipeline";

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
    const { ocr, items } = await runOcrClientsPipelineOnPdfBuffer(buffer);

    const payloadItems = items.map((it) => ({
      index: it.index,
      name: it.name,
      UEN: it.UEN,
      document_type: it.document_type,
      classification: it.classification,
      page_range: it.page_range,
      pageStart: it.pageStart,
      pageEnd: it.pageEnd,
      pdfBase64: it.pdfBuffer ? it.pdfBuffer.toString("base64") : null,
      pdfError: it.pdfError,
    }));

    return NextResponse.json({
      fileName: file.name,
      ocr: {
        pageCount: ocr.pageCount,
        textLength: ocr.textLength,
        provider: ocr.provider,
        pageAlignment: ocr.pageAlignment ?? null,
      },
      items: payloadItems,
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
