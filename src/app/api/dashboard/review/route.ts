import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const CONFIDENCE_THRESHOLD = 70;

function countReviewItems(items: Record<string, unknown>[]): number {
  return items.filter((item) => {
    const conf = item.confidence as number | null;
    if (conf != null && conf < CONFIDENCE_THRESHOLD) return true;
    if (item.odoo_match_status === "no_match") return true;
    if (item.odoo_match_status === "ambiguous") return true;
    if (item.odoo_match_status === "matched" && !item.odoo_contact_email) return true;
    if (item.UEN === "Null" && item.odoo_match_status !== "matched") return true;
    if (item.pdfError) return true;
    return false;
  }).length;
}

export async function GET() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const { data, error } = await supabase.client
    .from("documents")
    .select("id, drid, created_at, ocr_clients_items")
    .eq("ocr_clients_status", "completed")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const docs = (data ?? []).map((doc: Record<string, unknown>) => {
    const items = Array.isArray(doc.ocr_clients_items)
      ? (doc.ocr_clients_items as Record<string, unknown>[])
      : [];
    return {
      id: doc.id as string,
      drid: doc.drid as string,
      created_at: doc.created_at as string,
      totalItems: items.length,
      reviewCount: countReviewItems(items),
    };
  });

  // Split into two groups: needs review first, then clean
  const needsReview = docs.filter((d) => d.reviewCount > 0);
  const processed = docs.filter((d) => d.reviewCount === 0 && d.totalItems > 0);

  return NextResponse.json({ needsReview, processed });
}
