import { NextResponse } from "next/server";
import { scheduleDispatchAfterReviewCleared } from "@/lib/ocr-clients-auto-dispatch";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  authenticateOdooForMatch,
  loadOdooMatchConfigFromEnv,
  resolveOdooRecipientContact,
} from "@/lib/odoo-client-match";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ documentId: string; index: string }> },
) {
  const { documentId, index: indexStr } = await params;
  const itemIndex = Number(indexStr);
  const { partnerId } = (await req.json()) as { partnerId: number };

  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return NextResponse.json({ error: "Invalid partnerId" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  // Fetch document and current items array
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

  // Run contact resolution for the chosen partner
  const cfg = loadOdooMatchConfigFromEnv();
  let contactEmail: string | null = null;
  let contactName: string | null = null;
  let resolutionMethod: string | null = null;
  let accountingManagerEmail: string | null = null;
  let accountingManagerName: string | null = null;

  if (cfg) {
    try {
      const { client, uid } = await authenticateOdooForMatch(cfg);

      // Get partner name for match record
      const partnerRows = await client.searchReadPartners(
        uid,
        [["id", "=", partnerId]],
        ["id", "name", cfg.fieldUen],
        1,
      );

      const d4 = await resolveOdooRecipientContact({ client, uid, cfg, partnerId });
      if (d4.resolutionMethod !== "not_found" && d4.email) {
        contactEmail = d4.email;
        resolutionMethod = d4.resolutionMethod;
        contactName = d4.contactName;
      }
      accountingManagerEmail = d4.accountingManagerEmail;
      accountingManagerName = d4.accountingManagerName;

      void partnerRows; // used for logging only
    } catch {
      // Contact resolution failed — proceed with null contact
    }
  }

  // Update the item at itemIndex
  items[itemIndex] = {
    ...items[itemIndex],
    odoo_match_status: "matched",
    odoo_partner_id: partnerId,
    odoo_match_score: 100,
    odoo_match_method: "manual",
    odoo_contact_email: contactEmail,
    odoo_contact_name: contactName,
    odoo_resolution_method: resolutionMethod ?? "manual",
    odoo_accounting_manager_email: accountingManagerEmail,
    odoo_accounting_manager_name: accountingManagerName,
  };

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  scheduleDispatchAfterReviewCleared(supabase, documentId, itemIndex);

  return NextResponse.json({ item: items[itemIndex] });
}
