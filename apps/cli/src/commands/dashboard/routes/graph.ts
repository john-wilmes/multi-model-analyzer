/**
 * Route handlers for graph-related API endpoints:
 *   GET /api/dsm/:repo
 *   GET /api/graph/:repo
 *   GET /api/dependencies/:module
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EdgeKind } from "@mma/core";
import type { KVStore, GraphStore } from "@mma/storage";
import type { CrossRepoGraph } from "@mma/correlation";
import { sendJson, sendError, VALID_EDGE_KINDS, type ParsedQuery } from "../http-utils.js";

export function deserializeGraph(raw: {
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

export async function handleDsm(
  _req: IncomingMessage,
  res: ServerResponse,
  graphStore: GraphStore,
  repo: string,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
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

export async function handleGraph(
  _req: IncomingMessage,
  res: ServerResponse,
  graphStore: GraphStore,
  repo: string,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  const kindParam = query.single["kind"] ?? "imports";
  if (!VALID_EDGE_KINDS.has(kindParam)) {
    return sendError(res, `Invalid edgeKind: ${kindParam}. Must be one of: ${[...VALID_EDGE_KINDS].join(", ")}`, 400, corsOrigin);
  }
  const kind = kindParam;
  const limit = Math.min(Math.max(parseInt(query.single["limit"] ?? "1000", 10) || 1000, 1), 10000);
  const edges = await graphStore.getEdgesByKind(kind as Parameters<typeof graphStore.getEdgesByKind>[0], repo, { limit });
  return sendJson(res, { edges, limit }, 200, corsOrigin);
}

export async function handleDependencies(
  _req: IncomingMessage,
  res: ServerResponse,
  kvStore: KVStore,
  graphStore: GraphStore,
  root: string,
  query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
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
