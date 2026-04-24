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
  /** Null if ODOO_FIELD_LEGAL_NAME is empty — skip legal-name searches entirely. */
  fieldLegal: string | null;
  /** Null if ODOO_FIELD_TRADING_NAME is empty — skip trading-name searches entirely. */
  fieldTrading: string | null;
  /** Null if ODOO_FIELD_RO_MAIL_RECIPIENT is empty — skip primary-contact detection. */
  fieldRoMailRecipient: string | null;
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

/** Returns a valid field name, or null if the env var is intentionally empty. */
function optionalFieldName(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  return /^[a-zA-Z0-9_.]+$/.test(t) ? t : null;
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
    fieldUen: safeFieldName(
      process.env.ODOO_FIELD_UEN ?? "",
      "l10n_sg_unique_entity_number",
    ),
    fieldLegal: optionalFieldName(process.env.ODOO_FIELD_LEGAL_NAME),
    fieldTrading: optionalFieldName(process.env.ODOO_FIELD_TRADING_NAME),
    fieldRoMailRecipient: optionalFieldName(process.env.ODOO_FIELD_RO_MAIL_RECIPIENT),
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

  // Strip trailing " - X" vessel/project/category suffixes added by LLM extraction.
  // Handles variants: " - X", ". - X", ".- X", ",- X", etc.
  // The dash must be followed by whitespace so inner hyphens like "SU-NAV" are preserved
  // (letters before the dash never match `[.\s,;]`).
  const stripSuffix = (s: string | null): string | null => {
    if (!s) return s;
    const m = s.match(/^(.+?)[.\s,;]+-\s+.+$/);
    if (m && m[1] && m[1].trim().length >= 3) {
      return m[1].trim();
    }
    return s;
  };
  inputs = {
    ...inputs,
    legalName: stripSuffix(inputs.legalName),
    tradingName: stripSuffix(inputs.tradingName),
  };

  const { fieldUen, fieldLegal, fieldTrading, fuzzyCandidateLimit } = cfg;

  const fields = [
    "id",
    "name",
    fieldUen,
    fieldLegal,
    fieldTrading,
    "parent_id",
  ].filter((v): v is string => Boolean(v)).filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  // Tier 1: UEN — check custom field AND Odoo's Singapore localization field
  if (inputs.uen) {
    const domain = [
      "|",
      [fieldUen, "=", inputs.uen],
      ["l10n_sg_unique_entity_number", "=", inputs.uen],
    ];
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
      // that were removed by normalization. Skip empty field configs.
      const pattern = `%${n}%`;
      if (fieldLegal) orBranches.push([fieldLegal, "ilike", pattern]);
      if (fieldTrading) orBranches.push([fieldTrading, "ilike", pattern]);
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
          fieldLegal ? partnerField(p, fieldLegal) : null,
          fieldTrading ? partnerField(p, fieldTrading) : null,
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
      const branches: unknown[] = [];
      if (fieldLegal) branches.push([fieldLegal, "ilike", like]);
      if (fieldTrading) branches.push([fieldTrading, "ilike", like]);
      branches.push(["name", "ilike", like]);
      for (let i = 0; i < branches.length - 1; i += 1) domainParts.push("|");
      for (const b of branches) domainParts.push(b);
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
    const fuzzyDomain: unknown[] = [];
    const fuzzyBranches: unknown[] = [];
    if (fieldLegal) fuzzyBranches.push([fieldLegal, "ilike", like]);
    if (fieldTrading) fuzzyBranches.push([fieldTrading, "ilike", like]);
    fuzzyBranches.push(["name", "ilike", like]);
    for (let i = 0; i < fuzzyBranches.length - 1; i += 1) fuzzyDomain.push("|");
    for (const b of fuzzyBranches) fuzzyDomain.push(b);

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
    const pLegal = fieldLegal ? partnerField(p, fieldLegal) : null;
    const pTrade = fieldTrading ? partnerField(p, fieldTrading) : null;
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
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t;
  // Salvage corrupted double-email strings like "a@b.comfinance@b.com" —
  // extract the first valid-looking email pattern.
  const m = t.match(/[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
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
  const roFlagField = input.cfg.fieldRoMailRecipient;
  const contactFields = ["id", "name", "email", "active", "parent_id"];
  if (roFlagField) contactFields.push(roFlagField);

  // Fetch parent company: email + child_ids + user_id (for accounting manager) +
  // customer_contact_ids and signing_authority_ids (alternative contact storage).
  const parentRows = await input.client.searchReadPartners(
    input.uid,
    [["id", "=", input.partnerId]],
    [
      "id",
      "name",
      "email",
      "user_id",
      "child_ids",
      "customer_contact_ids",
      "signing_authority_ids",
    ],
    1,
  );
  const parent = parentRows[0];

  const { accountingManagerEmail, accountingManagerName } =
    await resolveAccountingManager(input.client, input.uid, parent);

  // --- Gather contacts separately by source so we can prioritize real children ---
  type ContactRow = { row: Record<string, unknown>; source: "child" | "alt" };
  const seenIds = new Set<number>();
  const childContacts: ContactRow[] = [];
  const altContacts: ContactRow[] = [];

  const push = (rows: Record<string, unknown>[], source: "child" | "alt") => {
    for (const r of rows) {
      const id = typeof r.id === "number" ? r.id : Number(r.id);
      if (!Number.isFinite(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      (source === "child" ? childContacts : altContacts).push({ row: r, source });
    }
  };

  // Fetches include archived records (active_test: false) because this Odoo
  // tenant's contacts are often archived but still the correct email recipient.
  const fetchContacts = async (domain: unknown[]): Promise<Record<string, unknown>[]> => {
    const result = await input.client.executeKw(
      input.uid,
      "res.partner",
      "search_read",
      [domain],
      { fields: contactFields, limit: 200, context: { active_test: false } },
    );
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
  };

  // Path A: child_ids on parent record
  const childIds = Array.isArray(parent?.child_ids)
    ? (parent.child_ids as unknown[]).filter((v) => typeof v === "number")
    : [];
  if (childIds.length > 0) {
    push(await fetchContacts([["id", "in", childIds]]), "child");
  }

  // Path B: parent_id search (catches children not listed in child_ids)
  const byParent = await fetchContacts([["parent_id", "=", input.partnerId]]);
  push(byParent, "child");

  // Path C: signing_authority_ids (these are the authorized mail recipients —
  // the "[primary]" badge in Odoo's UI comes from the first-listed entry here)
  // then customer_contact_ids as a fallback.
  // ORDER MATTERS — we preserve the Odoo-supplied sequence so the first signatory
  // is the one we pick. Odoo's search_read returns records in id order by default,
  // which is NOT what we want.
  const collectIds = (key: "customer_contact_ids" | "signing_authority_ids"): number[] => {
    const raw = parent?.[key];
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const v of raw) {
      if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    }
    return out;
  };

  const signingIds = collectIds("signing_authority_ids");
  const customerIds = collectIds("customer_contact_ids");
  // Signing authorities first (preserving list order), then customer contacts
  // (also preserving order). Dedupe while keeping first occurrence.
  const orderedAltIds: number[] = [];
  const altSeen = new Set<number>();
  for (const id of [...signingIds, ...customerIds]) {
    if (!altSeen.has(id)) {
      altSeen.add(id);
      orderedAltIds.push(id);
    }
  }
  const altContactIds = orderedAltIds;
  if (altContactIds.length > 0) {
    const altRowsUnordered = await fetchContacts([["id", "in", altContactIds]]);
    // Re-order by the sequence in orderedAltIds so the first signatory wins
    const byId = new Map<number, Record<string, unknown>>();
    for (const r of altRowsUnordered) {
      const id = typeof r.id === "number" ? r.id : Number(r.id);
      if (Number.isFinite(id)) byId.set(id, r);
    }
    const altRowsOrdered: Record<string, unknown>[] = [];
    for (const id of orderedAltIds) {
      const r = byId.get(id);
      if (r) altRowsOrdered.push(r);
    }
    push(altRowsOrdered, "alt");
  }

  console.log(
    `[D4] partnerId=${input.partnerId} contacts found: child=${childContacts.length} alt=${altContacts.length} (child_ids=${childIds.length}, parent_id_search=${byParent.length}, alt_contact_ids=${altContactIds.length})`,
  );

  const toContact = (r: Record<string, unknown>) => ({
    id: typeof r.id === "number" ? r.id : Number(r.id),
    name: typeof r.name === "string" ? r.name : null,
    email: normalizeEmail(r.email),
    isPrimary: roFlagField ? isTruthy(r[roFlagField]) : false,
  });

  const childWithEmail = childContacts
    .map(({ row }) => toContact(row))
    .filter((r) => Number.isFinite(r.id) && r.email != null) as Array<{
    id: number; name: string | null; email: string; isPrimary: boolean;
  }>;

  const altWithEmail = altContacts
    .map(({ row }) => toContact(row))
    .filter((r) => Number.isFinite(r.id) && r.email != null) as Array<{
    id: number; name: string | null; email: string; isPrimary: boolean;
  }>;

  // 1) Primary contact flag (among children only — alt contacts are unreliable)
  const primary = childWithEmail.find((r) => r.isPrimary);
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

  // 2) Secondary — any real child with a valid email
  const secondary = childWithEmail[0];
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

  // 3) Company email — in this Odoo tenant, the partner's `email` field is
  // typically the primary contact's email set correctly. Preferred over
  // customer_contact_ids/signing_authority_ids which often contain unrelated
  // records added by the custom contacts module.
  const companyEmail = normalizeEmail(parent?.email);
  if (parent && companyEmail) {
    const id = typeof parent.id === "number" ? parent.id : Number(parent.id);
    const companyName = typeof parent.name === "string" ? parent.name : null;

    // Look up any person (is_company=false) whose own email matches the company
    // email — that's the "primary contact" whose name we can use for the greeting.
    // This lets the email body say "Dear Ankur Pahuja" instead of "Dear Sir/Madam".
    let personName: string | null = null;
    let personId: number | null = null;
    try {
      const matches = (await input.client.executeKw(
        input.uid,
        "res.partner",
        "search_read",
        [[
          ["email", "=ilike", companyEmail],
          ["is_company", "=", false],
        ]],
        {
          fields: ["id", "name"],
          limit: 5,
          context: { active_test: false },
        },
      )) as Array<{ id: number; name: string }>;
      // Prefer a match whose name doesn't look like an email (sometimes records have
      // their name set to the email itself — skip those).
      const person = matches.find(
        (m) => typeof m.name === "string" && m.name.trim() && !m.name.includes("@"),
      );
      if (person) {
        personName = person.name;
        personId = typeof person.id === "number" ? person.id : Number(person.id);
      }
    } catch (e) {
      // Non-fatal — fall back to company name
      console.log(
        `[D4] partnerId=${input.partnerId} person lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (personName) {
      console.log(
        `[D4] partnerId=${input.partnerId} → company_email <${companyEmail}> (contact="${personName}")`,
      );
      return {
        contactId: personId ?? (Number.isFinite(id) ? id : null),
        contactName: personName,
        email: companyEmail,
        // Use "primary_contact" so the email template picks up the contact name
        // for the "Dear <name>" greeting line.
        resolutionMethod: "primary_contact",
        accountingManagerEmail,
        accountingManagerName,
      };
    }

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

  // 4) Last resort — alt contact from customer_contact_ids / signing_authority_ids.
  // Only reached if the company has no children AND no email set at all.
  const altFallback = altWithEmail[0];
  if (altFallback) {
    console.log(`[D4] partnerId=${input.partnerId} → alt_contact "${altFallback.name}" <${altFallback.email}> (last resort — no company email)`);
    return {
      contactId: altFallback.id,
      contactName: altFallback.name ?? null,
      email: altFallback.email,
      resolutionMethod: "secondary_contact",
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
