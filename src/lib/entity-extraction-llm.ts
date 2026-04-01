import Anthropic from "@anthropic-ai/sdk";
import type { ClassificationLabel } from "@/lib/document-classify";
import { sanitizeLegalPartyNameValue } from "@/lib/document-entities";

/** Keys the LLM may return for universal_info (pipeline-owned keys are never applied from LLM). */
export const UNIVERSAL_LLM_KEYS = [
  "recipient_name",
  "organization_name",
  "contact_person_name",
  "recipient_uen",
  "recipient_address",
  "sender_name",
  "sender_address",
  "document_date",
  "reference_number",
  "document_type",
  "document_subtype",
  "subject_line",
  "action_required",
  "deadline_date",
  "priority",
  "match_confidence",
  "status",
] as const;

export const LEGAL_LLM_KEYS = [
  "case_number",
  "court_name",
  "claimant_name",
  "claimant_address",
  "claimant_contact",
  "claimant_email",
  "respondent_name",
  "respondent_address",
  "respondent_contact",
  "respondent_email",
  "claim_type",
  "claim_amount",
  "claim_summary",
  "hearing_date",
  "hearing_location",
  "hearing_type",
  "crc_number",
  "online_access_code",
  "online_portal_url",
  "tax_reference",
  "year_of_assessment",
  "tax_amount",
  "surcharge_amount",
  "strike_off_date",
  "acra_reference",
  "employment_start_date",
  "employment_end_date",
  "dismissal_date",
  "basic_salary",
  "occupation",
  "legal_statute",
] as const;

export const INVOICE_LLM_KEYS = [
  "account_number",
  "account_name",
  "bill_number",
  "bill_date",
  "due_date",
  "service_period_start",
  "service_period_end",
  "currency",
  "previous_balance",
  "payment_received",
  "current_charges",
  "gst_amount",
  "total_amount_due",
  "payment_code",
  "giro_reference",
  "paynow_reference",
  "demand_amount",
  "demand_currency",
  "demand_deadline",
  "interest_rate",
  "service_type",
  "mobile_number",
  "plan_name",
  "bank_name",
  "d_and_t_reference",
  "audit_period",
] as const;

export type LlmEntityBuckets = {
  universal: Partial<Record<(typeof UNIVERSAL_LLM_KEYS)[number], unknown>>;
  legal: Partial<Record<(typeof LEGAL_LLM_KEYS)[number], unknown>>;
  invoice: Partial<Record<(typeof INVOICE_LLM_KEYS)[number], unknown>>;
};

/** Keys intake/OCR must never overwrite from LLM. */
export const UNIVERSAL_PROTECTED_KEYS = new Set([
  "document_id",
  "drid",
  "mrid",
  "full_text",
  "page_start",
  "page_end",
  "page_count",
  "pdf_path",
  "original_pdf_path",
  "classification_confidence",
]);

function parseRawLlmJson(raw: string): unknown | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function coerceString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function coerceDateString(v: unknown): string | null {
  const s = coerceString(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function coerceTimestamp(v: unknown): string | null {
  const s = coerceString(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function coerceDecimal(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceInt(v: unknown): number | null {
  const n = coerceDecimal(v);
  if (n == null) return null;
  const i = Math.round(n);
  return Number.isFinite(i) ? i : null;
}

function coerceBool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  return null;
}

const UNIVERSAL_DATE_KEYS = new Set([
  "document_date",
  "deadline_date",
] as const);

const LEGAL_DATE_KEYS = new Set([
  "employment_start_date",
  "employment_end_date",
  "dismissal_date",
  "strike_off_date",
] as const);

const INVOICE_DATE_KEYS = new Set([
  "bill_date",
  "due_date",
  "service_period_start",
  "service_period_end",
  "demand_deadline",
] as const);

const LEGAL_DECIMAL_KEYS = new Set([
  "claim_amount",
  "tax_amount",
  "surcharge_amount",
  "basic_salary",
] as const);

const INVOICE_DECIMAL_KEYS = new Set([
  "previous_balance",
  "payment_received",
  "current_charges",
  "gst_amount",
  "total_amount_due",
  "demand_amount",
  "interest_rate",
] as const);

function normalizeUniversalBucket(
  raw: Record<string, unknown>,
): LlmEntityBuckets["universal"] {
  const out: LlmEntityBuckets["universal"] = {};
  for (const key of UNIVERSAL_LLM_KEYS) {
    const v = raw[key];
    if (v == null) continue;
    if (key === "action_required") {
      const b = coerceBool(v);
      if (b != null) out[key] = b;
      continue;
    }
    if (key === "match_confidence") {
      const i = coerceInt(v);
      if (i != null) out[key] = i;
      continue;
    }
    if (UNIVERSAL_DATE_KEYS.has(key as "document_date")) {
      const d = coerceDateString(v);
      if (d) out[key] = d;
      continue;
    }
    const s = coerceString(v);
    if (s) out[key] = s;
  }
  return out;
}

function normalizeLegalBucket(
  raw: Record<string, unknown>,
): LlmEntityBuckets["legal"] {
  const out: LlmEntityBuckets["legal"] = {};
  for (const key of LEGAL_LLM_KEYS) {
    const v = raw[key];
    if (v == null) continue;
    if (key === "hearing_date") {
      const t = coerceTimestamp(v);
      if (t) out[key] = t;
      continue;
    }
    if (LEGAL_DATE_KEYS.has(key as "employment_start_date")) {
      const d = coerceDateString(v);
      if (d) out[key] = d;
      continue;
    }
    if (LEGAL_DECIMAL_KEYS.has(key as "claim_amount")) {
      const n = coerceDecimal(v);
      if (n != null) out[key] = n;
      continue;
    }
    const s = coerceString(v);
    if (!s) continue;
    if (key === "claimant_name" || key === "respondent_name") {
      const cleaned = sanitizeLegalPartyNameValue(s);
      if (cleaned) out[key] = cleaned;
      continue;
    }
    out[key] = s;
  }
  return out;
}

function normalizeInvoiceBucket(
  raw: Record<string, unknown>,
): LlmEntityBuckets["invoice"] {
  const out: LlmEntityBuckets["invoice"] = {};
  for (const key of INVOICE_LLM_KEYS) {
    const v = raw[key];
    if (v == null) continue;
    if (INVOICE_DATE_KEYS.has(key as "bill_date")) {
      const d = coerceDateString(v);
      if (d) out[key] = d;
      continue;
    }
    if (INVOICE_DECIMAL_KEYS.has(key as "gst_amount")) {
      const n = coerceDecimal(v);
      if (n != null) out[key] = n;
      continue;
    }
    const s = coerceString(v);
    if (s) out[key] = s;
  }
  return out;
}

function normalizeLlmPayload(parsed: unknown): LlmEntityBuckets | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const u = root.universal;
  const l = root.legal;
  const i = root.invoice;
  return {
    universal:
      u && typeof u === "object"
        ? normalizeUniversalBucket(u as Record<string, unknown>)
        : {},
    legal:
      l && typeof l === "object"
        ? normalizeLegalBucket(l as Record<string, unknown>)
        : {},
    invoice:
      i && typeof i === "object"
        ? normalizeInvoiceBucket(i as Record<string, unknown>)
        : {},
  };
}

export function isEmptyEntityValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/** True if any value is non-empty excluding listed keys (e.g. document_id, default currency). */
export function rowHasExtractableFields(
  row: Record<string, unknown>,
  skipKeys: readonly string[],
): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (skipKeys.includes(k)) continue;
    if (isEmptyEntityValue(v)) continue;
    return true;
  }
  return false;
}

/** Count non-empty values across universal / legal / invoice buckets (post-normalization). */
export function countLlmBucketValues(buckets: LlmEntityBuckets): number {
  let n = 0;
  for (const bucket of [
    buckets.universal,
    buckets.legal,
    buckets.invoice,
  ] as const) {
    for (const v of Object.values(bucket)) {
      if (!isEmptyEntityValue(v)) n += 1;
    }
  }
  return n;
}

/**
 * Merges LLM partial into base row. Returns number of keys applied from LLM (for audit).
 */
export function mergeEntityRows<T extends Record<string, unknown>>(
  base: T,
  llmPartial: Record<string, unknown> | null | undefined,
  protectedKeys: Set<string>,
  override: boolean,
): number {
  if (!llmPartial) return 0;
  let filled = 0;
  for (const [key, val] of Object.entries(llmPartial)) {
    if (protectedKeys.has(key)) continue;
    if (val === undefined) continue;
    if (!override) {
      const cur = base[key as keyof T];
      if (!isEmptyEntityValue(cur)) continue;
    }
    if (isEmptyEntityValue(val)) continue;
    (base as Record<string, unknown>)[key] = val;
    filled += 1;
  }
  return filled;
}

function entityExcerptMaxChars(): number {
  const raw = process.env.ENTITY_EXTRACTION_OCR_MAX_CHARS?.trim() ?? "28000";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 2000 ? n : 28000;
}

function safeDebugPreview(raw: string): string {
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
    .replace(/\b\d{6,}\b/g, "[redacted_number]")
    .slice(0, 1200);
}

/**
 * Optional Anthropic extraction: structured fields for universal_info / legal_entities / invoice_entities.
 * Returns null if disabled, no API key, parse failure, or API error (caller should catch throws).
 */
export async function extractEntitiesWithLlm(
  ocrText: string,
  classificationLabel: ClassificationLabel,
): Promise<LlmEntityBuckets | null> {
  if (process.env.ENTITY_EXTRACTION_USE_LLM !== "true") return null;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const model =
    process.env.ANTHROPIC_ENTITY_MODEL?.trim() || "claude-sonnet-4-6";
  const excerpt = ocrText.slice(0, entityExcerptMaxChars());

  const keyLists = {
    universal: UNIVERSAL_LLM_KEYS.join(", "),
    legal: LEGAL_LLM_KEYS.join(", "),
    invoice: INVOICE_LLM_KEYS.join(", "),
  };

  const legalPartyHint =
    classificationLabel === "LEGAL"
      ? `
Legal / tribunal (e.g. ECT): claimant_name and respondent_name must be the actual PERSON or COMPANY named in the "Particulars of Claimant" / "Particulars of Respondent" sections (the value next to Name or the block heading). Never use row labels or field names as the name — e.g. do not output Nationality, NRIC, Occupation, Address, Email, Employer, Employee, or section titles as claimant_name or respondent_name. If the true name is not clearly in the OCR, use null.
`
      : "";

  const userMsg = `You extract structured data from registered-office mail OCR. The document was classified as: ${classificationLabel}.

Semantic field meanings (universal):
- recipient_name / sender_name: directional and strict.
  - recipient_name = company the letter is addressed TO (address block at top, after "To:").
  - sender_name = company/person that SENT the letter (letterhead/logo/signature block).
  - Do NOT confuse sender_name with recipient_name.
- organization_name: the client COMPANY or legal entity the matter concerns (often the addressee company or name after "Re:", UEN block, or registered-office client). Use null if only a person is named with no clear entity.
- contact_person_name: a natural PERSON only when explicitly labeled (e.g. Attn:, Attention:, Dear Mr/Ms, signatory line). For "Attention: Kiran Sreedharan (Spade Consulting Pte. Ltd.)", use "Kiran Sreedharan".
- If an "Attention:" line includes a company distinct from recipient_name, use that company as organization_name (e.g. "Spade Consulting Pte. Ltd.").
${legalPartyHint}
Rules:
- Use ONLY information clearly present in the OCR. If a field is not in the text, use null.
- Do not invent UENs, amounts, dates, or names.
- Extract as many available fields as possible for recipient, sender, references, dates, legal parties, and account holder details.
- Return ONLY valid JSON (no markdown): an object with exactly three keys "universal", "legal", "invoice". Each value is an object whose keys MUST be chosen only from the allowed lists below; omit keys you cannot fill.

Allowed keys for "universal": ${keyLists.universal}

Allowed keys for "legal": ${keyLists.legal}

Allowed keys for "invoice": ${keyLists.invoice}

Formats: dates as YYYY-MM-DD strings; hearing_date as ISO-8601 datetime if time known else date; decimals as JSON numbers; action_required as boolean; match_confidence as integer 0-100.

OCR text:
---
${excerpt}
---`;

  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: userMsg }],
  });

  const block = resp.content[0];
  const text = block?.type === "text" ? block.text : "";
  const trimmed = text.trim();
  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H1_claude_empty_or_non_json",
      location: "entity-extraction-llm.ts:445",
      message: "=== CLAUDE RAW RESPONSE ===",
      data: {
        hasTextBlock: block?.type === "text",
        rawLength: trimmed.length,
        rawPreview: safeDebugPreview(trimmed),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  const parsed = parseRawLlmJson(text);
  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H2_json_parse_failed",
      location: "entity-extraction-llm.ts:465",
      message: "=== PARSED JSON ===",
      data: {
        parseOk: parsed != null,
        parsedType: parsed == null ? "null" : typeof parsed,
        parsedKeys:
          parsed && typeof parsed === "object"
            ? Object.keys(parsed as Record<string, unknown>)
            : [],
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (trimmed.length > 0 && parsed == null) {
    throw new Error("ENTITY_LLM_JSON_PARSE_FAILED");
  }
  const normalized = normalizeLlmPayload(parsed);
  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H3_normalization_dropped_values",
      location: "entity-extraction-llm.ts:491",
      message: "=== EXTRACTED ENTITIES ===",
      data: {
        universalKeys: Object.keys(normalized?.universal ?? {}),
        legalKeys: Object.keys(normalized?.legal ?? {}),
        invoiceKeys: Object.keys(normalized?.invoice ?? {}),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  return normalized;
}
