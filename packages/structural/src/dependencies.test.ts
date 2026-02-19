import { describe, it, expect } from "vitest";
import { findDependentsOf, findDependenciesOf, resolveImportSpecifier } from "./dependencies.js";
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
});
