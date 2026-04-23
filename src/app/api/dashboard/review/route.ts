import { NextResponse } from "next/server";
import {
  countOcrClientItemsDeferred,
  countOcrClientItemsNeedingReview,
} from "@/lib/ocr-clients-review";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

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
      reviewCount: countOcrClientItemsNeedingReview(items),
      deferredCount: countOcrClientItemsDeferred(items),
    };
  });

  // Three buckets: needs review > deferred > processed
  const needsReview = docs.filter((d) => d.reviewCount > 0);
  const deferred = docs.filter(
    (d) => d.reviewCount === 0 && d.deferredCount > 0,
  );
  const processed = docs.filter(
    (d) => d.reviewCount === 0 && d.deferredCount === 0 && d.totalItems > 0,
  );

  return NextResponse.json({ needsReview, deferred, processed });
}
