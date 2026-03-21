import { describe, it, expect } from "vitest";
import { computeBlastRadius, computeReachCounts } from "./blast-radius.js";
import { InMemoryGraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import type { CrossRepoGraph } from "@mma/correlation";

function importEdge(source: string, target: string, repo = "test"): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo } };
}

function callEdge(source: string, target: string, repo = "test"): GraphEdge {
  return { source, target, kind: "calls", metadata: { repo } };
}

describe("computeBlastRadius", () => {
  it("finds direct dependents of a single file", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "target.ts"),
      importEdge("b.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store);

    expect(result.totalAffected).toBe(2);
    expect(result.affectedFiles.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.affectedFiles.every((f) => f.depth === 1)).toBe(true);
    expect(result.affectedFiles.every((f) => f.via === "imports")).toBe(true);
  });

  it("finds transitive chain (A -> B -> C, change C -> both A and B affected)", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ]);

    const result = await computeBlastRadius(["c.ts"], store);

    expect(result.totalAffected).toBe(2);
    const b = result.affectedFiles.find((f) => f.path === "b.ts")!;
    const a = result.affectedFiles.find((f) => f.path === "a.ts")!;
    expect(b.depth).toBe(1);
    expect(a.depth).toBe(2);
  });

  it("respects maxDepth limiting", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
      importEdge("c.ts", "d.ts"),
    ]);

    const result = await computeBlastRadius(["d.ts"], store, { maxDepth: 1 });

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("c.ts");
  });

  it("includes call graph edges when enabled", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      callEdge("caller.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store, { includeCallGraph: true });

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("caller.ts");
    expect(result.affectedFiles[0]!.via).toBe("calls");
  });

  it("marks 'both' when reached via imports AND calls", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("consumer.ts", "target.ts"),
      callEdge("consumer.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store, { includeCallGraph: true });

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.via).toBe("both");
  });

  it("handles multiple changed files (union)", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "x.ts"),
      importEdge("b.ts", "y.ts"),
    ]);

    const result = await computeBlastRadius(["x.ts", "y.ts"], store);

    expect(result.totalAffected).toBe(2);
    expect(result.changedFiles.sort()).toEqual(["x.ts", "y.ts"]);
  });

  it("handles cycles without infinite loop", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "a.ts"),
    ]);

    const result = await computeBlastRadius(["a.ts"], store);

    // b.ts imports a.ts, so it's affected. a.ts imports b.ts but a.ts is the changed file.
    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("b.ts");
  });

  it("returns empty result when no dependents exist", async () => {
    const store = new InMemoryGraphStore();
    // isolated.ts has no incoming edges
    await store.addEdges([importEdge("isolated.ts", "dep.ts")]);

    const result = await computeBlastRadius(["isolated.ts"], store);

    expect(result.totalAffected).toBe(0);
    expect(result.affectedFiles).toHaveLength(0);
  });

  it("excludes call graph when includeCallGraph is false", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      callEdge("caller.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store, { includeCallGraph: false });
    expect(result.totalAffected).toBe(0);
  });

  it("returns empty result for empty changed files list", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius([], store);
    expect(result.totalAffected).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.affectedFiles).toHaveLength(0);
  });

  it("handles file with no graph edges (isolated)", async () => {
    const store = new InMemoryGraphStore();
    // No edges at all
    const result = await computeBlastRadius(["orphan.ts"], store);
    expect(result.totalAffected).toBe(0);
    expect(result.changedFiles).toEqual(["orphan.ts"]);
  });

  it("diamond dependency: affected files are not duplicated", async () => {
    // a -> b, a -> c, b -> d, c -> d. Change d → b, c at depth 1, a at depth 2
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("a.ts", "c.ts"),
      importEdge("b.ts", "d.ts"),
      importEdge("c.ts", "d.ts"),
    ]);

    const result = await computeBlastRadius(["d.ts"], store);
    expect(result.totalAffected).toBe(3);
    const paths = result.affectedFiles.map(f => f.path).sort();
    expect(paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("sorts affected files by depth then path", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("z.ts", "target.ts"),
      importEdge("a.ts", "target.ts"),
      importEdge("m.ts", "z.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store);
    // depth 1: a.ts, z.ts (alphabetical). depth 2: m.ts
    expect(result.affectedFiles.map(f => f.path)).toEqual(["a.ts", "z.ts", "m.ts"]);
  });

  it("description string reflects counts and maxDepth", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius(["b.ts"], store, { maxDepth: 3 });
    expect(result.description).toContain("1 files affected");
    expect(result.description).toContain("1 file(s)");
    expect(result.description).toContain("max depth 3");
  });

  it("maxDepth 0 means no traversal at all", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius(["b.ts"], store, { maxDepth: 0 });
    expect(result.totalAffected).toBe(0);
  });

  it("expands blast radius across repo boundaries when crossRepoGraph provided", async () => {
    const store = new InMemoryGraphStore();
    // Intra-repo edges for repoA
    await store.addEdges([
      importEdge("src/a.ts", "src/target.ts", "repoA"),
    ]);
    // Intra-repo edges for repoB (b.ts imports entry.ts)
    await store.addEdges([
      importEdge("src/b.ts", "src/entry.ts", "repoB"),
    ]);

    // Cross-repo graph: repoA:src/a.ts -> repoB:src/entry.ts
    const crossRepoGraph: CrossRepoGraph = {
      edges: [{
        edge: { source: "src/a.ts", target: "src/entry.ts", kind: "imports", metadata: {} },
        sourceRepo: "repoA",
        targetRepo: "repoB",
        packageName: "repoB",
      }],
      repoPairs: new Set(["repoA->repoB"]),
      downstreamMap: new Map([["repoA", new Set(["repoB"])]]),
      upstreamMap: new Map([["repoB", new Set(["repoA"])]]),
    };

    const result = await computeBlastRadius(
      ["src/target.ts"],
      store,
      { repo: "repoA", crossRepoGraph },
    );

    // Intra-repo: src/a.ts affected
    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("src/a.ts");

    // Cross-repo: repoB files affected
    expect(result.crossRepoAffected).toBeDefined();
    expect(result.crossRepoAffected!.has("repoB")).toBe(true);
    const repoBAffected = result.crossRepoAffected!.get("repoB")!;
    expect(repoBAffected.length).toBeGreaterThanOrEqual(1);
    // Should include at least entry.ts and b.ts
    const repoBPaths = repoBAffected.map(f => f.path);
    expect(repoBPaths).toContain("src/entry.ts");
    expect(repoBPaths).toContain("src/b.ts");
  });

  it("returns no crossRepoAffected when crossRepoGraph is not provided", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius(["b.ts"], store);
    expect(result.crossRepoAffected).toBeUndefined();
  });
});

describe("computeReachCounts", () => {
  it("computes reach counts for a chain (A→B→C)", async () => {
    const edges: GraphEdge[] = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ];
    const counts = await computeReachCounts(edges);
    expect(counts.get("c.ts")).toBe(2); // A and B both reach C
    expect(counts.get("b.ts")).toBe(1); // only A reaches B
    expect(counts.get("a.ts")).toBe(0); // nothing reaches A
  });

  it("computes reach counts for a diamond (A→B, A→C, B→D, C→D)", async () => {
    const edges: GraphEdge[] = [
      importEdge("a.ts", "b.ts"),
      importEdge("a.ts", "c.ts"),
      importEdge("b.ts", "d.ts"),
      importEdge("c.ts", "d.ts"),
    ];
    const counts = await computeReachCounts(edges);
    expect(counts.get("d.ts")).toBe(3); // A, B, C all reach D
    expect(counts.get("b.ts")).toBe(1); // only A reaches B
    expect(counts.get("c.ts")).toBe(1); // only A reaches C
    expect(counts.get("a.ts")).toBe(0); // nothing reaches A
  });

  it("handles cycles (A→B→A)", async () => {
    const edges: GraphEdge[] = [
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "a.ts"),
    ];
    const counts = await computeReachCounts(edges);
    expect(counts.get("a.ts")).toBe(1); // B reaches A
    expect(counts.get("b.ts")).toBe(1); // A reaches B
  });

  it("returns empty map for no import edges", async () => {
    const edges: GraphEdge[] = [
      { source: "a.ts", target: "b.ts", kind: "calls", metadata: { repo: "test" } },
    ];
    const counts = await computeReachCounts(edges);
    expect(counts.size).toBe(0);
  });

  it("handles isolated nodes (no incoming edges)", async () => {
    const edges: GraphEdge[] = [
      importEdge("a.ts", "b.ts"),
    ];
    const counts = await computeReachCounts(edges);
    expect(counts.get("b.ts")).toBe(1); // A reaches B
    expect(counts.get("a.ts")).toBe(0); // nothing reaches A
  });
});

describe("computeBlastRadius with pageRankScores", () => {
  it("annotates affected files with PageRank scores when provided", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "target.ts"),
      importEdge("b.ts", "target.ts"),
    ]);

    const scores = new Map([["a.ts", 0.5], ["b.ts", 0.3]]);
    const result = await computeBlastRadius(["target.ts"], store, {
      pageRankScores: scores,
    });

    expect(result.totalAffected).toBe(2);
    const aFile = result.affectedFiles.find(f => f.path === "a.ts")!;
    const bFile = result.affectedFiles.find(f => f.path === "b.ts")!;
    expect(aFile.score).toBe(0.5);
    expect(bFile.score).toBe(0.3);
  });

  it("leaves score undefined when pageRankScores not provided", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "target.ts")]);

    const result = await computeBlastRadius(["target.ts"], store);

    expect(result.affectedFiles[0]!.score).toBeUndefined();
  });
});
