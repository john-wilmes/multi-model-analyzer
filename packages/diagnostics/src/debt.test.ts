import { describe, it, expect } from "vitest";
import {
  getDebtMinutes,
  DEFAULT_DEBT_MINUTES,
  annotateDebt,
  summarizeDebt,
} from "./debt.js";
import type { SarifResult } from "@mma/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  ruleId: string,
  level: SarifResult["level"] = "warning",
  properties?: Record<string, unknown>,
): SarifResult {
  return {
    ruleId,
    level,
    message: { text: `Finding for ${ruleId}` },
    ...(properties !== undefined ? { properties } : {}),
  };
}

// ---------------------------------------------------------------------------
// getDebtMinutes
// ---------------------------------------------------------------------------

describe("getDebtMinutes", () => {
  it("returns correct minutes for a known rule", () => {
    expect(getDebtMinutes("config/dead-flag")).toBe(30);
    expect(getDebtMinutes("fault/cascading-failure-risk")).toBe(120);
    expect(getDebtMinutes("hotspot/high-churn-complexity")).toBe(180);
    expect(getDebtMinutes("structural/dead-export")).toBe(10);
  });

  it("returns DEFAULT_DEBT_MINUTES for an unknown rule", () => {
    expect(getDebtMinutes("unknown/rule-that-does-not-exist")).toBe(
      DEFAULT_DEBT_MINUTES,
    );
    expect(getDebtMinutes("")).toBe(DEFAULT_DEBT_MINUTES);
  });
});

// ---------------------------------------------------------------------------
// annotateDebt
// ---------------------------------------------------------------------------

describe("annotateDebt", () => {
  it("adds debtMinutes to properties of each result", () => {
    const results: SarifResult[] = [
      makeResult("config/dead-flag"),
      makeResult("fault/silent-failure"),
    ];

    const annotated = annotateDebt(results);

    expect(annotated[0]!.properties?.["debtMinutes"]).toBe(30);
    expect(annotated[1]!.properties?.["debtMinutes"]).toBe(45);
  });

  it("does not mutate the original results", () => {
    const original = makeResult("config/dead-flag");
    const results: SarifResult[] = [original];

    annotateDebt(results);

    // Original should be unmodified
    expect(original.properties).toBeUndefined();
  });

  it("preserves existing properties alongside debtMinutes", () => {
    const results: SarifResult[] = [
      makeResult("arch/layer-violation", "error", { existingProp: "keep-me" }),
    ];

    const annotated = annotateDebt(results);

    expect(annotated[0]!.properties?.["existingProp"]).toBe("keep-me");
    expect(annotated[0]!.properties?.["debtMinutes"]).toBe(90);
  });

  it("uses DEFAULT_DEBT_MINUTES for unknown rules", () => {
    const results: SarifResult[] = [makeResult("totally/unknown")];
    const annotated = annotateDebt(results);
    expect(annotated[0]!.properties?.["debtMinutes"]).toBe(DEFAULT_DEBT_MINUTES);
  });
});

// ---------------------------------------------------------------------------
// summarizeDebt
// ---------------------------------------------------------------------------

describe("summarizeDebt", () => {
  it("returns zero debt for empty results", () => {
    const summary = summarizeDebt("my-repo", []);
    expect(summary.repo).toBe("my-repo");
    expect(summary.totalMinutes).toBe(0);
    expect(summary.totalHours).toBe(0);
    expect(summary.byRule).toEqual({});
    expect(summary.bySeverity).toEqual({});
  });

  it("totals debt minutes correctly", () => {
    // config/dead-flag = 30, fault/silent-failure = 45 => 75 min = 1.3 hrs
    const results: SarifResult[] = [
      makeResult("config/dead-flag"),
      makeResult("fault/silent-failure"),
    ];
    const summary = summarizeDebt("repo-a", results);
    expect(summary.totalMinutes).toBe(75);
    expect(summary.totalHours).toBe(1.3);
  });

  it("groups by rule correctly", () => {
    const results: SarifResult[] = [
      makeResult("config/dead-flag"),
      makeResult("config/dead-flag"),
      makeResult("fault/silent-failure"),
    ];
    const summary = summarizeDebt("repo-b", results);

    expect(summary.byRule["config/dead-flag"]?.count).toBe(2);
    expect(summary.byRule["config/dead-flag"]?.minutes).toBe(60); // 2 × 30
    expect(summary.byRule["fault/silent-failure"]?.count).toBe(1);
    expect(summary.byRule["fault/silent-failure"]?.minutes).toBe(45);
  });

  it("groups by severity correctly", () => {
    const results: SarifResult[] = [
      makeResult("arch/layer-violation", "error"),       // 90 min
      makeResult("config/dead-flag", "warning"),          // 30 min
      makeResult("structural/dead-export", "note"),       // 10 min
      makeResult("config/always-on-flag", "warning"),     // 15 min
    ];
    const summary = summarizeDebt("repo-c", results);

    expect(summary.bySeverity["error"]?.count).toBe(1);
    expect(summary.bySeverity["error"]?.minutes).toBe(90);
    expect(summary.bySeverity["warning"]?.count).toBe(2);
    expect(summary.bySeverity["warning"]?.minutes).toBe(45); // 30 + 15
    expect(summary.bySeverity["note"]?.count).toBe(1);
    expect(summary.bySeverity["note"]?.minutes).toBe(10);
  });

  it("uses debtMinutes from properties when already annotated", () => {
    // Provide an explicitly annotated result with a custom value
    const annotated: SarifResult = {
      ruleId: "config/dead-flag",
      level: "warning",
      message: { text: "test" },
      properties: { debtMinutes: 999 },
    };
    const summary = summarizeDebt("repo-d", [annotated]);
    expect(summary.totalMinutes).toBe(999);
  });
});
