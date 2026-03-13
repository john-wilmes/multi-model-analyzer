/**
 * Git-affected scoping: combine git diff changeset with blast radius
 * to determine which files need re-analysis.
 */

import type { ChangeSet } from "@mma/core";
import type { GraphStore } from "@mma/storage";
import { computeBlastRadius, computePageRank } from "@mma/query";
import { getChangedFilesInRange, parseRevisionRange } from "@mma/ingestion";

export interface AffectedScope {
  readonly changedFiles: string[];
  readonly affectedFiles: string[];
  readonly allScopedFiles: string[];
  readonly repo: string;
}

export interface PRImpactSummary {
  readonly changedFiles: string[];
  readonly affectedFiles: string[];
  readonly totalAffected: number;
  readonly maxDepth: number;
  /** Files sorted by PageRank impact (highest risk first) */
  readonly highRiskFiles: readonly { path: string; score: number }[];
  readonly revisionRange: { from: string; to: string };
}

/** Compute affected scope per repo. Expects one ChangeSet per repo. */
export async function computeAffectedScope(
  changeSets: readonly ChangeSet[],
  graphStore: GraphStore,
  options?: { maxBlastDepth?: number },
): Promise<Map<string, AffectedScope>> {
  const maxDepth = options?.maxBlastDepth ?? 5;
  const result = new Map<string, AffectedScope>();

  for (const cs of changeSets) {
    const changedFiles = [
      ...cs.addedFiles,
      ...cs.modifiedFiles,
    ];
    // Include deleted files as blast radius roots: dependents of deleted files
    // need re-analysis even though deleted files won't be parsed themselves.
    const blastRoots = [...changedFiles, ...cs.deletedFiles];

    if (blastRoots.length === 0) {
      const existing = result.get(cs.repo);
      result.set(cs.repo, existing ?? {
        changedFiles: [],
        affectedFiles: [],
        allScopedFiles: [],
        repo: cs.repo,
      });
      continue;
    }

    const blastResult = await computeBlastRadius(
      blastRoots,
      graphStore,
      { maxDepth, repo: cs.repo },
    );

    const affectedPaths = blastResult.affectedFiles.map((f) => f.path);
    // allScopedFiles only includes files that still exist (not deleted),
    // since deleted files can't be parsed.
    const allScoped = [...new Set([...changedFiles, ...affectedPaths])];

    // Merge with any previously computed scope for this repo (union all sets)
    // to avoid silent overwrites when changeSets contains duplicate repo entries.
    const existing = result.get(cs.repo);
    if (existing) {
      const mergedChanged = [...new Set([...existing.changedFiles, ...changedFiles])];
      const mergedAffected = [...new Set([...existing.affectedFiles, ...affectedPaths])];
      const mergedAll = [...new Set([...existing.allScopedFiles, ...allScoped])];
      result.set(cs.repo, {
        changedFiles: mergedChanged,
        affectedFiles: mergedAffected,
        allScopedFiles: mergedAll,
        repo: cs.repo,
      });
    } else {
      result.set(cs.repo, {
        changedFiles,
        affectedFiles: affectedPaths,
        allScopedFiles: allScoped,
        repo: cs.repo,
      });
    }
  }

  return result;
}

/**
 * Compute PR impact analysis from a git revision range.
 *
 * Combines git diff with blast radius and PageRank scoring to produce
 * a summary of which files are changed and which are at risk.
 */
export async function computePRImpact(
  repoPath: string,
  range: string,
  graphStore: GraphStore,
  options?: { maxBlastDepth?: number; topN?: number; repo?: string },
): Promise<PRImpactSummary> {
  const maxDepth = options?.maxBlastDepth ?? 5;
  const topN = options?.topN ?? 10;
  const repo = options?.repo ?? "";

  const rangeResult = await getChangedFilesInRange(repoPath, range);
  const changedFiles = [...rangeResult.added, ...rangeResult.modified];

  const blastResult = await computeBlastRadius(
    [...changedFiles, ...rangeResult.deleted],
    graphStore,
    { maxDepth, repo },
  );

  // Get all import edges to compute PageRank on the full graph
  const allEdges = await graphStore.getEdgesByKind("imports", repo);
  const prResult = computePageRank(allEdges);

  // Filter PageRank results to changed + affected files
  const impactedPaths = new Set([...changedFiles, ...blastResult.affectedFiles.map(f => f.path)]);
  const highRiskFiles = prResult.ranked
    .filter(f => impactedPaths.has(f.path))
    .slice(0, topN)
    .map(f => ({ path: f.path, score: f.score }));

  return {
    changedFiles,
    affectedFiles: blastResult.affectedFiles.map(f => f.path),
    totalAffected: blastResult.totalAffected,
    maxDepth,
    highRiskFiles,
    revisionRange: parseRevisionRange(range),
  };
}
