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
  // Group edges by target module (the exported module being depended on),
  // collecting distinct source repos (the repos that import it).
  const targetToSourceRepos = new Map<
    string,
    { targetRepo: string; dependentRepos: Set<string> }
  >();

  for (const resolved of graph.edges) {
    const target = resolved.edge.target;
    let entry = targetToSourceRepos.get(target);
    if (!entry) {
      entry = { targetRepo: resolved.targetRepo, dependentRepos: new Set() };
      targetToSourceRepos.set(target, entry);
    }
    entry.dependentRepos.add(resolved.sourceRepo);
  }

  const results: SarifResult[] = [];

  for (const [moduleName, { targetRepo, dependentRepos }] of targetToSourceRepos) {
    if (dependentRepos.size < 3) continue;

    const location = {
      logicalLocations: [
        createLogicalLocation(targetRepo, moduleName, undefined, "module"),
      ],
    };

    const relatedLocations = Array.from(dependentRepos).map((repo) => ({
      logicalLocations: [
        createLogicalLocation(repo, repo, undefined, "repository"),
      ],
    }));

    results.push(
      createSarifResult(
        "cross-repo/breaking-change-risk",
        "warning",
        `Module "${moduleName}" in repo "${targetRepo}" is depended on by ${dependentRepos.size} repos. A breaking change would have wide cross-repo impact.`,
        {
          locations: [location],
          relatedLocations,
          properties: { dependentRepoCount: dependentRepos.size },
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
/**
 * Returns true for endpoints that cannot be meaningfully resolved statically:
 * template literals, localhost dev URLs, or synthetic placeholders.
 */
function isTemplateOrDevEndpoint(endpoint: string): boolean {
  if (endpoint.includes("${")) return true;
  if (endpoint.startsWith("http://localhost")) return true;
  if (endpoint === "external-api") return true;
  return false;
}

export function detectOrphanedServices(
  services: ServiceCorrelationResult,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const orphan of services.orphanedServices) {
    // Skip template URLs, localhost dev endpoints, and synthetic placeholders —
    // these cannot be resolved statically and produce noise.
    if (isTemplateOrDevEndpoint(orphan.endpoint)) continue;
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
 * DFS to find the longest downstream chain starting from `start`.
 * Returns the chain as an ordered array of repo names.
 *
 * No memoization: results depend on which nodes are already in the `visited`
 * set, so caching results keyed only by node is incorrect on graphs with
 * shared intermediate nodes.
 */
function longestChain(
  start: string,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  function dfs(node: string, visited: ReadonlySet<string>): string[] {
    const neighbors = graph.get(node) ?? new Set<string>();
    let best: string[] = [];
    for (const n of neighbors) {
      if (visited.has(n)) continue;
      const newVisited = new Set(visited);
      newVisited.add(n);
      const chain = dfs(n, newVisited);
      if (chain.length > best.length) best = chain;
    }
    return [node, ...best];
  }
  return dfs(start, new Set([start]));
}
