import { describe, expect, it } from "vitest";
import {
  decideFromRankedScores,
  extractUenFromText,
  normalizeOrgName,
  normalizeUen,
  pickFuzzyNeedle,
  scoreToBand,
  stringSimilarityPercent,
} from "@/lib/odoo-match-helpers";

describe("normalizeUen", () => {
  it("strips spaces and uppercases", () => {
    expect(normalizeUen(" 202134636d ")).toBe("202134636D");
    expect(normalizeUen("12-345-678")).toBe("12345678");
  });

  it("returns null for short or empty", () => {
    expect(normalizeUen("")).toBeNull();
    expect(normalizeUen("ab")).toBeNull();
  });
});

describe("normalizeOrgName", () => {
  it("lowercases and drops common suffix noise", () => {
    expect(normalizeOrgName("ACME  PTE.  LTD.")).toBe("acme");
  });
});

describe("stringSimilarityPercent", () => {
  it("is 100 for identical strings", () => {
    expect(stringSimilarityPercent("foo", "foo")).toBe(100);
  });

  it("scores typos below high band", () => {
    const s = stringSimilarityPercent(
      "acme engineering pte ltd",
      "acme enginering pte ltd",
    );
    expect(s).toBeGreaterThanOrEqual(85);
    expect(s).toBeLessThan(100);
  });
});

describe("scoreToBand", () => {
  it("maps SOP thresholds", () => {
    expect(scoreToBand(92)).toBe("high");
    expect(scoreToBand(91)).toBe("mid");
    expect(scoreToBand(85)).toBe("mid");
    expect(scoreToBand(84)).toBe("low");
  });
});

describe("decideFromRankedScores", () => {
  it("matches when top score is high and second is far below", () => {
    const d = decideFromRankedScores(
      [
        { id: 1, score: 95 },
        { id: 2, score: 70 },
      ],
      "fuzzy_name",
    );
    expect(d.kind).toBe("matched");
    if (d.kind === "matched") expect(d.partnerId).toBe(1);
  });

  it("ambiguous when two high scores tie", () => {
    const d = decideFromRankedScores(
      [
        { id: 1, score: 94 },
        { id: 2, score: 94 },
      ],
      "fuzzy_name",
    );
    expect(d.kind).toBe("ambiguous");
  });

  it("ambiguous in mid band", () => {
    const d = decideFromRankedScores([{ id: 1, score: 88 }], "fuzzy_name");
    expect(d.kind).toBe("ambiguous");
  });

  it("no_match when best is low", () => {
    const d = decideFromRankedScores([{ id: 1, score: 70 }], "fuzzy_name");
    expect(d.kind).toBe("no_match");
  });
});

describe("extractUenFromText", () => {
  it("finds labelled UEN", () => {
    expect(extractUenFromText("Reg No UEN: 202134636D")).toBe("202134636D");
  });
});

describe("pickFuzzyNeedle", () => {
  it("picks longest token", () => {
    expect(pickFuzzyNeedle("acme eng")).toBe("acme");
  });
});
