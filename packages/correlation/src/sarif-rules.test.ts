import { describe, it, expect } from "vitest";
import {
  detectBreakingChangeRisk,
  detectOrphanedServices,
  detectCriticalPaths,
} from "./sarif-rules.js";
import type { CrossRepoGraph, ServiceCorrelationResult } from "./types.js";
import type { GraphEdge } from "@mma/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdge(
  source: string,
  target: string,
  kind: GraphEdge["kind"] = "imports",
): GraphEdge {
  return { source, target, kind };
}

function makeGraph(
  edges: Array<{ source: string; target: string; sourceRepo: string; targetRepo: string }>,
): CrossRepoGraph {
  const repoPairs = new Set<string>();
  const downstreamMap = new Map<string, Set<string>>();
  const upstreamMap = new Map<string, Set<string>>();

  const resolvedEdges = edges.map(({ source, target, sourceRepo, targetRepo }) => {
    repoPairs.add(`${sourceRepo}->${targetRepo}`);

    if (!downstreamMap.has(sourceRepo)) downstreamMap.set(sourceRepo, new Set());
    downstreamMap.get(sourceRepo)!.add(targetRepo);

    if (!upstreamMap.has(targetRepo)) upstreamMap.set(targetRepo, new Set());
    upstreamMap.get(targetRepo)!.add(sourceRepo);

    return {
      edge: makeEdge(source, target),
      sourceRepo,
      targetRepo,
      packageName: targetRepo,
    };
  });

  return {
    edges: resolvedEdges,
    repoPairs,
    downstreamMap,
    upstreamMap,
  };
}

function makeServices(
  orphaned: Array<{
    endpoint: string;
    hasProducers: boolean;
    hasConsumers: boolean;
    repos: string[];
  }>,
): ServiceCorrelationResult {
  return {
    links: [],
    linchpins: [],
    orphanedServices: orphaned,
  };
}

// ---------------------------------------------------------------------------
// detectBreakingChangeRisk
// ---------------------------------------------------------------------------

describe("detectBreakingChangeRisk", () => {
  it("emits warning when a module is depended on by 3 distinct repos", () => {
    const graph = makeGraph([
      { source: "repo-b/src/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-b", targetRepo: "repo-a" },
      { source: "repo-c/src/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-c", targetRepo: "repo-a" },
      { source: "repo-d/src/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-d", targetRepo: "repo-a" },
    ]);

    const results = detectBreakingChangeRisk(graph);
    expect(results).toHaveLength(1);

    const r = results[0]!;
    expect(r.ruleId).toBe("cross-repo/breaking-change-risk");
    expect(r.level).toBe("warning");
    expect(r.locations![0]!.logicalLocations![0]!.name).toBe("shared-lib/index.ts");
    expect(r.relatedLocations).toHaveLength(3);
    expect(r.properties!["dependentRepoCount"]).toBe(3);
  });

  it("does NOT emit warning when a module has exactly 2 dependent repos", () => {
    const graph = makeGraph([
      { source: "repo-b/src/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-b", targetRepo: "repo-a" },
      { source: "repo-c/src/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-c", targetRepo: "repo-a" },
    ]);

    expect(detectBreakingChangeRisk(graph)).toHaveLength(0);
  });

  it("returns empty array for a graph with no edges", () => {
    const graph: CrossRepoGraph = {
      edges: [],
      repoPairs: new Set(),
      downstreamMap: new Map(),
      upstreamMap: new Map(),
    };
    expect(detectBreakingChangeRisk(graph)).toHaveLength(0);
  });

  it("counts distinct source repos, not total edges", () => {
    // Same sourceRepo "repo-b" imports two different files — should count as 1 distinct repo
    const graph = makeGraph([
      { source: "repo-b/src/a.ts", target: "shared-lib/index.ts", sourceRepo: "repo-b", targetRepo: "repo-a" },
      { source: "repo-b/src/b.ts", target: "shared-lib/index.ts", sourceRepo: "repo-b", targetRepo: "repo-a" },
      { source: "repo-c/src/a.ts", target: "shared-lib/index.ts", sourceRepo: "repo-c", targetRepo: "repo-a" },
    ]);
    // Only 2 distinct source repos — should not trigger
    expect(detectBreakingChangeRisk(graph)).toHaveLength(0);
  });

  it("handles multiple modules, some triggering and some not", () => {
    const graph = makeGraph([
      // shared-lib: depended on by 3 repos — triggers
      { source: "repo-b/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-b", targetRepo: "repo-a" },
      { source: "repo-c/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-c", targetRepo: "repo-a" },
      { source: "repo-d/use.ts", target: "shared-lib/index.ts", sourceRepo: "repo-d", targetRepo: "repo-a" },
      // other-lib: depended on by 1 repo — does not trigger
      { source: "repo-e/use.ts", target: "other-lib/index.ts", sourceRepo: "repo-e", targetRepo: "repo-a" },
    ]);

    const results = detectBreakingChangeRisk(graph);
    expect(results).toHaveLength(1);
    expect(results[0]!.locations![0]!.logicalLocations![0]!.name).toBe("shared-lib/index.ts");
  });
});

// ---------------------------------------------------------------------------
// detectOrphanedServices
// ---------------------------------------------------------------------------

describe("detectOrphanedServices", () => {
  it("emits note for a service with producers but no consumers", () => {
    const services = makeServices([
      { endpoint: "/api/payments", hasProducers: true, hasConsumers: false, repos: ["payments-svc"] },
    ]);

    const results = detectOrphanedServices(services);
    expect(results).toHaveLength(1);

    const r = results[0]!;
    expect(r.ruleId).toBe("cross-repo/orphaned-service");
    expect(r.level).toBe("note");
    expect(r.message.text).toContain("producers but no cross-repo consumers");
    expect(r.locations![0]!.logicalLocations![0]!.kind).toBe("service");
    expect(r.locations![0]!.logicalLocations![0]!.name).toBe("/api/payments");
  });

  it("emits note for a service with consumers but no producers", () => {
    const services = makeServices([
      { endpoint: "/api/legacy", hasProducers: false, hasConsumers: true, repos: ["consumer-svc"] },
    ]);

    const results = detectOrphanedServices(services);
    expect(results).toHaveLength(1);
    expect(results[0]!.message.text).toContain("consumers but no known producers");
  });

  it("returns empty array when there are no orphaned services", () => {
    expect(detectOrphanedServices(makeServices([]))).toHaveLength(0);
  });

  it("emits one result per orphaned service", () => {
    const services = makeServices([
      { endpoint: "/api/a", hasProducers: true, hasConsumers: false, repos: ["svc-a"] },
      { endpoint: "/api/b", hasProducers: false, hasConsumers: true, repos: ["svc-b"] },
    ]);

    expect(detectOrphanedServices(services)).toHaveLength(2);
  });

  it("uses repos[0] as the logical location repo", () => {
    const services = makeServices([
      { endpoint: "/api/data", hasProducers: true, hasConsumers: false, repos: ["primary-repo", "other-repo"] },
    ]);

    const results = detectOrphanedServices(services);
    expect(results[0]!.locations![0]!.logicalLocations![0]!.properties!["repo"]).toBe("primary-repo");
  });
});

// ---------------------------------------------------------------------------
// detectCriticalPaths
// ---------------------------------------------------------------------------

describe("detectCriticalPaths", () => {
  it("emits warning when a chain is 4 hops long", () => {
    // repo-a -> repo-b -> repo-c -> repo-d (chain.length === 4)
    const downstreamMap = new Map<string, Set<string>>([
      ["repo-a", new Set(["repo-b"])],
      ["repo-b", new Set(["repo-c"])],
      ["repo-c", new Set(["repo-d"])],
      ["repo-d", new Set()],
    ]);

    const graph: CrossRepoGraph = {
      edges: [],
      repoPairs: new Set(),
      downstreamMap,
      upstreamMap: new Map(),
    };

    const results = detectCriticalPaths(graph);
    const fromA = results.find(
      (r) => r.locations![0]!.logicalLocations![0]!.name === "repo-a",
    );
    expect(fromA).toBeDefined();
    expect(fromA!.ruleId).toBe("cross-repo/critical-path");
    expect(fromA!.level).toBe("warning");
    expect(fromA!.properties!["chainLength"]).toBe(4);
  });

  it("does NOT emit warning for chains shorter than 4", () => {
    // repo-a -> repo-b -> repo-c (3 nodes)
    const downstreamMap = new Map<string, Set<string>>([
      ["repo-a", new Set(["repo-b"])],
      ["repo-b", new Set(["repo-c"])],
      ["repo-c", new Set()],
    ]);

    const graph: CrossRepoGraph = {
      edges: [],
      repoPairs: new Set(),
      downstreamMap,
      upstreamMap: new Map(),
    };

    expect(detectCriticalPaths(graph)).toHaveLength(0);
  });

  it("returns empty array for an empty graph", () => {
    const graph: CrossRepoGraph = {
      edges: [],
      repoPairs: new Set(),
      downstreamMap: new Map(),
      upstreamMap: new Map(),
    };
    expect(detectCriticalPaths(graph)).toHaveLength(0);
  });

  it("reports relatedLocations for the repos in the chain (excluding start)", () => {
    const downstreamMap = new Map<string, Set<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["d"])],
      ["d", new Set()],
    ]);

    const graph: CrossRepoGraph = {
      edges: [],
      repoPairs: new Set(),
      downstreamMap,
      upstreamMap: new Map(),
    };

    const results = detectCriticalPaths(graph);
    const fromA = results.find(
      (r) => r.locations![0]!.logicalLocations![0]!.name === "a",
    )!;
    // relatedLocations should be b, c, d (chain minus the start)
    expect(fromA.relatedLocations).toHaveLength(3);
  });

  it("handles branching chains and reports the longest", () => {
    // a -> b -> c -> d -> e (5 hops from a)
    // a -> x (only 2 hops)
    const downstreamMap = new Map<string, Set<string>>([
      ["a", new Set(["b", "x"])],
      ["b", new Set(["c"])],
      ["c", new Set(["d"])],
      ["d", new Set(["e"])],
      ["e", new Set()],
      ["x", new Set()],
    ]);

    const graph: CrossRepoGraph = {
      edges: [],
      repoPairs: new Set(),
      downstreamMap,
      upstreamMap: new Map(),
    };

    const results = detectCriticalPaths(graph);
    const fromA = results.find(
      (r) => r.locations![0]!.logicalLocations![0]!.name === "a",
    )!;
    expect(fromA).toBeDefined();
    expect(fromA.properties!["chainLength"]).toBe(5);
  });
});
