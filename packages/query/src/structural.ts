/**
 * Structural query execution via graph traversal.
 */

import type { GraphEdge } from "@mma/core";
import type { GraphStore } from "@mma/storage";

export interface StructuralQueryResult {
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly string[];
  readonly description: string;
}

export async function executeCallersQuery(
  target: string,
  graphStore: GraphStore,
): Promise<StructuralQueryResult> {
  const edges = await graphStore.getEdgesTo(target);
  const callers = edges.map((e) => e.source);

  return {
    edges,
    nodes: callers,
    description: `${callers.length} callers of ${target}`,
  };
}

export async function executeCalleesQuery(
  source: string,
  graphStore: GraphStore,
): Promise<StructuralQueryResult> {
  const edges = await graphStore.getEdgesFrom(source);
  const callees = edges.map((e) => e.target);

  return {
    edges,
    nodes: callees,
    description: `${callees.length} callees from ${source}`,
  };
}

export async function executeDependencyQuery(
  module: string,
  graphStore: GraphStore,
  depth: number = 3,
): Promise<StructuralQueryResult> {
  const edges = await graphStore.traverseBFS(module, depth);
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.source);
    nodes.add(edge.target);
  }

  return {
    edges,
    nodes: [...nodes],
    description: `Dependency tree for ${module} (depth ${depth}): ${nodes.size} nodes`,
  };
}
