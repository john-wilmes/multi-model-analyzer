/**
 * Temporal coupling detection: identifies files that frequently
 * change together in git history, indicating hidden dependencies.
 *
 * Uses co-change analysis: for each commit, pairs of changed files
 * are counted. Pairs that appear together above a threshold are
 * flagged as temporally coupled.
 */

import type { SarifResult, HeuristicResult } from "@mma/core";
import { runHeuristic } from "@mma/core";

export interface CommitInfo {
  readonly hash: string;
  readonly files: readonly string[];
}

export interface CoupledPair {
  readonly fileA: string;
  readonly fileB: string;
  /** Number of commits where both files changed */
  readonly coChangeCount: number;
  /** Proportion of fileA's changes that also include fileB */
  readonly supportA: number;
  /** Proportion of fileB's changes that also include fileA */
  readonly supportB: number;
  /** Confidence: max(supportA, supportB) */
  readonly confidence: number;
}

export interface TemporalCouplingOptions {
  /** Minimum co-change count to report. Default: 3 */
  readonly minCoChanges?: number;
  /** Minimum confidence to report. Default: 0.5 */
  readonly minConfidence?: number;
  /** Maximum files per commit to consider (skip merge commits). Default: 50 */
  readonly maxFilesPerCommit?: number;
}

export interface TemporalCouplingResult {
  readonly pairs: readonly CoupledPair[];
  readonly commitsAnalyzed: number;
  readonly commitsSkipped: number;
}

/**
 * Group flat file-change records (from getCommitHistory) into CommitInfo[].
 */
export function groupByCommit(changes: readonly { hash: string; filePath: string }[]): CommitInfo[] {
  const map = new Map<string, string[]>();
  for (const c of changes) {
    let files = map.get(c.hash);
    if (!files) { files = []; map.set(c.hash, files); }
    files.push(c.filePath);
  }
  return Array.from(map, ([hash, files]) => ({ hash, files }));
}

/**
 * Analyze commit history to find temporally coupled file pairs.
 */
export function detectTemporalCoupling(
  commits: readonly CommitInfo[],
  options?: TemporalCouplingOptions,
): TemporalCouplingResult {
  const minCoChanges = options?.minCoChanges ?? 3;
  const minConfidence = options?.minConfidence ?? 0.5;
  const maxFilesPerCommit = options?.maxFilesPerCommit ?? 50;

  // Count how many commits each file appears in
  const fileCommitCount = new Map<string, number>();
  // Count co-occurrences for each pair
  const pairCount = new Map<string, number>();
  let commitsAnalyzed = 0;
  let commitsSkipped = 0;

  for (const commit of commits) {
    if (commit.files.length > maxFilesPerCommit) {
      commitsSkipped++;
      continue;
    }

    commitsAnalyzed++;

    // Count ALL file appearances (including single-file commits)
    for (const file of commit.files) {
      fileCommitCount.set(file, (fileCommitCount.get(file) ?? 0) + 1);
    }

    if (commit.files.length < 2) {
      continue;
    }

    // Count all pairs in this commit using inline comparison for canonical key order
    const files = commit.files;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const fileA = files[i]!;
        const fileB = files[j]!;
        const key = fileA < fileB ? `${fileA}\0${fileB}` : `${fileB}\0${fileA}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  // Build coupled pairs
  const pairs: CoupledPair[] = [];
  for (const [key, count] of pairCount) {
    if (count < minCoChanges) continue;

    const [fileA, fileB] = key.split("\0") as [string, string];
    const countA = fileCommitCount.get(fileA) ?? 1;
    const countB = fileCommitCount.get(fileB) ?? 1;

    const supportA = count / countA;
    const supportB = count / countB;
    const confidence = Math.max(supportA, supportB);

    if (confidence < minConfidence) continue;

    pairs.push({ fileA, fileB, coChangeCount: count, supportA, supportB, confidence });
  }

  // Sort by co-change count descending, then confidence
  pairs.sort((a, b) => b.coChangeCount - a.coChangeCount || b.confidence - a.confidence);

  return { pairs, commitsAnalyzed, commitsSkipped };
}

export function detectTemporalCouplingWithMeta(
  commits: readonly CommitInfo[],
  repo: string,
  options?: TemporalCouplingOptions,
): HeuristicResult<TemporalCouplingResult> {
  return runHeuristic(repo, "detectTemporalCoupling", () => detectTemporalCoupling(commits, options), (d) => d.pairs);
}

/**
 * Convert temporal coupling results to SARIF diagnostics.
 */
export function temporalCouplingToSarif(
  result: TemporalCouplingResult,
  repo: string,
  options?: { maxResults?: number },
): SarifResult[] {
  const maxResults = options?.maxResults ?? 20;

  return result.pairs.slice(0, maxResults).map(pair => ({
    ruleId: "temporal-coupling/co-change",
    level: pair.confidence >= 0.8 ? "warning" as const : "note" as const,
    message: {
      text: `Temporal coupling: "${pair.fileA}" and "${pair.fileB}" changed together in ${pair.coChangeCount} commits (confidence: ${(pair.confidence * 100).toFixed(0)}%). Consider if these files should be co-located or if there is a missing abstraction.`,
    },
    locations: [{
      logicalLocations: [{
        fullyQualifiedName: pair.fileA,
        kind: "module",
        properties: { repo },
      }],
    }],
    relatedLocations: [{
      logicalLocations: [{
        fullyQualifiedName: pair.fileB,
        kind: "module",
        properties: { repo },
      }],
    }],
    properties: {
      coChangeCount: pair.coChangeCount,
      confidence: pair.confidence,
      supportA: pair.supportA,
      supportB: pair.supportB,
    },
  }));
}
