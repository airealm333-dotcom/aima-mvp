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

    const entitiesRes = await supabase.client
      .from("document_entities")
      .select(
        "document_id, sender_name, recipient_name, organization_name, contact_person_name, reference_number, document_date, document_type, deadline_date, claimant_name, claimant_email, respondent_name, respondent_email, account_name",
      )
      .in("document_id", documentIds);

    if (entitiesRes.error) {
      return NextResponse.json({ items: documents });
    }

    const s = (v: unknown) => (v != null && v !== "" ? String(v) : null);

    const entitiesByDoc = Object.fromEntries(
      (entitiesRes.data ?? []).map((r: Record<string, unknown>) => [
        r.document_id as string,
        r,
      ]),
    );

    const items = documents.map((doc) => {
      const e = entitiesByDoc[doc.id] as Record<string, unknown> | undefined;

      return {
        ...doc,
        entity_sender: e?.sender_name != null ? s(e.sender_name) : null,
        entity_addressee:
          e?.recipient_name != null ? s(e.recipient_name) : null,
        entity_organization_name:
          e?.organization_name != null ? s(e.organization_name) : null,
        entity_contact_person_name:
          e?.contact_person_name != null ? s(e.contact_person_name) : null,
        entity_reference_number:
          e?.reference_number != null ? s(e.reference_number) : null,
        entity_document_date:
          e?.document_date != null ? s(e.document_date) : null,
        entity_document_type:
          e?.document_type != null ? s(e.document_type) : null,

        entity_invoice_number: null,
        entity_invoice_date: null,
        entity_due_date: null,
        entity_currency: null,
        entity_total_amount: null,
        entity_tax_amount: null,
        entity_vendor_name: e?.account_name != null ? s(e.account_name) : null,
        entity_buyer_name: null,

        entity_case_number: null,
        entity_notice_date: null,
        entity_authority: null,
        entity_deadline: e?.deadline_date != null ? s(e.deadline_date) : null,
        entity_claimant_name:
          e?.claimant_name != null ? s(e.claimant_name) : null,
        entity_respondent_name:
          e?.respondent_name != null ? s(e.respondent_name) : null,
        entity_claimant_email:
          e?.claimant_email != null ? s(e.claimant_email) : null,
        entity_respondent_email:
          e?.respondent_email != null ? s(e.respondent_email) : null,
        entity_respondent_contact_name: null,
        entity_employment_start_date: null,
        entity_employment_end_date: null,
        entity_employment_status: null,
        entity_occupation: null,
        entity_basic_salary_monthly: null,
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
