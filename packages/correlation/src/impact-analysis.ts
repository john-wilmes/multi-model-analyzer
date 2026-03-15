/**
 * Cross-repo impact analysis via reverse BFS.
 */

import type { GraphStore } from "@mma/storage";
import type { CrossRepoGraph, CrossRepoImpactResult } from "./types.js";

/**
 * Given a set of changed files in a repo, computes all transitively affected
 * files within the same repo and across repo boundaries.
 */
export async function computeCrossRepoImpact(
  changedFiles: readonly string[],
  changedRepo: string,
  graphStore: GraphStore,
  crossRepoGraph: CrossRepoGraph,
): Promise<CrossRepoImpactResult> {
  // Phase 1: Intra-repo reverse BFS
  const intraVisited = new Set<string>();
  const intraQueue: string[] = [...changedFiles];
  for (const f of changedFiles) intraVisited.add(f);

  while (intraQueue.length > 0) {
    const file = intraQueue.shift()!;
    const edges = await graphStore.getEdgesTo(file, changedRepo);
    for (const edge of edges) {
      if (!intraVisited.has(edge.source)) {
        intraVisited.add(edge.source);
        intraQueue.push(edge.source);
      }
    }
  }

  // affectedWithinRepo = all transitively affected files, excluding the changed files themselves
  const affectedWithinRepo = [...intraVisited].filter(
    (f) => !changedFiles.includes(f),
  );

  // Phase 2: Cross-repo expansion (iterative — supports multi-hop chains)
  const affectedAcrossRepos = new Map<string, Set<string>>();

  // Queue of (repo, file) pairs to expand cross-repo from
  const expansionQueue: Array<{ repo: string; files: Iterable<string> }> = [
    { repo: changedRepo, files: intraVisited },
  ];
  const processedRepos = new Set<string>([changedRepo]);

  while (expansionQueue.length > 0) {
    const { repo: sourceRepo, files } = expansionQueue.shift()!;

    for (const affectedFile of files) {
      const crossEdges = crossRepoGraph.edges.filter(
        (e) => e.sourceRepo === sourceRepo && e.edge.source === affectedFile,
      );

      for (const crossEdge of crossEdges) {
        const targetRepo = crossEdge.targetRepo;
        const seedFile = crossEdge.edge.target;

        if (!affectedAcrossRepos.has(targetRepo)) {
          affectedAcrossRepos.set(targetRepo, new Set());
        }
        const targetVisited = affectedAcrossRepos.get(targetRepo)!;

        if (targetVisited.has(seedFile)) continue;

        // Reverse BFS in the target repo
        const targetQueue: string[] = [seedFile];
        targetVisited.add(seedFile);

        while (targetQueue.length > 0) {
          const file = targetQueue.shift()!;
          const edges = await graphStore.getEdgesTo(file, targetRepo);
          for (const edge of edges) {
            if (!targetVisited.has(edge.source)) {
              targetVisited.add(edge.source);
              targetQueue.push(edge.source);
            }
          }
        }

        // Schedule cross-repo expansion from newly discovered files in targetRepo
        if (!processedRepos.has(targetRepo)) {
          processedRepos.add(targetRepo);
          expansionQueue.push({ repo: targetRepo, files: targetVisited });
        }
      }
    }
  }

  const reposReached =
    1 + // the changed repo
    affectedAcrossRepos.size;

  const affectedAcrossReposResult = new Map<string, readonly string[]>(
    [...affectedAcrossRepos.entries()].map(([repo, files]) => [repo, [...files]]),
  );

  return {
    changedFiles,
    changedRepo,
    affectedWithinRepo,
    affectedAcrossRepos: affectedAcrossReposResult,
    reposReached,
  };
}
