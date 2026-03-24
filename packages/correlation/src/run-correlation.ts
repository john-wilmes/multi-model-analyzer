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
  const INDEX_RE = /(?:^|[/\\])index\.[jt]sx?$/;
  for (const repo of repos) {
    const raw = await kvStore.get(`barrelFiles:${repo.name}`);
    const paths = raw ? (JSON.parse(raw) as string[]) : [];
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
    // Also track non-pure index files that have outgoing import edges.
    // These may re-export from sub-modules even if isBarrelFile() rejects them
    // (e.g. an index.ts with both `export * from '...'` and `export const ...`).
    const seen = new Set<string>();
    for (const edge of importEdges) {
      if (seen.has(edge.source) || barrelSourceMap.has(edge.source)) continue;
      seen.add(edge.source);
      const sourcePath = edge.source.slice(repo.name.length + 1);
      if (INDEX_RE.test(sourcePath)) {
        const sources = importEdges
          .filter((e) => e.source === edge.source)
          .map((e) => e.target);
        if (sources.length > 0) {
          barrelSourceMap.set(edge.source, sources);
        }
      }
    }
  }
  // Expand transitive re-export chains in barrelSourceMap.
  // If barrel A -> [B, C] and B -> [D, E], then A -> [B, C, D, E].
  {
    let changed = true;
    let depth = 0;
    while (changed && depth < 5) {
      changed = false;
      depth++;
      for (const [fileId, sources] of barrelSourceMap) {
        const expanded = new Set(sources);
        const before = expanded.size;
        for (const src of sources) {
          const transitive = barrelSourceMap.get(src);
          if (transitive) {
            for (const t of transitive) expanded.add(t);
          }
        }
        if (expanded.size > before) {
          barrelSourceMap.set(fileId, [...expanded]);
          changed = true;
        }
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

  // Fallback: for packages with no barrel entries, look for common entry points in exportIndex.
  for (const [pkgName, dirPath] of packageRoots.entries()) {
    if (packageEntryMap.has(pkgName)) continue;
    // Find which repo owns this package
    const repo = repos.find((r) => dirPath === r.localPath || dirPath.startsWith(r.localPath + "/"));
    if (!repo) continue;
    const relPrefix = dirPath === repo.localPath ? "" : dirPath.slice(repo.localPath.length + 1) + "/";
    const candidatePaths = ["src/index.ts", "index.ts", "src/index.tsx", "index.tsx", "src/index.js", "index.js"];
    const entryIds: string[] = [];
    for (const cp of candidatePaths) {
      const fileId = makeFileId(repo.name, relPrefix + cp);
      if (exportIndex.has(fileId) || barrelSourceMap.has(fileId)) {
        entryIds.push(fileId);
      }
    }
    if (entryIds.length > 0) {
      packageEntryMap.set(pkgName, entryIds);
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
