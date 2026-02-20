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

export type QueryRoute = "structural" | "search" | "analytical" | "synthesis" | "architecture";

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
  readonly repo?: string;
  readonly strippedQuery: string;
}

export function routeQuery(query: string): RouteDecision {
  const trimmed = query.trim();

  // Extract optional "repo:NAME" prefix
  let repo: string | undefined;
  let strippedQuery = trimmed;
  const repoMatch = trimmed.match(/^repo:(\S+)(?:\s+(.*))?$/s);
  if (repoMatch) {
    repo = repoMatch[1]!;
    strippedQuery = repoMatch[2] ?? "";
  }

  const entities = extractEntities(strippedQuery);
  const normalized = strippedQuery.toLowerCase().trim();

  // Structural patterns
  if (/\b(calls?|depend(?:s|ency|encies)?|imports?|extends?|implements?|references?|definition|callers?|callees?|uses|used|modules?|files?)\b/.test(normalized)) {
    return { route: "structural", confidence: 0.9, extractedEntities: entities, repo, strippedQuery };
  }

  // Analytical patterns
  if (/\b(risks?|faults?|errors?|failures?|dead|unused|orphan|violations?|flags?|config|diagnostics?|warnings?|issues?|gaps?|missing|circular)\b/.test(normalized)) {
    return { route: "analytical", confidence: 0.85, extractedEntities: entities, repo, strippedQuery };
  }

  // Architecture patterns (cross-repo topology, service overview)
  if (/\b(architecture|topology|service[\s-]?map|cross[\s-]?repo|(?:architecture|service)\s+overview)\b/.test(normalized)) {
    return { route: "architecture", confidence: 0.9, extractedEntities: entities, repo, strippedQuery };
  }

  // Synthesis patterns (complex questions)
  if (/\b(why|how|explain|summarize|describe|compare|design)\b/.test(normalized)) {
    return { route: "synthesis", confidence: 0.7, extractedEntities: entities, repo, strippedQuery };
  }

  // Default to search
  return { route: "search", confidence: 0.5, extractedEntities: entities, repo, strippedQuery };
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

  // Extract camelCase identifiers (must contain internal uppercase)
  const camelCase = query.match(/\b[a-z]+[A-Z][a-zA-Z]*\b/g);
  if (camelCase) {
    entities.push(...camelCase);
  }

  // Extract dotted paths
  const dottedPaths = query.match(/\b[\w]+(?:\.[\w]+)+\b/g);
  if (dottedPaths) {
    entities.push(...dottedPaths);
  }

  return [...new Set(entities)];
}
