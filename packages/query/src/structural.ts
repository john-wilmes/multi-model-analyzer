/**
 * Structural query execution via graph traversal.
 */

import type { GraphEdge } from "@mma/core";
import type { GraphStore, TraversalOptions } from "@mma/storage";

export interface StructuralQueryResult {
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly string[];
  readonly description: string;
}

export async function executeCallersQuery(
  target: string,
  graphStore: GraphStore,
  repo?: string,
): Promise<StructuralQueryResult> {
  const edges = await graphStore.getEdgesTo(target, repo);
  const callers = edges.map((e) => e.source);

  return {
    edges,
    nodes: callers,
    description: `${callers.length} callers of ${target}${repo ? ` (repo: ${repo})` : ""}`,
  };
}

export async function executeCalleesQuery(
  source: string,
  graphStore: GraphStore,
  repo?: string,
): Promise<StructuralQueryResult> {
  const edges = await graphStore.getEdgesFrom(source, repo);
  const callees = edges.map((e) => e.target);

  return {
    edges,
    nodes: callees,
    description: `${callees.length} callees from ${source}${repo ? ` (repo: ${repo})` : ""}`,
  };
}

export async function executeDependencyQuery(
  module: string,
  graphStore: GraphStore,
  options: number | TraversalOptions = 3,
): Promise<StructuralQueryResult> {
  const opts: TraversalOptions = typeof options === "number"
    ? { maxDepth: options }
    : options;
  const edges = await graphStore.traverseBFS(module, opts);
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.source);
    nodes.add(edge.target);
  }

  return {
    edges,
    nodes: [...nodes],
    description: `Dependency tree for ${module} (depth ${opts.maxDepth}): ${nodes.size} nodes${opts.repo ? ` (repo: ${opts.repo})` : ""}`,
  };
}
