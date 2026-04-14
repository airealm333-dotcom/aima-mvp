/** Shared rules for “needs review” (dashboard + dispatch). */

export const OCR_CLIENTS_CONFIDENCE_THRESHOLD = 70;

export type OcrClientReviewFields = {
  confidence?: number | null;
  odoo_match_status?: string | null;
  odoo_contact_email?: string | null;
  UEN?: string | null;
  pdfError?: string | null;
};

export function ocrClientItemNeedsReview(
  item: OcrClientReviewFields | Record<string, unknown>,
): boolean {
  const conf = item.confidence as number | null | undefined;
  if (conf != null && conf < OCR_CLIENTS_CONFIDENCE_THRESHOLD) return true;
  const status = item.odoo_match_status as string | null | undefined;
  // Null/empty/error status = Odoo matching never ran (auth failure, timeout, etc.)
  if (!status || status === "error") return true;
  if (status === "no_match") return true;
  if (status === "ambiguous") return true;
  if (status === "matched" && !item.odoo_contact_email) return true;
  const uen = item.UEN as string | null | undefined;
  if (uen === "Null" && status !== "matched") return true;
  if (item.pdfError) return true;
  return false;
}

export function countOcrClientItemsNeedingReview(
  items: Array<OcrClientReviewFields | Record<string, unknown>>,
): number {
  return items.filter(ocrClientItemNeedsReview).length;
}
