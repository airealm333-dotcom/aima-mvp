/** Shared rules for “needs review” (dashboard + dispatch). */

export const OCR_CLIENTS_CONFIDENCE_THRESHOLD = 70;

export type OcrClientReviewFields = {
  confidence?: number | null;
  odoo_match_status?: string | null;
  odoo_contact_email?: string | null;
  UEN?: string | null;
  pdfError?: string | null;
  deferred_at?: string | null;
  dispatched_at?: string | null;
  closed_at?: string | null;
};

export function ocrClientItemIsDeferred(
  item: OcrClientReviewFields | Record<string, unknown>,
): boolean {
  return Boolean(item.deferred_at);
}

export function ocrClientItemIsClosed(
  item: OcrClientReviewFields | Record<string, unknown>,
): boolean {
  return Boolean(item.closed_at);
}

export function ocrClientItemNeedsReview(
  item: OcrClientReviewFields | Record<string, unknown>,
): boolean {
  // Already dispatched — email has gone, no review possible.
  if (item.dispatched_at) return false;
  // Manually closed without dispatch — user decided "done", no action.
  if (ocrClientItemIsClosed(item)) return false;
  // Deferred items are parked — not in needs-review, not dispatchable.
  if (ocrClientItemIsDeferred(item)) return false;
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

export function countOcrClientItemsDeferred(
  items: Array<OcrClientReviewFields | Record<string, unknown>>,
): number {
  return items.filter(ocrClientItemIsDeferred).length;
}
