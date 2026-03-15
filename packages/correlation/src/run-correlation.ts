/**
 * Top-level correlation orchestrator.
 *
 * Runs all correlation passes (cross-repo graph, service correlation, SARIF rules),
 * persists results to KV store, and returns a CorrelationResult summary.
 */

import type { KVStore, GraphStore } from "@mma/storage";
import type { CorrelationOptions, CorrelationResult } from "./types.js";
import { buildCrossRepoGraph } from "./graph-builder.js";
import { buildServiceCorrelation } from "./service-correlation.js";
import {
  detectBreakingChangeRisk,
  detectOrphanedServices,
  detectCriticalPaths,
} from "./sarif-rules.js";

/**
 * Run all correlation analyses and persist results to KV store.
 */
export async function runCorrelation(
  kvStore: KVStore,
  graphStore: GraphStore,
  options: CorrelationOptions,
): Promise<CorrelationResult> {
  const { repos, packageRoots, verbose } = options;

  // 1. Build cross-repo dependency graph
  const crossRepoGraph = await buildCrossRepoGraph(graphStore, repos, packageRoots);

  // 2. Build service correlation
  const serviceCorrelation = await buildServiceCorrelation(graphStore, repos);

  // 3. Run SARIF detectors
  const breakingRisk = detectBreakingChangeRisk(crossRepoGraph);
  const orphaned = detectOrphanedServices(serviceCorrelation);
  const criticalPaths = detectCriticalPaths(crossRepoGraph);
  const sarifResults = [...breakingRisk, ...orphaned, ...criticalPaths];

  // 4. Persist to KV store
  await kvStore.set(
    "correlation:graph",
    JSON.stringify({
      edges: crossRepoGraph.edges,
      repoPairs: [...crossRepoGraph.repoPairs],
      downstreamMap: [...crossRepoGraph.downstreamMap.entries()].map(([k, v]) => [k, [...v]]),
      upstreamMap: [...crossRepoGraph.upstreamMap.entries()].map(([k, v]) => [k, [...v]]),
    }),
  );

  await kvStore.set(
    "correlation:services",
    JSON.stringify({
      links: serviceCorrelation.links.map((l) => ({
        endpoint: l.endpoint,
        producers: [...l.producers.entries()].map(([k, v]) => [k, v]),
        consumers: [...l.consumers.entries()].map(([k, v]) => [k, v]),
        linkedRepos: [...l.linkedRepos],
      })),
      linchpins: serviceCorrelation.linchpins,
      orphanedServices: serviceCorrelation.orphanedServices,
    }),
  );

  await kvStore.set("sarif:correlation", JSON.stringify(sarifResults));

  // 5. Counts
  const counts = {
    crossRepoEdges: crossRepoGraph.edges.length,
    repoPairs: crossRepoGraph.repoPairs.size,
    linchpins: serviceCorrelation.linchpins.length,
    orphanedServices: serviceCorrelation.orphanedServices.length,
    sarifFindings: sarifResults.length,
  };

  if (verbose) {
    console.log(
      `[correlation] cross-repo edges=${counts.crossRepoEdges} repoPairs=${counts.repoPairs}` +
      ` linchpins=${counts.linchpins} orphaned=${counts.orphanedServices}` +
      ` sarif=${counts.sarifFindings}`,
    );
  }

  return {
    crossRepoGraph,
    serviceCorrelation,
    sarifResults,
    counts,
  };
}
