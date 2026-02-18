import { describe, it, expect } from "vitest";
import { findDependentsOf, findDependenciesOf } from "./dependencies.js";
import type { DependencyGraph } from "@mma/core";

function makeGraph(
  edges: Array<{ source: string; target: string }>,
): DependencyGraph {
  return {
    repo: "test-repo",
    edges: edges.map((e) => ({ ...e, kind: "imports" as const })),
    circularDependencies: [],
  };
}

describe("findDependentsOf", () => {
  it("returns modules that import the target", () => {
    const graph = makeGraph([
      { source: "a.ts", target: "shared.ts" },
      { source: "b.ts", target: "shared.ts" },
      { source: "c.ts", target: "other.ts" },
    ]);

    const dependents = findDependentsOf(graph, "shared.ts");
    expect(dependents).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty for module with no dependents", () => {
    const graph = makeGraph([{ source: "a.ts", target: "b.ts" }]);
    expect(findDependentsOf(graph, "a.ts")).toEqual([]);
  });

  it("returns empty for unknown module", () => {
    const graph = makeGraph([{ source: "a.ts", target: "b.ts" }]);
    expect(findDependentsOf(graph, "z.ts")).toEqual([]);
  });
});

describe("findDependenciesOf", () => {
  it("returns modules that the source imports", () => {
    const graph = makeGraph([
      { source: "app.ts", target: "utils.ts" },
      { source: "app.ts", target: "config.ts" },
      { source: "other.ts", target: "utils.ts" },
    ]);

    const deps = findDependenciesOf(graph, "app.ts");
    expect(deps).toEqual(["utils.ts", "config.ts"]);
  });

  it("returns empty for module with no dependencies", () => {
    const graph = makeGraph([{ source: "a.ts", target: "b.ts" }]);
    expect(findDependenciesOf(graph, "b.ts")).toEqual([]);
  });

  it("returns empty for unknown module", () => {
    const graph = makeGraph([{ source: "a.ts", target: "b.ts" }]);
    expect(findDependenciesOf(graph, "z.ts")).toEqual([]);
  });
});
