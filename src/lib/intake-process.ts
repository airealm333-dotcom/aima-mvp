import { createHash } from "node:crypto";
import {
  type ClassificationLabel,
  classifyDocumentFromOcr,
} from "@/lib/document-classify";
import {
  extractDocumentEntitiesFromOcrText,
  type ExtractedEntitiesResult,
} from "@/lib/document-entities";
import { buildDrid, buildMrid } from "@/lib/mail-id";
import type { OcrResult } from "@/lib/ocr";
import { extractPdfText } from "@/lib/ocr";
import type { SupabaseAdminBundle } from "@/lib/supabase-admin";

const OCR_MIN_TEXT_LENGTH = 30;

/** Flattened for manual-upload testing panel (client = individual, company = counterpart). */
export type IntakeEntitySummary = {
  client_name: string | null;
  company_name: string | null;
  claimant_email: string | null;
  respondent_email: string | null;
};

function buildEntitySummaryFromExtracted(
  extracted: ExtractedEntitiesResult,
): IntakeEntitySummary {
  const legal = extracted.legal;
  const universal = extracted.universal;
  const invoice = extracted.invoice;
  return {
    client_name:
      legal?.claimant_name?.value ??
      universal?.sender?.value ??
      invoice?.buyer_name?.value ??
      null,
    company_name:
      legal?.respondent_name?.value ??
      invoice?.vendor_name?.value ??
      universal?.addressee?.value ??
      null,
    claimant_email: legal?.claimant_email?.value ?? null,
    respondent_email: legal?.respondent_email?.value ?? null,
  };
}

function buildEntitySummaryFromDbRows(
  rows: Array<Record<string, unknown>>,
): IntakeEntitySummary {
  const legal = rows.find((r) => r.entity_type === "legal_core");
  const universal = rows.find((r) => r.entity_type === "universal_minimal");
  const invoice = rows.find((r) => r.entity_type === "invoice_core");
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    client_name:
      s(legal?.claimant_name) ??
      s(universal?.sender) ??
      s(invoice?.buyer_name) ??
      null,
    company_name:
      s(legal?.respondent_name) ??
      s(invoice?.vendor_name) ??
      s(universal?.addressee) ??
      null,
    claimant_email: s(legal?.claimant_email),
    respondent_email: s(legal?.respondent_email),
  };
}
type LooseSupabaseClient = {
  // biome-ignore lint/suspicious/noExplicitAny: Supabase client is untyped; table queries need a loose chain.
  from: (table: string) => any;
  storage: {
    from: (bucket: string) => {
      upload: (...args: unknown[]) => Promise<{
        data: { path?: string } | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

function asLooseClient(
  client: SupabaseAdminBundle["client"],
): LooseSupabaseClient {
  return client as unknown as LooseSupabaseClient;
}

const ALLOWED_FILE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type IntakeSource = "manual_upload" | "email_intake";

export type ProcessIntakeInput = {
  supabase: SupabaseAdminBundle;
  buffer: Buffer;
  /** Raw browser/server MIME, may include charset */
  contentType: string;
  fileName: string;
  source: IntakeSource;
  gmailMessageId?: string | null;
  /** When both present, first attempt uses these IDs (SOP email subject). */
  subjectMrid?: string | null;
  subjectDrid?: string | null;
  sender?: string | null;
  addressee?: string | null;
  mieName?: string | null;
  envelopeCondition?: string;
  /** Manual form only: 0 = auto */
  requestedMailSequence?: number;
  requestedDocSequence?: number;
  split?: {
    parentRef?: string | null;
    index?: number | null;
    total?: number | null;
    method?: string | null;
    confidence?: number | null;
    suspectedMultiInvoice?: boolean;
    sectionType?: string | null;
    reason?: string | null;
    model?: string | null;
  };
};

export type ProcessIntakeSuccessBody = {
  mrid: string;
  drid: string;
  mailItemId: string;
  documentId: string;
  status: { mailItem: string; document: string };
  flags: { lowTextCoverage: boolean; isDuplicate?: boolean };
  file: { name: string; size: number; sha256: string; path: string };
  ocr?: OcrResult;
  classification?: {
    label: string;
    confidence: number;
    method: string;
    rationale: string;
  };
  duplicate?: {
    duplicateOfDocumentId: string;
    duplicateOfDrid?: string | null;
    reason: string;
  };
  entitySummary?: IntakeEntitySummary | null;
};

export type ProcessIntakeResult =
  | { ok: true; status: 200; body: ProcessIntakeSuccessBody }
  | { ok: false; status: number; body: Record<string, unknown> };

function normalizeContentType(contentType: string) {
  return contentType.split(";")[0]?.trim().toLowerCase() || "";
}

function extensionFromType(contentType: string) {
  switch (contentType) {
    case "application/pdf":
      return "pdf";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function formatUtcDateToken(now: Date) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function isDuplicateLikeError(error: { message?: string } | null | undefined) {
  const message = (error?.message ?? "").toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("duplicate key") ||
    message.includes("unique constraint") ||
    message.includes("violates unique")
  );
}

type CanonicalDocument = {
  id: string;
  drid: string | null;
  classification_label: string | null;
  classification_confidence: number | null;
  classification_method: string | null;
  classification_rationale: string | null;
  status: string | null;
};

function shouldRequireD3Review(input: {
  label: ClassificationLabel | string | null | undefined;
  confidence: number | null | undefined;
  isDuplicate: boolean;
  hasOpenException: boolean;
}) {
  if (input.isDuplicate) return true;
  if (input.hasOpenException) return true;
  if ((input.label ?? "UNKNOWN") === "UNKNOWN") return true;
  return (input.confidence ?? 0) < 90;
}

async function findCanonicalDocumentBySha(
  client: SupabaseAdminBundle["client"],
  sha256: string,
): Promise<CanonicalDocument | null> {
  const query = await asLooseClient(client)
    .from("documents")
    .select(
      "id, drid, classification_label, classification_confidence, classification_method, classification_rationale, status, is_duplicate, created_at",
    )
    .eq("sha256_hash", sha256)
    .order("is_duplicate", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (query.error || !query.data) return null;
  return query.data as CanonicalDocument;
}

async function getNextMailSequence(
  client: SupabaseAdminBundle["client"],
  now: Date,
) {
  const db = asLooseClient(client);
  const dateToken = formatUtcDateToken(now);
  const prefix = `ROSMAIL${dateToken}`;
  const query = await db
    .from("mail_items")
    .select("mrid")
    .like("mrid", `${prefix}%`)
    .order("mrid", { ascending: false })
    .limit(1);

  if (query.error) return 1;
  const latestMrid = query.data?.[0]?.mrid as string | undefined;
  if (!latestMrid) return 1;
  const suffix = latestMrid.slice(-3);
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed + 1;
}

async function getNextDocSequence(
  client: SupabaseAdminBundle["client"],
  now: Date,
  mrid: string,
) {
  const db = asLooseClient(client);
  const dateToken = formatUtcDateToken(now);
  const prefix = `ROSDOC${dateToken}${mrid}`;
  const query = await db
    .from("documents")
    .select("drid")
    .like("drid", `${prefix}%`)
    .order("drid", { ascending: false })
    .limit(1);

  if (query.error) return 1;
  const latestDrid = query.data?.[0]?.drid as string | undefined;
  if (!latestDrid) return 1;
  const suffix = latestDrid.slice(-2);
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed + 1;
}

/**
 * Shared intake: storage upload, DB rows, OCR, audit.
 */
export async function processIntakeDocument(
  input: ProcessIntakeInput,
): Promise<ProcessIntakeResult> {
  const {
    supabase,
    buffer,
    contentType: rawContentType,
    fileName,
    source,
    gmailMessageId = null,
    subjectMrid = null,
    subjectDrid = null,
    sender = null,
    addressee = null,
    mieName = null,
    envelopeCondition: envelopeConditionRaw,
    requestedMailSequence = 0,
    requestedDocSequence = 0,
    split,
  } = input;

  const normalizedType = normalizeContentType(rawContentType);
  if (!ALLOWED_FILE_TYPES.has(normalizedType)) {
    return {
      ok: false,
      status: 400,
      body: { error: "Only PDF, PNG, JPG, and WEBP files are accepted." },
    };
  }

  const envelopeCondition =
    (envelopeConditionRaw ?? "sealed").trim() || "sealed";
  const now = new Date();
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const fileExtension = extensionFromType(normalizedType);
  const db = asLooseClient(supabase.client);
  const canonicalDocument = await findCanonicalDocumentBySha(
    supabase.client,
    sha256,
  );

  let mrid = "";
  let drid = "";
  let storagePath = "";
  let mailItemId = "";
  let documentId = "";
  let duplicateAfterRetry = false;
  let isDuplicateDocument = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const useSubjectIds =
      attempt === 0 &&
      typeof subjectMrid === "string" &&
      subjectMrid.length > 0 &&
      typeof subjectDrid === "string" &&
      subjectDrid.length > 0;

    if (useSubjectIds) {
      mrid = subjectMrid as string;
      drid = subjectDrid as string;
    } else {
      const generatedMailSequence = await getNextMailSequence(
        supabase.client,
        now,
      );
      const mailSequence =
        attempt === 0 && requestedMailSequence > 0
          ? requestedMailSequence
          : generatedMailSequence;
      mrid = buildMrid(mailSequence, now);

      const generatedDocSequence = await getNextDocSequence(
        supabase.client,
        now,
        mrid,
      );
      const docSequence =
        attempt === 0 && requestedDocSequence > 0
          ? requestedDocSequence
          : generatedDocSequence;
      drid = buildDrid(mrid, docSequence, now);
    }

    storagePath = `${now.getUTCFullYear()}/${String(
      now.getUTCMonth() + 1,
    ).padStart(2, "0")}/${mrid}/${drid}.${fileExtension}`;

    const uploadResult = await db.storage
      .from(supabase.storageBucket)
      .upload(storagePath, buffer, {
        contentType: normalizedType,
        upsert: false,
      });

    if (uploadResult.error) {
      if (isDuplicateLikeError(uploadResult.error) && attempt === 0) {
        continue;
      }
      return {
        ok: false,
        status: 500,
        body: {
          error: "Failed to upload document to Supabase storage.",
          detail: uploadResult.error.message,
        },
      };
    }

    const mailInsert = await db
      .from("mail_items")
      .insert({
        mrid,
        received_at: now.toISOString(),
        sender,
        addressee,
        envelope_condition: envelopeCondition,
        mie_name: mieName,
        status: "MI5_INGESTED",
      })
      .select("id")
      .single();

    if (mailInsert.error) {
      if (isDuplicateLikeError(mailInsert.error) && attempt === 0) {
        continue;
      }
      if (isDuplicateLikeError(mailInsert.error) && attempt === 1) {
        duplicateAfterRetry = true;
        break;
      }
      return {
        ok: false,
        status: 500,
        body: {
          error: "Failed to write into 'mail_items'.",
          detail: mailInsert.error.message,
        },
      };
    }

    mailItemId = mailInsert.data.id;

    const documentInsert = await db
      .from("documents")
      .insert({
        drid,
        mail_item_id: mailItemId,
        gmail_message_id: gmailMessageId,
        file_path: storagePath,
        sha256_hash: sha256,
        status:
          canonicalDocument?.classification_label != null
            ? "D2_CLASSIFIED"
            : "D0_CREATED",
        is_duplicate: canonicalDocument != null,
        duplicate_of_document_id: canonicalDocument?.id ?? null,
        duplicate_reason: canonicalDocument ? "sha256_match" : null,
        classification_label: canonicalDocument?.classification_label ?? null,
        classification_confidence:
          canonicalDocument?.classification_confidence ?? null,
        classification_method: canonicalDocument?.classification_method ?? null,
        classification_rationale:
          canonicalDocument?.classification_rationale ?? null,
        review_required: canonicalDocument != null,
        review_status: canonicalDocument != null ? "pending" : null,
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        classification_label_original: null,
        split_parent_ref: split?.parentRef ?? null,
        split_index: split?.index ?? null,
        split_total: split?.total ?? null,
        split_method: split?.method ?? null,
        split_confidence: split?.confidence ?? null,
        multi_invoice_suspected: split?.suspectedMultiInvoice === true,
        split_section_type: split?.sectionType ?? null,
        split_reason: split?.reason ?? null,
        split_model: split?.model ?? null,
      })
      .select("id")
      .single();

    if (documentInsert.error) {
      if (isDuplicateLikeError(documentInsert.error) && attempt === 0) {
        continue;
      }
      if (isDuplicateLikeError(documentInsert.error) && attempt === 1) {
        duplicateAfterRetry = true;
        break;
      }
      return {
        ok: false,
        status: 500,
        body: {
          error: "Failed to write into 'documents'.",
          detail: documentInsert.error.message,
        },
      };
    }

    documentId = documentInsert.data.id;
    isDuplicateDocument = canonicalDocument != null;
    duplicateAfterRetry = false;
    break;
  }

  if (duplicateAfterRetry || !mailItemId || !documentId) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "SEQUENCE_CONFLICT_RETRY_EXHAUSTED",
        detail:
          "Could not allocate a unique MRID/DRID after retry. Please try again.",
      },
    };
  }

  const intakeAuditInsert = await db.from("audit_logs").insert({
    entity_type: "mail_item",
    entity_id: mailItemId,
    action: "INTAKE_INGESTED",
    actor: "AIMA",
    metadata: {
      mrid,
      source,
      fileName,
      storagePath,
      sha256,
      receivedAt: now.toISOString(),
      isDuplicate: isDuplicateDocument,
      ...(isDuplicateDocument
        ? {
            duplicateOfDocumentId: canonicalDocument?.id ?? null,
            duplicateReason: "sha256_match",
          }
        : {}),
      ...(gmailMessageId ? { gmailMessageId } : {}),
      ...(split?.method
        ? {
            split: {
              parentRef: split.parentRef ?? null,
              index: split.index ?? null,
              total: split.total ?? null,
              method: split.method,
              confidence: split.confidence ?? null,
              suspectedMultiInvoice: split.suspectedMultiInvoice === true,
              sectionType: split.sectionType ?? null,
              reason: split.reason ?? null,
              model: split.model ?? null,
            },
          }
        : {}),
    },
  });

  if (intakeAuditInsert.error) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to write intake audit log.",
        detail: intakeAuditInsert.error.message,
      },
    };
  }

  if (isDuplicateDocument && canonicalDocument) {
    const duplicateAuditInsert = await db.from("audit_logs").insert({
      entity_type: "document",
      entity_id: documentId,
      action: "DUPLICATE_DETECTED",
      actor: "AIMA",
      metadata: {
        drid,
        mrid,
        sha256,
        duplicateOfDocumentId: canonicalDocument.id,
        duplicateOfDrid: canonicalDocument.drid,
        reason: "sha256_match",
      },
    });

    if (duplicateAuditInsert.error) {
      return {
        ok: false,
        status: 500,
        body: {
          error: "Failed to write duplicate audit log.",
          detail: duplicateAuditInsert.error.message,
        },
      };
    }

    // Best-effort: copy extracted entities from canonical duplicate source.
    try {
      const canonicalEntities = await db
        .from("document_entities")
        .select(
          "entity_type, entities_json, confidence, method, sender, addressee, reference_number, document_type, document_date, invoice_number, invoice_date, due_date, currency, total_amount, tax_amount, vendor_name, buyer_name, case_number, notice_date, authority, deadline, reference_legal, claimant_name, respondent_name, claimant_email, respondent_email, respondent_contact_name, employment_start_date, employment_end_date, employment_status, occupation, basic_salary_monthly",
        )
        .eq("document_id", canonicalDocument.id);

      if (!canonicalEntities.error && canonicalEntities.data?.length) {
        const rowsToInsert = canonicalEntities.data.map(
          (row: Record<string, unknown>) => ({
            document_id: documentId,
            entity_type:
              (row.entity_type as string | null) ?? "universal_minimal",
            entities_json: row.entities_json ?? {},
            confidence: (row.confidence as number | null) ?? 0,
            method: (row.method as string | null) ?? "rules",
            sender: (row.sender as string | null) ?? null,
            addressee: (row.addressee as string | null) ?? null,
            reference_number: (row.reference_number as string | null) ?? null,
            document_date: (row.document_date as string | null) ?? null,
            document_type: (row.document_type as string | null) ?? null,
            invoice_number: (row.invoice_number as string | null) ?? null,
            invoice_date: (row.invoice_date as string | null) ?? null,
            due_date: (row.due_date as string | null) ?? null,
            currency: (row.currency as string | null) ?? null,
            total_amount: (row.total_amount as string | number | null) ?? null,
            tax_amount: (row.tax_amount as string | number | null) ?? null,
            vendor_name: (row.vendor_name as string | null) ?? null,
            buyer_name: (row.buyer_name as string | null) ?? null,
            case_number: (row.case_number as string | null) ?? null,
            notice_date: (row.notice_date as string | null) ?? null,
            authority: (row.authority as string | null) ?? null,
            deadline: (row.deadline as string | null) ?? null,
            reference_legal: (row.reference_legal as string | null) ?? null,
            claimant_name: (row.claimant_name as string | null) ?? null,
            respondent_name: (row.respondent_name as string | null) ?? null,
            claimant_email: (row.claimant_email as string | null) ?? null,
            respondent_email: (row.respondent_email as string | null) ?? null,
            respondent_contact_name:
              (row.respondent_contact_name as string | null) ?? null,
            employment_start_date:
              (row.employment_start_date as string | null) ?? null,
            employment_end_date:
              (row.employment_end_date as string | null) ?? null,
            employment_status:
              (row.employment_status as string | null) ?? null,
            occupation: (row.occupation as string | null) ?? null,
            basic_salary_monthly:
              (row.basic_salary_monthly as string | number | null) ?? null,
          }),
        );

        await db
          .from("document_entities")
          .upsert(rowsToInsert, { onConflict: "document_id,entity_type" });

        await db.from("audit_logs").insert({
          entity_type: "document",
          entity_id: documentId,
          action: "ENTITY_EXTRACTION_COPIED_FROM_CANONICAL",
          actor: "AIMA",
          metadata: {
            duplicateOfDocumentId: canonicalDocument.id,
            copiedEntityTypes: rowsToInsert.map(
              (r: { entity_type: string }) => r.entity_type,
            ),
          },
        });
      }
    } catch {
      // Non-fatal: missing table or query errors should not break intake.
    }

    let duplicateEntitySummary: IntakeEntitySummary | null = null;
    try {
      const ent = await db
        .from("document_entities")
        .select(
          "entity_type, claimant_name, respondent_name, claimant_email, respondent_email, sender, vendor_name, buyer_name, addressee",
        )
        .eq("document_id", documentId);
      if (!ent.error && ent.data?.length) {
        duplicateEntitySummary = buildEntitySummaryFromDbRows(
          ent.data as Array<Record<string, unknown>>,
        );
      }
    } catch {
      // Non-fatal
    }

    return {
      ok: true,
      status: 200,
      body: {
        mrid,
        drid,
        mailItemId,
        documentId,
        status: {
          mailItem: "MI5_INGESTED",
          document: "D3_REVIEW_PENDING",
        },
        flags: {
          lowTextCoverage: false,
          isDuplicate: true,
        },
        file: {
          name: fileName,
          size: buffer.length,
          sha256,
          path: storagePath,
        },
        classification:
          canonicalDocument.classification_label != null &&
          canonicalDocument.classification_confidence != null &&
          canonicalDocument.classification_method != null
            ? {
                label: canonicalDocument.classification_label,
                confidence: canonicalDocument.classification_confidence,
                method: canonicalDocument.classification_method,
                rationale:
                  canonicalDocument.classification_rationale ??
                  "Copied from canonical duplicate source.",
              }
            : undefined,
        duplicate: {
          duplicateOfDocumentId: canonicalDocument.id,
          duplicateOfDrid: canonicalDocument.drid,
          reason: "sha256_match",
        },
        entitySummary: duplicateEntitySummary,
      },
    };
  }

  let ocr: OcrResult;
  try {
    ocr = await extractPdfText(buffer, normalizedType);
  } catch (ocrError) {
    const detail =
      ocrError instanceof Error ? ocrError.message : "Unknown OCR error";

    await db
      .from("exceptions")
      .insert({
        drid,
        document_id: documentId,
        type: "E4_DOCUMENT_UNREADABLE",
        status: "open",
        root_cause: "OCR failed while parsing document",
        suggested_action: "Rescan the document and retry OCR.",
      })
      .select("id")
      .single();

    await db.from("audit_logs").insert({
      entity_type: "document",
      entity_id: documentId,
      action: "OCR_FAILED",
      actor: "AIMA",
      metadata: { drid, mrid, detail, fileName, sha256 },
    });

    return {
      ok: false,
      status: 422,
      body: {
        error: "OCR_FAILED",
        detail,
        mrid,
        drid,
        mailItemId,
        documentId,
      },
    };
  }

  const documentUpdate = await db
    .from("documents")
    .update({
      ocr_text: ocr.text,
      status: "D1_OCR_COMPLETED",
    })
    .eq("id", documentId)
    .select("id")
    .single();

  if (documentUpdate.error) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to write into 'documents'.",
        detail: documentUpdate.error.message,
      },
    };
  }

  const lowTextCoverage = ocr.textLength < OCR_MIN_TEXT_LENGTH;

  if (lowTextCoverage) {
    const exceptionInsert = await db
      .from("exceptions")
      .insert({
        drid,
        document_id: documentId,
        type: "E4_DOCUMENT_UNREADABLE",
        status: "open",
        root_cause: "OCR produced very low text coverage",
        suggested_action: "Rescan at higher quality or in color and retry.",
      })
      .select("id")
      .single();

    if (exceptionInsert.error) {
      return {
        ok: false,
        status: 500,
        body: {
          error: "Failed to write OCR exception into 'exceptions'.",
          detail: exceptionInsert.error.message,
        },
      };
    }
  }

  const auditInsert = await db.from("audit_logs").insert({
    entity_type: "document",
    entity_id: documentId,
    action: lowTextCoverage ? "OCR_COMPLETED_LOW_COVERAGE" : "OCR_COMPLETED",
    actor: "AIMA",
    metadata: {
      drid,
      mrid,
      sha256,
      pageCount: ocr.pageCount,
      textLength: ocr.textLength,
      lowTextCoverage,
      provider: ocr.provider,
    },
  });

  if (auditInsert.error) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to write into 'audit_logs'.",
        detail: auditInsert.error.message,
      },
    };
  }

  const classification = await classifyDocumentFromOcr(ocr.text);
  const reviewRequiredByRules = shouldRequireD3Review({
    label: classification.label,
    confidence: classification.confidence,
    isDuplicate: false,
    hasOpenException: lowTextCoverage,
  });
  const forceReviewForSplit = split?.suspectedMultiInvoice === true;
  const lowSplitConfidence =
    split?.method === "anthropic" && (split.confidence ?? 0) < 70;
  const reviewRequired =
    reviewRequiredByRules || forceReviewForSplit || lowSplitConfidence;
  const reviewNote = reviewRequired
    ? forceReviewForSplit
      ? "Requires D3 review: multi-invoice suspected from PDF split fallback."
      : lowSplitConfidence
        ? "Requires D3 review: low AI split confidence."
        : "Requires D3 review based on confidence/label/risk rules."
    : "Auto-approved by D3 rule.";

  const d2Update = await db
    .from("documents")
    .update({
      classification_label: classification.label,
      classification_confidence: Math.round(classification.confidence),
      classification_method: classification.method,
      classification_rationale: classification.rationale,
      review_required: reviewRequired,
      review_status: reviewRequired ? "pending" : "approved",
      reviewed_by: reviewRequired ? null : "SYSTEM",
      reviewed_at: reviewRequired ? null : new Date().toISOString(),
      review_note: reviewNote,
      status: reviewRequired ? "D3_REVIEW_PENDING" : "D3_APPROVED",
    })
    .eq("id", documentId)
    .select("id")
    .single();

  if (d2Update.error) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to write classification into 'documents'.",
        detail: d2Update.error.message,
      },
    };
  }

  const classificationAudit = await db.from("audit_logs").insert({
    entity_type: "document",
    entity_id: documentId,
    action: "CLASSIFICATION_COMPLETED",
    actor: "AIMA",
    metadata: {
      drid,
      mrid,
      label: classification.label,
      confidence: classification.confidence,
      method: classification.method,
    },
  });

  if (classificationAudit.error) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "Failed to write classification audit log.",
        detail: classificationAudit.error.message,
      },
    };
  }

  // D2.5 Entity extraction (best-effort, non-fatal).
  let entitySummary: IntakeEntitySummary | null = null;
  try {
    const extracted = extractDocumentEntitiesFromOcrText(
      ocr.text,
      classification.label,
    );

    entitySummary = buildEntitySummaryFromExtracted(extracted);

    const universalHasAnyFields =
      extracted.universal && Object.keys(extracted.universal).length > 0;

    const rowsToUpsert: Array<{
      document_id: string;
      entity_type: "universal_minimal" | "invoice_core" | "legal_core";
      entities_json: unknown;
      confidence: number;
      method: string;
      sender?: string | null;
      addressee?: string | null;
      reference_number?: string | null;
      document_date?: string | null;
      document_type?: string | null;
      invoice_number?: string | null;
      invoice_date?: string | null;
      due_date?: string | null;
      currency?: string | null;
      total_amount?: string | null;
      tax_amount?: string | null;
      vendor_name?: string | null;
      buyer_name?: string | null;
      case_number?: string | null;
      notice_date?: string | null;
      authority?: string | null;
      deadline?: string | null;
      reference_legal?: string | null;
      claimant_name?: string | null;
      respondent_name?: string | null;
      claimant_email?: string | null;
      respondent_email?: string | null;
      respondent_contact_name?: string | null;
      employment_start_date?: string | null;
      employment_end_date?: string | null;
      employment_status?: string | null;
      occupation?: string | null;
      basic_salary_monthly?: string | null;
    }> = [];

    if (universalHasAnyFields && extracted.universalConfidence > 0) {
      rowsToUpsert.push({
        document_id: documentId,
        entity_type: "universal_minimal",
        entities_json: extracted.universal,
        confidence: extracted.universalConfidence,
        method: "rules",
        sender: extracted.universal.sender?.value ?? null,
        addressee: extracted.universal.addressee?.value ?? null,
        reference_number: extracted.universal.reference_number?.value ?? null,
        document_date: extracted.universal.document_date?.value ?? null,
        document_type: extracted.universal.document_type?.value ?? null,
      });
    }

    if (
      extracted.invoice &&
      extracted.invoicePresent &&
      extracted.invoiceConfidence > 0
    ) {
      rowsToUpsert.push({
        document_id: documentId,
        entity_type: "invoice_core",
        entities_json: extracted.invoice,
        confidence: extracted.invoiceConfidence,
        method: "rules",
        invoice_number: extracted.invoice.invoice_number?.value ?? null,
        invoice_date: extracted.invoice.invoice_date?.value ?? null,
        due_date: extracted.invoice.due_date?.value ?? null,
        currency: extracted.invoice.currency?.value ?? null,
        total_amount: extracted.invoice.total_amount?.value ?? null,
        tax_amount: extracted.invoice.tax_amount?.value ?? null,
        vendor_name: extracted.invoice.vendor_name?.value ?? null,
        buyer_name: extracted.invoice.buyer_name?.value ?? null,
      });
    }
    if (
      extracted.legal &&
      extracted.legalPresent &&
      extracted.legalConfidence > 0
    ) {
      rowsToUpsert.push({
        document_id: documentId,
        entity_type: "legal_core",
        entities_json: extracted.legal,
        confidence: extracted.legalConfidence,
        method: "rules",
        case_number: extracted.legal.case_number?.value ?? null,
        notice_date: extracted.legal.notice_date?.value ?? null,
        authority: extracted.legal.authority?.value ?? null,
        deadline: extracted.legal.deadline?.value ?? null,
        reference_legal: extracted.legal.reference_legal?.value ?? null,
        claimant_name: extracted.legal.claimant_name?.value ?? null,
        respondent_name: extracted.legal.respondent_name?.value ?? null,
        claimant_email: extracted.legal.claimant_email?.value ?? null,
        respondent_email: extracted.legal.respondent_email?.value ?? null,
        respondent_contact_name:
          extracted.legal.respondent_contact_name?.value ?? null,
        employment_start_date:
          extracted.legal.employment_start_date?.value ?? null,
        employment_end_date:
          extracted.legal.employment_end_date?.value ?? null,
        employment_status: extracted.legal.employment_status?.value ?? null,
        occupation: extracted.legal.occupation?.value ?? null,
        basic_salary_monthly:
          extracted.legal.basic_salary_monthly?.value ?? null,
      });
    }

    if (rowsToUpsert.length > 0) {
      const entityUpsert = await db
        .from("document_entities")
        .upsert(rowsToUpsert, { onConflict: "document_id,entity_type" });

      if (entityUpsert.error) {
        await db.from("audit_logs").insert({
          entity_type: "document",
          entity_id: documentId,
          action: "ENTITY_EXTRACTION_FAILED",
          actor: "AIMA",
          metadata: {
            detail: entityUpsert.error.message,
          },
        });
      } else {
        await db.from("audit_logs").insert({
          entity_type: "document",
          entity_id: documentId,
          action: "ENTITY_EXTRACTION_COMPLETED",
          actor: "AIMA",
          metadata: {
            universalConfidence: extracted.universalConfidence,
            invoiceConfidence: extracted.invoiceConfidence,
            invoicePresent: extracted.invoicePresent,
            legalConfidence: extracted.legalConfidence,
            legalPresent: extracted.legalPresent,
          },
        });
      }
    }
  } catch {
    // Non-fatal: keep intake success even if entity extraction fails.
  }

  return {
    ok: true,
    status: 200,
    body: {
      mrid,
      drid,
      mailItemId,
      documentId,
      status: {
        mailItem: "MI5_INGESTED",
        document: reviewRequired ? "D3_REVIEW_PENDING" : "D3_APPROVED",
      },
      flags: {
        lowTextCoverage,
      },
      file: {
        name: fileName,
        size: buffer.length,
        sha256,
        path: storagePath,
      },
      ocr,
      classification: {
        label: classification.label,
        confidence: classification.confidence,
        method: classification.method,
        rationale: classification.rationale,
      },
      entitySummary,
    },
  };
}
