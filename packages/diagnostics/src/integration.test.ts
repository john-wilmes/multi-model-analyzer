/**
 * Integration tests: Structural → Diagnostics SARIF emission.
 *
 * Tests the real computeModuleMetrics and detectDeadExports functions
 * from @mma/structural, then verifies the SARIF output produced by
 * createSarifRun / createSarifLog from @mma/core.
 */

import { describe, it, expect } from "vitest";
import type { GraphEdge, ParsedFile } from "@mma/core";
import { createSarifRun, createSarifLog, createSarifResult } from "@mma/core";
import { computeModuleMetrics, detectDeadExports } from "@mma/structural";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function importEdge(source: string, target: string): GraphEdge {
  return { source, target, kind: "imports" };
}

function parsedFile(
  path: string,
  repo: string,
  symbols: ParsedFile["symbols"] = [],
): ParsedFile {
  return { path, repo, kind: "typescript", symbols, errors: [], contentHash: "abc" };
}

// ---------------------------------------------------------------------------
// computeModuleMetrics
// ---------------------------------------------------------------------------

describe("computeModuleMetrics -> valid numbers", () => {
  it("produces numeric ca/ce/instability for a synthetic dep graph", () => {
    const edges: GraphEdge[] = [
      importEdge("src/a.ts", "src/b.ts"),
      importEdge("src/a.ts", "src/c.ts"),
      importEdge("src/b.ts", "src/c.ts"),
    ];
    const files: ParsedFile[] = [
      parsedFile("src/a.ts", "repo"),
      parsedFile("src/b.ts", "repo"),
      parsedFile("src/c.ts", "repo"),
    ];

    const metrics = computeModuleMetrics(edges, files, "repo");
    expect(metrics.length).toBeGreaterThan(0);

    for (const m of metrics) {
      expect(typeof m.ca).toBe("number");
      expect(typeof m.ce).toBe("number");
      expect(m.instability).toBeGreaterThanOrEqual(0);
      expect(m.instability).toBeLessThanOrEqual(1);
      expect(m.abstractness).toBeGreaterThanOrEqual(0);
      expect(m.abstractness).toBeLessThanOrEqual(1);
    }
  });
});

describe("computeModuleMetrics -> SARIF ruleId", () => {
  it("metrics can be converted to SARIF results with correct ruleId", () => {
    const edges: GraphEdge[] = [importEdge("src/a.ts", "src/b.ts")];
    const files: ParsedFile[] = [
      parsedFile("src/a.ts", "repo"),
      parsedFile("src/b.ts", "repo"),
    ];

    const metrics = computeModuleMetrics(edges, files, "repo");
    const painZone = metrics.filter((m) => m.zone === "pain");

    const sarifResults = painZone.map((m) =>
      createSarifResult(
        "structural/pain-zone",
        "warning",
        `Module ${m.module} is in the pain zone (instability=${m.instability.toFixed(2)}, abstractness=${m.abstractness.toFixed(2)})`,
      ),
    );

    for (const r of sarifResults) {
      expect(r.ruleId).toBe("structural/pain-zone");
      expect(r.level).toBe("warning");
      expect(r.message.text).toContain("pain zone");
    }
  });
});

// ---------------------------------------------------------------------------
// detectDeadExports
// ---------------------------------------------------------------------------

describe("detectDeadExports -> SARIF emission", () => {
  it("flags exported symbols in files with no importers", () => {
    const files: ParsedFile[] = [
      parsedFile("src/util.ts", "repo", [
        { name: "helper", kind: "function", startLine: 1, endLine: 5, exported: true },
      ]),
      parsedFile("src/main.ts", "repo"),  // no exports, no importers needed
    ];

    // No import edges → src/util.ts is never imported
    const results = detectDeadExports(files, [], "repo");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.ruleId).toBe("structural/dead-export");
    expect(results[0]!.level).toBe("note");
    expect(results[0]!.message.text).toContain("helper");
  });
});

// ---------------------------------------------------------------------------
// createSarifRun + createSarifLog
// ---------------------------------------------------------------------------

describe("createSarifLog -> valid SARIF 2.1 structure", () => {
  it("produces $schema, version, and runs fields", () => {
    const run = createSarifRun("test-tool", "1.0.0", [], []);
    const log = createSarifLog([run]);

    expect(log.$schema).toBe(
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    );
    expect(log.version).toBe("2.1.0");
    expect(Array.isArray(log.runs)).toBe(true);
    expect(log.runs).toHaveLength(1);
  });

  it("empty results still produce valid SARIF structure", () => {
    const run = createSarifRun("mma", "0.1.0", [], []);
    const log = createSarifLog([run]);

    expect(log.runs[0]!.results).toHaveLength(0);
    expect(log.runs[0]!.tool.driver.name).toBe("mma");
  });
});

describe("createSarifRun -> distinct ruleIds", () => {
  it("multiple rules produce distinct ruleIds in the run descriptor", () => {
    const rules = [
      { id: "structural/pain-zone", shortDescription: { text: "Pain zone" } },
      { id: "structural/dead-export", shortDescription: { text: "Dead export" } },
      { id: "structural/circular-dep", shortDescription: { text: "Circular dep" } },
    ];

    const run = createSarifRun("mma", "1.0.0", rules, []);
    const ids = run.tool.driver.rules.map((r) => r.id);

    expect(ids).toContain("structural/pain-zone");
    expect(ids).toContain("structural/dead-export");
    expect(ids).toContain("structural/circular-dep");
    expect(new Set(ids).size).toBe(3);
  });
});
