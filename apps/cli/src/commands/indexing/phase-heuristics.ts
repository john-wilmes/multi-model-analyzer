/**
 * Phase 4c-4f + Phase 5: Module metrics, dead exports, hotspots, temporal coupling,
 * service inference, patterns, flags, logs, naming, topology, arch rules, PageRank,
 * vulnerability reachability.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { RepoConfig } from "@mma/core";
import { getFileContent, getCommitHistory } from "@mma/ingestion";
import {
  computeModuleMetrics,
  summarizeRepoMetrics,
  detectDeadExports,
  detectInstabilityViolations,
} from "@mma/structural";
import {
  inferServicesWithMeta,
  detectPatternsWithMeta,
  scanForFlags,
  extractFlagRegistry,
  extractFlagRegistryFromText,
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
import type { PackageJsonInfo, CommitInfo, InstalledPackage } from "@mma/heuristics";
import { hotspotFindings } from "@mma/diagnostics";
import { computePageRank, pageRankToSarif, computeReachCounts } from "@mma/query";
import { checkBareRepo, resolveCommitForBare } from "./bare-repo.js";
import type { PipelineContext } from "./types.js";

export async function runPhaseHeuristics(
  ctx: PipelineContext,
  repo: RepoConfig,
): Promise<void> {
  const { log, mirrorDir, kvStore, graphStore, options, changeSets } = ctx;
  const repoPath = repo.localPath ?? join(mirrorDir, `${repo.name}.git`);
  const trees = ctx.treesByRepo.get(repo.name);

  // --- Phase 4c: Module instability metrics ---
  // Runs for both normal and recovery repos (only needs parsedFiles + depGraph)
  {
    const pf4c = ctx.parsedFilesByRepo.get(repo.name);
    const dg4c = ctx.depGraphByRepo.get(repo.name);
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
    const pf4d = ctx.parsedFilesByRepo.get(repo.name);
    const dg4d = ctx.depGraphByRepo.get(repo.name);
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
    const pf4e = ctx.parsedFilesByRepo.get(repo.name);
    if (pf4e && pf4e.length > 0) {
      log(`  [${repo.name}] Computing hotspots...`);
      try {
        const start = performance.now();
        const fileChanges = await getCommitHistory(repoPath, 200);
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
    const pf4f = ctx.parsedFilesByRepo.get(repo.name);
    if (pf4f && pf4f.length > 0) {
      log(`  [${repo.name}] Computing temporal coupling...`);
      try {
        const start = performance.now();
        const fileChanges = await getCommitHistory(repoPath, 200);
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
  const depGraph = ctx.depGraphByRepo.get(repo.name);
  const parsedFiles = ctx.parsedFilesByRepo.get(repo.name);
  const repoClassified = ctx.classifiedByRepo.get(repo.name) ?? [];
  if (!depGraph) {
    log(`  [${repo.name}] Skipping heuristics (no dependency graph)`);
    return;
  }

  log(`  [${repo.name}] Running heuristics...`);
  const phase5Start = performance.now();
  try {
    // 5a: Service inference
    // In recovery mode, repoClassified may be empty; derive filePaths from parsedFiles.
    const packageJsonFiles = repoClassified.filter(
      (f) => f.kind === "json" && f.path.endsWith("package.json"),
    );

    const packageJsons = new Map<string, PackageJsonInfo>();
    const isBare = await checkBareRepo(repoPath);
    await Promise.all(packageJsonFiles.map(async (pjFile) => {
      try {
        const raw = isBare
          ? await getFileContent(repoPath, await resolveCommitForBare(repoPath, changeSets, repo.name), pjFile.path)
          : await readFile(join(repoPath, pjFile.path), "utf-8");
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
    }));

    // Incremental mode: merge with cached packageJsons for dirs not re-scanned
    if (!options.forceFullReindex) {
      const cachedPjJson = await kvStore.get(`packageJsons:${repo.name}`);
      if (cachedPjJson) {
        try {
          const cachedEntries = JSON.parse(cachedPjJson) as [string, PackageJsonInfo][];
          const scannedDirs = new Set(packageJsonFiles.map((f) => dirname(f.path)));
          for (const [dir, info] of cachedEntries) {
            if (!scannedDirs.has(dir)) {
              packageJsons.set(dir, info);
            }
          }
        } catch { /* skip malformed cache */ }
      }
    }
    await kvStore.set(`packageJsons:${repo.name}`, JSON.stringify([...packageJsons.entries()]));

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
    ctx.servicesByRepo.set(repo.name, services);

    log(`    ${servicesResult.meta.itemCount} services inferred in ${servicesResult.meta.durationMs}ms, ${packageJsons.size} package.json files`);
    for (const svc of services.slice(0, 10)) {
      log(`      ${svc.name} (${svc.rootPath}) confidence=${svc.confidence} deps=${svc.dependencies.length}`);
    }
    if (services.length > 10) {
      log(`      ... and ${services.length - 10} more`);
    }

    // Build intermediate maps for remaining heuristics
    const symbolsByFile = new Map<string, readonly import("@mma/core").SymbolInfo[]>();
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
    ctx.patternsByRepo.set(repo.name, patterns);
    await kvStore.set(`patterns:${repo.name}`, JSON.stringify(patterns));
    log(`    ${patternsResult.meta.itemCount} patterns detected in ${patternsResult.meta.durationMs}ms (from ${symbolsByFile.size} files with symbols)`);

    // 5c: Feature flag scanning
    // Try to extract the flag registry (canonical enum) regardless of whether trees are available.
    // In incremental mode, unchanged repos have no trees, so use a text-based fallback.
    if (!await kvStore.get("flagRegistry")) {
      let registryFlags: import("@mma/core").FeatureFlag[] = [];
      if (trees && trees.size > 0) {
        const enumFiles = [...trees.keys()].filter(f => f.includes("feature-flags") || f.includes("featureFlags"));
        let fileTexts: Map<string, string> | undefined;
        if (enumFiles.length > 0) {
          fileTexts = new Map();
          for (const ef of enumFiles) {
            try {
              const text = isBare
                ? await getFileContent(repoPath, await resolveCommitForBare(repoPath, changeSets, repo.name), ef)
                : await readFile(join(repoPath, ef), "utf-8");
              fileTexts.set(ef, text);
            } catch { /* file may not exist on disk */ }
          }
        }
        registryFlags = extractFlagRegistry(trees, repo.name, fileTexts);
      } else {
        // Text-based fallback: use classified file list to find enum file and read from disk/git
        const enumCandidates = repoClassified.filter(f =>
          f.path.includes("feature-flags") || f.path.includes("featureFlags"));
        for (const candidate of enumCandidates) {
          try {
            const text = isBare
              ? await getFileContent(repoPath, await resolveCommitForBare(repoPath, changeSets, repo.name), candidate.path)
              : await readFile(join(repoPath, candidate.path), "utf-8");
            registryFlags = extractFlagRegistryFromText(text, candidate.path, repo.name);
            if (registryFlags.length > 0) break;
          } catch { /* file read may fail */ }
        }
      }
      if (registryFlags.length > 0) {
        await kvStore.set("flagRegistry", JSON.stringify(registryFlags));
        log(`    ${registryFlags.length} registry flags extracted from enum`);
      }
    }

    if (trees && trees.size > 0) {
      // Load registry from KV (may come from this repo or a previously indexed repo)
      let allRegistryFlags: import("@mma/core").FeatureFlag[] | undefined;
      const registryJson = await kvStore.get("flagRegistry");
      if (registryJson) {
        try { allRegistryFlags = JSON.parse(registryJson); } catch { /* skip */ }
      }

      let flagInventory = scanForFlags(trees, repo.name, { registryFlags: allRegistryFlags });

      // Incremental mode: merge with cached flags for files not re-scanned
      if (!options.forceFullReindex) {
        const cachedFlagJson = await kvStore.get(`flags:${repo.name}`);
        if (cachedFlagJson) {
          try {
            const cached = JSON.parse(cachedFlagJson) as import("@mma/core").FlagInventory;
            const scannedFiles = new Set(trees.keys());
            const mergedFlagMap = new Map<string, { name: string; sdk?: string; defaultValue?: unknown; locations: import("@mma/core").LogicalLocation[] }>();
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

      ctx.flagsByRepo.set(repo.name, flagInventory);
      await kvStore.set(`flags:${repo.name}`, JSON.stringify(flagInventory));
      log(`    ${flagInventory.flags.length} feature flags found`);

      // 5d: Log statement extraction
      let logIndex = extractLogStatements(trees, repo.name);

      // Incremental mode: merge with cached templates for files not re-scanned
      if (!options.forceFullReindex) {
        const cachedLogJson = await kvStore.get(`logTemplates:${repo.name}`);
        if (cachedLogJson) {
          try {
            const cached = JSON.parse(cachedLogJson) as import("@mma/core").LogTemplateIndex;
            const scannedFiles = new Set(trees.keys());
            // Key: "severity\0template" → merged template entry
            type MutableTemplate = { id: string; template: string; severity: import("@mma/core").LogSeverity; locations: import("@mma/core").LogicalLocation[]; frequency: number };
            const mergedMap = new Map<string, MutableTemplate>();
            // Keep cached locations from files not re-scanned
            for (const t of cached.templates) {
              const keptLocs = t.locations.filter(loc => !scannedFiles.has(loc.module));
              if (keptLocs.length > 0) {
                const key = `${t.severity}\x00${t.template}`;
                mergedMap.set(key, { id: t.id, template: t.template, severity: t.severity, locations: [...keptLocs], frequency: keptLocs.length });
              }
            }
            // Merge new templates from re-scanned files
            for (const t of logIndex.templates) {
              const key = `${t.severity}\x00${t.template}`;
              const existing = mergedMap.get(key);
              if (existing) {
                existing.locations.push(...t.locations);
                existing.frequency = existing.locations.length;
              } else {
                mergedMap.set(key, { id: t.id, template: t.template, severity: t.severity, locations: [...t.locations], frequency: t.frequency });
              }
            }
            // Re-index IDs sequentially
            const mergedTemplates = [...mergedMap.values()].map((t, i) => ({ ...t, id: `log-template-${i}` }));
            logIndex = { repo: repo.name, templates: mergedTemplates };
          } catch { /* skip malformed cache */ }
        }
      }

      ctx.logIndexByRepo.set(repo.name, logIndex);
      await kvStore.set(`logTemplates:${repo.name}`, JSON.stringify(logIndex));
      log(`    ${logIndex.templates.length} log templates extracted`);
    } else {
      log(`    skipping flag scan and log extraction (no tree-sitter trees)`);
    }

    // 5e: Naming analysis
    if (symbolsByFile.size > 0) {
      const namingHeuristic = analyzeNamingWithMeta(symbolsByFile, repo.name);
      ctx.namingByRepo.set(repo.name, namingHeuristic.data);
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
        await graphStore.addEdges(topologyEdges);
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
      const packageJsons2 = new Map<string, PackageJsonInfo>();
      const cachedPjJson = await kvStore.get(`packageJsons:${repo.name}`);
      if (cachedPjJson) {
        try {
          const entries = JSON.parse(cachedPjJson) as [string, PackageJsonInfo][];
          for (const [dir, info] of entries) packageJsons2.set(dir, info);
        } catch { /* skip malformed */ }
      }
      const installed: InstalledPackage[] = [];
      const skippedProtocols: string[] = [];
      for (const [, pj] of packageJsons2) {
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
        if (packageJsons2.size === 0) {
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
    ctx.failedRepoNames.add(repo.name);
  }
}
