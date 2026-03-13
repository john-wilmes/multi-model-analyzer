/**
 * CLI command: query the index.
 *
 * Accepts a natural language query, routes to appropriate backend,
 * returns results formatted for terminal output.
 */

import { routeQuery } from "@mma/query";
import { executeSearchQuery } from "@mma/query";
import { executeCallersQuery, executeCalleesQuery, executeDependencyQuery } from "@mma/query";
import { executeArchitectureQuery } from "@mma/query";
import type { DetectedPattern, FaultTree, SarifLog } from "@mma/core";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import { printJson, printSarif } from "../formatter.js";
import type { OutputFormat } from "../formatter.js";

/** Display limits for table output to prevent terminal flooding. */
const DISPLAY_LIMITS = {
  diagnostics: 50,
  crossRepoEdges: 30,
  serviceLinks: 10,
  patterns: 30,
  faultTrees: 20,
} as const;

export interface QueryOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly verbose: boolean;
  readonly format: OutputFormat;
}

export async function queryCommand(
  query: string,
  options: QueryOptions,
): Promise<void> {
  const { graphStore, searchStore, verbose, format } = options;

  const log = verbose ? console.log : () => {};

  const decision = routeQuery(query);
  const repoFilter = decision.repo;
  log(`Route: ${decision.route} (confidence: ${decision.confidence.toFixed(2)})`);
  if (repoFilter) log(`Repo filter: ${repoFilter}`);
  log(`Entities: ${decision.extractedEntities.join(", ") || "none"}`);

  switch (decision.route) {
    case "structural": {
      const q = decision.strippedQuery.toLowerCase();
      const isCircular = /\bcircular\b/.test(q);
      if (isCircular) {
        const keys = await options.kvStore.keys("circularDeps:");
        const allCycles: Array<{ repo: string; cycle: string[] }> = [];
        for (const key of keys) {
          const repo = key.replace("circularDeps:", "");
          if (repoFilter && repo !== repoFilter) continue;
          const json = await options.kvStore.get(key);
          if (!json) continue;
          let cycles: string[][];
          try {
            cycles = JSON.parse(json) as string[][];
          } catch {
            console.log(`Warning: corrupted circular dependency data for ${repo}. Re-run 'index' to regenerate.`);
            continue;
          }
          for (const cycle of cycles) {
            allCycles.push({ repo, cycle });
          }
        }
        if (format === "json") {
          printJson({ route: "structural", type: "circular", cycles: allCycles });
        } else if (format === "sarif") {
          printSarif("mma-query", allCycles.map((c) => ({
            ruleId: "structural/circular-dependency",
            level: "warning" as const,
            message: `Circular: ${c.cycle.join(" -> ")}`,
            repo: c.repo,
          })));
        } else {
          if (allCycles.length === 0) {
            console.log(repoFilter
              ? `No circular dependencies found for repo: ${repoFilter}`
              : "No circular dependencies found.");
          } else {
            // Group by repo for display
            const byRepo = new Map<string, string[][]>();
            for (const c of allCycles) {
              const arr = byRepo.get(c.repo) ?? [];
              arr.push(c.cycle);
              byRepo.set(c.repo, arr);
            }
            for (const [repo, cycles] of byRepo) {
              console.log(`${cycles.length} circular dependencies (${repo}):`);
              for (const cycle of cycles) {
                console.log(`  ${cycle.join(" -> ")}`);
              }
            }
          }
        }
        break;
      }
      if (decision.extractedEntities.length > 0) {
        const entity = decision.extractedEntities[0]!;
        const isCallees = /\bcallees?\b/.test(q) || /\bwhat does .+ call\b/.test(q);
        const isDeps = q.includes("depend");
        const result = isDeps
          ? await executeDependencyQuery(entity, graphStore, repoFilter ? { maxDepth: 3, repo: repoFilter } : 3, searchStore)
          : isCallees
            ? await executeCalleesQuery(entity, graphStore, repoFilter, searchStore)
            : await executeCallersQuery(entity, graphStore, repoFilter, searchStore);
        if (format === "json") {
          printJson({ route: "structural", entity, description: result.description, edges: result.edges });
        } else if (format === "sarif") {
          printSarif("mma-query", result.edges.map((e) => ({
            ruleId: `structural/${isDeps ? "dependency" : isCallees ? "callee" : "caller"}`,
            level: "note" as const,
            message: `${e.source} -> ${e.target} [${e.kind}]`,
          })));
        } else {
          console.log(result.description);
          for (const edge of result.edges) {
            console.log(`  ${edge.source} -> ${edge.target} [${edge.kind}]`);
          }
        }
      } else {
        console.log("No entity found in query for structural lookup.");
      }
      break;
    }

    case "search": {
      const result = await executeSearchQuery(decision.strippedQuery, searchStore);
      const hits = repoFilter
        ? result.results.filter((hit) => hit.metadata?.["repo"] === repoFilter)
        : result.results;
      if (format === "json") {
        printJson({ route: "search", query: decision.strippedQuery, results: hits });
      } else if (format === "sarif") {
        printSarif("mma-query", hits.map((h) => ({
          ruleId: "search/match",
          level: "note" as const,
          message: `[${h.score.toFixed(2)}] ${h.id}: ${h.content.slice(0, 120)}`,
          repo: typeof h.metadata?.["repo"] === "string" ? h.metadata["repo"] : undefined,
        })));
      } else {
        const header = repoFilter
          ? `${hits.length} results (filtered to repo: ${repoFilter}):`
          : result.description;
        console.log(header);
        for (const hit of hits) {
          const meta = hit.metadata ?? {};
          const metaStr = Object.entries(meta)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          const suffix = metaStr ? ` (${metaStr})` : "";
          console.log(`  [${hit.score.toFixed(2)}] ${hit.id}${suffix}`);
          console.log(`    ${hit.content.slice(0, 120)}`);
        }
      }
      break;
    }

    case "analytical": {
      // Look up pre-computed SARIF results
      const sarifJson = await options.kvStore.get("sarif:latest");
      if (sarifJson) {
        let sarif: SarifLog;
        try {
          sarif = JSON.parse(sarifJson) as SarifLog;
        } catch {
          console.log("Error: stored SARIF data is corrupted. Re-run 'index' to regenerate.");
          break;
        }

        // For sarif format, emit the raw stored SARIF log directly
        if (format === "sarif") {
          printJson(sarif);
          break;
        }

        const stopWords = new Set([
          "a", "an", "the", "is", "are", "was", "were", "be", "been",
          "do", "does", "did", "have", "has", "had", "will", "would",
          "can", "could", "should", "may", "might", "shall",
          "what", "which", "who", "whom", "where", "when", "why", "how",
          "that", "this", "these", "those", "it", "its",
          "in", "on", "at", "to", "for", "of", "with", "by", "from",
          "and", "or", "not", "no", "but", "if", "then", "so",
          "about", "any", "all", "some", "there", "my", "me", "show",
        ]);
        const keywords = decision.strippedQuery.toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1 && !stopWords.has(w));
        const entities = decision.extractedEntities;

        // Category-level filters take priority over broad terms
        const categoryLevelFilter = resolveCategoryFilter(keywords);
        const categoryRuleFilter = resolveCategoryRuleFilter(keywords);
        const broadTerms = /^(?:diagnostics?|issues?|findings?|results?|problems?)$/;
        const isBroadQuery = !categoryLevelFilter && !categoryRuleFilter
          && keywords.some((kw) => broadTerms.test(kw));

        const matching = sarif.runs.flatMap((r) =>
          r.results.filter((res) => {
            // Repo filter: check location properties for repo name
            if (repoFilter) {
              const locRepo = res.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"];
              if (locRepo !== repoFilter) return false;
            }
            // Broad terms (diagnostics/issues/findings) -> return all results
            if (isBroadQuery) return true;
            // Category-level filter (e.g., "warnings" -> level="warning")
            if (categoryLevelFilter && res.level !== categoryLevelFilter) return false;
            // Category-rule filter (e.g., "faults" -> ruleId starts with "fault/")
            if (categoryRuleFilter && !res.ruleId?.startsWith(categoryRuleFilter)) return false;
            // If we have a category filter, include all matching results
            if (categoryLevelFilter || categoryRuleFilter) return true;

            const text = `${res.ruleId} ${res.message.text}`.toLowerCase();
            // Match if any entity appears in the message
            if (entities.some((e) => text.includes(e.toLowerCase()))) return true;
            // Match if at least half of the keywords appear
            if (keywords.length === 0) return false;
            const hits = keywords.filter((kw) => text.includes(kw)).length;
            return hits >= Math.max(1, Math.ceil(keywords.length / 2));
          }),
        );
        if (format === "json") {
          printJson({ route: "analytical", total: matching.length, results: matching });
        } else {
          console.log(`${matching.length} matching diagnostics${repoFilter ? ` (repo: ${repoFilter})` : ""}:`);
          for (const result of matching.slice(0, DISPLAY_LIMITS.diagnostics)) {
            console.log(`  [${result.level}] ${result.ruleId}: ${result.message.text}`);
          }
          if (matching.length > DISPLAY_LIMITS.diagnostics) {
            console.log(`  ... and ${matching.length - DISPLAY_LIMITS.diagnostics} more`);
          }
        }
      } else {
        console.log("No analysis results available. Run 'index' first.");
      }
      break;
    }

    case "architecture": {
      const archResult = await executeArchitectureQuery(
        graphStore,
        options.kvStore,
        repoFilter,
      );
      if (format === "json") {
        printJson({ route: "architecture", ...archResult });
      } else if (format === "sarif") {
        const sarifResults = archResult.repos.map((r) => ({
          ruleId: "architecture/repo-summary",
          level: "note" as const,
          message: `${r.name} [${r.role}]: ${r.importCount} imports, ${r.callCount} calls`,
          repo: r.name,
        }));
        printSarif("mma-query", sarifResults);
      } else {
        console.log(archResult.description);
        console.log("\nRepos:");
        for (const repo of archResult.repos) {
          console.log(
            `  ${repo.name} [${repo.role}]: ${repo.importCount} imports (${repo.crossRepoImports} cross-repo), ${repo.callCount} calls, ${repo.serviceCallCount} service-call edges`,
          );
        }

        if (archResult.crossRepoEdges.length > 0) {
          console.log("\nCross-repo dependencies:");
          for (const edge of archResult.crossRepoEdges.slice(0, DISPLAY_LIMITS.crossRepoEdges)) {
            console.log(`  ${edge.sourceRepo} -> ${edge.targetPackage} (${edge.count} imports)`);
          }
          if (archResult.crossRepoEdges.length > DISPLAY_LIMITS.crossRepoEdges) {
            console.log(`  ... and ${archResult.crossRepoEdges.length - DISPLAY_LIMITS.crossRepoEdges} more`);
          }
        }

        if (archResult.serviceTopology.length > 0) {
          console.log("\nService topology:");
          // Group by protocol/role for cleaner output
          const byType = new Map<string, typeof archResult.serviceTopology[number][]>();
          for (const link of archResult.serviceTopology) {
            const key = `${link.protocol}/${link.role}`;
            const arr = byType.get(key) ?? [];
            arr.push(link);
            byType.set(key, arr);
          }
          const sortedTypes = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
          for (const [type, links] of sortedTypes) {
            links.sort((a, b) =>
              a.sourceRepo.localeCompare(b.sourceRepo)
              || a.sourceFile.localeCompare(b.sourceFile)
              || a.target.localeCompare(b.target),
            );
            console.log(`  [${type}] (${links.length} edges):`);
            for (const link of links.slice(0, DISPLAY_LIMITS.serviceLinks)) {
              console.log(`    ${link.sourceRepo}:${link.sourceFile} -> ${link.target} (${link.detail})`);
            }
            if (links.length > DISPLAY_LIMITS.serviceLinks) {
              console.log(`    ... and ${links.length - DISPLAY_LIMITS.serviceLinks} more`);
            }
          }
        }
      }
      break;
    }

    case "pattern": {
      const keys = await options.kvStore.keys("patterns:");
      const q = decision.strippedQuery.toLowerCase();
      // Extract pattern kind filter from query
      const kindMap: Record<string, string> = {
        factory: "factory", factories: "factory",
        singleton: "singleton", singletons: "singleton",
        observer: "observer", observers: "observer",
        adapter: "adapter", adapters: "adapter",
        facade: "facade", facades: "facade",
        repository: "repository", repositories: "repository",
        middleware: "middleware", middlewares: "middleware",
        decorator: "decorator", decorators: "decorator",
      };
      let kindFilter: string | null = null;
      for (const [word, kind] of Object.entries(kindMap)) {
        if (q.includes(word)) { kindFilter = kind; break; }
      }

      const allPatterns: Array<{ repo: string; kind: string; name: string; confidence: number; location: string }> = [];
      for (const key of keys) {
        const repo = key.replace("patterns:", "");
        if (repoFilter && repo !== repoFilter) continue;
        const json = await options.kvStore.get(key);
        if (!json) continue;
        let patterns: DetectedPattern[];
        try {
          const parsed: unknown = JSON.parse(json);
          if (!Array.isArray(parsed)) {
            console.log(`Warning: unexpected pattern data shape for ${repo}. Re-run 'index' to regenerate.`);
            continue;
          }
          patterns = parsed as DetectedPattern[];
        } catch {
          console.log(`Warning: corrupted pattern data for ${repo}. Re-run 'index' to regenerate.`);
          continue;
        }
        if (kindFilter) {
          patterns = patterns.filter((p) => p.kind === kindFilter);
        }
        for (const p of patterns) {
          allPatterns.push({
            repo,
            kind: p.kind,
            name: p.name,
            confidence: p.confidence,
            location: p.locations[0]?.module ?? "",
          });
        }
      }

      if (format === "json") {
        printJson({ route: "pattern", kindFilter, patterns: allPatterns });
      } else if (format === "sarif") {
        printSarif("mma-query", allPatterns.map((p) => ({
          ruleId: `pattern/${p.kind}`,
          level: "note" as const,
          message: `${p.name} (confidence: ${p.confidence.toFixed(2)}) ${p.location}`,
          repo: p.repo,
        })));
      } else {
        if (allPatterns.length === 0) {
          console.log(repoFilter
            ? `No patterns found for repo: ${repoFilter}${kindFilter ? ` [${kindFilter}]` : ""}`
            : `No patterns found${kindFilter ? ` [${kindFilter}]` : ""}.`);
        } else {
          // Group by repo for display
          const byRepo = new Map<string, typeof allPatterns>();
          for (const p of allPatterns) {
            const arr = byRepo.get(p.repo) ?? [];
            arr.push(p);
            byRepo.set(p.repo, arr);
          }
          for (const [repo, patterns] of byRepo) {
            console.log(`${patterns.length} patterns (${repo})${kindFilter ? ` [${kindFilter}]` : ""}:`);
            for (const p of patterns.slice(0, DISPLAY_LIMITS.patterns)) {
              console.log(`  [${p.kind}] ${p.name} (confidence: ${p.confidence.toFixed(2)}) ${p.location}`);
            }
            if (patterns.length > DISPLAY_LIMITS.patterns) {
              console.log(`  ... and ${patterns.length - DISPLAY_LIMITS.patterns} more`);
            }
          }
        }
      }
      break;
    }

    case "documentation": {
      const keys = await options.kvStore.keys("docs:functional:");
      const allDocs: Array<{ repo: string; content: string }> = [];
      for (const key of keys) {
        const repo = key.replace("docs:functional:", "");
        if (repoFilter && repo !== repoFilter) continue;
        const docs = await options.kvStore.get(key);
        if (!docs) continue;
        allDocs.push({ repo, content: docs });
      }
      if (format === "json") {
        printJson({ route: "documentation", docs: allDocs });
      } else if (format === "sarif") {
        printSarif("mma-query", allDocs.map((d) => ({
          ruleId: "documentation/content",
          level: "note" as const,
          message: d.content.slice(0, 200),
          repo: d.repo,
        })));
      } else {
        if (allDocs.length === 0) {
          console.log(repoFilter
            ? `No documentation found for repo: ${repoFilter}`
            : "No documentation available. Run 'index' first.");
        } else {
          for (const d of allDocs) {
            console.log(`Documentation (${d.repo}):\n`);
            console.log(d.content);
          }
        }
      }
      break;
    }

    case "faulttree": {
      const keys = await options.kvStore.keys("faultTrees:");
      const allTrees: Array<{ repo: string; kind: string; label: string; childCount: number }> = [];
      for (const key of keys) {
        const repo = key.replace("faultTrees:", "");
        if (repoFilter && repo !== repoFilter) continue;
        const json = await options.kvStore.get(key);
        if (!json) continue;
        let trees: FaultTree[];
        try {
          const parsed: unknown = JSON.parse(json);
          if (!Array.isArray(parsed)) {
            console.log(`Warning: unexpected fault tree data shape for ${repo}. Re-run 'index' to regenerate.`);
            continue;
          }
          trees = parsed as FaultTree[];
        } catch {
          console.log(`Warning: corrupted fault tree data for ${repo}. Re-run 'index' to regenerate.`);
          continue;
        }
        for (const tree of trees) {
          allTrees.push({
            repo,
            kind: tree.topEvent.kind,
            label: tree.topEvent.label,
            childCount: tree.topEvent.children?.length ?? 0,
          });
        }
      }
      if (format === "json") {
        printJson({ route: "faulttree", trees: allTrees });
      } else if (format === "sarif") {
        printSarif("mma-query", allTrees.map((t) => ({
          ruleId: `faulttree/${t.kind}`,
          level: "warning" as const,
          message: `${t.label} (${t.childCount} children)`,
          repo: t.repo,
        })));
      } else {
        if (allTrees.length === 0) {
          console.log(repoFilter
            ? `No fault trees found for repo: ${repoFilter}`
            : "No fault trees found. Run 'index' first.");
        } else {
          // Group by repo for display
          const byRepo = new Map<string, typeof allTrees>();
          for (const t of allTrees) {
            const arr = byRepo.get(t.repo) ?? [];
            arr.push(t);
            byRepo.set(t.repo, arr);
          }
          for (const [repo, trees] of byRepo) {
            console.log(`${trees.length} fault trees (${repo}):`);
            for (const tree of trees.slice(0, DISPLAY_LIMITS.faultTrees)) {
              console.log(`  [${tree.kind}] ${tree.label} (${tree.childCount} children)`);
            }
            if (trees.length > DISPLAY_LIMITS.faultTrees) {
              console.log(`  ... and ${trees.length - DISPLAY_LIMITS.faultTrees} more`);
            }
          }
        }
      }
      break;
    }

    case "synthesis": {
      console.log("Synthesis queries require tier 4 (Sonnet) -- not yet implemented in CLI.");
      break;
    }
  }
}

/** Map natural language terms to SARIF result levels. */
function resolveCategoryFilter(keywords: string[]): string | null {
  for (const kw of keywords) {
    if (/^warnings?$/.test(kw)) return "warning";
    if (/^errors?$/.test(kw)) return "error";
    if (/^notes?$/.test(kw)) return "note";
  }
  return null;
}

/** Map natural language terms to SARIF ruleId prefixes. */
function resolveCategoryRuleFilter(keywords: string[]): string | null {
  for (const kw of keywords) {
    if (/^(?:faults?|unhandled|gaps?|missing)$/.test(kw)) return "fault/";
    if (/^(?:configs?|flags?|interactions?|untested)$/.test(kw)) return "config/";
  }
  return null;
}
