import { describe, it, expect } from "vitest";
import { InMemoryGraphStore } from "@mma/storage";
import { computeCrossRepoImpact } from "./impact-analysis.js";
import type { CrossRepoGraph, ResolvedCrossRepoEdge } from "./types.js";

function makeGraph(edges: ResolvedCrossRepoEdge[]): CrossRepoGraph {
  const repoPairs = new Set<string>();
  const downstreamMap = new Map<string, Set<string>>();
  const upstreamMap = new Map<string, Set<string>>();

  for (const e of edges) {
    repoPairs.add(`${e.sourceRepo}->${e.targetRepo}`);
    if (!downstreamMap.has(e.sourceRepo)) downstreamMap.set(e.sourceRepo, new Set());
    downstreamMap.get(e.sourceRepo)!.add(e.targetRepo);
    if (!upstreamMap.has(e.targetRepo)) upstreamMap.set(e.targetRepo, new Set());
    upstreamMap.get(e.targetRepo)!.add(e.sourceRepo);
  }

  return { edges, repoPairs, downstreamMap, upstreamMap };
}

describe("computeCrossRepoImpact", () => {
  it("returns empty result when no files depend on the changed file", async () => {
    const gs = new InMemoryGraphStore();
    const graph = makeGraph([]);

    const result = await computeCrossRepoImpact(["src/a.ts"], "repo-a", gs, graph);

    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.changedRepo).toBe("repo-a");
    expect(result.affectedWithinRepo).toEqual([]);
    expect(result.affectedAcrossRepos.size).toBe(0);
    expect(result.reposReached).toBe(1);
  });

  it("propagates intra-repo transitively via reverse BFS", async () => {
    const gs = new InMemoryGraphStore();
    // b imports a, c imports b — changing a affects b and c
    await gs.addEdges([
      { source: "src/b.ts", target: "src/a.ts", kind: "imports", metadata: { repo: "repo-a" } },
      { source: "src/c.ts", target: "src/b.ts", kind: "imports", metadata: { repo: "repo-a" } },
    ]);
    const graph = makeGraph([]);

    const result = await computeCrossRepoImpact(["src/a.ts"], "repo-a", gs, graph);

    expect(result.affectedWithinRepo).toContain("src/b.ts");
    expect(result.affectedWithinRepo).toContain("src/c.ts");
    expect(result.affectedWithinRepo).not.toContain("src/a.ts");
    expect(result.affectedAcrossRepos.size).toBe(0);
    expect(result.reposReached).toBe(1);
  });

  it("propagates across a repo boundary via cross-repo edge", async () => {
    const gs = new InMemoryGraphStore();
    // repo-a: b imports a
    await gs.addEdges([
      { source: "src/b.ts", target: "src/a.ts", kind: "imports", metadata: { repo: "repo-a" } },
    ]);
    // repo-b: x imports shared-lib/index (mapped to repo-a/src/b.ts)
    await gs.addEdges([
      { source: "src/x.ts", target: "lib/index.ts", kind: "imports", metadata: { repo: "repo-b" } },
    ]);

    const crossEdge: ResolvedCrossRepoEdge = {
      edge: { source: "src/b.ts", target: "lib/index.ts", kind: "imports" },
      sourceRepo: "repo-a",
      targetRepo: "repo-b",
      packageName: "shared-lib",
    };
    const graph = makeGraph([crossEdge]);

    const result = await computeCrossRepoImpact(["src/a.ts"], "repo-a", gs, graph);

    expect(result.affectedWithinRepo).toContain("src/b.ts");
    expect(result.affectedAcrossRepos.has("repo-b")).toBe(true);
    const repoBFiles = result.affectedAcrossRepos.get("repo-b")!;
    expect(repoBFiles).toContain("lib/index.ts");
    expect(repoBFiles).toContain("src/x.ts");
    expect(result.reposReached).toBe(2);
  });

  it("handles multiple cross-repo hops (chain: a -> b -> c)", async () => {
    const gs = new InMemoryGraphStore();
    // repo-a: no intra deps on a.ts
    // repo-b: y imports api (cross from repo-a)
    await gs.addEdges([
      { source: "src/y.ts", target: "api/index.ts", kind: "imports", metadata: { repo: "repo-b" } },
    ]);
    // repo-c: z imports pkg (cross from repo-b)
    await gs.addEdges([
      { source: "src/z.ts", target: "pkg/index.ts", kind: "imports", metadata: { repo: "repo-c" } },
    ]);

    const crossEdges: ResolvedCrossRepoEdge[] = [
      {
        edge: { source: "src/a.ts", target: "api/index.ts", kind: "imports" },
        sourceRepo: "repo-a",
        targetRepo: "repo-b",
        packageName: "pkg-b",
      },
      {
        edge: { source: "api/index.ts", target: "pkg/index.ts", kind: "imports" },
        sourceRepo: "repo-b",
        targetRepo: "repo-c",
        packageName: "pkg-c",
      },
    ];
    const graph = makeGraph(crossEdges);

    const resultA = await computeCrossRepoImpact(["src/a.ts"], "repo-a", gs, graph);

    expect(resultA.affectedAcrossRepos.has("repo-b")).toBe(true);
    expect(resultA.affectedAcrossRepos.get("repo-b")).toContain("api/index.ts");
    expect(resultA.affectedAcrossRepos.get("repo-b")).toContain("src/y.ts");
    // repo-c is reached because api/index.ts in repo-b has a cross edge to repo-c
    // (the BFS in repo-b seeds api/index.ts which is the source in the cross edge to repo-c)
    expect(resultA.affectedAcrossRepos.has("repo-c")).toBe(true);
    expect(resultA.affectedAcrossRepos.get("repo-c")).toContain("pkg/index.ts");
    expect(resultA.reposReached).toBe(3);
  });

  it("does not include changed files in affectedWithinRepo", async () => {
    const gs = new InMemoryGraphStore();
    const graph = makeGraph([]);

    const result = await computeCrossRepoImpact(
      ["src/a.ts", "src/b.ts"],
      "repo-a",
      gs,
      graph,
    );

    expect(result.affectedWithinRepo).not.toContain("src/a.ts");
    expect(result.affectedWithinRepo).not.toContain("src/b.ts");
  });
});
