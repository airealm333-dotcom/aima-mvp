import { OdooJsonRpcClient } from "@/lib/odoo-jsonrpc";
import {
  bestNameScore,
  decideFromRankedScores,
  extractUenFromText,
  normalizeOrgName,
  normalizeUen,
  pickFuzzyNeedle,
  type TierDecision,
} from "@/lib/odoo-match-helpers";

export type OdooMatchEnvConfig = {
  baseUrl: string;
  db: string;
  username: string;
  password: string;
  timeoutMs: number;
  fieldUen: string;
  fieldLegal: string;
  fieldTrading: string;
  fuzzyCandidateLimit: number;
};

export type ClientMatchInputs = {
  uen: string | null;
  legalName: string | null;
  tradingName: string | null;
};

export type OdooPartnerCandidate = { id: number; score: number; name: string };

export type OdooClientMatchStatus =
  | "matched"
  | "ambiguous"
  | "no_match"
  | "skipped"
  | "error";

export type OdooClientMatchResult = {
  status: OdooClientMatchStatus;
  partnerId: number | null;
  score: number | null;
  method: string | null;
  candidates: OdooPartnerCandidate[];
};

export type OdooResolvedContact = {
  contactId: number | null;
  email: string;
  resolutionMethod:
    | "child_ro_flag"
    | "child_any_email"
    | "company_email"
    | "not_found";
};

function safeFieldName(raw: string, fallback: string): string {
  const t = raw.trim();
  return /^[a-zA-Z0-9_.]+$/.test(t) ? t : fallback;
}

function parsePositiveInt(raw: string | undefined, defaultVal: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultVal;
}

export function loadOdooMatchConfigFromEnv(): OdooMatchEnvConfig | null {
  if (process.env.ODOO_MATCH_ENABLED !== "true") return null;

  const baseUrl = (process.env.ODOO_URL ?? "").trim();
  const db = (process.env.ODOO_DB ?? "").trim();
  const username = (process.env.ODOO_USERNAME ?? "").trim();
  const password = (process.env.ODOO_API_KEY ?? "").trim();

  if (!baseUrl || !db || !username || !password) return null;

  return {
    baseUrl,
    db,
    username,
    password,
    timeoutMs: parsePositiveInt(process.env.ODOO_JSONRPC_TIMEOUT_MS, 20_000),
    fieldUen: safeFieldName(process.env.ODOO_FIELD_UEN ?? "", "x_uen"),
    fieldLegal: safeFieldName(
      process.env.ODOO_FIELD_LEGAL_NAME ?? "",
      "x_legal_name",
    ),
    fieldTrading: safeFieldName(
      process.env.ODOO_FIELD_TRADING_NAME ?? "",
      "x_trading_name",
    ),
    fuzzyCandidateLimit: parsePositiveInt(
      process.env.ODOO_FUZZY_CANDIDATE_LIMIT,
      120,
    ),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function buildClientMatchInputs(
  entitiesRow: Record<string, unknown>,
  ocrText: string,
): ClientMatchInputs {
  const recipientUen = str(entitiesRow.recipient_uen);
  const uen = normalizeUen(recipientUen) ?? extractUenFromText(ocrText);

  // Convention for SOP D3 client matching:
  // - `organization_name` is the main legal entity (captured from OCR/LLM).
  // - `recipient_name` is often the counterpart/trading entity name.
  const legalName =
    str(entitiesRow.organization_name) ??
    str(entitiesRow.respondent_name) ??
    str(entitiesRow.account_name) ??
    null;

  const tradingName =
    str(entitiesRow.recipient_name) ??
    str(entitiesRow.contact_person_name) ??
    null;

  return { uen, legalName, tradingName };
}

function partnerField(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return str(v);
}

function toResult(
  decision: TierDecision,
  rankedForAudit: OdooPartnerCandidate[],
): OdooClientMatchResult {
  if (decision.kind === "matched") {
    return {
      status: "matched",
      partnerId: decision.partnerId,
      score: decision.score,
      method: decision.method,
      candidates: rankedForAudit.slice(0, 8),
    };
  }
  if (decision.kind === "ambiguous") {
    return {
      status: "ambiguous",
      partnerId: null,
      score: decision.topScore,
      method: decision.method,
      candidates: rankedForAudit.slice(0, 8),
    };
  }
  return {
    status: "no_match",
    partnerId: null,
    score: decision.bestScore,
    method: decision.method,
    candidates: rankedForAudit.slice(0, 8),
  };
}

function hasAnyIdentifier(inputs: ClientMatchInputs): boolean {
  return Boolean(
    inputs.uen ||
      normalizeOrgName(inputs.legalName) ||
      normalizeOrgName(inputs.tradingName),
  );
}

/** Odoo prefix-OR: N leaves require N-1 leading `'|'`. */
function buildOrDomain(conditions: unknown[]): unknown[] {
  if (conditions.length === 0) return [];
  if (conditions.length === 1) return conditions as unknown[];
  const pipes: unknown[] = [];
  for (let i = 0; i < conditions.length - 1; i++) pipes.push("|");
  return [...pipes, ...conditions];
}

/**
 * Runs UEN → exact legal → fuzzy name against Odoo (caller supplies authenticated uid).
 */
export async function runOdooClientMatch(
  client: OdooJsonRpcClient,
  uid: number,
  cfg: OdooMatchEnvConfig,
  inputs: ClientMatchInputs,
): Promise<OdooClientMatchResult> {
  if (!hasAnyIdentifier(inputs)) {
    return {
      status: "skipped",
      partnerId: null,
      score: null,
      method: "skipped",
      candidates: [],
    };
  }

  const { fieldUen, fieldLegal, fieldTrading, fuzzyCandidateLimit } = cfg;

  const fields = ["id", "name", fieldUen, fieldLegal, fieldTrading].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  // Tier 1: UEN
  if (inputs.uen) {
    const domain = [[fieldUen, "=", inputs.uen]];
    const rows = await client.searchReadPartners(uid, domain, fields, 20);
    const ids = rows
      .map((r) => (typeof r.id === "number" ? r.id : Number(r.id)))
      .filter((id) => Number.isFinite(id));

    if (ids.length === 1) {
      const p = rows[0];
      if (!p) throw new Error("Unexpected empty Odoo rows for UEN match");
      const id = typeof p.id === "number" ? p.id : Number(p.id);
      return {
        status: "matched",
        partnerId: id,
        score: 100,
        method: "uen_exact",
        candidates: [
          {
            id,
            score: 100,
            name: partnerField(p, "name") ?? `#${id}`,
          },
        ],
      };
    }

    if (ids.length > 1) {
      const ranked: OdooPartnerCandidate[] = rows.map((p) => {
        const id = typeof p.id === "number" ? p.id : Number(p.id);
        return {
          id,
          score: 100,
          name: partnerField(p, "name") ?? `#${id}`,
        };
      });
      return {
        status: "ambiguous",
        partnerId: null,
        score: 100,
        method: "uen_exact",
        candidates: ranked.slice(0, 8),
      };
    }
  }

  const legalNorm = normalizeOrgName(inputs.legalName);
  const tradingNorm = normalizeOrgName(inputs.tradingName);

  // Tier 2: exact normalized legal / trading match
  if (legalNorm || tradingNorm) {
    const orBranches: unknown[] = [];
    const norms = [legalNorm, tradingNorm].filter(Boolean) as string[];
    const uniqueNorms = [...new Set(norms)];

    for (const n of uniqueNorms) {
      // Use wildcards so we still fetch candidates when Odoo stores punctuation/suffixes
      // that were removed by normalization.
      const pattern = `%${n}%`;
      orBranches.push([fieldLegal, "ilike", pattern]);
      orBranches.push([fieldTrading, "ilike", pattern]);
      orBranches.push(["name", "ilike", pattern]);
    }

    if (orBranches.length > 0) {
      const domain = buildOrDomain(orBranches);
      const rows = await client.searchReadPartners(
        uid,
        domain,
        fields,
        Math.min(80, fuzzyCandidateLimit),
      );

      const exactHits = rows.filter((p) => {
        const parts = [
          partnerField(p, fieldLegal),
          partnerField(p, fieldTrading),
          partnerField(p, "name"),
        ];
        for (const target of uniqueNorms) {
          for (const part of parts) {
            const pn = normalizeOrgName(part);
            if (pn && pn === target) return true;
          }
        }
        return false;
      });

      if (exactHits.length === 1) {
        const p = exactHits[0];
        if (!p) {
          throw new Error(
            "Unexpected empty Odoo rows for exact normalized name match",
          );
        }
        const id = typeof p.id === "number" ? p.id : Number(p.id);
        return {
          status: "matched",
          partnerId: id,
          score: 100,
          method: "legal_exact",
          candidates: [
            {
              id,
              score: 100,
              name: partnerField(p, "name") ?? `#${id}`,
            },
          ],
        };
      }

      if (exactHits.length > 1) {
        const ranked: OdooPartnerCandidate[] = exactHits.map((p) => {
          const id = typeof p.id === "number" ? p.id : Number(p.id);
          return {
            id,
            score: 100,
            name: partnerField(p, "name") ?? `#${id}`,
          };
        });
        return {
          status: "ambiguous",
          partnerId: null,
          score: 100,
          method: "legal_exact",
          candidates: ranked.slice(0, 8),
        };
      }
    }
  }

  // Tier 3: fuzzy
  const primaryNorm = legalNorm ?? tradingNorm;
  if (!primaryNorm) {
    return {
      status: "no_match",
      partnerId: null,
      score: 0,
      method: "fuzzy_name",
      candidates: [],
    };
  }

  let needle = pickFuzzyNeedle(primaryNorm);
  if (!needle && tradingNorm) needle = pickFuzzyNeedle(tradingNorm);
  if (!needle) {
    return {
      status: "no_match",
      partnerId: null,
      score: 0,
      method: "fuzzy_name",
      candidates: [],
    };
  }

  const like = `%${needle}%`;
  const fuzzyDomain: unknown[] = [
    "|",
    "|",
    [fieldLegal, "ilike", like],
    [fieldTrading, "ilike", like],
    ["name", "ilike", like],
  ];

  const rows = await client.searchReadPartners(
    uid,
    fuzzyDomain,
    fields,
    fuzzyCandidateLimit,
  );

  const scored: OdooPartnerCandidate[] = rows.map((p) => {
    const id = typeof p.id === "number" ? p.id : Number(p.id);
    const pLegal = partnerField(p, fieldLegal);
    const pTrade = partnerField(p, fieldTrading);
    const pName = partnerField(p, "name");

    let score = 0;
    if (legalNorm) {
      score = Math.max(
        score,
        bestNameScore(legalNorm, [pLegal, pTrade, pName]),
      );
    }
    if (tradingNorm) {
      score = Math.max(
        score,
        bestNameScore(tradingNorm, [pLegal, pTrade, pName]),
      );
    }
    if (!legalNorm && tradingNorm) {
      score = Math.max(
        score,
        bestNameScore(tradingNorm, [pLegal, pTrade, pName]),
      );
    }

    return {
      id,
      score,
      name: pName ?? `#${id}`,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const decision = decideFromRankedScores(
    scored.map((s) => ({ id: s.id, score: s.score })),
    "fuzzy_name",
  );

  return toResult(decision, scored);
}

export async function authenticateOdooForMatch(
  cfg: OdooMatchEnvConfig,
): Promise<{ client: OdooJsonRpcClient; uid: number }> {
  const client = new OdooJsonRpcClient({
    baseUrl: cfg.baseUrl,
    db: cfg.db,
    username: cfg.username,
    password: cfg.password,
    timeoutMs: cfg.timeoutMs,
  });
  const uid = await client.authenticate();
  return { client, uid };
}

function isTruthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "1" || t === "true" || t === "yes";
  }
  return false;
}

function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return null;
  return t;
}

/**
 * D4 contact resolution:
 * 1) child contacts with x_ro_mail_recipient=true and valid email
 * 2) any child contact with valid email
 * 3) parent company email
 */
export async function resolveOdooRecipientContact(input: {
  client: OdooJsonRpcClient;
  uid: number;
  cfg: OdooMatchEnvConfig;
  partnerId: number;
}): Promise<OdooResolvedContact> {
  const roFlagField = "x_ro_mail_recipient";
  const childDomain: Array<[string, string, unknown]> = [
    ["parent_id", "=", input.partnerId],
    ["active", "=", true],
  ];
  const childFields = [
    "id",
    "name",
    "email",
    roFlagField,
    "active",
    "parent_id",
  ];
  console.log("[D4] Searching for RO contact with:", {
    partnerId: input.partnerId,
    roFlagField,
    query: childDomain,
    fields: childFields,
  });

  const childRows = await input.client.searchReadPartners(
    input.uid,
    childDomain,
    childFields,
    200,
  );
  console.log("[D4] Child contact rows (debug):", {
    count: childRows.length,
    sample: childRows.slice(0, 5).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      parent_id: r.parent_id,
      x_ro_mail_recipient: r.x_ro_mail_recipient,
      x_studio_ro_mail_recipient: r.x_studio_ro_mail_recipient,
    })),
  });

  const withEmail = childRows
    .map((r) => ({
      id: typeof r.id === "number" ? r.id : Number(r.id),
      email: normalizeEmail(r.email),
      roFlag: isTruthy(r[roFlagField]),
    }))
    .filter((r) => Number.isFinite(r.id) && r.email != null) as Array<{
    id: number;
    email: string;
    roFlag: boolean;
  }>;

  const preferred = withEmail.find((r) => r.roFlag);
  if (preferred) {
    return {
      contactId: preferred.id,
      email: preferred.email,
      resolutionMethod: "child_ro_flag",
    };
  }

  const anyChild = withEmail[0];
  if (anyChild) {
    return {
      contactId: anyChild.id,
      email: anyChild.email,
      resolutionMethod: "child_any_email",
    };
  }

  const parentRows = await input.client.searchReadPartners(
    input.uid,
    [["id", "=", input.partnerId]],
    ["id", "email"],
    1,
  );
  const parent = parentRows[0];
  const parentEmail = normalizeEmail(parent?.email);
  if (parent && parentEmail) {
    const id = typeof parent.id === "number" ? parent.id : Number(parent.id);
    return {
      contactId: Number.isFinite(id) ? id : null,
      email: parentEmail,
      resolutionMethod: "company_email",
    };
  }

  return {
    contactId: null,
    email: "",
    resolutionMethod: "not_found",
  };
}
