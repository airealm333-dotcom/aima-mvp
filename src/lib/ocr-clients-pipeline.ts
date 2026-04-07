import { extractPdfText, type OcrResult } from "@/lib/ocr";
import {
  type ClassificationLabel,
  extractOcrClientRowsFromDocumentText,
  parsePageRangeString,
  slicePdfBufferByOneBasedPageRange,
} from "@/lib/ocr-client-extract";
import {
  authenticateOdooForMatch,
  type ClientMatchInputs,
  loadOdooMatchConfigFromEnv,
  resolveOdooRecipientContact,
  runOdooClientMatch,
} from "@/lib/odoo-client-match";
import { normalizeUen } from "@/lib/odoo-match-helpers";

export type OcrClientsPipelineItemInternal = {
  index: number;
  name: string;
  UEN: string;
  document_type: string;
  classification: ClassificationLabel;
  confidence: number;
  page_range: string;
  pageStart: number | null;
  pageEnd: number | null;
  pdfBuffer: Buffer | null;
  pdfError: string | null;
  odoo_match_status: string | null;
  odoo_partner_id: number | null;
  odoo_match_score: number | null;
  odoo_match_method: string | null;
  odoo_contact_email: string | null;
  odoo_resolution_method: string | null;
  odoo_accounting_manager_email: string | null;
  odoo_accounting_manager_name: string | null;
  sender_name: string | null;
  sender_address: string | null;
};

export type OcrClientsPipelineResult = {
  ocr: Pick<
    OcrResult,
    "pageCount" | "textLength" | "provider" | "pageAlignment"
  >;
  overall_confidence: number;
  items: OcrClientsPipelineItemInternal[];
};

/**
 * Full OCR (labeled pages) + Claude client rows + PDF slice per page_range.
 * Used by POST /api/ocr-clients and POST /api/dashboard/documents/[id]/run-ocr-clients.
 */
export async function runOcrClientsPipelineOnPdfBuffer(
  pdfBuffer: Buffer,
): Promise<OcrClientsPipelineResult> {
  const ocr = await extractPdfText(pdfBuffer, "application/pdf", {
    labelPdfPages: true,
  });

  const { overall_confidence, items: rows } =
    await extractOcrClientRowsFromDocumentText(ocr.text);

  const items = await Promise.all(
    rows.map(async (row, index) => {
      const pr = parsePageRangeString(row.page_range, ocr.pageCount);
      const nullOdoo = {
        odoo_match_status: null as string | null,
        odoo_partner_id: null as number | null,
        odoo_match_score: null as number | null,
        odoo_match_method: null as string | null,
        odoo_contact_email: null as string | null,
        odoo_resolution_method: null as string | null,
        odoo_accounting_manager_email: null as string | null,
        odoo_accounting_manager_name: null as string | null,
        sender_name: row.sender_name === "Null" ? null : (row.sender_name || null),
        sender_address: row.sender_address === "Null" ? null : (row.sender_address || null),
      };

      if (!pr) {
        return {
          index,
          name: row.name,
          UEN: row.UEN,
          document_type: row.document_type,
          classification: row.classification,
          confidence: row.confidence,
          page_range: row.page_range,
          pageStart: null as number | null,
          pageEnd: null as number | null,
          pdfBuffer: null as Buffer | null,
          pdfError: `Could not parse page_range "${row.page_range}" for a ${ocr.pageCount}-page PDF.`,
          ...nullOdoo,
        };
      }
      try {
        const pdfBuf = await slicePdfBufferByOneBasedPageRange(
          pdfBuffer,
          pr.start,
          pr.end,
        );
        return {
          index,
          name: row.name,
          UEN: row.UEN,
          document_type: row.document_type,
          classification: row.classification,
          confidence: row.confidence,
          page_range: row.page_range,
          pageStart: pr.start,
          pageEnd: pr.end,
          pdfBuffer: pdfBuf,
          pdfError: null as string | null,
          ...nullOdoo,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          index,
          name: row.name,
          UEN: row.UEN,
          document_type: row.document_type,
          classification: row.classification,
          confidence: row.confidence,
          page_range: row.page_range,
          pageStart: pr.start,
          pageEnd: pr.end,
          pdfBuffer: null as Buffer | null,
          pdfError: msg,
          ...nullOdoo,
        };
      }
    }),
  );

  const matchedItems = await runOdooMatchingForItems(items);

  return {
    ocr: {
      pageCount: ocr.pageCount,
      textLength: ocr.textLength,
      provider: ocr.provider,
      pageAlignment: ocr.pageAlignment,
    },
    overall_confidence,
    items: matchedItems,
  };
}

/**
 * Runs Odoo D3/D4 matching for each extracted client item.
 * Authenticates once and reuses the session across all items.
 * Silently skips if Odoo is not configured.
 */
async function runOdooMatchingForItems(
  items: OcrClientsPipelineItemInternal[],
): Promise<OcrClientsPipelineItemInternal[]> {
  const cfg = loadOdooMatchConfigFromEnv();
  if (!cfg) return items;

  let client: Awaited<ReturnType<typeof authenticateOdooForMatch>>["client"];
  let uid: number;
  try {
    ({ client, uid } = await authenticateOdooForMatch(cfg));
  } catch {
    return items;
  }

  return Promise.all(
    items.map(async (item) => {
      const inputs: ClientMatchInputs = {
        uen: normalizeUen(item.UEN === "Null" ? null : item.UEN),
        legalName: item.name || null,
        tradingName: null,
      };

      try {
        const matchResult = await runOdooClientMatch(client, uid, cfg, inputs);

        let odoo_contact_email: string | null = null;
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
            odoo_resolution_method = d4.resolutionMethod;
          }
          odoo_accounting_manager_email = d4.accountingManagerEmail;
          odoo_accounting_manager_name = d4.accountingManagerName;
        }

        return {
          ...item,
          odoo_match_status: matchResult.status,
          odoo_partner_id: matchResult.partnerId,
          odoo_match_score: matchResult.score,
          odoo_match_method: matchResult.method,
          odoo_contact_email,
          odoo_resolution_method,
          odoo_accounting_manager_email,
          odoo_accounting_manager_name,
        };
      } catch {
        return {
          ...item,
          odoo_match_status: "error",
          odoo_partner_id: null,
          odoo_match_score: null,
          odoo_match_method: null,
          odoo_contact_email: null,
          odoo_resolution_method: null,
          odoo_accounting_manager_email: null,
          odoo_accounting_manager_name: null,
        };
      }
    }),
  );
}
