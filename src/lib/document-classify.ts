import Anthropic from "@anthropic-ai/sdk";

export const CLASSIFICATION_LABELS = [
  "IRAS",
  "ACRA",
  "MOM",
  "BANK_FINANCIAL",
  "LEGAL",
  "UTILITY_PROPERTY",
  "GENERAL",
  "UNKNOWN",
] as const;

export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

export type ClassificationResult = {
  label: ClassificationLabel;
  confidence: number;
  method: "rules" | "llm" | "rules_then_llm";
  rationale: string;
};

type RulePattern = {
  match: (upper: string) => boolean;
  weight: number;
  name: string;
};

const RULE_GROUPS: {
  label: Exclude<ClassificationLabel, "UNKNOWN">;
  patterns: RulePattern[];
}[] = [
  {
    label: "IRAS",
    patterns: [
      {
        match: (u) => u.includes("INLAND REVENUE AUTHORITY OF SINGAPORE"),
        weight: 52,
        name: "IRAS full name",
      },
      {
        match: (u) => u.includes("INLAND REVENUE AUTHORITY"),
        weight: 48,
        name: "Inland Revenue Authority",
      },
      { match: (u) => /\bIRAS\b/.test(u), weight: 38, name: "IRAS" },
      {
        match: (u) => /\bGST\b/.test(u) && u.includes("TAX"),
        weight: 18,
        name: "GST/tax",
      },
    ],
  },
  {
    label: "ACRA",
    patterns: [
      {
        match: (u) =>
          u.includes("ACCOUNTING AND CORPORATE REGULATORY AUTHORITY"),
        weight: 52,
        name: "ACRA full name",
      },
      {
        match: (u) => u.includes("CORPORATE REGULATORY AUTHORITY"),
        weight: 45,
        name: "Corporate Regulatory Authority",
      },
      { match: (u) => /\bACRA\b/.test(u), weight: 40, name: "ACRA" },
    ],
  },
  {
    label: "MOM",
    patterns: [
      {
        match: (u) => u.includes("MINISTRY OF MANPOWER"),
        weight: 50,
        name: "Ministry of Manpower",
      },
      { match: (u) => /\bMOM\b/.test(u), weight: 36, name: "MOM" },
      {
        match: (u) =>
          /\b(WORK PASS|EMPLOYMENT PASS|S PASS|DEPENDANT'S PASS)\b/i.test(u),
        weight: 28,
        name: "work pass",
      },
    ],
  },
  {
    label: "LEGAL",
    patterns: [
      {
        match: (u) =>
          /\b(HIGH COURT|SUPREME COURT|DISTRICT COURT|STATE COURTS)\b/.test(u),
        weight: 46,
        name: "court",
      },
      {
        match: (u) =>
          /\b(LETTER OF DEMAND|STATUTORY DEMAND|WRIT OF SUMMON|LEGAL NOTICE)\b/i.test(
            u,
          ),
        weight: 44,
        name: "demand/notice",
      },
      {
        match: (u) => /\bSOLICITOR\b|\bADVOCATE\b|\bLAW FIRM\b/i.test(u),
        weight: 32,
        name: "law firm",
      },
    ],
  },
  {
    label: "BANK_FINANCIAL",
    patterns: [
      {
        match: (u) =>
          /\b(BANK LIMITED|BANK BERHAD|BANKING|SWIFT\/BIC|IBAN)\b/i.test(u),
        weight: 40,
        name: "banking",
      },
      {
        match: (u) =>
          /\b(CREDIT CARD|DEBIT CARD|LOAN STATEMENT|MORTGAGE)\b/i.test(u),
        weight: 30,
        name: "credit/loan",
      },
    ],
  },
  {
    label: "UTILITY_PROPERTY",
    patterns: [
      {
        match: (u) =>
          /\b(ELECTRICITY|WATER BILL|UTILITIES|TENANCY|LANDLORD|LEASE)\b/i.test(
            u,
          ),
        weight: 38,
        name: "utility/tenancy",
      },
      {
        match: (u) => /\bPUB\b|\bSP SERVICES\b/i.test(u),
        weight: 34,
        name: "PUB/SP",
      },
    ],
  },
  {
    label: "GENERAL",
    patterns: [
      {
        match: (u) =>
          /\b(PTE\.?\s*LTD|SDN BHD|LLP|INC\.|CORPORATION)\b/i.test(u),
        weight: 12,
        name: "entity suffix",
      },
      { match: (u) => u.length > 200, weight: 8, name: "substantive text" },
    ],
  },
];

function normalizeForRules(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

export function classifyDocumentFromOcrRules(
  ocrText: string,
): ClassificationResult {
  const upper = normalizeForRules(ocrText);
  if (!upper.length) {
    return {
      label: "UNKNOWN",
      confidence: 15,
      method: "rules",
      rationale: "No OCR text to classify.",
    };
  }

  const scores: Partial<Record<ClassificationLabel, number>> = {};
  const hits: Record<string, string[]> = {};

  for (const group of RULE_GROUPS) {
    let total = 0;
    const names: string[] = [];
    for (const p of group.patterns) {
      if (p.match(upper)) {
        total += p.weight;
        names.push(p.name);
      }
    }
    if (total > 0) {
      scores[group.label] = total;
      hits[group.label] = names;
    }
  }

  const entries = Object.entries(scores) as [ClassificationLabel, number][];
  if (entries.length === 0) {
    return {
      label: "UNKNOWN",
      confidence: 28,
      method: "rules",
      rationale: "No keyword rules matched.",
    };
  }

  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  if (!top) {
    return {
      label: "UNKNOWN",
      confidence: 28,
      method: "rules",
      rationale: "No keyword rules matched.",
    };
  }
  const [bestLabel, bestScore] = top;
  const secondScore = entries[1]?.[1] ?? 0;

  let confidence = Math.min(96, 48 + Math.round(bestScore * 0.45));
  if (secondScore > 0 && bestScore - secondScore < 18) {
    confidence = Math.max(40, confidence - 18);
  }

  const rationale =
    (hits[bestLabel] ?? []).length > 0
      ? `Rules: ${(hits[bestLabel] ?? []).join(", ")}`
      : "Rules: category score";

  return {
    label: bestLabel,
    confidence,
    method: "rules",
    rationale,
  };
}

function parseLlmJson(raw: string): Partial<ClassificationResult> | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const label = o.label as string;
    const confidence = Number(o.confidence);
    const rationale = typeof o.rationale === "string" ? o.rationale : "";
    if (!CLASSIFICATION_LABELS.includes(label as ClassificationLabel))
      return null;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)
      return null;
    return {
      label: label as ClassificationLabel,
      confidence: Math.round(confidence),
      rationale: rationale.slice(0, 500),
    };
  } catch {
    return null;
  }
}

async function classifyWithLlm(
  ocrText: string,
): Promise<ClassificationResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const model =
    process.env.ANTHROPIC_CLASSIFICATION_MODEL?.trim() ||
    "claude-sonnet-4-6";
  const excerpt = ocrText.slice(0, 12_000);

  const client = new Anthropic({ apiKey });
  const userMsg = `Classify this registered-office mail OCR text into exactly one category for operational routing.

Categories (use the label string exactly): ${CLASSIFICATION_LABELS.join(", ")}

Return ONLY a JSON object (no markdown) with keys: "label", "confidence" (0-100 integer), "rationale" (one short sentence).

OCR text:
---
${excerpt}
---`;

  const resp = await client.messages.create({
    model,
    max_tokens: 256,
    messages: [{ role: "user", content: userMsg }],
  });

  const block = resp.content[0];
  const text = block?.type === "text" ? block.text : "";
  const parsed = parseLlmJson(text);
  if (!parsed?.label || parsed.confidence === undefined) return null;

  return {
    label: parsed.label,
    confidence: parsed.confidence,
    method: "llm",
    rationale: parsed.rationale || "LLM classification",
  };
}

/**
 * Rules first; optional Anthropic LLM when rules confidence is below threshold.
 */
export async function classifyDocumentFromOcr(
  ocrText: string,
): Promise<ClassificationResult> {
  const rules = classifyDocumentFromOcrRules(ocrText);

  const thresholdRaw = process.env.CLASSIFICATION_LLM_THRESHOLD?.trim() ?? "90";
  const parsedThreshold = Number.parseInt(thresholdRaw, 10);
  const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 90;
  const useLlm = process.env.CLASSIFICATION_USE_LLM === "true";

  if (!useLlm || rules.confidence >= threshold) {
    return rules;
  }

  try {
    const llm = await classifyWithLlm(ocrText);
    if (!llm) return rules;

    return {
      ...llm,
      method: "rules_then_llm",
      rationale: `LLM: ${llm.rationale} | Prior rules: ${rules.label}@${rules.confidence}%`,
    };
  } catch {
    return {
      ...rules,
      rationale: `${rules.rationale} (LLM classification skipped or failed.)`,
    };
  }
}
