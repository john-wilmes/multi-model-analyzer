import { describe, it, expect } from "vitest";
import { tier2Summarize, shouldEscalateToTier3 } from "./heuristics.js";
import type { MethodPurpose, Summary } from "@mma/core";

describe("tier2Summarize", () => {
  it("converts method purposes to tier-2 summaries", () => {
    const purposes: MethodPurpose[] = [
      {
        methodId: "src/user.ts#getUser",
        verb: "get",
        object: "user",
        purpose: "Gets user",
        confidence: 0.85,
      },
      {
        methodId: "src/user.ts#saveUser",
        verb: "save",
        object: "user",
        purpose: "Saves user",
        confidence: 0.85,
      },
    ];

    const summaries = tier2Summarize(purposes);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.entityId).toBe("src/user.ts#getUser");
    expect(summaries[0]!.tier).toBe(2);
    expect(summaries[0]!.description).toBe("Gets user");
    expect(summaries[0]!.confidence).toBe(0.85);
  });

  it("returns empty array for empty input", () => {
    expect(tier2Summarize([])).toEqual([]);
  });
});

describe("shouldEscalateToTier3", () => {
  const highConfidence: Summary = {
    entityId: "x",
    tier: 2,
    description: "Gets user",
    confidence: 0.85,
  };

  const lowConfidence: Summary = {
    entityId: "x",
    tier: 1,
    description: "function getUser",
    confidence: 0.4,
  };

  it("returns false when tier 2 confidence is above threshold", () => {
    expect(shouldEscalateToTier3(undefined, highConfidence)).toBe(false);
  });

  it("returns true when only low-confidence tier 1 exists", () => {
    expect(shouldEscalateToTier3(lowConfidence, undefined)).toBe(true);
  });

  it("returns true when no summaries exist", () => {
    expect(shouldEscalateToTier3(undefined, undefined)).toBe(true);
  });

  it("prefers tier 2 over tier 1", () => {
    expect(shouldEscalateToTier3(lowConfidence, highConfidence)).toBe(false);
  });

  it("respects custom threshold", () => {
    expect(shouldEscalateToTier3(undefined, highConfidence, 0.9)).toBe(true);
    expect(shouldEscalateToTier3(undefined, highConfidence, 0.8)).toBe(false);
  });
});
