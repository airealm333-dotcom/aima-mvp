import { getGmailClientOrNull } from "@/lib/gmail-client";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";

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

export type GmailIntakeClient = NonNullable<
  ReturnType<typeof getGmailClientOrNull>
>;
type GmailClient = GmailIntakeClient;

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function normalizeMime(mime?: string | null) {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

function decodeGmailBase64(data: string): Buffer {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
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

function getSubject(payload: GmailMessagePart | undefined): string | null {
  const headers = payload?.headers;
  if (!headers) return null;
  const h = headers.find((x) => (x.name ?? "").toLowerCase() === "subject");
  return h?.value ?? null;
}

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

function pickAttachmentParts(parts: GmailMessagePart[]): GmailMessagePart[] {
  const scored: { part: GmailMessagePart; score: number }[] = [];
  for (const p of parts) {
    const score = scoreAttachmentPart(p);
    if (score > 0) scored.push({ part: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.part);
}

async function downloadPartBody(
  gmail: GmailClient,
  userId: string,
  messageId: string,
  part: GmailMessagePart,
): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  const mime = normalizeMime(part.mimeType);
  const filename =
    part.filename || `attachment.${mime === "application/pdf" ? "pdf" : "bin"}`;

  if (part.body?.data) {
    if (!ALLOWED_MIME.has(mime) && !/\.(pdf|png|jpe?g|webp)$/i.test(filename)) {
      return null;
    }
    return {
      buffer: decodeGmailBase64(part.body.data),
      mime: ALLOWED_MIME.has(mime) ? mime : "application/pdf",
      filename,
    };
  }

  const attachmentId = part.body?.attachmentId;
  if (!attachmentId) return null;

  const att = await gmail.users.messages.attachments.get({
    userId,
    id: attachmentId,
    messageId,
  });
  const raw = att.data.data;
  if (!raw) return null;

  let effectiveMime = mime;
  if (!ALLOWED_MIME.has(effectiveMime)) {
    if (filename.toLowerCase().endsWith(".pdf"))
      effectiveMime = "application/pdf";
    else if (filename.toLowerCase().endsWith(".png"))
      effectiveMime = "image/png";
    else if (/\.(jpe?g)$/i.test(filename)) effectiveMime = "image/jpeg";
    else if (filename.toLowerCase().endsWith(".webp"))
      effectiveMime = "image/webp";
    else return null;
  }

  return {
    buffer: decodeGmailBase64(raw),
    mime: effectiveMime,
    filename,
  };
}

async function resolveLabelId(
  gmail: GmailClient,
  userId: string,
  labelName: string,
): Promise<string | null> {
  const res = await gmail.users.labels.list({ userId });
  const wanted = labelName.trim().toLowerCase();
  const labels = res.data.labels ?? [];
  const found = labels.find((l) => (l.name ?? "").toLowerCase() === wanted);
  return found?.id ?? null;
}

/** Create user label if missing (SOP Unprocessed/Processed setup without manual Gmail UI). */
export async function getOrCreateLabelId(
  gmail: GmailClient,
  userId: string,
  labelName: string,
): Promise<string | null> {
  const existing = await resolveLabelId(gmail, userId, labelName);
  if (existing) return existing;
  try {
    const created = await gmail.users.labels.create({
      userId,
      requestBody: {
        name: labelName.trim(),
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    return created.data.id ?? null;
  } catch {
    return null;
  }
}

export type EmailPollResult = {
  scanned: number;
  processed: number;
  skipped: number;
  errors: string[];
  details: Array<{ messageId: string; outcome: string; item?: string }>;
};

async function createMinimalDocument(
  supabase: SupabaseAdminBundle,
  buffer: Buffer,
  fileName: string,
): Promise<string | null> {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const random = Math.random().toString(36).slice(2, 10).toUpperCase();
  const drid = `ROSDOC${yyyy}${mm}${dd}${random}`;
  const storagePath = `${yyyy}/${mm}/${drid}.pdf`;

  const blob = new Blob([new Uint8Array(buffer)], { type: "application/pdf" });
  const upload = await supabase.client.storage
    .from(supabase.storageBucket)
    .upload(storagePath, blob, { contentType: "application/pdf", upsert: false });

  if (upload.error) {
    console.error(`[gmail-intake] storage upload failed:`, upload.error.message, (upload.error as unknown as { cause?: unknown }).cause ?? "");
    return null;
  }

  const insert = await supabase.client
    .from("documents")
    .insert({
      drid,
      status: "received",
      file_path: storagePath,
      created_at: now.toISOString(),
    } as never)
    .select("id")
    .single();

  if (insert.error) {
    console.error(`[gmail-intake] document insert failed: ${insert.error.message}`);
    return null;
  }

  console.log(`[gmail-intake] created document ${drid} → ${(insert.data as { id: string }).id}`);
  return (insert.data as { id: string }).id;
}

async function insertAuditLog(
  supabase: SupabaseAdminBundle,
  row: Record<string, unknown>,
) {
  // Supabase client is untyped in this repo; cast for safe runtime insert.
  return supabase.client.from("audit_logs" as never).insert(row as never);
}

export type SingleGmailIntakeResult = {
  processed: number;
  skipped: number;
  errors: string[];
  details: Array<{ messageId: string; outcome: string; item?: string }>;
  /** True when all attachments succeeded and Gmail Unprocessed label was removed. */
  movedGmailLabel: boolean;
  /** IDs of documents successfully created during intake. */
  documentIds: string[];
};

/**
 * Ingest every supported attachment for one Gmail message (split PDFs, intake, optional label move).
 */
export async function processSingleGmailMessage(
  supabase: SupabaseAdminBundle,
  gmail: GmailIntakeClient,
  userId: string,
  processedId: string | null,
  messageId: string,
): Promise<SingleGmailIntakeResult> {
  const result: SingleGmailIntakeResult = {
    processed: 0,
    skipped: 0,
    errors: [],
    details: [],
    movedGmailLabel: false,
    documentIds: [],
  };

  try {
    const full = await gmail.users.messages.get({
      userId,
      id: messageId,
      format: "full",
    });

    const flat: GmailMessagePart[] = [];
    flattenParts(full.data.payload, flat);
    const parts = pickAttachmentParts(flat);

    if (parts.length === 0) {
      result.skipped += 1;
      result.details.push({ messageId, outcome: "no_supported_attachment" });
      return result;
    }

    // Take only the best PDF attachment (highest scored)
    const bestPart = parts[0];
    const downloaded = await downloadPartBody(gmail, userId, messageId, bestPart);
    const itemLabel = bestPart.filename ?? "attachment.pdf";

    if (!downloaded) {
      result.errors.push(`${messageId}:attachment_decode_failed`);
      result.details.push({ messageId, item: itemLabel, outcome: "attachment_decode_failed" });
      return result;
    }

    if (!downloaded.mime.includes("pdf") && !downloaded.filename.toLowerCase().endsWith(".pdf")) {
      result.skipped += 1;
      result.details.push({ messageId, item: itemLabel, outcome: "not_a_pdf" });
      return result;
    }

    // Upload raw PDF + create minimal document row — OCR→Clients pipeline handles the rest
    const docId = await createMinimalDocument(supabase, downloaded.buffer, downloaded.filename);
    if (!docId) {
      result.errors.push(`${messageId}:document_create_failed`);
      result.details.push({ messageId, item: itemLabel, outcome: "document_create_failed" });
      return result;
    }

    result.processed += 1;
    result.documentIds.push(docId);
    result.details.push({ messageId, item: itemLabel, outcome: "ok" });

    // Archive the email (remove from INBOX); optionally add a "Processed" label
    result.movedGmailLabel = true;
    await gmail.users.messages.modify({
      userId,
      id: messageId,
      requestBody: {
        removeLabelIds: ["INBOX"],
        ...(processedId ? { addLabelIds: [processedId] } : {}),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`${messageId}:${msg}`);
    result.details.push({ messageId, outcome: "exception" });
  }

  return result;
}

/** Download the highest-priority supported attachment (same ordering as intake). */
export async function downloadFirstSupportedAttachment(
  gmail: GmailIntakeClient,
  userId: string,
  messageId: string,
): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  const full = await gmail.users.messages.get({
    userId,
    id: messageId,
    format: "full",
  });
  const payload = full.data.payload;
  const flat: GmailMessagePart[] = [];
  flattenParts(payload, flat);
  const parts = pickAttachmentParts(flat);
  if (parts.length === 0) return null;
  return downloadPartBody(gmail, userId, messageId, parts[0]);
}
