/**
 * Cross-repo impact analysis via reverse BFS.
 */

import type { GraphStore } from "@mma/storage";
import type { CrossRepoGraph, CrossRepoImpactResult } from "./types.js";

/** Yield to the event loop to prevent blocking on large graph traversals. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Given a set of changed files in a repo, computes all transitively affected
 * files within the same repo and across repo boundaries.
 *
 * This is an on-demand utility intended for MCP tool calls and CLI queries
 * (e.g., "what breaks if I change X?"). It is NOT called during batch pipeline
 * execution in run-correlation.ts — the pipeline does not have per-file change
 * sets at correlation time. Callers supply the specific (changedRepo, changedFiles)
 * they want to analyze.
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

  let intraIter = 0;
  while (intraQueue.length > 0) {
    if (++intraIter % 1000 === 0) await yieldToEventLoop();
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

  // Pre-build an index of cross-repo edges keyed by "sourceRepo\0sourceFile"
  // to avoid O(files × crossEdges) linear scans in the inner loop.
  const crossEdgeIndex = new Map<string, typeof crossRepoGraph.edges[number][]>();
  for (const edge of crossRepoGraph.edges) {
    // sourceRepo is also derivable via extractRepo(edge.edge.source) for canonical IDs
    const key = `${edge.sourceRepo}\0${edge.edge.source}`;
    const arr = crossEdgeIndex.get(key);
    if (arr) arr.push(edge);
    else crossEdgeIndex.set(key, [edge]);
  }

  // Queue of (repo, file) pairs to expand cross-repo from
  const expansionQueue: Array<{ repo: string; files: Iterable<string> }> = [
    { repo: changedRepo, files: intraVisited },
  ];
  // Track (repo, seedFile) pairs already seeded so we don't re-do the same
  // intra-repo BFS from the same file, but DO allow a new seed file in an
  // already-visited repo (reached via a different cross-repo edge).
  const processedSeeds = new Set<string>(
    [...intraVisited].map((f) => `${changedRepo}\0${f}`),
  );

  while (expansionQueue.length > 0) {
    const { repo: sourceRepo, files } = expansionQueue.shift()!;

    for (const affectedFile of files) {
      const crossEdges = crossEdgeIndex.get(`${sourceRepo}\0${affectedFile}`) ?? [];

      for (const crossEdge of crossEdges) {
        const targetRepo = crossEdge.targetRepo;
        const seedFile = crossEdge.edge.target;

        if (!affectedAcrossRepos.has(targetRepo)) {
          affectedAcrossRepos.set(targetRepo, new Set());
        }
        const targetVisited = affectedAcrossRepos.get(targetRepo)!;

        const seedKey = `${targetRepo}\0${seedFile}`;
        if (processedSeeds.has(seedKey)) continue;
        processedSeeds.add(seedKey);

        // Reverse BFS in the target repo from this seed file
        const targetQueue: string[] = [seedFile];
        targetVisited.add(seedFile);

        let targetIter = 0;
        while (targetQueue.length > 0) {
          if (++targetIter % 1000 === 0) await yieldToEventLoop();
          const file = targetQueue.shift()!;
          const edges = await graphStore.getEdgesTo(file, targetRepo);
          for (const edge of edges) {
            if (!targetVisited.has(edge.source)) {
              targetVisited.add(edge.source);
              targetQueue.push(edge.source);
            }
          }
        }

        // Always schedule cross-repo expansion from targetRepo with the files
        // discovered in this BFS pass (new seed may have revealed new files).
        expansionQueue.push({ repo: targetRepo, files: targetVisited });
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
