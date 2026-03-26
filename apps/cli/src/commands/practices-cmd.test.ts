import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { SarifLog, SarifResult, RepoMetricsSummary } from "@mma/core";
import { practicesCommand, type PracticesReport, type PracticesOptions } from "./practices-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKvStore() {
  return new InMemoryKVStore();
}

async function seedMetrics(
  kv: InMemoryKVStore,
  repo: string,
  overrides?: Partial<RepoMetricsSummary>,
): Promise<void> {
  const summary: RepoMetricsSummary = {
    repo,
    moduleCount: 10,
    avgInstability: 0.5,
    avgAbstractness: 0.3,
    avgDistance: 0.2,
    painZoneCount: 1,
    uselessnessZoneCount: 0,
    ...overrides,
  };
  await kv.set(`metricsSummary:${repo}`, JSON.stringify(summary));
  await kv.set(`commit:${repo}`, "abc123");
}

async function seedSarif(
  kv: InMemoryKVStore,
  results: Array<{ ruleId: string; level: "error" | "warning" | "note"; baselineState?: string }>,
): Promise<void> {
  const sarifResults: SarifResult[] = results.map((r) => ({
    ruleId: r.ruleId,
    level: r.level,
    message: { text: `Finding: ${r.ruleId}` },
    ...(r.baselineState ? { baselineState: r.baselineState as SarifResult["baselineState"] } : {}),
  }));
  const log: SarifLog = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "multi-model-analyzer", version: "0.1.0", rules: [] } },
        results: sarifResults,
      },
    ],
  };
  await kv.set("sarif:latest", JSON.stringify(log));
}

async function generatePractices(
  kv: InMemoryKVStore,
  overrides?: Partial<PracticesOptions>,
): Promise<PracticesReport> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return await practicesCommand({
      kvStore: kv,
      format: "json",
      ...overrides,
    });
  } finally {
    logSpy.mockRestore();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("practicesCommand", () => {
  let kv: InMemoryKVStore;

  beforeEach(() => {
    kv = makeKvStore();
  });

  it("produces a valid report with findings and metrics", async () => {
    await seedMetrics(kv, "repo-alpha");
    await seedMetrics(kv, "repo-beta");
    await seedSarif(kv, [
      { ruleId: "structural/dead-export", level: "note" },
      { ruleId: "structural/dead-export", level: "note" },
      { ruleId: "structural/unstable-dependency", level: "warning" },
      { ruleId: "fault/silent-failure", level: "warning" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "config/missing-schema", level: "note" },
    ]);

    const report = await generatePractices(kv);

    expect(report.schemaVersion).toBe("1.2");
    expect(report.repoCount).toBe(2);
    expect(report.executive.grade).toHaveLength(1);
    expect(report.executive.score).toBeGreaterThanOrEqual(0);
    expect(report.executive.score).toBeLessThanOrEqual(100);
    expect(report.executive.topActions.length).toBeLessThanOrEqual(3);
    expect(report.findings).toHaveProperty("fixNow");
    expect(report.findings).toHaveProperty("planFor");
    expect(report.findings).toHaveProperty("monitor");
    expect(Array.isArray(report.findings.fixNow)).toBe(true);
    expect(Array.isArray(report.findings.planFor)).toBe(true);
    expect(Array.isArray(report.findings.monitor)).toBe(true);
  });

  it("computes correct grade for healthy codebase", async () => {
    await seedMetrics(kv, "healthy-repo", {
      avgDistance: 0.1,
      painZoneCount: 0,
      uselessnessZoneCount: 0,
    });
    await seedSarif(kv, [
      { ruleId: "config/missing-schema", level: "note" },
      { ruleId: "structural/dead-export", level: "note" },
    ]);

    const report = await generatePractices(kv);

    expect(report.executive.score).toBeGreaterThanOrEqual(85);
    expect(report.executive.grade).toBe("A");
  });

  it("computes correct grade for unhealthy codebase", async () => {
    await seedMetrics(kv, "sick-repo", {
      avgDistance: 0.5,
      painZoneCount: 5,
      uselessnessZoneCount: 0,
      moduleCount: 10,
    });
    await seedSarif(kv, [
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "fault/silent-failure", level: "error" },
      { ruleId: "structural/unstable-dependency", level: "error" },
      { ruleId: "structural/dead-export", level: "warning" },
      { ruleId: "structural/dead-export", level: "warning" },
      { ruleId: "structural/dead-export", level: "warning" },
      { ruleId: "structural/unstable-dependency", level: "warning" },
      { ruleId: "fault/silent-failure", level: "warning" },
      { ruleId: "config/missing-schema", level: "warning" },
      { ruleId: "config/missing-schema", level: "warning" },
      { ruleId: "config/missing-schema", level: "warning" },
      { ruleId: "config/missing-schema", level: "warning" },
      { ruleId: "config/missing-schema", level: "warning" },
    ]);

    const report = await generatePractices(kv);

    // ATDI normalizes by module count, so dense findings on a 10-module repo
    // produce a low-but-not-zero score. D or below (< 55) is correct for this density.
    expect(report.executive.score).toBeLessThan(55);
    expect(["D", "F"]).toContain(report.executive.grade);
  });

  it("partitions findings into correct tiers", async () => {
    await seedMetrics(kv, "tier-repo");
    await seedSarif(kv, [
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "structural/dead-export", level: "note" },
      { ruleId: "structural/dead-export", level: "note" },
      { ruleId: "fault/silent-failure", level: "warning" },
    ]);

    const report = await generatePractices(kv);

    const vulnGroup = [
      ...report.findings.fixNow,
      ...report.findings.planFor,
      ...report.findings.monitor,
    ].find((g) => g.ruleId === "vuln/reachable-dependency");
    expect(vulnGroup).toBeDefined();
    expect(vulnGroup!.count).toBe(3);

    const deadExportGroup = [
      ...report.findings.fixNow,
      ...report.findings.planFor,
      ...report.findings.monitor,
    ].find((g) => g.ruleId === "structural/dead-export");
    expect(deadExportGroup).toBeDefined();
    expect(deadExportGroup!.count).toBe(2);

    // vuln/reachable-dependency (high severity) should be in fixNow
    expect(report.findings.fixNow.some((g) => g.ruleId === "vuln/reachable-dependency")).toBe(true);

    // structural/dead-export (note level) should be in monitor
    expect(report.findings.monitor.some((g) => g.ruleId === "structural/dead-export")).toBe(true);
  });

  it("applies new bonus to priority scoring", async () => {
    await seedMetrics(kv, "baseline-repo");

    // Seed without baselineState
    await seedSarif(kv, [
      { ruleId: "structural/unstable-dependency", level: "warning" },
      { ruleId: "structural/unstable-dependency", level: "warning" },
    ]);
    const reportWithout = await generatePractices(kv);
    const allGroupsWithout = [
      ...reportWithout.findings.fixNow,
      ...reportWithout.findings.planFor,
      ...reportWithout.findings.monitor,
    ];
    const groupWithout = allGroupsWithout.find(
      (g) => g.ruleId === "structural/unstable-dependency",
    );
    expect(groupWithout).toBeDefined();
    const scoreWithout = groupWithout!.priorityScore;

    // Re-seed with one "new" finding
    await seedSarif(kv, [
      { ruleId: "structural/unstable-dependency", level: "warning", baselineState: "new" },
      { ruleId: "structural/unstable-dependency", level: "warning" },
    ]);
    const reportWith = await generatePractices(kv);
    const allGroupsWith = [
      ...reportWith.findings.fixNow,
      ...reportWith.findings.planFor,
      ...reportWith.findings.monitor,
    ];
    const groupWith = allGroupsWith.find((g) => g.ruleId === "structural/unstable-dependency");
    expect(groupWith).toBeDefined();
    const scoreWith = groupWith!.priorityScore;

    expect(scoreWith).toBeGreaterThan(scoreWithout);
    expect(scoreWith - scoreWithout).toBe(15);
  });

  it("assesses structural health ratings at boundary values", async () => {
    await seedMetrics(kv, "repo-good", {
      avgDistance: 0.15,
      painZoneCount: 0,
      uselessnessZoneCount: 0,
      moduleCount: 20,
    });
    await seedMetrics(kv, "repo-warn", {
      avgDistance: 0.35,
      painZoneCount: 4,
      uselessnessZoneCount: 2,
      moduleCount: 20,
    });
    await seedMetrics(kv, "repo-crit", {
      avgDistance: 0.5,
      painZoneCount: 6,
      uselessnessZoneCount: 4,
      moduleCount: 20,
    });

    const report = await generatePractices(kv);

    const good = report.structural.repos.find((r) => r.repo === "repo-good");
    const warn = report.structural.repos.find((r) => r.repo === "repo-warn");
    const crit = report.structural.repos.find((r) => r.repo === "repo-crit");

    expect(good).toBeDefined();
    expect(good!.distanceRating).toBe("good");
    expect(good!.painRating).toBe("good");
    expect(good!.uselessnessRating).toBe("good");

    expect(warn).toBeDefined();
    expect(warn!.distanceRating).toBe("warning");
    expect(warn!.painRating).toBe("warning");
    expect(warn!.uselessnessRating).toBe("warning");

    expect(crit).toBeDefined();
    expect(crit!.distanceRating).toBe("critical");
    expect(crit!.painRating).toBe("critical");
    expect(crit!.uselessnessRating).toBe("critical");
  });

  it("builds scorecard with correct health scores", async () => {
    await seedMetrics(kv, "scorecard-repo");
    await seedSarif(kv, [
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "structural/dead-export", level: "warning" },
      { ruleId: "structural/dead-export", level: "warning" },
      { ruleId: "config/missing-schema", level: "note" },
    ]);

    const report = await generatePractices(kv);

    expect(report.scorecard.length).toBeGreaterThan(0);

    const vulnRow = report.scorecard.find((row) => row.category === "vulnerability");
    const structuralRow = report.scorecard.find((row) => row.category === "structural");
    const configRow = report.scorecard.find((row) => row.category === "config");

    expect(vulnRow).toBeDefined();
    expect(structuralRow).toBeDefined();
    expect(configRow).toBeDefined();

    // Each row has a healthScore
    expect(typeof vulnRow!.healthScore).toBe("number");
    expect(typeof structuralRow!.healthScore).toBe("number");
    expect(typeof configRow!.healthScore).toBe("number");

    // Vulnerability (4 errors) should have lowest health score
    expect(vulnRow!.healthScore).toBeLessThan(structuralRow!.healthScore);
    expect(vulnRow!.healthScore).toBeLessThan(configRow!.healthScore);

    // Scorecard should be sorted worst-first (ascending health score)
    for (let i = 0; i < report.scorecard.length - 1; i++) {
      expect(report.scorecard[i]!.healthScore).toBeLessThanOrEqual(
        report.scorecard[i + 1]!.healthScore,
      );
    }
  });

  it("synthesizes recommendations from findings and structural health", async () => {
    await seedMetrics(kv, "rec-repo", {
      avgDistance: 0.5,
      painZoneCount: 6,
    });
    await seedSarif(kv, [
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
      { ruleId: "fault/silent-failure", level: "error" },
    ]);

    const report = await generatePractices(kv);

    expect(report.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(report.recommendations.length).toBeLessThanOrEqual(7);

    // Sorted by priority ascending
    for (let i = 0; i < report.recommendations.length - 1; i++) {
      expect(report.recommendations[i]!.priority).toBeLessThanOrEqual(
        report.recommendations[i + 1]!.priority,
      );
    }

    // Each recommendation has required fields
    for (const rec of report.recommendations) {
      expect(typeof rec.title).toBe("string");
      expect(rec.title.length).toBeGreaterThan(0);
      expect(typeof rec.rationale).toBe("string");
      expect(rec.rationale.length).toBeGreaterThan(0);
      expect(typeof rec.effort).toBe("string");
      expect(rec.effort.length).toBeGreaterThan(0);
    }
  });

  it("renders markdown output with key sections", async () => {
    await seedMetrics(kv, "md-repo");
    await seedSarif(kv, [
      { ruleId: "structural/dead-export", level: "warning" },
      { ruleId: "vuln/reachable-dependency", level: "error" },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await practicesCommand({
        kvStore: kv,
        format: "markdown",
      });

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");

      expect(output).toContain("Best Practices Report");
      expect(output).toContain("Executive Summary");
      expect(output).toContain("Priority Findings");
      expect(output).toContain("Structural Health");
      expect(output).toContain("Category Scorecard");
      expect(output).toContain("Recommendations");
      expect(output).toContain("findings-guide.md");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("produces graceful output for empty database", async () => {
    const report = await generatePractices(kv);

    expect(report.repoCount).toBe(0);
    expect(report.executive.grade).toBeDefined();
    // No findings means perfect score → "A"
    expect(report.executive.grade).toBe("A");
    expect(report.findings.fixNow).toHaveLength(0);
    expect(report.findings.planFor).toHaveLength(0);
    expect(report.findings.monitor).toHaveLength(0);
    expect(report.structural.repos).toHaveLength(0);
    expect(report.recommendations).toHaveLength(0);
  });

  it("JSON output matches PracticesReport shape", async () => {
    await seedMetrics(kv, "shape-repo");
    await seedSarif(kv, [{ ruleId: "structural/dead-export", level: "warning" }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await practicesCommand({
        kvStore: kv,
        format: "json",
      });

      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output) as Record<string, unknown>;

      expect(parsed).toHaveProperty("schemaVersion");
      expect(parsed).toHaveProperty("generatedAt");
      expect(parsed).toHaveProperty("repoCount");
      expect(parsed).toHaveProperty("executive");
      expect(parsed).toHaveProperty("findings");
      expect(parsed).toHaveProperty("structural");
      expect(parsed).toHaveProperty("scorecard");
      expect(parsed).toHaveProperty("recommendations");
      expect(parsed).toHaveProperty("debt");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("uses real repo names (not anonymized)", async () => {
    await seedMetrics(kv, "my-real-project");

    const report = await generatePractices(kv);

    expect(report.structural.repos.length).toBeGreaterThan(0);
    expect(report.structural.repos[0]!.repo).toBe("my-real-project");
  });
});

describe("Debt estimation", () => {
  let kv: InMemoryKVStore;

  beforeEach(() => {
    kv = makeKvStore();
  });

  it("zero debt for empty database", async () => {
    const report = await generatePractices(kv);
    expect(report.debt.totalDebtMinutes).toBe(0);
    expect(report.debt.totalDebtHours).toBe(0);
    expect(report.debt.byCategory).toHaveLength(0);
    expect(report.debt.byRule).toHaveLength(0);
  });

  it("correct per-rule estimation for fault/silent-failure", async () => {
    await seedMetrics(kv, "repo-a");
    await seedSarif(kv, [
      { ruleId: "fault/silent-failure", level: "error" },
      { ruleId: "fault/silent-failure", level: "error" },
      { ruleId: "fault/silent-failure", level: "error" },
    ]);

    const report = await generatePractices(kv);
    // fault/silent-failure = 20 min each, 3 instances = 60 total
    expect(report.debt.totalDebtMinutes).toBe(60);
    expect(report.debt.totalDebtHours).toBe(1);
  });

  it("category aggregation is correct for mixed findings", async () => {
    await seedMetrics(kv, "repo-a");
    await seedSarif(kv, [
      { ruleId: "config/dead-flag", level: "note" },        // 15 min each
      { ruleId: "config/dead-flag", level: "note" },        // 15 min → 30 total for config
      { ruleId: "fault/silent-failure", level: "warning" }, // 20 min → 20 total for fault
    ]);

    const report = await generatePractices(kv);
    expect(report.debt.totalDebtMinutes).toBe(50);

    const configCat = report.debt.byCategory.find(c => c.category === "config");
    const faultCat = report.debt.byCategory.find(c => c.category === "fault");
    expect(configCat?.debtMinutes).toBe(30);
    expect(faultCat?.debtMinutes).toBe(20);
  });

  it("byRule is limited to top 10", async () => {
    await seedMetrics(kv, "repo-a");
    // Seed findings across 12 different rules
    const manyRules = [
      "config/dead-flag", "config/always-on-flag", "config/missing-constraint",
      "config/format-violation", "fault/unhandled-error-path", "fault/silent-failure",
      "fault/missing-error-boundary", "structural/dead-export", "structural/unstable-dependency",
      "arch/layer-violation", "arch/forbidden-import", "arch/dependency-direction",
    ];
    await seedSarif(kv, manyRules.map(ruleId => ({ ruleId, level: "warning" as const })));

    const report = await generatePractices(kv);
    expect(report.debt.byRule.length).toBeLessThanOrEqual(10);
  });

  it("report JSON includes debt field with correct shape", async () => {
    await seedMetrics(kv, "repo-a");
    await seedSarif(kv, [{ ruleId: "fault/cascading-failure-risk", level: "error" }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await practicesCommand({ kvStore: kv, format: "json" });
      const output = logSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output) as Record<string, unknown>;

      expect(parsed).toHaveProperty("debt");
      const debt = parsed["debt"] as Record<string, unknown>;
      expect(typeof debt["totalDebtMinutes"]).toBe("number");
      expect(typeof debt["totalDebtHours"]).toBe("number");
      expect(Array.isArray(debt["byCategory"])).toBe(true);
      expect(Array.isArray(debt["byRule"])).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("days calculation is correct for large debt", async () => {
    await seedMetrics(kv, "repo-a");
    // fault/cascading-failure-risk = 480 min each
    await seedSarif(kv, [
      { ruleId: "fault/cascading-failure-risk", level: "error" },
      { ruleId: "fault/cascading-failure-risk", level: "error" },
    ]);

    const report = await generatePractices(kv);
    // 2 * 480 = 960 minutes = 16 hours
    expect(report.debt.totalDebtMinutes).toBe(960);
    expect(report.debt.totalDebtHours).toBe(16);
  });
});

describe("ATDI score", () => {
  let kv: InMemoryKVStore;

  beforeEach(() => {
    kv = makeKvStore();
  });

  it("score is 100 for empty database", async () => {
    const report = await generatePractices(kv);
    expect(report.atdi.score).toBe(100);
  });

  it("score increases with more errors", async () => {
    await seedMetrics(kv, "repo-a");
    await seedSarif(kv, [
      { ruleId: "fault/silent-failure", level: "error" },
      { ruleId: "fault/unhandled-error-path", level: "error" },
    ]);

    const report = await generatePractices(kv);
    expect(report.atdi.score).toBeGreaterThan(0);
  });

  it("large codebase scores higher than small codebase with same findings", async () => {
    // Small codebase: 5 modules — same 2 findings = high finding density = lower (unhealthier) score
    await seedMetrics(kv, "small-repo", { moduleCount: 5 });
    await seedSarif(kv, [
      { ruleId: "fault/silent-failure", level: "error" },
      { ruleId: "fault/unhandled-error-path", level: "warning" },
    ]);
    const smallReport = await generatePractices(kv);

    // Large codebase: 500 modules, same findings = low finding density = higher (healthier) score
    const kv2 = makeKvStore();
    await seedMetrics(kv2, "large-repo", { moduleCount: 500 });
    await seedSarif(kv2, [
      { ruleId: "fault/silent-failure", level: "error" },
      { ruleId: "fault/unhandled-error-path", level: "warning" },
    ]);
    const largeReport = await generatePractices(kv2);

    expect(largeReport.atdi.score).toBeGreaterThan(smallReport.atdi.score);
  });

  it("worsening trend when >20% findings are new", async () => {
    await seedMetrics(kv, "repo-a");
    // 3 new out of 4 total = 75% new > 20%
    await seedSarif(kv, [
      { ruleId: "fault/silent-failure", level: "warning", baselineState: "new" },
      { ruleId: "fault/silent-failure", level: "warning", baselineState: "new" },
      { ruleId: "fault/silent-failure", level: "warning", baselineState: "new" },
      { ruleId: "fault/unhandled-error-path", level: "warning" },
    ]);

    const report = await generatePractices(kv);
    expect(report.atdi.trend).toBe("worsening");
  });

  it("stable trend when <=20% new and no absent findings", async () => {
    await seedMetrics(kv, "repo-a");
    // 1 new out of 10 total = 10% new <= 20%, no absent
    const results: Array<{ ruleId: string; level: "warning" }> = Array.from({ length: 9 }, () => ({
      ruleId: "fault/silent-failure",
      level: "warning" as const,
    }));
    await seedSarif(kv, [
      ...results,
      { ruleId: "fault/silent-failure", level: "warning", baselineState: "new" },
    ]);

    const report = await generatePractices(kv);
    expect(report.atdi.trend).toBe("stable");
  });

  it("score is bounded at 100 when flooded with errors", async () => {
    await seedMetrics(kv, "repo-a", { moduleCount: 1 });
    // 200 errors across high-weight categories
    const manyErrors = Array.from({ length: 200 }, (_, i) => ({
      ruleId: i % 2 === 0 ? "vuln/reachable-dependency" : "fault/silent-failure",
      level: "error" as const,
    }));
    await seedSarif(kv, manyErrors);

    const report = await generatePractices(kv);
    expect(report.atdi.score).toBeLessThanOrEqual(100);
  });

  it("report JSON includes atdi field", async () => {
    await seedMetrics(kv, "json-repo");
    await seedSarif(kv, [{ ruleId: "structural/dead-export", level: "warning" }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await practicesCommand({ kvStore: kv, format: "json" });

      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output) as Record<string, unknown>;

      expect(parsed).toHaveProperty("atdi");
      const atdi = parsed["atdi"] as Record<string, unknown>;
      expect(typeof atdi["score"]).toBe("number");
      expect(["worsening", "stable", "improving"]).toContain(atdi["trend"]);
      expect(typeof atdi["newFindingCount"]).toBe("number");
      expect(typeof atdi["totalFindingCount"]).toBe("number");
      expect(Array.isArray(atdi["categoryBreakdown"])).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
