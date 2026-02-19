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
  Summary,
  ControlFlowGraph,
  CallGraph,
} from "@mma/core";
import { detectChanges, classifyFiles } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { extractDependencyGraph, buildControlFlowGraph, createCfgIdCounter } from "@mma/structural";
import type { TreeSitterNode } from "@mma/parsing";
import { buildFeatureModel, extractConstraintsFromCode, validateFeatureModel } from "@mma/model-config";
import { identifyLogRoots, traceBackwardFromLog, buildFaultTree, analyzeGaps } from "@mma/model-fault";
import { buildServiceCatalog, generateDocumentation } from "@mma/model-functional";
import {
  inferServices,
  detectPatterns,
  scanForFlags,
  extractLogStatements,
  analyzeNaming,
} from "@mma/heuristics";
import type { PackageJsonInfo } from "@mma/heuristics";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";
import { tier1Summarize, tier2Summarize } from "@mma/summarization";

export interface IndexOptions {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
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

  // Phase 0: Cleanup stale data for deleted files
  for (const changeSet of changeSets) {
    if (changeSet.deletedFiles.length > 0) {
      log(`Phase 0: Cleaning up ${changeSet.deletedFiles.length} deleted files from ${changeSet.repo}...`);
      const deletedIds: string[] = [];
      for (const filePath of changeSet.deletedFiles) {
        deletedIds.push(filePath);
      }

      // Remove from search index
      await options.searchStore.delete(deletedIds);

      // Remove stale graph edges sourced from deleted files
      // (Graph edges are re-added during Phase 4, so clearing per-repo is simpler)
      await options.graphStore.clear(changeSet.repo);

      // Remove KV entries associated with deleted files
      for (const filePath of changeSet.deletedFiles) {
        await kvStore.deleteByPrefix(`${changeSet.repo}:${filePath}`);
      }

      log(`  Removed stale data for ${changeSet.deletedFiles.length} files`);
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

      if (result.parsedFiles.length === 0) {
        log(`    warning: 0 parsed files produced -- downstream phases will have no data`);
      } else if (result.stats.symbolCount === 0) {
        log(`    warning: 0 symbols extracted from ${result.parsedFiles.length} files`);
      }

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
      if (graph.edges.length === 0) {
        log(`    warning: 0 import edges from ${trees.size} trees -- pattern and flag detection may be limited`);
      }
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
    if (!classified || !depGraph) {
      log(`  ${repo.name}: skipping heuristics (no classified files or dependency graph)`);
      continue;
    }

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
          log(`    warning: could not read ${pjFile.path}`);
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

      const importsByFile = new Map<string, string[]>();
      for (const edge of depGraph.edges) {
        let imports = importsByFile.get(edge.source);
        if (!imports) {
          imports = [];
          importsByFile.set(edge.source, imports);
        }
        imports.push(edge.target);
      }

      // 5b: Pattern detection
      const patterns = detectPatterns({
        repo: repo.name,
        symbols: symbolsByFile,
        imports: importsByFile,
      });
      patternsByRepo.set(repo.name, patterns);
      log(`  ${repo.name}: ${patterns.length} patterns detected (from ${symbolsByFile.size} files with symbols)`);

      // 5c: Feature flag scanning
      if (trees && trees.size > 0) {
        const flagInventory = scanForFlags(trees, repo.name);
        flagsByRepo.set(repo.name, flagInventory);
        log(`  ${repo.name}: ${flagInventory.flags.length} feature flags found`);

        // 5d: Log statement extraction
        const logIndex = extractLogStatements(trees, repo.name);
        logIndexByRepo.set(repo.name, logIndex);
        log(`  ${repo.name}: ${logIndex.templates.length} log templates extracted`);
      } else {
        log(`  ${repo.name}: skipping flag scan and log extraction (no tree-sitter trees)`);
      }

      // 5e: Naming analysis
      if (symbolsByFile.size > 0) {
        const namingResult = analyzeNaming(symbolsByFile, repo.name);
        namingByRepo.set(repo.name, namingResult);
        log(`  ${repo.name}: ${namingResult.methods.length} method purposes inferred`);
      } else {
        log(`  ${repo.name}: skipping naming analysis (no symbols)`);
      }
    } catch (error) {
      console.error(`  Failed to run heuristics for ${repo.name}:`, error);
    }
  }

  // Phase 6: Summarization (tier-1 + tier-2)
  log("Phase 6: Generating summaries...");
  const summariesByRepo = new Map<string, Map<string, Summary>>();

  for (const repo of repos) {
    const parsedFiles = parsedFilesByRepo.get(repo.name);
    const namingResult = namingByRepo.get(repo.name);
    if (!parsedFiles) {
      log(`  ${repo.name}: skipping summarization (no parsed files)`);
      continue;
    }

    try {
      const summaryMap = new Map<string, Summary>();

      // Tier 1: template-based summaries from AST
      let tier1ReadErrors = 0;
      for (const pf of parsedFiles) {
        try {
          const absPath = join(repo.localPath, pf.path);
          const sourceText = await readFile(absPath, "utf-8");
          const tier1 = tier1Summarize(pf.symbols, pf.path, sourceText);
          for (const s of tier1) {
            summaryMap.set(s.entityId, s);
          }
        } catch {
          tier1ReadErrors++;
        }
      }
      if (tier1ReadErrors > 0) {
        log(`    warning: ${tier1ReadErrors} files could not be read for tier-1 summarization`);
      }

      const tier1Count = summaryMap.size;

      // Tier 2: naming-based summaries (overwrites tier 1 for same entityId)
      let tier2Total = 0;
      let tier2Upgraded = 0;
      if (namingResult) {
        const tier2 = tier2Summarize(namingResult.methods);
        tier2Total = tier2.length;
        for (const s of tier2) {
          if (summaryMap.has(s.entityId)) tier2Upgraded++;
          summaryMap.set(s.entityId, s);
        }
      }

      summariesByRepo.set(repo.name, summaryMap);

      // Index summaries in search store for query support
      const searchDocs = [...summaryMap.values()].map((s) => ({
        id: s.entityId,
        content: `${s.entityId} ${s.description}`,
        metadata: { tier: String(s.tier), repo: repo.name },
      }));
      await options.searchStore.index(searchDocs);

      log(`  ${repo.name}: ${tier1Count} tier-1, ${tier2Total} tier-2 (${tier2Upgraded} upgraded from tier-1), ${summaryMap.size} total`);
    } catch (error) {
      console.error(`  Failed to generate summaries for ${repo.name}:`, error);
    }
  }

  // Phase 7: Model generation
  log("Phase 7: Generating models...");

  for (const repo of repos) {
    const trees = treesByRepo.get(repo.name);
    const depGraph = depGraphByRepo.get(repo.name);
    const flagInventory = flagsByRepo.get(repo.name);
    const logIndex = logIndexByRepo.get(repo.name);
    const services = servicesByRepo.get(repo.name);
    const summaryMap = summariesByRepo.get(repo.name);

    // 7a: Feature/Config model
    if (!flagInventory || !depGraph || flagInventory.flags.length === 0) {
      log(`  ${repo.name} [config]: skipped (${!flagInventory ? "no flag inventory" : !depGraph ? "no dep graph" : "0 flags found"})`);
    }
    if (flagInventory && depGraph && flagInventory.flags.length > 0) {
      try {
        let featureModel = buildFeatureModel(flagInventory, depGraph);

        if (trees && trees.size > 0) {
          const codeConstraints = extractConstraintsFromCode(trees, featureModel.flags);
          if (codeConstraints.length > 0) {
            featureModel = {
              flags: featureModel.flags,
              constraints: [
                ...featureModel.constraints,
                ...codeConstraints.map((c) => c.constraint),
              ],
            };
          }
        }

        const { results: configResults, validation } = await validateFeatureModel(featureModel, repo.name);
        await kvStore.set(`sarif:config:${repo.name}`, JSON.stringify(configResults));

        log(`  ${repo.name} [config]: ${featureModel.flags.length} flags, ${featureModel.constraints.length} constraints, ${configResults.length} findings`);
        log(`    dead=${validation.deadFlags.length} always-on=${validation.alwaysOnFlags.length} untested=${validation.untestedInteractions.length}`);
      } catch (error) {
        console.error(`  Failed to build feature model for ${repo.name}:`, error);
      }
    }

    // 7b: Fault model
    if (!logIndex || logIndex.templates.length === 0 || !trees) {
      log(`  ${repo.name} [fault]: skipped (${!logIndex ? "no log index" : logIndex.templates.length === 0 ? "0 log templates" : "no trees"})`);
    }
    if (logIndex && logIndex.templates.length > 0 && trees) {
      try {
        const logRoots = identifyLogRoots(logIndex);

        // Build CFGs only for files that contain log templates
        const logFiles = new Set<string>();
        for (const tmpl of logIndex.templates) {
          for (const loc of tmpl.locations) {
            logFiles.add(loc.module);
          }
        }

        const cfgCounter = createCfgIdCounter();
        const cfgs = new Map<string, ControlFlowGraph>();
        for (const filePath of logFiles) {
          const tree = trees.get(filePath);
          if (!tree) {
            log(`    warning: no tree-sitter tree for log file ${filePath} (skipping CFG build)`);
            continue;
          }

          const fnNodes = findFunctionNodes(tree.rootNode);
          for (const fnNode of fnNodes) {
            const functionId = `${filePath}#${fnNode.name}`;
            const cfg = buildControlFlowGraph(fnNode.node, functionId, repo.name, filePath, cfgCounter);
            cfgs.set(functionId, cfg);
          }
        }

        // Empty call graph for POC (intra-function tracing still works)
        const emptyCallGraph: CallGraph = { repo: repo.name, edges: [], nodeCount: 0 };

        const faultTrees = [];
        // Limit tracing for POC performance; full-scale tracing requires call graph
        const MAX_TRACED_ROOTS = 50;
        const tracedRoots = logRoots.slice(0, MAX_TRACED_ROOTS);
        let emptyTraces = 0;
        for (const root of tracedRoots) {
          const trace = traceBackwardFromLog(root, cfgs, emptyCallGraph);
          if (trace.steps.length > 0) {
            faultTrees.push(buildFaultTree(trace, repo.name));
          } else {
            emptyTraces++;
          }
        }
        if (logRoots.length > MAX_TRACED_ROOTS) {
          log(`    warning: ${logRoots.length - MAX_TRACED_ROOTS} log roots not traced (POC limit=${MAX_TRACED_ROOTS})`);
        }
        if (emptyTraces > 0) {
          log(`    ${emptyTraces}/${tracedRoots.length} traces returned no steps (no matching CFG or log node)`);
        }

        const gapResults = analyzeGaps(cfgs, repo.name);
        await kvStore.set(`sarif:fault:${repo.name}`, JSON.stringify(gapResults));
        await kvStore.set(`faultTrees:${repo.name}`, JSON.stringify(faultTrees));

        log(`  ${repo.name} [fault]: ${logRoots.length} log roots, ${cfgs.size} CFGs, ${faultTrees.length} fault trees, ${gapResults.length} gap findings`);
      } catch (error) {
        console.error(`  Failed to build fault model for ${repo.name}:`, error);
      }
    }

    // 7c: Functional model (service catalog)
    if (!services || services.length === 0) {
      log(`  ${repo.name} [functional]: skipped (${!services ? "no services" : "0 services inferred"})`);
    }
    if (services && services.length > 0) {
      try {
        const svcSummaries = summaryMap ?? new Map<string, Summary>();
        const svcLogIndex = logIndex ?? { repo: repo.name, templates: [] };

        const catalog = buildServiceCatalog(services, svcSummaries, svcLogIndex);
        const docs = generateDocumentation(catalog, svcSummaries);
        await kvStore.set(`docs:functional:${repo.name}`, docs);

        log(`  ${repo.name} [functional]: ${catalog.length} catalog entries, ${docs.length} chars of documentation`);
      } catch (error) {
        console.error(`  Failed to build service catalog for ${repo.name}:`, error);
      }
    }
  }

  // Aggregate all per-repo SARIF into a combined latest result
  const allSarifResults: import("@mma/core").SarifResult[] = [];
  for (const repo of repos) {
    for (const key of ["config", "fault"] as const) {
      const json = await kvStore.get(`sarif:${key}:${repo.name}`);
      if (json) {
        try {
          const results = JSON.parse(json) as import("@mma/core").SarifResult[];
          allSarifResults.push(...results);
        } catch {
          log(`    warning: could not parse sarif:${key}:${repo.name}`);
        }
      }
    }
  }
  if (allSarifResults.length > 0) {
    const sarifLog: import("@mma/core").SarifLog = {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "multi-model-analyzer", version: "0.1.0", rules: [] } },
        results: allSarifResults,
      }],
    };
    await kvStore.set("sarif:latest", JSON.stringify(sarifLog));
    log(`  Aggregated ${allSarifResults.length} SARIF results into sarif:latest`);
  }

  // Save commit hashes only for repos that completed successfully
  const successfulRepos = new Set<string>();
  for (const repo of repos) {
    // A repo succeeded if it has parsed files or at least classified files
    if (parsedFilesByRepo.has(repo.name) || classifiedByRepo.has(repo.name)) {
      successfulRepos.add(repo.name);
    }
  }
  for (const changeSet of changeSets) {
    if (successfulRepos.has(changeSet.repo)) {
      await kvStore.set(`commit:${changeSet.repo}`, changeSet.commitHash);
    } else {
      log(`  Skipping commit hash for ${changeSet.repo} (processing incomplete)`);
    }
  }

  log("Indexing complete.");
}

interface FunctionNodeInfo {
  readonly name: string;
  readonly node: TreeSitterNode;
}

function findFunctionNodes(rootNode: TreeSitterNode): FunctionNodeInfo[] {
  const results: FunctionNodeInfo[] = [];

  function walk(node: TreeSitterNode): void {
    if (
      node.type === "function_declaration" ||
      node.type === "function_expression" ||
      node.type === "method_definition"
    ) {
      const nameNode = node.namedChildren.find(
        (c) => c.type === "identifier" || c.type === "property_identifier",
      );
      const name = nameNode?.text ?? `anon_${node.startPosition.row}`;
      results.push({ name, node });
    } else if (node.type === "arrow_function") {
      // Arrow function names live in the parent variable_declarator, not the arrow_function itself
      let name = `anon_${node.startPosition.row}`;
      const parent = node.parent;
      if (parent?.type === "variable_declarator") {
        const varName = parent.childForFieldName("name");
        if (varName) name = varName.text;
      } else if (parent?.type === "pair") {
        // Object property: { handler: (e) => ... }
        const key = parent.namedChildren.find((c) => c.type === "property_identifier" || c.type === "string");
        if (key) name = key.text;
      }
      results.push({ name, node });
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(rootNode);
  return results;
}
