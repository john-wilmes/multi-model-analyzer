/**
 * Technical Debt Cost Estimation
 *
 * Assigns estimated remediation times (in minutes) to SARIF rule IDs and
 * provides utilities to annotate findings and summarize debt per repo.
 *
 * Estimates are based on NDepend/SonarQube-style heuristics.
 */

import type { SarifResult } from "@mma/core";

// ---------------------------------------------------------------------------
// Debt estimate table
// ---------------------------------------------------------------------------

const DEBT_MINUTES: Record<string, number> = {
  // Configuration model
  "config/dead-flag": 30,
  "config/always-on-flag": 15,
  "config/missing-constraint": 60,
  "config/untested-interaction": 45,
  "config/format-violation": 20,

  // Fault tree
  "fault/unhandled-error-path": 60,
  "fault/silent-failure": 45,
  "fault/missing-error-boundary": 90,
  "fault/cascading-failure-risk": 120,

  // Structural
  "structural/dead-export": 10,
  "structural/unstable-dependency": 60,
  "structural/pain-zone-module": 120,
  "structural/uselessness-zone-module": 30,

  // Architecture
  "arch/layer-violation": 90,
  "arch/forbidden-import": 60,
  "arch/dependency-direction": 90,

  // Hotspot
  "hotspot/high-churn-complexity": 180,

  // Blast radius
  "blast-radius/high-pagerank": 60,

  // Cross-repo
  "correlation/linchpin-service": 90,
};

export const DEFAULT_DEBT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DebtEstimate {
  readonly ruleId: string;
  readonly minutes: number;
}

export interface RepoDebtSummary {
  readonly repo: string;
  readonly totalMinutes: number;
  readonly totalHours: number;
  readonly byRule: Record<string, { count: number; minutes: number }>;
  readonly bySeverity: Record<string, { count: number; minutes: number }>;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Return the estimated remediation time (minutes) for a given rule ID.
 * Falls back to DEFAULT_DEBT_MINUTES for unknown rules.
 */
export function getDebtMinutes(ruleId: string): number {
  return DEBT_MINUTES[ruleId] ?? DEFAULT_DEBT_MINUTES;
}

/**
 * Return new SarifResult objects with `properties.debtMinutes` added.
 * The original array and its elements are not mutated.
 */
export function annotateDebt(results: readonly SarifResult[]): SarifResult[] {
  return results.map((r) => ({
    ...r,
    properties: {
      ...r.properties,
      debtMinutes: getDebtMinutes(r.ruleId),
    },
  }));
}

/**
 * Summarize total debt for a set of SARIF findings belonging to one repo.
 *
 * The function reads `properties.debtMinutes` when present (i.e. results
 * have already been annotated) and falls back to `getDebtMinutes(ruleId)`
 * otherwise, so it works both before and after annotation.
 */
export function summarizeDebt(
  repo: string,
  results: readonly SarifResult[],
): RepoDebtSummary {
  let totalMinutes = 0;
  const byRule: Record<string, { count: number; minutes: number }> = {};
  const bySeverity: Record<string, { count: number; minutes: number }> = {};

  for (const r of results) {
    const minutes =
      typeof r.properties?.["debtMinutes"] === "number"
        ? r.properties["debtMinutes"]
        : getDebtMinutes(r.ruleId);

    totalMinutes += minutes;

    // Group by rule
    const ruleEntry = byRule[r.ruleId] ?? (byRule[r.ruleId] = { count: 0, minutes: 0 });
    ruleEntry.count += 1;
    ruleEntry.minutes += minutes;

    // Group by severity
    const severity = r.level;
    const sevEntry = bySeverity[severity] ?? (bySeverity[severity] = { count: 0, minutes: 0 });
    sevEntry.count += 1;
    sevEntry.minutes += minutes;
  }

  return {
    repo,
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 10) / 10,
    byRule,
    bySeverity,
  };
}
