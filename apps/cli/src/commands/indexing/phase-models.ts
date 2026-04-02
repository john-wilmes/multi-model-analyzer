/**
 * Phase 6a: Config model (feature flags) and fault model (log traces + CFGs).
 * Also releases tree-sitter ASTs after this phase (last consumer of trees).
 */

import type { RepoConfig, SarifResult, CallGraph } from "@mma/core";
import {
  extractConfigSchemas,
  extractCredentialAccesses,
  buildConstraintSets,
  extractMongooseSettingsSchema,
  extractMongooseAccountSettingsSchema,
  extractSettingsAccesses,
  buildSettingsConstraintSet,
  extractAccountSettingsAccesses,
  buildAccountSettingsConstraintSet,
  detectCrossEntityDependencies,
  makeCredentialFieldExtractor,
  makeSettingsFieldExtractor,
  makeAccountSettingsFieldExtractor,
} from "@mma/constraints";
import type { ConfigSchema, CredentialAccess } from "@mma/constraints";
import { buildFeatureModel, extractConstraintsFromCode, validateFeatureModel } from "@mma/model-config";
import { identifyLogRoots, traceBackwardFromLog, buildFaultTree, analyzeGaps, analyzeCascadingRisk } from "@mma/model-fault";
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

  // --- ISC constraint extraction (runs independently of feature model) ---
  // Uses tree-sitter trees for source text (works with both bare git mirrors and working trees)
  if (trees && trees.size > 0) {
    const configFiles: { path: string; content: string }[] = [];
    const settingModelFiles: { path: string; content: string }[] = [];
    const allFiles: { path: string; content: string }[] = [];
    for (const [filePath, tree] of trees) {
      const content = tree.rootNode.text;
      allFiles.push({ path: filePath, content });
      if (filePath.includes('/context/configuration.')) {
        configFiles.push({ path: filePath, content });
      }
      if (/models\/setting\.[jt]sx?$/.test(filePath)) {
        settingModelFiles.push({ path: filePath, content });
      }
    }

    // Hoisted access results for cross-entity detection (Step 2c)
    let credentialAccesses: readonly CredentialAccess[] = [];
    let settingsAccesses: readonly CredentialAccess[] = [];
    let accountSettingsAccesses: readonly CredentialAccess[] = [];

    // --- ISC credential constraints ---
    if (configFiles.length > 0) {
      try {
        const schemaResult = await extractConfigSchemas(configFiles);
        const accessResult = await extractCredentialAccesses(allFiles);
        credentialAccesses = accessResult.accesses;
        const { constraintSets } = buildConstraintSets(schemaResult.schemas, accessResult.accesses);

        if (constraintSets.length > 0) {
          await kvStore.set(`constraints:${repo.name}`, JSON.stringify(constraintSets));
        }
        log(`  [${repo.name}] [constraints] ${constraintSets.length} sets (${schemaResult.schemas.length} schemas, ${accessResult.stats.totalAccesses} accesses)`);
      } catch (err) {
        log(`  [${repo.name}] [constraints] extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Mongoose settings schema extraction (runs on model-repository) ---
    // Key is intentionally global (not repo-scoped): the Setting model lives in
    // model-repository only, but other repos (integrator-service-clients) read it
    // during the constraints step below. Repos are indexed sequentially.
    if (settingModelFiles.length > 0) {
      try {
        const schemaResult = await extractMongooseSettingsSchema(settingModelFiles);
        const settingsSchema = schemaResult.schemas[0];
        if (settingsSchema) {
          await kvStore.set('schema:settings:integrator', JSON.stringify(settingsSchema));
          log(`  [${repo.name}] [settings-schema] integrator: ${settingsSchema.fields.length} fields extracted`);
        }
      } catch (err) {
        log(`  [${repo.name}] [settings-schema] integrator extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const accountSchemaResult = await extractMongooseAccountSettingsSchema(settingModelFiles);
        const accountSchema = accountSchemaResult.schemas[0];
        if (accountSchema) {
          await kvStore.set('schema:settings:account', JSON.stringify(accountSchema));
          log(`  [${repo.name}] [settings-schema] account: ${accountSchema.fields.length} fields extracted`);
        }
      } catch (err) {
        log(`  [${repo.name}] [settings-schema] account extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Integrator settings constraints (runs on repos with settings accesses) ---
    try {
      const settingsAccessResult = await extractSettingsAccesses(allFiles);
      settingsAccesses = settingsAccessResult.accesses;
      if (settingsAccessResult.accesses.length > 0) {
        const schemaJson = await kvStore.get('schema:settings:integrator');
        const schema: ConfigSchema | undefined = schemaJson ? JSON.parse(schemaJson) : undefined;
        const constraintSet = buildSettingsConstraintSet(schema, settingsAccessResult.accesses);
        await kvStore.set(`constraints:settings:integrator:${repo.name}`, JSON.stringify(constraintSet));
        log(`  [${repo.name}] [settings-constraints] integrator: ${constraintSet.fields.length} fields (${settingsAccessResult.stats.totalAccesses} accesses${schema ? ', schema merged' : ', no schema'})`);
      }
    } catch (err) {
      log(`  [${repo.name}] [settings-constraints] integrator extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- Account settings constraints (runs on repos with account settings accesses) ---
    try {
      const accountAccessResult = await extractAccountSettingsAccesses(allFiles);
      accountSettingsAccesses = accountAccessResult.accesses;
      if (accountAccessResult.accesses.length > 0) {
        const schemaJson = await kvStore.get('schema:settings:account');
        const schema: ConfigSchema | undefined = schemaJson ? JSON.parse(schemaJson) : undefined;
        const constraintSet = buildAccountSettingsConstraintSet(schema, accountAccessResult.accesses);
        await kvStore.set(`constraints:settings:account:${repo.name}`, JSON.stringify(constraintSet));
        log(`  [${repo.name}] [settings-constraints] account: ${constraintSet.fields.length} fields (${accountAccessResult.stats.totalAccesses} accesses${schema ? ', schema merged' : ', no schema'})`);
      }
    } catch (err) {
      log(`  [${repo.name}] [settings-constraints] account extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- Cross-entity constraint detection ---
    try {
      const crossEntityResult = detectCrossEntityDependencies(
        credentialAccesses,
        settingsAccesses,
        accountSettingsAccesses,
        {
          credentials: makeCredentialFieldExtractor(),
          settings: makeSettingsFieldExtractor(),
          accountSettings: makeAccountSettingsFieldExtractor(),
        },
      );
      // Persist even when empty to distinguish "no dependencies" from "not indexed"
      await kvStore.set(`constraints:cross-entity:${repo.name}`, JSON.stringify(crossEntityResult));
      log(`  [${repo.name}] [cross-entity] ${crossEntityResult.dependencies.length} dependencies (${crossEntityResult.stats.crossEntityAccesses}/${crossEntityResult.stats.totalAccesses} accesses)`);
    } catch (err) {
      log(`  [${repo.name}] [cross-entity] detection failed: ${err instanceof Error ? err.message : String(err)}`);
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
