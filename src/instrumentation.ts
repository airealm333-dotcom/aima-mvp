/**
 * Next.js server startup hook — runs in-process on Railway (long-running Node).
 * Starts two polling loops:
 *   1. Gmail intake poll (GMAIL_AUTOPOLL_INTERVAL_MS)
 *   2. Dispatch pending items (DISPATCH_POLL_INTERVAL_MS, default 5 min)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;

  // ── Gmail intake poll ──────────────────────────────────────────────────────
  const rawGmail = process.env.GMAIL_AUTOPOLL_INTERVAL_MS?.trim();
  const gmailMs = rawGmail ? Number.parseInt(rawGmail, 10) : 0;

  if (Number.isFinite(gmailMs) && gmailMs > 0) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const { getSupabaseAdmin } = await import("@/lib/supabase-admin");
        const { runEmailIntakePoll } = await import("@/lib/gmail-queue");
        const supabase = getSupabaseAdmin();
        if (!supabase) return;
        const result = await runEmailIntakePoll(supabase);
        console.info(
          `[gmail-autopoll] scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} errors=${result.errors.length}`,
        );
        for (const err of result.errors) {
          console.error(`[gmail-autopoll] error: ${err}`);
        }
      } catch (e) {
        console.error("[gmail-autopoll]", e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
      }
    }, gmailMs);
    console.info(`[gmail-autopoll] started, interval=${gmailMs}ms`);
  }

  // ── Dispatch pending items poll ────────────────────────────────────────────
  if (!process.env.DISPATCH_TO_EMAIL?.trim()) return;

  const rawDispatch = process.env.DISPATCH_POLL_INTERVAL_MS?.trim();
  const dispatchMs = rawDispatch ? Number.parseInt(rawDispatch, 10) : 5 * 60 * 1000;

  if (!Number.isFinite(dispatchMs) || dispatchMs <= 0) return;

  let dispatchBusy = false;
  setInterval(async () => {
    if (dispatchBusy) return;
    dispatchBusy = true;
    try {
      const { getSupabaseAdmin } = await import("@/lib/supabase-admin");
      const { dispatchDocumentItems } = await import("@/lib/dispatch-email");
      const { ocrClientItemNeedsReview } = await import("@/lib/ocr-clients-review");
      const { getDispatchMode } = await import("@/lib/app-settings");

      const supabase = getSupabaseAdmin();
      if (!supabase) return;

      const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const { data: docs, error } = await supabase.client
        .from("documents")
        .select("id, drid, ocr_clients_items")
        .eq("ocr_clients_status" as never, "completed")
        .lt("ocr_clients_completed_at" as never, cutoff)
        .not("ocr_clients_items" as never, "is", null) as unknown as {
          data: { id: string; drid: string; ocr_clients_items: unknown }[] | null;
          error: { message: string } | null;
        };

      if (error || !docs || docs.length === 0) return;

      const mode = await getDispatchMode();

      for (const doc of docs) {
        type Item = import("@/lib/dispatch-email").DispatchItem;
        const items: Item[] = Array.isArray(doc.ocr_clients_items)
          ? (doc.ocr_clients_items as Item[])
          : [];

        const undispatched = items.filter((it) => {
          const extra = it as { deferred_at?: string | null; closed_at?: string | null };
          return !it.dispatched_at && !extra.deferred_at && !extra.closed_at;
        });
        if (undispatched.length === 0) continue;

        const cleanItems = undispatched.filter((it) => !ocrClientItemNeedsReview(it));
        if (cleanItems.length === 0) continue;

        if (mode === "document_complete" && items.some(ocrClientItemNeedsReview)) continue;

        const indices = cleanItems.map((it) => it.index);
        try {
          const results = await dispatchDocumentItems(supabase, doc.id, doc.drid, [], indices);
          const sent = results.filter((r) => r.status === "sent").length;
          const errors = results.filter((r) => r.status === "error").length;
          if (sent > 0 || errors > 0) {
            console.info(`[dispatch-poll] ${doc.drid}: sent=${sent} errors=${errors}`);
          }
        } catch (e) {
          console.error(`[dispatch-poll] ${doc.drid}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      console.error("[dispatch-poll]", e instanceof Error ? e.message : String(e));
    } finally {
      dispatchBusy = false;
    }
  }, dispatchMs);
  console.info(`[dispatch-poll] started, interval=${dispatchMs}ms`);
}
