import { describe, it, expect } from "vitest";
import { detectTemporalCoupling, detectTemporalCouplingWithMeta, temporalCouplingToSarif, groupByCommit } from "./temporal-coupling.js";
import type { CommitInfo } from "./temporal-coupling.js";

function commit(hash: string, files: string[]): CommitInfo {
  return { hash, files };
}

describe("detectTemporalCoupling", () => {
  it("detects files that frequently change together", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts", "c.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
      commit("c4", ["a.ts", "d.ts"]),
    ];
    const result = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0 });

    expect(result.pairs.length).toBeGreaterThanOrEqual(1);
    const abPair = result.pairs.find(p => p.fileA === "a.ts" && p.fileB === "b.ts");
    expect(abPair).toBeDefined();
    expect(abPair!.coChangeCount).toBe(3);
  });

  it("computes support correctly", () => {
    // a.ts appears in 4 commits, b.ts appears in 3 commits, co-change = 3
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
      commit("c4", ["a.ts", "c.ts"]),
    ];
    const result = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0 });

    const pair = result.pairs.find(p => p.fileA === "a.ts" && p.fileB === "b.ts")!;
    expect(pair.supportA).toBeCloseTo(3 / 4); // 3 co-changes out of 4 commits with a.ts
    expect(pair.supportB).toBeCloseTo(3 / 3); // 3 co-changes out of 3 commits with b.ts
    expect(pair.confidence).toBeCloseTo(1.0);  // max(0.75, 1.0)
  });

  it("filters by minCoChanges", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
    ];
    const result = detectTemporalCoupling(commits, { minCoChanges: 3 });
    expect(result.pairs).toHaveLength(0);
  });

  it("filters by minConfidence", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
      commit("c4", ["a.ts", "c.ts"]),
      commit("c5", ["a.ts", "d.ts"]),
      commit("c6", ["a.ts", "e.ts"]),
    ];
    // a-b co-change=3, a appears 6 times, b appears 3 times
    // supportA=0.5, supportB=1.0, confidence=1.0
    const result = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0.9 });
    expect(result.pairs).toHaveLength(1); // only a-b passes
  });

  it("skips large commits (merge commits)", () => {
    const bigFiles = Array.from({ length: 60 }, (_, i) => `file${i}.ts`);
    const commits = [
      commit("c1", bigFiles), // skipped: > 50 files
      commit("c2", ["a.ts", "b.ts"]),
    ];
    const result = detectTemporalCoupling(commits, { maxFilesPerCommit: 50, minCoChanges: 1 });
    expect(result.commitsSkipped).toBe(1);
    expect(result.commitsAnalyzed).toBe(1);
  });

  it("handles single-file commits", () => {
    const commits = [
      commit("c1", ["a.ts"]),
      commit("c2", ["b.ts"]),
    ];
    const result = detectTemporalCoupling(commits, { minCoChanges: 1 });
    expect(result.pairs).toHaveLength(0);
    expect(result.commitsAnalyzed).toBe(2);
  });

  it("handles empty commit list", () => {
    const result = detectTemporalCoupling([]);
    expect(result.pairs).toHaveLength(0);
    expect(result.commitsAnalyzed).toBe(0);
    expect(result.commitsSkipped).toBe(0);
  });

  it("sorts by co-change count descending", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
      commit("c4", ["c.ts", "d.ts"]),
      commit("c5", ["c.ts", "d.ts"]),
      commit("c6", ["c.ts", "d.ts"]),
      commit("c7", ["c.ts", "d.ts"]),
    ];
    const result = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0 });
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs[0]!.coChangeCount).toBe(4); // c-d
    expect(result.pairs[1]!.coChangeCount).toBe(3); // a-b
  });
});

describe("temporalCouplingToSarif", () => {
  it("converts coupled pairs to SARIF results", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
    ];
    const coupling = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0 });
    const sarif = temporalCouplingToSarif(coupling, "test-repo");

    expect(sarif).toHaveLength(1);
    expect(sarif[0]!.ruleId).toBe("temporal-coupling/co-change");
    expect(sarif[0]!.message.text).toContain("a.ts");
    expect(sarif[0]!.message.text).toContain("b.ts");
    expect(sarif[0]!.relatedLocations).toHaveLength(1);
  });

  it("uses warning level for high-confidence pairs", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
    ];
    const coupling = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0 });
    const sarif = temporalCouplingToSarif(coupling, "test-repo");

    expect(sarif[0]!.level).toBe("warning"); // confidence 1.0 >= 0.8
  });

  it("respects maxResults", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts", "c.ts"]),
      commit("c2", ["a.ts", "b.ts", "c.ts"]),
      commit("c3", ["a.ts", "b.ts", "c.ts"]),
    ];
    const coupling = detectTemporalCoupling(commits, { minCoChanges: 3, minConfidence: 0 });
    const sarif = temporalCouplingToSarif(coupling, "test-repo", { maxResults: 1 });

    expect(sarif).toHaveLength(1);
  });

  it("returns empty for no coupling", () => {
    const coupling = detectTemporalCoupling([]);
    const sarif = temporalCouplingToSarif(coupling, "test-repo");
    expect(sarif).toHaveLength(0);
  });
});

describe("detectTemporalCouplingWithMeta", () => {
  it("meta.heuristic equals 'detectTemporalCoupling'", () => {
    const result = detectTemporalCouplingWithMeta([], "test-repo");
    expect(result.meta.heuristic).toBe("detectTemporalCoupling");
  });

  it("meta.itemCount matches data.pairs.length", () => {
    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
    ];
    const result = detectTemporalCouplingWithMeta(commits, "test-repo", { minCoChanges: 3, minConfidence: 0 });
    expect(result.meta.itemCount).toBe(result.data.pairs.length);
    expect(result.meta.itemCount).toBe(1);
  });

  it("confidenceStats undefined for empty commits, populated when coupled pairs exist", () => {
    const emptyResult = detectTemporalCouplingWithMeta([], "test-repo");
    expect(emptyResult.meta.confidenceStats).toBeUndefined();

    const commits = [
      commit("c1", ["a.ts", "b.ts"]),
      commit("c2", ["a.ts", "b.ts"]),
      commit("c3", ["a.ts", "b.ts"]),
    ];
    const filledResult = detectTemporalCouplingWithMeta(commits, "test-repo", { minCoChanges: 3, minConfidence: 0 });
    expect(filledResult.meta.confidenceStats).toBeDefined();
    expect(filledResult.meta.confidenceStats!.min).toBeGreaterThanOrEqual(0);
    expect(filledResult.meta.confidenceStats!.max).toBeLessThanOrEqual(1);
    expect(filledResult.meta.confidenceStats!.mean).toBeGreaterThanOrEqual(0);
  });
});

describe("groupByCommit", () => {
  it("groups flat file changes into CommitInfo[]", () => {
    const flat = [
      { hash: "c1", filePath: "a.ts" },
      { hash: "c1", filePath: "b.ts" },
      { hash: "c2", filePath: "c.ts" },
      { hash: "c1", filePath: "d.ts" },
      { hash: "c2", filePath: "e.ts" },
    ];
    const result = groupByCommit(flat);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ hash: "c1", files: ["a.ts", "b.ts", "d.ts"] });
    expect(result[1]).toEqual({ hash: "c2", files: ["c.ts", "e.ts"] });
  });

  it("returns empty array for empty input", () => {
    expect(groupByCommit([])).toEqual([]);
  });
});
