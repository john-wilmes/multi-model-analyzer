/**
 * SARIF detection rules for cross-repo correlation analysis.
 */

import {
  type SarifResult,
  createSarifResult,
  createLogicalLocation,
} from "@mma/core";
import type { CrossRepoGraph, ServiceCorrelationResult } from "./types.js";

/**
 * Detect modules that are depended on by 3+ distinct repos.
 * A breaking change in such a module poses cross-repo risk.
 */
export function detectBreakingChangeRisk(
  graph: CrossRepoGraph,
): SarifResult[] {
  // Group edges by source module, collecting distinct target repos
  const sourceToTargetRepos = new Map<
    string,
    { sourceRepo: string; targetRepos: Set<string> }
  >();

  for (const resolved of graph.edges) {
    const source = resolved.edge.source;
    let entry = sourceToTargetRepos.get(source);
    if (!entry) {
      entry = { sourceRepo: resolved.sourceRepo, targetRepos: new Set() };
      sourceToTargetRepos.set(source, entry);
    }
    entry.targetRepos.add(resolved.targetRepo);
  }

  const results: SarifResult[] = [];

  for (const [moduleName, { sourceRepo, targetRepos }] of sourceToTargetRepos) {
    if (targetRepos.size < 3) continue;

    const location = {
      logicalLocations: [
        createLogicalLocation(sourceRepo, moduleName, undefined, "module"),
      ],
    };

    const relatedLocations = Array.from(targetRepos).map((repo) => ({
      logicalLocations: [
        createLogicalLocation(repo, repo, undefined, "repository"),
      ],
    }));

    results.push(
      createSarifResult(
        "cross-repo/breaking-change-risk",
        "warning",
        `Module "${moduleName}" in repo "${sourceRepo}" is depended on by ${targetRepos.size} repos. A breaking change would have wide cross-repo impact.`,
        {
          locations: [location],
          relatedLocations,
          properties: { dependentRepoCount: targetRepos.size },
        },
      ),
    );
  }

  return results;
}

/**
 * Detect services that have producers but no cross-repo consumers, or
 * consumers but no cross-repo producers.
 */
export function detectOrphanedServices(
  services: ServiceCorrelationResult,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const orphan of services.orphanedServices) {
    const repo = orphan.repos[0] ?? "unknown";

    let message: string;
    if (orphan.hasProducers && !orphan.hasConsumers) {
      message = `Service endpoint "${orphan.endpoint}" has producers but no cross-repo consumers. It may be unused externally.`;
    } else if (!orphan.hasProducers && orphan.hasConsumers) {
      message = `Service endpoint "${orphan.endpoint}" has cross-repo consumers but no known producers. The provider may be missing or unindexed.`;
    } else {
      message = `Service endpoint "${orphan.endpoint}" appears orphaned with no cross-repo producers or consumers.`;
    }

    const location = {
      logicalLocations: [
        createLogicalLocation(repo, orphan.endpoint, undefined, "service"),
      ],
    };

    results.push(
      createSarifResult("cross-repo/orphaned-service", "note", message, {
        locations: [location],
        properties: {
          hasProducers: orphan.hasProducers,
          hasConsumers: orphan.hasConsumers,
          repos: orphan.repos,
        },
      }),
    );
  }

  return results;
}

/**
 * Detect repos that sit on long dependency chains (>= 4 hops).
 * These are critical path nodes where failures cascade widely.
 */
export function detectCriticalPaths(graph: CrossRepoGraph): SarifResult[] {
  const results: SarifResult[] = [];

  // BFS from each repo to find the longest downstream chain length
  for (const [startRepo] of graph.downstreamMap) {
    const chain = longestChain(startRepo, graph.downstreamMap);
    if (chain.length < 4) continue;

    const location = {
      logicalLocations: [
        createLogicalLocation(startRepo, startRepo, undefined, "repository"),
      ],
    };

    const relatedLocations = chain.slice(1).map((repo) => ({
      logicalLocations: [
        createLogicalLocation(repo, repo, undefined, "repository"),
      ],
    }));

    results.push(
      createSarifResult(
        "cross-repo/critical-path",
        "warning",
        `Repo "${startRepo}" is at the head of a dependency chain ${chain.length} hops long. Failures here cascade to ${chain.length - 1} downstream repos.`,
        {
          locations: [location],
          relatedLocations,
          properties: { chainLength: chain.length, chain },
        },
      ),
    );
  }

  return results;
}

/**
 * BFS to find the longest downstream chain starting from `start`.
 * Returns the chain as an ordered array of repo names.
 */
function longestChain(
  start: string,
  downstreamMap: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  // BFS tracking longest path — use DFS with memoization to find longest chain
  const memo = new Map<string, string[]>();

  function dfs(repo: string, visited: Set<string>): string[] {
    if (memo.has(repo)) return memo.get(repo)!;

    const downstream = downstreamMap.get(repo);
    if (!downstream || downstream.size === 0) return [repo];

    let best: string[] = [repo];
    for (const next of downstream) {
      if (visited.has(next)) continue; // avoid cycles
      visited.add(next);
      const sub = dfs(next, visited);
      visited.delete(next);
      if (sub.length + 1 > best.length) {
        best = [repo, ...sub];
      }
    }

    memo.set(repo, best);
    return best;
  }

  return dfs(start, new Set([start]));
}
