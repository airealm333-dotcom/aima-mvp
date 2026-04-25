import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/**
 * Two modes for deferred items, controlled by `action`:
 *
 * - `action: "save"` — save contact email + accounting manager onto a deferred
 *   item. Item STAYS deferred; this just updates the displayed info so the
 *   dashboard card shows the manager without having to open the item.
 *
 * - `action: "close"` — mark the deferred item as done WITHOUT sending any email.
 *   Clears `deferred_at`, sets `closed_at` (so dispatch-poll skips it permanently),
 *   and makes the item count as processed.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ documentId: string; index: string }> },
) {
  const { documentId, index: indexStr } = await params;
  const itemIndex = Number(indexStr);
  const body = (await req.json()) as {
    action?: "save" | "close";
    email?: string;
    accountingManagerName?: string;
    accountingManagerEmail?: string;
  };

  const action = body.action ?? "save";
  const email = (body.email ?? "").trim() || null;
  const mgrName = (body.accountingManagerName ?? "").trim() || null;
  const mgrEmail = (body.accountingManagerEmail ?? "").trim() || null;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const { data: docData, error: docErr } = await supabase.client
    .from("documents")
    .select("ocr_clients_items")
    .eq("id", documentId)
    .maybeSingle();

  if (docErr || !docData) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const items: Record<string, unknown>[] = Array.isArray(
    (docData as { ocr_clients_items: unknown }).ocr_clients_items,
  )
    ? ([...(docData as { ocr_clients_items: unknown[] }).ocr_clients_items] as Record<string, unknown>[])
    : [];

  if (itemIndex < 0 || itemIndex >= items.length) {
    return NextResponse.json({ error: "Item index out of range" }, { status: 400 });
  }

  const existing = items[itemIndex] as Record<string, unknown>;
  const now = new Date().toISOString();

  if (action === "close") {
    // Move to Processed without dispatching: clear deferred_at, set closed_at.
    items[itemIndex] = {
      ...existing,
      // Preserve any contact/manager info already saved
      ...(email != null ? { odoo_contact_email: email } : {}),
      ...(mgrName != null ? { odoo_accounting_manager_name: mgrName } : {}),
      ...(mgrEmail != null ? { odoo_accounting_manager_email: mgrEmail } : {}),
      deferred_at: null,
      closed_at: now,
    };
  } else {
    // "save" — update contact/manager but keep the item deferred
    items[itemIndex] = {
      ...existing,
      ...(email != null ? { odoo_contact_email: email } : {}),
      ...(mgrName != null
        ? {
            odoo_accounting_manager_name: mgrName,
            odoo_contact_name: mgrName,
          }
        : {}),
      ...(mgrEmail != null ? { odoo_accounting_manager_email: mgrEmail } : {}),
      // Ensure it stays deferred even if somehow cleared
      deferred_at: (existing.deferred_at as string | null) ?? now,
    };
  }

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ item: items[itemIndex] });
}
