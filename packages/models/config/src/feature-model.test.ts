import { describe, it, expect } from "vitest";
import { buildFeatureModel } from "./feature-model.js";
import type { FlagInventory, DependencyGraph, FeatureFlag } from "@mma/core";

function flag(name: string, module: string): FeatureFlag {
  return { name, locations: [{ repo: "test-repo", module }] };
}

function makeGraph(
  edges: Array<{ source: string; target: string }> = [],
): DependencyGraph {
  return {
    repo: "test-repo",
    edges: edges.map((e) => ({ ...e, kind: "imports" as const })),
    circularDependencies: [],
  };
}

describe("buildFeatureModel", () => {
  it("returns flags from inventory", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [flag("FEATURE_A", "src/a.ts")],
    };

    const model = buildFeatureModel(inventory, makeGraph());
    expect(model.flags).toHaveLength(1);
    expect(model.flags[0]!.name).toBe("FEATURE_A");
  });

  it("infers co-location constraints for flags in same file", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [
        flag("FEATURE_A", "src/config.ts"),
        flag("FEATURE_B", "src/config.ts"),
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph());
    expect(model.constraints).toHaveLength(1);

    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(1);
    expect(implies[0]!.flags).toContain("FEATURE_A");
    expect(implies[0]!.flags).toContain("FEATURE_B");
    expect(implies[0]!.source).toBe("inferred");
  });

  it("infers dependency-based constraints from graph edges", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [
        flag("FEATURE_X", "src/x.ts"),
        flag("FEATURE_Y", "src/y.ts"),
      ],
    };
    const graph = makeGraph([
      { source: "src/x.ts", target: "src/y.ts" },
    ]);

    const model = buildFeatureModel(inventory, graph);
    const requires = model.constraints.filter((c) => c.kind === "requires");
    expect(requires).toHaveLength(1);
    expect(requires[0]!.flags).toContain("FEATURE_X");
    expect(requires[0]!.flags).toContain("FEATURE_Y");
  });

  it("deduplicates constraints", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [
        { name: "A", locations: [{ repo: "test-repo", module: "src/a.ts" }, { repo: "test-repo", module: "src/b.ts" }] },
        { name: "B", locations: [{ repo: "test-repo", module: "src/a.ts" }, { repo: "test-repo", module: "src/b.ts" }] },
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph());
    // Co-location in both src/a.ts and src/b.ts should deduplicate
    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(1);
  });

  it("returns empty constraints when flags are in separate files with no deps", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [
        flag("FEATURE_A", "src/a.ts"),
        flag("FEATURE_B", "src/b.ts"),
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph());
    expect(model.constraints).toHaveLength(0);
  });
});
