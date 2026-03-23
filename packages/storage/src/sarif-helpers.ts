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
    level?: string | string[];
    limit?: number;
    offset?: number;
  },
): Promise<PaginatedSarifResults> {
  const { repo, ruleId, level, limit = 50, offset = 0 } = options;

  if (repo) {
    // Single-repo path: already efficient — filter then slice without a separate array
    const repoResults = await getSarifResultsForRepo(kvStore, repo);
    let total = 0;
    const pageResults: SarifResult[] = [];
    for (const result of repoResults) {
      if (ruleId && result.ruleId !== ruleId) continue;
      if (level) {
        if (Array.isArray(level)) {
          if (!level.includes(result.level ?? "")) continue;
        } else {
          if (result.level !== level) continue;
        }
      }
      if (total >= offset && pageResults.length < limit) {
        pageResults.push(result);
      }
      total++;
    }
    return { results: pageResults, total };
  }

  // No repo filter: iterate repos lazily to avoid loading all findings into memory at once.
  // Peak memory is O(max_findings_per_repo + limit) instead of O(all_findings).
  const indexJson = await kvStore.get("sarif:latest:index");
  if (indexJson) {
    try {
      const index = JSON.parse(indexJson) as SarifLatestIndex;
      let total = 0;
      const pageResults: SarifResult[] = [];

      for (const r of index.repos) {
        const repoResults = await getSarifResultsForRepo(kvStore, r);
        for (const result of repoResults) {
          if (ruleId && result.ruleId !== ruleId) continue;
          if (level) {
            if (Array.isArray(level)) {
              if (!level.includes(result.level ?? "")) continue;
            } else {
              if (result.level !== level) continue;
            }
          }
          if (total >= offset && pageResults.length < limit) {
            pageResults.push(result);
          }
          total++;
        }
      }

      return { results: pageResults, total };
    } catch {
      // Fall through to legacy sarif:latest path
    }
  }

  // Legacy fallback: sarif:latest monolithic blob (no per-repo keys, no index)
  const allResults = await getAllFromSarifLatest(kvStore);
  let total = 0;
  const pageResults: SarifResult[] = [];
  for (const result of allResults) {
    if (ruleId && result.ruleId !== ruleId) continue;
    if (level) {
      if (Array.isArray(level)) {
        if (!level.includes(result.level ?? "")) continue;
      } else {
        if (result.level !== level) continue;
      }
    }
    if (total >= offset && pageResults.length < limit) {
      pageResults.push(result);
    }
    total++;
  }
  return { results: pageResults, total };
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
