/**
 * Phase 6a: Config model (feature flags) and fault model (log traces + CFGs).
 * Also releases tree-sitter ASTs after this phase (last consumer of trees).
 */

import type { RepoConfig, SarifResult, CallGraph } from "@mma/core";
import { createSarifResult, createLogicalLocation } from "@mma/core";
import { buildFeatureModel, extractConstraintsFromCode, validateFeatureModel } from "@mma/model-config";
import { identifyLogRoots, traceBackwardFromLog, buildFaultTree, faultTreeToCodeFlow, analyzeGaps, analyzeCascadingRisk, analyzeTimeoutMissing, analyzeRetryWithoutBackoff, analyzeUncheckedNullReturn, analyzeLogCoOccurrence } from "@mma/model-fault";
import { buildControlFlowGraph, createCfgIdCounter } from "@mma/structural";
import { findFunctionNodes, detectMissingErrorBoundaries } from "./ast-utils.js";
import type { PipelineContext } from "./types.js";

export async function runPhaseModels(
  ctx: PipelineContext,
  repo: RepoConfig,
): Promise<void> {
  const { log, kvStore, graphStore } = ctx;
  const trees = ctx.treesByRepo.get(repo.name);
  const flagInventory = ctx.flagsByRepo.get(repo.name);
  const configInventory = ctx.settingsByRepo.get(repo.name);
  const logIndex = ctx.logIndexByRepo.get(repo.name);
  const depGraph = ctx.depGraphByRepo.get(repo.name);

  const phase6aStart = performance.now();

  // Config model — runs when flags OR settings are available
  const hasFlags = flagInventory && flagInventory.flags.length > 0;
  const hasSettings = configInventory && configInventory.parameters.length > 0;
  if (!depGraph || (!hasFlags && !hasSettings)) {
    log(`  [${repo.name}] [config]: skipped (${!depGraph ? "no dep graph" : "no flags or settings found"})`);
  }
  if (depGraph && (hasFlags || hasSettings)) {
    try {
      // Build unified feature model from flags + settings
      const effectiveInventory = flagInventory ?? { repo: repo.name, flags: [] };
      let featureModel = buildFeatureModel(effectiveInventory, depGraph, configInventory);

      if (trees && trees.size > 0) {
        const codeConstraints = extractConstraintsFromCode(
          trees,
          featureModel.flags,
          configInventory?.parameters,
        );
        if (codeConstraints.length > 0) {
          featureModel = {
            flags: featureModel.flags,
            constraints: [
              ...featureModel.constraints,
              ...codeConstraints.map((c) => c.constraint),
            ],
            ...(featureModel.parameters ? { parameters: featureModel.parameters } : {}),
          };
        }
      }

      const { results: configResults, validation } = await validateFeatureModel(featureModel, repo.name);
      await kvStore.set(`sarif:config:${repo.name}`, JSON.stringify(configResults));

      // Persist the config model so MCP tools can retrieve it
      await kvStore.set(`config-model:${repo.name}`, JSON.stringify(featureModel));

      const paramCount = featureModel.parameters?.length ?? 0;
      log(`  [${repo.name}] [config]: ${featureModel.flags.length} flags, ${paramCount} params, ${featureModel.constraints.length} constraints, ${configResults.length} findings`);
      log(`    dead=${validation.deadFlags.length} always-on=${validation.alwaysOnFlags.length} untested=${validation.inferredUntestedPairs.length} unused-registry=${validation.unusedRegistryFlags.length} unregistered=${validation.unregisteredFlags.length}`);
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

      // Build CFGs for files containing log templates
      const logFiles = new Set<string>();
      for (const tmpl of logIndex.templates) {
        for (const loc of tmpl.locations) {
          logFiles.add(loc.module);
        }
      }

      const cfgCounter = createCfgIdCounter();
      const cfgs = new Map<string, import("@mma/core").ControlFlowGraph>();

      // Helper: build CFGs for all functions in a file
      const buildCfgsForFile = (filePath: string) => {
        const tree = trees.get(filePath);
        if (!tree) return;
        const fnNodes = findFunctionNodes(tree.rootNode);
        for (const fnNode of fnNodes) {
          const functionId = `${filePath}#${fnNode.name}`;
          if (!cfgs.has(functionId)) {
            const cfg = buildControlFlowGraph(fnNode.node, functionId, repo.name, filePath, cfgCounter);
            cfgs.set(functionId, cfg);
          }
        }
      };

      for (const filePath of logFiles) {
        if (!trees.has(filePath)) {
          log(`    warning: no tree-sitter tree for log file ${filePath} (skipping CFG build)`);
          continue;
        }
        buildCfgsForFile(filePath);
      }

      // Fetch call edges once and strip the "repo:" prefix so source/target
      // match bare CFG function IDs ("filePath#fn" not "repo:filePath#fn").
      const repoPrefix = `${repo.name}:`;
      const stripRepo = (id: string) => (id.startsWith(repoPrefix) ? id.slice(repoPrefix.length) : id);
      const rawCallEdges = await graphStore.getEdgesByKind("calls", repo.name);
      const normalizedCallEdges = rawCallEdges.map((e) => ({
        ...e,
        source: stripRepo(e.source),
        target: stripRepo(e.target),
      }));

      // Expand CFG frontier to caller files so inter-procedural tracing works
      // across file boundaries (up to MAX_INTERPROCEDURAL_DEPTH = 3 hops)
      const builtFiles = new Set(logFiles);
      for (let hop = 0; hop < 3; hop++) {
        const currentFunctions = new Set(cfgs.keys());
        const newFiles = new Set<string>();
        for (const edge of normalizedCallEdges) {
          if (currentFunctions.has(edge.target)) {
            const callerFile = edge.source.split("#")[0] ?? "";
            if (callerFile && !builtFiles.has(callerFile) && trees.has(callerFile)) {
              newFiles.add(callerFile);
            }
          }
        }
        if (newFiles.size === 0) break;
        for (const filePath of newFiles) {
          buildCfgsForFile(filePath);
          builtFiles.add(filePath);
        }
      }

      const callGraph: CallGraph = {
        repo: repo.name,
        edges: normalizedCallEdges,
        nodeCount: new Set(normalizedCallEdges.flatMap((e) => [e.source, e.target])).size,
      };

      const faultTrees = [];
      const allTraces: import("@mma/model-fault").BackwardTrace[] = [];
      const failCounts = new Map<string, number>();
      for (const root of logRoots) {
        const trace = traceBackwardFromLog(root, cfgs, callGraph);
        allTraces.push(trace);
        if (trace.steps.length > 0) {
          faultTrees.push(buildFaultTree(trace, repo.name));
        } else if (trace.failReason) {
          failCounts.set(trace.failReason, (failCounts.get(trace.failReason) ?? 0) + 1);
        }
      }
      if (failCounts.size > 0) {
        const breakdown = [...failCounts.entries()].map(([reason, count]) => `${count} ${reason}`).join(", ");
        const totalFailed = [...failCounts.values()].reduce((a, b) => a + b, 0);
        log(`    trace failures: ${breakdown} (${totalFailed}/${logRoots.length} total)`);
      }

      // Collect all fault SARIF results
      const faultResults: SarifResult[] = [];

      // Fault trees → SARIF results with codeFlows for execution traces
      for (const tree of faultTrees) {
        const codeFlow = faultTreeToCodeFlow(tree);
        const topLoc = tree.topEvent.location;
        faultResults.push(
          createSarifResult(
            "fault/traced-error-path",
            "note",
            `Error path traced from: ${tree.topEvent.label}`,
            {
              locations: topLoc ? [{
                logicalLocations: [
                  createLogicalLocation(topLoc.repo, topLoc.module, topLoc.fullyQualifiedName ?? topLoc.module),
                ],
              }] : [],
              codeFlows: [codeFlow],
            },
          ),
        );
      }

      // Gap analysis (unhandled-error-path + silent-failure)
      faultResults.push(...analyzeGaps(cfgs, repo.name));

      // Cascading failure risk from cross-service calls
      faultResults.push(...analyzeCascadingRisk(allTraces, repo.name));

      // Missing error boundaries (async functions without try/catch)
      faultResults.push(...detectMissingErrorBoundaries(cfgs, repo.name));

      // Outbound HTTP calls without timeout
      faultResults.push(...analyzeTimeoutMissing(cfgs, repo.name));

      // Retry loops with fixed delay (no backoff)
      faultResults.push(...analyzeRetryWithoutBackoff(cfgs, repo.name));

      // Database queries without null guard
      faultResults.push(...analyzeUncheckedNullReturn(cfgs, repo.name));

      // Log co-occurrence analysis
      const coOccurrence = analyzeLogCoOccurrence(logIndex, callGraph, allTraces);
      if (coOccurrence.groups.length > 0) {
        await kvStore.set(`logCoOccurrence:${repo.name}`, JSON.stringify(coOccurrence));
        log(`    log co-occurrence: ${coOccurrence.groups.length} groups found`);
      }

      await kvStore.set(`sarif:fault:${repo.name}`, JSON.stringify(faultResults));
      await kvStore.set(`faultTrees:${repo.name}`, JSON.stringify(faultTrees));

      log(`  [${repo.name}] [fault]: ${logRoots.length} log roots, ${cfgs.size} CFGs, ${faultTrees.length} fault trees (${faultTrees.length} with codeFlows), ${faultResults.length} fault findings`);
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
    ctx.treesByRepo.delete(repo.name);
    log(`  [${repo.name}] Released tree-sitter ASTs`);
  }
}
