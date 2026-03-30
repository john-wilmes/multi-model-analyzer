/**
 * Feature model construction from flag inventory, config inventory,
 * and dependency analysis.
 *
 * Builds a formal feature model: flags as features, settings and credentials
 * as parameters, detected dependencies as constraints.
 * Used as input to Z3 SAT solver for validation.
 */

import type {
  FeatureConstraint,
  FeatureFlag,
  FeatureModel,
  FlagInventory,
  ConfigInventory,
  ConfigParameter,
  DependencyGraph,
} from "@mma/core";

export interface BuildFeatureModelOptions {
  readonly inventory: FlagInventory;
  readonly dependencyGraph: DependencyGraph;
  readonly configInventory?: ConfigInventory;
}

/**
 * Build a feature model from flag inventory, dependency graph, and optionally
 * a config inventory. When configInventory is provided, constraints are
 * inferred across the unified parameter set (flags + settings + credentials).
 */
export function buildFeatureModel(
  inventory: FlagInventory,
  dependencyGraph: DependencyGraph,
  configInventory?: ConfigInventory,
): FeatureModel {
  const constraints = inferConstraints(
    inventory.flags,
    dependencyGraph,
    configInventory?.parameters,
  );

  return {
    flags: inventory.flags,
    constraints,
    ...(configInventory ? { parameters: configInventory.parameters } : {}),
  };
}

/** An item (flag or parameter) with optional scope for constraint scoping. */
interface ScopedItem {
  readonly name: string;
  readonly locations: readonly { module: string }[];
  readonly scope?: string;
}

/**
 * Two items are scope-compatible if they could plausibly interact:
 * - Either has no scope (flags, unscoped params) → always compatible
 * - Both have the same scope → compatible
 * - Different scopes → not compatible (e.g. integrator-config vs account-setting)
 */
function scopeCompatible(a: ScopedItem, b: ScopedItem): boolean {
  if (!a.scope || !b.scope) return true;
  return a.scope === b.scope;
}

function inferConstraints(
  flags: readonly FeatureFlag[],
  graph: DependencyGraph,
  parameters?: readonly ConfigParameter[],
): FeatureConstraint[] {
  const constraints: FeatureConstraint[] = [];

  // Build unified name set for co-location analysis, preserving scope
  const allItems: ScopedItem[] = flags.map((f) => ({
    name: f.name,
    locations: f.locations,
  }));
  if (parameters) {
    for (const p of parameters) {
      allItems.push({ name: p.name, locations: p.locations, scope: p.scope });
    }
  }

  // Strategy 1: co-located flags/parameters likely have dependencies
  // Only infer between scope-compatible items to avoid cross-scope noise.
  const itemsByFile = groupByFile(allItems);
  for (const [_file, fileItems] of itemsByFile) {
    if (fileItems.length >= 2) {
      for (let i = 0; i < fileItems.length; i++) {
        for (let j = i + 1; j < fileItems.length; j++) {
          if (!scopeCompatible(fileItems[i]!, fileItems[j]!)) continue;
          constraints.push({
            kind: "implies",
            flags: [fileItems[i]!.name, fileItems[j]!.name],
            description: `Co-located in same file, likely related`,
            source: "inferred",
          });
        }
      }
    }
  }

  // Strategy 2: flags in modules that depend on each other
  // Index edges for O(1) lookup instead of O(e) linear scan per pair
  const edgeSet = new Set(graph.edges.map((e) => `${e.source}\0${e.target}`));

  for (const item of allItems) {
    for (const otherItem of allItems) {
      if (item.name === otherItem.name) continue;
      if (!scopeCompatible(item, otherItem)) continue;

      const itemModules = item.locations.map((l) => l.module);
      const otherModules = otherItem.locations.map((l) => l.module);

      for (const fm of itemModules) {
        for (const om of otherModules) {
          if (edgeSet.has(`${fm}\0${om}`)) {
            constraints.push({
              kind: "requires",
              flags: [item.name, otherItem.name],
              description: `Module ${fm} depends on ${om}`,
              source: "inferred",
            });
          }
        }
      }
    }
  }

  // Strategy 3: schema-derived constraints from config parameters
  if (parameters) {
    for (const param of parameters) {
      // Enum constraint from validation schemas
      if (param.enumValues && param.enumValues.length >= 2) {
        constraints.push({
          kind: "enum",
          flags: [param.name],
          description: `Schema-derived enum: ${param.name} must be one of [${param.enumValues.join(", ")}]`,
          source: "schema",
          allowedValues: param.enumValues,
        });
      }

      // Range constraint from validation schemas
      if (param.rangeMin !== undefined || param.rangeMax !== undefined) {
        const rangeDesc = param.rangeMin !== undefined && param.rangeMax !== undefined
          ? `${param.rangeMin}..${param.rangeMax}`
          : param.rangeMin !== undefined ? `>= ${param.rangeMin}` : `<= ${param.rangeMax}`;
        constraints.push({
          kind: "range",
          flags: [param.name],
          description: `Schema-derived range: ${param.name} in ${rangeDesc}`,
          source: "schema",
        });
      }
    }
  }

  return deduplicateConstraints(constraints);
}

function groupByFile(
  items: readonly ScopedItem[],
): Map<string, ScopedItem[]> {
  const map = new Map<string, ScopedItem[]>();
  for (const item of items) {
    for (const loc of item.locations) {
      const existing = map.get(loc.module) ?? [];
      existing.push(item);
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
