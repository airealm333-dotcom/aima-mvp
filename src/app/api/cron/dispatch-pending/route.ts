import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { dispatchDocumentItems } from "@/lib/dispatch-email";
import { ocrClientItemNeedsReview } from "@/lib/ocr-clients-review";
import { getDispatchMode } from "@/lib/app-settings";
import type { DispatchItem } from "@/lib/dispatch-email";

export const runtime = "nodejs";
export const maxDuration = 60;

const DISPATCH_DELAY_MS = 2 * 60 * 1000; // 2 minutes after completion

export async function POST(req: Request) {
  // Simple shared secret auth
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  if (!process.env.DISPATCH_TO_EMAIL?.trim()) {
    return NextResponse.json({ error: "DISPATCH_TO_EMAIL not set" }, { status: 500 });
  }

  // Find completed documents where pipeline finished >2 min ago
  const cutoff = new Date(Date.now() - DISPATCH_DELAY_MS).toISOString();

  type DocRow = { id: string; drid: string; ocr_clients_items: unknown };

  const { data: docs, error } = await supabase.client
    .from("documents")
    .select("id, drid, ocr_clients_items, ocr_clients_completed_at")
    .eq("ocr_clients_status" as never, "completed")
    .lt("ocr_clients_completed_at" as never, cutoff)
    .not("ocr_clients_items" as never, "is", null) as unknown as {
      data: DocRow[] | null;
      error: { message: string } | null;
    };

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const mode = await getDispatchMode();
  const summary: { drid: string; sent: number; skipped: number; errors: number }[] = [];

  for (const doc of (docs ?? [])) {
    const items: DispatchItem[] = Array.isArray(doc.ocr_clients_items)
      ? (doc.ocr_clients_items as DispatchItem[])
      : [];

    // Skip if nothing to dispatch
    const undispatched = items.filter((it) => !it.dispatched_at);
    if (undispatched.length === 0) continue;

    const cleanItems = undispatched.filter((it) => !ocrClientItemNeedsReview(it));
    if (cleanItems.length === 0) continue;

    // document_complete: skip if any item still needs review
    if (mode === "document_complete") {
      const anyNeedsReview = items.some(ocrClientItemNeedsReview);
      if (anyNeedsReview) continue;
    }

    const indices = cleanItems.map((it) => it.index);
    try {
      const results = await dispatchDocumentItems(supabase, doc.id, doc.drid, [], indices);
      const sent = results.filter((r) => r.status === "sent").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const errors = results.filter((r) => r.status === "error").length;
      summary.push({ drid: doc.drid, sent, skipped, errors });
    } catch (e) {
      console.error(`[cron-dispatch] ${doc.drid}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`[cron-dispatch] done — processed ${summary.length} doc(s)`, summary);
  return NextResponse.json({ ok: true, docs: summary.length, summary });
}
