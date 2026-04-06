import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const DOC_SELECT =
  "id, drid, status, file_path, created_at, mail_item_id, classification_label, classification_confidence, ocr_clients_status, ocr_clients_items, ocr_clients_ocr_summary, ocr_clients_completed_at, ocr_clients_error, split_index, split_total, split_parent_ref";

const GMAIL_QUEUE_SELECT =
  "id, gmail_message_id, subject, subject_mrid, subject_drid, snippet, internal_date_ms, attachment_filename, attachment_mime, status, error_message, processing_started_at, created_at";

export async function GET() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return NextResponse.json(
      { error: "SUPABASE_CONFIG_MISSING" },
      { status: 500 },
    );
  }

  let gmailUnprocessed: unknown[] = [];
  let gmailInProgress: unknown[] = [];
  let gmailQueueHint: string | undefined;

  const gqWaiting = await supabase.client
    .from("gmail_intake_queue")
    .select(GMAIL_QUEUE_SELECT)
    .in("status", ["queued", "failed", "skipped"])
    .order("internal_date_ms", { ascending: false, nullsFirst: false })
    .limit(100);

  if (gqWaiting.error) {
    const m = gqWaiting.error.message ?? "";
    if (
      m.includes("gmail_intake_queue") ||
      m.includes("schema cache") ||
      m.includes("does not exist")
    ) {
      gmailQueueHint =
        "Run sql/gmail_intake_queue.sql in Supabase to enable the Gmail queue tab.";
    }
  } else {
    gmailUnprocessed = gqWaiting.data ?? [];
  }

  const gqProc = await supabase.client
    .from("gmail_intake_queue")
    .select(GMAIL_QUEUE_SELECT)
    .eq("status", "processing")
    .order("processing_started_at", { ascending: false, nullsFirst: true })
    .limit(20);

  if (!gqProc.error) {
    gmailInProgress = gqProc.data ?? [];
  }

  let gmailProcessed: unknown[] = [];
  const gqDone = await supabase.client
    .from("gmail_intake_queue")
    .select(GMAIL_QUEUE_SELECT)
    .eq("status", "ingested")
    .order("ingested_at" as never, { ascending: false, nullsFirst: false })
    .limit(100);

  if (!gqDone.error) {
    gmailProcessed = gqDone.data ?? [];
  }

  const procRes = await supabase.client
    .from("documents")
    .select(
      `${DOC_SELECT}, mail_items ( mrid, received_at, sender, addressee )`,
    )
    .or(
      "ocr_clients_status.eq.processing,ocr_clients_status.eq.failed",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (procRes.error) {
    const d = procRes.error.message ?? "";
    const missing =
      d.includes("ocr_clients") ||
      d.includes("column") ||
      d.includes("schema cache");
    return NextResponse.json(
      {
        error: missing
          ? "SCHEMA_MISSING_OCR_CLIENTS_COLUMNS"
          : "DASHBOARD_QUERY_FAILED",
        detail: procRes.error.message,
        hint: missing
          ? "Run sql/documents_ocr_clients_columns.sql in Supabase, then retry."
          : undefined,
      },
      { status: 500 },
    );
  }

  const doneRes = await supabase.client
    .from("documents")
    .select(
      `${DOC_SELECT}, mail_items ( mrid, received_at, sender, addressee )`,
    )
    .eq("ocr_clients_status", "completed")
    .order("created_at", { ascending: false })
    .limit(100);

  if (doneRes.error) {
    return NextResponse.json(
      {
        error: "DASHBOARD_QUERY_FAILED",
        detail: doneRes.error.message,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    gmailUnprocessed,
    gmailInProgress,
    gmailProcessed,
    ...(gmailQueueHint ? { gmailQueueHint } : {}),
    processing: procRes.data ?? [],
    processed: doneRes.data ?? [],
  });
}
