/**
 * CLI command: query the index.
 *
 * Accepts a natural language query, routes to appropriate backend,
 * returns results formatted for terminal output.
 */

import { routeQuery } from "@mma/query";
import { executeSearchQuery } from "@mma/query";
import { executeCallersQuery, executeCalleesQuery, executeDependencyQuery } from "@mma/query";
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
