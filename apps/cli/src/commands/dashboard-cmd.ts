/**
 * `mma compress` — Gzip the analysis database.
 * `mma dashboard` — Serve a local web dashboard over the analysis database.
 */

import { createReadStream, createWriteStream, statSync, existsSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, extname, resolve } from "node:path";
import type {
  ModuleMetrics,
  RepoMetricsSummary,
  EdgeKind,
} from "@mma/core";
import type { KVStore, GraphStore } from "@mma/storage";
import { getSarifResultsPaginated, discoverRepos } from "@mma/storage";
import { practicesCommand } from "./practices-cmd.js";
import { computeCrossRepoImpact } from "@mma/correlation";
import type { CrossRepoGraph } from "@mma/correlation";
import { computeBlastRadius, computePageRank } from "@mma/query";

// ---------------------------------------------------------------------------
// compress
// ---------------------------------------------------------------------------

export async function compressCommand(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const gzPath = `${dbPath}.gz`;
  const beforeBytes = statSync(dbPath).size;

  await pipeline(createReadStream(dbPath), createGzip(), createWriteStream(gzPath));

  const afterBytes = statSync(gzPath).size;
  const ratio = ((1 - afterBytes / beforeBytes) * 100).toFixed(1);

  console.log(`Compressed: ${dbPath}`);
  console.log(`  Before: ${(beforeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  After:  ${(afterBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Ratio:  ${ratio}% reduction`);
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

export interface DashboardOptions {
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly port: number;
  readonly host: string;
  readonly staticDir: string;
  /** Explicit origins allowed for CORS. Empty set = no CORS headers (localhost-only default). */
  readonly corsOrigins?: ReadonlySet<string>;
}


interface ParsedQuery {
  single: Record<string, string>;
  multi: Record<string, string[]>;
}

function parseQuery(url: string): ParsedQuery {
  const idx = url.indexOf("?");
  const result: ParsedQuery = { single: {}, multi: {} };
  if (idx === -1) return result;
  for (const part of url.slice(idx + 1).split("&")) {
    const [k, v] = part.split("=");
    if (!k) continue;
    const key = decodeURIComponent(k.replace(/\+/g, "%20"));
    const val = v ? decodeURIComponent(v.replace(/\+/g, "%20")) : "";
    if (!(key in result.single)) result.single[key] = val;
    if (!result.multi[key]) result.multi[key] = [];
    result.multi[key].push(val);
  }
  return result;
}

const VALID_EDGE_KINDS = new Set<string>(["calls", "imports", "extends", "implements", "depends-on", "contains", "service-call"]);

// Simple TTL cache for read-only endpoints (C5)
interface CacheEntry { data: unknown; expires: number }
const apiCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheGet(key: string): unknown {
  const entry = apiCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) { apiCache.delete(key); return undefined; }
  return entry.data;
}

function cacheSet(key: string, data: unknown): void {
  apiCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function sendJson(res: ServerResponse, data: unknown, status = 200, corsOrigin?: string): void {
  const body = JSON.stringify(data);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  };
  if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res: ServerResponse, message: string, status = 500, corsOrigin?: string): void {
  sendJson(res, { error: message }, status, corsOrigin);
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
): Promise<void> {
  const { readFile } = await import("node:fs/promises");

  const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };

  let urlPath = req.url?.split("?")[0] ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = resolve(join(staticDir, urlPath));
  const resolvedStaticDir = resolve(staticDir);
  if (!filePath.startsWith(resolvedStaticDir + "/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback — serve index.html
    try {
      const data = await readFile(join(staticDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }
}

/** Resolve the allowed CORS origin for a request, given the server's allowlist. */
function getAllowedOrigin(req: IncomingMessage, corsOrigins: ReadonlySet<string>): string | undefined {
  if (corsOrigins.size === 0) return undefined;
  const origin = req.headers.origin;
  if (!origin) return undefined;
  return corsOrigins.has(origin) ? origin : undefined;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  graphStore: GraphStore,
  corsOrigin: string | undefined,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0]!;
  const query = parseQuery(url);

  // GET /api/repos
  if (path === "/api/repos") {
    const repos = await discoverRepos(kvStore);
    return sendJson(res, { repos }, 200, corsOrigin);
  }

  // GET /api/metrics-summary
  if (path === "/api/metrics-summary") {
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

  // GET /api/metrics-all?limit=1000
  if (path === "/api/metrics-all") {
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

  // GET /api/dsm/:repo
  const dsmMatch = path.match(/^\/api\/dsm\/(.+)$/);
  if (dsmMatch) {
    const repo = decodeURIComponent(dsmMatch[1]!);
    const kindParam = query.single["kind"] ?? "imports";
    if (!VALID_EDGE_KINDS.has(kindParam)) {
      return sendError(res, `Invalid edgeKind: ${kindParam}. Must be one of: ${[...VALID_EDGE_KINDS].join(", ")}`, 400, corsOrigin);
    }
    const edgeKind = kindParam as EdgeKind;
    const edges = await graphStore.getEdgesByKind(edgeKind, repo);

    // Count connections per module
    const connCount = new Map<string, number>();
    for (const e of edges) {
      connCount.set(e.source, (connCount.get(e.source) ?? 0) + 1);
      connCount.set(e.target, (connCount.get(e.target) ?? 0) + 1);
    }

    // Get top 80 modules by connection count
    let modules = [...connCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    if (modules.length > 80) modules = modules.slice(0, 80);
    modules.sort(); // alphabetical for display

    const idx = new Map(modules.map((m, i) => [m, i]));
    const n = modules.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0) as number[]);

    for (const e of edges) {
      const si = idx.get(e.source);
      const ti = idx.get(e.target);
      if (si !== undefined && ti !== undefined) {
        matrix[si]![ti]! += 1;
      }
    }

    return sendJson(res, { modules, matrix, edgeKind }, 200, corsOrigin);
  }

  // GET /api/metrics/:repo
  const metricsMatch = path.match(/^\/api\/metrics\/(.+)$/);
  if (metricsMatch) {
    const repo = decodeURIComponent(metricsMatch[1]!);
    const json = await kvStore.get(`metrics:${repo}`);
    if (!json) return sendJson(res, [], 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as ModuleMetrics[], 200, corsOrigin);
    } catch {
      return sendJson(res, [], 200, corsOrigin);
    }
  }

  // GET /api/findings?repo=X&level=Y&rule=Z&limit=50&offset=0
  // GET /api/findings/:ruleId
  if (path === "/api/findings" || path.startsWith("/api/findings/")) {
    const ruleIdFromPath = path.startsWith("/api/findings/")
      ? decodeURIComponent(path.slice("/api/findings/".length))
      : undefined;

    const limit = Math.min(parseInt(query.single["limit"] ?? "50", 10) || 50, 500);
    const offset = parseInt(query.single["offset"] ?? "0", 10) || 0;

    // Use per-repo SARIF keys when repo filter is present (avoids parsing monolithic blob)
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

  // GET /api/graph/:repo?kind=imports&limit=1000
  const graphMatch = path.match(/^\/api\/graph\/(.+)$/);
  if (graphMatch) {
    const repo = decodeURIComponent(graphMatch[1]!);
    const kindParam = query.single["kind"] ?? "imports";
    if (!VALID_EDGE_KINDS.has(kindParam)) {
      return sendError(res, `Invalid edgeKind: ${kindParam}. Must be one of: ${[...VALID_EDGE_KINDS].join(", ")}`, 400, corsOrigin);
    }
    const kind = kindParam;
    const limit = Math.min(Math.max(parseInt(query.single["limit"] ?? "1000", 10) || 1000, 1), 10000);
    const edges = await graphStore.getEdgesByKind(kind as Parameters<typeof graphStore.getEdgesByKind>[0], repo, { limit });
    return sendJson(res, { edges, limit }, 200, corsOrigin);
  }

  // GET /api/dependencies/:module?depth=3
  const depsMatch = path.match(/^\/api\/dependencies\/(.+)$/);
  if (depsMatch) {
    const root = decodeURIComponent(depsMatch[1]!);
    const maxDepth = Math.min(parseInt(query.single["depth"] ?? "3", 10) || 3, 10);

    // root may be "repo:module" or just "module"
    const colonIdx = root.indexOf(":");
    const repo = colonIdx >= 0 ? root.slice(0, colonIdx) : undefined;
    const modulePath = colonIdx >= 0 ? root.slice(colonIdx + 1) : root;

    const allEdges = await graphStore.getEdgesByKind("imports", repo);

    // Build forward (dependencies) and reverse (dependents) maps
    const fwd = new Map<string, string[]>();
    const rev = new Map<string, string[]>();
    for (const e of allEdges) {
      if (!fwd.has(e.source)) fwd.set(e.source, []);
      fwd.get(e.source)!.push(e.target);
      if (!rev.has(e.target)) rev.set(e.target, []);
      rev.get(e.target)!.push(e.source);
    }

    function bfs(
      start: string,
      neighbors: Map<string, string[]>,
    ): Array<{ path: string; depth: number }> {
      const visited = new Set<string>([start]);
      const queue: Array<{ node: string; depth: number }> = [{ node: start, depth: 0 }];
      const result: Array<{ path: string; depth: number }> = [];
      while (queue.length > 0) {
        const { node, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;
        for (const next of neighbors.get(node) ?? []) {
          if (!visited.has(next)) {
            visited.add(next);
            result.push({ path: next, depth: depth + 1 });
            queue.push({ node: next, depth: depth + 1 });
          }
        }
      }
      return result;
    }

    // Optional cross-repo expansion
    let crossRepoDeps: Record<string, Array<{ path: string; depth: number }>> | undefined;
    if (query.single["crossRepo"] === "true" && repo) {
      const raw = await kvStore.get("correlation:graph");
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as {
            edges: CrossRepoGraph["edges"];
            repoPairs: string[];
            downstreamMap: [string, string[]][];
            upstreamMap: [string, string[]][];
          };
          // Find cross-repo edges originating from this module's repo
          crossRepoDeps = {};
          for (const e of parsed.edges) {
            if (e.sourceRepo === repo && e.edge.source === modulePath) {
              if (!crossRepoDeps[e.targetRepo]) crossRepoDeps[e.targetRepo] = [];
              const bucket = crossRepoDeps[e.targetRepo]!;
              bucket.push({ path: e.edge.target, depth: 1 });
            }
          }
          if (Object.keys(crossRepoDeps).length === 0) crossRepoDeps = undefined;
        } catch { /* ignore parse errors */ }
      }
    }

    return sendJson(res, {
      root,
      dependencies: bfs(modulePath, fwd),
      dependents: bfs(modulePath, rev),
      crossRepoDeps,
    }, 200, corsOrigin);
  }

  // GET /api/practices
  if (path === "/api/practices") {
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

  // GET /api/patterns/:repo
  const patternsMatch = path.match(/^\/api\/patterns\/(.+)$/);
  if (patternsMatch) {
    const repo = decodeURIComponent(patternsMatch[1]!);
    const json = await kvStore.get(`patterns:${repo}`);
    if (!json) return sendJson(res, {}, 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    } catch {
      return sendJson(res, {}, 200, corsOrigin);
    }
  }


  // GET /api/hotspots?limit=50&offset=0
  if (path === "/api/hotspots") {
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

  // GET /api/temporal-coupling
  if (path === "/api/temporal-coupling") {
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

  // GET /api/temporal-coupling/:repo
  const tcRepoMatch = path.match(/^\/api\/temporal-coupling\/(.+)$/);
  if (tcRepoMatch) {
    const repo = decodeURIComponent(tcRepoMatch[1]!);
    const json = await kvStore.get(`temporal-coupling:${repo}`);
    if (!json) return sendJson(res, { pairs: [], commitsAnalyzed: 0, commitsSkipped: 0 }, 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    } catch {
      return sendJson(res, { pairs: [], commitsAnalyzed: 0, commitsSkipped: 0 }, 200, corsOrigin);
    }
  }

  // GET /api/atdi
  if (path === "/api/atdi") {
    const json = await kvStore.get("atdi:system");
    if (!json) return sendJson(res, null, 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    } catch {
      return sendJson(res, null, 200, corsOrigin);
    }
  }

  // GET /api/atdi/:repo
  const atdiMatch = path.match(/^\/api\/atdi\/(.+)$/);
  if (atdiMatch) {
    const repo = decodeURIComponent(atdiMatch[1]!);
    const json = await kvStore.get(`atdi:${repo}`);
    if (!json) return sendJson(res, null, 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    } catch {
      return sendJson(res, null, 200, corsOrigin);
    }
  }

  // GET /api/debt
  if (path === "/api/debt") {
    const json = await kvStore.get("debt:system");
    if (!json) return sendJson(res, null, 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    } catch {
      return sendJson(res, null, 200, corsOrigin);
    }
  }

  // GET /api/debt/:repo
  const debtMatch = path.match(/^\/api\/debt\/(.+)$/);
  if (debtMatch) {
    const repo = decodeURIComponent(debtMatch[1]!);
    const json = await kvStore.get(`debt:${repo}`);
    if (!json) return sendJson(res, null, 200, corsOrigin);
    try {
      return sendJson(res, JSON.parse(json) as unknown, 200, corsOrigin);
    } catch {
      return sendJson(res, null, 200, corsOrigin);
    }
  }

  // GET /api/cross-repo-graph?repo=X&limit=200&offset=0
  if (path === "/api/cross-repo-graph") {
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
      const limit = Math.min(parseInt(query.single["limit"] ?? "200", 10) || 200, 2000);
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

  // POST /api/cross-repo-impact  body: { files: string[], repo: string }
  if (path === "/api/cross-repo-impact" && req.method === "POST") {
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

  // GET /api/cross-repo-features?repo=X&limit=50&offset=0&search=term
  if (path === "/api/cross-repo-features") {
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

  // GET /api/cross-repo-faults?repo=X&limit=50&offset=0&search=term
  if (path === "/api/cross-repo-faults") {
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

  // GET /api/cross-repo-catalog?repo=X&limit=50&offset=0&search=term
  if (path === "/api/cross-repo-catalog") {
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

  // GET /api/repo-states
  if (path === "/api/repo-states") {
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

  // GET /api/blast-radius/:repo[?file=path&maxDepth=N]
  const blastMatch = path.match(/^\/api\/blast-radius\/(.+)$/);
  if (blastMatch) {
    const repo = decodeURIComponent(blastMatch[1]!);
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

  return sendError(res, "Not found", 404, corsOrigin);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body exceeds 1MB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function deserializeGraph(raw: {
  edges: CrossRepoGraph["edges"];
  repoPairs: string[];
  downstreamMap: [string, string[]][];
  upstreamMap: [string, string[]][];
}): CrossRepoGraph {
  return {
    edges: raw.edges,
    repoPairs: new Set(raw.repoPairs),
    downstreamMap: new Map(raw.downstreamMap.map(([k, v]) => [k, new Set(v)])),
    upstreamMap: new Map(raw.upstreamMap.map(([k, v]) => [k, new Set(v)])),
  };
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const { kvStore, graphStore, port, staticDir } = options;
  const corsOrigins = options.corsOrigins ?? new Set<string>();

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = req.url ?? "/";
      const path = url.split("?")[0]!;
      const corsOrigin = getAllowedOrigin(req, corsOrigins);

      if (req.method === "OPTIONS") {
        const headers: Record<string, string | number> = { Allow: "GET, POST, OPTIONS" };
        if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
        res.writeHead(204, headers);
        res.end();
        return;
      }

      if (path.startsWith("/api/")) {
        handleApi(req, res, kvStore, graphStore, corsOrigin).catch((err: unknown) => {
          if (!res.headersSent) {
            sendError(res, err instanceof Error ? err.message : String(err), 500, corsOrigin);
          }
        });
      } else {
        serveStatic(req, res, staticDir).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(err instanceof Error ? err.message : String(err));
          }
        });
      }
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(port, options.host, () => resolve());
    server.once("error", reject);
  });

  const browseHost = options.host === "0.0.0.0" ? "localhost" : options.host;
  const url = `http://${browseHost}:${port}`;
  console.log(`Dashboard running at ${url}${options.host === "0.0.0.0" ? " (listening on all interfaces)" : ""}`);

  // Auto-open browser (best-effort, platform-aware, no shell interpolation)
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", url], { stdio: "ignore" })
      .on("error", () => { /* ignore – browser open is best-effort */ })
      .unref();
  } else {
    const binary = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(binary, [url], { stdio: "ignore" })
      .on("error", () => { /* ignore – browser open is best-effort */ })
      .unref();
  }

  // Clean shutdown on SIGINT / SIGTERM
  const shutdown = (): void => {
    console.log("\nShutting down dashboard…");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Keep the process alive
  await new Promise<never>(() => { /* runs until signal */ });
}

// ---------------------------------------------------------------------------
// Auto-decompress helper (used by index.ts before opening stores)
// ---------------------------------------------------------------------------

export async function maybeDecompress(dbPath: string): Promise<void> {
  const gzPath = `${dbPath}.gz`;
  if (!existsSync(dbPath) && existsSync(gzPath)) {
    console.log(`Decompressing ${gzPath} → ${dbPath}`);
    await pipeline(
      createReadStream(gzPath),
      createGunzip(),
      createWriteStream(dbPath),
    );
  }
}

