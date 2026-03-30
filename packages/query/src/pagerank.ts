/**
 * PageRank-based reach scoring for dependency graphs.
 *
 * Computes a score for each file in the graph reflecting how many other files
 * transitively depend on it. Higher score = higher blast radius risk.
 */

import type { GraphEdge, SarifResult } from "@mma/core";
import { createSarifResult } from "@mma/core";

export interface PageRankOptions {
  /** Damping factor (probability of following a link). Default: 0.85 */
  readonly damping?: number;
  /** Maximum iterations. Default: 100 */
  readonly maxIterations?: number;
  /** Convergence threshold. Default: 1e-6 */
  readonly tolerance?: number;
}

export interface PageRankResult {
  /** File path -> normalized PageRank score (0-1) */
  readonly scores: ReadonlyMap<string, number>;
  /** Number of iterations to converge */
  readonly iterations: number;
  /** Files sorted by score descending */
  readonly ranked: readonly RankedFile[];
}

export interface RankedFile {
  readonly path: string;
  readonly score: number;
  readonly rank: number;
}

/**
 * Compute PageRank scores for nodes in a dependency graph.
 *
 * Uses import edges to build an adjacency list. In dependency graph terms,
 * "A imports B" means B is important — so we use the forward import direction
 * to assign rank (link targets accumulate rank from sources).
 */
export function computePageRank(
  edges: readonly GraphEdge[],
  options?: PageRankOptions,
): PageRankResult {
  const damping = options?.damping ?? 0.85;
  const maxIterations = options?.maxIterations ?? 100;
  const tolerance = options?.tolerance ?? 1e-6;

  // Collect all nodes
  const nodes = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    nodes.add(edge.source);
    nodes.add(edge.target);
  }

  const nodeList = [...nodes];
  const n = nodeList.length;

  if (n === 0) {
    return { scores: new Map(), iterations: 0, ranked: [] };
  }

  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    nodeIndex.set(nodeList[i]!, i);
  }

  // Build adjacency: outLinks[i] = list of node indices that i links to
  // "A imports B" means A has an outgoing link to B
  const outLinks: number[][] = Array.from({ length: n }, () => []);
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    const srcIdx = nodeIndex.get(edge.source);
    const tgtIdx = nodeIndex.get(edge.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      outLinks[srcIdx]!.push(tgtIdx);
    }
  }

  // Initialize scores uniformly
  let scores = new Float64Array(n).fill(1 / n);
  let iterations = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(n).fill((1 - damping) / n);

    // Distribute rank from each node to its outgoing targets
    for (let i = 0; i < n; i++) {
      const links = outLinks[i]!;
      if (links.length === 0) {
        // Dangling node: distribute rank evenly to all
        const share = scores[i]! * damping / n;
        for (let j = 0; j < n; j++) {
          next[j]! += share;
        }
      } else {
        const share = scores[i]! * damping / links.length;
        for (const target of links) {
          next[target]! += share;
        }
      }
    }

    // Check convergence
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(next[i]! - scores[i]!);
    }

    scores = next;
    iterations = iter + 1;

    if (diff < tolerance) break;
  }

  // Build results
  const scoreMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    scoreMap.set(nodeList[i]!, scores[i]!);
  }

  const ranked: RankedFile[] = nodeList
    .map((path, i) => ({ path, score: scores[i]! }))
    .sort((a, b) => b.score - a.score)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));

  return { scores: scoreMap, iterations, ranked };
}

/**
 * Convert PageRank results to SARIF diagnostics.
 *
 * Emits a "note" for each file above the score threshold, flagging it
 * as a high-risk node in the dependency graph.
 */
export function pageRankToSarif(
  result: PageRankResult,
  repo: string,
  options?: { topN?: number; minScore?: number },
): SarifResult[] {
  const topN = options?.topN ?? 10;

  // Filter to internal files only (prefixed with "repo:path") — excludes
  // external packages like "class-validator" that have high PageRank but
  // aren't meaningful for blast radius analysis.
  // Internal files are prefixed with "repo:" by the indexing pipeline
  // (e.g. "novu-api:src/app.ts"). External packages (lodash, @novu/shared,
  // node:fs) lack this prefix.
  const repoPrefix = `${repo}:`;
  const internal = result.ranked.filter(f => {
    if (!f.path.startsWith(repoPrefix)) return false;
    // Exclude compiled output / vendored paths that shouldn't produce findings
    const relPath = f.path.slice(repoPrefix.length);
    if (relPath.startsWith("dist/") || relPath.startsWith("node_modules/") || relPath.startsWith(".next/")) return false;
    return true;
  });

  // Use explicit minScore if provided, otherwise derive from internal distribution:
  // default to 10% of the top internal score (adapts to different graph sizes).
  const topInternalScore = internal.length > 0 ? internal[0]!.score : 0;
  const minScore = options?.minScore ?? topInternalScore * 0.1;

  const filtered = internal.filter(f => f.score > minScore).slice(0, topN);

  return filtered.map((f, i) => {
    const rank = i + 1;
    return createSarifResult(
      "blast-radius/high-pagerank",
      "note",
      `High blast radius: "${f.path}" has PageRank score ${f.score.toFixed(4)} (rank #${rank}). Changes to this file affect many dependents.`,
      {
        locations: [{
          logicalLocations: [{
            fullyQualifiedName: f.path,
            kind: "module",
            properties: { repo },
          }],
        }],
        properties: { pageRankScore: f.score, rank },
      },
    );
  });
}
