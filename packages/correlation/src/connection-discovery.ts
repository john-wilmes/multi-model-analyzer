/**
 * Discover cross-repo connections after indexing a repo.
 *
 * Finds repos not yet indexed that are connected to the newly indexed repo via:
 * - Forward edges: the indexed repo imports/depends-on an unindexed repo's packages
 * - Reverse package deps: an unindexed repo's package.json lists packages published
 *   by the indexed repo
 */

import type { GraphStore } from "@mma/storage";
import type { PackageMap, RepoPackages } from "@mma/ingestion";
import { extractRepo } from "@mma/core";
import type { RepoStateManager } from "./repo-state.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A discovered connection between repos. */
export interface RepoConnection {
  /** The target repo that could be indexed next. */
  readonly repo: string;
  /** How this repo is connected. */
  readonly connectionType:
    | "imports"
    | "depends-on"
    | "reverse-import"
    | "reverse-depends-on";
  /** Number of edges (or package dep entries) forming this connection. */
  readonly edgeCount: number;
  /** The repo that has the edges pointing to/from the target. */
  readonly fromRepo: string;
}

/** Options for connection discovery. */
export interface ConnectionDiscoveryOptions {
  /** The repo that was just indexed. */
  readonly indexedRepo: string;
  /** Graph store with edges from all indexed repos. */
  readonly graphStore: GraphStore;
  /** Package map for resolving package names to repos. */
  readonly packageMap: PackageMap;
  /** State manager to check which repos are already indexed/ignored. */
  readonly stateManager: RepoStateManager;
  /** Pre-scanned package info for all repos (indexed and unindexed). */
  readonly allRepoPackages: readonly RepoPackages[];
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * After indexing a repo, discover connections to repos not yet indexed.
 *
 * Scans:
 * 1. Forward edges (imports/depends-on) from the indexed repo → find target repos
 * 2. Reverse package deps: for each unindexed repo in allRepoPackages, check
 *    whether its packages' dependencies include any package published by indexedRepo
 *
 * Filters out repos that are already indexed, indexing, or ignored.
 * Returns results sorted by edge count descending (most-connected first).
 */
export async function discoverConnections(
  options: ConnectionDiscoveryOptions,
): Promise<RepoConnection[]> {
  const { indexedRepo, graphStore, packageMap, stateManager, allRepoPackages } =
    options;

  // Accumulate connections: key = "<repo>:<connectionType>"
  const connectionMap = new Map<
    string,
    {
      repo: string;
      connectionType: RepoConnection["connectionType"];
      edgeCount: number;
      fromRepo: string;
    }
  >();

  function addConnection(
    repo: string,
    connectionType: RepoConnection["connectionType"],
    fromRepo: string,
  ): void {
    const mapKey = `${repo}:${connectionType}`;
    const existing = connectionMap.get(mapKey);
    if (existing) {
      existing.edgeCount++;
    } else {
      connectionMap.set(mapKey, { repo, connectionType, edgeCount: 1, fromRepo });
    }
  }

  // ------------------------------------------------------------------
  // 1. Forward: scan imports and depends-on edges FROM the indexed repo
  // ------------------------------------------------------------------
  for (const kind of ["imports", "depends-on"] as const) {
    const edges = await graphStore.getEdgesByKind(kind, indexedRepo);
    for (const edge of edges) {
      const targetRepo = resolveEdgeTargetRepo(edge.target, packageMap);
      if (targetRepo !== null && targetRepo !== indexedRepo) {
        addConnection(targetRepo, kind, indexedRepo);
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Reverse: find unindexed repos whose package deps include
  //    packages published by indexedRepo
  // ------------------------------------------------------------------
  const indexedRepoPackages = packageMap.repoToPackages.get(indexedRepo) ?? [];

  if (indexedRepoPackages.length > 0) {
    const publishedSet = new Set(indexedRepoPackages);

    for (const repoPackages of allRepoPackages) {
      if (repoPackages.repo === indexedRepo) continue;

      for (const pkg of repoPackages.packages) {
        // Check all three dependency kinds
        const depKinds: Array<{
          deps: readonly string[];
          connType: RepoConnection["connectionType"];
        }> = [
          { deps: pkg.dependencies, connType: "reverse-import" },
          { deps: pkg.devDependencies, connType: "reverse-depends-on" },
          { deps: pkg.peerDependencies, connType: "reverse-depends-on" },
        ];

        for (const { deps, connType } of depKinds) {
          for (const dep of deps) {
            if (publishedSet.has(dep)) {
              addConnection(repoPackages.repo, connType, indexedRepo);
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Filter out repos that are already indexed, indexing, or ignored
  // ------------------------------------------------------------------
  const results: RepoConnection[] = [];

  for (const conn of connectionMap.values()) {
    const state = await stateManager.get(conn.repo);
    if (
      state !== undefined &&
      (state.status === "indexed" ||
        state.status === "ignored" ||
        state.status === "indexing")
    ) {
      continue;
    }
    results.push(conn);
  }

  // Sort by edge count descending (most connected first)
  results.sort((a, b) => b.edgeCount - a.edgeCount);

  return results;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an edge target string to a repo name using the package map.
 * Returns null if the target cannot be resolved to a known repo.
 *
 * Strategy:
 * 1. Try extracting repo from canonical ID (`repo:path` format).
 * 2. Try matching as an npm package name against the package map.
 */
function resolveEdgeTargetRepo(
  target: string,
  packageMap: PackageMap,
): string | null {
  // 1. Canonical ID form: "repo:path/to/file"
  const repoFromId = extractRepo(target);
  if (repoFromId !== undefined) return repoFromId;

  // 2. npm package name
  const packageName = extractPackageName(target);
  if (packageName !== null) {
    const repo = packageMap.packageToRepo.get(packageName);
    if (repo !== undefined) return repo;
  }

  return null;
}

/**
 * Extract the npm package name from an import specifier.
 *
 * - Scoped:   `@org/pkg/deep/path` → `@org/pkg`
 * - Unscoped: `lodash/utils`       → `lodash`
 * - Relative, absolute, or protocol specifiers → null
 */
export function extractPackageName(target: string): string | null {
  // Relative or absolute paths are not package names
  if (target.startsWith(".") || target.startsWith("/")) return null;

  // URL-like protocols (node:, https:, npm:, bun:, jsr:, data:, …)
  if (/^[a-z][a-z0-9+\-.]*:/.test(target)) return null;

  if (target.startsWith("@")) {
    const parts = target.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }

  return target.split("/")[0] ?? null;
}
