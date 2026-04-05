/**
 * Tests for IPOG covering array generation and interaction strength computation.
 */

import { describe, it, expect } from "vitest";
import type { FeatureModel, FeatureFlag, FeatureConstraint, ConfigParameter } from "@mma/core";
import { generateCoveringArray, computeInteractionStrength } from "./covering-array.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFlag(name: string): FeatureFlag {
  return { name, locations: [] };
}

function makeConstraint(
  kind: FeatureConstraint["kind"],
  flags: string[],
  source: "inferred" | "human" = "human",
): FeatureConstraint {
  return { kind, flags, description: `${kind} on ${flags.join(",")}`, source };
}

function makeParam(
  name: string,
  overrides: Partial<ConfigParameter> = {},
): ConfigParameter {
  return { name, locations: [], kind: "setting", ...overrides };
}

function makeModel(
  flags: FeatureFlag[],
  constraints: FeatureConstraint[],
  parameters?: ConfigParameter[],
): FeatureModel {
  return { flags, constraints, ...(parameters ? { parameters } : {}) };
}

/**
 * Verifies that every t-way tuple appears in at least one configuration.
 * Returns counts of covered vs total tuples for assertion.
 *
 * Uses the same canonical (alphabetically sorted by param name) serialization
 * as the IPOG implementation.
 */
function verifyTupleCoverage(
  configs: readonly Record<string, unknown>[],
  paramNames: string[],
  domains: Map<string, unknown[]>,
  strength: number,
): { covered: number; total: number } {
  function tupleKey(entries: [string, unknown][]): string {
    const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify(sorted);
  }

  // Generate all t-combinations of param indices and enumerate their value assignments
  const allTupleKeys = new Set<string>();
  function combineIndices(start: number, chosen: number[]): void {
    if (chosen.length === strength) {
      const chosenParams = chosen.map((i) => paramNames[i]!);
      const chosenDomains = chosenParams.map((p) => domains.get(p)!);
      function cartesian(dimIdx: number, partial: [string, unknown][]): void {
        if (dimIdx === chosenParams.length) {
          allTupleKeys.add(tupleKey(partial));
          return;
        }
        for (const val of chosenDomains[dimIdx]!) {
          cartesian(dimIdx + 1, [...partial, [chosenParams[dimIdx]!, val]]);
        }
      }
      cartesian(0, []);
      return;
    }
    for (let i = start; i <= paramNames.length - (strength - chosen.length); i++) {
      combineIndices(i + 1, [...chosen, i]);
    }
  }
  combineIndices(0, []);

  const total = allTupleKeys.size;
  const uncovered = new Set(allTupleKeys);

  // Mark tuples covered by each config row
  for (const config of configs) {
    function markCombos(start: number, chosen: number[]): void {
      if (chosen.length === strength) {
        const entries: [string, unknown][] = chosen.map((i) => [
          paramNames[i]!,
          config[paramNames[i]!],
        ]);
        uncovered.delete(tupleKey(entries));
        return;
      }
      for (let i = start; i <= paramNames.length - (strength - chosen.length); i++) {
        markCombos(i + 1, [...chosen, i]);
      }
    }
    markCombos(0, []);
  }

  return { covered: total - uncovered.size, total };
}

// ---------------------------------------------------------------------------
// generateCoveringArray — basic cases
// ---------------------------------------------------------------------------

describe("generateCoveringArray — basic cases", () => {
  it("3 boolean parameters at strength 2 — all pairs covered", () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b"), makeFlag("c")],
      [],
    );

    const result = generateCoveringArray(model, { strength: 2 });

    expect(result.strength).toBe(2);
    expect(result.parameterCount).toBe(3);
    expect(result.coverageStats.coveragePercent).toBe(100);

    const domains = new Map<string, unknown[]>([
      ["a", [true, false]],
      ["b", [true, false]],
      ["c", [true, false]],
    ]);
    const { covered, total } = verifyTupleCoverage(
      result.configurations,
      ["a", "b", "c"],
      domains,
      2,
    );
    expect(covered).toBe(total);
    // C(3,2) × 2^2 = 12 total pairs
    expect(total).toBe(12);
  });

  it("parameters with enum values — pairwise coverage", () => {
    // mode: 3 enum values, featureX: boolean, featureY: boolean
    const model = makeModel(
      [],
      [],
      [
        makeParam("mode", { enumValues: ["fast", "medium", "slow"] }),
        makeParam("featureX", { valueType: "boolean" }),
        makeParam("featureY", { valueType: "boolean" }),
      ],
    );

    const result = generateCoveringArray(model, { strength: 2 });

    expect(result.strength).toBe(2);
    expect(result.parameterCount).toBe(3);
    expect(result.coverageStats.coveragePercent).toBe(100);

    const domains = new Map<string, unknown[]>([
      ["mode", ["fast", "medium", "slow"]],
      ["featureX", [true, false]],
      ["featureY", [true, false]],
    ]);
    const { covered, total } = verifyTupleCoverage(
      result.configurations,
      ["mode", "featureX", "featureY"],
      domains,
      2,
    );
    expect(covered).toBe(total);
    // C(3,2) pairs: mode×featureX (3×2=6), mode×featureY (3×2=6), featureX×featureY (2×2=4) = 16
    expect(total).toBe(16);
  });

  it("strength 3 with small parameter set — all triples covered", () => {
    const model = makeModel(
      [makeFlag("p"), makeFlag("q"), makeFlag("r"), makeFlag("s")],
      [],
    );

    const result = generateCoveringArray(model, { strength: 3 });

    expect(result.strength).toBe(3);
    expect(result.parameterCount).toBe(4);
    expect(result.coverageStats.coveragePercent).toBe(100);

    const domains = new Map<string, unknown[]>([
      ["p", [true, false]],
      ["q", [true, false]],
      ["r", [true, false]],
      ["s", [true, false]],
    ]);
    const { covered, total } = verifyTupleCoverage(
      result.configurations,
      ["p", "q", "r", "s"],
      domains,
      3,
    );
    expect(covered).toBe(total);
    // C(4,3) × 2^3 = 4 × 8 = 32 total triples
    expect(total).toBe(32);
  });

  it("single parameter returns empty configurations", () => {
    const model = makeModel([makeFlag("onlyParam")], []);

    const result = generateCoveringArray(model, { strength: 2 });

    expect(result.configurations).toHaveLength(0);
    expect(result.parameterCount).toBe(1);
    expect(result.coverageStats.totalTuples).toBe(0);
    expect(result.coverageStats.coveragePercent).toBe(100);
  });

  it("no parameters returns empty configurations", () => {
    const model = makeModel([], []);

    const result = generateCoveringArray(model);

    expect(result.configurations).toHaveLength(0);
    expect(result.parameterCount).toBe(0);
    expect(result.coverageStats.totalTuples).toBe(0);
    expect(result.coverageStats.coveragePercent).toBe(100);
  });

  it("model with flags only (no ConfigParameter[]) uses boolean domains", () => {
    const model = makeModel(
      [makeFlag("flagA"), makeFlag("flagB"), makeFlag("flagC")],
      [],
      // no parameters array — flags fall back to [true, false] domain
    );

    const result = generateCoveringArray(model, { strength: 2 });

    expect(result.parameterCount).toBe(3);
    expect(result.coverageStats.coveragePercent).toBe(100);

    // Every config value for each flag must be a boolean
    for (const config of result.configurations) {
      for (const key of ["flagA", "flagB", "flagC"]) {
        expect(typeof config[key]).toBe("boolean");
      }
    }
  });

  it("coverageStats totalTuples and coveredTuples are consistent", () => {
    const model = makeModel(
      [makeFlag("x"), makeFlag("y"), makeFlag("z")],
      [],
    );

    const result = generateCoveringArray(model, { strength: 2 });

    // C(3,2) × 2^2 = 12 total tuples
    expect(result.coverageStats.totalTuples).toBe(12);
    expect(result.coverageStats.coveredTuples).toBe(result.coverageStats.totalTuples);
    expect(result.coverageStats.coveragePercent).toBe(100);
  });

  it("result configurations contain all active parameter keys", () => {
    const model = makeModel(
      [makeFlag("alpha"), makeFlag("beta"), makeFlag("gamma")],
      [],
    );

    const result = generateCoveringArray(model, { strength: 2 });

    for (const config of result.configurations) {
      expect("alpha" in config).toBe(true);
      expect("beta" in config).toBe(true);
      expect("gamma" in config).toBe(true);
    }
  });

  it("number parameters with range use boundary values in domain", () => {
    const model = makeModel(
      [],
      [],
      [
        makeParam("timeout", { valueType: "number", rangeMin: 0, rangeMax: 100 }),
        makeParam("retries", { valueType: "number", rangeMin: 1, rangeMax: 5 }),
      ],
    );

    const result = generateCoveringArray(model, { strength: 2 });

    // timeout domain: [0, 50, 100]; retries domain: [1, 3, 5] — 3 values each, pairs: 3×3=9
    expect(result.coverageStats.coveragePercent).toBe(100);
    expect(result.coverageStats.totalTuples).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// generateCoveringArray — constraint-aware mode
// ---------------------------------------------------------------------------

describe("generateCoveringArray — constraint-aware mode", () => {
  it("model with mutex constraint — no configs violate mutex", () => {
    const model = makeModel(
      [makeFlag("modeA"), makeFlag("modeB"), makeFlag("extra")],
      [makeConstraint("mutex", ["modeA", "modeB"])],
    );

    const result = generateCoveringArray(model, { strength: 2, constraintAware: true });

    for (const config of result.configurations) {
      const bothActive = config["modeA"] === true && config["modeB"] === true;
      expect(bothActive).toBe(false);
    }
  });

  it("model with excludes constraint — excluded combos do not appear", () => {
    const model = makeModel(
      [makeFlag("legacyMode"), makeFlag("newMode"), makeFlag("debug")],
      [makeConstraint("excludes", ["legacyMode", "newMode"])],
    );

    const result = generateCoveringArray(model, { strength: 2, constraintAware: true });

    for (const config of result.configurations) {
      const bothEnabled = config["legacyMode"] === true && config["newMode"] === true;
      expect(bothEnabled).toBe(false);
    }
  });

  it("disabling constraintAware skips constraint filtering", () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b"), makeFlag("c")],
      [makeConstraint("excludes", ["a", "b"])],
    );

    const resultConstrained = generateCoveringArray(model, { strength: 2, constraintAware: true });
    const resultUnconstrained = generateCoveringArray(model, { strength: 2, constraintAware: false });

    // Unconstrained should have at least as many configs (no filtering removes rows)
    expect(resultUnconstrained.configurations.length).toBeGreaterThanOrEqual(
      resultConstrained.configurations.length,
    );
    // Both should produce a non-empty result
    expect(resultUnconstrained.configurations.length).toBeGreaterThan(0);
  });

  it("constraintAware defaults to true", () => {
    const model = makeModel(
      [makeFlag("x"), makeFlag("y"), makeFlag("z")],
      [makeConstraint("mutex", ["x", "y"])],
    );

    // No options passed — should default to constraintAware: true
    const result = generateCoveringArray(model);

    for (const config of result.configurations) {
      const bothActive = config["x"] === true && config["y"] === true;
      expect(bothActive).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// computeInteractionStrength
// ---------------------------------------------------------------------------

describe("computeInteractionStrength", () => {
  it("parameter absent from all constraints → interactionCount 0 and maxStrength 0", () => {
    const model = makeModel(
      [makeFlag("standalone"), makeFlag("a"), makeFlag("b")],
      [makeConstraint("requires", ["a", "b"])],
    );

    const result = computeInteractionStrength(model, "standalone");

    expect(result.parameter).toBe("standalone");
    expect(result.interactionCount).toBe(0);
    expect(result.interactsWith).toHaveLength(0);
    expect(result.maxStrength).toBe(0);
  });

  it("parameter in 1 binary constraint → interactionCount 1 and maxStrength 2", () => {
    const model = makeModel(
      [makeFlag("featureA"), makeFlag("featureB")],
      [makeConstraint("requires", ["featureA", "featureB"])],
    );

    const result = computeInteractionStrength(model, "featureA");

    expect(result.parameter).toBe("featureA");
    expect(result.interactionCount).toBe(1);
    expect(result.interactsWith).toContain("featureB");
    expect(result.maxStrength).toBe(2);
  });

  it("parameter connected to 3+ others → interactionCount >= 3 and maxStrength matches largest group", () => {
    const model = makeModel(
      [makeFlag("hub"), makeFlag("a"), makeFlag("b"), makeFlag("c"), makeFlag("d")],
      [
        makeConstraint("requires", ["hub", "a"]),          // group size 2
        makeConstraint("requires", ["hub", "b"]),          // group size 2
        makeConstraint("mutex", ["hub", "c"]),             // group size 2
        makeConstraint("excludes", ["hub", "d"]),          // group size 2
      ],
    );

    const result = computeInteractionStrength(model, "hub");

    expect(result.parameter).toBe("hub");
    expect(result.interactionCount).toBeGreaterThanOrEqual(3);
    expect(result.interactsWith).toContain("a");
    expect(result.interactsWith).toContain("b");
    expect(result.interactsWith).toContain("c");
    expect(result.interactsWith).toContain("d");
    expect(result.maxStrength).toBe(2);
  });

  it("maxStrength reflects the largest constraint group size", () => {
    const model = makeModel(
      [makeFlag("p"), makeFlag("q"), makeFlag("r"), makeFlag("s")],
      [
        makeConstraint("requires", ["p", "q"]),       // group size 2
        makeConstraint("mutex", ["p", "r", "s"]),     // group size 3
      ],
    );

    const result = computeInteractionStrength(model, "p");

    expect(result.maxStrength).toBe(3);
    expect(result.interactionCount).toBe(3); // q, r, s
  });

  it("interactsWith is deduplicated when param appears with same partner in multiple constraints", () => {
    const model = makeModel(
      [makeFlag("center"), makeFlag("partner")],
      [
        makeConstraint("requires", ["center", "partner"]),
        makeConstraint("excludes", ["center", "partner"]),
      ],
    );

    const result = computeInteractionStrength(model, "center");

    // "partner" should appear only once despite two constraints
    expect(result.interactsWith.filter((p) => p === "partner")).toHaveLength(1);
    expect(result.interactionCount).toBe(1);
  });

  it("interactsWith is sorted alphabetically", () => {
    const model = makeModel(
      [makeFlag("hub"), makeFlag("zebra"), makeFlag("apple"), makeFlag("mango")],
      [
        makeConstraint("requires", ["hub", "zebra"]),
        makeConstraint("requires", ["hub", "apple"]),
        makeConstraint("requires", ["hub", "mango"]),
      ],
    );

    const result = computeInteractionStrength(model, "hub");

    expect(result.interactsWith).toEqual(["apple", "mango", "zebra"]);
  });

  it("parameter appearing as non-first flag in constraint still counts", () => {
    // computeInteractionStrength checks flags.includes(name), so position doesn't matter
    const model = makeModel(
      [makeFlag("a"), makeFlag("dependency")],
      [makeConstraint("requires", ["a", "dependency"])],
    );

    const result = computeInteractionStrength(model, "dependency");

    expect(result.interactionCount).toBe(1);
    expect(result.interactsWith).toContain("a");
    expect(result.maxStrength).toBe(2);
  });

  it("model with no constraints returns zero interaction for any param", () => {
    const model = makeModel(
      [makeFlag("lone"), makeFlag("other")],
      [],
    );

    const result = computeInteractionStrength(model, "lone");

    expect(result.interactionCount).toBe(0);
    expect(result.interactsWith).toHaveLength(0);
    expect(result.maxStrength).toBe(0);
  });
});
