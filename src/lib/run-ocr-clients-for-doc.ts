import { runOcrClientsPipelineOnPdfBuffer } from "@/lib/ocr-clients-pipeline";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";

function splitStoragePath(
  sourceFilePath: string,
  drid: string,
  index: number,
) {
  const i = sourceFilePath.lastIndexOf("/");
  const dir = i >= 0 ? sourceFilePath.slice(0, i) : "";
  const name = `${drid}-ocr-client-${index}.pdf`;
  return dir ? `${dir}/${name}` : name;
}

type StoredOcrItem = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  classification: string;
  confidence: number;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  split_path: string | null;
  pdfError: string | null;
  odoo_match_status: string | null;
  odoo_partner_id: number | null;
  odoo_match_score: number | null;
  odoo_match_method: string | null;
  odoo_contact_email: string | null;
  odoo_resolution_method: string | null;
  odoo_accounting_manager_email: string | null;
  odoo_accounting_manager_name: string | null;
};

export type OcrClientsDocResult = {
  ocr: {
    pageCount: number;
    textLength: number;
    provider: string;
    pageAlignment: unknown;
  };
  overall_confidence: number;
  items: StoredOcrItem[];
};

/**
 * Run the OCR→Clients pipeline for an already-created document and persist
 * the results. Called from both the manual API route and the intake pipeline.
 */
export async function runOcrClientsForDocument(
  supabase: SupabaseAdminBundle,
  documentId: string,
): Promise<OcrClientsDocResult> {
  console.log(`[run-ocr-clients] starting for documentId: ${documentId}`);
  await supabase.client
    .from("documents")
    .update({ ocr_clients_status: "processing", ocr_clients_error: null } as never)
    .eq("id", documentId);

  try {
    const docRes = await supabase.client
      .from("documents")
      .select("id, drid, file_path")
      .eq("id", documentId)
      .maybeSingle();

    if (docRes.error || !docRes.data) {
      throw new Error(docRes.error?.message ?? "Document not found");
    }

    const row = docRes.data as { id: string; drid: string; file_path: string };

    if (!row.file_path?.toLowerCase().endsWith(".pdf")) {
      throw new Error("NOT_A_PDF_DOCUMENT");
    }

    const dl = await supabase.client.storage
      .from(supabase.storageBucket)
      .download(row.file_path);

    if (dl.error || !dl.data) {
      throw new Error(dl.error?.message ?? "Storage download failed");
    }

    const buffer = Buffer.from(await dl.data.arrayBuffer());
    const { ocr, overall_confidence, items } =
      await runOcrClientsPipelineOnPdfBuffer(buffer);

    const storedItems: StoredOcrItem[] = [];

    for (const it of items) {
      const splitPath = splitStoragePath(row.file_path, row.drid, it.index);
      let uploadedPath: string | null = null;
      let pdfError = it.pdfError;

      if (it.pdfBuffer && it.pdfBuffer.length > 0) {
        const up = await supabase.client.storage
          .from(supabase.storageBucket)
          .upload(splitPath, it.pdfBuffer, {
            contentType: "application/pdf",
            upsert: true,
          });
        if (up.error) {
          pdfError = up.error.message;
        } else {
          uploadedPath = splitPath;
        }
      }

      storedItems.push({
        index: it.index,
        name: it.name,
        UEN: it.UEN,
        document_type: it.document_type,
        classification: it.classification,
        confidence: it.confidence,
        page_range: it.page_range,
        pageStart: it.pageStart,
        pageEnd: it.pageEnd,
        split_path: uploadedPath,
        pdfError,
        odoo_match_status: it.odoo_match_status,
        odoo_partner_id: it.odoo_partner_id,
        odoo_match_score: it.odoo_match_score,
        odoo_match_method: it.odoo_match_method,
        odoo_contact_email: it.odoo_contact_email,
        odoo_resolution_method: it.odoo_resolution_method,
        odoo_accounting_manager_email: it.odoo_accounting_manager_email,
        odoo_accounting_manager_name: it.odoo_accounting_manager_name,
      });
    }

    const now = new Date().toISOString();
    await supabase.client
      .from("documents")
      .update({
        ocr_clients_status: "completed",
        ocr_clients_completed_at: now,
        ocr_clients_ocr_summary: {
          pageCount: ocr.pageCount,
          textLength: ocr.textLength,
          provider: ocr.provider,
          pageAlignment: ocr.pageAlignment ?? null,
          overall_confidence,
        },
        ocr_clients_items: storedItems,
        ocr_clients_error: null,
      } as never)
      .eq("id", documentId);

    await supabase.client.from("audit_logs" as never).insert({
      entity_type: "document",
      entity_id: documentId,
      action: "OCR_CLIENTS_PIPELINE_COMPLETED",
      actor: "AIMA",
      metadata: { drid: row.drid, itemCount: storedItems.length },
    } as never);

    return {
      ocr: {
        pageCount: ocr.pageCount,
        textLength: ocr.textLength,
        provider: ocr.provider,
        pageAlignment: ocr.pageAlignment ?? null,
      },
      overall_confidence,
      items: storedItems,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.client
      .from("documents")
      .update({ ocr_clients_status: "failed", ocr_clients_error: msg } as never)
      .eq("id", documentId);
    throw e;
  }
}
