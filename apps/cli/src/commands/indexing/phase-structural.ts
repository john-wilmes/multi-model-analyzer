/**
 * Phase 4a-4b: Dependency graph, call graph, heritage edges extraction.
 * Also saves commit hash after graph extraction.
 */

import { join } from "node:path";
import type { RepoConfig } from "@mma/core";
import type { classifyFiles } from "@mma/ingestion";
import { isExcludedPath } from "@mma/ingestion";
import {
  extractDependencyGraph,
  extractCallEdgesFromTreeSitter,
  extractHeritageEdges,
  tagBarrelMediatedCycles,
  getBarrelPaths,
} from "@mma/structural";
import type { TsNode } from "@mma/structural";
import type { PipelineContext } from "./types.js";

export async function runPhaseStructural(
  ctx: PipelineContext,
  repo: RepoConfig,
  classified: ReturnType<typeof classifyFiles>,
): Promise<void> {
  const { log, mirrorDir, kvStore, graphStore, options, changeSets, packageRoots, treesByRepo } = ctx;
  const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
  const trees = treesByRepo.get(repo.name);

  const changedFilePaths = classified.map(f => f.path);

  // Clean up all edge kinds for changed files before any edges are added.
  // This is idempotent: if a prior run failed mid-phase, re-running will clean
  // up any partial state before re-inserting. Covers imports, calls, extends,
  // and implements edges all at once.
  if (!options.forceFullReindex && changedFilePaths.length > 0) {
    await graphStore.deleteEdgesForFiles(repo.name, changedFilePaths);
  }

  // --- Phase 4a: Dependency graph extraction ---
  if (trees && trees.size > 0) {
    log(`  [${repo.name}] Extracting dependency graph...`);
    try {
      const start = performance.now();
      const graph = extractDependencyGraph(trees, repo.name, { detectCircular: true }, packageRoots, repoPath);
      const elapsed = Math.round(performance.now() - start);

      ctx.depGraphByRepo.set(repo.name, graph);
      if (options.forceFullReindex) {
        await graphStore.clear(repo.name);
        // Remove KV entries for files that are now excluded (e.g. dist/ files
        // that were previously indexed but should no longer be).
        const symbolKeys = await kvStore.getByPrefix(`symbols:${repo.name}:`);
        const prefixLen = `symbols:${repo.name}:`.length;
        const excludedFilePaths: string[] = [];
        for (const key of symbolKeys.keys()) {
          const filePath = key.slice(prefixLen);
          if (isExcludedPath(filePath)) {
            excludedFilePaths.push(filePath);
          }
        }
        if (excludedFilePaths.length > 0) {
          const keysToDelete: string[] = [];
          for (const filePath of excludedFilePaths) {
            keysToDelete.push(`symbols:${repo.name}:${filePath}`);
          }
          await Promise.all(keysToDelete.map((k) => kvStore.delete(k)));
          await Promise.all(excludedFilePaths.flatMap((filePath) => [
            kvStore.deleteByPrefix(`summary:t1:${repo.name}:${filePath}:`),
            kvStore.deleteByPrefix(`summary:t3:${repo.name}:${filePath}#`),
          ]));
          log(`  [${repo.name}] Removed KV entries for ${excludedFilePaths.length} excluded files`);
        }
      }
      await graphStore.addEdges(graph.edges);

      log(`  [${repo.name}] ${graph.edges.length} import edges (${elapsed}ms)`);
      if (graph.edges.length === 0) {
        log(`    warning: 0 import edges from ${trees.size} trees -- pattern and flag detection may be limited`);
      }
      // Tag barrel-mediated cycles
      const annotated = tagBarrelMediatedCycles(graph.circularDependencies, trees, repo.name);
      let mergedCycles = graph.circularDependencies;
      let mergedBarrelFlags = annotated.map((a) => a.barrelMediated);
      // Incremental mode: keep cached cycles that don't touch any changed file
      if (!options.forceFullReindex) {
        const changedSet = new Set(changedFilePaths);
        const cachedCyclesJson = await kvStore.get(`circularDeps:${repo.name}`);
        const cachedBarrelJson = await kvStore.get(`circularDepsBarrel:${repo.name}`);
        if (cachedCyclesJson) {
          try {
            const cachedCycles = JSON.parse(cachedCyclesJson) as string[][];
            const cachedBarrels = cachedBarrelJson ? (JSON.parse(cachedBarrelJson) as boolean[]) : [];
            const keptCycles: string[][] = [];
            const keptBarrels: boolean[] = [];
            for (let ci = 0; ci < cachedCycles.length; ci++) {
              if (!cachedCycles[ci]!.some((p) => changedSet.has(p))) {
                keptCycles.push(cachedCycles[ci]!);
                keptBarrels.push(cachedBarrels[ci] ?? false);
              }
            }
            mergedCycles = [...keptCycles, ...graph.circularDependencies];
            mergedBarrelFlags = [...keptBarrels, ...annotated.map((a) => a.barrelMediated)];
          } catch { /* skip malformed cache */ }
        }
      }
      await kvStore.set(`circularDeps:${repo.name}`, JSON.stringify(mergedCycles));
      await kvStore.set(`circularDepsBarrel:${repo.name}`, JSON.stringify(mergedBarrelFlags));
      // Persist barrel file paths for cross-repo symbol resolution.
      const barrelKey = `barrelFiles:${repo.name}`;
      const newBarrels = getBarrelPaths(trees);
      if (options.forceFullReindex) {
        if (newBarrels.length > 0) {
          await kvStore.set(barrelKey, JSON.stringify(newBarrels));
        } else {
          await kvStore.delete(barrelKey);
        }
      } else {
        // Incremental: merge with previous barrel set. Keep barrels from the
        // previous run that were not re-parsed, and add newly detected ones.
        const prev = await kvStore.get(barrelKey);
        const existing = prev ? (JSON.parse(prev) as string[]) : [];
        const parsedPaths = new Set(trees.keys());
        const deletedFilePaths = new Set(changeSets.find(c => c.repo === repo.name)?.deletedFiles ?? []);
        const merged = existing.filter((p) => !parsedPaths.has(p) && !deletedFilePaths.has(p));
        merged.push(...newBarrels);
        if (merged.length > 0) {
          await kvStore.set(barrelKey, JSON.stringify(merged));
        } else {
          await kvStore.delete(barrelKey);
        }
      }
      if (mergedCycles.length > 0) {
        const barrelCount = mergedBarrelFlags.filter(Boolean).length;
        log(`    ${mergedCycles.length} circular dependencies found (${barrelCount} barrel-mediated)`);
        for (const cycle of mergedCycles.slice(0, 5)) {
          log(`      ${cycle.join(" -> ")}`);
        }
        if (mergedCycles.length > 5) {
          log(`      ... and ${mergedCycles.length - 5} more`);
        }
      }
    } catch (error) {
      console.error(`  Failed to extract dependency graph for ${repo.name}:`, error);
    }
  }

  // --- Phase 4b: Call graph extraction ---
  if (trees && trees.size > 0) {
    log(`  [${repo.name}] Extracting call graph...`);
    try {
      const start = performance.now();
      const callEdges: import("@mma/core").GraphEdge[] = [];

      for (const [filePath, tree] of trees) {
        const edges = extractCallEdgesFromTreeSitter(
          tree.rootNode as TsNode,
          filePath,
          repo.name,
        );
        callEdges.push(...edges);
      }

      if (callEdges.length > 0) {
        await graphStore.addEdges(callEdges);
      }

      const elapsed = Math.round(performance.now() - start);
      log(`  [${repo.name}] ${callEdges.length} call edges (${elapsed}ms)`);
    } catch (error) {
      console.error(`  Failed to extract call graph for ${repo.name}:`, error);
    }
  }

  if (trees && trees.size > 0) {
    log(`  [${repo.name}] Extracting heritage edges...`);
    try {
      const start = performance.now();
      const heritageEdges = extractHeritageEdges(trees, repo.name);

      if (heritageEdges.length > 0) {
        await graphStore.addEdges(heritageEdges);
      }

      const elapsed = Math.round(performance.now() - start);
      log(`  [${repo.name}] ${heritageEdges.length} heritage edges (extends/implements) (${elapsed}ms)`);
    } catch (error) {
      console.error(`  Failed to extract heritage edges for ${repo.name}:`, error);
    }
  }

  // Save commit hash after graph extraction completes (Phases 3-4b done).
  // Clear pipelineComplete so a Phase 5+ failure triggers recovery next run.
  const repoChangeSet = changeSets.find(cs => cs.repo === repo.name);
  if (repoChangeSet) {
    await kvStore.delete(`pipelineComplete:${repo.name}`);
    await kvStore.set(`commit:${repo.name}`, repoChangeSet.commitHash);
  }
  // Reconstruct full depGraph from graph store (incremental: changed + unchanged edges)
  if (!options.forceFullReindex) {
    const fullImportEdges = await graphStore.getEdgesByKind("imports", repo.name);
    ctx.depGraphByRepo.set(repo.name, { repo: repo.name, edges: fullImportEdges, circularDependencies: [] });
  }
}
