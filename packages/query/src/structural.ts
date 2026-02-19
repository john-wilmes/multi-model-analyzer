/**
 * Structural query execution via graph traversal.
 *
 * When an entity name doesn't match any graph node exactly, falls back
 * to BM25 search to resolve the fully qualified name before retrying.
 */

import type { GraphEdge } from "@mma/core";
import type { GraphStore, SearchStore, TraversalOptions } from "@mma/storage";

export interface StructuralQueryResult {
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly string[];
  readonly description: string;
}

export async function executeCallersQuery(
  target: string,
  graphStore: GraphStore,
  repo?: string,
  searchStore?: SearchStore,
): Promise<StructuralQueryResult> {
  let edges = await graphStore.getEdgesTo(target, repo);

  // BM25 fallback: resolve short name to FQN
  if (edges.length === 0 && searchStore) {
    const resolved = await resolveEntityViaBM25(target, searchStore);
    if (resolved) {
      edges = await graphStore.getEdgesTo(resolved, repo);
      if (edges.length > 0) {
        const callers = edges.map((e) => e.source);
        return {
          edges,
          nodes: callers,
          description: `${callers.length} callers of ${resolved} (resolved from "${target}")${repo ? ` (repo: ${repo})` : ""}`,
        };
      }
    }
  }

  if (edges.length === 0) {
    return {
      edges: [],
      nodes: [],
      description: `No matches found for "${target}". Try a fully qualified name like file.ts#ClassName.${repo ? ` (repo: ${repo})` : ""}`,
    };
  }

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
  searchStore?: SearchStore,
): Promise<StructuralQueryResult> {
  let edges = await graphStore.getEdgesFrom(source, repo);

  // BM25 fallback: resolve short name to FQN
  if (edges.length === 0 && searchStore) {
    const resolved = await resolveEntityViaBM25(source, searchStore);
    if (resolved) {
      edges = await graphStore.getEdgesFrom(resolved, repo);
      if (edges.length > 0) {
        const callees = edges.map((e) => e.target);
        return {
          edges,
          nodes: callees,
          description: `${callees.length} callees from ${resolved} (resolved from "${source}")${repo ? ` (repo: ${repo})` : ""}`,
        };
      }
    }
  }

  if (edges.length === 0) {
    return {
      edges: [],
      nodes: [],
      description: `No matches found for "${source}". Try a fully qualified name like file.ts#ClassName.${repo ? ` (repo: ${repo})` : ""}`,
    };
  }

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
  searchStore?: SearchStore,
): Promise<StructuralQueryResult> {
  const opts: TraversalOptions = typeof options === "number"
    ? { maxDepth: options }
    : options;
  let edges = await graphStore.traverseBFS(module, opts);

  // BM25 fallback: resolve short name to FQN
  if (edges.length === 0 && searchStore) {
    const resolved = await resolveEntityViaBM25(module, searchStore);
    if (resolved) {
      edges = await graphStore.traverseBFS(resolved, opts);
      if (edges.length > 0) {
        const nodes = new Set<string>();
        for (const edge of edges) {
          nodes.add(edge.source);
          nodes.add(edge.target);
        }
        return {
          edges,
          nodes: [...nodes],
          description: `Dependency tree for ${resolved} (resolved from "${module}", depth ${opts.maxDepth}): ${nodes.size} nodes${opts.repo ? ` (repo: ${opts.repo})` : ""}`,
        };
      }
    }
  }

  if (edges.length === 0) {
    return {
      edges: [],
      nodes: [],
      description: `No matches found for "${module}". Try a fully qualified name like file.ts#ClassName.${opts.repo ? ` (repo: ${opts.repo})` : ""}`,
    };
  }

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

async function resolveEntityViaBM25(
  entity: string,
  searchStore: SearchStore,
): Promise<string | null> {
  const results = await searchStore.search(entity, 1);
  if (results.length === 0) return null;
  return results[0]!.id;
}
