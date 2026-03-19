/**
 * Tests for Z3 feature model validation (heuristic mode).
 */

import { describe, it, expect } from "vitest";
import type { FeatureModel, FeatureFlag, FeatureConstraint } from "@mma/core";
import { validateFeatureModel, CONFIG_RULES } from "./z3.js";

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

function makeModel(flags: FeatureFlag[], constraints: FeatureConstraint[]): FeatureModel {
  return { flags, constraints };
}

describe("CONFIG_RULES", () => {
  it("defines expected rule IDs", () => {
    const ids = CONFIG_RULES.map((r) => r.id);

    expect(ids).toContain("config/dead-flag");
    expect(ids).toContain("config/always-on-flag");
    expect(ids).toContain("config/missing-constraint");
    expect(ids).toContain("config/untested-interaction");
    expect(ids).toContain("config/format-violation");
  });
});

describe("validateFeatureModel", () => {
  it("returns empty results for a model with no constraints", async () => {
    const model = makeModel([makeFlag("featureA")], []);

    const { results, validation } = await validateFeatureModel(model, "repo");

    expect(results).toHaveLength(0);
    expect(validation.deadFlags).toHaveLength(0);
    expect(validation.alwaysOnFlags).toHaveLength(0);
    expect(validation.impossibleCombinations).toHaveLength(0);
    expect(validation.inferredUntestedPairs).toHaveLength(0);
  });

  it("detects dead flags (excluded but not required by any)", async () => {
    const model = makeModel(
      [makeFlag("live"), makeFlag("dead")],
      [makeConstraint("excludes", ["live", "dead"])],
    );

    const { results, validation } = await validateFeatureModel(model, "repo");

    // Both flags are in the excludes constraint and neither is required, so both are dead
    expect(validation.deadFlags).toContain("live");
    expect(validation.deadFlags).toContain("dead");
    const deadResults = results.filter((r) => r.ruleId === "config/dead-flag");
    expect(deadResults.length).toBe(2);
  });

  it("does not mark flag as dead if it is required by another", async () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b")],
      [
        makeConstraint("excludes", ["a", "b"]),
        makeConstraint("requires", ["a", "b"]),
      ],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.deadFlags).not.toContain("b");
  });

  it("detects always-on flags (required by all others, no exclusions)", async () => {
    // Always-on requires: isRequired (flags[0] === name), no exclusions,
    // and requiringFlags.length === flags.length - 1 (counting self-references)
    const model = makeModel(
      [makeFlag("core"), makeFlag("a"), makeFlag("b"), makeFlag("c")],
      [
        makeConstraint("requires", ["core", "core"]),
        makeConstraint("requires", ["a", "core"]),
        makeConstraint("requires", ["b", "core"]),
        // requiringFlags = ["core", "a", "b"], length 3 = flags.length - 1
      ],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.alwaysOnFlags).toContain("core");
  });

  it("does not mark flag as always-on when excluded somewhere", async () => {
    const flags = [makeFlag("core"), makeFlag("a")];
    const constraints = [
      makeConstraint("requires", ["core", "core"]),
      makeConstraint("excludes", ["a", "core"]),
    ];
    const model = makeModel(flags, constraints);

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.alwaysOnFlags).not.toContain("core");
  });

  it("detects impossible combinations from mutex constraints", async () => {
    const model = makeModel(
      [makeFlag("x"), makeFlag("y")],
      [makeConstraint("mutex", ["x", "y"])],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.impossibleCombinations).toHaveLength(1);
    expect(validation.impossibleCombinations[0]).toEqual(["x", "y"]);
  });

  it("detects untested interactions from inferred constraints", async () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b")],
      [makeConstraint("requires", ["a", "b"], "inferred")],
    );

    const { results, validation } = await validateFeatureModel(model, "repo");

    expect(validation.inferredUntestedPairs).toHaveLength(1);
    expect(validation.inferredUntestedPairs[0]).toEqual(["a", "b"]);
    const untestedResult = results.find((r) => r.ruleId === "config/untested-interaction");
    expect(untestedResult).toBeDefined();
  });

  it("ignores human-sourced constraints for untested interactions", async () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b")],
      [makeConstraint("requires", ["a", "b"], "human")],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.inferredUntestedPairs).toHaveLength(0);
  });

  it("produces SARIF results with correct locations", async () => {
    const model = makeModel(
      [makeFlag("dead-flag")],
      [makeConstraint("excludes", ["other", "dead-flag"])],
    );

    const { results } = await validateFeatureModel(model, "my-repo");

    const result = results[0]!;
    expect(result.locations).toBeDefined();
    expect(result.locations![0]!.logicalLocations![0]!.properties).toEqual({ repo: "my-repo" });
  });

  it("reports always-on flags as SARIF note level", async () => {
    // Use the same 4-flag setup as the "detects always-on" test so the heuristic
    // fires: requiringFlags.length (3) === flags.length - 1 (3).
    const flags = [makeFlag("core"), makeFlag("a"), makeFlag("b"), makeFlag("c")];
    const constraints = [
      makeConstraint("requires", ["core", "core"]),
      makeConstraint("requires", ["a", "core"]),
      makeConstraint("requires", ["b", "core"]),
      // requiringFlags = ["core", "a", "b"], length 3 = flags.length - 1
    ];
    const { results } = await validateFeatureModel(makeModel(flags, constraints), "repo");

    const alwaysOnResult = results.find((r) => r.ruleId === "config/always-on-flag");
    expect(alwaysOnResult).toBeDefined();
    expect(alwaysOnResult!.level).toBe("note");
  });
});
