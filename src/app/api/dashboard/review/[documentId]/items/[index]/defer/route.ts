import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Toggle the `deferred_at` timestamp on a specific item.
 * Body: { deferred: true | false }
 * - deferred=true → stamps `deferred_at` with current timestamp
 * - deferred=false → clears `deferred_at` (undo defer)
 * Does NOT touch `dispatched_at` — already-sent items stay sent.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ documentId: string; index: string }> },
) {
  const { documentId, index: indexStr } = await params;
  const itemIndex = Number(indexStr);
  const { deferred } = (await req.json()) as { deferred: boolean };

  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const { data: docData, error: docErr } = await supabase.client
    .from("documents")
    .select("ocr_clients_items")
    .eq("id", documentId)
    .maybeSingle();

  if (docErr || !docData) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const items: Record<string, unknown>[] = Array.isArray(
    (docData as { ocr_clients_items: unknown }).ocr_clients_items,
  )
    ? ([...(docData as { ocr_clients_items: unknown[] }).ocr_clients_items] as Record<string, unknown>[])
    : [];

  if (itemIndex < 0 || itemIndex >= items.length) {
    return NextResponse.json({ error: "Item index out of range" }, { status: 400 });
  }

  const existing = items[itemIndex] as Record<string, unknown>;
  items[itemIndex] = {
    ...existing,
    deferred_at: deferred ? new Date().toISOString() : null,
  };

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ item: items[itemIndex] });
}
