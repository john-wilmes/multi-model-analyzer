/**
 * Phase 6a: Config model (feature flags) and fault model (log traces + CFGs).
 * Also releases tree-sitter ASTs after this phase (last consumer of trees).
 */

import { join } from "node:path";
import type { RepoConfig, SarifResult, CallGraph } from "@mma/core";
import { buildFeatureModel, extractConstraintsFromCode, validateFeatureModel } from "@mma/model-config";
import { identifyLogRoots, traceBackwardFromLog, buildFaultTree, analyzeGaps, analyzeCascadingRisk, FAULT_RULES } from "@mma/model-fault";
import { buildControlFlowGraph, createCfgIdCounter } from "@mma/structural";
import { findFunctionNodes, detectMissingErrorBoundaries } from "./ast-utils.js";
import type { PipelineContext } from "./types.js";

export async function runPhaseModels(
  ctx: PipelineContext,
  repo: RepoConfig,
): Promise<void> {
  const { log, mirrorDir, kvStore, graphStore, options } = ctx;
  const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
  const trees = ctx.treesByRepo.get(repo.name);
  const flagInventory = ctx.flagsByRepo.get(repo.name);
  const logIndex = ctx.logIndexByRepo.get(repo.name);
  const depGraph = ctx.depGraphByRepo.get(repo.name);

  const phase6aStart = performance.now();

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
      const cfgs = new Map<string, import("@mma/core").ControlFlowGraph>();
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
      const repoCallEdges = await graphStore.getEdgesByKind("calls", repo.name);
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
    ctx.treesByRepo.delete(repo.name);
    log(`  [${repo.name}] Released tree-sitter ASTs`);
  }
}
