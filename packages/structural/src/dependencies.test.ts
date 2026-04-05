import { describe, it, expect } from "vitest";
import { findDependentsOf, findDependenciesOf, findCircularDependencies, resolveImportSpecifier } from "./dependencies.js";
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

describe("resolveImportSpecifier", () => {
  const known = new Set(["src/utils.ts", "src/config.ts", "src/index.ts", "lib/helper.js"]);

  it("resolves relative import with .ts extension", () => {
    expect(resolveImportSpecifier("./utils", "src/app.ts", known)).toBe("src/utils.ts");
  });

  it("resolves relative import with explicit extension", () => {
    expect(resolveImportSpecifier("./config.ts", "src/app.ts", known)).toBe("src/config.ts");
  });

  it("resolves parent-dir imports", () => {
    expect(resolveImportSpecifier("../lib/helper", "src/app.ts", known)).toBe("lib/helper.js");
  });

  it("resolves index file", () => {
    expect(resolveImportSpecifier(".", "src/app.ts", known)).toBe("src/index.ts");
  });

  it("returns raw specifier for non-relative imports", () => {
    expect(resolveImportSpecifier("lodash", "src/app.ts", known)).toBe("lodash");
  });

  it("falls back to raw specifier when no match found", () => {
    expect(resolveImportSpecifier("./missing", "src/app.ts", known)).toBe("./missing");
  });

  it("resolves CJS require with .js extension to .ts source", () => {
    // require('./utils.js') should resolve to utils.ts when the .ts file is known
    expect(resolveImportSpecifier("./utils.js", "src/app.ts", known)).toBe("src/utils.ts");
  });
});

describe("resolveImportSpecifier with packageRoots", () => {
  const known = new Set([
    "packages/utils/src/index.ts",
    "packages/utils/src/helpers.ts",
    "packages/core/src/index.ts",
    "packages/core/src/types.ts",
    "src/app.ts",
  ]);

  const packageRoots = new Map([
    ["@myorg/utils", "packages/utils"],
    ["@myorg/core", "packages/core"],
  ]);

  it("resolves scoped package to index file", () => {
    expect(
      resolveImportSpecifier("@myorg/utils", "src/app.ts", known, packageRoots),
    ).toBe("packages/utils/src/index.ts");
  });

  it("resolves scoped package with subpath", () => {
    expect(
      resolveImportSpecifier("@myorg/utils/helpers", "src/app.ts", known, packageRoots),
    ).toBe("packages/utils/src/helpers.ts");
  });

  it("resolves different scoped package", () => {
    expect(
      resolveImportSpecifier("@myorg/core/types", "src/app.ts", known, packageRoots),
    ).toBe("packages/core/src/types.ts");
  });

  it("falls back to raw specifier for unknown packages", () => {
    expect(
      resolveImportSpecifier("@myorg/unknown", "src/app.ts", known, packageRoots),
    ).toBe("@myorg/unknown");
  });

  it("falls back to raw specifier when packageRoots is not provided", () => {
    expect(
      resolveImportSpecifier("@myorg/utils", "src/app.ts", known),
    ).toBe("@myorg/utils");
  });

  it("resolves plain (non-scoped) package with subpath", () => {
    const roots = new Map([["mylib", "packages/utils"]]);
    expect(
      resolveImportSpecifier("mylib/helpers", "src/app.ts", known, roots),
    ).toBe("packages/utils/src/helpers.ts");
  });
});

describe("findDependentsOf / findDependenciesOf edge cases", () => {
  it("module that is both source and target of edges", () => {
    const graph = makeGraph([
      { source: "a.ts", target: "b.ts" },
      { source: "b.ts", target: "c.ts" },
      { source: "c.ts", target: "b.ts" },
    ]);

    expect(findDependentsOf(graph, "b.ts")).toEqual(["a.ts", "c.ts"]);
    expect(findDependenciesOf(graph, "b.ts")).toEqual(["c.ts"]);
  });

  it("self-referencing module (imports itself)", () => {
    const graph = makeGraph([{ source: "a.ts", target: "a.ts" }]);
    expect(findDependentsOf(graph, "a.ts")).toEqual(["a.ts"]);
    expect(findDependenciesOf(graph, "a.ts")).toEqual(["a.ts"]);
  });

  it("graph with duplicate edges counts each occurrence", () => {
    const graph = makeGraph([
      { source: "a.ts", target: "b.ts" },
      { source: "a.ts", target: "b.ts" },
    ]);
    // Both edge instances are returned (no dedup in find functions)
    expect(findDependentsOf(graph, "b.ts")).toEqual(["a.ts", "a.ts"]);
    expect(findDependenciesOf(graph, "a.ts")).toEqual(["b.ts", "b.ts"]);
  });

  it("handles empty graph", () => {
    const graph = makeGraph([]);
    expect(findDependentsOf(graph, "any.ts")).toEqual([]);
    expect(findDependenciesOf(graph, "any.ts")).toEqual([]);
  });
});

function makeEdges(
  pairs: Array<[string, string]>,
): Array<{ source: string; target: string; kind: "imports"; metadata: Record<string, string> }> {
  return pairs.map(([s, t]) => ({ source: s, target: t, kind: "imports" as const, metadata: {} }));
}

describe("findCircularDependencies", () => {
  it("detects a simple two-node cycle", () => {
    const cycles = findCircularDependencies(makeEdges([["a", "b"], ["b", "a"]]));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    // At least one cycle should contain both a and b
    const hasCycle = cycles.some((c) => c.includes("a") && c.includes("b"));
    expect(hasCycle).toBe(true);
  });

  it("detects a three-node cycle", () => {
    const cycles = findCircularDependencies(makeEdges([["a", "b"], ["b", "c"], ["c", "a"]]));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const hasCycle = cycles.some((c) => c.length === 3 && c.includes("a") && c.includes("b") && c.includes("c"));
    expect(hasCycle).toBe(true);
  });

  it("returns empty for acyclic graph", () => {
    const cycles = findCircularDependencies(makeEdges([["a", "b"], ["b", "c"], ["a", "c"]]));
    expect(cycles).toEqual([]);
  });

  it("detects self-loop", () => {
    const cycles = findCircularDependencies(makeEdges([["a", "a"]]));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles.some((c) => c.includes("a"))).toBe(true);
  });

  it("detects cycles in disconnected components", () => {
    // Component 1: a -> b -> a
    // Component 2: c -> d -> c
    // No edges between components
    const cycles = findCircularDependencies(makeEdges([
      ["a", "b"], ["b", "a"],
      ["c", "d"], ["d", "c"],
    ]));
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    const hasAB = cycles.some((c) => c.includes("a") && c.includes("b"));
    const hasCD = cycles.some((c) => c.includes("c") && c.includes("d"));
    expect(hasAB).toBe(true);
    expect(hasCD).toBe(true);
  });

  it("detects cycle reachable through non-cyclic prefix", () => {
    // x -> a -> b -> a (x is not in the cycle, but leads to it)
    const cycles = findCircularDependencies(makeEdges([["x", "a"], ["a", "b"], ["b", "a"]]));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const hasCycle = cycles.some((c) => c.includes("a") && c.includes("b") && !c.includes("x"));
    expect(hasCycle).toBe(true);
  });

  it("detects multiple cycles sharing nodes", () => {
    // Cycle 1: a -> b -> c -> a
    // Cycle 2: b -> c -> d -> b
    const cycles = findCircularDependencies(makeEdges([
      ["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"], ["d", "b"],
    ]));
    expect(cycles.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty edge list", () => {
    expect(findCircularDependencies([])).toEqual([]);
  });

  it("finds cycle when cross-component edge connects to visited node", () => {
    // A -> C (cross-component), B -> C -> B (cycle in component 2)
    // A is processed first, visits C. Then B starts DFS and should still find B->C->B.
    const cycles = findCircularDependencies(makeEdges([
      ["a", "c"], ["b", "c"], ["c", "b"],
    ]));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const hasCycle = cycles.some((c) => c.includes("b") && c.includes("c"));
    expect(hasCycle).toBe(true);
  });

  it("detects cycle B->C->D->B when A->C creates a shared non-cyclic entry point", () => {
    // Regression test for the naive DFS bug: adding nodes to `visited` on entry
    // (before processing neighbors) would mark C as BLACK when A visits it first.
    // Then when B->C->D->B is traversed, C appears BLACK and the DFS short-circuits,
    // missing the cycle entirely.
    //
    // Edges: A->C, B->C, C->D, D->B
    // Only cycle: B->C->D->B (A is not part of any cycle)
    const cycles = findCircularDependencies(makeEdges([
      ["a", "c"], ["b", "c"], ["c", "d"], ["d", "b"],
    ]));
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const hasCycle = cycles.some(
      (c) => c.includes("b") && c.includes("c") && c.includes("d") && !c.includes("a"),
    );
    expect(hasCycle).toBe(true);
  });
});

describe("resolveImportSpecifier with @/ path alias", () => {
  const known = new Set([
    "src/utils/helpers.ts",
    "src/components/Button.tsx",
    "src/index.ts",
    "src/config.ts",
    "src/hooks/useAuth/index.ts",
  ]);

  it("resolves @/ alias to src/ directory with .ts extension", () => {
    expect(resolveImportSpecifier("@/config", "src/app.ts", known)).toBe("src/config.ts");
  });

  it("resolves @/ alias with nested path", () => {
    expect(resolveImportSpecifier("@/utils/helpers", "src/app.ts", known)).toBe("src/utils/helpers.ts");
  });

  it("resolves @/ alias with .tsx extension", () => {
    expect(resolveImportSpecifier("@/components/Button", "src/app.ts", known)).toBe("src/components/Button.tsx");
  });

  it("resolves @/ alias to index file in subdirectory", () => {
    expect(resolveImportSpecifier("@/hooks/useAuth", "src/app.ts", known)).toBe("src/hooks/useAuth/index.ts");
  });

  it("resolves @/ alias regardless of importer location", () => {
    expect(resolveImportSpecifier("@/config", "src/deep/nested/file.ts", known)).toBe("src/config.ts");
  });

  it("falls back to raw specifier when @/ alias cannot be resolved", () => {
    expect(resolveImportSpecifier("@/nonexistent", "src/app.ts", known)).toBe("@/nonexistent");
  });

  it("resolves @/ when files are at project root (no src/ prefix)", () => {
    const rootKnown = new Set(["utils/helpers.ts", "config.ts"]);
    expect(resolveImportSpecifier("@/config", "app.ts", rootKnown)).toBe("config.ts");
    expect(resolveImportSpecifier("@/utils/helpers", "app.ts", rootKnown)).toBe("utils/helpers.ts");
  });

  it("does not confuse @/ with scoped packages like @org/pkg", () => {
    // @org/pkg should NOT be treated as @/ alias
    expect(resolveImportSpecifier("@org/pkg", "src/app.ts", known)).toBe("@org/pkg");
  });
});

describe("resolveImportSpecifier edge cases", () => {
  it("deeply nested relative import with multiple parent dirs", () => {
    // src/deep/nested/ + ../../lib/utils → src/lib/utils
    const known = new Set(["src/lib/utils.ts"]);
    expect(resolveImportSpecifier("../../lib/utils", "src/deep/nested/app.ts", known)).toBe("src/lib/utils.ts");
  });

  it("resolves .jsx extension", () => {
    const known = new Set(["src/Component.jsx"]);
    expect(resolveImportSpecifier("./Component", "src/app.ts", known)).toBe("src/Component.jsx");
  });

  it("resolves index.tsx", () => {
    const known = new Set(["src/components/index.tsx"]);
    expect(resolveImportSpecifier("./components", "src/app.ts", known)).toBe("src/components/index.tsx");
  });

  it("file in root directory (no slashes in importer)", () => {
    const known = new Set(["utils.ts"]);
    expect(resolveImportSpecifier("./utils", "app.ts", known)).toBe("utils.ts");
  });

  it("import with trailing .js extension (common in ESM)", () => {
    const known = new Set(["src/helper.js"]);
    expect(resolveImportSpecifier("./helper.js", "src/app.ts", known)).toBe("src/helper.js");
  });
});
