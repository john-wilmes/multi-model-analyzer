import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  InMemoryKVStore,
  InMemoryGraphStore,
} from "@mma/storage";
import type { SarifLog, ModuleMetrics, RepoMetricsSummary } from "@mma/core";
import { reportCommand, type FieldTrialReport, type ReportOptions } from "./report-cmd.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStores() {
  return {
    kvStore: new InMemoryKVStore(),
    graphStore: new InMemoryGraphStore(),
  };
}

async function seedRepo(
  kvStore: InMemoryKVStore,
  graphStore: InMemoryGraphStore,
  repoName: string,
): Promise<void> {
  // Commit
  await kvStore.set(`commit:${repoName}`, "abc123");

  // Metrics summary
  const summary: RepoMetricsSummary = {
    repo: repoName,
    moduleCount: 4,
    avgInstability: 0.5,
    avgAbstractness: 0.3,
    avgDistance: 0.2,
    painZoneCount: 1,
    uselessnessZoneCount: 0,
  };
  await kvStore.set(`metricsSummary:${repoName}`, JSON.stringify(summary));

  // Per-module metrics
  const modules: ModuleMetrics[] = [
    { module: "src/auth.ts", repo: repoName, ca: 3, ce: 1, instability: 0.25, abstractness: 0.0, distance: 0.75, zone: "pain" },
    { module: "src/api.ts", repo: repoName, ca: 1, ce: 3, instability: 0.75, abstractness: 0.5, distance: 0.25, zone: "main-sequence" },
    { module: "src/util.ts", repo: repoName, ca: 0, ce: 2, instability: 1.0, abstractness: 0.0, distance: 0.0, zone: "balanced" },
    { module: "src/types.ts", repo: repoName, ca: 4, ce: 0, instability: 0.0, abstractness: 1.0, distance: 0.0, zone: "main-sequence" },
  ];
  await kvStore.set(`metrics:${repoName}`, JSON.stringify(modules));

  // Patterns
  await kvStore.set(
    `patterns:${repoName}`,
    JSON.stringify([
      { kind: "factory", name: "createAuth", locations: [], confidence: 0.9 },
      { kind: "middleware", name: "logger", locations: [], confidence: 0.8 },
    ]),
  );

  // SARIF
  const sarifResults = [
    { ruleId: "structural/dead-export", level: "warning", message: { text: `Dead export in ${repoName}/src/old.ts` } },
    { ruleId: "structural/dead-export", level: "warning", message: { text: `Dead export in ${repoName}/src/legacy.ts` } },
    { ruleId: "structural/unstable-dependency", level: "warning", message: { text: "Unstable dep" } },
  ];
  await kvStore.set(`sarif:deadExports:${repoName}`, JSON.stringify(sarifResults.slice(0, 2)));
  await kvStore.set(`sarif:instability:${repoName}`, JSON.stringify(sarifResults.slice(2)));

  // Graph edges
  await graphStore.addEdges([
    { source: `${repoName}/src/api.ts`, target: `${repoName}/src/auth.ts`, kind: "imports", repo: repoName, metadata: { repo: repoName } },
    { source: `${repoName}/src/api.ts`, target: `${repoName}/src/util.ts`, kind: "imports", repo: repoName, metadata: { repo: repoName } },
    { source: `${repoName}/src/auth.ts`, target: `${repoName}/src/types.ts`, kind: "imports", repo: repoName, metadata: { repo: repoName } },
  ]);
}

async function generateReport(
  kvStore: InMemoryKVStore,
  graphStore: InMemoryGraphStore,
  overrides?: Partial<ReportOptions>,
): Promise<FieldTrialReport> {
  return reportCommand({
    kvStore,
    graphStore,
    format: "json",
    output: undefined,
    includeSarif: false,
    salt: "test-salt",
    ...overrides,
  });
}

// Aggregate sarif:latest from per-category keys (mimics index-cmd)
async function aggregateSarif(kvStore: InMemoryKVStore, repoNames: string[]): Promise<void> {
  const allResults: unknown[] = [];
  for (const repo of repoNames) {
    for (const key of ["config", "fault", "deadExports", "arch", "instability"]) {
      const json = await kvStore.get(`sarif:${key}:${repo}`);
      if (json) {
        const results = JSON.parse(json) as unknown[];
        allResults.push(...results);
      }
    }
  }
  if (allResults.length > 0) {
    const sarifLog: SarifLog = {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "multi-model-analyzer", version: "0.1.0", rules: [] } },
        results: allResults as SarifLog["runs"][0]["results"],
      }],
    };
    await kvStore.set("sarif:latest", JSON.stringify(sarifLog));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reportCommand", () => {
  let kvStore: InMemoryKVStore;
  let graphStore: InMemoryGraphStore;

  beforeEach(() => {
    const stores = makeStores();
    kvStore = stores.kvStore;
    graphStore = stores.graphStore;
  });

  it("produces a valid report with seeded data", async () => {
    await seedRepo(kvStore, graphStore, "acme-frontend");
    await aggregateSarif(kvStore, ["acme-frontend"]);

    const report = await generateReport(kvStore, graphStore);

    expect(report.schemaVersion).toBe("1.0");
    expect(report.repoCount).toBe(1);
    expect(report.metrics.aggregate).not.toBeNull();
    expect(report.metrics.aggregate!.moduleCount).toBe(4);
    expect(report.diagnostics.totalFindings).toBe(3);
  });

  it("does not leak repo names in JSON output", async () => {
    await seedRepo(kvStore, graphStore, "acme-frontend");
    await aggregateSarif(kvStore, ["acme-frontend"]);

    const report = await generateReport(kvStore, graphStore);
    const json = JSON.stringify(report);

    expect(json).not.toContain("acme-frontend");
    // Check anonymous labels are used
    expect(json).toContain("repo-1");
  });

  it("does not leak file paths in JSON output (excluding sarif)", async () => {
    await seedRepo(kvStore, graphStore, "acme-frontend");
    await aggregateSarif(kvStore, ["acme-frontend"]);

    const report = await generateReport(kvStore, graphStore);
    const json = JSON.stringify(report);

    expect(json).not.toContain("src/auth.ts");
    expect(json).not.toContain("src/api.ts");
    expect(json).not.toContain("src/old.ts");
  });

  it("computes correct metrics distributions", async () => {
    await seedRepo(kvStore, graphStore, "test-repo");
    await aggregateSarif(kvStore, ["test-repo"]);

    const report = await generateReport(kvStore, graphStore);
    const agg = report.metrics.aggregate!;

    // 4 modules with instabilities: 0.25, 0.75, 1.0, 0.0
    expect(agg.instabilityQuartiles.q0).toBe(0);
    expect(agg.instabilityQuartiles.q4).toBe(1);
    // Zones: 1 pain, 2 main-sequence, 1 balanced
    expect(agg.zoneHistogram["pain"]).toBe(1);
    expect(agg.zoneHistogram["main-sequence"]).toBe(2);
    expect(agg.zoneHistogram["balanced"]).toBe(1);
  });

  it("handles multiple repos with correct labeling", async () => {
    await seedRepo(kvStore, graphStore, "zebra-api");
    await seedRepo(kvStore, graphStore, "alpha-ui");
    await aggregateSarif(kvStore, ["zebra-api", "alpha-ui"]);

    const report = await generateReport(kvStore, graphStore);

    expect(report.repoCount).toBe(2);
    // Sorted alphabetically: alpha-ui → repo-1, zebra-api → repo-2
    const labels = report.metrics.perRepo.map((r) => r.label);
    expect(labels).toContain("repo-1");
    expect(labels).toContain("repo-2");
    // No real names
    const json = JSON.stringify(report);
    expect(json).not.toContain("zebra-api");
    expect(json).not.toContain("alpha-ui");
  });

  it("produces a valid report for an empty database", async () => {
    const report = await generateReport(kvStore, graphStore);

    expect(report.schemaVersion).toBe("1.0");
    expect(report.repoCount).toBe(0);
    expect(report.metrics.aggregate).toBeNull();
    expect(report.metrics.perRepo).toHaveLength(0);
    expect(report.diagnostics.totalFindings).toBe(0);
    expect(Object.keys(report.graph.byKind)).toHaveLength(0);
    expect(report.patterns.totalPatterns).toBe(0);
    // All capabilities should be not-run or ran-empty
    for (const status of Object.values(report.quality.capabilities)) {
      expect(["not-run", "ran-empty"]).toContain(status);
    }
  });

  it("includes redacted SARIF when --include-sarif is set", async () => {
    await seedRepo(kvStore, graphStore, "secret-repo");
    await aggregateSarif(kvStore, ["secret-repo"]);

    const report = await generateReport(kvStore, graphStore, {
      includeSarif: true,
    });

    expect(report.sarif).toBeDefined();
    const sarifJson = JSON.stringify(report.sarif);
    // Repo names in message text should be redacted if they appear via
    // service-like patterns, but raw repo names in message text get
    // redacted via file-path pattern since redactFilePaths is true
    expect(sarifJson).not.toContain("secret-repo/src/old.ts");
    expect(sarifJson).not.toContain("secret-repo/src/legacy.ts");
  });

  it("excludes SARIF by default", async () => {
    await seedRepo(kvStore, graphStore, "test-repo");
    await aggregateSarif(kvStore, ["test-repo"]);

    const report = await generateReport(kvStore, graphStore);

    expect(report.sarif).toBeUndefined();
  });

  it("emits redacted SARIF when format is sarif", async () => {
    await seedRepo(kvStore, graphStore, "secret-repo");
    await aggregateSarif(kvStore, ["secret-repo"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await generateReport(kvStore, graphStore, { format: "sarif" });

      // Should have called console.log with SARIF JSON
      expect(logSpy).toHaveBeenCalled();
      const output = logSpy.mock.calls[0]![0] as string;
      const sarif = JSON.parse(output) as import("@mma/core").SarifLog;
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.$schema).toContain("sarif");
      expect(sarif.runs).toBeDefined();
      // File paths should be redacted
      expect(output).not.toContain("secret-repo/src/old.ts");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits table output", async () => {
    await seedRepo(kvStore, graphStore, "acme-frontend");
    await aggregateSarif(kvStore, ["acme-frontend"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const report = await generateReport(kvStore, graphStore, { format: "table" });

      const output = logSpy.mock.calls.map((c) => c[0] as string).join("\n");

      // Header line with repo count
      expect(output).toContain("1 repo(s)");
      // Per-repo metrics table headers
      expect(output).toContain("Repo");
      expect(output).toContain("Modules");
      expect(output).toContain("Instability");
      // Anonymous label present
      expect(output).toContain("repo-1");
      // Diagnostics section
      expect(output).toContain("Diagnostics");
      // Capabilities section
      expect(output).toContain("Capabilities");
      // Real repo name NOT leaked
      expect(output).not.toContain("acme-frontend");

      // Report object still returned
      expect(report.schemaVersion).toBe("1.0");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("graph topology counts edges correctly", async () => {
    await seedRepo(kvStore, graphStore, "test-repo");

    const report = await generateReport(kvStore, graphStore);

    const imports = report.graph.byKind["imports"];
    expect(imports).toBeDefined();
    expect(imports!.edgeCount).toBe(3);
    // 4 distinct nodes: api.ts, auth.ts, util.ts, types.ts
    expect(imports!.nodeCount).toBe(4);
  });

  it("pipeline health detects present vs missing phases", async () => {
    await seedRepo(kvStore, graphStore, "test-repo");

    const report = await generateReport(kvStore, graphStore);

    const repo = report.pipeline.repos[0]!;
    expect(repo.phases["commit"]).toBe("present");
    expect(repo.phases["metricsSummary"]).toBe("present");
    expect(repo.phases["metrics"]).toBe("present");
    expect(repo.phases["patterns"]).toBe("present");
    expect(repo.phases["docs"]).toBe("missing");
    expect(repo.phases["faultTrees"]).toBe("missing");
  });

  it("quality assessment reflects actual data", async () => {
    await seedRepo(kvStore, graphStore, "test-repo");
    await aggregateSarif(kvStore, ["test-repo"]);

    const report = await generateReport(kvStore, graphStore);

    expect(report.quality.capabilities["module-metrics"]).toBe("produced-data");
    expect(report.quality.capabilities["diagnostics"]).toBe("produced-data");
    expect(report.quality.capabilities["dependency-graph"]).toBe("produced-data");
    expect(report.quality.capabilities["pattern-detection"]).toBe("produced-data");
    expect(report.quality.capabilities["documentation"]).toBe("not-run");
    expect(report.quality.capabilities["fault-trees"]).toBe("not-run");
  });
});
