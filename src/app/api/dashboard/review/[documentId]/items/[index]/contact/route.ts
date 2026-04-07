import { NextResponse } from "next/server";
import { scheduleDispatchAfterReviewCleared } from "@/lib/ocr-clients-auto-dispatch";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ documentId: string; index: string }> },
) {
  const { documentId, index: indexStr } = await params;
  const itemIndex = Number(indexStr);
  const { email } = (await req.json()) as { email: string };

  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const { data: docData, error: docErr } = await supabase.client
    .from("documents")
    .select("ocr_clients_items")
    .eq("id", documentId)
    .maybeSingle();

  if (docErr || !docData) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const items: Record<string, unknown>[] = Array.isArray((docData as { ocr_clients_items: unknown }).ocr_clients_items)
    ? ([...(docData as { ocr_clients_items: unknown[] }).ocr_clients_items] as Record<string, unknown>[])
    : [];

  if (itemIndex < 0 || itemIndex >= items.length) {
    return NextResponse.json({ error: "Item index out of range" }, { status: 400 });
  }

  items[itemIndex] = {
    ...items[itemIndex],
    odoo_contact_email: email.trim() || null,
    odoo_resolution_method: "manual_override",
  };

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  scheduleDispatchAfterReviewCleared(supabase, documentId, itemIndex);

  return NextResponse.json({ item: items[itemIndex] });
}
