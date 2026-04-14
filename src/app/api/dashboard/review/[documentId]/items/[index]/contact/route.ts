import { NextResponse } from "next/server";
import { scheduleDispatchAfterReviewCleared } from "@/lib/ocr-clients-auto-dispatch";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type PatchBody = {
  email?: string;
  accountingManagerName?: string;
  accountingManagerEmail?: string;
};

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ documentId: string; index: string }> },
) {
  const { documentId, index: indexStr } = await params;
  const itemIndex = Number(indexStr);
  const body = (await req.json()) as PatchBody;

  const trimmedEmail = (body.email ?? "").trim() || null;
  const mgrName = (body.accountingManagerName ?? "").trim() || null;
  const mgrEmail = (body.accountingManagerEmail ?? "").trim() || null;

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

  const existing = items[itemIndex] as Record<string, unknown>;
  const existingStatus = existing.odoo_match_status as string | null | undefined;

  // Promote the item to "matched" only when the user has supplied ALL three:
  // contact email, accounting manager name, and accounting manager email.
  // Anything less → save the partial data but leave the match status flagged.
  const hasAllManualInputs = Boolean(trimmedEmail && mgrName && mgrEmail);

  let newStatus = existingStatus ?? null;
  let newMethod = existing.odoo_match_method as string | null | undefined;
  if (hasAllManualInputs && existingStatus !== "matched") {
    newStatus = "matched";
    newMethod = "manual_override";
  }

  items[itemIndex] = {
    ...existing,
    odoo_contact_email: trimmedEmail,
    odoo_resolution_method: "manual_override",
    odoo_match_status: newStatus,
    odoo_match_method: newMethod,
    // Always overwrite when the caller sent values; otherwise preserve existing
    ...(mgrName != null ? { odoo_accounting_manager_name: mgrName } : {}),
    ...(mgrEmail != null ? { odoo_accounting_manager_email: mgrEmail } : {}),
  };

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  scheduleDispatchAfterReviewCleared(supabase, documentId, itemIndex);

  return NextResponse.json({ item: items[itemIndex] });
}
