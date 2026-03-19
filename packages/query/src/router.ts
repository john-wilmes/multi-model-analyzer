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

export type QueryRoute = "structural" | "search" | "analytical" | "synthesis" | "architecture" | "pattern" | "documentation" | "faulttree" | "metrics" | "blastradius" | "flagimpact";

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
  readonly repos?: readonly string[];
  readonly strippedQuery: string;
}

export function routeQuery(query: string): RouteDecision {
  const trimmed = query.trim();

  // Extract optional "repo:NAME" or "repos:A,B,C" prefix
  let repo: string | undefined;
  let repos: string[] | undefined;
  let strippedQuery = trimmed;
  const reposMatch = trimmed.match(/^repos:(\S+)(?:\s+(.*))?$/s);
  if (reposMatch) {
    repos = reposMatch[1]!.split(",").filter((r) => r.length > 0);
    if (repos.length === 1) {
      repo = repos[0];
      repos = undefined;
    }
    strippedQuery = reposMatch[2] ?? "";
  } else {
    const repoMatch = trimmed.match(/^repo:(\S+)(?:\s+(.*))?$/s);
    if (repoMatch) {
      repo = repoMatch[1]!;
      strippedQuery = repoMatch[2] ?? "";
    }
  }

  const entities = extractEntities(strippedQuery);
  const normalized = strippedQuery.toLowerCase().trim();

  function decision(route: QueryRoute, confidence: number): RouteDecision {
    return { route, confidence, extractedEntities: entities, repo, repos, strippedQuery };
  }

  // Metrics patterns (instability, coupling)
  if (/\b(metrics?|instability|coupling|afferent|efferent|abstractness|main[\s-]?sequence)\b/.test(normalized)) {
    return decision("metrics", 0.9);
  }

  // Feature flag impact patterns (must come before blastradius — "impact" in blastradius would match "flag impact")
  if (/\b(flag[\s-]?impacts?|feature[\s-]?flags?|flag[\s-]?inventor(?:y|ies)|flag[\s-]?analysis)\b/.test(normalized)) {
    return decision("flagimpact", 0.9);
  }

  // Blast radius patterns
  if (/\b(blast\s*radius|impact|affected\s*by|ripple|critical|high[\s-]?risk|hotspot|risky|important)\b/.test(normalized)) {
    return decision("blastradius", 0.9);
  }

  // Structural patterns
  if (/\b(calls?|depend(?:s|ency|encies)?|imports?|extends?|implements?|references?|definition|callers?|callees?|uses|used|modules?|files?)\b/.test(normalized)) {
    return decision("structural", 0.9);
  }

  // Fault tree patterns (before analytical to avoid "fault" triggering analytical)
  if (/\bfault\s*trees?\b|\bfailure\s*(paths?|analysis)\b|\bbasic\s*events?\b/.test(normalized)) {
    return decision("faulttree", 0.9);
  }

  // Analytical patterns
  if (/\b(risks?|faults?|errors?|failures?|dead|unused|orphan|violations?|flags?|config|diagnostics?|warnings?|issues?|gaps?|missing|circular)\b/.test(normalized)) {
    return decision("analytical", 0.85);
  }

  // Narration patterns — must precede architecture so "narrate architecture" routes to synthesis
  if (/\b(narrat(?:e|ion|ive))\b/.test(normalized)) {
    return decision("synthesis", 0.9);
  }

  // Architecture patterns (cross-repo topology, service overview)
  if (/\b(architecture|topology|service[\s-]?map|cross[\s-]?repo|(?:architecture|service)\s+overview)\b/.test(normalized)) {
    return decision("architecture", 0.9);
  }

  // Pattern detection patterns
  if (/\b(patterns?|factor(?:y|ies)|singletons?|observers?|adapters?|facades?|repositor(?:y|ies)|middlewares?|decorators?)\b/.test(normalized)) {
    return decision("pattern", 0.85);
  }

  // Documentation patterns (before synthesis to avoid "describe" triggering synthesis)
  if (/\b(docs?|documentation)\b/.test(normalized)) {
    return decision("documentation", 0.85);
  }

  // Synthesis patterns (complex questions)
  if (/\b(why|how|explain|summarize|describe|compare|design)\b/.test(normalized)) {
    return decision("synthesis", 0.7);
  }

  // Default to search
  return decision("search", 0.5);
}

function extractEntities(query: string): string[] {
  const entities: string[] = [];

  // Extract quoted strings
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) {
    entities.push(...quoted.map((q) => q.replace(/"/g, "")));
  }

  // Extract PascalCase identifiers (require at least one internal uppercase
  // letter so sentence-starting words like "Why" or "Please" are excluded).
  const pascalCase = query.match(/\b[A-Z][a-z]+[A-Z][a-zA-Z]*\b/g);
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
