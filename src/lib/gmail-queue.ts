import { getGmailClientOrNull } from "@/lib/gmail-client";
import {
  getOrCreateLabelId,
  processSingleGmailMessage,
  type EmailPollResult,
  type GmailIntakeClient,
} from "@/lib/gmail-intake";
import { parseMridDridFromSubject } from "@/lib/mail-subject";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";

const QUEUE_TABLE = "gmail_intake_queue";

type QueueStatus =
  | "queued"
  | "processing"
  | "ingested"
  | "skipped"
  | "failed";

type GmailMessagePart = {
  mimeType?: string | null;
  filename?: string | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  body?: {
    attachmentId?: string | null;
    data?: string | null;
    size?: number | null;
  } | null;
  parts?: GmailMessagePart[] | null;
};

function getSubject(payload: GmailMessagePart | undefined): string | null {
  const headers = payload?.headers;
  if (!headers) return null;
  const h = headers.find((x) => (x.name ?? "").toLowerCase() === "subject");
  return h?.value ?? null;
}

function normalizeMime(mime?: string | null) {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function scoreAttachmentPart(part: GmailMessagePart): number {
  const mime = normalizeMime(part.mimeType);
  const name = (part.filename ?? "").toLowerCase();
  if (!part.filename && !part.body?.attachmentId && !part.body?.data) return 0;
  if (mime === "application/pdf") return 100;
  if (name.endsWith(".pdf")) return 90;
  if (ALLOWED_MIME.has(mime)) return 80;
  if (/\.(png|jpe?g|webp)$/i.test(name)) return 70;
  return 0;
}

function flattenParts(
  part: GmailMessagePart | undefined | null,
  out: GmailMessagePart[],
) {
  if (!part) return;
  out.push(part);
  for (const p of part.parts ?? []) {
    flattenParts(p, out);
  }
}

function bestAttachmentMeta(payload: GmailMessagePart | undefined) {
  const flat: GmailMessagePart[] = [];
  flattenParts(payload, flat);
  const scored: { part: GmailMessagePart; score: number }[] = [];
  for (const p of flat) {
    const score = scoreAttachmentPart(p);
    if (score > 0) scored.push({ part: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.part;
  if (!top) return { filename: null as string | null, mime: null as string | null };
  const mime = normalizeMime(top.mimeType);
  const filename =
    top.filename ||
    `attachment.${mime === "application/pdf" ? "pdf" : "bin"}`;
  return { filename, mime: mime || null };
}

const STALE_PROCESSING_MS = 45 * 60 * 1000;

async function resetStaleProcessing(supabase: SupabaseAdminBundle) {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  await supabase.client
    .from(QUEUE_TABLE)
    .update({
      status: "queued",
      processing_started_at: null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("status", "processing")
    .lt("processing_started_at", cutoff);
}

export type GmailQueueRow = {
  id: string;
  gmail_message_id: string;
  subject: string | null;
  subject_mrid: string | null;
  subject_drid: string | null;
  snippet: string | null;
  internal_date_ms: number | null;
  attachment_filename: string | null;
  attachment_mime: string | null;
  status: QueueStatus;
  error_message: string | null;
  processing_started_at: string | null;
  ingested_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * List Gmail messages in Unprocessed and upsert mirror rows (queued) for the dashboard.
 */
export async function syncGmailUnprocessedToQueue(
  supabase: SupabaseAdminBundle,
  gmail: GmailIntakeClient,
  userId: string,
  unprocessedLabelId: string,
): Promise<{ upserted: number; listedCount: number; errors: string[] }> {
  const errors: string[] = [];
  const syncMaxRaw = process.env.GMAIL_QUEUE_SYNC_MAX_MESSAGES;
  const syncMax = syncMaxRaw ? Number.parseInt(syncMaxRaw, 10) : 100;
  const limit = Number.isFinite(syncMax) && syncMax > 0 ? syncMax : 100;

  const list = await gmail.users.messages.list({
    userId,
    labelIds: [unprocessedLabelId],
    maxResults: limit,
  });

  const refs = list.data.messages ?? [];
  const listedCount = refs.length;
  let upserted = 0;

  for (const ref of refs) {
    const messageId = ref.id;
    if (!messageId) continue;
    try {
      const full = await gmail.users.messages.get({
        userId,
        id: messageId,
        format: "full",
      });
      const payload = full.data.payload;
      const subject = getSubject(payload as GmailMessagePart) ?? "";
      const { mrid, drid } = parseMridDridFromSubject(subject);
      const { filename, mime } = bestAttachmentMeta(payload as GmailMessagePart);
      const internalDateMs = full.data.internalDate
        ? Number(full.data.internalDate)
        : null;
      const snippet = full.data.snippet ?? null;

      const existing = (await supabase.client
        .from(QUEUE_TABLE)
        .select("id,status")
        .eq("gmail_message_id", messageId)
        .maybeSingle()) as {
        data: { id: string; status: string } | null;
        error: { message?: string } | null;
      };

      if (existing.error) {
        errors.push(`${messageId}:${existing.error.message ?? "select failed"}`);
        continue;
      }

      const row = existing.data;
      if (row?.status === "ingested" || row?.status === "processing") {
        continue;
      }

      const now = new Date().toISOString();
      const retryQueued =
        row?.status === "failed" || row?.status === "skipped";

      const patch: Record<string, unknown> = {
        subject: subject || null,
        subject_mrid: mrid,
        subject_drid: drid,
        snippet,
        internal_date_ms: internalDateMs,
        attachment_filename: filename,
        attachment_mime: mime,
        updated_at: now,
      };
      if (retryQueued) {
        patch.status = "queued";
        patch.error_message = null;
        patch.processing_started_at = null;
      }

      if (!row) {
        const ins = await supabase.client.from(QUEUE_TABLE).insert({
          gmail_message_id: messageId,
          status: "queued",
          ...patch,
          created_at: now,
        } as never);
        if (ins.error) {
          errors.push(`${messageId}:${ins.error.message ?? "insert failed"}`);
        } else {
          upserted += 1;
        }
      } else {
        const upd = await supabase.client
          .from(QUEUE_TABLE)
          .update(patch as never)
          .eq("id", row.id);
        if (upd.error) {
          errors.push(`${messageId}:${upd.error.message ?? "update failed"}`);
        } else {
          upserted += 1;
        }
      }
    } catch (e) {
      errors.push(`${messageId}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { upserted, listedCount, errors };
}

async function claimNextQueuedRow(
  supabase: SupabaseAdminBundle,
): Promise<GmailQueueRow | null> {
  const pending = (await supabase.client
    .from(QUEUE_TABLE)
    .select("*")
    .eq("status", "queued")
    .order("internal_date_ms", { ascending: true, nullsFirst: false })
    .limit(1)) as { data: GmailQueueRow[] | null; error: { message?: string } | null };

  if (pending.error || !pending.data?.[0]) {
    return null;
  }
  const candidate = pending.data[0];
  const now = new Date().toISOString();
  const claimed = (await supabase.client
    .from(QUEUE_TABLE)
    .update({
      status: "processing",
      processing_started_at: now,
      updated_at: now,
    } as never)
    .eq("id", candidate.id)
    .eq("status", "queued")
    .select("*")) as { data: GmailQueueRow[] | null; error: { message?: string } | null };

  if (claimed.error || !claimed.data?.[0]) {
    return null;
  }
  return claimed.data[0];
}

async function hasActiveProcessing(
  supabase: SupabaseAdminBundle,
): Promise<boolean> {
  const r = (await supabase.client
    .from(QUEUE_TABLE)
    .select("id")
    .eq("status", "processing")
    .limit(1)) as { data: unknown[] | null };
  return Array.isArray(r.data) && r.data.length > 0;
}

async function finalizeQueueRow(
  supabase: SupabaseAdminBundle,
  rowId: string,
  patch: Record<string, unknown>,
) {
  await supabase.client
    .from(QUEUE_TABLE)
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", rowId);
}

/**
 * Sync Unprocessed → Supabase queue, then ingest at most one queued message (sequential pipeline).
 */
export async function runEmailIntakePoll(
  supabase: SupabaseAdminBundle,
): Promise<EmailPollResult> {
  const result: EmailPollResult = {
    scanned: 0,
    processed: 0,
    skipped: 0,
    errors: [],
    details: [],
  };

  const gmail = getGmailClientOrNull();
  if (!gmail) {
    result.errors.push("GMAIL_NOT_CONFIGURED");
    return result;
  }

  const userId = process.env.GMAIL_INTAKE_USER_ID?.trim() || "me";
  const unprocessedName =
    process.env.GMAIL_INTAKE_LABEL_UNPROCESSED?.trim() || "Unprocessed";
  const processedName =
    process.env.GMAIL_INTAKE_LABEL_PROCESSED?.trim() || "Processed";

  const unprocessedId = await getOrCreateLabelId(
    gmail,
    userId,
    unprocessedName,
  );
  const processedId = await getOrCreateLabelId(gmail, userId, processedName);

  if (!unprocessedId) {
    result.errors.push(`LABEL_MISSING_OR_CREATE_FAILED:${unprocessedName}`);
    return result;
  }

  await resetStaleProcessing(supabase);

  const sync = await syncGmailUnprocessedToQueue(
    supabase,
    gmail,
    userId,
    unprocessedId,
  );
  result.errors.push(...sync.errors);
  result.scanned = sync.listedCount;

  if (await hasActiveProcessing(supabase)) {
    result.details.push({
      messageId: "_queue",
      outcome: "skip_already_processing",
    });
    return result;
  }

  const row = await claimNextQueuedRow(supabase);
  if (!row) {
    return result;
  }

  const intake = await processSingleGmailMessage(
    supabase,
    gmail,
    userId,
    unprocessedId,
    processedId,
    row.gmail_message_id,
  );

  result.processed += intake.processed;
  result.skipped += intake.skipped;
  result.errors.push(...intake.errors);
  result.details.push(...intake.details);

  const errSummary =
    intake.errors.length > 0 ? intake.errors.join("; ") : null;

  if (intake.details.some((d) => d.outcome === "no_supported_attachment")) {
    await finalizeQueueRow(supabase, row.id, {
      status: "skipped",
      error_message: "no_supported_attachment",
      processing_started_at: null,
    });
    return result;
  }

  if (intake.errors.length > 0 || !intake.movedGmailLabel) {
    await finalizeQueueRow(supabase, row.id, {
      status: "failed",
      error_message: errSummary ?? "intake_incomplete",
      processing_started_at: null,
    });
    return result;
  }

  await finalizeQueueRow(supabase, row.id, {
    status: "ingested",
    error_message: null,
    ingested_at: new Date().toISOString(),
    processing_started_at: null,
  });

  return result;
}
