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

    expect(report.schemaVersion).toBe("1.0");
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

    expect(report.executive.score).toBeLessThan(40);
    expect(report.executive.grade).toBe("F");
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
