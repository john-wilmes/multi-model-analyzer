/**
 * Flag impact analysis: traces feature flag usage through the dependency graph.
 *
 * Given a feature flag, performs reverse BFS from its source locations to find
 * all transitively affected files and services.
 */

import type { GraphStore, KVStore } from "@mma/storage";
import type { FlagInventory, FeatureFlag } from "@mma/core";

/** Yield to the event loop to prevent blocking on large graph traversals. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export interface FlagInventoryResult {
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly flags: FlagInventoryEntry[];
}

export interface FlagInventoryEntry {
  readonly repo: string;
  readonly name: string;
  readonly sdk?: string;
  readonly locationCount: number;
  readonly modules: string[];
}

export interface FlagImpactResult {
  readonly flagName: string;
  readonly repo: string;
  readonly flagLocations: string[];
  readonly affectedFiles: AffectedFile[];
  readonly affectedServices: AffectedService[];
  readonly totalAffected: number;
  readonly maxDepth: number;
}

export interface AffectedFile {
  readonly path: string;
  readonly depth: number;
  readonly via: "imports" | "calls" | "both";
}

export interface AffectedService {
  readonly endpoint: string;
  readonly sourceFile: string;
}

/**
 * Retrieve and search the persisted flag inventory across repos.
 */
export async function getFlagInventory(
  kvStore: KVStore,
  options?: { repo?: string; search?: string; limit?: number; offset?: number },
): Promise<FlagInventoryResult> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const search = options?.search?.toLowerCase();

  const keys = await kvStore.keys("flags:");
  const allEntries: FlagInventoryEntry[] = [];

  for (const key of keys) {
    const repoName = key.slice("flags:".length);
    if (options?.repo && repoName !== options.repo) continue;

    const raw = await kvStore.get(key);
    if (!raw) continue;

    let inventory: FlagInventory;
    try {
      inventory = JSON.parse(raw) as FlagInventory;
    } catch {
      continue;
    }

    for (const flag of inventory.flags) {
      if (search && !flag.name.toLowerCase().includes(search)) continue;
      allEntries.push({
        repo: repoName,
        name: flag.name,
        sdk: flag.sdk,
        locationCount: flag.locations.length,
        modules: [...new Set(flag.locations.map((l) => l.module))],
      });
    }
  }

  const page = allEntries.slice(offset, offset + limit);
  return {
    total: allEntries.length,
    returned: page.length,
    offset,
    hasMore: offset + limit < allEntries.length,
    flags: page,
  };
}

/**
 * Compute the impact of a feature flag by reverse-BFS from its source locations.
 */
export async function computeFlagImpact(
  flagName: string,
  repo: string,
  kvStore: KVStore,
  graphStore: GraphStore,
  options?: { maxDepth?: number; includeCallGraph?: boolean },
): Promise<FlagImpactResult> {
  const maxDepth = options?.maxDepth ?? 5;
  const includeCallGraph = options?.includeCallGraph ?? true;

  // Load flag inventory for this repo
  const raw = await kvStore.get(`flags:${repo}`);
  if (!raw) {
    return emptyResult(flagName, repo, maxDepth);
  }

  let inventory: FlagInventory;
  try {
    inventory = JSON.parse(raw) as FlagInventory;
  } catch {
    return emptyResult(flagName, repo, maxDepth);
  }

  // Find flag: exact match first, then substring
  let flag: FeatureFlag | undefined = inventory.flags.find(
    (f) => f.name === flagName,
  );
  if (!flag) {
    const lower = flagName.toLowerCase();
    flag = inventory.flags.find((f) => f.name.toLowerCase().includes(lower));
  }
  if (!flag) {
    return emptyResult(flagName, repo, maxDepth);
  }

  // Seed: unique file paths from flag locations
  const seedFiles = [...new Set(flag.locations.map((l) => l.module))];

  // Reverse BFS
  const visited = new Map<string, { depth: number; via: Set<string> }>();
  const queue: Array<{ node: string; depth: number }> = [];

  for (const file of seedFiles) {
    visited.set(file, { depth: 0, via: new Set() });
    queue.push({ node: file, depth: 0 });
  }

  let bfsIter = 0;
  while (queue.length > 0) {
    if (++bfsIter % 1000 === 0) await yieldToEventLoop();
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const reverseEdges = await graphStore.getEdgesTo(current.node, repo);
    const importEdges = reverseEdges.filter((e) => e.kind === "imports");
    const callEdges = includeCallGraph
      ? reverseEdges.filter((e) => e.kind === "calls")
      : [];

    for (const edge of importEdges) {
      const nextDepth = current.depth + 1;
      const existing = visited.get(edge.source);
      if (!existing) {
        visited.set(edge.source, { depth: nextDepth, via: new Set(["imports"]) });
        queue.push({ node: edge.source, depth: nextDepth });
      } else {
        existing.via.add("imports");
      }
    }

    for (const edge of callEdges) {
      const nextDepth = current.depth + 1;
      const existing = visited.get(edge.source);
      if (!existing) {
        visited.set(edge.source, { depth: nextDepth, via: new Set(["calls"]) });
        queue.push({ node: edge.source, depth: nextDepth });
      } else {
        existing.via.add("calls");
      }
    }
  }

  // Build affected files (exclude seed files)
  const seedSet = new Set(seedFiles);
  const affectedFiles: AffectedFile[] = [];
  for (const [path, info] of visited) {
    if (seedSet.has(path)) continue;
    const via = info.via.has("imports") && info.via.has("calls")
      ? "both" as const
      : info.via.has("imports") ? "imports" as const : "calls" as const;
    affectedFiles.push({ path, depth: info.depth, via });
  }
  affectedFiles.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  // Find service-call edges from affected or seed files
  const allVisitedFiles = new Set(visited.keys());
  const serviceEdges = await graphStore.getEdgesByKind("service-call", repo);
  const affectedServices: AffectedService[] = [];
  const seenEndpoints = new Set<string>();
  for (const edge of serviceEdges) {
    if (allVisitedFiles.has(edge.source)) {
      const endpoint = edge.target;
      const key = `${endpoint}:${edge.source}`;
      if (!seenEndpoints.has(key)) {
        seenEndpoints.add(key);
        affectedServices.push({ endpoint, sourceFile: edge.source });
      }
    }
  }

  return {
    flagName: flag.name,
    repo,
    flagLocations: seedFiles,
    affectedFiles,
    affectedServices,
    totalAffected: affectedFiles.length,
    maxDepth,
  };
}

function emptyResult(flagName: string, repo: string, maxDepth: number): FlagImpactResult {
  return {
    flagName,
    repo,
    flagLocations: [],
    affectedFiles: [],
    affectedServices: [],
    totalAffected: 0,
    maxDepth,
  };
}
