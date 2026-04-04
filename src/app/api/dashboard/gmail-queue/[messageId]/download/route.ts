import { NextResponse } from "next/server";
import { getGmailClientOrNull } from "@/lib/gmail-client";
import { downloadFirstSupportedAttachment } from "@/lib/gmail-intake";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const QUEUE_TABLE = "gmail_intake_queue";

/** Allow download while mail is still in the operational queue (not yet fully ingested). */
const DOWNLOADABLE = new Set(["queued", "processing", "failed", "skipped"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_CONFIG_MISSING" },
      { status: 500 },
    );
  }

  const { messageId } = await params;
  if (!messageId?.trim()) {
    return NextResponse.json({ error: "MESSAGE_ID_REQUIRED" }, { status: 400 });
  }

  const rowRes = (await supabase.client
    .from(QUEUE_TABLE)
    .select("status")
    .eq("gmail_message_id", messageId)
    .maybeSingle()) as {
    data: { status: string } | null;
    error: { message?: string } | null;
  };

  if (rowRes.error) {
    return NextResponse.json(
      {
        error: "QUEUE_QUERY_FAILED",
        detail: rowRes.error.message,
        hint:
          rowRes.error.message?.includes("gmail_intake_queue") ||
          rowRes.error.message?.includes("schema cache")
            ? "Run sql/gmail_intake_queue.sql in Supabase."
            : undefined,
      },
      { status: 500 },
    );
  }

  if (!rowRes.data || !DOWNLOADABLE.has(rowRes.data.status)) {
    return NextResponse.json(
      {
        error: "NOT_DOWNLOADABLE",
        detail:
          "No queue row for this message, or it is already ingested (use document storage).",
      },
      { status: 404 },
    );
  }

  const gmail = getGmailClientOrNull();
  if (!gmail) {
    return NextResponse.json({ error: "GMAIL_NOT_CONFIGURED" }, { status: 503 });
  }

  const userId = process.env.GMAIL_INTAKE_USER_ID?.trim() || "me";

  try {
    const file = await downloadFirstSupportedAttachment(
      gmail,
      userId,
      messageId,
    );
    if (!file) {
      return NextResponse.json(
        { error: "NO_SUPPORTED_ATTACHMENT" },
        { status: 404 },
      );
    }

    const safeName = file.filename.replace(/[^\w.\-()+ ]/g, "_").slice(0, 200);
    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${safeName}"`,
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "GMAIL_DOWNLOAD_FAILED", detail },
      { status: 502 },
    );
  }
}
