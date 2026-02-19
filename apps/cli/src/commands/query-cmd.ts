/**
 * CLI command: query the index.
 *
 * Accepts a natural language query, routes to appropriate backend,
 * returns results formatted for terminal output.
 */

import { routeQuery } from "@mma/query";
import { executeSearchQuery } from "@mma/query";
import { executeCallersQuery, executeDependencyQuery } from "@mma/query";
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
      if (decision.extractedEntities.length > 0) {
        const entity = decision.extractedEntities[0]!;
        const result = decision.strippedQuery.toLowerCase().includes("depend")
          ? await executeDependencyQuery(entity, graphStore, repoFilter ? { maxDepth: 3, repo: repoFilter } : 3)
          : await executeCallersQuery(entity, graphStore, repoFilter);
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
      if (repoFilter) {
        const filtered = result.results.filter((hit) => hit.metadata?.["repo"] === repoFilter);
        console.log(`${filtered.length} results (filtered to repo: ${repoFilter}):`);
        for (const hit of filtered) {
          const meta = hit.metadata ?? {};
          const metaStr = Object.entries(meta)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          const suffix = metaStr ? ` (${metaStr})` : "";
          console.log(`  [${hit.score.toFixed(2)}] ${hit.id}${suffix}`);
          console.log(`    ${hit.content.slice(0, 120)}`);
        }
      } else {
        console.log(result.description);
        for (const hit of result.results) {
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
          "about", "any", "all", "some", "there", "my", "me",
        ]);
        const keywords = decision.strippedQuery.toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1 && !stopWords.has(w));
        const entities = decision.extractedEntities;

        const matching = sarif.runs.flatMap((r) =>
          r.results.filter((res) => {
            // Repo filter: check ruleId prefix or location FQN for repo name
            if (repoFilter) {
              const ruleText = res.ruleId ?? "";
              const fqn = res.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? "";
              if (!ruleText.includes(repoFilter) && !fqn.includes(repoFilter)) return false;
            }
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
