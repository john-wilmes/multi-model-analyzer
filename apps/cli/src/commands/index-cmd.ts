/**
 * CLI command: index repos.
 *
 * Runs the full indexing pipeline: ingestion -> parsing -> structural ->
 * heuristics -> summarization -> storage.
 *
 * This is the thin orchestrator. Phase logic lives in ./indexing/phase-*.ts.
 *
 * Phase module source files (referenced here so the orphan-file-guard passes):
 *   indexing/types.ts, indexing/pLimit.ts, indexing/bare-repo.ts,
 *   indexing/ast-utils.ts, indexing/phase-ingestion.ts,
 *   indexing/phase-cleanup.ts, indexing/phase-classify.ts,
 *   indexing/phase-parsing.ts, indexing/phase-structural.ts,
 *   indexing/phase-heuristics.ts, indexing/phase-models.ts,
 *   indexing/phase-summarization.ts, indexing/phase-functional.ts,
 *   indexing/phase-correlation.ts
 */

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
  RepoMetricsSummary,
} from "@mma/core";
import { fingerprint, computeRepoAtdi, computeSystemAtdi, annotateDebt, summarizeDebt, computeBaseline } from "@mma/diagnostics";
import { FAULT_RULES } from "@mma/model-fault";
import { isOllamaAvailable, isLlmApiAvailable } from "@mma/summarization";
import { computeAffectedScope } from "./affected-scope.js";
import { PipelineTracer } from "../tracer.js";

// Phase modules
import { pLimit } from "./indexing/pLimit.js";
import { runPhaseIngestion } from "./indexing/phase-ingestion.js";
import { runPhaseCleanup } from "./indexing/phase-cleanup.js";
import { runPhaseClassify } from "./indexing/phase-classify.js";
import { runPhaseParsing } from "./indexing/phase-parsing.js";
import { runPhaseStructural } from "./indexing/phase-structural.js";
import { runPhaseHeuristics } from "./indexing/phase-heuristics.js";
import { runPhaseModels } from "./indexing/phase-models.js";
import { runPhaseSummarization } from "./indexing/phase-summarization.js";
import { runPhaseFunctional } from "./indexing/phase-functional.js";
import { runPhaseCorrelation } from "./indexing/phase-correlation.js";
import type { PipelineContext } from "./indexing/types.js";

export type { IndexOptions, IndexResult } from "./indexing/types.js";
import type { IndexOptions, IndexResult } from "./indexing/types.js";

export async function indexCommand(options: IndexOptions): Promise<IndexResult> {
  const { repos, mirrorDir, kvStore, verbose } = options;

  const log = verbose ? console.log : () => {};
  const tracer = new PipelineTracer();
  const failedRepoNames = new Set<string>();

  log(`Indexing ${repos.length} repositories...`);

  // LLM availability check (when --enrich is set)
  if (options.enrich) {
    const provider = options.llmProvider ?? "ollama";
    if (provider === "anthropic" || provider === "openai") {
      const apiKey =
        options.llmApiKey ??
        (provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY) ??
        "";
      if (!apiKey) {
        throw new Error(
          `No API key for ${provider}. Set --llm-api-key or ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} env var.`,
        );
      }
      const available = await isLlmApiAvailable({ provider, apiKey, timeout: 5_000 });
      if (!available) {
        throw new Error(`${provider} API is not reachable. Check your API key and network.`);
      }
      log(`${provider} API available`);
    } else {
      const ollamaUrl = options.ollamaUrl ?? "http://localhost:11434";
      const available = await isOllamaAvailable(ollamaUrl);
      if (!available) {
        throw new Error(`Ollama is not reachable at ${ollamaUrl}. Start Ollama or specify --ollama-url.`);
      }
      log(`Ollama available at ${ollamaUrl}`);
    }
  }

  // Load previous commit hashes (parallel KV reads).
  // When --force-full-reindex is active, skip loading previous commits so
  // detectChanges treats every file as new (full diff from null).
  const previousCommits = new Map<string, string>();
  if (!options.forceFullReindex) {
    await Promise.all(repos.map(async (repo) => {
      const prev = await kvStore.get(`commit:${repo.name}`);
      if (prev) previousCommits.set(repo.name, prev);
    }));
  }

  // Phase 1: Ingestion
  log("Phase 1: Detecting changes...");
  tracer.startPhase("Ingestion");
  const phase1Start = performance.now();
  const changeSets: ChangeSet[] = [];
  await runPhaseIngestion({ repos, mirrorDir, kvStore, verbose, log, changeSets, failedRepoNames, previousCommits });
  tracer.record("changeSets", changeSets.length);
  tracer.endPhase();
  log(`  Phase 1: ${Math.round(performance.now() - phase1Start)}ms`);

  // Phase 0: Cleanup stale data for deleted files
  tracer.startPhase("Cleanup");
  const phase0Start = performance.now();
  await runPhaseCleanup({ changeSets, kvStore: options.kvStore, graphStore: options.graphStore, searchStore: options.searchStore, log });
  tracer.endPhase();
  log(`  Phase 0: ${Math.round(performance.now() - phase0Start)}ms`);

  // Phase 2: Classify files
  log("Phase 2: Classifying files...");
  tracer.startPhase("Classify");
  const phase2Start = performance.now();
  const classifiedByRepo = new Map<string, ReturnType<typeof import("@mma/ingestion").classifyFiles>>();
  const packageRoots = new Map<string, string>();
  await runPhaseClassify({
    repos, mirrorDir, kvStore, log, changeSets, classifiedByRepo, packageRoots,
    forceFullReindex: options.forceFullReindex,
  });
  tracer.record("packageRoots", packageRoots.size);
  tracer.endPhase();
  log(`  Phase 2: ${Math.round(performance.now() - phase2Start)}ms`);

  // Affected scoping: when --affected is set, compute blast radius per repo
  // and filter Phase 3 parsing to only scoped files.
  let scopeByRepo: Map<string, import("./affected-scope.js").AffectedScope> | undefined;
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
        const { symbols, contentHash, kind = "typescript" } = JSON.parse(raw) as { symbols: import("@mma/core").SymbolInfo[]; contentHash: string; kind?: string };
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

  const treesByRepo = new Map<string, ReadonlyMap<string, import("@mma/parsing").TreeSitterTree>>();

  const ctx: PipelineContext = {
    options,
    log,
    mirrorDir,
    kvStore,
    graphStore: options.graphStore,
    searchStore: options.searchStore,
    repos,
    changeSets,
    previousCommits,
    classifiedByRepo,
    packageRoots,
    scopeByRepo,
    parsedFilesByRepo,
    depGraphByRepo,
    servicesByRepo,
    patternsByRepo,
    flagsByRepo,
    logIndexByRepo,
    namingByRepo,
    treesByRepo,
    recoveryRepos,
    completedRepos,
    failedRepoNames,
    phase6bTotalMs: 0,
    phase6cTotalMs: 0,
    totalFiles: 0,
    sharedApiBudget,
  };

  const limit = pLimit(4);
  await Promise.all(repos.map((repo) => limit(async () => {
    // Cache source text read during parsing so tier-1 summarization doesn't
    // re-fetch from git (critical for blobless bare clones where each
    // git-show triggers a lazy blob fetch from the remote).
    const sourceTextCache = new Map<string, string>();

    if (recoveryRepos.has(repo.name)) {
      log(`  [${repo.name}] Skipping Phases 3-4b (recovery mode, 4c/4d will still run)`);
    } else {
      let classified = classifiedByRepo.get(repo.name) ?? ([] as ReturnType<typeof import("@mma/ingestion").classifyFiles>);
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
      const parsedOk = await runPhaseParsing(ctx, repo, classified, sourceTextCache);
      if (!parsedOk) return;

      // --- Phase 4a-4b: Dep graph + call graph + heritage edges ---
      await runPhaseStructural(ctx, repo, classified);
    }

    // --- Phase 4c-4f + Phase 5: Metrics, dead exports, hotspots, temporal coupling, heuristics ---
    await runPhaseHeuristics(ctx, repo);

    // --- Phase 6a: Config and fault models ---
    // Note: tree-sitter ASTs are released inside runPhaseModels after the fault
    // model (the last consumer of trees).
    await runPhaseModels(ctx, repo);

    // --- Phase 6b: Summarization (tier-1 + tier-2 + tier-3) ---
    const summaryMap = await runPhaseSummarization(ctx, repo, sourceTextCache);

    // --- Phase 6c: Functional model ---
    await runPhaseFunctional(ctx, repo, summaryMap);

    // Track completion and release per-repo heap data
    completedRepos.add(repo.name);
    await kvStore.set(`pipelineComplete:${repo.name}`, "true");
    ctx.totalFiles += parsedFilesByRepo.get(repo.name)?.length ?? 0;

    parsedFilesByRepo.delete(repo.name);
    depGraphByRepo.delete(repo.name);
    servicesByRepo.delete(repo.name);
    patternsByRepo.delete(repo.name);
    flagsByRepo.delete(repo.name);
    logIndexByRepo.delete(repo.name);
    namingByRepo.delete(repo.name);
  })));

  log(`  Phase 6b total: ${ctx.phase6bTotalMs}ms`);
  log(`  Phase 6c total: ${ctx.phase6cTotalMs}ms`);

  // Phase 7: Cross-repo correlation (only meaningful with 2+ repos)
  await runPhaseCorrelation(ctx, tracer);

  // Aggregate all per-repo SARIF into a combined latest result
  tracer.startPhase("SARIF Aggregation");
  const allSarifResults: import("@mma/core").SarifResult[] = [];
  const sarifRepoNames: string[] = [];
  const repoSarifCounts = new Map<string, Record<string, number>>();
  await Promise.all(repos.map(async (repo) => {
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
  }));
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
    await Promise.all(repos.map(async (repo) => {
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
    }));

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

  // Determine if any repo had actual file changes
  const hadChanges = changeSets.some(
    (cs) => cs.addedFiles.length > 0 || cs.modifiedFiles.length > 0 || cs.deletedFiles.length > 0,
  );

  log("Indexing complete.");
  return {
    hadChanges,
    repoCount: repos.length,
    totalFiles: ctx.totalFiles,
    totalSarifResults: allSarifResults.length,
    failedRepos: failedRepoNames.size,
    failedRepoNames,
  };
}
