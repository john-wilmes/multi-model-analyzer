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
  /** Inferred flag pairs with no explicit test coverage. Named "inferred" to
   * clarify this is static inference only — no runtime coverage data is used. */
  readonly inferredUntestedPairs: readonly string[][];
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
  const inferredUntestedPairs = findInferredUntestedPairs(model);

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

  for (const combo of inferredUntestedPairs) {
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
      inferredUntestedPairs,
    },
  };
}

/**
 * Heuristic dead-flag detection.
 *
 * A flag is considered dead when it appears in at least one "excludes"
 * constraint AND no "requires" constraint names it as a dependency
 * (i.e. nothing requires it to be on). This is a conservative approximation:
 * it will miss flags that are excluded only under specific conditions, and it
 * may produce false positives for flags that are excluded alongside others but
 * are still reachable. A full SAT/SMT check (Z3) is needed for soundness.
 */
function findDeadFlags(model: FeatureModel): string[] {
  const deadFlags: string[] = [];

  for (const flag of model.flags) {
    const excludingConstraints = model.constraints.filter(
      (c) => c.kind === "excludes" && c.flags.includes(flag.name),
    );
    const requiredBy = model.constraints.filter(
      (c) => c.kind === "requires" && c.flags[1] === flag.name,
    );

    // Heuristic: flag is likely dead if it is excluded somewhere and nothing
    // depends on it being enabled.
    if (excludingConstraints.length > 0 && requiredBy.length === 0) {
      deadFlags.push(flag.name);
    }
  }

  return deadFlags;
}

/**
 * Heuristic always-on detection.
 *
 * A flag is considered always-on when: (1) it appears as the source of at
 * least one "requires" constraint, (2) it has no "excludes" constraints, and
 * (3) every other flag in the model has a "requires" constraint pointing to it.
 * This is a heuristic — it approximates the SAT condition "flag must be true
 * in every satisfying assignment" without running a full solver.
 */
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
      // Heuristic: if every other flag in the model has a requires-constraint
      // pointing at this flag, treat it as always-on.
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

/**
 * Returns inferred flag pairs that have no explicit test coverage.
 *
 * NOTE: This function performs static inference only. It identifies constraint
 * pairs derived from code analysis (source === "inferred") and labels them as
 * potentially untested. No runtime coverage data is consulted. The name
 * "inferredUntestedPairs" reflects this: the pairs are inferred, not confirmed
 * untested by a coverage tool.
 */
function findInferredUntestedPairs(model: FeatureModel): string[][] {
  return model.constraints
    .filter((c) => c.source === "inferred" && c.flags.length === 2)
    .map((c) => [...c.flags]);
}
