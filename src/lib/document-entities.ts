export type EntityField = {
  value: string;
  confidence: number; // 0-100
};

export type UniversalMinimalEntities = {
  sender?: EntityField;
  addressee?: EntityField;
  /** Client company / legal entity (letterhead, PTE LTD line, etc.). */
  organization_name?: EntityField;
  /** Named individual when Attn/Attention/Dear line matches. */
  contact_person_name?: EntityField;
  reference_number?: EntityField;
  document_date?: EntityField;
  document_type?: EntityField;
};

export type InvoiceCoreEntities = {
  invoice_number?: EntityField;
  invoice_date?: EntityField;
  due_date?: EntityField;
  currency?: EntityField;
  total_amount?: EntityField;
  tax_amount?: EntityField;
  vendor_name?: EntityField;
  buyer_name?: EntityField;
};

export type LegalCoreEntities = {
  case_number?: EntityField;
  notice_date?: EntityField;
  authority?: EntityField;
  deadline?: EntityField;
  reference_legal?: EntityField;
  // Employment Claims Tribunal (ECT) claim forms.
  claimant_name?: EntityField;
  respondent_name?: EntityField;
  claimant_email?: EntityField;
  respondent_email?: EntityField;
  respondent_contact_name?: EntityField;
  employment_start_date?: EntityField;
  employment_end_date?: EntityField;
  employment_status?: EntityField;
  occupation?: EntityField;
  basic_salary_monthly?: EntityField;
};

export type ExtractedEntitiesResult = {
  universal: UniversalMinimalEntities;
  universalConfidence: number;
  invoice?: InvoiceCoreEntities;
  invoiceConfidence: number;
  invoicePresent: boolean;
  legal?: LegalCoreEntities;
  legalConfidence: number;
  legalPresent: boolean;
};

function normalizeWhitespace(input: string) {
  return input.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeLines(input: string) {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Strip noise from regex captures (e.g. TO:: EMPLOYER → EMPLOYER). */
function normalizeCapturedFieldValue(raw: string): string {
  return raw
    .replace(/^[:;,.、，\-–—\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a line (or label before ":") looks like an ECT/employment form row header, not a person/company name.
 */
function isLikelyFormFieldLabelLine(s: string): boolean {
  const t = s.trim();
  if (t.length === 0) return true;
  const head = (t.split(/[:：]/)[0] ?? t).trim();
  const headNorm = head.replace(/\s+/g, " ").toUpperCase();
  const fullNorm = t.replace(/\s+/g, " ").toUpperCase();

  const exactTokens = new Set([
    "NATIONALITY",
    "NRIC",
    "FIN",
    "PASSPORT",
    "ADDRESS",
    "EMAIL",
    "MOBILE",
    "PHONE",
    "GENDER",
    "AGE",
    "OCCUPATION",
    "DESIGNATION",
    "CITIZENSHIP",
    "EMPLOYEE",
    "EMPLOYER",
    "NAME",
    "SURNAME",
    "GIVEN NAME",
    "FIRST NAME",
    "LAST NAME",
    "D.O.B",
    "DOB",
    "DATE OF BIRTH",
  ]);
  if (exactTokens.has(fullNorm) || exactTokens.has(headNorm)) return true;

  return /^(?:NATIONALITY|NRIC|FIN|PASSPORT|PASSPORT\s+NO\.?|ADDRESS|EMAIL|MOBILE|PHONE|CONTACT(?:\s+NO\.?)?|OCCUPATION|DESIGNATION|DATE\s+OF\s+BIRTH|D\.?O\.?B\.?|GENDER|AGE|RELATIONSHIP|CITIZENSHIP|WORK\s+PERMIT)\b/i.test(
    head,
  );
}

/**
 * Drop OCR/LLM garbage for claimant_name / respondent_name; shared with entity-extraction-llm.
 */
export function sanitizeLegalPartyNameValue(raw: string): string | null {
  let t = normalizeCapturedFieldValue(raw);
  if (t.length < 2) return null;

  const colonIdx = t.search(/[:：]/);
  if (colonIdx >= 0) {
    const left = t.slice(0, colonIdx).trim();
    const right = t.slice(colonIdx + 1).trim();
    if (isLikelyFormFieldLabelLine(left) && right.length >= 2) {
      t = normalizeCapturedFieldValue(right);
    }
  }

  if (isLikelyFormFieldLabelLine(t)) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(t)) return null;
  return t.length >= 2 ? t : null;
}

function parseToIsoDate(raw: string): string | null {
  // Supported:
  // - dd/mm/yyyy
  // - dd-mm-yyyy
  // - yyyy-mm-dd
  const s = raw.trim();
  const slash = s.includes("/") ? "/" : s.includes("-") ? "-" : null;
  if (!slash) return null;

  const parts = s.split(slash).map((p) => p.trim());
  if (parts.length !== 3) return null;

  const [a, b, c] = parts;
  let yyyy = 0;
  let mm = 0;
  let dd = 0;

  if (slash === "/" || slash === "-") {
    // dd/mm/yyyy or dd-mm-yy(yy)
    if (a.length <= 2 && c.length >= 2) {
      dd = Number(a);
      mm = Number(b);
      yyyy = Number(c.length === 2 ? `20${c}` : c);
    } else if (a.length === 4) {
      // yyyy-mm-dd
      yyyy = Number(a);
      mm = Number(b);
      dd = Number(c);
    }
  }

  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd))
    return null;
  if (yyyy < 1900 || yyyy > 2100) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;

  const iso = `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(
    2,
    "0",
  )}-${String(dd).padStart(2, "0")}`;
  return iso;
}

function parseAmountNumber(raw: string): string | null {
  const cleaned = raw.replace(/,/g, "").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  // Keep as fixed with 2 decimals if it looks like a currency amount.
  if (cleaned.includes(".") || cleaned.includes(",")) {
    return n.toFixed(2);
  }
  return cleaned;
}

function pickFirstLineValue(
  lines: string[],
  labels: RegExp[],
  confidence: number,
): EntityField | undefined {
  for (const line of lines) {
    for (const re of labels) {
      const m = line.match(re);
      if (!m) continue;
      const value = normalizeCapturedFieldValue(m[1] ?? "");
      if (!value) continue;
      return { value, confidence };
    }
  }
  return undefined;
}

function findDateNearKeyword(
  text: string,
  keywordRegex: RegExp,
): EntityField | undefined {
  const m = text.match(keywordRegex);
  if (!m) return undefined;
  const rawDate = (m[1] ?? "").trim();
  const iso = parseToIsoDate(rawDate);
  if (!iso) return undefined;
  return { value: iso, confidence: 85 };
}

function findFirstDate(text: string): EntityField | undefined {
  const m = text.match(
    /\b(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/,
  );
  if (!m) return undefined;
  const iso = parseToIsoDate(m[1]);
  if (!iso) return undefined;
  return { value: iso, confidence: 60 };
}

function extractReference(
  text: string,
  lines: string[],
): EntityField | undefined {
  const refPatterns: Array<{ re: RegExp; confidence: number }> = [
    { re: /\bUEN\b\s*[:-]?\s*([A-Z0-9]{5,15})\b/i, confidence: 80 },
    {
      re: /\b(?:REFERENCE|REF)\b\s*(?:NO\.?|NO|NUMBER)?\s*[:-]?\s*([A-Z0-9/-]{3,})\b/i,
      confidence: 80,
    },
    {
      re: /\b(?:CASE|CLAIM|ACCOUNT|POLICY)\b\s*(?:NO\.?|NO|NUMBER)?\s*[:-]?\s*([A-Z0-9/-]{3,})\b/i,
      confidence: 75,
    },
    {
      re: /\bINVOICE\s*(?:NO\.?|NO|NUMBER|#)?\s*[:-]?\s*([A-Z0-9/-]{3,})\b/i,
      confidence: 70,
    },
  ];

  for (const { re, confidence } of refPatterns) {
    const m = text.match(re);
    if (m?.[1]) return { value: m[1].trim(), confidence };
  }

  // Line-based fallback: "Ref: ..."
  for (const line of lines) {
    const m = line.match(/\b(?:REF|REFERENCE)\b\s*[:-]\s*([A-Z0-9/-]{3,})\b/i);
    if (m?.[1]) return { value: m[1].trim(), confidence: 60 };
  }

  return undefined;
}

function extractCaseNumber(text: string): EntityField | undefined {
  const ect = text.match(/\bECT\/\d{4,}\/\d{2,6}\b/i);
  if (ect?.[0]) return { value: ect[0], confidence: 95 };

  const m = text.match(
    /\b(?:CASE|CLAIM|MATTER)\b\s*(?:NO\.?|NO|NUMBER)?\s*[:-]?\s*([A-Z0-9/-]{3,})\b/i,
  );
  if (!m?.[1]) return undefined;
  return { value: m[1].trim(), confidence: 85 };
}

function extractAuthority(
  text: string,
  lines: string[],
): EntityField | undefined {
  const byLine = pickFirstLineValue(
    lines,
    [
      /\b(?:AUTHORITY|ISSUED BY|ISSUING AUTHORITY|FROM)\b\s*[:-]\s*(.{3,})\s*$/i,
    ],
    75,
  );
  if (byLine) return byLine;

  const m =
    text.match(/\b(EMPLOYMENT CLAIMS TRIBUNALS)\b/i) ??
    text.match(/\b(SUPREME COURT|STATE COURTS|HIGH COURT)\b/i) ??
    text.match(/\b(ACRA|IRAS|MOM|CPF|HDB|LTA|MAS)\b/i);
  if (!m?.[1]) return undefined;
  return { value: m[1].trim(), confidence: 70 };
}

function extractInvoiceNumber(
  text: string,
  lines: string[],
): EntityField | undefined {
  const m =
    text.match(
      /\b(?:TAX\s+INVOICE|INVOICE)\s*(?:NO\.?|NO|NUMBER|#)?\s*[:-]?\s*([A-Z0-9/-]{3,})\b/i,
    ) ??
    lines
      .map((l) =>
        l.match(
          /\bINVOICE\b\s*(?:NO\.?|NO|NUMBER|#)?\s*[:-]?\s*([A-Z0-9/-]{3,})\b/i,
        ),
      )
      .find((x) => Boolean(x?.[1])) ??
    null;

  if (!m) return undefined;
  const val = (m[1] ?? "").trim();
  if (!val) return undefined;
  return { value: val, confidence: 85 };
}

function extractInvoiceDate(text: string): EntityField | undefined {
  const byKeyword = findDateNearKeyword(
    text,
    /\b(?:INVOICE\s+DATE|INVDATE|INVOICE\s+DATED|DATE\s+OF\s+INVOICE)\b\s*[:-]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
  );
  return byKeyword ?? findFirstDate(text);
}

function extractDueDate(text: string): EntityField | undefined {
  return (
    findDateNearKeyword(
      text,
      /\b(?:DUE\s*DATE|PAYMENT\s*DUE|PAY\s*BY|DUE)\b\s*[:-]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    ) ?? undefined
  );
}

function extractCurrency(text: string): EntityField | undefined {
  const m =
    text.match(/\b(SGD|S\$)\b\s*([0-9.,]+)?/i) ??
    text.match(/\b(USD|US\$)\b\s*([0-9.,]+)?/i) ??
    text.match(/\b(A\$|AU\$|NZ\$)\b\s*([0-9.,]+)?/i);
  if (!m) return undefined;
  return {
    value: (m[1] ?? "").replace(/\s+/g, "").toUpperCase(),
    confidence: 70,
  };
}

function extractAmountNearLabel(
  text: string,
  labelRegex: RegExp,
): EntityField | undefined {
  // Captures a numeric string with optional commas/decimals.
  const m = text.match(
    new RegExp(
      `${labelRegex.source}\\s*[:\\-]?\\s*(?:[A-Z]{2,4}|S\\\\$|SGD|USD)?\\s*([0-9][0-9,]*(?:\\.[0-9]{2})?)`,
      "i",
    ),
  );
  if (!m?.[1]) return undefined;
  const num = parseAmountNumber(m[1]);
  if (!num) return undefined;
  return { value: num, confidence: 80 };
}

function extractVendorBuyer(text: string, lines: string[]) {
  const sender = pickFirstLineValue(
    lines,
    [
      /\b(?:FROM|SENDER|VENDOR|SUPPLIER|ISSUED BY)\b\s*[:-]\s*(.{4,})\s*$/i,
      /\b(?:SENDER)\b\s*[:-]\s*(.{4,})\s*$/i,
    ],
    75,
  );

  const addressee = pickFirstLineValue(
    lines,
    [
      /\b(?:TO|ADDRESSEE|BILL TO|CUSTOMER|RECIPIENT|ATTN)\b\s*[:-]\s*(.{4,})\s*$/i,
    ],
    75,
  );

  // Sometimes the labels are within one line without a dedicated token.
  if (!sender && text) {
    const m = text.match(/\b(?:FROM)\b\s*[:-]\s*([A-Z0-9 ,.&'\\/-]{4,})/i);
    if (m?.[1]) {
      const v = normalizeCapturedFieldValue(m[1]);
      if (v.length >= 4)
        return {
          sender: { value: v, confidence: 60 },
          buyer: addressee,
        };
    }
  }

  return { sender, buyer: addressee };
}

function extractContactPersonFromAttn(rawLines: string[]): EntityField | undefined {
  for (const line of rawLines.slice(0, 45)) {
    const attn = line.match(
      /^\s*(?:ATTN|ATTENTION|ATT\.?\s*N)\s*[:\-.]\s*(.+)$/i,
    );
    if (attn?.[1]) {
      const v = attn[1].trim();
      if (v.length >= 2 && v.length < 160) {
        return { value: v.replace(/\s+/g, " "), confidence: 78 };
      }
    }
    const dear = line.match(
      /^\s*DEAR\s+(?:MR\.?|MS\.?|MRS\.?|DR\.?|PROF\.?)?\s*([A-Za-z][A-Za-z'.-]+(?:\s+[A-Za-z][A-Za-z'.-]+){0,5})\s*[,:]/i,
    );
    if (dear?.[1]) {
      const v = dear[1].trim();
      if (v.length >= 2 && v.length < 120) {
        return { value: v.replace(/\s+/g, " "), confidence: 62 };
      }
    }
  }
  return undefined;
}

function extractOrganizationFromLines(rawLines: string[]): EntityField | undefined {
  const orgPattern =
    /\b(PTE\.?\s*LTD|PTE\s+LTD|LTD\.?|LIMITED|LLP|LLC|INC\.?|CORP\.?|SDN\.?\s*BHD|BERHAD|CO\.\s*,\s*REG)\b/i;
  for (let i = 0; i < Math.min(rawLines.length, 28); i++) {
    const line = rawLines[i];
    if (!line || line.length < 6 || line.length > 220) continue;
    if (orgPattern.test(line)) {
      const cleaned = line.replace(/^\d+[\).\s]+/, "").trim();
      if (cleaned.length >= 6) {
        return { value: cleaned, confidence: 72 };
      }
    }
  }
  return undefined;
}

function findClaimantRespondentHeaderIndices(upperLines: string[]): {
  claimantHeaderIdx: number;
  respondentHeaderIdx: number;
} {
  const claimantHeaderIdx = upperLines.findIndex(
    (l) =>
      /\bPARTICULARS\s+OF\s+CLAIMANT\b/i.test(l) ||
      /\bCLAIMANT\(S\)\b/i.test(l) ||
      /\bPARTICULARS\s+OF\s+CLAIMANTS\b/i.test(l),
  );
  const respondentHeaderIdx = upperLines.findIndex(
    (l) =>
      /\bPARTICULARS\s+OF\s+RESPONDENT\b/i.test(l) ||
      /\bRESPONDENT\(S\)\b/i.test(l) ||
      /\bPARTICULARS\s+OF\s+RESPONDENTS\b/i.test(l),
  );
  return { claimantHeaderIdx, respondentHeaderIdx };
}

function extractClaimantRespondentNames(
  rawLines: string[],
  upperLines: string[],
): {
  claimant?: EntityField;
  respondent?: EntityField;
  claimantHeaderIdx: number;
  respondentHeaderIdx: number;
} {
  const { claimantHeaderIdx, respondentHeaderIdx } =
    findClaimantRespondentHeaderIndices(upperLines);

  const extractNameAfterHeader = (
    headerIdx: number,
  ): EntityField | undefined => {
    if (headerIdx < 0) return undefined;

    const windowEnd = Math.min(upperLines.length, headerIdx + 12);
    for (let i = headerIdx + 1; i < windowEnd; i += 1) {
      const rawLine = rawLines[i] ?? "";
      const upperLine = upperLines[i] ?? "";
      // "Name : …", "Name (Company) : …", "NAME - …"
      const m = rawLine.match(
        /\bNAME\b(?:\s*\([^)]+\))?\s*[:-]?\s*(.+)$/i,
      );
      if (m?.[1]) {
        const cleaned = sanitizeLegalPartyNameValue(m[1]);
        if (cleaned) return { value: cleaned, confidence: 90 };
      }

      if (/\bNAME\b(?:\s*\([^)]+\))?\s*[:-]?\s*$/i.test(rawLine)) {
        const scanEnd = Math.min(i + 6, windowEnd);
        for (let j = i + 1; j < scanEnd; j += 1) {
          const nextRaw = rawLines[j] ?? "";
          if (nextRaw.trim().length < 2) continue;
          if (isLikelyFormFieldLabelLine(nextRaw)) continue;
          const cleaned = sanitizeLegalPartyNameValue(nextRaw);
          if (cleaned) return { value: cleaned, confidence: 85 };
        }
      }

      // Upper-only line match when raw regex missed noisy OCR
      const um = upperLine.match(/\bNAME\b(?:\s*\([^)]+\))?\s*[:-]?\s*(.+)$/);
      if (um?.[1]) {
        const v = um[1].trim();
        if (!/^EMAIL\b/i.test(v)) {
          const cleaned = sanitizeLegalPartyNameValue(v);
          if (cleaned) return { value: cleaned, confidence: 82 };
        }
      }
    }

    return undefined;
  };

  const claimant = extractNameAfterHeader(claimantHeaderIdx);
  const respondent = extractNameAfterHeader(respondentHeaderIdx);
  return { claimant, respondent, claimantHeaderIdx, respondentHeaderIdx };
}

const EMAIL_IN_LINE = /\bEMAIL\b\s*[:-]?\s*(\S+@\S+)/i;

function extractEmailInSectionWindow(
  rawLines: string[],
  headerIdx: number,
  windowSize: number,
): EntityField | undefined {
  if (headerIdx < 0) return undefined;
  const windowEnd = Math.min(rawLines.length, headerIdx + windowSize);
  for (let i = headerIdx + 1; i < windowEnd; i += 1) {
    const line = rawLines[i] ?? "";
    const m = line.match(EMAIL_IN_LINE);
    if (m?.[1]) return { value: m[1].trim(), confidence: 88 };
  }
  return undefined;
}

function extractRespondentContactPerson(
  rawLines: string[],
  respondentHeaderIdx: number,
  sectionCIdx: number,
): EntityField | undefined {
  if (respondentHeaderIdx < 0) return undefined;
  const windowEnd = Math.min(
    rawLines.length,
    sectionCIdx >= 0
      ? Math.min(sectionCIdx, respondentHeaderIdx + 22)
      : respondentHeaderIdx + 22,
  );
  for (let i = respondentHeaderIdx + 1; i < windowEnd; i += 1) {
    if (sectionCIdx >= 0 && i >= sectionCIdx) break;
    const rawLine = rawLines[i] ?? "";
    const m = rawLine.match(/\bCONTACT\s+PERSON\b\s*[:-]?\s*(.+)$/i);
    if (m?.[1]) {
      const v = m[1].trim();
      if (v.length >= 2 && !v.includes("@"))
        return { value: v, confidence: 86 };
    }
    if (/\bCONTACT\s+PERSON\b\s*[:-]?\s*$/i.test(rawLine)) {
      const next = (rawLines[i + 1] ?? "").trim();
      if (next.length >= 2 && !next.includes("@"))
        return { value: next, confidence: 82 };
    }
  }
  return undefined;
}

function findSectionCIndex(upperLines: string[]): number {
  return upperLines.findIndex(
    (l) =>
      /\bSECTION\s+C\b/.test(l) ||
      /\bEMPLOYMENT\s+DETAILS\s+OF\s+EMPLOYEE\b/.test(l) ||
      /\bEMPLOYMENT\s+DETAILS\b/.test(l),
  );
}

function extractLabeledValueAfterKeyword(
  rawLines: string[],
  upperLines: string[],
  keywordLine: RegExp,
  asDate: boolean,
): EntityField | undefined {
  const idx = upperLines.findIndex((l) => keywordLine.test(l));
  if (idx < 0) return undefined;
  const rawLine = rawLines[idx] ?? "";
  const afterFirstColon = rawLine.includes(":")
    ? rawLine.slice(rawLine.indexOf(":") + 1).trim()
    : "";
  const candidates = [afterFirstColon, (rawLines[idx + 1] ?? "").trim()].filter(
    (s) => s.length > 0,
  );
  for (const cand of candidates) {
    if (asDate) {
      const iso = parseToIsoDate(cand.replace(/\s+per\s+month.*$/i, "").trim());
      if (iso) return { value: iso, confidence: 86 };
    } else {
      const cleaned = cand.replace(/\s+per\s+month.*$/i, "").trim();
      if (cleaned.length >= 2)
        return { value: cleaned, confidence: 82 };
    }
  }
  return undefined;
}

function extractBasicSalaryMonthly(normalizedText: string): EntityField | undefined {
  const m = normalizedText.match(
    /\bBASIC\s+SALARY\b[^0-9]{0,50}(?:S\$|SGD)?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i,
  );
  if (!m?.[1]) return undefined;
  const num = parseAmountNumber(m[1]);
  if (!num) return undefined;
  return { value: num, confidence: 80 };
}

function extractOccupation(
  rawLines: string[],
  upperLines: string[],
): EntityField | undefined {
  const idx = upperLines.findIndex(
    (l) => /\bOCCUPATION\b/.test(l) && !/\bOCCUPATIONAL\b/.test(l),
  );
  if (idx < 0) return undefined;
  const rawLine = rawLines[idx] ?? "";
  const tail = rawLine.includes(":")
    ? rawLine.slice(rawLine.indexOf(":") + 1).trim()
    : "";
  if (tail.length >= 2) return { value: tail, confidence: 84 };
  const next = (rawLines[idx + 1] ?? "").trim();
  if (next.length >= 2) return { value: next, confidence: 80 };
  return undefined;
}

function averageConfidence(fields: Array<EntityField | undefined>): number {
  const present = fields.filter((f): f is EntityField => Boolean(f));
  if (present.length === 0) return 0;
  const avg = present.reduce((s, f) => s + f.confidence, 0) / present.length;
  return Math.round(Math.max(0, Math.min(100, avg)));
}

function cleanJsonForSupabase(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function extractDocumentEntitiesFromOcrText(
  ocrText: string,
  classificationLabel?: string | null,
): ExtractedEntitiesResult {
  const normalizedText = normalizeWhitespace(ocrText).toUpperCase();
  const rawLines = normalizeLines(ocrText);
  const lines = rawLines.map((l) => l.toUpperCase());

  const documentTypeValue =
    classificationLabel && classificationLabel !== "UNKNOWN"
      ? classificationLabel
      : undefined;

  const universal: UniversalMinimalEntities = {
    document_type: documentTypeValue
      ? { value: documentTypeValue, confidence: 75 }
      : undefined,
  };

  const universalReference = extractReference(normalizedText, lines);
  if (universalReference) universal.reference_number = universalReference;

  // Sender/addressee are often in the "FROM"/"TO" lines.
  const { sender, buyer } = extractVendorBuyer(normalizedText, lines);
  if (sender) universal.sender = sender;
  if (buyer) universal.addressee = buyer;

  const contactPerson = extractContactPersonFromAttn(rawLines);
  if (contactPerson) universal.contact_person_name = contactPerson;
  const orgFromLine = extractOrganizationFromLines(rawLines);
  if (orgFromLine) universal.organization_name = orgFromLine;

  // Document date: often "DATE" or first date in doc.
  const documentDate = findDateNearKeyword(
    normalizedText,
    /\b(?:DOCUMENT\s*DATE|DATE)\b\s*[:-]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/,
  );
  universal.document_date = documentDate ?? findFirstDate(normalizedText);

  const invoiceNumber = extractInvoiceNumber(normalizedText, lines);
  const invoiceDate = extractInvoiceDate(normalizedText);
  const dueDate = extractDueDate(normalizedText);
  const currency = extractCurrency(normalizedText);

  const totalAmount = extractAmountNearLabel(
    normalizedText,
    /(?:TOTAL|AMOUNT\s*PAYABLE|AMOUNT\s+DUE|INVOICE\s*TOTAL)/,
  );
  const taxAmount = extractAmountNearLabel(normalizedText, /(?:GST|TAX|VAT)/);

  const vendorBuyer = extractVendorBuyer(normalizedText, lines);

  const invoiceEntities: InvoiceCoreEntities = {
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    due_date: dueDate,
    currency,
    total_amount: totalAmount,
    tax_amount: taxAmount,
    vendor_name: vendorBuyer.sender,
    buyer_name: vendorBuyer.buyer,
  };

  const invoicePresent = Boolean(
    invoiceEntities.invoice_number ||
      invoiceEntities.total_amount ||
      invoiceEntities.tax_amount ||
      invoiceEntities.due_date,
  );

  const invoiceConfidence = invoicePresent
    ? averageConfidence([
        invoiceEntities.invoice_number,
        invoiceEntities.invoice_date,
        invoiceEntities.due_date,
        invoiceEntities.currency,
        invoiceEntities.total_amount,
        invoiceEntities.tax_amount,
        invoiceEntities.vendor_name,
        invoiceEntities.buyer_name,
      ])
    : 0;

  const caseNumber = extractCaseNumber(normalizedText);
  const noticeDate = findDateNearKeyword(
    normalizedText,
    /\b(?:NOTICE\s*DATE|DATE\s*OF\s*NOTICE|DATED)\b\s*[:-]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
  );
  const authority = extractAuthority(normalizedText, lines);
  const deadline = findDateNearKeyword(
    normalizedText,
    /\b(?:DEADLINE|BY\s*DATE|RESPOND\s*BY|DUE\s*BY)\b\s*[:-]?\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
  );
  const legalReference = extractReference(normalizedText, lines);

  const legalEntities: LegalCoreEntities = {
    case_number: caseNumber,
    notice_date: noticeDate,
    authority,
    deadline,
    reference_legal: legalReference,
  };

  const { claimant, respondent, claimantHeaderIdx, respondentHeaderIdx } =
    extractClaimantRespondentNames(rawLines, lines);
  if (claimant) legalEntities.claimant_name = claimant;
  if (respondent) legalEntities.respondent_name = respondent;

  const claimantEmail = extractEmailInSectionWindow(
    rawLines,
    claimantHeaderIdx,
    15,
  );
  const respondentEmail = extractEmailInSectionWindow(
    rawLines,
    respondentHeaderIdx,
    15,
  );
  if (claimantEmail) legalEntities.claimant_email = claimantEmail;
  if (respondentEmail) legalEntities.respondent_email = respondentEmail;

  const sectionCIdx = findSectionCIndex(lines);
  const respondentContact = extractRespondentContactPerson(
    rawLines,
    respondentHeaderIdx,
    sectionCIdx,
  );
  if (respondentContact)
    legalEntities.respondent_contact_name = respondentContact;

  const employmentStart = extractLabeledValueAfterKeyword(
    rawLines,
    lines,
    /START\s+DATE\s+OF\s+EMPLOYMENT/,
    true,
  );
  const employmentEnd = extractLabeledValueAfterKeyword(
    rawLines,
    lines,
    /END\s+DATE\s+OF\s+EMPLOYMENT/,
    true,
  );
  const employmentStatus = extractLabeledValueAfterKeyword(
    rawLines,
    lines,
    /EMPLOYMENT\s+STATUS/,
    false,
  );
  const occupation = extractOccupation(rawLines, lines);
  const basicSalary = extractBasicSalaryMonthly(normalizedText);

  if (employmentStart) legalEntities.employment_start_date = employmentStart;
  if (employmentEnd) legalEntities.employment_end_date = employmentEnd;
  if (employmentStatus) legalEntities.employment_status = employmentStatus;
  if (occupation) legalEntities.occupation = occupation;
  if (basicSalary) legalEntities.basic_salary_monthly = basicSalary;

  const orgSuffixPattern =
    /\b(PTE\.?\s*LTD|PTE\s+LTD|LTD\.?|LIMITED|LLP|LLC|INC\.?|CORP\.?|SDN\.?\s*BHD|BERHAD|CO\.\s*,\s*REG)\b/i;
  if (
    classificationLabel === "LEGAL" &&
    !universal.organization_name &&
    legalEntities.respondent_name?.value &&
    orgSuffixPattern.test(legalEntities.respondent_name.value) &&
    legalEntities.respondent_name.value.length >= 8
  ) {
    universal.organization_name = {
      value: legalEntities.respondent_name.value,
      confidence: 60,
    };
  }

  const universalConfidence = averageConfidence([
    universal.sender,
    universal.addressee,
    universal.organization_name,
    universal.contact_person_name,
    universal.reference_number,
    universal.document_date,
    universal.document_type,
  ]);

  const legalPresent = Boolean(
    legalEntities.case_number ||
      legalEntities.authority ||
      legalEntities.notice_date ||
      legalEntities.deadline ||
      legalEntities.reference_legal ||
      legalEntities.claimant_name ||
      legalEntities.respondent_name ||
      legalEntities.claimant_email ||
      legalEntities.respondent_email ||
      legalEntities.respondent_contact_name ||
      legalEntities.employment_start_date ||
      legalEntities.employment_end_date ||
      legalEntities.employment_status ||
      legalEntities.occupation ||
      legalEntities.basic_salary_monthly,
  );
  const legalConfidence = legalPresent
    ? averageConfidence([
        legalEntities.case_number,
        legalEntities.notice_date,
        legalEntities.authority,
        legalEntities.deadline,
        legalEntities.reference_legal,
        legalEntities.claimant_name,
        legalEntities.respondent_name,
        legalEntities.claimant_email,
        legalEntities.respondent_email,
        legalEntities.respondent_contact_name,
        legalEntities.employment_start_date,
        legalEntities.employment_end_date,
        legalEntities.employment_status,
        legalEntities.occupation,
        legalEntities.basic_salary_monthly,
      ])
    : 0;

  const cleanedUniversal = cleanJsonForSupabase(universal);
  const cleanedInvoice =
    invoicePresent && invoiceConfidence > 0
      ? cleanJsonForSupabase(invoiceEntities)
      : undefined;
  const cleanedLegal =
    legalPresent && legalConfidence > 0
      ? cleanJsonForSupabase(legalEntities)
      : undefined;

  return {
    universal: cleanedUniversal as UniversalMinimalEntities,
    universalConfidence,
    invoice: cleanedInvoice,
    invoiceConfidence,
    invoicePresent,
    legal: cleanedLegal,
    legalConfidence,
    legalPresent,
  };
}
