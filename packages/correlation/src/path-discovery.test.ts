import { describe, it, expect } from "vitest";
import { findDependencyPaths } from "./path-discovery.js";
import type { CrossRepoGraph } from "./types.js";

/** Build a minimal CrossRepoGraph from an adjacency list (repo -> deps). */
function makeGraph(adj: Record<string, string[]>): CrossRepoGraph {
  const downstreamMap = new Map<string, ReadonlySet<string>>();
  const upstreamMap = new Map<string, ReadonlySet<string>>();

  for (const [repo, deps] of Object.entries(adj)) {
    downstreamMap.set(repo, new Set(deps));
    for (const dep of deps) {
      if (!upstreamMap.has(dep)) {
        upstreamMap.set(dep, new Set());
      }
      (upstreamMap.get(dep) as Set<string>).add(repo);
    }
  }

  return {
    edges: [],
    repoPairs: new Set(),
    downstreamMap,
    upstreamMap,
  };
}

describe("findDependencyPaths", () => {
  it("returns empty array when source === target", () => {
    const graph = makeGraph({ A: ["B"] });
    expect(findDependencyPaths("A", "A", graph)).toEqual([]);
  });

  it("returns empty array when no path exists", () => {
    const graph = makeGraph({ A: ["B"], C: ["D"] });
    expect(findDependencyPaths("A", "C", graph)).toEqual([]);
    expect(findDependencyPaths("A", "D", graph)).toEqual([]);
  });

  it("returns empty array when target is not reachable (reversed edge only)", () => {
    // B depends on A, not the other way around
    const graph = makeGraph({ B: ["A"] });
    expect(findDependencyPaths("A", "B", graph)).toEqual([]);
  });

  it("finds a direct (1-hop) dependency", () => {
    const graph = makeGraph({ A: ["B"] });
    const result = findDependencyPaths("A", "B", graph);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ nodes: ["A", "B"], boundaryCount: 1 });
  });

  it("finds a transitive (2-hop) dependency", () => {
    const graph = makeGraph({ A: ["B"], B: ["C"] });
    const result = findDependencyPaths("A", "C", graph);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ nodes: ["A", "B", "C"], boundaryCount: 2 });
  });

  it("finds a longer chain (A → B → C → D)", () => {
    const graph = makeGraph({ A: ["B"], B: ["C"], C: ["D"] });
    const result = findDependencyPaths("A", "D", graph);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      nodes: ["A", "B", "C", "D"],
      boundaryCount: 3,
    });
  });

  it("returns all shortest paths when multiple exist (diamond)", () => {
    // A → B → D
    // A → C → D
    const graph = makeGraph({ A: ["B", "C"], B: ["D"], C: ["D"] });
    const result = findDependencyPaths("A", "D", graph);
    expect(result).toHaveLength(2);
    const nodesList = result.map((p) => p.nodes);
    expect(nodesList).toContainEqual(["A", "B", "D"]);
    expect(nodesList).toContainEqual(["A", "C", "D"]);
    for (const path of result) {
      expect(path.boundaryCount).toBe(2);
    }
  });

  it("returns only shortest paths, not longer ones", () => {
    // Direct: A → C (1 hop)
    // Indirect: A → B → C (2 hops)
    const graph = makeGraph({ A: ["B", "C"], B: ["C"] });
    const result = findDependencyPaths("A", "C", graph);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ nodes: ["A", "C"], boundaryCount: 1 });
  });

  it("handles a graph with no outgoing edges from source", () => {
    const graph = makeGraph({ A: [] });
    expect(findDependencyPaths("A", "B", graph)).toEqual([]);
  });

  it("handles source not present in downstreamMap", () => {
    const graph = makeGraph({ B: ["C"] });
    expect(findDependencyPaths("A", "C", graph)).toEqual([]);
  });

  it("returns three shortest paths when they all have the same length", () => {
    // A → X → D
    // A → Y → D
    // A → Z → D
    const graph = makeGraph({ A: ["X", "Y", "Z"], X: ["D"], Y: ["D"], Z: ["D"] });
    const result = findDependencyPaths("A", "D", graph);
    expect(result).toHaveLength(3);
    for (const path of result) {
      expect(path.boundaryCount).toBe(2);
      expect(path.nodes[0]).toBe("A");
      expect(path.nodes[2]).toBe("D");
    }
  });
});
