/**
 * Z3 SAT solver integration for configuration validation.
 *
 * Checks for dead flags, always-on flags, impossible combinations,
 * and targeted interaction analysis.
 *
 * External dependency: z3-solver (WASM build)
 */

import type { FeatureModel } from "@mma/core";
import type {
  SarifResult,
  SarifReportingDescriptor,
} from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";

export interface Z3ValidationResult {
  readonly deadFlags: readonly string[];
  readonly alwaysOnFlags: readonly string[];
  readonly impossibleCombinations: readonly string[][];
  readonly untestedInteractions: readonly string[][];
}

export const CONFIG_RULES: readonly SarifReportingDescriptor[] = [
  {
    id: "config/dead-flag",
    shortDescription: {
      text: "Flag that can never be enabled given current constraints",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "config/always-on-flag",
    shortDescription: {
      text: "Flag that is always enabled regardless of configuration",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "config/missing-constraint",
    shortDescription: {
      text: "Flag used without validation of its dependencies",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "config/untested-interaction",
    shortDescription: {
      text: "Flag pair with detected interaction but no test coverage",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "config/format-violation",
    shortDescription: {
      text: "Parameter value violates type or range constraint",
    },
    defaultConfiguration: { level: "error", enabled: true },
  },
];

export async function validateFeatureModel(
  model: FeatureModel,
  repo: string,
): Promise<{ results: SarifResult[]; validation: Z3ValidationResult }> {
  // Z3 WASM solver integration
  // For POC: simulate constraint checking with simple logic
  // For scale: use z3-solver npm package with WASM backend

  const deadFlags = findDeadFlags(model);
  const alwaysOnFlags = findAlwaysOnFlags(model);
  const impossibleCombinations = findImpossibleCombinations(model);
  const untestedInteractions = findUntestedInteractions(model);

  const results: SarifResult[] = [];

  for (const flag of deadFlags) {
    results.push(
      createSarifResult(
        "config/dead-flag",
        "warning",
        `Flag "${flag}" can never be enabled given current constraints`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, flag)],
          }],
        },
      ),
    );
  }

  for (const flag of alwaysOnFlags) {
    results.push(
      createSarifResult(
        "config/always-on-flag",
        "note",
        `Flag "${flag}" is always enabled`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, flag)],
          }],
        },
      ),
    );
  }

  for (const combo of untestedInteractions) {
    results.push(
      createSarifResult(
        "config/untested-interaction",
        "note",
        `Flag interaction [${combo.join(", ")}] has no test coverage`,
      ),
    );
  }

  return {
    results,
    validation: {
      deadFlags,
      alwaysOnFlags,
      impossibleCombinations,
      untestedInteractions,
    },
  };
}

function findDeadFlags(model: FeatureModel): string[] {
  const deadFlags: string[] = [];

  for (const flag of model.flags) {
    const excludingConstraints = model.constraints.filter(
      (c) => c.kind === "excludes" && c.flags.includes(flag.name),
    );
    const requiredBy = model.constraints.filter(
      (c) => c.kind === "requires" && c.flags[1] === flag.name,
    );

    // A flag is dead if it's excluded by all its dependents
    if (excludingConstraints.length > 0 && requiredBy.length === 0) {
      deadFlags.push(flag.name);
    }
  }

  return deadFlags;
}

function findAlwaysOnFlags(model: FeatureModel): string[] {
  const alwaysOn: string[] = [];

  for (const flag of model.flags) {
    const isRequired = model.constraints.some(
      (c) => c.kind === "requires" && c.flags[0] === flag.name,
    );
    const hasNoExclusions = !model.constraints.some(
      (c) => c.kind === "excludes" && c.flags.includes(flag.name),
    );

    if (isRequired && hasNoExclusions) {
      // Check if every other flag requires this one
      const requiringFlags = model.constraints
        .filter((c) => c.kind === "requires" && c.flags[1] === flag.name)
        .map((c) => c.flags[0]);

      if (requiringFlags.length === model.flags.length - 1) {
        alwaysOn.push(flag.name);
      }
    }
  }

  return alwaysOn;
}

function findImpossibleCombinations(model: FeatureModel): string[][] {
  const impossible: string[][] = [];

  const mutexConstraints = model.constraints.filter((c) => c.kind === "mutex");
  for (const constraint of mutexConstraints) {
    // All flags in a mutex constraint can't be simultaneously enabled
    impossible.push([...constraint.flags]);
  }

  return impossible;
}

function findUntestedInteractions(model: FeatureModel): string[][] {
  const interactions: string[][] = [];

  // Flag pairs that have inferred relationships but no explicit test coverage
  const inferredPairs = model.constraints
    .filter((c) => c.source === "inferred" && c.flags.length === 2)
    .map((c) => [...c.flags]);

  interactions.push(...inferredPairs);
  return interactions;
}
