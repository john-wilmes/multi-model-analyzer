/**
 * Architectural Technical Debt Index (ATDI)
 *
 * Produces a single 0-100 health score per repo and system-wide.
 * Higher scores = healthier codebase.
 *
 * Three components (weights sum to 1.0):
 *   - Findings density  (0.5): weighted SARIF findings per module, saturates at 10/module
 *   - Zone ratio        (0.3): fraction of modules in pain or uselessness zones
 *   - Avg main-sequence distance (0.2): average |D| already in RepoMetricsSummary
 */

export interface AtdiScore {
  readonly repo: string;
  readonly score: number; // 0-100, higher = healthier
  readonly moduleCount: number;
  readonly components: {
    readonly findingsDensity: number; // 0-1
    readonly zoneRatio: number; // 0-1
    readonly avgDistance: number; // 0-1
  };
  readonly findingCounts: {
    readonly error: number;
    readonly warning: number;
    readonly note: number;
  };
}

export interface SystemAtdi {
  readonly score: number; // 0-100, weighted average by module count
  readonly repoScores: readonly AtdiScore[];
  readonly computedAt: string; // ISO timestamp
}

/**
 * Compute an ATDI score for a single repo.
 *
 * @param repo                 Repository name.
 * @param moduleCount          Number of modules analysed.
 * @param painZoneCount        Modules in the Zone of Pain (high I, high A).
 * @param uselessnessZoneCount Modules in the Zone of Uselessness (low I, low A).
 * @param avgDistance          Average distance from the Main Sequence (0-1).
 * @param errorCount           SARIF results at level "error".
 * @param warningCount         SARIF results at level "warning".
 * @param noteCount            SARIF results at level "note".
 */
export function computeRepoAtdi(
  repo: string,
  moduleCount: number,
  painZoneCount: number,
  uselessnessZoneCount: number,
  avgDistance: number,
  errorCount: number,
  warningCount: number,
  noteCount: number,
): AtdiScore {
  const safeModuleCount = Math.max(moduleCount, 1);

  // Component 1: findings density (weight 0.5)
  const weightedFindings = errorCount * 10 + warningCount * 3 + noteCount * 1;
  const findingsPerModule = weightedFindings / safeModuleCount;
  const findingsDensity = Math.min(1, findingsPerModule / 10);

  // Component 2: zone ratio (weight 0.3)
  const zoneRatio = (painZoneCount + uselessnessZoneCount) / safeModuleCount;

  // Component 3: average main-sequence distance (weight 0.2)
  // avgDistance is already 0-1; clamp defensively
  const clampedAvgDistance = Math.min(1, Math.max(0, avgDistance));

  const debtRatio =
    findingsDensity * 0.5 + zoneRatio * 0.3 + clampedAvgDistance * 0.2;

  const score = Math.max(0, Math.min(100, Math.round((1 - debtRatio) * 100)));

  return {
    repo,
    score,
    moduleCount,
    components: {
      findingsDensity,
      zoneRatio,
      avgDistance: clampedAvgDistance,
    },
    findingCounts: {
      error: errorCount,
      warning: warningCount,
      note: noteCount,
    },
  };
}

/**
 * Compute a system-wide ATDI score as a weighted average by module count.
 *
 * Repos with zero modules are given a minimum weight of 1 and are included in
 * repoScores but contribute only minimally to the overall score.
 */
export function computeSystemAtdi(repoScores: readonly AtdiScore[]): SystemAtdi {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const r of repoScores) {
    const weight = Math.max(r.moduleCount, 1);
    totalWeight += weight;
    weightedSum += r.score * weight;
  }

  const score =
    totalWeight === 0
      ? 100
      : Math.max(0, Math.min(100, Math.round(weightedSum / totalWeight)));

  return {
    score,
    repoScores,
    computedAt: new Date().toISOString(),
  };
}
