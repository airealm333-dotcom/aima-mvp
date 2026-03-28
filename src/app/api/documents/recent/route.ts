import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function GET() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      {
        error: "SUPABASE_CONFIG_MISSING",
        detail:
          "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment.",
      },
      { status: 500 },
    );
  }

  try {
    const { data, error } = await supabase.client
      .from("documents")
      .select(
        "id, drid, status, file_path, created_at, mail_item_id, classification_label, classification_confidence, classification_method, classification_rationale, is_duplicate, duplicate_of_document_id, duplicate_reason, review_required, review_status, reviewed_by, reviewed_at, review_note, split_parent_ref, split_index, split_total, split_method, split_confidence, multi_invoice_suspected, split_section_type, split_reason, split_model",
      )
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      return NextResponse.json(
        {
          error: "FAILED_TO_FETCH_RECENT_DOCUMENTS",
          detail: error.message,
        },
        { status: 500 },
      );
    }

    const documents = (data ?? []) as Array<
      { id: string } & Record<string, unknown>
    >;
    const documentIds = documents.map((d) => d.id).filter(Boolean);

    if (documentIds.length === 0) {
      return NextResponse.json({ items: [] });
    }

    const [uniRes, legRes, invRes] = await Promise.all([
      supabase.client
        .from("universal_info")
        .select(
          "document_id, sender_name, recipient_name, organization_name, contact_person_name, reference_number, document_date, document_type, deadline_date",
        )
        .in("document_id", documentIds),
      supabase.client
        .from("legal_entities")
        .select(
          "document_id, case_number, court_name, claimant_name, claimant_email, respondent_name, respondent_email, respondent_contact, employment_start_date, employment_end_date, occupation, basic_salary",
        )
        .in("document_id", documentIds),
      supabase.client
        .from("invoice_entities")
        .select(
          "document_id, bill_number, bill_date, due_date, currency, gst_amount, total_amount_due, account_name, service_type",
        )
        .in("document_id", documentIds),
    ]);

    if (uniRes.error || legRes.error || invRes.error) {
      return NextResponse.json({ items: documents });
    }

    const s = (v: unknown) =>
      v != null && v !== "" ? String(v) : null;

    const uniByDoc = Object.fromEntries(
      (uniRes.data ?? []).map((r: Record<string, unknown>) => [
        r.document_id as string,
        r,
      ]),
    );
    const legByDoc = Object.fromEntries(
      (legRes.data ?? []).map((r: Record<string, unknown>) => [
        r.document_id as string,
        r,
      ]),
    );
    const invByDoc = Object.fromEntries(
      (invRes.data ?? []).map((r: Record<string, unknown>) => [
        r.document_id as string,
        r,
      ]),
    );

    const items = documents.map((doc) => {
      const u = uniByDoc[doc.id] as Record<string, unknown> | undefined;
      const leg = legByDoc[doc.id] as Record<string, unknown> | undefined;
      const inv = invByDoc[doc.id] as Record<string, unknown> | undefined;

      return {
        ...doc,
        entity_sender: u?.sender_name != null ? s(u.sender_name) : null,
        entity_addressee:
          u?.recipient_name != null ? s(u.recipient_name) : null,
        entity_organization_name:
          u?.organization_name != null ? s(u.organization_name) : null,
        entity_contact_person_name:
          u?.contact_person_name != null ? s(u.contact_person_name) : null,
        entity_reference_number:
          u?.reference_number != null ? s(u.reference_number) : null,
        entity_document_date:
          u?.document_date != null ? s(u.document_date) : null,
        entity_document_type:
          u?.document_type != null ? s(u.document_type) : null,

        entity_invoice_number:
          inv?.bill_number != null ? s(inv.bill_number) : null,
        entity_invoice_date:
          inv?.bill_date != null ? s(inv.bill_date) : null,
        entity_due_date: inv?.due_date != null ? s(inv.due_date) : null,
        entity_currency: inv?.currency != null ? s(inv.currency) : null,
        entity_total_amount:
          inv?.total_amount_due != null ? s(inv.total_amount_due) : null,
        entity_tax_amount:
          inv?.gst_amount != null ? s(inv.gst_amount) : null,
        entity_vendor_name:
          inv?.account_name != null ? s(inv.account_name) : null,
        entity_buyer_name:
          inv?.service_type != null ? s(inv.service_type) : null,

        entity_case_number:
          leg?.case_number != null ? s(leg.case_number) : null,
        entity_notice_date: null,
        entity_authority: leg?.court_name != null ? s(leg.court_name) : null,
        entity_deadline:
          u?.deadline_date != null ? s(u.deadline_date) : null,
        entity_claimant_name:
          leg?.claimant_name != null ? s(leg.claimant_name) : null,
        entity_respondent_name:
          leg?.respondent_name != null ? s(leg.respondent_name) : null,
        entity_claimant_email:
          leg?.claimant_email != null ? s(leg.claimant_email) : null,
        entity_respondent_email:
          leg?.respondent_email != null ? s(leg.respondent_email) : null,
        entity_respondent_contact_name:
          leg?.respondent_contact != null ? s(leg.respondent_contact) : null,
        entity_employment_start_date:
          leg?.employment_start_date != null
            ? s(leg.employment_start_date)
            : null,
        entity_employment_end_date:
          leg?.employment_end_date != null
            ? s(leg.employment_end_date)
            : null,
        entity_employment_status: null,
        entity_occupation:
          leg?.occupation != null ? s(leg.occupation) : null,
        entity_basic_salary_monthly:
          leg?.basic_salary != null ? s(leg.basic_salary) : null,
        entity_reference_legal: null,
      };
    });

    return NextResponse.json({ items });
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: "SUPABASE_QUERY_FAILED", detail },
      { status: 500 },
    );
  }
}
