import { NextResponse } from "next/server";
import { getGmailClientOrNull } from "@/lib/gmail-client";
import { getOrCreateLabelId } from "@/lib/gmail-intake";
import { syncGmailUnprocessedToQueue } from "@/lib/gmail-queue";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

/** Pull Gmail Unprocessed into `gmail_intake_queue` (no intake). */
export async function POST() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_CONFIG_MISSING" },
      { status: 500 },
    );
  }

  const gmail = getGmailClientOrNull();
  if (!gmail) {
    return NextResponse.json({ error: "GMAIL_NOT_CONFIGURED" }, { status: 503 });
  }

  const userId = process.env.GMAIL_INTAKE_USER_ID?.trim() || "me";
  const unprocessedName =
    process.env.GMAIL_INTAKE_LABEL_UNPROCESSED?.trim() || "Unprocessed";
  const unprocessedId = await getOrCreateLabelId(
    gmail,
    userId,
    unprocessedName,
  );
  if (!unprocessedId) {
    return NextResponse.json(
      { error: `LABEL_MISSING_OR_CREATE_FAILED:${unprocessedName}` },
      { status: 500 },
    );
  }

  try {
    const out = await syncGmailUnprocessedToQueue(
      supabase,
      gmail,
      userId,
      unprocessedId,
    );
    return NextResponse.json({
      ok: true,
      listedCount: out.listedCount,
      upserted: out.upserted,
      errors: out.errors,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "SYNC_FAILED", detail }, { status: 500 });
  }
}
