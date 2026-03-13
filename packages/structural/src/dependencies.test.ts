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
