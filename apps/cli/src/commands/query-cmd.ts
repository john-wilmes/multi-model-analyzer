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
import type { DetectedPattern, FaultTree } from "@mma/core";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";

export interface QueryOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly verbose: boolean;
}

export async function queryCommand(
  query: string,
  options: QueryOptions,
): Promise<void> {
  const { graphStore, searchStore, verbose } = options;

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
        let totalCycles = 0;
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
          totalCycles += cycles.length;
          console.log(`${cycles.length} circular dependencies (${repo}):`);
          for (const cycle of cycles) {
            console.log(`  ${cycle.join(" -> ")}`);
          }
        }
        if (totalCycles === 0) {
          console.log(repoFilter
            ? `No circular dependencies found for repo: ${repoFilter}`
            : "No circular dependencies found.");
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
        console.log(result.description);
        for (const edge of result.edges) {
          console.log(`  ${edge.source} -> ${edge.target} [${edge.kind}]`);
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
      break;
    }

    case "analytical": {
      // Look up pre-computed SARIF results
      const sarifJson = await options.kvStore.get("sarif:latest");
      if (sarifJson) {
        let sarif: import("@mma/core").SarifLog;
        try {
          sarif = JSON.parse(sarifJson) as import("@mma/core").SarifLog;
        } catch {
          console.log("Error: stored SARIF data is corrupted. Re-run 'index' to regenerate.");
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
        console.log(`${matching.length} matching diagnostics${repoFilter ? ` (repo: ${repoFilter})` : ""}:`);
        for (const result of matching.slice(0, 50)) {
          console.log(`  [${result.level}] ${result.ruleId}: ${result.message.text}`);
        }
        if (matching.length > 50) {
          console.log(`  ... and ${matching.length - 50} more`);
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
      console.log(archResult.description);
      console.log("\nRepos:");
      for (const repo of archResult.repos) {
        console.log(
          `  ${repo.name} [${repo.role}]: ${repo.importCount} imports (${repo.crossRepoImports} cross-repo), ${repo.callCount} calls, ${repo.serviceCallCount} service-call edges`,
        );
      }

      if (archResult.crossRepoEdges.length > 0) {
        console.log("\nCross-repo dependencies:");
        for (const edge of archResult.crossRepoEdges.slice(0, 30)) {
          console.log(`  ${edge.sourceRepo} -> ${edge.targetPackage} (${edge.count} imports)`);
        }
        if (archResult.crossRepoEdges.length > 30) {
          console.log(`  ... and ${archResult.crossRepoEdges.length - 30} more`);
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
          for (const link of links.slice(0, 10)) {
            console.log(`    ${link.sourceRepo}:${link.sourceFile} -> ${link.target} (${link.detail})`);
          }
          if (links.length > 10) {
            console.log(`    ... and ${links.length - 10} more`);
          }
        }
      }
      break;
    }

    case "pattern": {
      const keys = await options.kvStore.keys("patterns:");
      let totalPatterns = 0;
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

      for (const key of keys) {
        const repo = key.replace("patterns:", "");
        if (repoFilter && repo !== repoFilter) continue;
        const json = await options.kvStore.get(key);
        if (!json) continue;
        let patterns: DetectedPattern[];
        try {
          patterns = JSON.parse(json);
        } catch {
          console.log(`Warning: corrupted pattern data for ${repo}. Re-run 'index' to regenerate.`);
          continue;
        }
        if (kindFilter) {
          patterns = patterns.filter((p) => p.kind === kindFilter);
        }
        totalPatterns += patterns.length;
        if (patterns.length > 0) {
          console.log(`${patterns.length} patterns (${repo})${kindFilter ? ` [${kindFilter}]` : ""}:`);
          for (const p of patterns.slice(0, 30)) {
            const loc = p.locations[0]?.module ?? "";
            console.log(`  [${p.kind}] ${p.name} (confidence: ${p.confidence.toFixed(2)}) ${loc}`);
          }
          if (patterns.length > 30) {
            console.log(`  ... and ${patterns.length - 30} more`);
          }
        }
      }
      if (totalPatterns === 0) {
        console.log(repoFilter
          ? `No patterns found for repo: ${repoFilter}${kindFilter ? ` [${kindFilter}]` : ""}`
          : `No patterns found${kindFilter ? ` [${kindFilter}]` : ""}.`);
      }
      break;
    }

    case "documentation": {
      const keys = await options.kvStore.keys("docs:functional:");
      let found = false;
      for (const key of keys) {
        const repo = key.replace("docs:functional:", "");
        if (repoFilter && repo !== repoFilter) continue;
        const docs = await options.kvStore.get(key);
        if (!docs) continue;
        found = true;
        console.log(`Documentation (${repo}):\n`);
        console.log(docs);
      }
      if (!found) {
        console.log(repoFilter
          ? `No documentation found for repo: ${repoFilter}`
          : "No documentation available. Run 'index' first.");
      }
      break;
    }

    case "faulttree": {
      const keys = await options.kvStore.keys("faultTrees:");
      let totalTrees = 0;
      for (const key of keys) {
        const repo = key.replace("faultTrees:", "");
        if (repoFilter && repo !== repoFilter) continue;
        const json = await options.kvStore.get(key);
        if (!json) continue;
        let trees: FaultTree[];
        try {
          trees = JSON.parse(json);
        } catch {
          console.log(`Warning: corrupted fault tree data for ${repo}. Re-run 'index' to regenerate.`);
          continue;
        }
        totalTrees += trees.length;
        console.log(`${trees.length} fault trees (${repo}):`);
        for (const tree of trees.slice(0, 20)) {
          const childCount = tree.topEvent.children?.length ?? 0;
          console.log(`  [${tree.topEvent.kind}] ${tree.topEvent.label} (${childCount} children)`);
        }
        if (trees.length > 20) {
          console.log(`  ... and ${trees.length - 20} more`);
        }
      }
      if (totalTrees === 0) {
        console.log(repoFilter
          ? `No fault trees found for repo: ${repoFilter}`
          : "No fault trees found. Run 'index' first.");
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
