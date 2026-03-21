/**
 * Blast radius analysis: reverse BFS to find all files affected by changes.
 *
 * Given a set of changed files, traverses the dependency graph in reverse
 * (following who-imports-me edges) to identify all transitively affected files.
 */

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
  while (queue.length > 0) {
    if (++bfsIter % 1000 === 0) await yieldToEventLoop();
    const current = queue.shift()!;
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
        while (targetQueue.length > 0) {
          if (++crossBfsIter % 1000 === 0) await yieldToEventLoop();
          const current = targetQueue.shift()!;
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

/**
 * Compute transitive fan-in (reach count) for each file in the dependency graph.
 *
 * For each file, counts how many other files transitively depend on it
 * (i.e., how many files would be affected if this file changed).
 * O(V+E), pure, synchronous.
 */
export async function computeReachCounts(
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

  // For each node, BFS through reverse adjacency to count transitive dependents
  const result = new Map<string, number>();
  let nodeIter = 0;
  for (const node of allNodes) {
    if (++nodeIter % 100 === 0) await yieldToEventLoop();
    const visited = new Set<string>();
    const queue = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
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

    // Exclude the node itself from its reach count
    result.set(node, visited.size - 1);
  }

  return result;
}
