/**
 * Blast radius analysis: reverse BFS to find all files affected by changes.
 *
 * Given a set of changed files, traverses the dependency graph in reverse
 * (following who-imports-me edges) to identify all transitively affected files.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { parseSymbolId } from "@mma/core";
import type { GraphEdge } from "@mma/core";
import type { GraphStore, SearchStore } from "@mma/storage";
import type { CrossRepoGraph } from "@mma/correlation";

/** Yield to the event loop to prevent blocking on large graph traversals. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export interface AffectedFile {
  readonly path: string;
  readonly depth: number;
  readonly via: "imports" | "calls" | "both";
  readonly repo: string;
  readonly score?: number;
  readonly reachCount?: number;
}

export interface BlastRadiusResult {
  readonly changedFiles: string[];
  readonly affectedFiles: AffectedFile[];
  readonly totalAffected: number;
  readonly maxDepth: number;
  readonly description: string;
  readonly crossRepoAffected?: Map<string, AffectedFile[]>;
}

export async function computeBlastRadius(
  changedFiles: string[],
  graphStore: GraphStore,
  options?: {
    maxDepth?: number;
    includeCallGraph?: boolean;
    repo?: string;
    crossRepoGraph?: CrossRepoGraph;
    pageRankScores?: ReadonlyMap<string, number>;
  },
  searchStore?: SearchStore,
): Promise<BlastRadiusResult> {
  const maxDepth = options?.maxDepth ?? 5;
  const includeCallGraph = options?.includeCallGraph ?? true;
  const repo = options?.repo;

  // Resolve changed files: try BM25 fallback if no direct graph edges
  const resolvedFiles = new Set<string>();
  for (const file of changedFiles) {
    const directEdges = await graphStore.getEdgesTo(file, repo);
    if (directEdges.length > 0 || !searchStore) {
      resolvedFiles.add(file);
    } else {
      // BM25 fallback
      const results = await searchStore.search(file, 3);
      const match = repo
        ? results.find((r) => r.metadata?.["repo"] === repo)
        : results[0];
      if (match) {
        const parsed = parseSymbolId(match.id);
        const fileId = parsed.symbolName
          ? (parsed.isCanonical ? `${parsed.repo}:${parsed.filePath}` : parsed.filePath)
          : match.id;
        resolvedFiles.add(fileId);
      } else {
        resolvedFiles.add(file); // keep original even if unresolved
      }
    }
  }

  // Multi-source reverse BFS
  const visited = new Map<string, { depth: number; via: Set<string> }>();
  const queue: Array<{ node: string; depth: number; edgeKind: string }> = [];

  // Seed queue with changed files at depth 0 (they aren't "affected", they're the source)
  for (const file of resolvedFiles) {
    visited.set(file, { depth: 0, via: new Set() });
    queue.push({ node: file, depth: 0, edgeKind: "source" });
  }

  let bfsIter = 0;
  let queueHead = 0;
  while (queueHead < queue.length) {
    if (++bfsIter % 1000 === 0) await yieldToEventLoop();
    const current = queue[queueHead++]!;
    if (current.depth >= maxDepth) continue;

    // Get all files that import this file (reverse: getEdgesTo finds edges where target = current)
    const importEdges = await graphStore.getEdgesTo(current.node, repo);
    const reverseEdges = importEdges.filter((e) => e.kind === "imports");

    // Optionally include call edges
    const callEdges = includeCallGraph
      ? importEdges.filter((e) => e.kind === "calls")
      : [];

    for (const edge of reverseEdges) {
      const nextDepth = current.depth + 1;
      const existing = visited.get(edge.source);
      if (!existing) {
        visited.set(edge.source, { depth: nextDepth, via: new Set(["imports"]) });
        queue.push({ node: edge.source, depth: nextDepth, edgeKind: "imports" });
      } else {
        existing.via.add("imports");
      }
    }

    for (const edge of callEdges) {
      const nextDepth = current.depth + 1;
      const existing = visited.get(edge.source);
      if (!existing) {
        visited.set(edge.source, { depth: nextDepth, via: new Set(["calls"]) });
        queue.push({ node: edge.source, depth: nextDepth, edgeKind: "calls" });
      } else {
        existing.via.add("calls");
      }
    }
  }

  // Build result: exclude the original changed files from "affected"
  const affectedFiles: AffectedFile[] = [];
  for (const [path, info] of visited) {
    if (resolvedFiles.has(path)) continue; // skip source files
    const via = info.via.has("imports") && info.via.has("calls")
      ? "both" as const
      : info.via.has("imports") ? "imports" as const : "calls" as const;
    affectedFiles.push({
      path, depth: info.depth, via, repo: repo ?? "",
      score: options?.pageRankScores?.get(path),
    });
  }

  // Sort by depth, then path
  affectedFiles.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  // Cross-repo expansion (when correlation graph is provided)
  let crossRepoAffected: Map<string, AffectedFile[]> | undefined;
  if (options?.crossRepoGraph) {
    crossRepoAffected = new Map();
    const crGraph = options.crossRepoGraph;

    // Build index of cross-repo edges by "sourceRepo\0sourceFile"
    const crossEdgeIndex = new Map<string, typeof crGraph.edges[number][]>();
    for (const edge of crGraph.edges) {
      const key = `${edge.sourceRepo}\0${edge.edge.source}`;
      const arr = crossEdgeIndex.get(key);
      if (arr) arr.push(edge);
      else crossEdgeIndex.set(key, [edge]);
    }

    // For each affected file (including changed files), check for cross-repo edges
    const sourceRepo = repo ?? "";
    for (const [path] of visited) {
      const crossEdges = crossEdgeIndex.get(`${sourceRepo}\0${path}`) ?? [];
      for (const crossEdge of crossEdges) {
        const targetRepo = crossEdge.targetRepo;
        if (!crossRepoAffected.has(targetRepo)) {
          crossRepoAffected.set(targetRepo, []);
        }

        // Reverse BFS in target repo from the cross-repo edge target
        const targetVisited = new Set<string>();
        const targetQueue: Array<{ node: string; depth: number }> = [];
        const seedFile = crossEdge.edge.target;
        const seedDepth = (visited.get(path)?.depth ?? 0) + 1;

        targetVisited.add(seedFile);
        targetQueue.push({ node: seedFile, depth: seedDepth });

        let crossBfsIter = 0;
        let targetQueueHead = 0;
        while (targetQueueHead < targetQueue.length) {
          if (++crossBfsIter % 1000 === 0) await yieldToEventLoop();
          const current = targetQueue[targetQueueHead++]!;
          if (current.depth >= maxDepth) continue;

          const edges = await graphStore.getEdgesTo(current.node, targetRepo);
          for (const e of edges) {
            if (!targetVisited.has(e.source)) {
              targetVisited.add(e.source);
              targetQueue.push({ node: e.source, depth: current.depth + 1 });
            }
          }
        }

        // Add discovered files to crossRepoAffected
        const existing = crossRepoAffected.get(targetRepo)!;
        const existingSeen = new Set(existing.map(f => f.path));
        for (const file of targetVisited) {
          if (!existingSeen.has(file)) {
            existingSeen.add(file);
            const depthInTarget = seedDepth; // approximate
            existing.push({
              path: file,
              depth: depthInTarget,
              via: "imports",
              repo: targetRepo,
            });
          }
        }
      }
    }

    // Remove empty entries
    for (const [r, files] of crossRepoAffected) {
      if (files.length === 0) crossRepoAffected.delete(r);
    }
    if (crossRepoAffected.size === 0) crossRepoAffected = undefined;
  }

  return {
    changedFiles: [...resolvedFiles],
    affectedFiles,
    totalAffected: affectedFiles.length,
    maxDepth,
    description: `${affectedFiles.length} files affected by changes to ${resolvedFiles.size} file(s), max depth ${maxDepth}`,
    crossRepoAffected,
  };
}

/** Popcount for a 32-bit integer (Knuth SWAR / Hamming weight). */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** Count total set bits across a Uint32Array bitset. */
function bitsetPopcount(bs: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < bs.length; i++) count += popcount32(bs[i]!);
  return count;
}

/** OR src into dst in-place. */
function bitsetOr(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i]! |= src[i]!;
}

/**
 * Iterative Tarjan's SCC on integer-indexed graph.
 * Returns SCCs in reverse topological order (sinks first).
 */
function tarjanSCC(V: number, adj: number[][]): number[][] {
  const index = new Int32Array(V).fill(-1);
  const lowlink = new Int32Array(V);
  const onStack = new Uint8Array(V);
  const sccOf = new Int32Array(V).fill(-1);
  const sccs: number[][] = [];
  const stack: number[] = [];
  let nextIndex = 0;

  // Iterative DFS frames: [node, neighborIndex]
  const dfsStack: Array<[number, number]> = [];

  for (let start = 0; start < V; start++) {
    if (index[start] !== -1) continue;

    dfsStack.push([start, 0]);
    index[start] = lowlink[start] = nextIndex++;
    stack.push(start);
    onStack[start] = 1;

    while (dfsStack.length > 0) {
      const frame = dfsStack[dfsStack.length - 1]!;
      const v = frame[0];
      const neighbors = adj[v]!;

      if (frame[1] < neighbors.length) {
        const w = neighbors[frame[1]++]!;
        if (index[w] === -1) {
          // Tree edge: push new frame
          index[w] = lowlink[w] = nextIndex++;
          stack.push(w);
          onStack[w] = 1;
          dfsStack.push([w, 0]);
        } else if (onStack[w]) {
          lowlink[v] = Math.min(lowlink[v]!, index[w]!);
        }
      } else {
        // All neighbors processed — pop and update parent
        if (lowlink[v] === index[v]) {
          const scc: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            sccOf[w] = sccs.length;
            scc.push(w);
          } while (w !== v);
          sccs.push(scc);
        }
        dfsStack.pop();
        if (dfsStack.length > 0) {
          const parent = dfsStack[dfsStack.length - 1]![0];
          lowlink[parent] = Math.min(lowlink[parent]!, lowlink[v]!);
        }
      }
    }
  }

  return sccs; // reverse topo order (sinks first)
}

/** Worker timeout for computeReachCounts offloading (milliseconds). */
const WORKER_TIMEOUT_MS = 30_000;

/**
 * Resolve the path to the compiled reach-worker.js file.
 * In production the file lives alongside this module in dist/.
 * In test runs (ts-node / vitest with source maps) it lives in dist/ after build.
 */
function resolveWorkerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "reach-worker.js");
}

/**
 * Run the SCC + bitset computation in a worker thread.
 * Returns null if the worker fails or times out.
 */
function runInWorker(
  importEdges: ReadonlyArray<{ source: string; target: string }>,
): Promise<Map<string, number> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;

    const done = (result: Map<string, number> | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      worker = new Worker(resolveWorkerPath(), {
        workerData: { edges: importEdges },
      });
    } catch {
      done(null);
      return;
    }

    const timer = setTimeout(() => {
      void worker.terminate();
      done(null);
    }, WORKER_TIMEOUT_MS);

    worker.on("message", (msg: { ok: boolean; result?: [string, number][]; error?: string }) => {
      clearTimeout(timer);
      if (msg.ok && msg.result) {
        done(new Map(msg.result));
      } else {
        done(null);
      }
    });

    worker.on("error", () => {
      clearTimeout(timer);
      done(null);
    });

    worker.on("exit", () => {
      clearTimeout(timer);
      done(null); // settled guard prevents double resolution
    });
  });
}

/**
 * Compute transitive fan-in (reach count) for each file in the dependency graph.
 *
 * For graphs up to 20,000 nodes: offloads SCC condensation + bitset propagation
 * to a worker thread (with 30s timeout and in-process fallback).
 * For graphs over 20,000 nodes: falls back to the yielding BFS implementation.
 */
export async function computeReachCounts(
  edges: readonly GraphEdge[],
): Promise<Map<string, number>> {
  // Pre-filter to import edges only; collect node count to decide strategy
  const importEdges: Array<{ source: string; target: string }> = [];
  const allNodes = new Set<string>();

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    allNodes.add(edge.source);
    allNodes.add(edge.target);
    importEdges.push({ source: edge.source, target: edge.target });
  }

  const V = allNodes.size;
  if (V === 0) return new Map();

  // Fallback to BFS for very large graphs (until HyperLogLog is added)
  if (V > 20_000) {
    return computeReachCountsBFS(edges);
  }

  // Try worker thread first; fall back to in-process on failure
  const workerResult = await runInWorker(importEdges);
  if (workerResult !== null) return workerResult;

  return computeReachCountsInProcess(edges);
}

/**
 * In-process SCC + bitset reach-count computation (used as worker fallback).
 * Uses setImmediate yields to avoid blocking the event loop on large graphs.
 */
async function computeReachCountsInProcess(
  edges: readonly GraphEdge[],
): Promise<Map<string, number>> {
  // Build reverse adjacency: for each target, who imports it?
  // "A imports B" means B is depended upon by A → reverse: B -> [A]
  const reverseAdj = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    allNodes.add(edge.source);
    allNodes.add(edge.target);
    let deps = reverseAdj.get(edge.target);
    if (!deps) {
      deps = [];
      reverseAdj.set(edge.target, deps);
    }
    deps.push(edge.source);
  }

  const V = allNodes.size;
  if (V === 0) return new Map();

  // Map node names to integer IDs
  const nodeToId = new Map<string, number>();
  const idToNode: string[] = [];
  for (const node of allNodes) {
    nodeToId.set(node, idToNode.length);
    idToNode.push(node);
  }

  // Build integer-indexed reverse adjacency
  const intAdj: number[][] = new Array(V);
  for (let i = 0; i < V; i++) intAdj[i] = [];
  for (const [target, sources] of reverseAdj) {
    const tId = nodeToId.get(target)!;
    for (const src of sources) {
      intAdj[tId]!.push(nodeToId.get(src)!);
    }
  }

  // Tarjan's SCC on reverse graph — returns SCCs in reverse topo order (sinks first)
  const sccs = tarjanSCC(V, intAdj);
  const numSCCs = sccs.length;

  // Map each node to its SCC index
  const sccOf = new Int32Array(V);
  for (let s = 0; s < numSCCs; s++) {
    for (const v of sccs[s]!) sccOf[v] = s;
  }

  // Build condensed DAG edges (SCC → SCC, deduplicated)
  const condensedAdj: Set<number>[] = new Array(numSCCs);
  for (let s = 0; s < numSCCs; s++) condensedAdj[s] = new Set();
  for (let v = 0; v < V; v++) {
    const sv = sccOf[v]!;
    for (const w of intAdj[v]!) {
      const sw = sccOf[w]!;
      if (sv !== sw) condensedAdj[sv]!.add(sw);
    }
  }

  // Bitset propagation: each SCC gets a bitset of size ceil(V/32)
  const words = (V + 31) >>> 5;
  const bitsets: Uint32Array[] = new Array(numSCCs);
  for (let s = 0; s < numSCCs; s++) {
    const bs = new Uint32Array(words);
    for (const v of sccs[s]!) {
      const word = v >>> 5;
      bs[word] = (bs[word] ?? 0) | (1 << (v & 31));
    }
    bitsets[s] = bs;
  }

  // Propagate in Tarjan output order (sinks first = already correct order)
  let propOps = 0;
  for (let s = 0; s < numSCCs; s++) {
    for (const succ of condensedAdj[s]!) {
      bitsetOr(bitsets[s]!, bitsets[succ]!);
      if (++propOps % 500 === 0) await yieldToEventLoop();
    }
  }

  // Extract results
  const result = new Map<string, number>();
  let nodeIter = 0;
  for (let v = 0; v < V; v++) {
    if (++nodeIter % 200 === 0) await yieldToEventLoop();
    const count = bitsetPopcount(bitsets[sccOf[v]!]!) - 1; // exclude self
    result.set(idToNode[v]!, count);
  }

  return result;
}

/**
 * Compute transitive fan-in via per-node BFS (original O(V*(V+E)) algorithm).
 * Used as fallback for V > 20,000 and for parity testing.
 */
export async function computeReachCountsBFS(
  edges: readonly GraphEdge[],
): Promise<Map<string, number>> {
  const reverseAdj = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    allNodes.add(edge.source);
    allNodes.add(edge.target);
    let deps = reverseAdj.get(edge.target);
    if (!deps) {
      deps = [];
      reverseAdj.set(edge.target, deps);
    }
    deps.push(edge.source);
  }

  const result = new Map<string, number>();
  let nodeIter = 0;
  for (const node of allNodes) {
    if (++nodeIter % 100 === 0) await yieldToEventLoop();
    const visited = new Set<string>();
    const queue = [node];
    visited.add(node);

    let innerIter = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (++innerIter % 200 === 0) await yieldToEventLoop();
      const dependents = reverseAdj.get(current);
      if (dependents) {
        for (const dep of dependents) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    result.set(node, visited.size - 1);
  }

  return result;
}
