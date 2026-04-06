import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { dispatchDocumentItems, type DispatchItem } from "@/lib/dispatch-email";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;

  // Optional: dispatch only specific item indices
  const body = await req.json().catch(() => ({})) as { indices?: number[] };
  const indices = Array.isArray(body.indices) ? body.indices : undefined;

  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const { data, error } = await supabase.client
    .from("documents")
    .select("drid, ocr_clients_items, ocr_clients_status")
    .eq("id", documentId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const doc = data as { drid: string; ocr_clients_items: DispatchItem[] | null; ocr_clients_status: string | null };

  if (doc.ocr_clients_status !== "completed") {
    return NextResponse.json({ error: "Document OCR pipeline not completed yet" }, { status: 400 });
  }

  const items = Array.isArray(doc.ocr_clients_items) ? doc.ocr_clients_items : [];
  if (items.length === 0) {
    return NextResponse.json({ error: "No items to dispatch" }, { status: 400 });
  }

  try {
    const results = await dispatchDocumentItems(supabase, documentId, doc.drid, items, indices);
    const sent = results.filter((r) => r.status === "sent").length;
    const errors = results.filter((r) => r.status === "error");
    return NextResponse.json({ results, sent, errorCount: errors.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
