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

  it("handles empty runs array", () => {
    const merged = aggregateRuns([], "test", "1.0");
    expect(merged.results).toHaveLength(0);
    expect(merged.tool.driver.rules).toHaveLength(0);
    const stats = merged.properties?.statistics as SarifStatistics;
    expect(stats.totalResults).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.warningCount).toBe(0);
    expect(stats.noteCount).toBe(0);
    expect(stats.rulesTriggered).toBe(0);
  });

  it("sets tool name and version in output", () => {
    const merged = aggregateRuns([], "my-analyzer", "2.0.0");
    expect(merged.tool.driver.name).toBe("my-analyzer");
    expect(merged.tool.driver.version).toBe("2.0.0");
  });

  it("concatenates all results from multiple runs", () => {
    const runs: SarifRun[] = [
      makeRun([
        { ruleId: "rule/a", level: "error" },
        { ruleId: "rule/b", level: "warning" },
      ]),
      makeRun([
        { ruleId: "rule/c", level: "note" },
      ]),
    ];

    const merged = aggregateRuns(runs, "test", "1.0");
    expect(merged.results).toHaveLength(3);
    expect(merged.results.map(r => r.ruleId)).toEqual(["rule/a", "rule/b", "rule/c"]);
  });

  it("mixes pre-computed stats and computed-from-results", () => {
    const runs: SarifRun[] = [
      makeRun(
        [{ ruleId: "rule/a", level: "error" }],
        { totalResults: 1, errorCount: 1, warningCount: 0, noteCount: 0 },
      ),
      makeRun([{ ruleId: "rule/b", level: "note" }]), // no stats → computed from results
    ];

    const merged = aggregateRuns(runs, "test", "1.0");
    const stats = merged.properties?.statistics as SarifStatistics;
    expect(stats.totalResults).toBe(2);
    expect(stats.errorCount).toBe(1);
    expect(stats.noteCount).toBe(1);
    expect(stats.warningCount).toBe(0);
    expect(stats.rulesTriggered).toBe(2);
  });

  it("includes analysisTimestamp in statistics", () => {
    const merged = aggregateRuns([], "test", "1.0");
    const stats = merged.properties?.statistics as SarifStatistics;
    expect(stats.analysisTimestamp).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(stats.analysisTimestamp).getTime()).not.toBeNaN();
  });

  it("deduplicates logical locations by fullyQualifiedName", () => {
    const runs: SarifRun[] = [
      {
        tool: { driver: { name: "t", version: "1", rules: [] } },
        results: [],
        logicalLocations: [
          { fullyQualifiedName: "a.ts", kind: "module" },
          { fullyQualifiedName: "b.ts", kind: "module" },
        ],
      },
      {
        tool: { driver: { name: "t", version: "1", rules: [] } },
        results: [],
        logicalLocations: [
          { fullyQualifiedName: "a.ts", kind: "module" }, // duplicate
          { fullyQualifiedName: "c.ts", kind: "module" },
        ],
      },
    ];

    const merged = aggregateRuns(runs, "test", "1.0");
    expect(merged.logicalLocations).toHaveLength(3);
    const names = merged.logicalLocations!.map(l => l.fullyQualifiedName);
    expect(names).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("omits logicalLocations when no runs have them", () => {
    const merged = aggregateRuns([makeRun([])], "test", "1.0");
    expect(merged.logicalLocations).toBeUndefined();
  });
});

describe("aggregateSarifLogs", () => {
  it("merges runs from multiple logs", async () => {
    const { aggregateSarifLogs } = await import("./aggregation.js");
    const { createSarifLog } = await import("@mma/core");

    const log1 = createSarifLog([{
      tool: { driver: { name: "t1", version: "1", rules: [] } },
      results: [{ ruleId: "r1", level: "error", message: { text: "err" } }],
    }]);
    const log2 = createSarifLog([{
      tool: { driver: { name: "t2", version: "1", rules: [] } },
      results: [{ ruleId: "r2", level: "note", message: { text: "note" } }],
    }]);

    const merged = aggregateSarifLogs([log1, log2]);
    expect(merged.runs).toHaveLength(2);
    expect(merged.$schema).toBeDefined();
  });
});

describe("sarifToJson", () => {
  it("produces valid JSON string", async () => {
    const { sarifToJson } = await import("./aggregation.js");
    const { createSarifLog } = await import("@mma/core");

    const log = createSarifLog([]);
    const json = sarifToJson(log);
    const parsed = JSON.parse(json) as { $schema?: string; version?: string };
    expect(parsed.$schema).toBeDefined();
    expect(parsed.version).toBe("2.1.0");
  });

  it("produces compact JSON when pretty=false", async () => {
    const { sarifToJson } = await import("./aggregation.js");
    const { createSarifLog } = await import("@mma/core");

    const log = createSarifLog([]);
    const compact = sarifToJson(log, false);
    const pretty = sarifToJson(log, true);
    expect(compact.length).toBeLessThan(pretty.length);
    expect(compact.includes("\n")).toBe(false);
  });
});
