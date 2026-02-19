import { describe, it, expect } from "vitest";
import type { SarifRun, SarifStatistics } from "@mma/core";
import { aggregateRuns } from "./aggregation.js";

function makeRun(
  results: Array<{ ruleId: string; level: "error" | "warning" | "note" }>,
  stats?: { totalResults: number; errorCount: number; warningCount: number; noteCount: number },
): SarifRun {
  return {
    tool: { driver: { name: "test", version: "1.0", rules: [] } },
    results: results.map((r) => ({
      ruleId: r.ruleId,
      level: r.level,
      message: { text: "test" },
    })),
    properties: stats ? {
      statistics: {
        ...stats,
        rulesTriggered: 0,
        analysisTimestamp: new Date().toISOString(),
      },
    } : undefined,
  };
}

describe("aggregateRuns", () => {
  it("counts rules from results even when stats are pre-computed", () => {
    const runs: SarifRun[] = [
      makeRun(
        [
          { ruleId: "rule/a", level: "error" },
          { ruleId: "rule/b", level: "warning" },
        ],
        { totalResults: 2, errorCount: 1, warningCount: 1, noteCount: 0 },
      ),
      makeRun(
        [
          { ruleId: "rule/b", level: "warning" },
          { ruleId: "rule/c", level: "note" },
        ],
        { totalResults: 2, errorCount: 0, warningCount: 1, noteCount: 1 },
      ),
    ];

    const merged = aggregateRuns(runs, "test", "1.0");
    const stats = merged.properties?.statistics as SarifStatistics;
    expect(stats.totalResults).toBe(4);
    expect(stats.rulesTriggered).toBe(3); // rule/a, rule/b, rule/c
  });

  it("computes counts from results when no pre-computed stats", () => {
    const runs: SarifRun[] = [
      makeRun([
        { ruleId: "rule/x", level: "error" },
        { ruleId: "rule/y", level: "note" },
      ]),
    ];

    const merged = aggregateRuns(runs, "test", "1.0");
    const stats = merged.properties?.statistics as SarifStatistics;
    expect(stats.totalResults).toBe(2);
    expect(stats.errorCount).toBe(1);
    expect(stats.noteCount).toBe(1);
    expect(stats.rulesTriggered).toBe(2);
  });

  it("deduplicates rules across runs", () => {
    const runs: SarifRun[] = [
      makeRun([{ ruleId: "rule/a", level: "error" }]),
      makeRun([{ ruleId: "rule/a", level: "warning" }]),
    ];

    const merged = aggregateRuns(runs, "test", "1.0");
    const stats = merged.properties?.statistics as SarifStatistics;
    expect(stats.rulesTriggered).toBe(1);
  });
});
