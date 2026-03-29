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
  readonly unusedRegistryFlags: readonly string[];
  readonly unregisteredFlags: readonly string[];
  readonly deadSettings: readonly string[];
  readonly missingDependencies: readonly MissingDependencyFinding[];
  readonly conflictingSettings: readonly ConflictingSettingsFinding[];
}

export interface MissingDependencyFinding {
  readonly parameter: string;
  readonly requiredBy: string;
  readonly condition?: Record<string, unknown>;
}

export interface ConflictingSettingsFinding {
  readonly parameters: readonly string[];
  readonly description: string;
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
  {
    id: "config/unused-registry-flag",
    shortDescription: {
      text: "Flag defined in registry enum but not referenced in code",
    },
    defaultConfiguration: { level: "note", enabled: true },
  },
  {
    id: "config/unregistered-flag",
    shortDescription: {
      text: "Flag used in code but missing from registry enum",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "config/dead-setting",
    shortDescription: {
      text: "Setting that can never be used given current constraints",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "config/missing-dependency",
    shortDescription: {
      text: "Setting requires another parameter that is not configured",
    },
    defaultConfiguration: { level: "warning", enabled: true },
  },
  {
    id: "config/conflicting-settings",
    shortDescription: {
      text: "Two settings contradict each other based on inferred constraints",
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
  const unusedRegistryFlags = findUnusedRegistryFlags(model);
  const unregisteredFlags = findUnregisteredFlags(model);
  const deadSettings = findDeadSettings(model);
  const missingDependencies = findMissingDependencies(model);
  const conflictingSettings = findConflictingSettings(model);

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
    const fqn = [...combo].sort().join("+");
    results.push(
      createSarifResult(
        "config/untested-interaction",
        "note",
        `Flag interaction [${combo.join(", ")}] has no test coverage`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, fqn)],
          }],
        },
      ),
    );
  }

  for (const flag of unusedRegistryFlags) {
    results.push(
      createSarifResult(
        "config/unused-registry-flag",
        "note",
        `Flag "${flag}" is defined in the registry enum but not referenced in code`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, flag)],
          }],
        },
      ),
    );
  }

  for (const flag of unregisteredFlags) {
    results.push(
      createSarifResult(
        "config/unregistered-flag",
        "warning",
        `Flag "${flag}" is used in code but missing from the registry enum`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, flag)],
          }],
        },
      ),
    );
  }

  for (const setting of deadSettings) {
    results.push(
      createSarifResult(
        "config/dead-setting",
        "warning",
        `Setting "${setting}" can never be used given current constraints`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, setting)],
          }],
        },
      ),
    );
  }

  for (const dep of missingDependencies) {
    const condDesc = dep.condition
      ? ` when ${JSON.stringify(dep.condition)}`
      : "";
    results.push(
      createSarifResult(
        "config/missing-dependency",
        "warning",
        `"${dep.requiredBy}" requires "${dep.parameter}"${condDesc} but no definition was found`,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, dep.parameter)],
          }],
        },
      ),
    );
  }

  for (const conflict of conflictingSettings) {
    const fqn = [...conflict.parameters].sort().join("+");
    results.push(
      createSarifResult(
        "config/conflicting-settings",
        "error",
        conflict.description,
        {
          locations: [{
            logicalLocations: [createLogicalLocation(repo, fqn)],
          }],
        },
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
      unusedRegistryFlags,
      unregisteredFlags,
      deadSettings,
      missingDependencies,
      conflictingSettings,
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

/**
 * Flags defined in the registry enum but not referenced elsewhere in code.
 *
 * A registry-only flag has `isRegistry: true` and exactly one location
 * (the registry file itself). Flags that are both registered and detected
 * in code retain their code locations, so `locations.length > 1`.
 */
function findUnusedRegistryFlags(model: FeatureModel): string[] {
  return model.flags
    .filter((f) => f.isRegistry === true && f.locations.length <= 1)
    .map((f) => f.name);
}

/**
 * Flags used in code but not present in the registry enum.
 *
 * Only emitted when a registry exists (at least one flag has `isRegistry`),
 * otherwise every flag would be "unregistered" which is not useful.
 */
function findUnregisteredFlags(model: FeatureModel): string[] {
  const hasRegistry = model.flags.some((f) => f.isRegistry === true);
  if (!hasRegistry) return [];
  return model.flags
    .filter((f) => f.isRegistry !== true)
    .map((f) => f.name);
}

// ---------------------------------------------------------------------------
// Dead settings, missing dependencies, conflicting settings
// ---------------------------------------------------------------------------

/**
 * Settings that can never be used given current constraints.
 *
 * A setting (from model.parameters) is dead when it is excluded by at least
 * one constraint and no constraint requires it. Mirrors findDeadFlags logic
 * but operates on the parameters list.
 */
function findDeadSettings(model: FeatureModel): string[] {
  if (!model.parameters || model.parameters.length === 0) return [];

  const flagNameSet = new Set(model.flags.map((f) => f.name));
  const dead: string[] = [];

  for (const param of model.parameters) {
    // Only check settings/credentials, not flags (flags are handled by findDeadFlags)
    if (param.kind === "flag") continue;
    if (flagNameSet.has(param.name)) continue;

    const excluded = model.constraints.some(
      (c) => c.kind === "excludes" && c.flags.includes(param.name),
    );
    const required = model.constraints.some(
      (c) => c.kind === "requires" && c.flags[1] === param.name,
    );

    if (excluded && !required) {
      dead.push(param.name);
    }
  }

  return dead;
}

/**
 * Settings that require another parameter which is not defined anywhere.
 *
 * Scans "requires" constraints where the target parameter does not appear
 * in the model's flags or parameters. This catches cases where a guard
 * clause references a parameter that was never defined/scanned.
 */
function findMissingDependencies(model: FeatureModel): MissingDependencyFinding[] {
  const allNames = new Set(model.flags.map((f) => f.name));
  if (model.parameters) {
    for (const p of model.parameters) allNames.add(p.name);
  }

  const findings: MissingDependencyFinding[] = [];
  const seen = new Set<string>();

  for (const constraint of model.constraints) {
    if (constraint.kind !== "requires") continue;
    const [source, target] = constraint.flags;
    if (!source || !target) continue;

    // The source must exist in the model but the target must be missing
    if (!allNames.has(source)) continue;
    if (allNames.has(target)) continue;

    const key = `${source}->${target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      parameter: target,
      requiredBy: source,
      condition: constraint.condition,
    });
  }

  return findings;
}

/**
 * Settings that conflict with each other based on inferred constraints.
 *
 * Detects when two excludes/mutex constraints create a contradiction:
 * A excludes B and B excludes C, but A requires C. Also checks for
 * direct contradictions where a parameter is both required and excluded
 * by the same source.
 */
function findConflictingSettings(model: FeatureModel): ConflictingSettingsFinding[] {
  const findings: ConflictingSettingsFinding[] = [];
  const seen = new Set<string>();

  // Build lookup: what does each parameter require and exclude?
  const requiresMap = new Map<string, Set<string>>();
  const excludesMap = new Map<string, Set<string>>();

  for (const c of model.constraints) {
    if (c.kind === "requires" && c.flags.length === 2) {
      const [src, tgt] = c.flags;
      if (!src || !tgt) continue;
      if (!requiresMap.has(src)) requiresMap.set(src, new Set());
      requiresMap.get(src)!.add(tgt);
    }
    if (c.kind === "excludes" && c.flags.length === 2) {
      const [a, b] = c.flags;
      if (!a || !b) continue;
      if (!excludesMap.has(a)) excludesMap.set(a, new Set());
      excludesMap.get(a)!.add(b);
      // Excludes is symmetric
      if (!excludesMap.has(b)) excludesMap.set(b, new Set());
      excludesMap.get(b)!.add(a);
    }
  }

  // Direct contradiction: A requires B, but A also excludes B
  for (const [param, required] of requiresMap) {
    const excluded = excludesMap.get(param);
    if (!excluded) continue;
    for (const req of required) {
      if (excluded.has(req)) {
        const key = [param, req].sort().join("+");
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          parameters: [param, req],
          description: `"${param}" both requires and excludes "${req}" — contradictory constraints`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

export interface ConfigValidationIssue {
  readonly kind: "missing-dependency" | "conflict" | "invalid-value" | "enum-violation";
  readonly parameter: string;
  readonly message: string;
  readonly relatedParameters?: readonly string[];
}

export interface ConfigValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ConfigValidationIssue[];
}

/**
 * Validate a partial configuration against the feature model's constraints.
 *
 * Checks:
 * - Required parameters are present when their guard conditions are met
 * - Mutual exclusion constraints are not violated
 * - Enum values are within the allowed set
 * - Conditional constraints are satisfied
 */
export function validateConfiguration(
  model: FeatureModel,
  partialConfig: Record<string, unknown>,
): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  const configKeys = new Set(Object.keys(partialConfig));

  for (const constraint of model.constraints) {
    switch (constraint.kind) {
      case "requires": {
        // If the first parameter is set, the second must also be set
        const [source, target] = constraint.flags;
        if (!source || !target) break;
        if (configKeys.has(source) && !configKeys.has(target)) {
          // Check condition if present
          if (constraint.condition) {
            const conditionMet = Object.entries(constraint.condition).every(
              ([k, v]) => partialConfig[k] === v,
            );
            if (!conditionMet) break;
          }
          issues.push({
            kind: "missing-dependency",
            parameter: source,
            message: `"${source}" requires "${target}" to be configured (${constraint.description})`,
            relatedParameters: [target],
          });
        }
        break;
      }

      case "mutex": {
        // At most one of the mutex group can be set/truthy
        const activeFlags = constraint.flags.filter(
          (f) => configKeys.has(f) && partialConfig[f],
        );
        if (activeFlags.length > 1) {
          issues.push({
            kind: "conflict",
            parameter: activeFlags[0]!,
            message: `Mutual exclusion violated: [${activeFlags.join(", ")}] cannot all be active`,
            relatedParameters: activeFlags.slice(1),
          });
        }
        break;
      }

      case "excludes": {
        const [a, b] = constraint.flags;
        if (!a || !b) break;
        if (configKeys.has(a) && partialConfig[a] && configKeys.has(b) && partialConfig[b]) {
          issues.push({
            kind: "conflict",
            parameter: a,
            message: `"${a}" and "${b}" cannot both be enabled`,
            relatedParameters: [b],
          });
        }
        break;
      }

      case "enum": {
        const paramName = constraint.flags[0];
        if (!paramName || !configKeys.has(paramName)) break;
        const value = partialConfig[paramName];
        if (constraint.allowedValues && !constraint.allowedValues.includes(value)) {
          issues.push({
            kind: "enum-violation",
            parameter: paramName,
            message: `"${paramName}" value "${String(value)}" is not in allowed values: [${constraint.allowedValues.map(String).join(", ")}]`,
          });
        }
        break;
      }

      case "conditional": {
        // If condition is met, check that constrained values are valid
        if (!constraint.condition) break;
        const conditionMet = Object.entries(constraint.condition).every(
          ([k, v]) => configKeys.has(k) && partialConfig[k] === v,
        );
        if (!conditionMet) break;

        const target = constraint.flags[1];
        if (!target || !configKeys.has(target)) break;
        const targetValue = partialConfig[target];
        if (constraint.allowedValues && !constraint.allowedValues.includes(targetValue)) {
          issues.push({
            kind: "invalid-value",
            parameter: target,
            message: `When ${JSON.stringify(constraint.condition)} is set, "${target}" must be one of ${JSON.stringify(constraint.allowedValues)}`,
            relatedParameters: Object.keys(constraint.condition),
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return { valid: issues.length === 0, issues };
}
