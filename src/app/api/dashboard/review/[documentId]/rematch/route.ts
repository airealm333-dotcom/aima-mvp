import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ocrClientItemNeedsReview } from "@/lib/ocr-clients-review";
import {
  authenticateOdooForMatch,
  loadOdooMatchConfigFromEnv,
  resolveOdooRecipientContact,
  runOdooClientMatch,
  type ClientMatchInputs,
} from "@/lib/odoo-client-match";
import { normalizeUen } from "@/lib/odoo-match-helpers";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Re-runs Odoo matching for items that currently need review.
 * Items that already have `dispatched_at` set are never touched.
 * Does NOT re-run OCR extraction — only the matching step.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  void req;
  const { documentId } = await params;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const { data: docData, error: docErr } = await supabase.client
    .from("documents")
    .select("drid, ocr_clients_items")
    .eq("id", documentId)
    .maybeSingle();

  if (docErr || !docData) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const row = docData as { drid: string; ocr_clients_items: unknown };
  const items: Record<string, unknown>[] = Array.isArray(row.ocr_clients_items)
    ? ([...(row.ocr_clients_items as unknown[])] as Record<string, unknown>[])
    : [];

  if (items.length === 0) {
    return NextResponse.json({ error: "No items on document" }, { status: 400 });
  }

  // Select items that need review AND have not been dispatched yet.
  const targets = items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => {
      if (item.dispatched_at) return false;
      return ocrClientItemNeedsReview(item);
    });

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      drid: row.drid,
      rematched: 0,
      message: "No items need rematching",
      items,
    });
  }

  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) {
    return NextResponse.json({ error: "Odoo not configured" }, { status: 503 });
  }

  let client: Awaited<ReturnType<typeof authenticateOdooForMatch>>["client"];
  let uid: number;
  try {
    ({ client, uid } = await authenticateOdooForMatch(cfg));
  } catch (e) {
    return NextResponse.json(
      { error: `Odoo auth failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 503 },
    );
  }

  const errors: string[] = [];
  let rematched = 0;

  for (const { item, idx } of targets) {
    try {
      const uenRaw = item.UEN as string | null | undefined;
      const name = item.name as string | null | undefined;

      const inputs: ClientMatchInputs = {
        uen: normalizeUen(uenRaw === "Null" || !uenRaw ? null : uenRaw),
        legalName: name || null,
        tradingName: null,
      };

      const matchResult = await runOdooClientMatch(client, uid, cfg, inputs);

      let odoo_contact_email: string | null = null;
      let odoo_contact_name: string | null = null;
      let odoo_resolution_method: string | null = null;
      let odoo_accounting_manager_email: string | null = null;
      let odoo_accounting_manager_name: string | null = null;

      if (matchResult.status === "matched" && matchResult.partnerId != null) {
        const d4 = await resolveOdooRecipientContact({
          client,
          uid,
          cfg,
          partnerId: matchResult.partnerId,
        });
        if (d4.resolutionMethod !== "not_found") {
          odoo_contact_email = d4.email;
          odoo_contact_name = d4.contactName;
          odoo_resolution_method = d4.resolutionMethod;
        }
        odoo_accounting_manager_email = d4.accountingManagerEmail;
        odoo_accounting_manager_name = d4.accountingManagerName;
      }

      items[idx] = {
        ...item,
        odoo_match_status: matchResult.status,
        odoo_partner_id: matchResult.partnerId,
        odoo_match_score: matchResult.score,
        odoo_match_method: matchResult.method,
        odoo_contact_email,
        odoo_contact_name,
        odoo_resolution_method,
        odoo_accounting_manager_email,
        odoo_accounting_manager_name,
      };
      rematched += 1;
    } catch (e) {
      errors.push(`item ${idx}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const { error: updateErr } = await supabase.client
    .from("documents")
    .update({ ocr_clients_items: items } as never)
    .eq("id", documentId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  console.log(
    `[rematch] ${row.drid}: rematched ${rematched}/${targets.length} items (errors=${errors.length})`,
  );

  return NextResponse.json({
    ok: true,
    drid: row.drid,
    total: items.length,
    targeted: targets.length,
    rematched,
    errors,
    items,
  });
}
