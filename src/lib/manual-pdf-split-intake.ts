import { createHash } from "node:crypto";
import {
  processIntakeDocument,
  type ProcessIntakeSuccessBody,
} from "@/lib/intake-process";
import { splitPdfIntoLogicalSections } from "@/lib/pdf-split";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";

function normalizeContentType(contentType: string) {
  return contentType.split(";")[0]?.trim().toLowerCase() || "";
}

function manualPdfSplitEnabled(): boolean {
  return process.env.MANUAL_UPLOAD_PDF_SPLIT?.trim() !== "false";
}

async function insertAuditLog(
  supabase: SupabaseAdminBundle,
  row: Record<string, unknown>,
) {
  return supabase.client.from("audit_logs" as never).insert(row as never);
}

export type ManualIntakeSuccess =
  | { split: false; body: ProcessIntakeSuccessBody }
  | {
      split: true;
      sourceFileName: string;
      documents: ProcessIntakeSuccessBody[];
      errors: Array<{ chunkIndex: number; status: number; detail: string }>;
    };

export type ManualIntakeOutcome =
  | { ok: true; response: ManualIntakeSuccess }
  | { ok: false; status: number; body: Record<string, unknown> };

type BaseManualFields = {
  supabase: SupabaseAdminBundle;
  buffer: Buffer;
  contentType: string;
  fileName: string;
  sender: string | null;
  addressee: string | null;
  mieName: string | null;
  envelopeCondition: string;
  requestedMailSequence: number;
  requestedDocSequence: number;
};

/**
 * Manual web upload: optional PDF split (same pipeline as Gmail), then one processIntakeDocument per segment.
 */
export async function runManualIntakeWithOptionalPdfSplit(
  input: BaseManualFields,
): Promise<ManualIntakeOutcome> {
  const normalizedType = normalizeContentType(input.contentType);
  const base = {
    supabase: input.supabase,
    sender: input.sender,
    addressee: input.addressee,
    mieName: input.mieName,
    envelopeCondition: input.envelopeCondition,
    requestedMailSequence: input.requestedMailSequence,
    requestedDocSequence: input.requestedDocSequence,
    source: "manual_upload" as const,
    gmailMessageId: null as string | null,
  };

  if (normalizedType !== "application/pdf" || !manualPdfSplitEnabled()) {
    const result = await processIntakeDocument({
      ...base,
      buffer: input.buffer,
      contentType: input.contentType,
      fileName: input.fileName,
    });
    if (!result.ok) {
      return { ok: false, status: result.status, body: result.body };
    }
    return { ok: true, response: { split: false, body: result.body } };
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const splitParentRef = `manual:${sha256.slice(0, 16)}:${input.fileName.slice(0, 120)}`;

  let splitCandidate: Awaited<
    ReturnType<typeof splitPdfIntoLogicalSections>
  > | null = null;
  try {
    splitCandidate = await splitPdfIntoLogicalSections(input.buffer);
  } catch {
    splitCandidate = {
      chunks: [],
      method: "single",
      confidence: 0,
      suspectedMultiInvoice: false,
      reason: "split_unexpected_error",
    };
  }

  const chunks =
    splitCandidate && splitCandidate.chunks.length > 1
      ? splitCandidate.chunks
      : null;

  if (chunks && chunks.length > 1) {
    await insertAuditLog(input.supabase, {
      entity_type: "mail_item",
      entity_id: splitParentRef,
      action: "AI_SPLIT_DETECTED",
      actor: "AIMA",
      metadata: {
        source: "manual_upload",
        sourceFile: input.fileName,
        segmentCount: chunks.length,
        method: splitCandidate?.method ?? "anthropic",
        confidence: splitCandidate?.confidence ?? 0,
        model: splitCandidate?.model ?? null,
      },
    });

    const splitMethod = splitCandidate?.method ?? "anthropic";
    const documents: ProcessIntakeSuccessBody[] = [];
    const errors: Array<{
      chunkIndex: number;
      status: number;
      detail: string;
    }> = [];

    for (const chunk of chunks) {
      const chunkName = `${input.fileName.replace(/\.pdf$/i, "")}.part-${chunk.index}.pdf`;
      const intake = await processIntakeDocument({
        ...base,
        buffer: chunk.buffer,
        contentType: "application/pdf",
        fileName: chunkName,
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
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        },
      });

      if (!intake.ok) {
        errors.push({
          chunkIndex: chunk.index,
          status: intake.status,
          detail: JSON.stringify(intake.body),
        });
        continue;
      }

      await insertAuditLog(input.supabase, {
        entity_type: "document",
        entity_id: intake.body.documentId,
        action: "AI_SPLIT_SEGMENT_INGESTED",
        actor: "AIMA",
        metadata: {
          source: "manual_upload",
          sourceFile: input.fileName,
          parentRef: splitParentRef,
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

      documents.push(intake.body);
    }

    if (documents.length === 0) {
      const first = errors[0];
      return {
        ok: false,
        status: first?.status ?? 500,
        body: {
          error: "MANUAL_SPLIT_ALL_SEGMENTS_FAILED",
          detail: first?.detail ?? "No segments ingested.",
          errors,
        },
      };
    }

    return {
      ok: true,
      response: {
        split: true,
        sourceFileName: input.fileName,
        documents,
        errors,
      },
    };
  }

  const intake = await processIntakeDocument({
    ...base,
    buffer: input.buffer,
    contentType: input.contentType,
    fileName: input.fileName,
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
    return { ok: false, status: intake.status, body: intake.body };
  }

  if (splitCandidate?.suspectedMultiInvoice) {
    await insertAuditLog(input.supabase, {
      entity_type: "document",
      entity_id: intake.body.documentId,
      action: "AI_SPLIT_FALLBACK_SINGLE",
      actor: "AIMA",
      metadata: {
        source: "manual_upload",
        sourceFile: input.fileName,
        reason: splitCandidate.reason ?? "fallback_single",
        confidence: splitCandidate.confidence,
        model: splitCandidate.model ?? null,
      },
    });
  }

  return { ok: true, response: { split: false, body: intake.body } };
}
