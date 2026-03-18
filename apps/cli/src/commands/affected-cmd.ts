/**
 * `mma affected` — Show blast radius for a git revision range.
 *
 * Combines git diff with dependency graph traversal and PageRank scoring
 * to show which files are changed and which are transitively affected.
 */

import type { GraphStore } from "@mma/storage";
import { computeBlastRadius, computePageRank } from "@mma/query";
import { getChangedFilesInRange, parseRevisionRange } from "@mma/ingestion";

export interface AffectedCommandOptions {
  readonly repoPath: string;
  readonly range: string;
  readonly graphStore: GraphStore;
  readonly format: "json" | "table" | "sarif";
  readonly repo?: string;
  readonly maxDepth?: number;
}

export interface AffectedResult {
  readonly range: string;
  readonly changed: { added: string[]; modified: string[]; deleted: string[] };
  readonly affected: ReadonlyArray<{ path: string; depth: number; via: string }>;
  readonly totalAffected: number;
  readonly highRisk: ReadonlyArray<{ path: string; rank: number; score: number }>;
}

/**
 * Core logic for the affected command. Returns structured result
 * without doing any output (for testability).
 */
export async function computeAffected(
  options: Pick<AffectedCommandOptions, "repoPath" | "range" | "graphStore" | "repo" | "maxDepth">,
): Promise<AffectedResult> {
  const { repoPath, range, graphStore, repo, maxDepth = 5 } = options;

  const parsedRange = parseRevisionRange(range);
  const rangeResult = await getChangedFilesInRange(repoPath, range);
  const changedFiles = [...rangeResult.added, ...rangeResult.modified];

  const blastRoots = [...changedFiles, ...rangeResult.deleted];
  const blastResult = blastRoots.length > 0
    ? await computeBlastRadius(blastRoots, graphStore, { maxDepth, repo })
    : { totalAffected: 0, affectedFiles: [] as Array<{ path: string; depth: number; via: string }> };

  // PageRank scoring for risk ranking
  const allEdges = await graphStore.getEdgesByKind("imports", repo);
  let highRisk: Array<{ path: string; rank: number; score: number }> = [];
  if (allEdges.length > 0) {
    const prResult = computePageRank(allEdges);
    const impacted = new Set([...changedFiles, ...blastResult.affectedFiles.map(f => f.path)]);
    highRisk = prResult.ranked
      .filter(f => impacted.has(f.path))
      .slice(0, 10);
  }

  return {
    range: `${parsedRange.from}..${parsedRange.to}`,
    changed: {
      added: rangeResult.added,
      modified: rangeResult.modified,
      deleted: rangeResult.deleted,
    },
    affected: blastResult.affectedFiles,
    totalAffected: blastResult.totalAffected,
    highRisk,
  };
}
