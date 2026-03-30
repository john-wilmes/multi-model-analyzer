import { describe, it, expect } from "vitest";
import { buildFeatureModel } from "./feature-model.js";
import type { FlagInventory, DependencyGraph, FeatureFlag, ConfigInventory, ConfigParameter } from "@mma/core";

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
    expect(implies[0]!.flags).toHaveLength(2);
    expect(implies[0]!.flags).toEqual(["A", "B"]);
  });

  it("preserves both directions for bidirectional requires constraints", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [
        flag("FEATURE_X", "src/x.ts"),
        flag("FEATURE_Y", "src/y.ts"),
      ],
    };
    // Bidirectional dependency: X imports Y AND Y imports X
    const graph = makeGraph([
      { source: "src/x.ts", target: "src/y.ts" },
      { source: "src/y.ts", target: "src/x.ts" },
    ]);

    const model = buildFeatureModel(inventory, graph);
    const requires = model.constraints.filter((c) => c.kind === "requires");
    // Both directions should be preserved: X->Y and Y->X
    expect(requires).toHaveLength(2);
    const directions = requires.map((c) => `${c.flags[0]}->${c.flags[1]}`);
    expect(directions).toContain("FEATURE_X->FEATURE_Y");
    expect(directions).toContain("FEATURE_Y->FEATURE_X");
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

// ---------------------------------------------------------------------------
// buildFeatureModel with ConfigInventory
// ---------------------------------------------------------------------------

function param(name: string, module: string, kind: "setting" | "credential" | "flag" = "setting", scope?: string): ConfigParameter {
  return { name, locations: [{ repo: "test-repo", module }], kind, ...(scope ? { scope } : {}) };
}

describe("buildFeatureModel with configInventory", () => {
  it("includes parameters in the model when configInventory is provided", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [flag("FEATURE_A", "src/a.ts")],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [param("timeout", "src/config.ts")],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    expect(model.parameters).toHaveLength(1);
    expect(model.parameters![0]!.name).toBe("timeout");
  });

  it("does not include parameters when configInventory is omitted", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [flag("FEATURE_A", "src/a.ts")],
    };

    const model = buildFeatureModel(inventory, makeGraph());
    expect(model.parameters).toBeUndefined();
  });

  it("infers co-location between flag and setting in same file", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [flag("FEATURE_A", "src/config.ts")],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [param("timeout", "src/config.ts")],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(1);
    expect(implies[0]!.flags).toContain("FEATURE_A");
    expect(implies[0]!.flags).toContain("timeout");
  });

  it("infers dependency between setting and flag across modules", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [flag("FEATURE_A", "src/a.ts")],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [param("timeout", "src/b.ts")],
    };
    const graph = makeGraph([{ source: "src/a.ts", target: "src/b.ts" }]);

    const model = buildFeatureModel(inventory, graph, configInventory);
    const requires = model.constraints.filter((c) => c.kind === "requires");
    expect(requires).toHaveLength(1);
    expect(requires[0]!.flags).toContain("FEATURE_A");
    expect(requires[0]!.flags).toContain("timeout");
  });

  it("creates schema-derived enum constraint from parameters with enumValues", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [{
        name: "logLevel",
        locations: [{ repo: "test-repo", module: "src/config.ts" }],
        kind: "setting",
        enumValues: ["debug", "info", "warn", "error"],
      }],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const enumC = model.constraints.filter((c) => c.kind === "enum");
    expect(enumC).toHaveLength(1);
    expect(enumC[0]!.source).toBe("schema");
    expect(enumC[0]!.allowedValues).toEqual(["debug", "info", "warn", "error"]);
  });

  it("creates schema-derived range constraint from parameters with rangeMin/rangeMax", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [{
        name: "port",
        locations: [{ repo: "test-repo", module: "src/config.ts" }],
        kind: "setting",
        rangeMin: 1,
        rangeMax: 65535,
      }],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const range = model.constraints.filter((c) => c.kind === "range");
    expect(range).toHaveLength(1);
    expect(range[0]!.source).toBe("schema");
    expect(range[0]!.description).toContain("1..65535");
  });

  it("skips co-location constraint between params in different scopes", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [
        param("dbURL", "src/config.ts", "setting", "integrator-config"),
        param("orgName", "src/config.ts", "setting", "account-setting"),
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(0);
  });

  it("infers co-location constraint between params in same scope", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [
        param("dbURL", "src/config.ts", "setting", "integrator-config"),
        param("port", "src/config.ts", "setting", "integrator-config"),
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(1);
    expect(implies[0]!.flags).toContain("dbURL");
    expect(implies[0]!.flags).toContain("port");
  });

  it("infers co-location between unscoped param and scoped param", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [
        param("dbURL", "src/config.ts", "setting", "integrator-config"),
        param("timeout", "src/config.ts"),
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(1);
  });

  it("infers co-location between flag and scoped param in same file", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [flag("FEATURE_A", "src/config.ts")],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [
        param("dbURL", "src/config.ts", "setting", "integrator-config"),
      ],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const implies = model.constraints.filter((c) => c.kind === "implies");
    expect(implies).toHaveLength(1);
    expect(implies[0]!.flags).toContain("FEATURE_A");
    expect(implies[0]!.flags).toContain("dbURL");
  });

  it("skips dependency constraint between params in different scopes", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [
        param("dbURL", "src/a.ts", "setting", "integrator-config"),
        param("orgName", "src/b.ts", "setting", "account-setting"),
      ],
    };
    const graph = makeGraph([{ source: "src/a.ts", target: "src/b.ts" }]);

    const model = buildFeatureModel(inventory, graph, configInventory);
    const requires = model.constraints.filter((c) => c.kind === "requires");
    expect(requires).toHaveLength(0);
  });

  it("infers dependency constraint between params in same scope", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [
        param("dbURL", "src/a.ts", "setting", "integrator-config"),
        param("port", "src/b.ts", "setting", "integrator-config"),
      ],
    };
    const graph = makeGraph([{ source: "src/a.ts", target: "src/b.ts" }]);

    const model = buildFeatureModel(inventory, graph, configInventory);
    const requires = model.constraints.filter((c) => c.kind === "requires");
    expect(requires).toHaveLength(1);
    expect(requires[0]!.flags).toEqual(["dbURL", "port"]);
  });

  it("does not create enum constraint for fewer than 2 enumValues", () => {
    const inventory: FlagInventory = {
      repo: "test-repo",
      flags: [],
    };
    const configInventory: ConfigInventory = {
      repo: "test-repo",
      parameters: [{
        name: "mode",
        locations: [{ repo: "test-repo", module: "src/config.ts" }],
        kind: "setting",
        enumValues: ["only"],
      }],
    };

    const model = buildFeatureModel(inventory, makeGraph(), configInventory);
    const enumC = model.constraints.filter((c) => c.kind === "enum");
    expect(enumC).toHaveLength(0);
  });
});
