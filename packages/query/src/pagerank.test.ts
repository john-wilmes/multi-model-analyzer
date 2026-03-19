import { describe, it, expect } from "vitest";
import { computePageRank, pageRankToSarif } from "./pagerank.js";
import type { GraphEdge } from "@mma/core";

function importEdge(source: string, target: string): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo: "test" } };
}

describe("computePageRank", () => {
  it("returns empty result for no edges", () => {
    const result = computePageRank([]);
    expect(result.scores.size).toBe(0);
    expect(result.ranked).toHaveLength(0);
    expect(result.iterations).toBe(0);
  });

  it("assigns higher rank to highly-imported files", () => {
    // a, b, c all import shared.ts → shared should rank highest
    const edges = [
      importEdge("a.ts", "shared.ts"),
      importEdge("b.ts", "shared.ts"),
      importEdge("c.ts", "shared.ts"),
    ];
    const result = computePageRank(edges);

    expect(result.ranked[0]!.path).toBe("shared.ts");
    expect(result.ranked[0]!.rank).toBe(1);
    expect(result.scores.get("shared.ts")!).toBeGreaterThan(result.scores.get("a.ts")!);
  });

  it("handles chain: a -> b -> c, c has highest rank", () => {
    const edges = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ];
    const result = computePageRank(edges);

    // c.ts is imported by b.ts which is imported by a.ts
    // c.ts should have highest rank as the deepest dependency
    expect(result.scores.get("c.ts")!).toBeGreaterThan(result.scores.get("a.ts")!);
  });

  it("converges within max iterations", () => {
    const edges = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
      importEdge("c.ts", "a.ts"), // cycle
    ];
    const result = computePageRank(edges, { maxIterations: 200 });
    expect(result.iterations).toBeLessThanOrEqual(200);
    // In a cycle, scores should be roughly equal
    const scores = [...result.scores.values()];
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    for (const s of scores) {
      expect(Math.abs(s - avg)).toBeLessThan(0.01);
    }
  });

  it("ignores non-import edges", () => {
    const edges: GraphEdge[] = [
      { source: "a.ts", target: "b.ts", kind: "calls", metadata: { repo: "test" } },
    ];
    const result = computePageRank(edges);
    expect(result.scores.size).toBe(0);
  });

  it("respects damping factor", () => {
    const edges = [importEdge("a.ts", "b.ts")];
    const high = computePageRank(edges, { damping: 0.99 });
    const low = computePageRank(edges, { damping: 0.5 });

    // Higher damping → more differentiation between nodes
    const highDiff = high.scores.get("b.ts")! - high.scores.get("a.ts")!;
    const lowDiff = low.scores.get("b.ts")! - low.scores.get("a.ts")!;
    expect(highDiff).toBeGreaterThan(lowDiff);
  });

  it("ranks are sequential starting from 1", () => {
    const edges = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ];
    const result = computePageRank(edges);
    expect(result.ranked.map(r => r.rank)).toEqual([1, 2, 3]);
  });

  it("scores sum to approximately 1", () => {
    const edges = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
      importEdge("c.ts", "d.ts"),
      importEdge("d.ts", "b.ts"), // cycle back
    ];
    const result = computePageRank(edges);
    const total = [...result.scores.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 3);
  });
});

// pageRankToSarif uses repo-prefixed paths (e.g. "repo:src/a.ts") matching
// the format produced by the indexing pipeline.
function repoEdge(source: string, target: string): GraphEdge {
  return { source: `repo:${source}`, target: `repo:${target}`, kind: "imports", metadata: { repo: "test" } };
}

describe("pageRankToSarif", () => {
  it("converts top-ranked files to SARIF notes", () => {
    const edges = [
      repoEdge("a.ts", "shared.ts"),
      repoEdge("b.ts", "shared.ts"),
      repoEdge("c.ts", "shared.ts"),
    ];
    const pr = computePageRank(edges);
    const sarif = pageRankToSarif(pr, "test-repo", { topN: 2 });

    expect(sarif.length).toBeLessThanOrEqual(2);
    expect(sarif[0]!.ruleId).toBe("blast-radius/high-pagerank");
    expect(sarif[0]!.level).toBe("note");
    expect(sarif[0]!.message.text).toContain("shared.ts");
  });

  it("returns empty array for empty PageRank result", () => {
    const pr = computePageRank([]);
    const sarif = pageRankToSarif(pr, "test-repo");
    expect(sarif).toHaveLength(0);
  });

  it("respects minScore filter", () => {
    const edges = [
      repoEdge("a.ts", "shared.ts"),
      repoEdge("b.ts", "shared.ts"),
    ];
    const pr = computePageRank(edges);
    // With a very high minScore, nothing should pass
    const sarif = pageRankToSarif(pr, "test-repo", { minScore: 0.99 });
    expect(sarif).toHaveLength(0);
  });

  it("includes repo in SARIF location properties", () => {
    const edges = [repoEdge("a.ts", "b.ts")];
    const pr = computePageRank(edges);
    const sarif = pageRankToSarif(pr, "my-repo", { topN: 5 });
    for (const result of sarif) {
      expect(result.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"]).toBe("my-repo");
    }
  });

  it("includes pageRankScore and rank in SARIF properties", () => {
    const edges = [repoEdge("a.ts", "b.ts")];
    const pr = computePageRank(edges);
    const sarif = pageRankToSarif(pr, "test", { topN: 5 });
    expect(sarif.length).toBeGreaterThan(0);
    for (const result of sarif) {
      expect(result.properties?.["pageRankScore"]).toBeGreaterThan(0);
      expect(result.properties?.["rank"]).toBeGreaterThanOrEqual(1);
    }
  });

  it("excludes external packages (no repo: prefix) from SARIF output", () => {
    // Mix of internal (repo-prefixed) and external (bare package name) nodes
    const edges: GraphEdge[] = [
      { source: "repo:src/a.ts", target: "lodash", kind: "imports", metadata: { repo: "test" } },
      { source: "repo:src/b.ts", target: "lodash", kind: "imports", metadata: { repo: "test" } },
      { source: "repo:src/c.ts", target: "lodash", kind: "imports", metadata: { repo: "test" } },
      repoEdge("src/a.ts", "src/shared.ts"),
      repoEdge("src/b.ts", "src/shared.ts"),
    ];
    const pr = computePageRank(edges);
    const sarif = pageRankToSarif(pr, "test-repo", { topN: 10 });

    // "lodash" has highest PageRank but should be excluded
    const paths = sarif.map(r => r.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName);
    expect(paths).not.toContain("lodash");
    // Internal files should still appear
    expect(paths.some(p => p?.includes("shared.ts"))).toBe(true);
  });
});

describe("computePageRank edge cases", () => {
  it("single node with self-import", () => {
    const edges = [importEdge("a.ts", "a.ts")];
    const result = computePageRank(edges);
    expect(result.scores.size).toBe(1);
    expect(result.scores.get("a.ts")).toBeCloseTo(1.0, 3);
  });

  it("dangling node (no outgoing edges) distributes rank to all nodes", () => {
    // b.ts is imported by a.ts but has no outgoing edges → dangling
    // c.ts imports b.ts and also has outgoing edge
    const edges = [
      importEdge("a.ts", "b.ts"),
      importEdge("c.ts", "b.ts"),
    ];
    const result = computePageRank(edges);
    // b.ts has no outgoing links (dangling), its rank distributes evenly
    // All scores should still sum to 1
    const total = [...result.scores.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 3);
    // b.ts should have highest rank (two importers)
    expect(result.ranked[0]!.path).toBe("b.ts");
  });

  it("star topology: many imports to one hub", () => {
    const spokes = Array.from({ length: 20 }, (_, i) => `spoke${i}.ts`);
    const edges = spokes.map(s => importEdge(s, "hub.ts"));
    const result = computePageRank(edges);

    expect(result.ranked[0]!.path).toBe("hub.ts");
    // Hub score should be significantly higher than any spoke
    const hubScore = result.scores.get("hub.ts")!;
    for (const spoke of spokes) {
      expect(hubScore).toBeGreaterThan(result.scores.get(spoke)! * 2);
    }
  });

  it("convergence with low tolerance", () => {
    const edges = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ];
    const loose = computePageRank(edges, { tolerance: 0.1 });
    const tight = computePageRank(edges, { tolerance: 1e-10, maxIterations: 500 });
    // Tight tolerance should need more iterations
    expect(tight.iterations).toBeGreaterThanOrEqual(loose.iterations);
  });

  it("maxIterations=1 still produces valid scores", () => {
    const edges = [importEdge("a.ts", "b.ts")];
    const result = computePageRank(edges, { maxIterations: 1 });
    expect(result.iterations).toBe(1);
    const total = [...result.scores.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 3);
  });
});
