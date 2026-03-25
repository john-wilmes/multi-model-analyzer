/**
 * Builds a cross-repo dependency graph by resolving inter-repo edges
 * from the graph store.
 */

import { join } from "node:path";
import type { GraphStore } from "@mma/storage";
import { extractRepo } from "@mma/core";
import type { GraphEdge, RepoConfig } from "@mma/core";
import type { CrossRepoGraph, ResolvedCrossRepoEdge } from "./types.js";

/**
 * Extracts a package name from an edge target string.
 * - Scoped: `@org/auth/src/index.ts` → `@org/auth`
 * - Unscoped: `lodash/utils` → `lodash`
 * - Relative paths (starting with `.`) → null (skip)
 */
function extractPackageName(target: string): string | null {
  if (target.startsWith(".")) return null;

  if (target.startsWith("@")) {
    // Scoped package: first two path segments
    const parts = target.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }

  // Unscoped: first path segment
  return target.split("/")[0] ?? null;
}

/**
 * Finds which repo owns a given directory path by checking localPath prefix.
 * Falls back to mirrorDir/<repo.name>.git for repos without localPath.
 */
function findRepoForPath(
  dirPath: string,
  repos: readonly RepoConfig[],
  mirrorDir: string,
): string | null {
  for (const repo of repos) {
    const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
    if (dirPath === repoPath || dirPath.startsWith(repoPath + "/")) {
      return repo.name;
    }
  }
  return null;
}

/**
 * Resolves the target repo for a given edge.
 * Uses `edge.metadata.targetRepo` if present, otherwise looks up via packageRoots.
 */
function resolveTargetRepo(
  edge: GraphEdge,
  repos: readonly RepoConfig[],
  packageRoots: ReadonlyMap<string, string>,
  mirrorDir: string,
): { targetRepo: string; packageName: string } | null {
  // Skip non-repo specifiers (node:fs, https://..., npm:pkg, bun:test, jsr:@pkg)
  if (/^(?:node|https?|npm|bun|jsr|data):/.test(edge.target)) return null;

  // Fast path: canonical ID carries repo inline — verify it's a known repo
  const targetRepoFromId = extractRepo(edge.target);
  if (targetRepoFromId) {
    const isKnownRepo = repos.some((r) => r.name === targetRepoFromId);
    if (!isKnownRepo) return null;
    const packageName = extractPackageName(edge.target) ?? edge.target;
    return { targetRepo: targetRepoFromId, packageName };
  }

  // Fast path: explicit metadata
  if (typeof edge.metadata?.["targetRepo"] === "string") {
    const targetRepo = edge.metadata["targetRepo"];
    const packageName = extractPackageName(edge.target) ?? edge.target;
    return { targetRepo, packageName };
  }

  // Slow path: resolve via packageRoots
  const packageName = extractPackageName(edge.target);
  if (!packageName) return null;

  const dirPath = packageRoots.get(packageName);
  if (!dirPath) return null;

  const targetRepo = findRepoForPath(dirPath, repos, mirrorDir);
  if (!targetRepo) return null;

  return { targetRepo, packageName };
}

/**
 * Builds a cross-repo dependency graph from the graph store.
 *
 * For each repo, loads `imports` and `depends-on` edges, resolves which
 * target edges point to other repos, and assembles the full graph.
 */
export async function buildCrossRepoGraph(
  graphStore: GraphStore,
  repos: readonly RepoConfig[],
  packageRoots: ReadonlyMap<string, string>,
  mirrorDir: string,
): Promise<CrossRepoGraph> {
  const resolvedEdges: ResolvedCrossRepoEdge[] = [];
  const repoPairs = new Set<string>();
  const downstreamMap = new Map<string, Set<string>>();
  const upstreamMap = new Map<string, Set<string>>();

  for (const repo of repos) {
    // Load both relevant edge kinds for this repo
    const [importEdges, dependsOnEdges] = await Promise.all([
      graphStore.getEdgesByKind("imports", repo.name),
      graphStore.getEdgesByKind("depends-on", repo.name),
    ]);

    const edges = [...importEdges, ...dependsOnEdges];

    for (const edge of edges) {
      const resolution = resolveTargetRepo(edge, repos, packageRoots, mirrorDir);
      if (!resolution) continue;

      const { targetRepo, packageName } = resolution;
      const sourceRepo = repo.name;

      // Skip self-edges
      if (sourceRepo === targetRepo) continue;

      resolvedEdges.push({ edge, sourceRepo, targetRepo, packageName });

      const pairKey = `${sourceRepo}->${targetRepo}`;
      repoPairs.add(pairKey);

      // Update downstream map: sourceRepo depends on targetRepo
      if (!downstreamMap.has(sourceRepo)) {
        downstreamMap.set(sourceRepo, new Set());
      }
      downstreamMap.get(sourceRepo)!.add(targetRepo);

      // Update upstream map: targetRepo is depended upon by sourceRepo
      if (!upstreamMap.has(targetRepo)) {
        upstreamMap.set(targetRepo, new Set());
      }
      upstreamMap.get(targetRepo)!.add(sourceRepo);
    }
  }

  return {
    edges: resolvedEdges,
    repoPairs,
    downstreamMap,
    upstreamMap,
  };
}
