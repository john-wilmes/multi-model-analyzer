/**
 * Natural language query interface over functional model.
 *
 * Routes queries to appropriate backend:
 * - Structural queries -> graph traversal
 * - Search queries -> BM25
 * - Analytical queries -> pre-computed results
 */

import type { ServiceCatalogEntry, Summary } from "@mma/core";
import type { SearchStore } from "@mma/storage";

export type QueryKind = "structural" | "search" | "analytical";

export interface QueryResult {
  readonly kind: QueryKind;
  readonly answer: string;
  readonly sources: readonly QuerySource[];
  readonly confidence: number;
}

export interface QuerySource {
  readonly entityId: string;
  readonly relevance: number;
  readonly snippet: string;
}

/** @internal */
export function classifyQuery(query: string): QueryKind {
  const structural = /\b(calls?|depends?|imports?|extends?|implements?|graph|reference|definition)\b/i;
  const analytical = /\b(risk|fault|error|failure|bug|vulnerability|issue|problem|configuration|flag)\b/i;

  if (structural.test(query)) return "structural";
  if (analytical.test(query)) return "analytical";
  return "search";
}

/** @internal */
export async function executeQuery(
  query: string,
  searchStore: SearchStore,
  catalog: readonly ServiceCatalogEntry[],
  summaries: ReadonlyMap<string, Summary>,
): Promise<QueryResult> {
  const kind = classifyQuery(query);

  switch (kind) {
    case "search":
      return executeSearchQuery(query, searchStore);
    case "structural":
      return executeStructuralQuery(query, catalog, summaries);
    case "analytical":
      return executeAnalyticalQuery(query, catalog);
  }
}

async function executeSearchQuery(
  query: string,
  searchStore: SearchStore,
): Promise<QueryResult> {
  const results = await searchStore.search(query, 5);

  if (results.length === 0) {
    return {
      kind: "search",
      answer: "No matching results found.",
      sources: [],
      confidence: 0,
    };
  }

  const answer = results
    .map((r) => `- ${r.metadata["entityId"] ?? r.id}: ${r.content.slice(0, 200)}`)
    .join("\n");

  return {
    kind: "search",
    answer,
    sources: results.map((r) => ({
      entityId: r.id,
      relevance: r.score,
      snippet: r.content.slice(0, 100),
    })),
    confidence: Math.min(results[0]!.score / 10, 1),
  };
}

async function executeStructuralQuery(
  query: string,
  catalog: readonly ServiceCatalogEntry[],
  _summaries: ReadonlyMap<string, Summary>,
): Promise<QueryResult> {
  // Simple keyword matching for POC
  const queryLower = query.toLowerCase();

  const matchingServices = catalog.filter(
    (s) =>
      queryLower.includes(s.name.toLowerCase()) ||
      s.purpose.toLowerCase().includes(queryLower.split(" ").pop() ?? ""),
  );

  if (matchingServices.length > 0) {
    const answer = matchingServices
      .map((s) => {
        const deps = s.dependencies.length > 0
          ? `Dependencies: ${s.dependencies.join(", ")}`
          : "No dependencies";
        return `${s.name}: ${s.purpose}\n  ${deps}`;
      })
      .join("\n\n");

    return {
      kind: "structural",
      answer,
      sources: matchingServices.map((s) => ({
        entityId: s.name,
        relevance: 1,
        snippet: s.purpose,
      })),
      confidence: 0.7,
    };
  }

  return {
    kind: "structural",
    answer: "No structural information found for this query.",
    sources: [],
    confidence: 0,
  };
}

async function executeAnalyticalQuery(
  _query: string,
  catalog: readonly ServiceCatalogEntry[],
): Promise<QueryResult> {
  const matchingServices = catalog.filter(
    (s) => s.errorHandlingSummary !== "No error logging detected",
  );

  const answer = matchingServices
    .map((s) => `${s.name}: ${s.errorHandlingSummary}`)
    .join("\n");

  return {
    kind: "analytical",
    answer: answer || "No analytical data available for this query.",
    sources: matchingServices.map((s) => ({
      entityId: s.name,
      relevance: 0.5,
      snippet: s.errorHandlingSummary,
    })),
    confidence: 0.5,
  };
}
