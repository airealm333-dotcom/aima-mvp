import { NextResponse } from "next/server";
import { runOcrClientsPipelineOnPdfBuffer } from "@/lib/ocr-clients-pipeline";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type StoredOcrItem = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  classification: string;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  split_path: string | null;
  pdfError: string | null;
};

function splitStoragePath(sourceFilePath: string, drid: string, index: number) {
  const i = sourceFilePath.lastIndexOf("/");
  const dir = i >= 0 ? sourceFilePath.slice(0, i) : "";
  const name = `${drid}-ocr-client-${index}.pdf`;
  return dir ? `${dir}/${name}` : name;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_CONFIG_MISSING" },
      { status: 500 },
    );
  }

  const { id: documentId } = await params;

  const docRes = await supabase.client
    .from("documents")
    .select("id, drid, file_path")
    .eq("id", documentId)
    .maybeSingle();

  if (docRes.error || !docRes.data) {
    return NextResponse.json(
      { error: "DOCUMENT_NOT_FOUND", detail: docRes.error?.message },
      { status: 404 },
    );
  }

  const row = docRes.data as {
    id: string;
    drid: string;
    file_path: string;
  };

  if (!row.file_path?.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "NOT_A_PDF_DOCUMENT" }, { status: 400 });
  }

  await supabase.client
    .from("documents")
    .update({
      ocr_clients_status: "processing",
      ocr_clients_error: null,
    } as never)
    .eq("id", documentId);

  try {
    const dl = await supabase.client.storage
      .from(supabase.storageBucket)
      .download(row.file_path);

    if (dl.error || !dl.data) {
      throw new Error(dl.error?.message ?? "Storage download failed");
    }

    const ab = await dl.data.arrayBuffer();
    const buffer = Buffer.from(ab);

    const { ocr, items } = await runOcrClientsPipelineOnPdfBuffer(buffer);

    const storedItems: StoredOcrItem[] = [];

    for (const it of items) {
      const splitPath = splitStoragePath(row.file_path, row.drid, it.index);
      let uploadedPath: string | null = null;

      if (it.pdfBuffer && it.pdfBuffer.length > 0) {
        const up = await supabase.client.storage
          .from(supabase.storageBucket)
          .upload(splitPath, it.pdfBuffer, {
            contentType: "application/pdf",
            upsert: true,
          });
        if (up.error) {
          storedItems.push({
            index: it.index,
            name: it.name,
            UEN: it.UEN,
            document_type: it.document_type,
            classification: it.classification,
            page_range: it.page_range,
            pageStart: it.pageStart,
            pageEnd: it.pageEnd,
            split_path: null,
            pdfError: up.error.message,
          });
          continue;
        }
        uploadedPath = splitPath;
      }

      storedItems.push({
        index: it.index,
        name: it.name,
        UEN: it.UEN,
        document_type: it.document_type,
        classification: it.classification,
        page_range: it.page_range,
        pageStart: it.pageStart,
        pageEnd: it.pageEnd,
        split_path: uploadedPath,
        pdfError: it.pdfError,
      });
    }

    const now = new Date().toISOString();
    const upd = await supabase.client
      .from("documents")
      .update({
        ocr_clients_status: "completed",
        ocr_clients_completed_at: now,
        ocr_clients_ocr_summary: {
          pageCount: ocr.pageCount,
          textLength: ocr.textLength,
          provider: ocr.provider,
          pageAlignment: ocr.pageAlignment ?? null,
        },
        ocr_clients_items: storedItems,
        ocr_clients_error: null,
      } as never)
      .eq("id", documentId)
      .select("id")
      .single();

    if (upd.error) {
      throw new Error(upd.error.message);
    }

    await supabase.client.from("audit_logs" as never).insert({
      entity_type: "document",
      entity_id: documentId,
      action: "OCR_CLIENTS_PIPELINE_COMPLETED",
      actor: "AIMA",
      metadata: {
        drid: row.drid,
        itemCount: storedItems.length,
      },
    } as never);

    return NextResponse.json({
      ok: true,
      documentId,
      ocr: {
        pageCount: ocr.pageCount,
        textLength: ocr.textLength,
        provider: ocr.provider,
        pageAlignment: ocr.pageAlignment ?? null,
      },
      items: storedItems,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.client
      .from("documents")
      .update({
        ocr_clients_status: "failed",
        ocr_clients_error: msg,
      } as never)
      .eq("id", documentId);

    return NextResponse.json(
      { error: "OCR_CLIENTS_PIPELINE_FAILED", detail: msg },
      { status: 500 },
    );
  }
}
