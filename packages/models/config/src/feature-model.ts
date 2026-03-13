/**
 * Feature model construction from flag inventory and dependency analysis.
 *
 * Builds a formal feature model: flags as features, detected dependencies
 * as constraints. Used as input to Z3 SAT solver for validation.
 */

import type {
  FeatureConstraint,
  FeatureFlag,
  FeatureModel,
  FlagInventory,
  DependencyGraph,
} from "@mma/core";

export function buildFeatureModel(
  inventory: FlagInventory,
  dependencyGraph: DependencyGraph,
): FeatureModel {
  const constraints = inferConstraints(inventory.flags, dependencyGraph);

  return {
    flags: inventory.flags,
    constraints,
  };
}

function inferConstraints(
  flags: readonly FeatureFlag[],
  graph: DependencyGraph,
): FeatureConstraint[] {
  const constraints: FeatureConstraint[] = [];

  // Strategy 1: co-located flags likely have dependencies
  const flagsByFile = groupFlagsByFile(flags);
  for (const [_file, fileFlags] of flagsByFile) {
    if (fileFlags.length >= 2) {
      for (let i = 0; i < fileFlags.length; i++) {
        for (let j = i + 1; j < fileFlags.length; j++) {
          constraints.push({
            kind: "implies",
            flags: [fileFlags[i]!.name, fileFlags[j]!.name],
            description: `Co-located in same file, likely related`,
            source: "inferred",
          });
        }
      }
    }
  }

  // Strategy 2: flags in modules that depend on each other
  for (const flag of flags) {
    for (const otherFlag of flags) {
      if (flag.name === otherFlag.name) continue;

      const flagModules = flag.locations.map((l) => l.module);
      const otherModules = otherFlag.locations.map((l) => l.module);

      for (const fm of flagModules) {
        for (const om of otherModules) {
          const hasDep = graph.edges.some(
            (e) => e.source === fm && e.target === om,
          );
          if (hasDep) {
            constraints.push({
              kind: "requires",
              flags: [flag.name, otherFlag.name],
              description: `Module ${fm} depends on ${om}`,
              source: "inferred",
            });
          }
        }
      }
    }
  }

  return deduplicateConstraints(constraints);
}

function groupFlagsByFile(
  flags: readonly FeatureFlag[],
): Map<string, FeatureFlag[]> {
  const map = new Map<string, FeatureFlag[]>();
  for (const flag of flags) {
    for (const loc of flag.locations) {
      const existing = map.get(loc.module) ?? [];
      existing.push(flag);
      map.set(loc.module, existing);
    }
  }
  return map;
}

function deduplicateConstraints(
  constraints: FeatureConstraint[],
): FeatureConstraint[] {
  const seen = new Set<string>();
  return constraints.filter((c) => {
    // "excludes" is symmetric (A excludes B == B excludes A), so sort for dedup.
    // "implies" and "requires" are directional (A->B != B->A), so preserve order.
    const flagKey = c.kind === "excludes"
      ? [...c.flags].sort().join(",")
      : c.flags.join(",");
    const key = `${c.kind}:${flagKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
