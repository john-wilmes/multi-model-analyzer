/**
 * Tests for Z3 feature model validation (heuristic mode).
 */

import { describe, it, expect } from "vitest";
import type { FeatureModel, FeatureFlag, FeatureConstraint, ConfigParameter } from "@mma/core";
import { validateFeatureModel, validateConfiguration, CONFIG_RULES } from "./z3.js";

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

function makeParam(name: string, kind: ConfigParameter["kind"] = "setting"): ConfigParameter {
  return { name, locations: [], kind };
}

function makeModel(flags: FeatureFlag[], constraints: FeatureConstraint[], parameters?: ConfigParameter[]): FeatureModel {
  return { flags, constraints, ...(parameters ? { parameters } : {}) };
}

describe("CONFIG_RULES", () => {
  it("defines expected rule IDs", () => {
    const ids = CONFIG_RULES.map((r) => r.id);

    expect(ids).toContain("config/dead-flag");
    expect(ids).toContain("config/always-on-flag");
    expect(ids).toContain("config/missing-constraint");
    expect(ids).toContain("config/untested-interaction");
    expect(ids).toContain("config/format-violation");
    expect(ids).toContain("config/unused-registry-flag");
    expect(ids).toContain("config/unregistered-flag");
    expect(ids).toContain("config/dead-setting");
    expect(ids).toContain("config/missing-dependency");
    expect(ids).toContain("config/conflicting-settings");
    expect(ids).toContain("config/high-interaction-strength");
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

  it("detects high-interaction-strength parameter appearing in 3+ constraints", async () => {
    // "hub" co-occurs with A, B, and C in separate requires constraints
    const model = makeModel(
      [makeFlag("hub"), makeFlag("A"), makeFlag("B"), makeFlag("C")],
      [
        makeConstraint("requires", ["hub", "A"]),
        makeConstraint("requires", ["hub", "B"]),
        makeConstraint("requires", ["hub", "C"]),
      ],
    );

    const { results, validation } = await validateFeatureModel(model, "repo");

    expect(validation.highInteractionParameters).toContain("hub");
    const citResult = results.find((r) => r.ruleId === "config/high-interaction-strength");
    expect(citResult).toBeDefined();
  });

  it("untested-interaction SARIF message says 'Parameter interaction'", async () => {
    // Inferred constraint between a flag and a setting
    const model = makeModel(
      [makeFlag("flagX")],
      [makeConstraint("requires", ["flagX", "settingY"], "inferred")],
      [makeParam("settingY")],
    );

    const { results } = await validateFeatureModel(model, "repo");

    const untestedResult = results.find((r) => r.ruleId === "config/untested-interaction");
    expect(untestedResult).toBeDefined();
    expect(untestedResult!.message.text).toContain("Parameter interaction");
  });

  it("highInteractionParameters is empty when there are no constraints", async () => {
    const model = makeModel([makeFlag("a"), makeFlag("b"), makeFlag("c")], []);

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.highInteractionParameters).toHaveLength(0);
  });
});

describe("unused-registry-flag detection", () => {
  it("detects a registry flag with only one location (unused)", async () => {
    const flag: FeatureFlag = {
      name: "myFlag",
      locations: [{ repo: "r", module: "registry.ts" }],
      isRegistry: true,
    };
    const model = makeModel([flag], []);

    const { results } = await validateFeatureModel(model, "r");

    const found = results.find((r) => r.ruleId === "config/unused-registry-flag");
    expect(found).toBeDefined();
  });

  it("does not flag a registry flag that appears in multiple locations", async () => {
    const flag: FeatureFlag = {
      name: "myFlag",
      locations: [
        { repo: "r", module: "a.ts" },
        { repo: "r", module: "b.ts" },
      ],
      isRegistry: true,
    };
    const model = makeModel([flag], []);

    const { results } = await validateFeatureModel(model, "r");

    const found = results.find((r) => r.ruleId === "config/unused-registry-flag");
    expect(found).toBeUndefined();
  });
});

describe("unregistered-flag detection", () => {
  it("detects a non-registry flag when a registry flag exists in the model", async () => {
    const registryFlag: FeatureFlag = {
      name: "registryFlag",
      locations: [
        { repo: "r", module: "registry.ts" },
        { repo: "r", module: "a.ts" },
      ],
      isRegistry: true,
    };
    const unregisteredFlag: FeatureFlag = {
      name: "orphanFlag",
      locations: [{ repo: "r", module: "b.ts" }],
    };
    const model = makeModel([registryFlag, unregisteredFlag], []);

    const { results } = await validateFeatureModel(model, "r");

    const found = results.find(
      (r) => r.ruleId === "config/unregistered-flag" && r.message.text.includes("orphanFlag"),
    );
    expect(found).toBeDefined();
  });

  it("does not report unregistered flags when no registry flags exist", async () => {
    const flagA: FeatureFlag = { name: "flagA", locations: [{ repo: "r", module: "a.ts" }] };
    const flagB: FeatureFlag = { name: "flagB", locations: [{ repo: "r", module: "b.ts" }] };
    const model = makeModel([flagA, flagB], []);

    const { results } = await validateFeatureModel(model, "r");

    const found = results.find((r) => r.ruleId === "config/unregistered-flag");
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateConfiguration
// ---------------------------------------------------------------------------

describe("validateConfiguration", () => {
  it("returns valid for empty model", () => {
    const model = makeModel([], []);
    const result = validateConfiguration(model, { flagA: true });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects missing dependency when requires constraint is violated", () => {
    const model = makeModel([], [
      makeConstraint("requires", ["flagA", "flagB"]),
    ]);

    const result = validateConfiguration(model, { flagA: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.kind).toBe("missing-dependency");
    expect(result.issues[0]!.parameter).toBe("flagA");
    expect(result.issues[0]!.relatedParameters).toContain("flagB");
  });

  it("passes when both required parameters are present", () => {
    const model = makeModel([], [
      makeConstraint("requires", ["flagA", "flagB"]),
    ]);

    const result = validateConfiguration(model, { flagA: true, flagB: true });
    expect(result.valid).toBe(true);
  });

  it("detects mutex violation when multiple mutex flags are active", () => {
    const model = makeModel([], [
      makeConstraint("mutex", ["modeA", "modeB", "modeC"]),
    ]);

    const result = validateConfiguration(model, { modeA: true, modeB: true });
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.kind).toBe("conflict");
  });

  it("passes mutex when only one flag is active", () => {
    const model = makeModel([], [
      makeConstraint("mutex", ["modeA", "modeB", "modeC"]),
    ]);

    const result = validateConfiguration(model, { modeA: true, modeB: false });
    expect(result.valid).toBe(true);
  });

  it("detects excludes violation", () => {
    const model = makeModel([], [
      makeConstraint("excludes", ["flagA", "flagB"]),
    ]);

    const result = validateConfiguration(model, { flagA: true, flagB: true });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.kind).toBe("conflict");
  });

  it("detects enum violation for invalid value", () => {
    const model = makeModel([], [{
      kind: "enum",
      flags: ["mode"],
      description: "mode enum",
      source: "inferred" as const,
      allowedValues: ["dark", "light"],
    }]);

    const result = validateConfiguration(model, { mode: "rainbow" });
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.kind).toBe("enum-violation");
    expect(result.issues[0]!.message).toContain("rainbow");
  });

  it("passes enum check for valid value", () => {
    const model = makeModel([], [{
      kind: "enum",
      flags: ["mode"],
      description: "mode enum",
      source: "inferred" as const,
      allowedValues: ["dark", "light"],
    }]);

    const result = validateConfiguration(model, { mode: "dark" });
    expect(result.valid).toBe(true);
  });

  it("detects conditional violation when condition is met but value is wrong", () => {
    const model = makeModel([], [{
      kind: "conditional",
      flags: ["isProduction", "timeout"],
      description: "conditional",
      source: "inferred" as const,
      condition: { isProduction: true },
      allowedValues: [30000, 5000],
    }]);

    const result = validateConfiguration(model, { isProduction: true, timeout: 999 });
    expect(result.valid).toBe(false);
    expect(result.issues[0]!.kind).toBe("invalid-value");
  });

  it("passes conditional when condition is not met", () => {
    const model = makeModel([], [{
      kind: "conditional",
      flags: ["isProduction", "timeout"],
      description: "conditional",
      source: "inferred" as const,
      condition: { isProduction: true },
      allowedValues: [30000, 5000],
    }]);

    const result = validateConfiguration(model, { isProduction: false, timeout: 999 });
    expect(result.valid).toBe(true);
  });

  it("detects requires with condition only when condition is met", () => {
    const model = makeModel([], [{
      kind: "requires",
      flags: ["provider", "twilioSid"],
      description: "twilio requires sid",
      source: "inferred" as const,
      condition: { provider: "twilio" },
    }]);

    // Condition not met — different provider
    const result1 = validateConfiguration(model, { provider: "sendgrid" });
    expect(result1.valid).toBe(true);

    // Condition met — missing dependency
    const result2 = validateConfiguration(model, { provider: "twilio" });
    expect(result2.valid).toBe(false);
    expect(result2.issues[0]!.kind).toBe("missing-dependency");
  });

  it("handles multiple issues in a single validation", () => {
    const model = makeModel([], [
      makeConstraint("requires", ["flagA", "flagB"]),
      makeConstraint("mutex", ["flagC", "flagD"]),
      {
        kind: "enum",
        flags: ["mode"],
        description: "mode enum",
        source: "inferred" as const,
        allowedValues: ["a", "b"],
      },
    ]);

    const result = validateConfiguration(model, {
      flagA: true,
      flagC: true,
      flagD: true,
      mode: "invalid",
    });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Dead settings detection
// ---------------------------------------------------------------------------

describe("dead-setting detection", () => {
  it("detects a setting excluded but not required", async () => {
    const model = makeModel(
      [],
      [makeConstraint("excludes", ["legacyMode", "otherSetting"])],
      [makeParam("legacyMode"), makeParam("otherSetting")],
    );

    const { results, validation } = await validateFeatureModel(model, "repo");

    expect(validation.deadSettings).toContain("legacyMode");
    expect(validation.deadSettings).toContain("otherSetting");
    const deadResults = results.filter((r) => r.ruleId === "config/dead-setting");
    expect(deadResults.length).toBe(2);
  });

  it("does not mark setting as dead if it is required by another", async () => {
    const model = makeModel(
      [],
      [
        makeConstraint("excludes", ["legacyMode", "newMode"]),
        makeConstraint("requires", ["feature", "legacyMode"]),
      ],
      [makeParam("legacyMode"), makeParam("newMode"), makeParam("feature")],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.deadSettings).not.toContain("legacyMode");
    expect(validation.deadSettings).toContain("newMode");
  });

  it("returns empty when no parameters are present", async () => {
    const model = makeModel([makeFlag("a")], []);

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.deadSettings).toHaveLength(0);
  });

  it("does not double-count flags in both flags and parameters", async () => {
    // A flag that appears in model.flags should be reported by dead-flag, not dead-setting
    const model = makeModel(
      [makeFlag("sharedName")],
      [makeConstraint("excludes", ["sharedName", "other"])],
      [makeParam("sharedName", "flag"), makeParam("other")],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    // sharedName should be in deadFlags, not deadSettings
    expect(validation.deadFlags).toContain("sharedName");
    expect(validation.deadSettings).not.toContain("sharedName");
    expect(validation.deadSettings).toContain("other");
  });
});

// ---------------------------------------------------------------------------
// Missing dependency detection
// ---------------------------------------------------------------------------

describe("missing-dependency detection", () => {
  it("detects when a requires constraint target is not in the model", async () => {
    const model = makeModel(
      [makeFlag("featureA")],
      [{
        kind: "requires",
        flags: ["featureA", "missingConfig"],
        description: "featureA requires missingConfig",
        source: "inferred" as const,
      }],
    );

    const { results, validation } = await validateFeatureModel(model, "repo");

    expect(validation.missingDependencies).toHaveLength(1);
    expect(validation.missingDependencies[0]!.parameter).toBe("missingConfig");
    expect(validation.missingDependencies[0]!.requiredBy).toBe("featureA");
    const depResults = results.filter((r) => r.ruleId === "config/missing-dependency");
    expect(depResults.length).toBe(1);
  });

  it("does not report when both parameters exist in the model", async () => {
    const model = makeModel(
      [makeFlag("featureA"), makeFlag("featureB")],
      [makeConstraint("requires", ["featureA", "featureB"])],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.missingDependencies).toHaveLength(0);
  });

  it("does not report when target exists as a config parameter", async () => {
    const model = makeModel(
      [makeFlag("featureA")],
      [makeConstraint("requires", ["featureA", "timeout"])],
      [makeParam("timeout")],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.missingDependencies).toHaveLength(0);
  });

  it("includes condition in the finding when present", async () => {
    const model = makeModel(
      [],
      [{
        kind: "requires",
        flags: ["provider", "twilioSid"],
        description: "twilio requires sid",
        source: "inferred" as const,
        condition: { provider: "twilio" },
      }],
      [makeParam("provider")],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.missingDependencies).toHaveLength(1);
    expect(validation.missingDependencies[0]!.condition).toEqual({ provider: "twilio" });
  });

  it("deduplicates multiple requires constraints for the same target", async () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b")],
      [
        makeConstraint("requires", ["a", "missingParam"]),
        makeConstraint("requires", ["a", "missingParam"]),
      ],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.missingDependencies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conflicting settings detection
// ---------------------------------------------------------------------------

describe("conflicting-settings detection", () => {
  it("detects direct contradiction: requires + excludes same pair", async () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b")],
      [
        makeConstraint("requires", ["a", "b"]),
        makeConstraint("excludes", ["a", "b"]),
      ],
    );

    const { results, validation } = await validateFeatureModel(model, "repo");

    expect(validation.conflictingSettings).toHaveLength(1);
    expect(validation.conflictingSettings[0]!.parameters).toContain("a");
    expect(validation.conflictingSettings[0]!.parameters).toContain("b");
    const conflictResults = results.filter((r) => r.ruleId === "config/conflicting-settings");
    expect(conflictResults.length).toBe(1);
    expect(conflictResults[0]!.level).toBe("error");
  });

  it("does not report when requires and excludes are on different pairs", async () => {
    const model = makeModel(
      [makeFlag("a"), makeFlag("b"), makeFlag("c")],
      [
        makeConstraint("requires", ["a", "b"]),
        makeConstraint("excludes", ["a", "c"]),
      ],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.conflictingSettings).toHaveLength(0);
  });

  it("returns empty when there are no constraints", async () => {
    const model = makeModel([makeFlag("a")], []);

    const { validation } = await validateFeatureModel(model, "repo");

    expect(validation.conflictingSettings).toHaveLength(0);
  });

  it("deduplicates symmetric conflicts", async () => {
    // Both directions of requires+excludes on the same pair
    const model = makeModel(
      [makeFlag("x"), makeFlag("y")],
      [
        makeConstraint("requires", ["x", "y"]),
        makeConstraint("requires", ["y", "x"]),
        makeConstraint("excludes", ["x", "y"]),
      ],
    );

    const { validation } = await validateFeatureModel(model, "repo");

    // Should produce only one finding despite two requires constraints
    expect(validation.conflictingSettings).toHaveLength(1);
  });
});
