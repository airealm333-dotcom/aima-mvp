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
  contactName: string | null;
  email: string;
  resolutionMethod:
    | "primary_contact"
    | "secondary_contact"
    | "company_email"
    | "not_found";
  accountingManagerEmail: string | null;
  accountingManagerName: string | null;
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

/**
 * Child contacts (parent_id set) get resolved to their parent company ID.
 * Deduplicates by resolved ID, keeping the highest score per company.
 * This collapses e.g. "SHN BV" (child, score 86) into the parent
 * "SHN Investments Pte. Ltd." so the match isn't split across two candidates.
 */
function resolveToParents(
  rows: Record<string, unknown>[],
  candidates: OdooPartnerCandidate[],
): OdooPartnerCandidate[] {
  const parentMap = new Map<number, number>();
  for (const r of rows) {
    const id = typeof r.id === "number" ? r.id : Number(r.id);
    const raw = r.parent_id;
    let parentId: number | null = null;
    if (Array.isArray(raw) && typeof raw[0] === "number") parentId = raw[0];
    else if (typeof raw === "number" && raw > 0) parentId = raw;
    if (parentId) parentMap.set(id, parentId);
  }
  const merged = new Map<number, OdooPartnerCandidate>();
  for (const c of candidates) {
    const resolvedId = parentMap.get(c.id) ?? c.id;
    const existing = merged.get(resolvedId);
    if (!existing || c.score > existing.score) {
      merged.set(resolvedId, { id: resolvedId, score: c.score, name: c.name });
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
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

  // Strip trailing " - X" patterns (vessel/project/category suffixes added by LLM extraction).
  // E.g. "SU-NAV MARINE - SUBARNAREKH" → "SU-NAV MARINE". Only splits on " - " (with spaces),
  // so hyphenated words like "SU-NAV" are preserved.
  const stripSuffix = (s: string | null): string | null => {
    if (!s) return s;
    const parts = s.split(/\s+-\s+/);
    if (parts.length > 1 && parts[0] && parts[0].trim().length >= 3) {
      return parts[0].trim();
    }
    return s;
  };
  inputs = {
    ...inputs,
    legalName: stripSuffix(inputs.legalName),
    tradingName: stripSuffix(inputs.tradingName),
  };

  const { fieldUen, fieldLegal, fieldTrading, fuzzyCandidateLimit } = cfg;

  const fields = ["id", "name", fieldUen, fieldLegal, fieldTrading, "parent_id"].filter(
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

      if (exactHits.length > 0) {
        const ranked: OdooPartnerCandidate[] = exactHits.map((p) => {
          const id = typeof p.id === "number" ? p.id : Number(p.id);
          return { id, score: 100, name: partnerField(p, "name") ?? `#${id}` };
        });
        const resolved = resolveToParents(rows, ranked);
        console.log(
          `[odoo-match] tier2 exact hits (norms=[${uniqueNorms.join(",")}]) raw=${exactHits.length} resolved=${resolved.length}:`,
          resolved.slice(0, 5).map((r) => `id=${r.id} name="${r.name}"`).join(" | "),
        );
        if (resolved.length === 1) {
          return {
            status: "matched",
            partnerId: resolved[0]!.id,
            score: 100,
            method: "legal_exact",
            candidates: resolved,
          };
        }
        return {
          status: "ambiguous",
          partnerId: null,
          score: 100,
          method: "legal_exact",
          candidates: resolved.slice(0, 8),
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

  // Collect all meaningful tokens (≥3 chars) from legal + trading names
  const allTokens = [
    ...(legalNorm ? legalNorm.split(/\s+/).filter((t) => t.length >= 3) : []),
    ...(tradingNorm ? tradingNorm.split(/\s+/).filter((t) => t.length >= 3) : []),
  ];
  const uniqueTokens = [...new Set(allTokens)];

  let rows: Record<string, unknown>[] = [];
  let searchStrategy = "none";

  // Strategy 1 — token-AND search: each token must appear in legal OR trading OR name
  if (uniqueTokens.length > 0) {
    const domainParts: unknown[] = [];
    for (const token of uniqueTokens) {
      const like = `%${token}%`;
      domainParts.push(
        "|",
        "|",
        [fieldLegal, "ilike", like],
        [fieldTrading, "ilike", like],
        ["name", "ilike", like],
      );
    }
    try {
      rows = await client.searchReadPartners(
        uid,
        domainParts,
        fields,
        fuzzyCandidateLimit,
      );
      if (rows.length > 0) searchStrategy = `token_and[${uniqueTokens.join(",")}]`;
    } catch {
      rows = [];
    }
  }

  // Strategy 2 — fall back to single longest-token needle
  if (rows.length === 0) {
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

    rows = await client.searchReadPartners(
      uid,
      fuzzyDomain,
      fields,
      fuzzyCandidateLimit,
    );
    searchStrategy = `needle[${needle}]`;
  }

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

  const resolved = resolveToParents(rows, scored);

  console.log(
    `[odoo-match] fuzzy candidates after resolve (strategy=${searchStrategy}, query="${primaryNorm}"):`,
    resolved.slice(0, 5).map((r) => `id=${r.id} score=${r.score} name="${r.name}"`).join(" | "),
  );

  const decision = decideFromRankedScores(
    resolved.map((s) => ({ id: s.id, score: s.score })),
    "fuzzy_name",
  );

  return toResult(decision, resolved);
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

function extractPlainEmail(raw: string): string | null {
  // RFC 2822 "Display Name" <email> or <email>
  const angleMatch = raw.match(/<([^>]+)>/);
  if (angleMatch) raw = angleMatch[1];
  const t = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  // Handle multiple addresses separated by ; or ,
  const first = t.split(/[;,]/)[0];
  return extractPlainEmail(first ?? t);
}

/**
 * Contact resolution priority:
 * 1) Primary contact — child partner with x_ro_mail_recipient=true
 * 2) Secondary contact — any other child partner with a valid email
 * 3) Company email fallback — email field on the company record itself
 * 4) not_found
 *
 * Contacts are fetched two ways and merged (deduped by id):
 *   a) Via company's child_ids field (reads what Odoo itself considers children)
 *   b) Via parent_id search (catches contacts not listed in child_ids)
 */
export async function resolveOdooRecipientContact(input: {
  client: OdooJsonRpcClient;
  uid: number;
  cfg: OdooMatchEnvConfig;
  partnerId: number;
}): Promise<OdooResolvedContact> {
  const roFlagField = "x_ro_mail_recipient";
  const contactFields = ["id", "name", "email", roFlagField, "active", "parent_id"];

  // Fetch parent company: email + child_ids + user_id (for accounting manager)
  const parentRows = await input.client.searchReadPartners(
    input.uid,
    [["id", "=", input.partnerId]],
    ["id", "name", "email", "user_id", "child_ids"],
    1,
  );
  const parent = parentRows[0];

  const { accountingManagerEmail, accountingManagerName } =
    await resolveAccountingManager(input.client, input.uid, parent);

  // --- Gather child contacts via two paths ---
  const seenIds = new Set<number>();
  const allChildRows: Record<string, unknown>[] = [];

  const mergeRows = (rows: Record<string, unknown>[]) => {
    for (const r of rows) {
      const id = typeof r.id === "number" ? r.id : Number(r.id);
      if (Number.isFinite(id) && !seenIds.has(id)) {
        seenIds.add(id);
        allChildRows.push(r);
      }
    }
  };

  // Path A: use child_ids from parent record
  const childIds = Array.isArray(parent?.child_ids)
    ? (parent.child_ids as unknown[]).filter((v) => typeof v === "number")
    : [];
  if (childIds.length > 0) {
    const rows = await input.client.searchReadPartners(
      input.uid,
      [["id", "in", childIds]],
      contactFields,
      200,
    );
    mergeRows(rows);
  }

  // Path B: parent_id search (catches contacts not listed in child_ids)
  const byParent = await input.client.searchReadPartners(
    input.uid,
    [["parent_id", "=", input.partnerId]],
    contactFields,
    200,
  );
  mergeRows(byParent);

  console.log(`[D4] partnerId=${input.partnerId} contacts found: ${allChildRows.length} (child_ids=${childIds.length}, parent_id_search=${byParent.length})`);

  // --- Apply priority ---
  const withEmail = allChildRows
    .map((r) => ({
      id: typeof r.id === "number" ? r.id : Number(r.id),
      name: typeof r.name === "string" ? r.name : null,
      email: normalizeEmail(r.email),
      isPrimary: isTruthy(r[roFlagField]),
    }))
    .filter((r) => Number.isFinite(r.id) && r.email != null) as Array<{
    id: number;
    name: string | null;
    email: string;
    isPrimary: boolean;
  }>;

  // 1) Primary contact (x_ro_mail_recipient = true)
  const primary = withEmail.find((r) => r.isPrimary);
  if (primary) {
    console.log(`[D4] partnerId=${input.partnerId} → primary_contact "${primary.name}" <${primary.email}>`);
    return {
      contactId: primary.id,
      contactName: primary.name ?? null,
      email: primary.email,
      resolutionMethod: "primary_contact",
      accountingManagerEmail,
      accountingManagerName,
    };
  }

  // 2) Secondary contact (any child with valid email)
  const secondary = withEmail[0];
  if (secondary) {
    console.log(`[D4] partnerId=${input.partnerId} → secondary_contact "${secondary.name}" <${secondary.email}>`);
    return {
      contactId: secondary.id,
      contactName: secondary.name ?? null,
      email: secondary.email,
      resolutionMethod: "secondary_contact",
      accountingManagerEmail,
      accountingManagerName,
    };
  }

  // 3) Company email fallback — use company name as contact name
  const companyEmail = normalizeEmail(parent?.email);
  if (parent && companyEmail) {
    const id = typeof parent.id === "number" ? parent.id : Number(parent.id);
    const companyName = typeof parent.name === "string" ? parent.name : null;
    console.log(`[D4] partnerId=${input.partnerId} → company_email <${companyEmail}>`);
    return {
      contactId: Number.isFinite(id) ? id : null,
      contactName: companyName,
      email: companyEmail,
      resolutionMethod: "company_email",
      accountingManagerEmail,
      accountingManagerName,
    };
  }

  console.log(`[D4] partnerId=${input.partnerId} → not_found`);
  return {
    contactId: null,
    contactName: null,
    email: "",
    resolutionMethod: "not_found",
    accountingManagerEmail,
    accountingManagerName,
  };
}

/**
 * Resolves the accounting manager (user_id on the partner's Sales & Purchase tab).
 * user_id is a Many2One — Odoo returns [id, "Name"] or false.
 * We read res.users to get their login (email) and name.
 */
async function resolveAccountingManager(
  client: OdooJsonRpcClient,
  uid: number,
  partner: Record<string, unknown> | undefined,
): Promise<{ accountingManagerEmail: string | null; accountingManagerName: string | null }> {
  if (!partner) return { accountingManagerEmail: null, accountingManagerName: null };

  const userId = partner.user_id;
  // Many2One comes back as [id, "Name"] or false
  const rawId = Array.isArray(userId) ? userId[0] : null;
  const rawName = Array.isArray(userId) && userId.length > 1 ? String(userId[1]) : null;
  const userIdNum = typeof rawId === "number" ? rawId : typeof rawId === "string" ? Number(rawId) : null;

  if (!userIdNum || !Number.isFinite(userIdNum)) {
    return { accountingManagerEmail: null, accountingManagerName: null };
  }

  try {
    const userRows = await client.searchRead(
      uid,
      "res.users",
      [["id", "=", userIdNum]],
      ["id", "login", "name"],
      1,
    );
    const user = userRows[0];
    if (!user) return { accountingManagerEmail: null, accountingManagerName: rawName };

    const email = normalizeEmail(user.login) ?? normalizeEmail(user.email);
    const name = typeof user.name === "string" ? user.name.trim() : rawName;
    console.log(`[D4] Accounting manager: ${name ?? "?"} <${email ?? "no email"}> (user_id=${userIdNum})`);
    return {
      accountingManagerEmail: email ?? null,
      accountingManagerName: name ?? null,
    };
  } catch {
    return { accountingManagerEmail: null, accountingManagerName: rawName };
  }
}
