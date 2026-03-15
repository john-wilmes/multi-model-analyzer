/**
 * Path discovery utilities for cross-repo dependency graphs.
 */

import type { CrossRepoGraph, DependencyPath } from "./types.js";

/**
 * Find all shortest dependency paths from sourceRepo to targetRepo using BFS.
 *
 * Returns all paths of minimum length. If no path exists or source === target,
 * returns an empty array.
 */
export function findDependencyPaths(
  sourceRepo: string,
  targetRepo: string,
  graph: CrossRepoGraph,
): DependencyPath[] {
  if (sourceRepo === targetRepo) {
    return [];
  }

  // BFS to find shortest-path distance, tracking all parents at each level
  // so we can reconstruct all shortest paths.
  const parents = new Map<string, Set<string>>();
  const visited = new Set<string>();
  let frontier = [sourceRepo];
  visited.add(sourceRepo);
  let found = false;

  while (frontier.length > 0 && !found) {
    const nextFrontier: string[] = [];

    for (const node of frontier) {
      const neighbors = graph.downstreamMap.get(node) ?? new Set<string>();
      for (const neighbor of neighbors) {
        if (neighbor === targetRepo) {
          // Record parent even if already "found" on this level — another path
          // of the same length may reach targetRepo from a different node.
          if (!parents.has(neighbor)) {
            parents.set(neighbor, new Set());
          }
          parents.get(neighbor)!.add(node);
          found = true;
        } else if (!visited.has(neighbor)) {
          visited.add(neighbor);
          if (!parents.has(neighbor)) {
            parents.set(neighbor, new Set());
          }
          parents.get(neighbor)!.add(node);
          nextFrontier.push(neighbor);
        } else if (parents.has(neighbor)) {
          // Neighbor already enqueued at this BFS level — record the additional
          // parent without re-enqueuing, so all shortest paths through it are
          // reconstructed during backtracking.
          parents.get(neighbor)!.add(node);
        }
      }
    }

    frontier = nextFrontier;
  }

  if (!found) {
    return [];
  }

  // Reconstruct all shortest paths by back-tracking from targetRepo.
  const paths: string[][] = [];

  function backtrack(node: string, path: string[]): void {
    path.unshift(node);
    if (node === sourceRepo) {
      paths.push([...path]);
    } else {
      const nodeParents = parents.get(node);
      if (nodeParents) {
        for (const parent of nodeParents) {
          backtrack(parent, path);
        }
      }
    }
    path.shift();
  }

  backtrack(targetRepo, []);

  return paths.map((nodes) => ({
    nodes,
    boundaryCount: nodes.length - 1,
  }));
}
