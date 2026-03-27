import { NextResponse } from "next/server";
import type {
  InvoiceCoreEntities,
  LegalCoreEntities,
  UniversalMinimalEntities,
} from "@/lib/document-entities";
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

    // Supabase client in this repo is loosely typed, which can lead to `never[]` inference.
    // We only rely on `id` to fetch entity rows.
    const documents = (data ?? []) as Array<
      { id: string } & Record<string, unknown>
    >;
    const documentIds = documents.map((d) => d.id).filter(Boolean);

    if (documentIds.length === 0) {
      return NextResponse.json({ items: [] });
    }

    // Fetch latest extracted entities for these documents.
    const { data: entityRows, error: entitiesError } = await supabase.client
      .from("document_entities")
      .select(
        "document_id, entity_type, entities_json, confidence, method, created_at, sender, addressee, reference_number, document_date, document_type, invoice_number, invoice_date, due_date, currency, total_amount, tax_amount, vendor_name, buyer_name, case_number, notice_date, authority, deadline, reference_legal, claimant_name, respondent_name, claimant_email, respondent_email, respondent_contact_name, employment_start_date, employment_end_date, employment_status, occupation, basic_salary_monthly",
      )
      .in("document_id", documentIds)
      .order("created_at", { ascending: false })
      .limit(50);

    if (entitiesError) {
      // Non-fatal: return documents without entity enrichment.
      return NextResponse.json({ items: documents });
    }

    const typedRows = (entityRows ?? []) as Array<{
      document_id: string;
      entity_type: "universal_minimal" | "invoice_core" | "legal_core";
      entities_json:
        | UniversalMinimalEntities
        | InvoiceCoreEntities
        | LegalCoreEntities;
      confidence?: number | null;
      method?: string | null;
      created_at?: string | null;
      sender?: string | null;
      addressee?: string | null;
      reference_number?: string | null;
      document_date?: string | null;
      document_type?: string | null;
      invoice_number?: string | null;
      invoice_date?: string | null;
      due_date?: string | null;
      currency?: string | null;
      total_amount?: string | number | null;
      tax_amount?: string | number | null;
      vendor_name?: string | null;
      buyer_name?: string | null;
      case_number?: string | null;
      notice_date?: string | null;
      authority?: string | null;
      deadline?: string | null;
      reference_legal?: string | null;
      claimant_name?: string | null;
      respondent_name?: string | null;
      claimant_email?: string | null;
      respondent_email?: string | null;
      respondent_contact_name?: string | null;
      employment_start_date?: string | null;
      employment_end_date?: string | null;
      employment_status?: string | null;
      occupation?: string | null;
      basic_salary_monthly?: string | number | null;
    }>;

    type EntityRow = (typeof typedRows)[number];

    const byDoc: Record<
      string,
      {
        universal?: EntityRow & { entities_json: UniversalMinimalEntities };
        invoice?: EntityRow & { entities_json: InvoiceCoreEntities };
        legal?: EntityRow & { entities_json: LegalCoreEntities };
      }
    > = {};

    for (const row of typedRows) {
      const docId = row.document_id;
      byDoc[docId] ??= {};
      if (row.entity_type === "universal_minimal") {
        byDoc[docId].universal = {
          ...row,
          entities_json: row.entities_json as UniversalMinimalEntities,
        };
      }
      if (row.entity_type === "invoice_core") {
        byDoc[docId].invoice = {
          ...row,
          entities_json: row.entities_json as InvoiceCoreEntities,
        };
      }
      if (row.entity_type === "legal_core") {
        byDoc[docId].legal = {
          ...row,
          entities_json: row.entities_json as LegalCoreEntities,
        };
      }
    }

    const flattenEntityValue = (maybeEntityField: unknown): string | null => {
      if (!maybeEntityField) return null;
      if (typeof maybeEntityField === "string") return maybeEntityField;

      if (typeof maybeEntityField !== "object") return null;
      const maybeObj = maybeEntityField as { value?: unknown };
      const v = maybeObj.value;
      if (typeof v === "string") return v;
      return null;
    };

    const items = documents.map((doc) => {
      const enriched = byDoc[doc.id] ?? {};
      const u =
        enriched.universal?.entities_json ?? ({} as UniversalMinimalEntities);
      const inv =
        enriched.invoice?.entities_json ?? ({} as InvoiceCoreEntities);
      const legal = enriched.legal?.entities_json ?? ({} as LegalCoreEntities);

      return {
        ...doc,
        entity_sender:
          enriched.universal?.sender ?? flattenEntityValue(u.sender),
        entity_addressee:
          enriched.universal?.addressee ?? flattenEntityValue(u.addressee),
        entity_reference_number:
          enriched.universal?.reference_number ??
          flattenEntityValue(u.reference_number),
        entity_document_date:
          enriched.universal?.document_date ??
          flattenEntityValue(u.document_date),
        entity_document_type:
          enriched.universal?.document_type ??
          flattenEntityValue(u.document_type),

        entity_invoice_number:
          enriched.invoice?.invoice_number ??
          flattenEntityValue(inv.invoice_number),
        entity_invoice_date:
          enriched.invoice?.invoice_date ??
          flattenEntityValue(inv.invoice_date),
        entity_due_date:
          enriched.invoice?.due_date ?? flattenEntityValue(inv.due_date),
        entity_currency:
          enriched.invoice?.currency ?? flattenEntityValue(inv.currency),
        entity_total_amount:
          enriched.invoice?.total_amount != null
            ? String(enriched.invoice.total_amount)
            : flattenEntityValue(inv.total_amount),
        entity_tax_amount:
          enriched.invoice?.tax_amount != null
            ? String(enriched.invoice.tax_amount)
            : flattenEntityValue(inv.tax_amount),
        entity_vendor_name:
          enriched.invoice?.vendor_name ?? flattenEntityValue(inv.vendor_name),
        entity_buyer_name:
          enriched.invoice?.buyer_name ?? flattenEntityValue(inv.buyer_name),

        entity_case_number:
          enriched.legal?.case_number ?? flattenEntityValue(legal.case_number),
        entity_notice_date:
          enriched.legal?.notice_date ?? flattenEntityValue(legal.notice_date),
        entity_authority:
          enriched.legal?.authority ?? flattenEntityValue(legal.authority),
        entity_deadline:
          enriched.legal?.deadline ?? flattenEntityValue(legal.deadline),
        entity_claimant_name:
          enriched.legal?.claimant_name ??
          flattenEntityValue(legal.claimant_name),
        entity_respondent_name:
          enriched.legal?.respondent_name ??
          flattenEntityValue(legal.respondent_name),
        entity_claimant_email:
          enriched.legal?.claimant_email ??
          flattenEntityValue(legal.claimant_email),
        entity_respondent_email:
          enriched.legal?.respondent_email ??
          flattenEntityValue(legal.respondent_email),
        entity_respondent_contact_name:
          enriched.legal?.respondent_contact_name ??
          flattenEntityValue(legal.respondent_contact_name),
        entity_employment_start_date:
          enriched.legal?.employment_start_date ??
          flattenEntityValue(legal.employment_start_date),
        entity_employment_end_date:
          enriched.legal?.employment_end_date ??
          flattenEntityValue(legal.employment_end_date),
        entity_employment_status:
          enriched.legal?.employment_status ??
          flattenEntityValue(legal.employment_status),
        entity_occupation:
          enriched.legal?.occupation ?? flattenEntityValue(legal.occupation),
        entity_basic_salary_monthly:
          enriched.legal?.basic_salary_monthly != null
            ? String(enriched.legal.basic_salary_monthly)
            : flattenEntityValue(legal.basic_salary_monthly),
        entity_reference_legal:
          enriched.legal?.reference_legal ??
          flattenEntityValue(legal.reference_legal),
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
