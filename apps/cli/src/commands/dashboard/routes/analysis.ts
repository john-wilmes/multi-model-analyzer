/**
 * Route handlers for analysis API endpoints:
 *   GET /api/findings[/:ruleId]
 *   GET /api/practices
 *   GET /api/patterns/:repo
 *   GET /api/hotspots
 *   GET /api/temporal-coupling[/:repo]
 *   GET /api/atdi[/:repo]
 *   GET /api/debt[/:repo]
 *   GET /api/blast-radius/:repo
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { KVStore, GraphStore } from "@mma/storage";
import { getSarifResultsPaginated } from "@mma/storage";
import { computeBlastRadius, computePageRank } from "@mma/query";
import { practicesCommand } from "../../practices-cmd.js";
import { sendJson, sendError, cacheGet, cacheSet, type ParsedQuery } from "../http-utils.js";

export async function handleFindings(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  path: string,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const ruleIdFromPath = path.startsWith("/api/findings/")
    ? decodeURIComponent(path.slice("/api/findings/".length))
    : undefined;

  const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
  const offset = parseInt(query.single["offset"] ?? "0", 10) || 0;

  const levelParam = query.multi["level"];
  const levelFilter = levelParam && levelParam.length > 0 ? (levelParam.length === 1 ? levelParam[0] : levelParam) : undefined;
  const { results, total } = await getSarifResultsPaginated(kvStore, {
    repo: query.single["repo"],
    ruleId: ruleIdFromPath ?? query.single["rule"],
    level: levelFilter,
    limit,
    offset,
  });

  return sendJson(res, { results, total, limit, offset }, 200, corsOrigin);
}

export async function handlePractices(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const cached = cacheGet("practices");
  if (cached !== undefined) return sendJson(res, cached, 200, corsOrigin);
  try {
    const report = await practicesCommand({
      kvStore,
      format: "json",
      silent: true,
    });
    cacheSet("practices", report);
    return sendJson(res, report, 200, corsOrigin);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
  }
}

export async function handlePatterns(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  repo: string,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get(`patterns:${repo}`);
  if (!json) return sendJson(res, {}, 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
  } catch {
    return sendJson(res, {}, 200, corsOrigin);
  }
}

export async function handleHotspots(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
  const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);
  const keys = await kvStore.keys("hotspots:");
  const result: Array<unknown> = [];
  for (const key of keys) {
    const repo = key.slice("hotspots:".length);
    const json = await kvStore.get(key);
    if (json) {
      try {
        const hotspots = JSON.parse(json) as Array<unknown>;
        for (const h of hotspots) {
          result.push({ ...(h as Record<string, unknown>), repo });
        }
      } catch { /* skip malformed */ }
    }
  }
  // Sort by hotspotScore descending
  (result as Array<Record<string, unknown>>).sort((a, b) => (b["hotspotScore"] as number) - (a["hotspotScore"] as number));
  const page = result.slice(offset, offset + limit);
  return sendJson(res, { results: page, total: result.length, limit, offset }, 200, corsOrigin);
}

export async function handleTemporalCouplingAll(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const keys = await kvStore.keys("temporal-coupling:");
  const allPairs: Array<unknown> = [];
  for (const key of keys) {
    const repo = key.slice("temporal-coupling:".length);
    const json = await kvStore.get(key);
    if (json) {
      try {
        const data = JSON.parse(json) as { pairs: Array<unknown> };
        for (const p of data.pairs ?? []) {
          allPairs.push({ ...(p as Record<string, unknown>), repo });
        }
      } catch { /* skip malformed */ }
    }
  }
  (allPairs as Array<Record<string, unknown>>).sort((a, b) => (b["coChangeCount"] as number) - (a["coChangeCount"] as number));
  return sendJson(res, allPairs, 200, corsOrigin);
}

export async function handleTemporalCouplingRepo(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  repo: string,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get(`temporal-coupling:${repo}`);
  if (!json) return sendJson(res, { pairs: [], commitsAnalyzed: 0, commitsSkipped: 0 }, 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
  } catch {
    return sendJson(res, { pairs: [], commitsAnalyzed: 0, commitsSkipped: 0 }, 200, corsOrigin);
  }
}

export async function handleAtdiSystem(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get("atdi:system");
  if (!json) return sendJson(res, null, 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
  } catch {
    return sendJson(res, null, 200, corsOrigin);
  }
}

export async function handleAtdiRepo(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  repo: string,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get(`atdi:${repo}`);
  if (!json) return sendJson(res, null, 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
  } catch {
    return sendJson(res, null, 200, corsOrigin);
  }
}

export async function handleDebtSystem(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get("debt:system");
  if (!json) return sendJson(res, null, 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
  } catch {
    return sendJson(res, null, 200, corsOrigin);
  }
}

export async function handleDebtRepo(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  repo: string,
  corsOrigin: string | undefined,
): Promise<void> {
  const json = await kvStore.get(`debt:${repo}`);
  if (!json) return sendJson(res, null, 200, corsOrigin);
  try {
    return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
  } catch {
    return sendJson(res, null, 200, corsOrigin);
  }
}

export async function handleBlastRadius(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  graphStore: GraphStore,
  repo: string,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const fileParam = query.single["file"];
  const parsedMaxDepth = Number.parseInt(query.single["maxDepth"] ?? "", 10);
  const maxDepth = Number.isNaN(parsedMaxDepth)
    ? 5
    : Math.min(Math.max(parsedMaxDepth, 1), 10);

  if (!fileParam) {
    // Overview mode: return pre-computed PageRank + reach counts from KV
    const cacheKey = `blast-overview:${repo}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return sendJson(res, cached, 200, corsOrigin);

    const prRaw = await kvStore.get(`sarif:blastRadius:${repo}`);
    const rcRaw = await kvStore.get(`reachCounts:${repo}`);

    type PrEntry = { ruleId: string; message: { text: string }; properties?: { pageRankScore?: number; rank?: number }; locations?: Array<{ logicalLocations?: Array<{ fullyQualifiedName?: string }> }> };
    let prSarif: PrEntry[] = [];
    let rcEntries: [string, number][] = [];
    try { prSarif = prRaw ? JSON.parse(prRaw) as PrEntry[] : []; } catch { /* malformed */ }
    try { rcEntries = rcRaw ? JSON.parse(rcRaw) as [string, number][] : []; } catch { /* malformed */ }
    const reachMap = new Map(rcEntries);

    const files = prSarif.map((r) => {
      const filePath = r.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? "";
      return {
        path: filePath,
        score: r.properties?.pageRankScore ?? 0,
        rank: r.properties?.rank ?? 0,
        reachCount: reachMap.get(filePath) ?? 0,
      };
    });

    const result = { repo, files, totalNodes: reachMap.size };
    cacheSet(cacheKey, result);
    return sendJson(res, result, 200, corsOrigin);
  }

  // Detail mode: compute blast radius for a specific file
  const cacheKey = `blast-detail:${repo}:${fileParam}:${maxDepth}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return sendJson(res, cached, 200, corsOrigin);

  const br = await computeBlastRadius([fileParam], graphStore, { maxDepth, repo });

  // Compute PageRank on import edges for scoring
  const importEdges = await graphStore.getEdgesByKind("imports", repo);
  const pr = computePageRank(importEdges);

  const affectedFiles = br.affectedFiles.map((f) => ({
    ...f,
    score: pr.scores.get(f.path) ?? 0,
  }));

  const result = {
    changedFiles: br.changedFiles,
    affectedFiles,
    totalAffected: br.totalAffected,
    maxDepth: br.maxDepth,
    description: br.description,
  };
  cacheSet(cacheKey, result);
  return sendJson(res, result, 200, corsOrigin);
}

export async function handleRepoStates(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const keys = await kvStore.keys("repo-state:");
  const total = keys.length;
  const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
  const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);
  const slicedKeys = keys.slice(offset, offset + limit);
  const states: Array<unknown> = [];
  for (const k of slicedKeys) {
    const raw = await kvStore.get(k);
    if (raw) {
      try { states.push(JSON.parse(raw) as unknown); } catch { /* skip */ }
    }
  }
  return sendJson(res, { states, total, limit, offset }, 200, corsOrigin);
}
