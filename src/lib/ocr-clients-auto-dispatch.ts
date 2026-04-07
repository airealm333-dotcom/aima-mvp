import { ocrClientItemNeedsReview } from "@/lib/ocr-clients-review";
import { getDispatchMode } from "@/lib/app-settings";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";
import type { DispatchItem } from "@/lib/dispatch-email";

/**
 * After a review UI save (manual match / contact edit), log whether the item
 * is now ready for dispatch. Actual sending is done by the cron job at
 * /api/cron/dispatch-pending — no in-process setTimeout to avoid races.
 */
export function scheduleDispatchAfterReviewCleared(
  supabase: SupabaseAdminBundle,
  documentId: string,
  fixedItemIndex: number,
): void {
  if (!process.env.DISPATCH_TO_EMAIL?.trim()) return;

  void (async () => {
    try {
      const [{ data, error }, mode] = await Promise.all([
        supabase.client
          .from("documents")
          .select("drid, ocr_clients_items")
          .eq("id", documentId)
          .maybeSingle(),
        getDispatchMode(),
      ]);

      if (error || !data) return;
      const row = data as { drid: string; ocr_clients_items: unknown };
      const items = Array.isArray(row.ocr_clients_items)
        ? (row.ocr_clients_items as DispatchItem[])
        : [];
      if (items.length === 0) return;

      const drid = row.drid;

      if (mode === "document_complete") {
        const stillNeedsReview = items.filter(ocrClientItemNeedsReview).length;
        console.log(
          stillNeedsReview > 0
            ? `[dispatch-review] ${drid}: ${stillNeedsReview} item(s) still need review — cron will send when all clear`
            : `[dispatch-review] ${drid}: all items clean — cron will dispatch shortly`,
        );
        return;
      }

      // item_ready: just log — cron picks it up within 5 min
      const fixedItem = items.find((it) => it.index === fixedItemIndex);
      if (!fixedItem) return;
      if (ocrClientItemNeedsReview(fixedItem)) {
        console.log(`[dispatch-review] ${drid}: item ${fixedItemIndex} still needs review`);
        return;
      }
      if (fixedItem.dispatched_at) {
        console.log(`[dispatch-review] ${drid}: item ${fixedItemIndex} already dispatched`);
        return;
      }
      console.log(`[dispatch-review] ${drid}: item ${fixedItemIndex} ready — cron will dispatch within 5 min`);
    } catch (e) {
      console.error("[dispatch-review]", e instanceof Error ? e.message : e);
    }
  })();
}
