/**
 * Top-level correlation orchestrator.
 *
 * Runs all correlation passes (cross-repo graph, service correlation, SARIF rules),
 * persists results to KV store, and returns a CorrelationResult summary.
 *
 * @see symbol-resolver.ts for cross-repo symbol resolution logic.
 */

import type { KVStore, GraphStore } from "@mma/storage";
import { makeFileId } from "@mma/core";
import type { CorrelationOptions, CorrelationResult } from "./types.js";
import { buildCrossRepoGraph } from "./graph-builder.js";
import { buildServiceCorrelation } from "./service-correlation.js";
import {
  detectBreakingChangeRisk,
  detectOrphanedServices,
  detectCriticalPaths,
} from "./sarif-rules.js";
import { buildExportIndex, resolveSymbolsOnEdges } from "./symbol-resolver.js";
import type { PackageEntryMap } from "./symbol-resolver.js";

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

  // 1b. Resolve imported symbol names on cross-repo edges.
  const exportIndex = await buildExportIndex(kvStore, repos);
  // Build barrel source map: barrelFileId -> file IDs the barrel re-exports from.
  const barrelSourceMap = new Map<string, string[]>();
  const repoBarrelPaths = new Map<string, string[]>();
  for (const repo of repos) {
    const raw = await kvStore.get(`barrelFiles:${repo.name}`);
    if (!raw) continue;
    const paths = JSON.parse(raw) as string[];
    repoBarrelPaths.set(repo.name, paths);
    // Load import edges for this repo once to avoid O(barrels * edges) queries.
    const importEdges = await graphStore.getEdgesByKind("imports", repo.name);
    for (const p of paths) {
      const fileId = makeFileId(repo.name, p);
      const sources = importEdges
        .filter((e) => e.source === fileId)
        .map((e) => e.target);
      if (sources.length > 0) {
        barrelSourceMap.set(fileId, sources);
      }
    }
  }
  // Build packageEntryMap: npm package name -> candidate entry file IDs.
  // Uses barrel files as entry points for each package; packageRoots maps
  // npm name -> absolute dir, so we invert to find which repo owns each package.
  const packageEntryMap: PackageEntryMap = new Map();
  for (const repo of repos) {
    const barrels = repoBarrelPaths.get(repo.name);
    if (!barrels) continue;
    // For each package name that resolves to this repo's directory, register barrel fileIds.
    for (const [pkgName, dirPath] of packageRoots.entries()) {
      if (dirPath === repo.localPath || dirPath.startsWith(repo.localPath + "/")) {
        // Compute the relative prefix for this package within the repo
        const relPrefix = dirPath === repo.localPath ? "" : dirPath.slice(repo.localPath.length + 1) + "/";
        const entryIds = barrels
          .filter((b) => relPrefix === "" || b.startsWith(relPrefix))
          .map((b) => makeFileId(repo.name, b));
        if (entryIds.length > 0) {
          const existing = packageEntryMap.get(pkgName) ?? [];
          packageEntryMap.set(pkgName, [...existing, ...entryIds]);
        }
      }
    }
  }

  const resolvedCount = resolveSymbolsOnEdges(
    crossRepoGraph.edges as import("./types.js").ResolvedCrossRepoEdge[],
    exportIndex,
    barrelSourceMap,
    packageEntryMap,
  );
  if (verbose && resolvedCount > 0) {
    console.log(`[correlation] resolved ${resolvedCount} cross-repo symbol bindings`);
  }

  // 2. Build service correlation (pass cross-repo graph for package linchpin detection)
  const serviceCorrelation = await buildServiceCorrelation(graphStore, repos, crossRepoGraph);

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
      packageLinchpins: serviceCorrelation.packageLinchpins,
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
