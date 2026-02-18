/**
 * CLI command: index repos.
 *
 * Runs the full indexing pipeline: ingestion -> parsing -> structural ->
 * heuristics -> summarization -> storage.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  RepoConfig,
  ChangeSet,
  DependencyGraph,
  ParsedFile,
  InferredService,
  DetectedPattern,
  FlagInventory,
  LogTemplateIndex,
  MethodPurposeMap,
  SymbolInfo,
} from "@mma/core";
import { detectChanges, classifyFiles } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { extractDependencyGraph } from "@mma/structural";
import {
  inferServices,
  detectPatterns,
  scanForFlags,
  extractLogStatements,
  analyzeNaming,
} from "@mma/heuristics";
import type { PackageJsonInfo } from "@mma/heuristics";
import type { KVStore, GraphStore } from "@mma/storage";

export interface IndexOptions {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly verbose: boolean;
  readonly enableTsMorph?: boolean;
}

export async function indexCommand(options: IndexOptions): Promise<void> {
  const { repos, mirrorDir, kvStore, verbose } = options;

  const log = verbose ? console.log : () => {};

  log(`Indexing ${repos.length} repositories...`);

  // Load previous commit hashes
  const previousCommits = new Map<string, string>();
  for (const repo of repos) {
    const prev = await kvStore.get(`commit:${repo.name}`);
    if (prev) previousCommits.set(repo.name, prev);
  }

  // Phase 1: Ingestion
  log("Phase 1: Detecting changes...");
  const changeSets: ChangeSet[] = [];
  for (const repo of repos) {
    try {
      const changeSet = await detectChanges(repo, {
        mirrorDir,
        previousCommits,
      });
      changeSets.push(changeSet);
      log(`  ${repo.name}: ${changeSet.addedFiles.length} added, ${changeSet.modifiedFiles.length} modified, ${changeSet.deletedFiles.length} deleted`);
    } catch (error) {
      console.error(`  Failed to index ${repo.name}:`, error);
    }
  }

  // Phase 2: Classify files
  log("Phase 2: Classifying files...");
  const classifiedByRepo = new Map<string, ReturnType<typeof classifyFiles>>();
  for (const changeSet of changeSets) {
    const classified = classifyFiles(changeSet);
    classifiedByRepo.set(changeSet.repo, classified);
    log(`  ${changeSet.repo}: ${classified.length} files classified`);
  }

  // Phase 3: Parsing
  log("Phase 3: Parsing files...");
  const treesByRepo = new Map<string, ReadonlyMap<string, TreeSitterTree>>();
  const parsedFilesByRepo = new Map<string, ParsedFile[]>();
  for (const repo of repos) {
    const classified = classifiedByRepo.get(repo.name);
    if (!classified || classified.length === 0) continue;

    try {
      const result = await parseFiles(classified, repo.name, repo.localPath, {
        enableTsMorph: options.enableTsMorph,
        onProgress: verbose
          ? (info) => {
              if (info.current === 1 || info.current % 100 === 0 || info.current === info.total) {
                log(`  [${info.phase}] ${info.current}/${info.total}`);
              }
            }
          : undefined,
      });

      log(`  ${repo.name}: ${result.stats.fileCount} files, ${result.stats.symbolCount} symbols, ${result.stats.errorCount} errors`);
      log(`    tree-sitter: ${result.stats.treeSitterTimeMs}ms, ts-morph: ${result.stats.tsMorphTimeMs}ms`);

      treesByRepo.set(repo.name, result.treeSitterTrees);
      parsedFilesByRepo.set(repo.name, result.parsedFiles);
    } catch (error) {
      console.error(`  Failed to parse ${repo.name}:`, error);
    }
  }

  // Phase 4: Dependency graph extraction
  log("Phase 4: Extracting dependency graphs...");
  const depGraphByRepo = new Map<string, DependencyGraph>();
  for (const repo of repos) {
    const trees = treesByRepo.get(repo.name);
    if (!trees || trees.size === 0) continue;

    try {
      const start = performance.now();
      const graph = extractDependencyGraph(trees, repo.name, { detectCircular: true });
      const elapsed = Math.round(performance.now() - start);

      depGraphByRepo.set(repo.name, graph);
      await options.graphStore.addEdges(graph.edges);

      log(`  ${repo.name}: ${graph.edges.length} import edges (${elapsed}ms)`);
      if (graph.circularDependencies.length > 0) {
        log(`    ${graph.circularDependencies.length} circular dependencies found`);
        for (const cycle of graph.circularDependencies.slice(0, 5)) {
          log(`      ${cycle.join(" -> ")}`);
        }
        if (graph.circularDependencies.length > 5) {
          log(`      ... and ${graph.circularDependencies.length - 5} more`);
        }
      }
    } catch (error) {
      console.error(`  Failed to extract dependency graph for ${repo.name}:`, error);
    }
  }

  // Phase 5: Heuristic analysis
  log("Phase 5: Running heuristics...");
  const servicesByRepo = new Map<string, InferredService[]>();
  const patternsByRepo = new Map<string, DetectedPattern[]>();
  const flagsByRepo = new Map<string, FlagInventory>();
  const logIndexByRepo = new Map<string, LogTemplateIndex>();
  const namingByRepo = new Map<string, MethodPurposeMap>();

  for (const repo of repos) {
    const classified = classifiedByRepo.get(repo.name);
    const depGraph = depGraphByRepo.get(repo.name);
    const trees = treesByRepo.get(repo.name);
    const parsedFiles = parsedFilesByRepo.get(repo.name);
    if (!classified || !depGraph) continue;

    try {
      // 5a: Service inference
      const packageJsonFiles = classified.filter(
        (f) => f.kind === "json" && f.path.endsWith("package.json"),
      );

      const packageJsons = new Map<string, PackageJsonInfo>();
      for (const pjFile of packageJsonFiles) {
        try {
          const absPath = join(repo.localPath, pjFile.path);
          const raw = await readFile(absPath, "utf-8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          packageJsons.set(dirname(pjFile.path), {
            name: (parsed.name as string) ?? "",
            main: parsed.main as string | undefined,
            bin: (parsed.bin as Record<string, string>) ?? undefined,
            dependencies: (parsed.dependencies as Record<string, string>) ?? {},
            scripts: (parsed.scripts as Record<string, string>) ?? {},
          });
        } catch {
          // Skip unreadable package.json files
        }
      }

      const filePaths = classified.map((f) => f.path);
      const services = inferServices({
        repo: repo.name,
        filePaths,
        packageJsons,
        dependencyGraph: depGraph,
      });
      servicesByRepo.set(repo.name, services);

      log(`  ${repo.name}: ${services.length} services inferred, ${packageJsons.size} package.json files`);
      for (const svc of services.slice(0, 10)) {
        log(`    ${svc.name} (${svc.rootPath}) confidence=${svc.confidence} deps=${svc.dependencies.length}`);
      }
      if (services.length > 10) {
        log(`    ... and ${services.length - 10} more`);
      }

      // Build intermediate maps for remaining heuristics
      const symbolsByFile = new Map<string, readonly SymbolInfo[]>();
      if (parsedFiles) {
        for (const pf of parsedFiles) {
          symbolsByFile.set(pf.path, pf.symbols);
        }
      }

      const importsByFile = new Map<string, readonly string[]>();
      for (const edge of depGraph.edges) {
        const existing = importsByFile.get(edge.source);
        if (existing) {
          importsByFile.set(edge.source, [...existing, edge.target]);
        } else {
          importsByFile.set(edge.source, [edge.target]);
        }
      }

      // 5b: Pattern detection
      const patterns = detectPatterns({
        repo: repo.name,
        symbols: symbolsByFile,
        imports: importsByFile,
      });
      patternsByRepo.set(repo.name, patterns);
      log(`  ${repo.name}: ${patterns.length} patterns detected`);

      // 5c: Feature flag scanning
      if (trees && trees.size > 0) {
        const flagInventory = scanForFlags(trees, repo.name);
        flagsByRepo.set(repo.name, flagInventory);
        log(`  ${repo.name}: ${flagInventory.flags.length} feature flags found`);

        // 5d: Log statement extraction
        const logIndex = extractLogStatements(trees, repo.name);
        logIndexByRepo.set(repo.name, logIndex);
        log(`  ${repo.name}: ${logIndex.templates.length} log templates extracted`);
      }

      // 5e: Naming analysis
      if (symbolsByFile.size > 0) {
        const namingResult = analyzeNaming(symbolsByFile, repo.name);
        namingByRepo.set(repo.name, namingResult);
        log(`  ${repo.name}: ${namingResult.methods.length} method purposes inferred`);
      }
    } catch (error) {
      console.error(`  Failed to run heuristics for ${repo.name}:`, error);
    }
  }

  // Phase 6-7: summarization, models (still stubbed)
  log("Phase 6-7: Summarization and model generation (stubbed)");

  // Save commit hashes
  for (const changeSet of changeSets) {
    await kvStore.set(`commit:${changeSet.repo}`, changeSet.commitHash);
  }

  log("Indexing complete.");
}
