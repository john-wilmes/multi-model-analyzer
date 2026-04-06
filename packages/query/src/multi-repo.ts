/**
 * Multi-repo query routing — cross-repo dependency queries.
 *
 * Provides:
 * - Cross-repo dependency discovery (which edges span repo boundaries)
 * - Multi-repo query dispatch (run a structural/search query across N repos, merge results)
 */

import type { GraphEdge } from "@mma/core";
import { extractRepo } from "@mma/core";
import type { GraphStore, SearchStore } from "@mma/storage";
import { executeCallersQuery, executeCalleesQuery } from "./structural.js";
import { executeSearchQuery } from "./search.js";
import type { StructuralQueryResult } from "./structural.js";
import type { SearchQueryResult } from "./search.js";

export interface CrossRepoDependency {
  readonly sourceRepo: string;
  readonly targetRepo: string;
  readonly edges: readonly GraphEdge[];
  readonly count: number;
}

export interface CrossRepoDependencyResult {
  readonly dependencies: readonly CrossRepoDependency[];
  readonly totalCrossRepoEdges: number;
  readonly description: string;
}

/**
 * Find import/dependency edges that cross repo boundaries.
 *
 * Optionally filter to edges from `sourceRepo` and/or targeting `targetRepo`.
 */
export async function findCrossRepoDependencies(
  graphStore: GraphStore,
  options?: {
    sourceRepo?: string;
    targetRepo?: string;
  },
): Promise<CrossRepoDependencyResult> {
  const allImports = await graphStore.getEdgesByKind("imports", options?.sourceRepo);
  const allDeps = await graphStore.getEdgesByKind("depends-on", options?.sourceRepo);
  const allEdges = [...allImports, ...allDeps];

  // Group edges by source-repo -> target-repo
  const pairMap = new Map<string, GraphEdge[]>();

  for (const edge of allEdges) {
    const srcRepo = edge.repo ?? (edge.metadata?.repo as string | undefined) ?? "unknown";
    const tgtRepo = (edge.metadata?.targetRepo as string | undefined) ?? inferTargetRepo(edge.target);

    // Skip edges where target repo can't be determined (assumed intra-repo)
    if (tgtRepo === null) continue;

    // Skip intra-repo edges
    if (srcRepo === tgtRepo) continue;

    // Apply target repo filter
    if (options?.targetRepo && tgtRepo !== options.targetRepo) continue;

    const key = `${srcRepo}->${tgtRepo}`;
    const list = pairMap.get(key) ?? [];
    list.push(edge);
    pairMap.set(key, list);
  }

  const dependencies: CrossRepoDependency[] = [];
  for (const [key, edges] of pairMap) {
    // Use indexOf to find only the first "->" so repo names containing "->"
    // are handled correctly.
    const arrowIdx = key.indexOf("->");
    const sourceRepo = arrowIdx >= 0 ? key.slice(0, arrowIdx) : key;
    const targetRepo = arrowIdx >= 0 ? key.slice(arrowIdx + 2) : "";
    dependencies.push({
      sourceRepo,
      targetRepo,
      edges,
      count: edges.length,
    });
  }
  dependencies.sort((a, b) => b.count - a.count);

  const totalCrossRepoEdges = dependencies.reduce((sum, d) => sum + d.count, 0);

  return {
    dependencies,
    totalCrossRepoEdges,
    description: `${totalCrossRepoEdges} cross-repo edges across ${dependencies.length} repo pairs`,
  };
}

export interface MultiRepoQueryResult {
  readonly perRepo: ReadonlyMap<string, StructuralQueryResult | SearchQueryResult>;
  readonly mergedDescription: string;
}

/**
 * Execute a structural or search query across multiple repos and merge results.
 *
 * For structural queries, runs callers/callees per repo.
 * For search queries, runs BM25 search per repo.
 */
export async function executeMultiRepoQuery(
  queryType: "callers" | "callees" | "search",
  entity: string,
  repos: readonly string[],
  graphStore: GraphStore,
  searchStore: SearchStore,
): Promise<MultiRepoQueryResult> {
  const perRepo = new Map<string, StructuralQueryResult | SearchQueryResult>();

  for (const repo of repos) {
    let result: StructuralQueryResult | SearchQueryResult;
    switch (queryType) {
      case "callers":
        result = await executeCallersQuery(entity, graphStore, repo, searchStore);
        break;
      case "callees":
        result = await executeCalleesQuery(entity, graphStore, repo, searchStore);
        break;
      case "search":
        result = await executeSearchQuery(entity, searchStore, 10, repo);
        break;
    }
    perRepo.set(repo, result);
  }

  const descriptions = [...perRepo.entries()]
    .map(([repo, r]) => `[${repo}] ${r.description}`)
    .join("; ");

  return {
    perRepo,
    mergedDescription: `Multi-repo query (${queryType}) across ${repos.length} repos: ${descriptions}`,
  };
}

/**
 * Infer the target repo from an import target path.
 *
 * Heuristic: if the target is a scoped package (@org/pkg), use that as the repo hint.
 * If the target starts with node_modules/, extract the package name.
 * Otherwise, assume same repo (returns "unknown").
 */
function inferTargetRepo(target: string): string | null {
  // Fast path: canonical ID carries repo inline
  const repo = extractRepo(target);
  if (repo) return repo;

  // node_modules/@org/pkg/... -> @org/pkg
  if (target.includes("node_modules/")) {
    const parts = target.split("node_modules/")[1]!.split("/");
    if (parts[0]!.startsWith("@") && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return parts[0]!;
  }

  // @org/pkg imports (scoped packages are cross-repo)
  if (target.startsWith("@")) {
    const parts = target.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
  }

  // Relative or local path — cannot determine target repo, assume same repo
  return null;
}
