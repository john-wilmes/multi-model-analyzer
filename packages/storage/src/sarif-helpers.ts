/**
 * SARIF storage helpers for per-repo decomposed reads.
 *
 * Instead of parsing the monolithic sarif:latest blob, consumers
 * can read per-repo keys (sarif:repo:<name>) written by the index pipeline.
 */

import type { KVStore } from "./kv.js";

export interface SarifResult {
  readonly ruleId: string;
  readonly level?: string;
  readonly message: { readonly text: string };
  readonly locations?: readonly unknown[];
  readonly baselineState?: string;
  readonly [key: string]: unknown;
}

export interface SarifLatestIndex {
  readonly repos: string[];
  readonly totalResults: number;
  readonly timestamp: string;
}

export interface PaginatedSarifResults {
  readonly results: SarifResult[];
  readonly total: number;
}

/**
 * Read SARIF results for a single repo from the per-repo key.
 * Falls back to filtering sarif:latest if per-repo key doesn't exist.
 */
export async function getSarifResultsForRepo(
  kvStore: KVStore,
  repo: string,
): Promise<SarifResult[]> {
  // Try per-repo key first
  const perRepoJson = await kvStore.get(`sarif:repo:${repo}`);
  if (perRepoJson) {
    try {
      return JSON.parse(perRepoJson) as SarifResult[];
    } catch {
      // Fall through to sarif:latest
    }
  }

  // Fallback: parse sarif:latest and filter
  return filterSarifLatestByRepo(kvStore, repo);
}

/**
 * Paginated SARIF results with optional repo filter.
 * Uses per-repo keys when available for dramatically smaller reads.
 */
export async function getSarifResultsPaginated(
  kvStore: KVStore,
  options: {
    repo?: string;
    ruleId?: string;
    level?: string;
    limit?: number;
    offset?: number;
  },
): Promise<PaginatedSarifResults> {
  const { repo, ruleId, level, limit = 50, offset = 0 } = options;

  let allResults: SarifResult[];

  if (repo) {
    allResults = await getSarifResultsForRepo(kvStore, repo);
  } else {
    // Try index to get repo list and read per-repo keys
    const indexJson = await kvStore.get("sarif:latest:index");
    if (indexJson) {
      try {
        const index = JSON.parse(indexJson) as SarifLatestIndex;
        allResults = [];
        for (const r of index.repos) {
          const repoResults = await getSarifResultsForRepo(kvStore, r);
          allResults.push(...repoResults);
        }
      } catch {
        allResults = await getAllFromSarifLatest(kvStore);
      }
    } else {
      allResults = await getAllFromSarifLatest(kvStore);
    }
  }

  // Apply filters
  let filtered = allResults;
  if (ruleId) {
    filtered = filtered.filter((r) => r.ruleId === ruleId);
  }
  if (level) {
    filtered = filtered.filter((r) => r.level === level);
  }

  const total = filtered.length;
  const results = filtered.slice(offset, offset + limit);
  return { results, total };
}

async function filterSarifLatestByRepo(
  kvStore: KVStore,
  repo: string,
): Promise<SarifResult[]> {
  const sarifJson = await kvStore.get("sarif:latest");
  if (!sarifJson) return [];
  try {
    const log = JSON.parse(sarifJson) as { runs: Array<{ results: SarifResult[] }> };
    return log.runs.flatMap((r) =>
      r.results.filter((res) => {
        const locs = res.locations as Array<{ logicalLocations?: Array<{ properties?: Record<string, unknown> }> }> | undefined;
        return locs?.some((loc) =>
          loc.logicalLocations?.some((ll) => ll.properties?.["repo"] === repo),
        );
      }),
    );
  } catch {
    return [];
  }
}

async function getAllFromSarifLatest(kvStore: KVStore): Promise<SarifResult[]> {
  const sarifJson = await kvStore.get("sarif:latest");
  if (!sarifJson) return [];
  try {
    const log = JSON.parse(sarifJson) as { runs: Array<{ results: SarifResult[] }> };
    return log.runs.flatMap((r) => r.results);
  } catch {
    return [];
  }
}
