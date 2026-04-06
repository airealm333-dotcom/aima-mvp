import { NextResponse } from "next/server";
import { runOcrClientsForDocument } from "@/lib/run-ocr-clients-for-doc";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 300;

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

  try {
    const result = await runOcrClientsForDocument(supabase, documentId);
    return NextResponse.json({ ok: true, documentId, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Document not found") {
      return NextResponse.json(
        { error: "DOCUMENT_NOT_FOUND", detail: msg },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "OCR_CLIENTS_PIPELINE_FAILED", detail: msg },
      { status: 500 },
    );
  }
}
