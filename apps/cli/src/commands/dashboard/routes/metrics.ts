/**
 * Route handlers for metrics-related API endpoints:
 *   GET /api/repos
 *   GET /api/metrics-summary
 *   GET /api/metrics-all
 *   GET /api/metrics/:repo
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ModuleMetrics, RepoMetricsSummary } from "@mma/core";
import type { KVStore } from "@mma/storage";
import { discoverRepos } from "@mma/storage";
import { sendJson, cacheGet, cacheSet, type ParsedQuery } from "../http-utils.js";

export async function handleRepos(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  let repos = await discoverRepos(kvStore);

  // ?indexed=true filters to only repos with ATDI scores (actively indexed, not just imported)
  if (query.single["indexed"] === "true") {
    const raw = await kvStore.get("atdi:system");
    if (raw) {
      try {
        const atdi = JSON.parse(raw) as { repoScores?: Array<{ repo: string }> };
        if (atdi.repoScores) {
          const indexedSet = new Set(atdi.repoScores.map((r) => r.repo));
          repos = repos.filter((r) => indexedSet.has(r));
        }
      } catch { /* use unfiltered */ }
    }
  }

  return sendJson(res, { repos }, 200, corsOrigin);
}

export async function handleMetricsSummary(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const keys = await kvStore.keys("metricsSummary:");
  const result: Record<string, RepoMetricsSummary> = {};
  for (const key of keys) {
    const repo = key.slice("metricsSummary:".length);
    const json = await kvStore.get(key);
    if (json) {
      try {
        result[repo] = JSON.parse(json) as RepoMetricsSummary;
      } catch { /* skip malformed */ }
    }
  }
  return sendJson(res, result, 200, corsOrigin);
}

export async function handleMetricsAll(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const limit = Math.min(parseInt(query.single["limit"] ?? "1000", 10) || 1000, 5000);
  const cacheKey = `metrics-all:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return sendJson(res, cached, 200, corsOrigin);
  const keys = await kvStore.keys("metrics:");
  const result: ModuleMetrics[] = [];
  for (const key of keys) {
    if (result.length >= limit) break;
    const json = await kvStore.get(key);
    if (json) {
      try {
        const metrics = JSON.parse(json) as ModuleMetrics[];
        const remaining = limit - result.length;
        result.push(...metrics.slice(0, remaining));
      } catch { /* skip malformed */ }
    }
  }
  cacheSet(cacheKey, result);
  return sendJson(res, result, 200, corsOrigin);
}

export async function handleMetricsRepo(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  repo: string,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get(`metrics:${repo}`);
  if (!json) return sendJson(res, [], 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as ModuleMetrics[], 200, corsOrigin);
  } catch {
    return sendJson(res, [], 200, corsOrigin);
  }
}
