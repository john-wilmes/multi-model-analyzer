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
  GraphEdge,
  ParsedFile,
  InferredService,
  DetectedPattern,
  FlagInventory,
  LogicalLocation,
  LogTemplateIndex,
  MethodPurposeMap,
  SymbolInfo,
  Summary,
  ControlFlowGraph,
  CallGraph,
  ArchitecturalRule,
  RepoMetricsSummary,
  SarifResult,
} from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import { detectChanges, classifyFiles, getFileContent, getFileContentBatch, getHeadCommit, isBareRepo, getCommitHistory } from "@mma/ingestion";
import { parseFiles } from "@mma/parsing";
import type { TreeSitterTree } from "@mma/parsing";
import { extractDependencyGraph, buildControlFlowGraph, createCfgIdCounter, extractCallEdgesFromTreeSitter, computeModuleMetrics, summarizeRepoMetrics, detectDeadExports, detectInstabilityViolations, extractHeritageEdges, tagBarrelMediatedCycles } from "@mma/structural";
import type { TreeSitterNode } from "@mma/parsing";
import { buildFeatureModel, extractConstraintsFromCode, validateFeatureModel } from "@mma/model-config";
import { identifyLogRoots, traceBackwardFromLog, buildFaultTree, analyzeGaps, analyzeCascadingRisk, FAULT_RULES } from "@mma/model-fault";
import { buildServiceCatalog, generateDocumentation } from "@mma/model-functional";
import {
  inferServicesWithMeta,
  detectPatternsWithMeta,
  scanForFlags,
  extractLogStatements,
  analyzeNamingWithMeta,
  extractServiceTopology,
  evaluateArchRules,
  computeHotspots,
  groupByCommit,
  detectTemporalCoupling,
  temporalCouplingToSarif,
  matchAdvisories,
  checkTransitiveVulnReachability,
  vulnReachabilityToSarifWithCodeFlows,
} from "@mma/heuristics";
import type { PackageJsonInfo, CommitInfo, Advisory, InstalledPackage } from "@mma/heuristics";
import { computeBaseline, fingerprint, hotspotFindings, computeRepoAtdi, computeSystemAtdi, annotateDebt, summarizeDebt } from "@mma/diagnostics";
import { computePageRank, pageRankToSarif, computeReachCounts } from "@mma/query";
import { runCorrelation, runCrossRepoModels } from "@mma/correlation";
import type { KVStore, GraphStore, SearchStore } from "@mma/storage";
import {
  tier1Summarize,
  tier2Summarize,
  shouldEscalateToTier3,
  tier3BatchSummarize,
  tier4BatchSummarize,
  SONNET_DEFAULTS,
  narrateAll,
} from "@mma/summarization";
import type { ServiceSummaryInput, RepoNarrationInput, SystemNarrationInput } from "@mma/summarization";
import { computeAffectedScope } from "./affected-scope.js";
import type { AffectedScope } from "./affected-scope.js";
import { PipelineTracer } from "../tracer.js";

function pLimit(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()!();
        });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
}

const bareRepoCache = new Map<string, boolean>();
async function checkBareRepo(repoPath: string): Promise<boolean> {
  let cached = bareRepoCache.get(repoPath);
  if (cached === undefined) {
    cached = await isBareRepo(repoPath);
    bareRepoCache.set(repoPath, cached);
  }
  return cached;
}

/** Resolve a commit hash for reading files from a bare repo. */
async function resolveCommitForBare(
  repoPath: string,
  changeSets: readonly ChangeSet[],
  repoName: string,
): Promise<string> {
  const cs = changeSets.find(c => c.repo === repoName);
  if (cs) return cs.commitHash;
  return getHeadCommit(repoPath);
}

export interface IndexOptions {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly verbose: boolean;
  readonly enableTsMorph?: boolean;
  readonly anthropicApiKey?: string;
  readonly maxApiCalls?: number;
  readonly rules?: readonly ArchitecturalRule[];
  readonly affected?: boolean;
  readonly narrateOnly?: boolean;
  readonly narrateForce?: boolean;
  readonly forceFullReindex?: boolean;
  readonly advisories?: readonly Advisory[];
  readonly enrich?: boolean;
}

export interface IndexResult {
  readonly hadChanges: boolean;
  readonly repoCount: number;
  readonly totalFiles: number;
  readonly totalSarifResults: number;
  readonly failedRepos: number;
}

export async function indexCommand(options: IndexOptions): Promise<IndexResult> {
  const { repos, mirrorDir, kvStore, verbose } = options;

  const log = verbose ? console.log : () => {};
  const tracer = new PipelineTracer();
  const failedRepoNames = new Set<string>();

  log(`Indexing ${repos.length} repositories...`);

  // Narrate-only mode: skip Phases 1-7, regenerate narrations from stored data
  if (options.narrateOnly) {
    if (!options.anthropicApiKey) {
      throw new Error("--narrate-only requires an Anthropic API key");
    }
    log("Narrate-only mode: skipping analysis, regenerating narrations from stored data...");

    // Reconstruct repoSarifCounts from stored per-category SARIF keys
    const repoSarifCounts = new Map<string, Record<string, number>>();
    let totalFindings = 0;
    for (const repo of repos) {
      const counts: Record<string, number> = {};
      for (const key of ["config", "fault", "deadExports", "arch", "instability", "blastRadius", "hotspot", "temporal-coupling", "vuln"] as const) {
        const json = await kvStore.get(`sarif:${key}:${repo.name}`);
        if (json) {
          try {
            const results = JSON.parse(json) as unknown[];
            counts[key] = results.length;
            totalFindings += results.length;
          } catch { /* skip malformed */ }
        }
      }
      repoSarifCounts.set(repo.name, counts);
    }
    // Add cross-repo SARIF counts
    for (const crossRepoKey of ["sarif:correlation", "sarif:cross-repo-models"] as const) {
      const json = await kvStore.get(crossRepoKey);
      if (json) {
        try {
          totalFindings += (JSON.parse(json) as unknown[]).length;
        } catch { /* skip */ }
      }
    }

    // Build narration inputs (same logic as Phase 8 in the full pipeline)
    tracer.startPhase("Narration");
    const narrationStart = performance.now();
    const repoInputs: RepoNarrationInput[] = [];

    for (const repo of repos) {
      const patternsJson = await kvStore.get(`patterns:${repo.name}`);
      const patterns: string[] = patternsJson
        ? (JSON.parse(patternsJson) as Array<{ kind: string }>).map((p) => p.kind)
        : [];

      const summaryJson = await kvStore.get(`metricsSummary:${repo.name}`);
      const metricsSummary = summaryJson ? JSON.parse(summaryJson) as RepoNarrationInput["metricsSummary"] : null;

      const sarifCounts = repoSarifCounts.get(repo.name) ?? {};

      // Recover service names + summaries from tier-4 cache
      const services: string[] = [];
      const serviceSummaries: string[] = [];
      const t4Keys = await kvStore.keys("summary:t4:");
      for (const k of t4Keys) {
        const val = await kvStore.get(k);
        if (val) {
          try {
            const s = JSON.parse(val) as { entityId: string; description: string };
            const repoServicePrefix = `service:${repo.name}/`;
            if (s.entityId.startsWith(repoServicePrefix)) {
              services.push(s.entityId.slice(repoServicePrefix.length));
              if (s.description) serviceSummaries.push(s.description);
            }
          } catch { /* skip malformed */ }
        }
      }

      // Cross-repo edge count for this repo
      let crossRepoEdges = 0;
      const corrGraphJson = await kvStore.get("correlation:graph");
      if (corrGraphJson) {
        try {
          const cg = JSON.parse(corrGraphJson) as { edges: Array<{ source: string; target: string }> };
          crossRepoEdges = cg.edges.filter(
            (e) => e.source.startsWith(repo.name) || e.target.startsWith(repo.name),
          ).length;
        } catch { /* skip */ }
      }

      repoInputs.push({ repo: repo.name, patterns, metricsSummary, sarifCounts, services, serviceSummaries, crossRepoEdges });
    }

    // System overview input
    let systemInput: SystemNarrationInput | undefined;
    if (repos.length > 1) {
      const corrServicesJson = await kvStore.get("correlation:services");
      const linchpins: string[] = [];
      let crossRepoEdgeCount = 0;
      if (corrServicesJson) {
        try {
          const cs = JSON.parse(corrServicesJson) as { linchpins: string[] };
          linchpins.push(...cs.linchpins);
        } catch { /* skip */ }
      }
      const corrGraphJson = await kvStore.get("correlation:graph");
      if (corrGraphJson) {
        try {
          const cg = JSON.parse(corrGraphJson) as { edges: unknown[] };
          crossRepoEdgeCount = cg.edges.length;
        } catch { /* skip */ }
      }
      systemInput = {
        repoNames: repos.map((r) => r.name),
        totalFindings,
        crossRepoEdgeCount,
        linchpins,
      };
    }

    const narrationResults = await narrateAll(repoInputs, systemInput, {
      apiKey: options.anthropicApiKey,
      kvStore,
      force: options.narrateForce,
    });

    const cached = narrationResults.filter((r) => r.cached).length;
    const generated = narrationResults.length - cached;
    const narrationMs = Math.round(performance.now() - narrationStart);
    log(`  Narration: ${narrationResults.length} total (${generated} generated, ${cached} cached) in ${narrationMs}ms`);
    tracer.record("narrationsGenerated", generated);
    tracer.record("narrationsCached", cached);
    tracer.endPhase();

    // Store pipeline trace
    const trace = tracer.finalize();
    await kvStore.set("pipeline:trace:latest", JSON.stringify(trace));
    if (verbose) {
      log(PipelineTracer.formatSummary(trace));
    }

    log("Narration complete.");
    return {
      hadChanges: false,
      repoCount: repos.length,
      totalFiles: 0,
      totalSarifResults: totalFindings,
      failedRepos: 0,
    };
  }

  // Load previous commit hashes
  const previousCommits = new Map<string, string>();
  for (const repo of repos) {
    const prev = await kvStore.get(`commit:${repo.name}`);
    if (prev) previousCommits.set(repo.name, prev);
  }

  // Phase 1: Ingestion
  log("Phase 1: Detecting changes...");
  tracer.startPhase("Ingestion");
  const phase1Start = performance.now();
  const changeSets: ChangeSet[] = [];
  const isTTY = process.stderr.isTTY;
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    if (!verbose) {
      const progress = `[${i + 1}/${repos.length}] ${repo.name}`;
      if (isTTY) {
        process.stderr.write(`\r${progress}\x1b[K`);
      } else {
        process.stderr.write(`${progress}\n`);
      }
    }
    try {
      const changeSet = await detectChanges(repo, {
        mirrorDir,
        previousCommits,
      });
      changeSets.push(changeSet);
      log(`  ${repo.name}: ${changeSet.addedFiles.length} added, ${changeSet.modifiedFiles.length} modified, ${changeSet.deletedFiles.length} deleted`);
    } catch (error) {
      console.error(`  Failed to index ${repo.name}:`, error);
      failedRepoNames.add(repo.name);
    }
  }
  // Clear progress line when done (TTY only)
  if (!verbose && isTTY && repos.length > 0) {
    process.stderr.write(`\r\x1b[K`);
  }
  tracer.record("changeSets", changeSets.length);
  tracer.endPhase();
  log(`  Phase 1: ${Math.round(performance.now() - phase1Start)}ms`);

  // Phase 0: Cleanup stale data for deleted files
  tracer.startPhase("Cleanup");
  const phase0Start = performance.now();
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
      await options.graphStore.deleteEdgesForFiles(changeSet.repo, changeSet.deletedFiles);

      // Remove KV entries associated with deleted files
      for (const filePath of changeSet.deletedFiles) {
        await kvStore.deleteByPrefix(`symbols:${changeSet.repo}:${filePath}`);
      }

      log(`  Removed stale data for ${changeSet.deletedFiles.length} files`);
    }
  }
  tracer.endPhase();
  log(`  Phase 0: ${Math.round(performance.now() - phase0Start)}ms`);

  // Phase 2: Classify files
  log("Phase 2: Classifying files...");
  tracer.startPhase("Classify");
  const phase2Start = performance.now();
  const classifiedByRepo = new Map<string, ReturnType<typeof classifyFiles>>();
  for (const changeSet of changeSets) {
    const classified = classifyFiles(changeSet);
    classifiedByRepo.set(changeSet.repo, classified);
    log(`  ${changeSet.repo}: ${classified.length} files classified`);
  }

  // Build cross-repo packageRoots map before Phase 3 so it's available for
  // dependency extraction (Phase 4). Only reads classified package.json files.
  const packageRoots = new Map<string, string>();
  const hasClassifiedFiles = [...classifiedByRepo.values()].some(c => c.length > 0);
  if (!hasClassifiedFiles) {
    // Incremental run with 0 changes — restore cached packageRoots from previous run
    const cached = await kvStore.get("_packageRoots");
    if (cached) {
      try {
        const entries = JSON.parse(cached) as [string, string][];
        for (const [name, dir] of entries) {
          packageRoots.set(name, dir);
        }
        log(`  Restored packageRoots from cache: ${packageRoots.size} packages`);
      } catch { /* ignore malformed cache entry */ }
    }
    // If cache was empty (e.g., first run after upgrade), scan repos via git
    if (packageRoots.size === 0) {
      for (const repo of repos) {
        try {
          const isBare = await checkBareRepo(repo.localPath);
          const commit = await resolveCommitForBare(repo.localPath, changeSets, repo.name);
          const { execSync } = await import("node:child_process");
          const lsOutput = execSync(
            `git ls-tree -r --name-only ${commit}`,
            { cwd: repo.localPath, encoding: "utf-8", timeout: 10000 },
          );
          const pjPaths = lsOutput.split("\n").filter(p => p.endsWith("/package.json") || p === "package.json");
          for (const pjPath of pjPaths) {
            try {
              const raw = isBare
                ? await getFileContent(repo.localPath, commit, pjPath)
                : await readFile(join(repo.localPath, pjPath), "utf-8");
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const name = parsed.name as string | undefined;
              if (name) {
                packageRoots.set(name, join(repo.localPath, dirname(pjPath)));
              }
            } catch { /* skip unreadable */ }
          }
        } catch { /* skip repos that fail git ls-tree */ }
      }
      if (packageRoots.size > 0) {
        await kvStore.set("_packageRoots", JSON.stringify([...packageRoots.entries()]));
        log(`  Built packageRoots from git scan: ${packageRoots.size} packages`);
      }
    }
  } else {
    for (const repo of repos) {
      const classified = classifiedByRepo.get(repo.name);
      if (!classified) continue;
      const packageJsonFiles = classified.filter(
        (f) => f.kind === "json" && f.path.endsWith("package.json"),
      );
      const isBare = await checkBareRepo(repo.localPath);
      for (const pjFile of packageJsonFiles) {
        try {
          const raw = isBare
            ? await getFileContent(repo.localPath, await resolveCommitForBare(repo.localPath, changeSets, repo.name), pjFile.path)
            : await readFile(join(repo.localPath, pjFile.path), "utf-8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const name = parsed.name as string | undefined;
          if (name) {
            const absDir = join(repo.localPath, dirname(pjFile.path));
            if (packageRoots.has(name)) {
              log(`    warning: duplicate package name "${name}" (overwriting ${packageRoots.get(name)} with ${absDir})`);
            }
            packageRoots.set(name, absDir);
          }
        } catch {
          // Skip unreadable package.json files
        }
      }
    }
    if (packageRoots.size > 0) {
      await kvStore.set("_packageRoots", JSON.stringify([...packageRoots.entries()]));
      log(`  Built packageRoots map: ${packageRoots.size} packages across all repos`);
    }
  }
  tracer.record("packageRoots", packageRoots.size);
  tracer.endPhase();
  log(`  Phase 2: ${Math.round(performance.now() - phase2Start)}ms`);

  // Affected scoping: when --affected is set, compute blast radius per repo
  // and filter Phase 3 parsing to only scoped files.
  let scopeByRepo: Map<string, AffectedScope> | undefined;
  if (options.affected) {
    log("Computing affected scope...");
    scopeByRepo = await computeAffectedScope(changeSets, options.graphStore);
    for (const [repoName, scope] of scopeByRepo) {
      log(`  ${repoName}: ${scope.changedFiles.length} changed, ${scope.affectedFiles.length} affected, ${scope.allScopedFiles.length} total scoped`);
    }
  }

  // Phases 3-6b: Per-repo processing (parse, structural, heuristics, models,
  // summarization). Repos are processed in parallel with a concurrency cap of 4
  // to bound WASM heap usage. Map writes use different keys per repo so there
  // are no races; SQLite stores use WAL + busy_timeout for concurrent writes.
  log("Phases 3-6b: Per-repo processing (parallel, concurrency=4)...");
  const parsedFilesByRepo = new Map<string, ParsedFile[]>();
  const depGraphByRepo = new Map<string, DependencyGraph>();
  const servicesByRepo = new Map<string, InferredService[]>();
  const patternsByRepo = new Map<string, DetectedPattern[]>();
  const flagsByRepo = new Map<string, FlagInventory>();
  const logIndexByRepo = new Map<string, LogTemplateIndex>();
  const namingByRepo = new Map<string, MethodPurposeMap>();
  const completedRepos = new Set<string>();
  let totalFiles = 0;
  let phase6bTotalMs = 0;
  let phase6cTotalMs = 0;

  // Detect repos that need recovery: commit hash matches (no file changes detected)
  // but pipelineComplete flag is missing (Phase 5+ failed on previous run).
  // Load cached symbols so Phases 5+ can re-run without re-parsing.
  const recoveryRepos = new Set<string>();
  for (const repo of repos) {
    const classified = classifiedByRepo.get(repo.name);
    if (classified && classified.length > 0) continue; // Has changes, normal processing

    const savedCommit = previousCommits.get(repo.name);
    if (!savedCommit) continue; // Never processed

    const pipelineComplete = await kvStore.get(`pipelineComplete:${repo.name}`);
    if (pipelineComplete) continue; // Fully completed last run

    // Recovery: batch-load cached symbols from KV (single range scan)
    const symbolEntries = await kvStore.getByPrefix(`symbols:${repo.name}:`);
    if (symbolEntries.size === 0) {
      // No cached symbols: pre-Increment-3 run. Backfill pipelineComplete
      // since the old code only saved commit hash on successful parse.
      await kvStore.set(`pipelineComplete:${repo.name}`, "true");
      log(`  [${repo.name}] Backfilled pipelineComplete (pre-recovery-era data)`);
      continue;
    }

    log(`  [${repo.name}] Recovery: loading ${symbolEntries.size} cached files...`);
    const recoveredFiles: ParsedFile[] = [];
    for (const [key, raw] of symbolEntries) {
      try {
        const { symbols, contentHash, kind = "typescript" } = JSON.parse(raw) as { symbols: SymbolInfo[]; contentHash: string; kind?: string };
        // Extract filePath from key: "symbols:<repo>:<filePath>"
        const filePath = key.slice(`symbols:${repo.name}:`.length);
        recoveredFiles.push({ path: filePath, repo: repo.name, kind: kind as ParsedFile["kind"], symbols, contentHash, errors: [] });
      } catch {
        log(`    warning: could not parse cached symbols for ${key}`);
      }
    }
    if (recoveredFiles.length > 0) {
      parsedFilesByRepo.set(repo.name, recoveredFiles);
      // Reconstruct depGraph from persisted graph edges
      const edges = await options.graphStore.getEdgesByKind("imports", repo.name);
      depGraphByRepo.set(repo.name, { repo: repo.name, edges, circularDependencies: [] });
      recoveryRepos.add(repo.name);
      log(`  [${repo.name}] Recovered ${recoveredFiles.length} files, ${edges.length} import edges`);
    }
  }

  // Shared API budget across all parallel workers.
  // reserve() atomically claims budget before async work; refund() returns unused.
  // This prevents concurrent pLimit workers from overspending.
  const sharedApiBudget = options.maxApiCalls !== undefined
    ? {
        remaining: options.maxApiCalls,
        reserve(n: number): number {
          const granted = Math.min(n, this.remaining);
          this.remaining -= granted;
          return granted;
        },
        refund(n: number): void {
          this.remaining += n;
        },
      }
    : undefined;

  const limit = pLimit(4);
  await Promise.all(repos.map((repo) => limit(async () => {
    let trees: ReadonlyMap<string, TreeSitterTree> | undefined;

    // Recovery repos skip Phases 3-4b (already have parsedFiles + graph edges)
    // Cache source text read during parsing so tier-1 summarization doesn't
    // re-fetch from git (critical for blobless bare clones where each
    // git-show triggers a lazy blob fetch from the remote).
    const sourceTextCache = new Map<string, string>();

    if (recoveryRepos.has(repo.name)) {
      log(`  [${repo.name}] Skipping Phases 3-4b (recovery mode, 4c/4d will still run)`);
    } else {
    let classified = classifiedByRepo.get(repo.name) ?? ([] as ReturnType<typeof classifyFiles>);
    if (classified.length === 0) return;

    // Filter to affected scope when --affected is active
    if (scopeByRepo) {
      const scope = scopeByRepo.get(repo.name);
      if (scope && scope.allScopedFiles.length > 0) {
        const scopedSet = new Set(scope.allScopedFiles);
        classified = classified.filter((f) => scopedSet.has(f.path));
        log(`  [${repo.name}] Scoped to ${classified.length} affected files`);
      }
    }

    // --- Phase 3: Parse files ---

    log(`  [${repo.name}] Parsing files...`);
    const phase3Start = performance.now();
    try {
      // Detect bare repos (no working tree) so we can read content via git show.
      // A bare repo path ends with ".git" or git rev-parse reports it is bare.
      const isBare = await checkBareRepo(repo.localPath);
      const bareCommit = isBare ? await resolveCommitForBare(repo.localPath, changeSets, repo.name) : undefined;
      const contentProvider =
        isBare && bareCommit
          ? async (filePath: string) => {
              const text = await getFileContent(repo.localPath, bareCommit, filePath);
              sourceTextCache.set(filePath, text);
              return text;
            }
          : undefined;

      const result = await parseFiles(classified, repo.name, repo.localPath, {
        enableTsMorph: options.enableTsMorph,
        contentProvider,
        onProgress: verbose
          ? (info) => {
              if (info.current === 1 || info.current % 100 === 0 || info.current === info.total) {
                log(`    [${info.phase}] ${info.current}/${info.total}`);
              }
            }
          : undefined,
      });

      log(`  [${repo.name}] ${result.stats.fileCount} files, ${result.stats.symbolCount} symbols, ${result.stats.errorCount} errors`);
      log(`    tree-sitter: ${result.stats.treeSitterTimeMs}ms, ts-morph: ${result.stats.tsMorphTimeMs}ms`);

      if (result.parsedFiles.length === 0) {
        log(`    warning: 0 parsed files produced -- downstream phases will have no data`);
      } else if (result.stats.symbolCount === 0) {
        log(`    warning: 0 symbols extracted from ${result.parsedFiles.length} files`);
      }

      trees = result.treeSitterTrees;
      parsedFilesByRepo.set(repo.name, result.parsedFiles);

      // For incremental mode: load cached symbols for unchanged files and merge
      if (!options.forceFullReindex) {
        const changedPathSet = new Set(result.parsedFiles.map(pf => pf.path));
        const symbolEntries = await kvStore.getByPrefix(`symbols:${repo.name}:`);
        for (const [key, raw] of symbolEntries) {
          const filePath = key.slice(`symbols:${repo.name}:`.length);
          if (changedPathSet.has(filePath)) continue; // freshly parsed
          try {
            const { symbols, contentHash, kind = "typescript" } = JSON.parse(raw) as { symbols: SymbolInfo[]; contentHash: string; kind?: string };
            result.parsedFiles.push({ path: filePath, repo: repo.name, kind: kind as ParsedFile["kind"], symbols, contentHash, errors: [] });
          } catch {
            // skip malformed cached entry
          }
        }
      }

      // Persist parsed symbols to KV for failure recovery.
      // If Phase 5+ fails, the next run can load these instead of re-parsing.
      const symbolEntries: Array<readonly [string, string]> = result.parsedFiles.map((pf) => [
        `symbols:${repo.name}:${pf.path}`,
        JSON.stringify({ symbols: pf.symbols, contentHash: pf.contentHash, kind: pf.kind }),
      ] as const);
      await kvStore.setMany(symbolEntries);
      log(`  [${repo.name}] Phase 3: ${Math.round(performance.now() - phase3Start)}ms`);
    } catch (error) {
      console.error(`  Failed to parse ${repo.name}:`, error);
      failedRepoNames.add(repo.name);
      return;
    }

    // --- Phase 4: Dependency graph extraction ---
    if (trees && trees.size > 0) {
      log(`  [${repo.name}] Extracting dependency graph...`);
      try {
        const start = performance.now();
        const graph = extractDependencyGraph(trees, repo.name, { detectCircular: true }, packageRoots, repo.localPath);
        const elapsed = Math.round(performance.now() - start);

        depGraphByRepo.set(repo.name, graph);
        const changedFilePaths = classified.map(f => f.path);
        if (options.forceFullReindex) {
          await options.graphStore.clear(repo.name);
        } else {
          await options.graphStore.deleteEdgesForFiles(repo.name, changedFilePaths);
        }
        await options.graphStore.addEdges(graph.edges);

        log(`  [${repo.name}] ${graph.edges.length} import edges (${elapsed}ms)`);
        if (graph.edges.length === 0) {
          log(`    warning: 0 import edges from ${trees.size} trees -- pattern and flag detection may be limited`);
        }
        await kvStore.set(`circularDeps:${repo.name}`, JSON.stringify(graph.circularDependencies));
        // Tag barrel-mediated cycles and persist the boolean flags so consumers
        // can suppress false-positive warnings without re-running analysis.
        const annotated = tagBarrelMediatedCycles(graph.circularDependencies, trees, repo.name);
        const barrelFlags = annotated.map((a) => a.barrelMediated);
        await kvStore.set(`circularDepsBarrel:${repo.name}`, JSON.stringify(barrelFlags));
        if (graph.circularDependencies.length > 0) {
          const barrelCount = barrelFlags.filter(Boolean).length;
          log(`    ${graph.circularDependencies.length} circular dependencies found (${barrelCount} barrel-mediated)`);
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

    // --- Phase 4b: Call graph extraction ---
    if (trees && trees.size > 0) {
      log(`  [${repo.name}] Extracting call graph...`);
      try {
        const start = performance.now();
        const callEdges: GraphEdge[] = [];

        for (const [filePath, tree] of trees) {
          const edges = extractCallEdgesFromTreeSitter(
            tree.rootNode as import("@mma/structural").TsNode,
            filePath,
            repo.name,
          );
          callEdges.push(...edges);
        }

        if (callEdges.length > 0) {
          await options.graphStore.addEdges(callEdges);
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
          await options.graphStore.addEdges(heritageEdges);
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
      const fullImportEdges = await options.graphStore.getEdgesByKind("imports", repo.name);
      depGraphByRepo.set(repo.name, { repo: repo.name, edges: fullImportEdges, circularDependencies: [] });
    }
    } // end of normal (non-recovery) Phases 3-4d block

    // --- Phase 4c: Module instability metrics ---
    // Runs for both normal and recovery repos (only needs parsedFiles + depGraph)
    {
      const pf4c = parsedFilesByRepo.get(repo.name);
      const dg4c = depGraphByRepo.get(repo.name);
      if (pf4c && dg4c) {
        log(`  [${repo.name}] Computing instability metrics...`);
        try {
          const start = performance.now();
          const metrics = computeModuleMetrics(dg4c.edges, pf4c, repo.name);
          const summary = summarizeRepoMetrics(metrics, repo.name);
          await kvStore.set(`metrics:${repo.name}`, JSON.stringify(metrics));
          await kvStore.set(`metricsSummary:${repo.name}`, JSON.stringify(summary));
          const elapsed = Math.round(performance.now() - start);
          log(`  [${repo.name}] ${metrics.length} modules, avg instability=${summary.avgInstability.toFixed(2)}, pain=${summary.painZoneCount}, uselessness=${summary.uselessnessZoneCount} (${elapsed}ms)`);

          // SDP violation detection (reuses metrics + edges from 4c)
          const instabilityResults = detectInstabilityViolations(metrics, dg4c.edges, repo.name);
          await kvStore.set(`sarif:instability:${repo.name}`, JSON.stringify(instabilityResults));
          log(`  [${repo.name}] ${instabilityResults.length} instability violations found`);
        } catch (error) {
          console.error(`  Failed to compute metrics for ${repo.name}:`, error);
        }
      }
    }

    // --- Phase 4d: Dead export detection ---
    // Runs for both normal and recovery repos (only needs parsedFiles + depGraph)
    {
      const pf4d = parsedFilesByRepo.get(repo.name);
      const dg4d = depGraphByRepo.get(repo.name);
      if (pf4d && dg4d) {
        log(`  [${repo.name}] Detecting dead exports...`);
        try {
          const start = performance.now();
          const deadResults = detectDeadExports(pf4d, dg4d.edges, repo.name);
          await kvStore.set(`sarif:deadExports:${repo.name}`, JSON.stringify(deadResults));
          const elapsed = Math.round(performance.now() - start);
          log(`  [${repo.name}] ${deadResults.length} dead exports found (${elapsed}ms)`);
        } catch (error) {
          console.error(`  Failed to detect dead exports for ${repo.name}:`, error);
        }
      }
    }

    // --- Phase 4e: Hotspot analysis ---
    {
      const pf4e = parsedFilesByRepo.get(repo.name);
      if (pf4e && pf4e.length > 0) {
        log(`  [${repo.name}] Computing hotspots...`);
        try {
          const start = performance.now();
          const fileChanges = await getCommitHistory(repo.localPath, 200);
          const symbolCounts = new Map<string, number>();
          for (const pf of pf4e) {
            symbolCounts.set(pf.path, pf.symbols.length);
          }
          const hotspotResult = computeHotspots(fileChanges, symbolCounts);
          const hotspotSarif = hotspotFindings(hotspotResult.hotspots, repo.name);
          await kvStore.set(`hotspots:${repo.name}`, JSON.stringify(hotspotResult.hotspots));
          await kvStore.set(`sarif:hotspot:${repo.name}`, JSON.stringify(hotspotSarif));
          const elapsed = Math.round(performance.now() - start);
          log(`  [${repo.name}] ${hotspotResult.hotspots.length} hotspots, ${hotspotSarif.length} findings (${elapsed}ms)`);
        } catch (error) {
          console.error(`  Failed to compute hotspots for ${repo.name}:`, error);
        }
      }
    }

    // --- Phase 4f: Temporal coupling ---
    {
      const pf4f = parsedFilesByRepo.get(repo.name);
      if (pf4f && pf4f.length > 0) {
        log(`  [${repo.name}] Computing temporal coupling...`);
        try {
          const start = performance.now();
          const fileChanges = await getCommitHistory(repo.localPath, 200);
          const commits: CommitInfo[] = groupByCommit(fileChanges);
          const tcResult = detectTemporalCoupling(commits);
          const tcSarif = temporalCouplingToSarif(tcResult, repo.name);
          await kvStore.set(`temporal-coupling:${repo.name}`, JSON.stringify(tcResult));
          await kvStore.set(`sarif:temporal-coupling:${repo.name}`, JSON.stringify(tcSarif));
          const elapsed = Math.round(performance.now() - start);
          log(`  [${repo.name}] ${tcResult.pairs.length} coupled pairs, ${tcSarif.length} findings (${elapsed}ms)`);
        } catch (error) {
          console.error(`  Failed to compute temporal coupling for ${repo.name}:`, error);
        }
      }
    }

    // --- Phase 5: Heuristic analysis ---
    const depGraph = depGraphByRepo.get(repo.name);
    const parsedFiles = parsedFilesByRepo.get(repo.name);
    const repoClassified = classifiedByRepo.get(repo.name) ?? [];
    if (!depGraph) {
      log(`  [${repo.name}] Skipping heuristics (no dependency graph)`);
    } else {
      log(`  [${repo.name}] Running heuristics...`);
      const phase5Start = performance.now();
      try {
        // 5a: Service inference
        // In recovery mode, repoClassified may be empty; derive filePaths from parsedFiles.
        const packageJsonFiles = repoClassified.filter(
          (f) => f.kind === "json" && f.path.endsWith("package.json"),
        );

        const packageJsons = new Map<string, PackageJsonInfo>();
        const isBare = await checkBareRepo(repo.localPath);
        for (const pjFile of packageJsonFiles) {
          try {
            const raw = isBare
              ? await getFileContent(repo.localPath, await resolveCommitForBare(repo.localPath, changeSets, repo.name), pjFile.path)
              : await readFile(join(repo.localPath, pjFile.path), "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            packageJsons.set(dirname(pjFile.path), {
              name: (parsed.name as string) ?? "",
              main: parsed.main as string | undefined,
              bin: (parsed.bin as Record<string, string>) ?? undefined,
              dependencies: (parsed.dependencies as Record<string, string>) ?? {},
              devDependencies: (parsed.devDependencies as Record<string, string>) ?? undefined,
              scripts: (parsed.scripts as Record<string, string>) ?? {},
            });
          } catch {
            log(`    warning: could not read ${pjFile.path}`);
          }
        }

        const filePaths = parsedFiles && parsedFiles.length > 0
          ? parsedFiles.map((pf) => pf.path)
          : repoClassified.map((f) => f.path);
        const servicesResult = inferServicesWithMeta({
          repo: repo.name,
          filePaths,
          packageJsons,
          dependencyGraph: depGraph,
        });
        const services = servicesResult.data;
        servicesByRepo.set(repo.name, services);

        log(`    ${servicesResult.meta.itemCount} services inferred in ${servicesResult.meta.durationMs}ms, ${packageJsons.size} package.json files`);
        for (const svc of services.slice(0, 10)) {
          log(`      ${svc.name} (${svc.rootPath}) confidence=${svc.confidence} deps=${svc.dependencies.length}`);
        }
        if (services.length > 10) {
          log(`      ... and ${services.length - 10} more`);
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
        const patternsResult = detectPatternsWithMeta({
          repo: repo.name,
          symbols: symbolsByFile,
          imports: importsByFile,
        });
        const patterns = patternsResult.data;
        patternsByRepo.set(repo.name, patterns);
        await kvStore.set(`patterns:${repo.name}`, JSON.stringify(patterns));
        log(`    ${patternsResult.meta.itemCount} patterns detected in ${patternsResult.meta.durationMs}ms (from ${symbolsByFile.size} files with symbols)`);

        // 5c: Feature flag scanning
        if (trees && trees.size > 0) {
          let flagInventory = scanForFlags(trees, repo.name);

          // Incremental mode: merge with cached flags for files not re-scanned
          if (!options.forceFullReindex) {
            const cachedFlagJson = await kvStore.get(`flags:${repo.name}`);
            if (cachedFlagJson) {
              try {
                const cached = JSON.parse(cachedFlagJson) as FlagInventory;
                const scannedFiles = new Set(trees.keys());
                const mergedFlagMap = new Map<string, { name: string; sdk?: string; defaultValue?: unknown; locations: LogicalLocation[] }>();
                // Keep cached flag locations from files not re-scanned
                for (const flag of cached.flags) {
                  const kept = flag.locations.filter(loc => !scannedFiles.has(loc.module));
                  if (kept.length > 0) {
                    mergedFlagMap.set(flag.name, { name: flag.name, sdk: flag.sdk, defaultValue: flag.defaultValue, locations: [...kept] });
                  }
                }
                // Add new flag results from scanned files
                for (const flag of flagInventory.flags) {
                  const existing = mergedFlagMap.get(flag.name);
                  if (existing) {
                    existing.locations.push(...flag.locations);
                  } else {
                    mergedFlagMap.set(flag.name, { name: flag.name, sdk: flag.sdk, defaultValue: flag.defaultValue, locations: [...flag.locations] });
                  }
                }
                flagInventory = { repo: repo.name, flags: [...mergedFlagMap.values()] };
              } catch { /* skip malformed cache */ }
            }
          }

          flagsByRepo.set(repo.name, flagInventory);
          await kvStore.set(`flags:${repo.name}`, JSON.stringify(flagInventory));
          log(`    ${flagInventory.flags.length} feature flags found`);

          // 5d: Log statement extraction
          const logIndex = extractLogStatements(trees, repo.name);
          logIndexByRepo.set(repo.name, logIndex);
          await kvStore.set(`logTemplates:${repo.name}`, JSON.stringify(logIndex));
          log(`    ${logIndex.templates.length} log templates extracted`);
        } else {
          log(`    skipping flag scan and log extraction (no tree-sitter trees)`);
        }

        // 5e: Naming analysis
        if (symbolsByFile.size > 0) {
          const namingHeuristic = analyzeNamingWithMeta(symbolsByFile, repo.name);
          namingByRepo.set(repo.name, namingHeuristic.data);
          await kvStore.set(`naming:${repo.name}`, JSON.stringify(namingHeuristic.data));
          log(`    ${namingHeuristic.meta.itemCount} method purposes inferred in ${namingHeuristic.meta.durationMs}ms`);
        } else {
          log(`    skipping naming analysis (no symbols)`);
        }

        // 5f: Service topology detection
        if (trees && trees.size > 0) {
          const topologyEdges = extractServiceTopology({
            repo: repo.name,
            trees,
            imports: importsByFile,
          });
          if (topologyEdges.length > 0) {
            await options.graphStore.addEdges(topologyEdges);
            log(`    ${topologyEdges.length} service-call edges detected`);
            const producers = topologyEdges.filter(e => e.metadata?.role === "producer").length;
            const consumers = topologyEdges.filter(e => e.metadata?.role === "consumer").length;
            const httpCalls = topologyEdges.filter(e => e.metadata?.protocol === "http").length;
            log(`      producers=${producers} consumers=${consumers} http=${httpCalls}`);
          } else {
            log(`    0 service-call edges detected`);
          }
        }
        // 5g: Architectural rules evaluation
        if (options.rules && options.rules.length > 0 && depGraph) {
          const archResults = evaluateArchRules(options.rules, depGraph.edges, repo.name);
          await kvStore.set(`sarif:arch:${repo.name}`, JSON.stringify(archResults));
          log(`    ${archResults.length} architectural rule violations`);
        }

        // 5h: PageRank blast radius scoring
        if (depGraph) {
          const prResult = computePageRank(depGraph.edges);
          const prSarif = pageRankToSarif(prResult, repo.name);
          await kvStore.set(`sarif:blastRadius:${repo.name}`, JSON.stringify(prSarif));
          log(`    PageRank: ${prResult.ranked.length} nodes scored, ${prSarif.length} high-risk`);
          const reachCounts = await computeReachCounts(depGraph.edges);
          await kvStore.set(`reachCounts:${repo.name}`, JSON.stringify([...reachCounts]));
          log(`    ReachCounts: ${reachCounts.size} nodes scored`);
        }

        // 5i: Vulnerability reachability
        if (options.advisories && options.advisories.length > 0) {
          const installed: InstalledPackage[] = [];
          const skippedProtocols: string[] = [];
          for (const [, pj] of packageJsons) {
            const allDeps = { ...pj.dependencies, ...pj.devDependencies };
            for (const [name, version] of Object.entries(allDeps)) {
              // Skip non-semver version protocols (workspace:*, link:, file:, etc.)
              if (/^(?:workspace|link|file|portal|patch):/.test(version)) {
                skippedProtocols.push(`${name}@${version}`);
                continue;
              }
              const clean = version.replace(/^[~^>=<v ]+/, "");
              if (clean && clean !== "*") installed.push({ name, version: clean });
            }
          }
          if (skippedProtocols.length > 0) {
            log(`    [vuln] skipped ${skippedProtocols.length} non-semver deps (${skippedProtocols.slice(0, 3).join(", ")}${skippedProtocols.length > 3 ? "..." : ""})`);
          }
          if (installed.length === 0) {
            if (packageJsons.size === 0) {
              log(`    [vuln] no package.json in changeset, skipping (use --force-full-reindex to re-scan)`);
            } else {
              log(`    [vuln] no semver-compatible dependencies found after protocol filtering, skipping`);
            }
          } else {
            const vulnMatches = matchAdvisories(installed, options.advisories);
            const reachability = checkTransitiveVulnReachability(vulnMatches, depGraph?.edges ?? []);
            const vulnSarif = vulnReachabilityToSarifWithCodeFlows(reachability, repo.name);
            await kvStore.set(`sarif:vuln:${repo.name}`, JSON.stringify(vulnSarif));
            log(`    ${vulnSarif.length} reachable vulnerabilities found`);
          }
        }

        log(`  [${repo.name}] Phase 5: ${Math.round(performance.now() - phase5Start)}ms`);
      } catch (error) {
        console.error(`  Failed to run heuristics for ${repo.name}:`, error);
        failedRepoNames.add(repo.name);
      }
    }

    // --- Phase 6a: Config and fault models ---
    const phase6aStart = performance.now();
    const flagInventory = flagsByRepo.get(repo.name);
    const logIndex = logIndexByRepo.get(repo.name);

    // Config model
    if (!flagInventory || !depGraph || flagInventory.flags.length === 0) {
      log(`  [${repo.name}] [config]: skipped (${!flagInventory ? "no flag inventory" : !depGraph ? "no dep graph" : "0 flags found"})`);
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

        log(`  [${repo.name}] [config]: ${featureModel.flags.length} flags, ${featureModel.constraints.length} constraints, ${configResults.length} findings`);
        log(`    dead=${validation.deadFlags.length} always-on=${validation.alwaysOnFlags.length} untested=${validation.inferredUntestedPairs.length}`);
      } catch (error) {
        console.error(`  Failed to build feature model for ${repo.name}:`, error);
      }
    }

    // Fault model
    if (!logIndex || logIndex.templates.length === 0 || !trees) {
      log(`  [${repo.name}] [fault]: skipped (${!logIndex ? "no log index" : logIndex.templates.length === 0 ? "0 log templates" : "no trees"})`);
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

        // Use real call edges from graph store if available
        const repoCallEdges = await options.graphStore.getEdgesByKind("calls", repo.name);
        const callGraph: CallGraph = {
          repo: repo.name,
          edges: repoCallEdges,
          nodeCount: new Set(repoCallEdges.flatMap(e => [e.source, e.target])).size,
        };

        const faultTrees = [];
        const allTraces: import("@mma/model-fault").BackwardTrace[] = [];
        // Limit tracing for POC performance; full-scale tracing requires call graph
        const MAX_TRACED_ROOTS = 50;
        const tracedRoots = logRoots.slice(0, MAX_TRACED_ROOTS);
        const failCounts = new Map<string, number>();
        for (const root of tracedRoots) {
          const trace = traceBackwardFromLog(root, cfgs, callGraph);
          allTraces.push(trace);
          if (trace.steps.length > 0) {
            faultTrees.push(buildFaultTree(trace, repo.name));
          } else if (trace.failReason) {
            failCounts.set(trace.failReason, (failCounts.get(trace.failReason) ?? 0) + 1);
          }
        }
        if (logRoots.length > MAX_TRACED_ROOTS) {
          log(`    warning: ${logRoots.length - MAX_TRACED_ROOTS} log roots not traced (POC limit=${MAX_TRACED_ROOTS})`);
        }
        if (failCounts.size > 0) {
          const breakdown = [...failCounts.entries()].map(([reason, count]) => `${count} ${reason}`).join(", ");
          const totalFailed = [...failCounts.values()].reduce((a, b) => a + b, 0);
          log(`    trace failures: ${breakdown} (${totalFailed}/${tracedRoots.length} total)`);
        }

        // Collect all fault SARIF results
        const faultResults: SarifResult[] = [];

        // Gap analysis (unhandled-error-path + silent-failure)
        faultResults.push(...analyzeGaps(cfgs, repo.name));

        // Cascading failure risk from cross-service calls
        faultResults.push(...analyzeCascadingRisk(allTraces, repo.name));

        // Missing error boundaries (async functions without try/catch)
        faultResults.push(...detectMissingErrorBoundaries(cfgs, repo.name));

        await kvStore.set(`sarif:fault:${repo.name}`, JSON.stringify(faultResults));
        await kvStore.set(`faultTrees:${repo.name}`, JSON.stringify(faultTrees));

        log(`  [${repo.name}] [fault]: ${logRoots.length} log roots, ${cfgs.size} CFGs, ${faultTrees.length} fault trees, ${faultResults.length} fault findings`);
      } catch (error) {
        console.error(`  Failed to build fault model for ${repo.name}:`, error);
      }
    }

    log(`  [${repo.name}] Phase 6a: ${Math.round(performance.now() - phase6aStart)}ms`);

    // Release tree-sitter ASTs: explicitly free WASM heap memory via tree.delete(),
    // then drop JS references. Without tree.delete(), trees are only collected by
    // JS GC which doesn't know about WASM heap pressure.
    if (trees && trees.size > 0) {
      for (const tree of trees.values()) {
        tree.delete();
      }
      log(`  [${repo.name}] Released tree-sitter ASTs`);
    }

    // --- Phase 6b: Summarization (tier-1 + tier-2) ---
    let summaryMap: Map<string, Summary> | undefined;
    if (!parsedFiles) {
      log(`  [${repo.name}] Skipping summarization (no parsed files)`);
    } else {
      const phase6bRepoStart = performance.now();
      try {
        summaryMap = new Map<string, Summary>();
        const namingResult = namingByRepo.get(repo.name);

        // Tier 1: template-based summaries from AST (batched parallel I/O, cached by contentHash)
        let tier1ReadErrors = 0;
        let tier1CacheHits = 0;
        const BATCH_SIZE = 20;
        // Source snippets for tier-3 context (only needed when --enrich is set)
        const needSnippets = !!(options.enrich && options.anthropicApiKey);
        const sourceContextMap = new Map<string, string>();
        const MAX_SNIPPET_LINES = 30;
        const isBareForTier1 = await checkBareRepo(repo.localPath);
        const bareCommitForTier1 = isBareForTier1
          ? await resolveCommitForBare(repo.localPath, changeSets, repo.name)
          : undefined;

        for (let batchStart = 0; batchStart < parsedFiles.length; batchStart += BATCH_SIZE) {
          const batch = parsedFiles.slice(batchStart, batchStart + BATCH_SIZE);

          // For bare repos: bulk-fetch uncached files in this batch via git cat-file --batch
          if (isBareForTier1 && bareCommitForTier1) {
            // Filter out files already in the source-text cache, then check the
            // KV summary cache in parallel for the remainder.
            const notInMemory = batch.filter((pf) => !sourceTextCache.has(pf.path));
            const cacheChecks = await Promise.all(
              notInMemory.map(async (pf) => {
                const cacheKey = `summary:t1:${repo.name}:${pf.path}:${pf.contentHash}`;
                const hit = await kvStore.get(cacheKey);
                return { pf, hit };
              }),
            );
            const uncached = cacheChecks.filter(({ hit }) => !hit).map(({ pf }) => pf.path);
            if (uncached.length > 0) {
              try {
                const fetched = await getFileContentBatch(repo.localPath, bareCommitForTier1, uncached);
                for (const [p, c] of fetched) sourceTextCache.set(p, c);
              } catch (err) {
                log(`[warn] bulk fetch failed for ${repo.name}, falling through to per-file reads: ${String(err)}`);
              }
            }
          }

          const results = await Promise.all(
            batch.map(async (pf) => {
              const cacheKey = `summary:t1:${repo.name}:${pf.path}:${pf.contentHash}`;
              const cached = await kvStore.get(cacheKey);
              if (cached) {
                tier1CacheHits++;
                try {
                  return { summaries: JSON.parse(cached) as Summary[], symbols: pf.symbols, sourceLines: null as string[] | null, filePath: pf.path };
                } catch {
                  // Corrupted cache entry; re-generate below
                }
              }
              try {
                const cachedSource = sourceTextCache.get(pf.path);
                sourceTextCache.delete(pf.path); // free after use
                const sourceText = cachedSource !== undefined
                  ? cachedSource
                  : isBareForTier1 && bareCommitForTier1
                    ? await getFileContent(repo.localPath, bareCommitForTier1, pf.path, { timeoutMs: 30_000 })
                    : await readFile(join(repo.localPath, pf.path), "utf-8");
                const summaries = tier1Summarize(pf.symbols, pf.path, sourceText);
                if (summaries.length > 0) {
                  await kvStore.set(cacheKey, JSON.stringify(summaries));
                }
                return { summaries, symbols: pf.symbols, sourceLines: needSnippets ? sourceText.split("\n") : null, filePath: pf.path };
              } catch {
                tier1ReadErrors++;
                return { summaries: [] as Summary[], symbols: pf.symbols, sourceLines: null as string[] | null, filePath: pf.path };
              }
            }),
          );
          for (const { summaries: tier1, symbols, sourceLines, filePath } of results) {
            for (const s of tier1) {
              summaryMap.set(s.entityId, s);
            }
            // Extract source snippets for tier-3 context
            if (sourceLines) {
              for (const sym of symbols) {
                if (sym.kind !== "function" && sym.kind !== "method" && sym.kind !== "class") continue;
                const entityId = sym.containerName
                  ? `${filePath}#${sym.containerName}.${sym.name}`
                  : `${filePath}#${sym.name}`;
                const start = Math.max(0, sym.startLine - 1);
                const end = Math.min(sourceLines.length, start + MAX_SNIPPET_LINES);
                sourceContextMap.set(entityId, sourceLines.slice(start, end).join("\n"));
              }
            }
          }
          const processed = Math.min(batchStart + BATCH_SIZE, parsedFiles.length);
          if (batchStart === 0 || processed % 1000 < BATCH_SIZE || processed === parsedFiles.length) {
            log(`    [tier-1] ${processed}/${parsedFiles.length}`);
          }
        }
        if (tier1CacheHits > 0) {
          log(`    [tier-1] ${tier1CacheHits} files served from cache`);
        }
        if (tier1ReadErrors > 0) {
          log(`    warning: ${tier1ReadErrors} files could not be read for tier-1 summarization`);
        }

        const tier1Count = summaryMap.size;
        sourceTextCache.clear(); // free memory after tier-1

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

        // Tier 3: Haiku LLM for low-confidence method summaries
        let tier3Count = 0;
        if (options.enrich && options.anthropicApiKey && (!sharedApiBudget || sharedApiBudget.remaining > 0)) {
          let tier3Candidates = [...summaryMap.entries()]
            .filter(([, s]) => shouldEscalateToTier3(s, undefined))
            .map(([entityId, s]) => ({
              entityId,
              description: s.description,
              context: sourceContextMap.get(entityId) ?? entityId,
            }));
          // Atomically reserve budget before async work
          if (sharedApiBudget) {
            const granted = sharedApiBudget.reserve(tier3Candidates.length);
            tier3Candidates = tier3Candidates.slice(0, granted);
          }
          if (tier3Candidates.length > 0) {
            log(`    Tier 3 (Haiku): upgrading ${tier3Candidates.length} low-confidence summaries`);
            const tier3Results = await tier3BatchSummarize(
              tier3Candidates,
              options.anthropicApiKey,
            );
            for (const s of tier3Results) {
              if (s.confidence > 0) {
                summaryMap.set(s.entityId, s);
                tier3Count++;
              }
            }
          }
        }
        sourceContextMap.clear(); // free snippet memory after tier-3

        // Tier 4: Sonnet for service-level summaries
        let tier4Count = 0;
        if (options.enrich && options.anthropicApiKey) {
          const services6b = servicesByRepo.get(repo.name);
          if (services6b && services6b.length > 0) {
            const inputs: ServiceSummaryInput[] = services6b.map((svc) => ({
              entityId: `service:${repo.name}/${svc.rootPath}`,
              serviceName: svc.name,
              methodSummaries: [...summaryMap!.values()]
                .filter((s) => s.entityId.startsWith(svc.rootPath))
                .slice(0, 20)
                .map((s) => s.description),
              dependencies: [...svc.dependencies],
              entryPoints: [...svc.entryPoints],
            }));
            // Atomically reserve budget before async work
            const tier4Budget = sharedApiBudget ? sharedApiBudget.reserve(inputs.length) : undefined;
            if (sharedApiBudget && tier4Budget === 0) {
              log(`    Tier 4: no API budget remaining, skipping`);
            } else {
              log(`    Tier 4 (Sonnet): summarizing ${inputs.length} services`);
              const tier4Result = await tier4BatchSummarize(inputs, {
                ...SONNET_DEFAULTS,
                apiKey: options.anthropicApiKey,
                kvStore,
                maxApiCalls: tier4Budget,
              });
              for (const s of tier4Result.summaries) {
                if (s.confidence > 0) {
                  summaryMap.set(s.entityId, s);
                  tier4Count++;
                }
              }
              // Refund unused budget
              if (sharedApiBudget && tier4Budget !== undefined) {
                const unused = tier4Budget - tier4Result.apiCallsMade;
                if (unused > 0) sharedApiBudget.refund(unused);
              }
              if (tier4Result.cacheHits > 0) {
                log(`    Tier 4: ${tier4Result.cacheHits} cache hits, ${tier4Result.apiCallsMade} API calls`);
              }
            }
          }
        }

        // Index summaries in search store for query support (batched to limit memory)
        const SEARCH_BATCH = 1000;
        const summaryValues = [...summaryMap.values()];
        for (let si = 0; si < summaryValues.length; si += SEARCH_BATCH) {
          const searchDocs = summaryValues.slice(si, si + SEARCH_BATCH).map((s) => ({
            id: s.entityId,
            content: `${s.entityId} ${s.description}`,
            metadata: { tier: String(s.tier), repo: repo.name },
          }));
          await options.searchStore.index(searchDocs);
        }

        const tierBreakdown = [
          `${tier1Count} tier-1`,
          `${tier2Total} tier-2 (${tier2Upgraded} upgraded)`,
          tier3Count > 0 ? `${tier3Count} tier-3` : null,
          tier4Count > 0 ? `${tier4Count} tier-4` : null,
        ].filter(Boolean).join(", ");
        log(`  [${repo.name}] Summaries: ${tierBreakdown}, ${summaryMap.size} total`);
      } catch (error) {
        console.error(`  Failed to generate summaries for ${repo.name}:`, error);
        failedRepoNames.add(repo.name);
      }
      phase6bTotalMs += Math.round(performance.now() - phase6bRepoStart);
    }

    // --- Phase 6c: Functional model ---
    {
      const services6c = servicesByRepo.get(repo.name);
      if (!services6c || services6c.length === 0) {
        log(`  [${repo.name}] [functional]: skipped (${!services6c ? "no services" : "0 services inferred"})`);
      } else {
        const phase6cRepoStart = performance.now();
        try {
          const svcSummaries = summaryMap ?? new Map<string, Summary>();
          const svcLogIndex = logIndex ?? { repo: repo.name, templates: [] };
          const catalog = buildServiceCatalog(services6c, svcSummaries, svcLogIndex);
          const docs = generateDocumentation(catalog, svcSummaries);
          await kvStore.set(`docs:functional:${repo.name}`, docs);
          await kvStore.set(`catalog:${repo.name}`, JSON.stringify(catalog));
          log(`  [${repo.name}] [functional]: ${catalog.length} catalog entries, ${docs.length} chars of documentation`);
        } catch (error) {
          console.error(`  Failed to build service catalog for ${repo.name}:`, error);
        }
        phase6cTotalMs += Math.round(performance.now() - phase6cRepoStart);
      }
    }

    // Track completion and release per-repo heap data
    completedRepos.add(repo.name);
    await kvStore.set(`pipelineComplete:${repo.name}`, "true");
    totalFiles += parsedFiles?.length ?? 0;

    parsedFilesByRepo.delete(repo.name);
    depGraphByRepo.delete(repo.name);
    servicesByRepo.delete(repo.name);
    patternsByRepo.delete(repo.name);
    flagsByRepo.delete(repo.name);
    logIndexByRepo.delete(repo.name);
    namingByRepo.delete(repo.name);
  })));

  log(`  Phase 6b total: ${phase6bTotalMs}ms`);
  log(`  Phase 6c total: ${phase6cTotalMs}ms`);

  // Phase 7: Cross-repo correlation (only meaningful with 2+ repos)
  let correlationResult: Awaited<ReturnType<typeof runCorrelation>> | undefined;
  if (repos.length > 1) {
    tracer.startPhase("Cross-repo Correlation");
    correlationResult = await runCorrelation(kvStore, options.graphStore, {
      repos, packageRoots, verbose,
    });
    if (verbose) {
      log(`  Cross-repo edges: ${correlationResult.counts.crossRepoEdges}`);
      log(`  Repo pairs: ${correlationResult.counts.repoPairs}`);
      log(`  Linchpins: ${correlationResult.counts.linchpins}`);
      log(`  SARIF findings: ${correlationResult.counts.sarifFindings}`);
    }
    tracer.record("crossRepoEdges", correlationResult.counts.crossRepoEdges);
    tracer.endPhase();

    // Phase 7b: Cross-repo model analysis
    tracer.startPhase("Cross-repo Models");
    const crossRepoModelsResult = await runCrossRepoModels(kvStore, {
      repos,
      crossRepoGraph: correlationResult.crossRepoGraph,
      serviceCorrelation: correlationResult.serviceCorrelation,
      verbose,
    });
    if (verbose) {
      log(`  Shared flags: ${crossRepoModelsResult.counts.sharedFlags}`);
      log(`  Fault links: ${crossRepoModelsResult.counts.faultLinks}`);
      log(`  Catalog entries: ${crossRepoModelsResult.counts.catalogEntries}`);
      log(`  SARIF findings: ${crossRepoModelsResult.counts.sarifFindings}`);
    }
    tracer.endPhase();
  }

  // Aggregate all per-repo SARIF into a combined latest result
  tracer.startPhase("SARIF Aggregation");
  const allSarifResults: import("@mma/core").SarifResult[] = [];
  const sarifRepoNames: string[] = [];
  const repoSarifCounts = new Map<string, Record<string, number>>();
  for (const repo of repos) {
    const repoResults: import("@mma/core").SarifResult[] = [];
    const counts: Record<string, number> = {};
    for (const key of ["config", "fault", "deadExports", "arch", "instability", "blastRadius", "hotspot", "temporal-coupling", "vuln"] as const) {
      const json = await kvStore.get(`sarif:${key}:${repo.name}`);
      if (json) {
        try {
          const results = JSON.parse(json) as import("@mma/core").SarifResult[];
          repoResults.push(...results);
          counts[key] = results.length;
        } catch {
          log(`    warning: could not parse sarif:${key}:${repo.name}`);
        }
      }
    }
    repoSarifCounts.set(repo.name, counts);
    if (repoResults.length > 0) {
      await kvStore.set(`sarif:repo:${repo.name}`, JSON.stringify(repoResults));
      sarifRepoNames.push(repo.name);
    }
    allSarifResults.push(...repoResults);
  }
  // Add cross-repo correlation SARIF (not per-repo)
  for (const crossRepoKey of ["sarif:correlation", "sarif:cross-repo-models"] as const) {
    const json = await kvStore.get(crossRepoKey);
    if (json) {
      try {
        const results = JSON.parse(json) as import("@mma/core").SarifResult[];
        allSarifResults.push(...results);
      } catch {
        log(`    warning: could not parse ${crossRepoKey}`);
      }
    }
  }
  // Deduplicate findings with identical fingerprints
  {
    const seen = new Set<string>();
    const deduped: typeof allSarifResults = [];
    for (const r of allSarifResults) {
      const fp = fingerprint(r);
      if (!seen.has(fp)) {
        seen.add(fp);
        deduped.push(r);
      }
    }
    if (deduped.length < allSarifResults.length) {
      log(`  Deduplicated: removed ${allSarifResults.length - deduped.length} duplicate findings`);
    }
    allSarifResults.length = 0;
    allSarifResults.push(...deduped);
  }

  // Compare against previous baseline for incremental adoption
  // (must run even when allSarifResults is empty to track "absent" results)
  let finalResults: import("@mma/core").SarifResult[] = allSarifResults;
  const previousJson = await kvStore.get("sarif:latest");
  if (previousJson) {
    try {
      const previousLog = JSON.parse(previousJson) as import("@mma/core").SarifLog;
      const previousResults = previousLog.runs.flatMap(r => r.results);
      finalResults = computeBaseline(allSarifResults, previousResults);
      const counts = { new: 0, unchanged: 0, updated: 0, absent: 0 };
      for (const r of finalResults) {
        if (r.baselineState) counts[r.baselineState]++;
      }
      log(`  Baseline: ${counts.new} new, ${counts.unchanged} unchanged, ${counts.updated} updated, ${counts.absent} absent`);
    } catch {
      log(`  warning: could not parse previous sarif:latest for baseline comparison`);
    }
  }

  // Stamp fingerprints on all results that lack them (SARIF spec compliance).
  // Runs after computeBaseline so "absent" results also get fingerprints.
  for (const r of finalResults) {
    if (!r.fingerprints) {
      (r as { fingerprints?: Record<string, string> }).fingerprints = { "mma/v1": fingerprint(r) };
    } else if (!r.fingerprints["mma/v1"]) {
      r.fingerprints["mma/v1"] = fingerprint(r);
    }
  }

  // Annotate all results with debtMinutes before writing
  const annotatedResults = annotateDebt(finalResults);

  if (annotatedResults.length > 0) {
    // Build rule descriptors from the unique ruleIds found in results
    const ruleIds = [...new Set(annotatedResults.map(r => r.ruleId))];
    // Build a lookup from known rule definitions (e.g., FAULT_RULES)
    const knownRules = new Map<string, import("@mma/core").SarifReportingDescriptor>();
    for (const rule of FAULT_RULES) {
      knownRules.set(rule.id, rule);
    }

    const ruleDescriptors: import("@mma/core").SarifReportingDescriptor[] = ruleIds.map(id => {
      const known = knownRules.get(id);
      if (known) return known;
      return {
        id,
        shortDescription: { text: id.replace("arch/", "Architectural: ").replace(/-/g, " ") },
      };
    });

    const sarifLog: import("@mma/core").SarifLog = {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "multi-model-analyzer", version: "0.1.0", rules: ruleDescriptors } },
        results: annotatedResults,
      }],
    };
    await kvStore.set("sarif:latest", JSON.stringify(sarifLog));
    log(`  Aggregated ${annotatedResults.length} SARIF results into sarif:latest`);
  }

  // Compute and store per-repo debt summaries
  {
    const repoDebtSummaries: import("@mma/diagnostics").RepoDebtSummary[] = [];
    for (const repo of repos) {
      const repoJson = await kvStore.get(`sarif:repo:${repo.name}`);
      if (repoJson) {
        try {
          const repoResults = JSON.parse(repoJson) as import("@mma/core").SarifResult[];
          const debtSummary = summarizeDebt(repo.name, repoResults);
          await kvStore.set(`debt:${repo.name}`, JSON.stringify(debtSummary));
          repoDebtSummaries.push(debtSummary);
        } catch {
          log(`    warning: could not parse sarif:repo:${repo.name} for debt summary`);
        }
      }
    }

    // System-wide debt summary
    const systemTotalMinutes = repoDebtSummaries.reduce((sum, s) => sum + s.totalMinutes, 0);
    const systemTotalHours = Math.round((systemTotalMinutes / 60) * 10) / 10;
    const systemDebt = {
      totalMinutes: systemTotalMinutes,
      totalHours: systemTotalHours,
      repos: repoDebtSummaries,
      computedAt: new Date().toISOString(),
    };
    await kvStore.set("debt:system", JSON.stringify(systemDebt));
    log(`  Total technical debt: ${systemTotalHours}h across ${repoDebtSummaries.length} repos`);
  }

  // Write per-repo index for decomposed reads (always, even when empty)
  await kvStore.set("sarif:latest:index", JSON.stringify({
    repos: sarifRepoNames,
    totalResults: finalResults.length,
    timestamp: new Date().toISOString(),
  }));

  tracer.record("sarifResults", allSarifResults.length);
  tracer.endPhase();
  // Compute Architectural Technical Debt Index (ATDI) scores
  tracer.startPhase("ATDI");
  {
    const repoAtdiScores: import("@mma/diagnostics").AtdiScore[] = [];
    for (const repo of repos) {
      // Read metrics summary (pain/uselessness zone counts + avgDistance)
      const summaryJson = await kvStore.get(`metricsSummary:${repo.name}`);
      let moduleCount = 0;
      let painZoneCount = 0;
      let uselessnessZoneCount = 0;
      let avgDistance = 0;
      let internalModuleCount: number | undefined;
      let internalPainZoneCount: number | undefined;
      let internalUselessnessZoneCount: number | undefined;
      if (summaryJson) {
        try {
          const s = JSON.parse(summaryJson) as RepoMetricsSummary;
          moduleCount = s.moduleCount;
          painZoneCount = s.painZoneCount;
          uselessnessZoneCount = s.uselessnessZoneCount;
          avgDistance = s.avgDistance;
          internalModuleCount = s.internalModuleCount;
          internalPainZoneCount = s.internalPainZoneCount;
          internalUselessnessZoneCount = s.internalUselessnessZoneCount;
        } catch { /* ignore malformed */ }
      }

      // Count SARIF findings by severity for this repo
      let errorCount = 0;
      let warningCount = 0;
      let noteCount = 0;
      const repoSarifJson = await kvStore.get(`sarif:repo:${repo.name}`);
      if (repoSarifJson) {
        try {
          const results = JSON.parse(repoSarifJson) as import("@mma/core").SarifResult[];
          for (const r of results) {
            if (r.level === "error") errorCount++;
            else if (r.level === "warning") warningCount++;
            else if (r.level === "note") noteCount++;
          }
        } catch { /* ignore malformed */ }
      }

      const atdi = computeRepoAtdi(
        repo.name, moduleCount, painZoneCount, uselessnessZoneCount,
        avgDistance, errorCount, warningCount, noteCount,
        internalModuleCount, internalPainZoneCount, internalUselessnessZoneCount,
      );
      repoAtdiScores.push(atdi);
      await kvStore.set(`atdi:${repo.name}`, JSON.stringify(atdi));
      log(`  [ATDI] ${repo.name}: ${atdi.score}/100 (modules=${atdi.moduleCount}, errors=${errorCount}, warnings=${warningCount}, notes=${noteCount})`);
    }

    const systemAtdi = computeSystemAtdi(repoAtdiScores);
    await kvStore.set("atdi:system", JSON.stringify(systemAtdi));
    log(`  [ATDI] System score: ${systemAtdi.score}/100 across ${repoAtdiScores.length} repos`);
  }
  tracer.endPhase();

  // Store pipeline trace for observability
  const trace = tracer.finalize();
  await kvStore.set("pipeline:trace:latest", JSON.stringify(trace));
  if (verbose) {
    log(PipelineTracer.formatSummary(trace));
  }

  // Phase 8: LLM narration (optional, requires Anthropic API key)
  if (options.anthropicApiKey) {
    tracer.startPhase("Narration");
    const narrationStart = performance.now();
    const repoInputs: RepoNarrationInput[] = [];

    for (const repo of repos) {
      const patternsJson = await kvStore.get(`patterns:${repo.name}`);
      const patterns: string[] = patternsJson
        ? (JSON.parse(patternsJson) as Array<{ kind: string }>).map((p) => p.kind)
        : [];

      const summaryJson = await kvStore.get(`metricsSummary:${repo.name}`);
      const metricsSummary = summaryJson ? JSON.parse(summaryJson) as RepoNarrationInput["metricsSummary"] : null;

      const sarifCounts = repoSarifCounts.get(repo.name) ?? {};

      // Recover service names + summaries from tier-4 cache
      const services: string[] = [];
      const serviceSummaries: string[] = [];
      const t4Keys = await kvStore.keys("summary:t4:");
      for (const k of t4Keys) {
        const val = await kvStore.get(k);
        if (val) {
          try {
            const s = JSON.parse(val) as { entityId: string; description: string };
            const repoServicePrefix = `service:${repo.name}/`;
            if (s.entityId.startsWith(repoServicePrefix)) {
              services.push(s.entityId.slice(repoServicePrefix.length));
              if (s.description) serviceSummaries.push(s.description);
            }
          } catch { /* skip malformed */ }
        }
      }

      // Cross-repo edge count for this repo
      let crossRepoEdges = 0;
      const corrGraphJson = await kvStore.get("correlation:graph");
      if (corrGraphJson) {
        try {
          const cg = JSON.parse(corrGraphJson) as { edges: Array<{ source: string; target: string }> };
          crossRepoEdges = cg.edges.filter(
            (e) => e.source.startsWith(repo.name) || e.target.startsWith(repo.name),
          ).length;
        } catch { /* skip */ }
      }

      repoInputs.push({ repo: repo.name, patterns, metricsSummary, sarifCounts, services, serviceSummaries, crossRepoEdges });
    }

    // System overview input
    let systemInput: SystemNarrationInput | undefined;
    if (repos.length > 1) {
      const corrServicesJson = await kvStore.get("correlation:services");
      const linchpins: string[] = [];
      let crossRepoEdgeCount = 0;
      if (corrServicesJson) {
        try {
          const cs = JSON.parse(corrServicesJson) as { linchpins: string[] };
          linchpins.push(...cs.linchpins);
        } catch { /* skip */ }
      }
      const corrGraphJson = await kvStore.get("correlation:graph");
      if (corrGraphJson) {
        try {
          const cg = JSON.parse(corrGraphJson) as { edges: unknown[] };
          crossRepoEdgeCount = cg.edges.length;
        } catch { /* skip */ }
      }
      systemInput = {
        repoNames: repos.map((r) => r.name),
        totalFindings: allSarifResults.length,
        crossRepoEdgeCount,
        linchpins,
      };
    }

    const narrationResults = await narrateAll(repoInputs, systemInput, {
      apiKey: options.anthropicApiKey,
      kvStore,
      force: options.narrateForce,
    });

    const cached = narrationResults.filter((r) => r.cached).length;
    const generated = narrationResults.length - cached;
    const narrationMs = Math.round(performance.now() - narrationStart);
    log(`  Phase 8 narration: ${narrationResults.length} total (${generated} generated, ${cached} cached) in ${narrationMs}ms`);
    tracer.record("narrationsGenerated", generated);
    tracer.record("narrationsCached", cached);
    tracer.endPhase();
  }

  // Determine if any repo had actual file changes
  const hadChanges = changeSets.some(
    (cs) => cs.addedFiles.length > 0 || cs.modifiedFiles.length > 0 || cs.deletedFiles.length > 0,
  );

  log("Indexing complete.");
  return {
    hadChanges,
    repoCount: repos.length,
    totalFiles,
    totalSarifResults: allSarifResults.length,
    failedRepos: failedRepoNames.size,
  };
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
    } else if (node.type === "public_field_definition") {
      // Class arrow property: handler = async (req) => {}
      const arrowChild = node.namedChildren.find((c) => c.type === "arrow_function");
      if (arrowChild) {
        const nameNode = node.namedChildren.find(
          (c) => c.type === "property_identifier" || c.type === "identifier",
        );
        const name = nameNode?.text ?? `anon_${node.startPosition.row}`;
        results.push({ name, node: arrowChild });
      }
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
      } else if (parent?.type === "export_statement") {
        // Exported default arrow: export default (req) => {}
        name = "default_export";
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

function detectMissingErrorBoundaries(
  cfgs: ReadonlyMap<string, ControlFlowGraph>,
  repo: string,
): SarifResult[] {
  const results: SarifResult[] = [];

  for (const [functionId, cfg] of cfgs) {
    const hasAwait = cfg.nodes.some(n => n.kind === "statement" && /\bawait\b/.test(n.label));
    if (!hasAwait) continue;

    const hasTryCatch = cfg.nodes.some(n => n.kind === "catch" || n.kind === "try");
    if (hasTryCatch) continue;

    results.push(
      createSarifResult(
        "fault/missing-error-boundary",
        "warning",
        `Async function ${functionId} uses await but has no try/catch error boundary`,
        {
          locations: [{
            logicalLocations: [
              createLogicalLocation(repo, functionId.split("#")[0] ?? "", functionId),
            ],
          }],
        },
      ),
    );
  }

  return results;
}
