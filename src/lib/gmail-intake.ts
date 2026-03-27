import { getGmailClientOrNull } from "@/lib/gmail-client";
import { processIntakeDocument } from "@/lib/intake-process";
import { parseMridDridFromSubject } from "@/lib/mail-subject";
import { splitPdfIntoLogicalSections } from "@/lib/pdf-split";
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

type GmailClient = NonNullable<ReturnType<typeof getGmailClientOrNull>>;

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
async function getOrCreateLabelId(
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

async function insertAuditLog(
  supabase: SupabaseAdminBundle,
  row: Record<string, unknown>,
) {
  // Supabase client is untyped in this repo; cast for safe runtime insert.
  return supabase.client.from("audit_logs" as never).insert(row as never);
}

/**
 * Poll Gmail for messages in the Unprocessed label, ingest first PDF/image attachment, move to Processed.
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

  const maxRaw = process.env.GMAIL_POLL_MAX_MESSAGES;
  const maxMessages = maxRaw ? Number.parseInt(maxRaw, 10) : 10;
  const limit =
    Number.isFinite(maxMessages) && maxMessages > 0 ? maxMessages : 10;

  const list = await gmail.users.messages.list({
    userId,
    labelIds: [unprocessedId],
    maxResults: limit,
  });

  const messageRefs = list.data.messages ?? [];
  result.scanned = messageRefs.length;

  for (const ref of messageRefs) {
    const messageId = ref.id;
    if (!messageId) continue;

    try {
      const full = await gmail.users.messages.get({
        userId,
        id: messageId,
        format: "full",
      });

      const payload = full.data.payload;
      const subject = getSubject(payload) ?? "";
      const { mrid: subjectMrid, drid: subjectDrid } =
        parseMridDridFromSubject(subject);

      const flat: GmailMessagePart[] = [];
      flattenParts(payload, flat);
      const parts = pickAttachmentParts(flat);
      if (parts.length === 0) {
        result.skipped += 1;
        result.details.push({ messageId, outcome: "no_supported_attachment" });
        continue;
      }

      let hadAttachmentErrors = false;

      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        const downloaded = await downloadPartBody(
          gmail,
          userId,
          messageId,
          part,
        );
        const itemLabel = part.filename ?? `attachment_${i + 1}`;
        if (!downloaded) {
          hadAttachmentErrors = true;
          result.skipped += 1;
          result.details.push({
            messageId,
            outcome: "attachment_decode_failed",
            item: itemLabel,
          });
          continue;
        }

        const splitParentRef = `${messageId}:${itemLabel}`;
        let splitCandidate: Awaited<
          ReturnType<typeof splitPdfIntoLogicalSections>
        > | null = null;
        if (downloaded.mime === "application/pdf") {
          try {
            splitCandidate = await splitPdfIntoLogicalSections(
              downloaded.buffer,
            );
          } catch {
            splitCandidate = {
              chunks: [],
              method: "single",
              confidence: 0,
              suspectedMultiInvoice: false,
              reason: "split_unexpected_error",
            };
          }
        }
        const chunks =
          splitCandidate && splitCandidate.chunks.length > 1
            ? splitCandidate.chunks
            : null;

        if (chunks && chunks.length > 1) {
          const splitMethod = splitCandidate?.method ?? "anthropic";
          await insertAuditLog(supabase, {
            entity_type: "mail_item",
            entity_id: messageId,
            action: "AI_SPLIT_DETECTED",
            actor: "AIMA",
            metadata: {
              messageId,
              sourceFile: downloaded.filename,
              segmentCount: chunks.length,
              method: splitMethod,
              confidence: splitCandidate?.confidence ?? 0,
              model: splitCandidate?.model ?? null,
            },
          });

          for (const chunk of chunks) {
            const chunkName = `${downloaded.filename.replace(/\.pdf$/i, "")}.part-${chunk.index}.pdf`;
            const intake = await processIntakeDocument({
              supabase,
              buffer: chunk.buffer,
              contentType: "application/pdf",
              fileName: chunkName,
              source: "email_intake",
              gmailMessageId: messageId,
              subjectMrid,
              subjectDrid,
              envelopeCondition: "sealed",
              split: {
                parentRef: splitParentRef,
                index: chunk.index,
                total: chunk.total,
                method: splitMethod,
                confidence: chunk.confidence,
                suspectedMultiInvoice: splitCandidate?.suspectedMultiInvoice,
                sectionType: chunk.sectionType,
                reason: chunk.reason,
                model: splitCandidate?.model ?? null,
              },
            });

            if (!intake.ok) {
              hadAttachmentErrors = true;
              result.errors.push(
                `${messageId}:${chunkName}:${JSON.stringify(intake.body)}`,
              );
              result.details.push({
                messageId,
                item: chunkName,
                outcome: `intake_failed_${intake.status}`,
              });
              continue;
            }

            await insertAuditLog(supabase, {
              entity_type: "document",
              entity_id: intake.body.documentId,
              action: "AI_SPLIT_SEGMENT_INGESTED",
              actor: "AIMA",
              metadata: {
                messageId,
                sourceFile: downloaded.filename,
                chunkIndex: chunk.index,
                chunkTotal: chunk.total,
                pageStart: chunk.pageStart,
                pageEnd: chunk.pageEnd,
                method: splitMethod,
                sectionType: chunk.sectionType,
                confidence: chunk.confidence,
                reason: chunk.reason,
                model: splitCandidate?.model ?? null,
              },
            });

            result.processed += 1;
            result.details.push({
              messageId,
              item: chunkName,
              outcome: "ok_ai_split_chunk",
            });
          }
          continue;
        }

        const intake = await processIntakeDocument({
          supabase,
          buffer: downloaded.buffer,
          contentType: downloaded.mime,
          fileName: downloaded.filename,
          source: "email_intake",
          gmailMessageId: messageId,
          subjectMrid,
          subjectDrid,
          envelopeCondition: "sealed",
          split: splitCandidate
            ? {
                parentRef: splitParentRef,
                index: 1,
                total: 1,
                method: splitCandidate.method,
                confidence: splitCandidate.confidence,
                suspectedMultiInvoice: splitCandidate.suspectedMultiInvoice,
                reason: splitCandidate.reason,
                sectionType: "other",
                model: splitCandidate.model ?? null,
              }
            : undefined,
        });

        if (!intake.ok) {
          hadAttachmentErrors = true;
          result.errors.push(`${messageId}:${JSON.stringify(intake.body)}`);
          result.details.push({
            messageId,
            item: itemLabel,
            outcome: `intake_failed_${intake.status}`,
          });
          continue;
        }

        if (splitCandidate?.suspectedMultiInvoice) {
          await insertAuditLog(supabase, {
            entity_type: "document",
            entity_id: intake.body.documentId,
            action: "AI_SPLIT_FALLBACK_SINGLE",
            actor: "AIMA",
            metadata: {
              messageId,
              sourceFile: downloaded.filename,
              reason: splitCandidate.reason ?? "fallback_single",
              confidence: splitCandidate.confidence,
              model: splitCandidate.model ?? null,
            },
          });
        }
        if (
          splitCandidate?.method === "single" &&
          splitCandidate?.reason?.startsWith("split_parse_failed:")
        ) {
          result.details.push({
            messageId,
            item: itemLabel,
            outcome: "split_parse_failed_fallback_single",
          });
        }

        result.processed += 1;
        const wasDuplicate =
          intake.ok &&
          typeof intake.body === "object" &&
          intake.body !== null &&
          "flags" in intake.body &&
          typeof (intake.body as { flags?: { isDuplicate?: boolean } }).flags
            ?.isDuplicate === "boolean" &&
          (intake.body as { flags?: { isDuplicate?: boolean } }).flags
            ?.isDuplicate === true;
        result.details.push({
          messageId,
          item: itemLabel,
          outcome: wasDuplicate ? "ok_duplicate" : "ok",
        });
      }

      if (hadAttachmentErrors) {
        continue;
      }

      if (processedId) {
        await gmail.users.messages.modify({
          userId,
          id: messageId,
          requestBody: {
            removeLabelIds: [unprocessedId],
            addLabelIds: [processedId],
          },
        });
      } else {
        await gmail.users.messages.modify({
          userId,
          id: messageId,
          requestBody: {
            removeLabelIds: [unprocessedId],
          },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${messageId}:${msg}`);
      result.details.push({ messageId, outcome: "exception" });
    }
  }

  return result;
}
