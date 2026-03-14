/**
 * `mma compress` — Gzip the analysis database.
 * `mma dashboard` — Serve a local web dashboard over the analysis database.
 */

import { createReadStream, createWriteStream, statSync, existsSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { exec } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, extname, resolve } from "node:path";
import type {
  ModuleMetrics,
  RepoMetricsSummary,
} from "@mma/core";
import type { KVStore, GraphStore } from "@mma/storage";
import { getSarifResultsPaginated } from "@mma/storage";
import { practicesCommand } from "./practices-cmd.js";

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
  readonly staticDir: string;
}

async function discoverRepos(kvStore: KVStore): Promise<string[]> {
  const repoSet = new Set<string>();
  const prefixes = ["metricsSummary:", "metrics:", "patterns:", "sarif:deadExports:"];
  for (const prefix of prefixes) {
    const keys = await kvStore.keys(prefix);
    for (const key of keys) {
      const repoName = key.slice(prefix.length);
      if (repoName && !repoName.includes(":")) repoSet.add(repoName);
    }
  }
  const commitKeys = await kvStore.keys("commit:");
  for (const key of commitKeys) {
    const repoName = key.slice("commit:".length);
    if (repoName) repoSet.add(repoName);
  }
  return [...repoSet].sort();
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
    const key = decodeURIComponent(k);
    const val = v ? decodeURIComponent(v) : "";
    if (!(key in result.single)) result.single[key] = val;
    if (!result.multi[key]) result.multi[key] = [];
    result.multi[key].push(val);
  }
  return result;
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "http://localhost",
  });
  res.end(body);
}

function sendError(res: ServerResponse, message: string, status = 500): void {
  sendJson(res, { error: message }, status);
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

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  graphStore: GraphStore,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0]!;
  const query = parseQuery(url);

  // GET /api/repos
  if (path === "/api/repos") {
    const repos = await discoverRepos(kvStore);
    return sendJson(res, { repos });
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
    return sendJson(res, result);
  }

  // GET /api/metrics/:repo
  const metricsMatch = path.match(/^\/api\/metrics\/(.+)$/);
  if (metricsMatch) {
    const repo = decodeURIComponent(metricsMatch[1]!);
    const json = await kvStore.get(`metrics:${repo}`);
    if (!json) return sendJson(res, []);
    try {
      return sendJson(res, JSON.parse(json) as ModuleMetrics[]);
    } catch {
      return sendJson(res, []);
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
    const { results: paginated, total: rawTotal } = await getSarifResultsPaginated(kvStore, {
      repo: query.single["repo"],
      ruleId: ruleIdFromPath ?? query.single["rule"],
      level: levelFilter,
      limit,
      offset,
    });

    // Additional fullyQualifiedName filter for backward compat
    let results = paginated;
    if (query.single["repo"] && !ruleIdFromPath) {
      const repoFilter = query.single["repo"];
      results = results.filter((r) => {
        const locs = r.locations as Array<{ logicalLocations?: Array<{ properties?: Record<string, unknown>; fullyQualifiedName?: string }> }> | undefined;
        return !locs || locs.some((loc) =>
          loc.logicalLocations?.some(
            (ll) =>
              ll.properties?.["repo"] === repoFilter ||
              ll.fullyQualifiedName?.startsWith(repoFilter + "/"),
          ),
        );
      });
    }

    return sendJson(res, { results, total: rawTotal });
  }

  // GET /api/graph/:repo?kind=imports&limit=1000
  const graphMatch = path.match(/^\/api\/graph\/(.+)$/);
  if (graphMatch) {
    const repo = decodeURIComponent(graphMatch[1]!);
    const kind = query.single["kind"] ?? "imports";
    const limit = Math.min(Math.max(parseInt(query.single["limit"] ?? "1000", 10) || 1000, 1), 10000);
    const edges = await graphStore.getEdgesByKind(kind as Parameters<typeof graphStore.getEdgesByKind>[0], repo, { limit });
    return sendJson(res, { edges, limit });
  }

  // GET /api/dependencies/:module?depth=3
  const depsMatch = path.match(/^\/api\/dependencies\/(.+)$/);
  if (depsMatch) {
    const root = decodeURIComponent(depsMatch[1]!);
    const maxDepth = parseInt(query.single["depth"] ?? "3", 10) || 3;

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

    return sendJson(res, {
      root,
      dependencies: bfs(modulePath, fwd),
      dependents: bfs(modulePath, rev),
    });
  }

  // GET /api/practices
  if (path === "/api/practices") {
    try {
      const report = await practicesCommand({
        kvStore,
        format: "json",
        silent: true,
      });
      return sendJson(res, report);
    } catch (err) {
      return sendError(res, err instanceof Error ? err.message : String(err));
    }
  }

  // GET /api/patterns/:repo
  const patternsMatch = path.match(/^\/api\/patterns\/(.+)$/);
  if (patternsMatch) {
    const repo = decodeURIComponent(patternsMatch[1]!);
    const json = await kvStore.get(`patterns:${repo}`);
    if (!json) return sendJson(res, {});
    try {
      return sendJson(res, JSON.parse(json) as unknown);
    } catch {
      return sendJson(res, {});
    }
  }

  return sendError(res, "Not found", 404);
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const { kvStore, graphStore, port, staticDir } = options;

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = req.url ?? "/";
      const path = url.split("?")[0]!;

      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "http://localhost" });
        res.end();
        return;
      }

      if (path.startsWith("/api/")) {
        handleApi(req, res, kvStore, graphStore).catch((err: unknown) => {
          if (!res.headersSent) {
            sendError(res, err instanceof Error ? err.message : String(err));
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
    server.listen(port, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const url = `http://localhost:${port}`;
  console.log(`Dashboard running at ${url}`);

  // Auto-open browser (best-effort, platform-aware)
  const opener =
    process.platform === "darwin"
      ? `open ${url}`
      : process.platform === "win32"
        ? `start ${url}`
        : `xdg-open ${url}`;
  exec(opener, () => { /* ignore errors */ });

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

