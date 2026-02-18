/**
 * Query router: accepts user questions and routes to appropriate backend.
 *
 * Routing logic:
 * - Structural queries ("what calls X?", "dependencies of Y") -> graph traversal
 * - Search queries ("find error handling in scheduler") -> BM25
 * - Analytical queries ("what are the risks in...") -> pre-computed SARIF lookup
 * - NL queries requiring synthesis -> Sonnet (tier 4, sparingly)
 */

import type { SarifLog } from "@mma/core";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";

export type QueryRoute = "structural" | "search" | "analytical" | "synthesis";

export interface RouterConfig {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly sarifResults?: SarifLog;
}

export interface RouteDecision {
  readonly route: QueryRoute;
  readonly confidence: number;
  readonly extractedEntities: readonly string[];
}

export function routeQuery(query: string): RouteDecision {
  const normalized = query.toLowerCase().trim();
  const entities = extractEntities(normalized);

  // Structural patterns
  if (/\b(call[s]?|depend[s]?|import[s]?|extend[s]?|implement[s]?|reference[s]?|definition)\b/.test(normalized)) {
    return { route: "structural", confidence: 0.9, extractedEntities: entities };
  }

  // Analytical patterns
  if (/\b(risk[s]?|fault[s]?|error[s]?|failure[s]?|dead|unused|orphan|violation[s]?|flag[s]?|config)\b/.test(normalized)) {
    return { route: "analytical", confidence: 0.85, extractedEntities: entities };
  }

  // Synthesis patterns (complex questions)
  if (/\b(why|how|explain|summarize|describe|compare|architecture|design)\b/.test(normalized)) {
    return { route: "synthesis", confidence: 0.7, extractedEntities: entities };
  }

  // Default to search
  return { route: "search", confidence: 0.5, extractedEntities: entities };
}

function extractEntities(query: string): string[] {
  const entities: string[] = [];

  // Extract quoted strings
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) {
    entities.push(...quoted.map((q) => q.replace(/"/g, "")));
  }

  // Extract PascalCase identifiers
  const pascalCase = query.match(/\b[A-Z][a-zA-Z]+\b/g);
  if (pascalCase) {
    entities.push(...pascalCase);
  }

  // Extract dotted paths
  const dottedPaths = query.match(/\b[\w]+(?:\.[\w]+)+\b/g);
  if (dottedPaths) {
    entities.push(...dottedPaths);
  }

  return [...new Set(entities)];
}
