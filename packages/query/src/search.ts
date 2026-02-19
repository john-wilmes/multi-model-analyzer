/**
 * Search query execution via BM25.
 */

import type { SearchStore, SearchResult } from "@mma/storage";

export interface SearchQueryResult {
  readonly results: readonly SearchResult[];
  /** Number of results returned (capped by limit). */
  readonly returnedCount: number;
  readonly description: string;
}

export async function executeSearchQuery(
  query: string,
  searchStore: SearchStore,
  limit: number = 10,
): Promise<SearchQueryResult> {
  const results = await searchStore.search(query, limit);

  return {
    results,
    returnedCount: results.length,
    description: `${results.length} results for "${query}"`,
  };
}
