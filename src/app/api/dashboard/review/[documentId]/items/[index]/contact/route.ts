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

  const trimmedEmail = email.trim() || null;
  const existing = items[itemIndex] as Record<string, unknown>;
  const existingStatus = existing.odoo_match_status as string | null | undefined;

  // When the user provides a valid contact email, treat it as explicit acceptance.
  // Promote ambiguous/no_match/null/error statuses to "matched" so the dispatch-poll
  // can send the email. Keep "matched" as-is.
  let newStatus = existingStatus;
  let newMethod = existing.odoo_match_method as string | null | undefined;
  if (trimmedEmail) {
    if (!existingStatus || existingStatus !== "matched") {
      newStatus = "matched";
      newMethod = "manual_override";
    }
  }

  items[itemIndex] = {
    ...existing,
    odoo_contact_email: trimmedEmail,
    odoo_resolution_method: "manual_override",
    odoo_match_status: newStatus,
    odoo_match_method: newMethod,
  };

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  scheduleDispatchAfterReviewCleared(supabase, documentId, itemIndex);

  return NextResponse.json({ item: items[itemIndex] });
}
