/**
 * Next.js server startup hook. Optional in-process Gmail poll (local / long-running Node).
 * Do not rely on this on Vercel serverless — use Vercel Cron → /api/cron/intake-email instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const raw = process.env.GMAIL_AUTOPOLL_INTERVAL_MS?.trim();
  const ms = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { getSupabaseAdmin } = await import("@/lib/supabase-admin");
      const { runEmailIntakePoll } = await import("@/lib/gmail-intake");
      const supabase = getSupabaseAdmin();
      if (!supabase) {
        return;
      }
      const result = await runEmailIntakePoll(supabase);
      console.info(
        `[gmail-autopoll] scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`[gmail-autopoll] error: ${err}`);
        }
        if (result.details.length > 0) {
          console.error(
            `[gmail-autopoll] details: ${JSON.stringify(result.details)}`,
          );
        }
      }
    } catch (e) {
      console.error(
        "[gmail-autopoll]",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      busy = false;
    }
  }, ms);
}
