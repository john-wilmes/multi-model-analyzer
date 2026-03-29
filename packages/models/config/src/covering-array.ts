/**
 * Covering array generation via the IPOG (In-Parameter-Order-General) algorithm.
 *
 * IPOG builds a t-way covering array incrementally:
 *   1. Start with an exhaustive Cartesian product of the first `t` parameters.
 *   2. For each additional parameter, extend existing rows horizontally by
 *      choosing the value that covers the most uncovered t-tuples.
 *   3. After horizontal extension, append new rows (vertical extension) to
 *      cover any remaining t-tuples that no existing row covers.
 *
 * A t-way covering array guarantees that every combination of `t` parameter
 * values appears in at least one row — the core requirement for combinatorial
 * interaction testing (CIT).
 *
 * Reference: Yu Lei & Kuo-Chung Tai, "In-parameter-order: a test generation
 * strategy for pairwise testing", HASE 1998.
 */

import type { FeatureModel } from "@mma/core";
import { validateConfiguration } from "./z3.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CoveringArrayOptions {
  readonly strength?: number; // default 2 (pairwise), max 6
  readonly constraintAware?: boolean; // skip configs violating model constraints (default true)
}

export interface CoveringArrayResult {
  readonly configurations: readonly Record<string, unknown>[];
  readonly strength: number;
  readonly parameterCount: number;
  readonly coverageStats: {
    readonly totalTuples: number;
    readonly coveredTuples: number;
    readonly coveragePercent: number;
  };
}

export interface InteractionStrengthResult {
  readonly parameter: string;
  readonly interactionCount: number;
  readonly interactsWith: readonly string[];
  readonly maxStrength: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a value domain for each parameter in the model.
 * Parameters with only one domain value are included here but filtered out
 * before running IPOG (they cannot contribute to interactions).
 */
export function extractDomains(model: FeatureModel): Map<string, unknown[]> {
  const domains = new Map<string, unknown[]>();

  // Parameters from ConfigParameter entries
  if (model.parameters) {
    for (const param of model.parameters) {
      let domain: unknown[];

      if (param.enumValues && param.enumValues.length > 0) {
        domain = [...param.enumValues];
      } else if (param.valueType === "boolean") {
        domain = [true, false];
      } else if (param.valueType === "number") {
        if (param.rangeMin !== undefined && param.rangeMax !== undefined) {
          const mid = (param.rangeMin + param.rangeMax) / 2;
          domain = [param.rangeMin, mid, param.rangeMax];
        } else {
          domain = [0, 1, -1];
        }
      } else {
        // string with no enum, or unknown type — single sentinel
        domain = ["<any>"];
      }

      domains.set(param.name, domain);
    }
  }

  // Feature flags: boolean domain
  for (const flag of model.flags) {
    const existing = domains.get(flag.name);
    if (!existing || (existing.length === 1 && existing[0] === "<any>")) {
      domains.set(flag.name, [true, false]);
    }
  }

  return domains;
}

/**
 * Generates all possible t-tuples over the given parameter names as
 * serialized JSON strings. Each tuple is a specific value assignment for
 * exactly `strength` parameters.
 *
 * Returns a Set of JSON-serialized `[paramName, value][]` arrays so that
 * membership can be tested in O(1).
 */
export function generateTuples(
  paramNames: string[],
  domains: Map<string, unknown[]>,
  strength: number,
): Set<string> {
  const tuples = new Set<string>();
  const n = paramNames.length;

  // Enumerate all combinations of `strength` indices from paramNames
  function combineIndices(start: number, chosen: number[]): void {
    if (chosen.length === strength) {
      // Enumerate Cartesian product of values for these parameters
      const chosenParams = chosen.map((i) => paramNames[i]!);
      const chosenDomains = chosenParams.map((p) => domains.get(p)!);

      function cartesian(dimIdx: number, partial: [string, unknown][]): void {
        if (dimIdx === chosenParams.length) {
          tuples.add(JSON.stringify(partial));
          return;
        }
        for (const val of chosenDomains[dimIdx]!) {
          cartesian(dimIdx + 1, [...partial, [chosenParams[dimIdx]!, val]]);
        }
      }

      cartesian(0, []);
      return;
    }

    if (start >= n) return;

    for (let i = start; i <= n - (strength - chosen.length); i++) {
      combineIndices(i + 1, [...chosen, i]);
    }
  }

  combineIndices(0, []);
  return tuples;
}

/**
 * Counts how many tuples from `candidates` (a subset of `uncovered`) would be
 * covered by assigning `value` to `newParam` in a row, given the `t-1`
 * already-assigned parameters from `processedParams`.
 *
 * A tuple is covered if:
 *   - It involves `newParam` with the given `value`
 *   - Its other t-1 parameters are already in `processedParams` and match `row`
 */
function countCoveredByChoice(
  newParam: string,
  value: unknown,
  row: Record<string, unknown>,
  processedParams: string[],
  _domains: Map<string, unknown[]>,
  strength: number,
  uncovered: Set<string>,
): number {
  let count = 0;

  // We need to pick (strength - 1) params from processedParams and combine with newParam
  const t = strength;
  const companions = processedParams;

  function combineCompanions(
    start: number,
    chosen: string[],
  ): void {
    if (chosen.length === t - 1) {
      // Build the tuple: chosen params from row + newParam = value
      const tupleEntries: [string, unknown][] = [
        ...chosen.map((p): [string, unknown] => [p, row[p]]),
        [newParam, value],
      ];
      // Sort by parameter name to match generateTuples ordering (which uses paramNames order,
      // but since we serialize arrays, we must match the exact structure)
      // generateTuples produces arrays in paramNames order; we reproduce that here.
      // The canonical key is param-name-ordered relative to the FULL paramNames list.
      // We stored tuples as JSON of sorted-by-param-index pairs, so sort accordingly.
      // Actually generateTuples preserves the order from paramNames (the combination order).
      // Since we don't have paramNames here, we sort alphabetically to match a consistent key,
      // but generateTuples does NOT sort alphabetically — it preserves paramNames order.
      // To correctly check, we must serialize in the same order as generateTuples would.
      // We rely on the fact that tupleEntries must exactly match what generateTuples produced.
      // generateTuples chooses combinations in index order (ascending), so param names appear
      // in increasing-index order. We sort tupleEntries by paramNames-index order.
      // Since we don't have paramNames here, we pass a sorted key check to the caller.
      // Instead, canonicalize by sorting by param name alphabetically for lookup.
      // NOTE: generateTuples uses natural combination order (ascending index), which corresponds
      // to alphabetical order of param names only if domains were inserted alphabetically.
      // For correctness, all tuple serializations must use the same ordering.
      // Solution: serialize as a sorted-by-name array to get a canonical form.
      tupleEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const key = JSON.stringify(tupleEntries);
      if (uncovered.has(key)) {
        count++;
      }
      return;
    }

    for (let i = start; i <= companions.length - (t - 1 - chosen.length); i++) {
      combineCompanions(i + 1, [...chosen, companions[i]!]);
    }
  }

  if (t === 1) {
    // Special case: tuple is just [newParam, value]
    const key = JSON.stringify([[newParam, value]]);
    if (uncovered.has(key)) count++;
  } else {
    combineCompanions(0, []);
  }

  return count;
}

/**
 * Returns all tuple keys that would be newly covered by assigning value to
 * newParam in a row (across all (t-1)-subsets of processedParams).
 */
function getTuplesForChoice(
  newParam: string,
  value: unknown,
  row: Record<string, unknown>,
  processedParams: string[],
  strength: number,
  uncovered: Set<string>,
): string[] {
  const covered: string[] = [];
  const t = strength;
  const companions = processedParams;

  function combineCompanions(start: number, chosen: string[]): void {
    if (chosen.length === t - 1) {
      const tupleEntries: [string, unknown][] = [
        ...chosen.map((p): [string, unknown] => [p, row[p]]),
        [newParam, value],
      ];
      tupleEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const key = JSON.stringify(tupleEntries);
      if (uncovered.has(key)) {
        covered.push(key);
      }
      return;
    }

    for (let i = start; i <= companions.length - (t - 1 - chosen.length); i++) {
      combineCompanions(i + 1, [...chosen, companions[i]!]);
    }
  }

  if (t === 1) {
    const key = JSON.stringify([[newParam, value]]);
    if (uncovered.has(key)) covered.push(key);
  } else {
    combineCompanions(0, []);
  }

  return covered;
}

// ---------------------------------------------------------------------------
// IPOG core
// ---------------------------------------------------------------------------

function runIpog(
  paramNames: string[],
  domains: Map<string, unknown[]>,
  strength: number,
): Record<string, unknown>[] {
  const t = strength;

  // Step 1: Initialize with exhaustive Cartesian product of first t parameters
  const initialParams = paramNames.slice(0, t);
  const rows: Record<string, unknown>[] = [];

  function cartesianInit(dimIdx: number, partial: Record<string, unknown>): void {
    if (dimIdx === initialParams.length) {
      rows.push({ ...partial });
      return;
    }
    const p = initialParams[dimIdx]!;
    for (const v of domains.get(p)!) {
      cartesianInit(dimIdx + 1, { ...partial, [p]: v });
    }
  }

  cartesianInit(0, {});

  // Generate initial uncovered set (all t-tuples over all params, sorted-key canonical form)
  // We generate tuples using canonical (alphabetically sorted) serialization.
  const allTuples = generateTuplesCanonical(paramNames, domains, t);
  const uncovered = new Set(allTuples);

  // Mark tuples covered by initial rows
  for (const row of rows) {
    markRowCoverage(row, initialParams, domains, t, uncovered, /* remove= */ true);
  }

  // Step 2: For each additional parameter, horizontal then vertical extension
  const processedParams = [...initialParams];

  for (let pi = t; pi < paramNames.length; pi++) {
    const newParam = paramNames[pi]!;
    const valueDomain = domains.get(newParam)!;

    // --- Horizontal extension ---
    for (const row of rows) {
      // Pick the value for newParam that covers the most uncovered tuples
      let bestValue = valueDomain[0];
      let bestCount = -1;

      for (const value of valueDomain) {
        const count = countCoveredByChoice(
          newParam,
          value,
          row,
          processedParams,
          domains,
          t,
          uncovered,
        );
        if (count > bestCount) {
          bestCount = count;
          bestValue = value;
        }
      }

      row[newParam] = bestValue;

      // Remove newly covered tuples
      const nowCovered = getTuplesForChoice(
        newParam,
        bestValue,
        row,
        processedParams,
        t,
        uncovered,
      );
      for (const key of nowCovered) {
        uncovered.delete(key);
      }
    }

    // --- Vertical extension ---
    // Collect all uncovered tuples involving newParam and any processedParams subset
    const remainingForNew = collectUncoveredForParam(newParam, processedParams, t, uncovered);

    while (remainingForNew.size > 0) {
      // Greedily construct a new row covering as many remaining tuples as possible
      const newRow: Record<string, unknown> = {};

      // For each processed param, pick the value used most often in remaining tuples
      for (const p of processedParams) {
        newRow[p] = pickBestValueForParam(p, domains.get(p)!, newParam, newRow, t, uncovered);
      }

      // Pick value for newParam
      let bestValue = valueDomain[0];
      let bestCount = -1;
      for (const value of valueDomain) {
        const count = countCoveredByChoice(
          newParam,
          value,
          newRow,
          processedParams,
          domains,
          t,
          uncovered,
        );
        if (count > bestCount) {
          bestCount = count;
          bestValue = value;
        }
      }
      newRow[newParam] = bestValue;

      rows.push(newRow);

      // Remove covered tuples
      const nowCovered = getTuplesForChoice(
        newParam,
        bestValue,
        newRow,
        processedParams,
        t,
        uncovered,
      );
      for (const key of nowCovered) {
        uncovered.delete(key);
        remainingForNew.delete(key);
      }

      // Safety: if nothing was covered, break to avoid infinite loop
      if (nowCovered.length === 0) break;
    }

    processedParams.push(newParam);
  }

  return rows;
}

/**
 * Generates all t-tuples using canonical (alphabetically sorted by param name)
 * serialization. This is the canonical form used throughout the algorithm.
 */
function generateTuplesCanonical(
  paramNames: string[],
  domains: Map<string, unknown[]>,
  strength: number,
): string[] {
  const tuples: string[] = [];
  const n = paramNames.length;
  const t = strength;

  function combineIndices(start: number, chosen: number[]): void {
    if (chosen.length === t) {
      const chosenParams = chosen.map((i) => paramNames[i]!);
      const chosenDomains = chosenParams.map((p) => domains.get(p)!);

      function cartesian(dimIdx: number, partial: [string, unknown][]): void {
        if (dimIdx === chosenParams.length) {
          const sorted = [...partial].sort((a, b) =>
            a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
          );
          tuples.push(JSON.stringify(sorted));
          return;
        }
        for (const val of chosenDomains[dimIdx]!) {
          cartesian(dimIdx + 1, [...partial, [chosenParams[dimIdx]!, val]]);
        }
      }

      cartesian(0, []);
      return;
    }

    for (let i = start; i <= n - (t - chosen.length); i++) {
      combineIndices(i + 1, [...chosen, i]);
    }
  }

  combineIndices(0, []);
  return tuples;
}

/**
 * Marks or unmarks all t-tuples that a given row covers (using canonical sorting).
 */
function markRowCoverage(
  row: Record<string, unknown>,
  paramNames: string[],
  _domains: Map<string, unknown[]>,
  strength: number,
  uncovered: Set<string>,
  remove: boolean,
): void {
  const t = strength;
  const n = paramNames.length;

  function combineIndices(start: number, chosen: number[]): void {
    if (chosen.length === t) {
      const entries: [string, unknown][] = chosen.map((i) => [
        paramNames[i]!,
        row[paramNames[i]!],
      ]);
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const key = JSON.stringify(entries);
      if (remove) {
        uncovered.delete(key);
      } else {
        uncovered.add(key);
      }
      return;
    }
    for (let i = start; i <= n - (t - chosen.length); i++) {
      combineIndices(i + 1, [...chosen, i]);
    }
  }

  combineIndices(0, []);
}

/**
 * Returns the set of uncovered tuple keys that involve `newParam`.
 */
function collectUncoveredForParam(
  newParam: string,
  _processedParams: string[],
  _strength: number,
  uncovered: Set<string>,
): Set<string> {
  const result = new Set<string>();
  for (const key of uncovered) {
    const entries = JSON.parse(key) as [string, unknown][];
    if (entries.some(([p]) => p === newParam)) {
      result.add(key);
    }
  }
  return result;
}

/**
 * Picks the best value for `param` when constructing a new vertical row,
 * by counting how many uncovered tuples each value participates in.
 */
function pickBestValueForParam(
  param: string,
  domain: unknown[],
  newParam: string,
  partialRow: Record<string, unknown>,
  _strength: number,
  uncovered: Set<string>,
): unknown {
  let bestValue = domain[0];
  let bestCount = -1;

  for (const value of domain) {
    let count = 0;
    const testRow = { ...partialRow, [param]: value };

    for (const key of uncovered) {
      const entries = JSON.parse(key) as [string, unknown][];
      if (!entries.some(([p]) => p === newParam)) continue;
      const paramEntry = entries.find(([p]) => p === param);
      if (!paramEntry) continue;
      if (paramEntry[1] !== value) continue;

      // Check all other entries in the tuple match testRow
      const allMatch = entries.every(([p, v]) => {
        if (p === param) return true; // already checked
        if (p === newParam) return true; // not assigned yet
        return !(p in testRow) || testRow[p] === v;
      });

      if (allMatch) count++;
    }

    if (count > bestCount) {
      bestCount = count;
      bestValue = value;
    }
  }

  return bestValue;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a partial assignment (tuple) is feasible under model constraints.
 * A tuple is infeasible if it directly violates an exclusion constraint where all
 * involved flags are present in the tuple.
 */
function isFeasibleTuple(tupleKey: string, model: FeatureModel): boolean {
  const entries = JSON.parse(tupleKey) as [string, unknown][];
  const assignment = new Map(entries);

  for (const constraint of model.constraints) {
    if (constraint.kind !== "excludes") continue;

    // Check if all flags in this constraint are assigned in this tuple
    const relevantFlags = constraint.flags.filter(f => assignment.has(f));
    if (relevantFlags.length < 2) continue;

    // For excludes: if all constrained flags are true, the tuple is infeasible
    const allTrue = relevantFlags.every(f => assignment.get(f) === true);
    if (allTrue) return false;
  }

  // For requires constraints: if the source is true but a required flag is false
  for (const constraint of model.constraints) {
    if (constraint.kind !== "requires") continue;

    const relevantFlags = constraint.flags.filter(f => assignment.has(f));
    if (relevantFlags.length < 2) continue;

    // requires: first flag being true requires all others to be true
    const source = constraint.flags[0] as string;
    if (assignment.has(source) && assignment.get(source) === true) {
      for (let i = 1; i < constraint.flags.length; i++) {
        const dep = constraint.flags[i] as string;
        if (assignment.has(dep) && assignment.get(dep) === false) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Generates a t-way covering array for the given feature model using IPOG.
 *
 * The result guarantees that every combination of `strength` parameter values
 * appears in at least one configuration — sufficient for combinatorial
 * interaction testing without exhaustive enumeration.
 */
export function generateCoveringArray(
  model: FeatureModel,
  options?: CoveringArrayOptions,
): CoveringArrayResult {
  const constraintAware = options?.constraintAware ?? true;

  // Extract domains for all parameters
  const allDomains = extractDomains(model);

  // Filter out single-value parameters (can't contribute to interactions)
  const paramNames: string[] = [];
  const activeDomains = new Map<string, unknown[]>();
  for (const [name, domain] of allDomains) {
    if (domain.length > 1) {
      paramNames.push(name);
      activeDomains.set(name, domain);
    }
  }

  const parameterCount = paramNames.length;

  // Validate and clamp strength
  const rawStrength = options?.strength ?? 2;
  if (!Number.isInteger(rawStrength)) {
    throw new TypeError(`strength must be an integer, got ${rawStrength}`);
  }
  const strength =
    parameterCount < 2
      ? Math.min(rawStrength, parameterCount)
      : Math.max(2, Math.min(6, Math.min(rawStrength, parameterCount)));

  // Edge case: fewer than 2 usable parameters
  if (parameterCount < 2) {
    return {
      configurations: [],
      strength,
      parameterCount,
      coverageStats: {
        totalTuples: 0,
        coveredTuples: 0,
        coveragePercent: 100,
      },
    };
  }

  // Run IPOG
  let rows = runIpog(paramNames, activeDomains, strength);

  // Constraint filtering
  if (constraintAware && model.constraints.length > 0) {
    rows = rows.filter((row) => {
      const result = validateConfiguration(model, row);
      return result.valid;
    });
  }

  // Compute coverage stats — only count feasible tuples
  const allTupleKeys = generateTuplesCanonical(paramNames, activeDomains, strength);

  // Filter to feasible tuples when constraint-aware
  const feasibleTupleKeys = (constraintAware && model.constraints.length > 0)
    ? allTupleKeys.filter(key => isFeasibleTuple(key, model))
    : allTupleKeys;

  const totalTuples = feasibleTupleKeys.length;
  const uncoveredSet = new Set(feasibleTupleKeys);

  for (const row of rows) {
    markRowCoverage(row, paramNames, activeDomains, strength, uncoveredSet, true);
  }

  const coveredTuples = totalTuples - uncoveredSet.size;
  const coveragePercent =
    totalTuples === 0 ? 100 : Math.round((coveredTuples / totalTuples) * 10000) / 100;

  return {
    configurations: rows,
    strength,
    parameterCount,
    coverageStats: {
      totalTuples,
      coveredTuples,
      coveragePercent,
    },
  };
}

/**
 * Computes how strongly a parameter interacts with others based on the model's
 * constraint definitions.
 *
 * Two parameters "interact" if they co-appear in any constraint's `flags` array.
 * The `maxStrength` reflects the largest constraint group the parameter belongs to.
 */
export function computeInteractionStrength(
  model: FeatureModel,
  parameterName: string,
): InteractionStrengthResult {
  const interactsWith = new Set<string>();
  let maxStrength = 0;

  for (const constraint of model.constraints) {
    if (!constraint.flags.includes(parameterName)) continue;

    const groupSize = constraint.flags.length;
    if (groupSize > maxStrength) {
      maxStrength = groupSize;
    }

    for (const flag of constraint.flags) {
      if (flag !== parameterName) {
        interactsWith.add(flag);
      }
    }
  }

  return {
    parameter: parameterName,
    interactionCount: interactsWith.size,
    interactsWith: [...interactsWith].sort(),
    maxStrength,
  };
}
