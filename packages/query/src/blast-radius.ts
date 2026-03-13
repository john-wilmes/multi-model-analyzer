/**
 * Blast radius analysis: reverse BFS to find all files affected by changes.
 *
 * Given a set of changed files, traverses the dependency graph in reverse
 * (following who-imports-me edges) to identify all transitively affected files.
 */

import type { GraphStore, SearchStore } from "@mma/storage";

export interface AffectedFile {
  readonly path: string;
  readonly depth: number;
  readonly via: "imports" | "calls" | "both";
  readonly repo: string;
}

export interface BlastRadiusResult {
  readonly changedFiles: string[];
  readonly affectedFiles: AffectedFile[];
  readonly totalAffected: number;
  readonly maxDepth: number;
  readonly description: string;
}

export async function computeBlastRadius(
  changedFiles: string[],
  graphStore: GraphStore,
  options?: { maxDepth?: number; includeCallGraph?: boolean; repo?: string },
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
        const hashIdx = match.id.indexOf("#");
        resolvedFiles.add(hashIdx > 0 ? match.id.slice(0, hashIdx) : match.id);
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

  while (queue.length > 0) {
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
    affectedFiles.push({ path, depth: info.depth, via, repo: repo ?? "" });
  }

  // Sort by depth, then path
  affectedFiles.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  return {
    changedFiles: [...resolvedFiles],
    affectedFiles,
    totalAffected: affectedFiles.length,
    maxDepth,
    description: `${affectedFiles.length} files affected by changes to ${resolvedFiles.size} file(s), max depth ${maxDepth}`,
  };
}
