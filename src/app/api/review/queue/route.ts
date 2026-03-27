import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "SUPABASE_CONFIG_MISSING",
        detail:
          "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.",
      },
      { status: 500 },
    );
  }

  try {
    const { data, error } = await supabase.client
      .from("documents")
      .select(
        "id, drid, file_path, status, created_at, classification_label, classification_confidence, classification_method, classification_rationale, review_required, review_status, reviewed_by, reviewed_at, review_note, is_duplicate, duplicate_reason, duplicate_of_document_id, split_parent_ref, split_index, split_total, split_method, split_confidence, multi_invoice_suspected, split_section_type, split_reason, split_model",
      )
      .or(
        "review_required.eq.true,review_status.eq.pending,status.eq.D3_REVIEW_PENDING",
      )
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json(
        { error: "FAILED_TO_FETCH_REVIEW_QUEUE", detail: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ items: data ?? [] });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "SUPABASE_QUERY_FAILED", detail },
      { status: 500 },
    );
  }
}
