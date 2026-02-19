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
  log(`Route: ${decision.route} (confidence: ${decision.confidence.toFixed(2)})`);
  log(`Entities: ${decision.extractedEntities.join(", ") || "none"}`);

  switch (decision.route) {
    case "structural": {
      if (decision.extractedEntities.length > 0) {
        const entity = decision.extractedEntities[0]!;
        const result = query.toLowerCase().includes("depend")
          ? await executeDependencyQuery(entity, graphStore)
          : await executeCallersQuery(entity, graphStore);
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
      const result = await executeSearchQuery(query, searchStore);
      console.log(result.description);
      for (const hit of result.results) {
        console.log(`  [${hit.score.toFixed(2)}] ${hit.id}: ${hit.content.slice(0, 100)}`);
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
        const matching = sarif.runs.flatMap((r) =>
          r.results.filter(
            (res) =>
              res.message.text.toLowerCase().includes(query.toLowerCase()) ||
              decision.extractedEntities.some((e) =>
                res.message.text.includes(e),
              ),
          ),
        );
        console.log(`${matching.length} matching diagnostics:`);
        for (const result of matching) {
          console.log(`  [${result.level}] ${result.ruleId}: ${result.message.text}`);
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
