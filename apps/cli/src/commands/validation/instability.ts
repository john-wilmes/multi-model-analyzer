import type { GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";

// ─── Independent instability computation ───────────────────

export interface ModuleInstability {
  ca: number;
  ce: number;
  instability: number;
}

export function computeInstabilityFromEdges(
  edges: readonly GraphEdge[],
): Map<string, ModuleInstability> {
  const caCount = new Map<string, Set<string>>();
  const ceCount = new Map<string, Set<string>>();
  const modules = new Set<string>();

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;

    let ce = ceCount.get(edge.source);
    if (!ce) { ce = new Set(); ceCount.set(edge.source, ce); }
    ce.add(edge.target);

    let ca = caCount.get(edge.target);
    if (!ca) { ca = new Set(); caCount.set(edge.target, ca); }
    ca.add(edge.source);

    modules.add(edge.source);
    modules.add(edge.target);
  }

  const result = new Map<string, ModuleInstability>();
  for (const mod of modules) {
    const ca = caCount.get(mod)?.size ?? 0;
    const ce = ceCount.get(mod)?.size ?? 0;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    result.set(mod, { ca, ce, instability });
  }
  return result;
}

// ─── Per-run caches (cleared each validateCommand call) ────

let edgesCache: Map<string, GraphEdge[]> = new Map();
let instabilityCache: Map<string, Map<string, ModuleInstability>> = new Map();

/** Reset per-run caches. Called automatically by validateCommand; exported for testing. */
export function resetCaches(): void {
  edgesCache = new Map();
  instabilityCache = new Map();
}

export async function getImportEdges(graphStore: GraphStore, repo: string): Promise<GraphEdge[]> {
  let cached = edgesCache.get(repo);
  if (!cached) {
    cached = await graphStore.getEdgesByKind("imports", repo);
    edgesCache.set(repo, cached);
  }
  return cached;
}

export function getInstability(edges: readonly GraphEdge[], repo: string): Map<string, ModuleInstability> {
  let cached = instabilityCache.get(repo);
  if (!cached) {
    cached = computeInstabilityFromEdges(edges);
    instabilityCache.set(repo, cached);
  }
  return cached;
}
