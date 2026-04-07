/**
 * Pure helpers for Odoo SOP D3 client matching (tests cover these; no network).
 */

const UEN_LABEL_RE = /\bUEN\b\s*[:-]?\s*([A-Z0-9]{5,15})\b/i;
/** Rough SG UEN / registration id shapes (not exhaustive). */
const UEN_STANDALONE_RES: RegExp[] = [
  /\b(\d{8}[A-Z]\d{4}[A-Z])\b/i,
  /\b(\d{9,10}[A-Z])\b/i,
  /\b([TS]\d{2}[A-Z]{2}\d{4}[A-Z])\b/i,
];

export function normalizeUen(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[\s-]/g, "").toUpperCase();
  return s.length >= 5 ? s : null;
}

/** Collapse whitespace; lowercase; strip most punctuation for comparison. */
export function normalizeOrgName(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let s = String(raw)
    .toLowerCase()
    .replace(/[.,'"()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(
    /\b(pte|ltd|limited|llp|llc|inc|corp|corporation|co)\b\.?/gi,
    "",
  );
  s = s.replace(/\s+/g, " ").trim();
  return s.length >= 2 ? s : null;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n] as number;
}

/** Similarity 0–100 (higher is closer). */
export function stringSimilarityPercent(a: string, b: string): number {
  if (a === b) return 100;
  const maxLen = Math.max(a.length, b.length, 1);
  const dist = levenshtein(a, b);
  return Math.round(100 * (1 - dist / maxLen));
}

/** Best score against several normalized targets. */
export function bestNameScore(
  queryNorm: string,
  candidates: Array<string | null | undefined>,
): number {
  let best = 0;
  for (const c of candidates) {
    const n = typeof c === "string" ? normalizeOrgName(c) : null;
    if (!n) continue;
    const s = stringSimilarityPercent(queryNorm, n);
    if (s > best) best = s;
  }
  return best;
}

export function extractUenFromText(
  text: string | null | undefined,
): string | null {
  if (text == null || !text.trim()) return null;
  const m = text.match(UEN_LABEL_RE);
  if (m?.[1]) return normalizeUen(m[1]);
  for (const re of UEN_STANDALONE_RES) {
    const mm = text.match(re);
    if (mm?.[1]) return normalizeUen(mm[1]);
  }
  return null;
}

/** Longest token ≥3 chars for ilike needle (Tier 3). */
export function pickFuzzyNeedle(normalizedName: string): string | null {
  const parts = normalizedName.split(/\s+/).filter((p) => p.length >= 3);
  if (parts.length === 0) return null;
  parts.sort((a, b) => b.length - a.length);
  return parts[0] ?? null;
}

export type MatchBand = "high" | "mid" | "low";

/** SOP bands: ≥92 high, 85–91 mid, &lt;85 low. */
export function scoreToBand(score: number): MatchBand {
  if (score >= 92) return "high";
  if (score >= 85) return "mid";
  return "low";
}

export type TierDecision =
  | { kind: "matched"; partnerId: number; score: number; method: string }
  | { kind: "ambiguous"; topScore: number; method: string }
  | { kind: "no_match"; bestScore: number; method: string };

const TIE_EPSILON = 1;

/**
 * Decide outcome from ranked candidates (same score ordering as Odoo tier).
 * - high + clear winner → matched
 * - high but near-tie → ambiguous
 * - mid band → ambiguous
 * - low → no_match
 */
export function decideFromRankedScores(
  ranked: Array<{ id: number; score: number }>,
  method: string,
): TierDecision {
  if (ranked.length === 0) {
    return { kind: "no_match", bestScore: 0, method };
  }

  const top = ranked[0];
  if (!top) return { kind: "no_match", bestScore: 0, method };
  const second = ranked[1];

  const band = scoreToBand(top.score);

  if (band === "low") {
    return { kind: "no_match", bestScore: top.score, method };
  }

  if (band === "mid") {
    // Single candidate in mid band is still a reasonable match
    if (ranked.length === 1) {
      return { kind: "matched", partnerId: top.id, score: top.score, method };
    }
    return { kind: "ambiguous", topScore: top.score, method };
  }

  // high
  if (
    second != null &&
    top.score - second.score <= TIE_EPSILON &&
    second.score >= 85
  ) {
    return { kind: "ambiguous", topScore: top.score, method };
  }

  return {
    kind: "matched",
    partnerId: top.id,
    score: top.score,
    method,
  };
}
