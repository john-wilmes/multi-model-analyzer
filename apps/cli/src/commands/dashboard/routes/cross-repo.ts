/**
 * Route handlers for cross-repo API endpoints:
 *   GET  /api/cross-repo-graph
 *   POST /api/cross-repo-impact
 *   GET  /api/cross-repo-features
 *   GET  /api/cross-repo-faults
 *   GET  /api/cross-repo-catalog
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { KVStore, GraphStore } from "@mma/storage";
import type { CrossRepoGraph } from "@mma/correlation";
import { computeCrossRepoImpact } from "@mma/correlation";
import { sendJson, sendError, readBody, type ParsedQuery } from "../http-utils.js";
import { deserializeGraph } from "./graph.js";

export async function handleCrossRepoGraph(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const raw = await kvStore.get("correlation:graph");
  if (!raw) return sendJson(res, { error: "No correlation data. Run 'mma index' with 2+ repos first." }, 200, corsOrigin);
  try {
    const parsed = JSON.parse(raw) as {
      edges: CrossRepoGraph["edges"];
      repoPairs: string[];
      downstreamMap: [string, string[]][];
      upstreamMap: [string, string[]][];
    };
    const repoFilter = query.single["repo"];
    const allEdges = repoFilter
      ? parsed.edges.filter((e) => e.sourceRepo === repoFilter || e.targetRepo === repoFilter)
      : parsed.edges;
    const limit = Math.min(parseInt(query.single["limit"] ?? "5000", 10) || 5000, 10000);
    const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);
    const edges = allEdges.slice(offset, offset + limit);

    // Filter companion metadata when repo filter is active (exact match, not substring)
    let repoPairs: string[];
    let downstreamMap: [string, string[]][];
    let upstreamMap: [string, string[]][];
    if (repoFilter) {
      // Collect repos that are paired with the filter target
      const relevantRepos = new Set<string>([repoFilter]);
      repoPairs = parsed.repoPairs.filter((p: string) => {
        const [left, right] = p.split(" <-> ");
        if (left === repoFilter || right === repoFilter) {
          if (left) relevantRepos.add(left);
          if (right) relevantRepos.add(right);
          return true;
        }
        return false;
      });
      downstreamMap = parsed.downstreamMap
        .filter(([repo, deps]: [string, string[]]) => repo === repoFilter || deps.includes(repoFilter))
        .map(([repo, deps]: [string, string[]]) => [repo, deps.filter(d => relevantRepos.has(d))]);
      upstreamMap = parsed.upstreamMap
        .filter(([repo, deps]: [string, string[]]) => repo === repoFilter || deps.includes(repoFilter))
        .map(([repo, deps]: [string, string[]]) => [repo, deps.filter(d => relevantRepos.has(d))]);
    } else {
      repoPairs = parsed.repoPairs;
      downstreamMap = parsed.downstreamMap;
      upstreamMap = parsed.upstreamMap;
    }

    return sendJson(res, {
      edges,
      total: allEdges.length,
      limit,
      offset,
      repoPairs,
      downstreamMap,
      upstreamMap,
    }, 200, corsOrigin);
  } catch {
    return sendJson(res, { error: "Corrupted correlation data." }, 200, corsOrigin);
  }
}

export async function handleCrossRepoImpact(
  req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  graphStore: GraphStore,
  corsOrigin: string | undefined,
): Promise<void> {
  try {
    const body = await readBody(req);
    const { files, repo: impactRepo } = JSON.parse(body) as { files: string[]; repo: string };
    if (!files || !impactRepo) {
      return sendError(res, "Missing 'files' or 'repo' in request body", 400, corsOrigin);
    }
    const raw = await kvStore.get("correlation:graph");
    if (!raw) return sendJson(res, { error: "No correlation data. Run 'mma index' with 2+ repos first." }, 200, corsOrigin);
    const parsed = JSON.parse(raw) as {
      edges: CrossRepoGraph["edges"];
      repoPairs: string[];
      downstreamMap: [string, string[]][];
      upstreamMap: [string, string[]][];
    };
    const graph = deserializeGraph(parsed);
    const impact = await computeCrossRepoImpact(files, impactRepo, graphStore, graph);
    return sendJson(res, {
      changedFiles: impact.changedFiles,
      changedRepo: impact.changedRepo,
      affectedWithinRepo: impact.affectedWithinRepo,
      affectedAcrossRepos: Object.fromEntries(impact.affectedAcrossRepos),
      reposReached: impact.reposReached,
    }, 200, corsOrigin);
  } catch (err) {
    return sendError(res, err instanceof Error ? err.message : String(err), 400, corsOrigin);
  }
}

export async function handleCrossRepoFeatures(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  type SharedFlag = { name: string; repos: string[]; coordinated: boolean };
  const raw = await kvStore.get("cross-repo:features");
  if (!raw) return sendJson(res, { flags: [], total: 0, limit: 50, offset: 0 }, 200, corsOrigin);
  try {
    const parsed = JSON.parse(raw) as SharedFlag[] | { sharedFlags?: SharedFlag[] };
    const allFlags: SharedFlag[] = Array.isArray(parsed) ? parsed : (parsed.sharedFlags ?? []);
    const repo = query.single["repo"];
    const search = query.single["search"]?.toLowerCase();
    const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
    const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);
    let filtered = repo ? allFlags.filter((f) => f.repos.includes(repo)) : allFlags;
    if (search) filtered = filtered.filter((f) => f.name.toLowerCase().includes(search));
    const flags = filtered.slice(offset, offset + limit);
    return sendJson(res, { flags, total: filtered.length, limit, offset }, 200, corsOrigin);
  } catch {
    return sendJson(res, { flags: [], total: 0, limit: 50, offset: 0 }, 200, corsOrigin);
  }
}

export async function handleCrossRepoFaults(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  type CrossRepoFaultLink = {
    endpoint: string;
    sourceRepo: string;
    targetRepo: string;
    sourceFaultTreeCount: number;
    targetFaultTreeCount: number;
  };
  const raw = await kvStore.get("cross-repo:faults");
  if (!raw) return sendJson(res, { faultLinks: [], total: 0, limit: 50, offset: 0 }, 200, corsOrigin);
  try {
    const parsed = JSON.parse(raw) as CrossRepoFaultLink[] | { sarifResults?: CrossRepoFaultLink[] };
    const allLinks: CrossRepoFaultLink[] = Array.isArray(parsed) ? parsed : (parsed.sarifResults ?? []);
    const repo = query.single["repo"];
    const search = query.single["search"]?.toLowerCase();
    const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
    const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);
    let filtered = repo
      ? allLinks.filter((l) => l.sourceRepo === repo || l.targetRepo === repo)
      : allLinks;
    if (search) filtered = filtered.filter((l) => l.endpoint.toLowerCase().includes(search));
    const faultLinks = filtered.slice(offset, offset + limit);
    return sendJson(res, { faultLinks, total: filtered.length, limit, offset }, 200, corsOrigin);
  } catch {
    return sendJson(res, { faultLinks: [], total: 0, limit: 50, offset: 0 }, 200, corsOrigin);
  }
}

export async function handleRepoFlags(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  type RepoFlag = { name: string; repo: string; source: string; line?: number; file?: string };

  const repoFilter = query.single["repo"];
  const search = query.single["search"]?.toLowerCase();
  const limit = Math.min(parseInt(query.single["limit"] ?? "100", 10) || 100, 1000);
  const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);

  try {
    // Get the repo list
    const reposRaw = await kvStore.get("repos");
    const repos: string[] = reposRaw ? (JSON.parse(reposRaw) as string[]) : [];

    // Collect flags from each repo
    const allFlags: RepoFlag[] = [];
    const targetRepos = repoFilter ? repos.filter((r) => r === repoFilter) : repos;

    for (const repoName of targetRepos) {
      const raw = await kvStore.get(`flags:${repoName}`);
      if (!raw) continue;
      try {
        type StoredFlag = { name: string; locations?: Array<{ repo: string; module: string; line?: number }>; sdk?: string };
        const parsed = JSON.parse(raw) as StoredFlag[];
        for (const flag of parsed) {
          if (!flag.name) continue;
          const locations = flag.locations ?? [{ repo: repoName, module: '' }];
          for (const loc of locations) {
            allFlags.push({
              name: flag.name,
              repo: repoName,
              source: flag.sdk ?? 'env',
              file: loc.module || undefined,
              line: loc.line,
            });
          }
        }
      } catch {
        // Skip corrupted entries
      }
    }

    let filtered = search ? allFlags.filter((f) =>
      f.name.toLowerCase().includes(search) ||
      f.repo.toLowerCase().includes(search) ||
      (f.file?.toLowerCase().includes(search) ?? false)
    ) : allFlags;

    const total = filtered.length;
    filtered = filtered.slice(offset, offset + limit);

    return sendJson(res, { flags: filtered, total, limit, offset }, 200, corsOrigin);
  } catch {
    return sendJson(res, { flags: [], total: 0, limit, offset }, 200, corsOrigin);
  }
}

export async function handleCrossRepoCatalog(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  type SystemCatalogEntry = {
    entry: {
      name: string;
      purpose: string;
      dependencies: string[];
      apiSurface: { method: string; path: string }[];
      errorHandlingSummary: string;
    };
    repo: string;
    consumers: string[];
    producers: string[];
  };
  const raw = await kvStore.get("cross-repo:catalog");
  if (!raw) return sendJson(res, { entries: [], total: 0, limit: 50, offset: 0 }, 200, corsOrigin);
  try {
    const parsed = JSON.parse(raw) as SystemCatalogEntry[] | { entries?: SystemCatalogEntry[] };
    const allEntries: SystemCatalogEntry[] = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    const repo = query.single["repo"];
    const search = query.single["search"]?.toLowerCase();
    const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
    const offset = Math.max(parseInt(query.single["offset"] ?? "0", 10) || 0, 0);
    let filtered = repo
      ? allEntries.filter(
          (e) => e.repo === repo || e.consumers.includes(repo) || e.producers.includes(repo),
        )
      : allEntries;
    if (search) filtered = filtered.filter((e) => e.entry.name.toLowerCase().includes(search));
    const entries = filtered.slice(offset, offset + limit);
    return sendJson(res, { entries, total: filtered.length, limit, offset }, 200, corsOrigin);
  } catch {
    return sendJson(res, { entries: [], total: 0, limit: 50, offset: 0 }, 200, corsOrigin);
  }
}
