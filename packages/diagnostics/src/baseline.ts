/**
 * SARIF baseline comparison: assigns baselineState to results
 * by comparing current results against a previous baseline run.
 *
 * Fingerprinting uses ruleId + first logicalLocation fullyQualifiedName
 * to identify matching results across runs.
 */

import type { SarifResult, SarifBaselineState } from "@mma/core";

/** Result fingerprint for matching across runs */
function fingerprint(result: SarifResult): string {
  const loc =
    result.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? "";
  return `${result.ruleId}::${loc}`;
}

export interface BaselineResult extends SarifResult {
  readonly baselineState: SarifBaselineState;
}

/**
 * Compare current results against a baseline set.
 *
 * Returns a new array with baselineState assigned:
 * - "new": result exists in current but not in baseline
 * - "unchanged": result exists in both with same level and message
 * - "updated": result exists in both but level or message changed
 * - "absent": result exists in baseline but not in current
 */
export function computeBaseline(
  current: readonly SarifResult[],
  baseline: readonly SarifResult[],
): BaselineResult[] {
  const baselineByKey = new Map<string, SarifResult>();
  for (const r of baseline) {
    baselineByKey.set(fingerprint(r), r);
  }

  const seenKeys = new Set<string>();
  const results: BaselineResult[] = [];

  for (const r of current) {
    const key = fingerprint(r);
    seenKeys.add(key);

    const prev = baselineByKey.get(key);
    let state: SarifBaselineState;

    if (!prev) {
      state = "new";
    } else if (prev.level === r.level && prev.message.text === r.message.text) {
      state = "unchanged";
    } else {
      state = "updated";
    }

    results.push({ ...r, baselineState: state });
  }

  // Add absent entries for baseline results not in current
  for (const [key, r] of baselineByKey) {
    if (!seenKeys.has(key)) {
      results.push({ ...r, baselineState: "absent" });
    }
  }

  return results;
}
