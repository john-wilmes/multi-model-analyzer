/**
 * Flag impact analysis: traces feature flag usage through the dependency graph.
 *
 * Given a feature flag, performs reverse BFS from its source locations to find
 * all transitively affected files and services.
 */

import type { GraphStore, KVStore } from "@mma/storage";
import type { FlagInventory, FeatureFlag, ConfigInventory, FeatureModel } from "@mma/core";

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
  readonly isRegistry?: boolean;
  readonly description?: string;
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
  options?: { repo?: string; search?: string; limit?: number; offset?: number; registryOnly?: boolean; unregistered?: boolean },
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
        isRegistry: flag.isRegistry,
        description: flag.description,
      });
    }
  }

  const filtered = allEntries.filter((entry) => {
    if (options?.registryOnly && !entry.isRegistry) return false;
    if (options?.unregistered && entry.isRegistry) return false;
    return true;
  });

  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    returned: page.length,
    offset,
    hasMore: offset + limit < filtered.length,
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

// ---------------------------------------------------------------------------
// Config inventory and model queries
// ---------------------------------------------------------------------------

export interface ConfigInventoryResult {
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly parameters: ConfigInventoryEntry[];
}

export interface ConfigInventoryEntry {
  readonly repo: string;
  readonly name: string;
  readonly kind: "setting" | "credential" | "flag";
  readonly locationCount: number;
  readonly modules: string[];
  readonly valueType?: string;
  readonly defaultValue?: unknown;
  readonly source?: string;
  readonly scope?: string;
}

/**
 * Retrieve the persisted config inventory across repos.
 */
export async function getConfigInventory(
  kvStore: KVStore,
  options?: {
    repo?: string;
    search?: string;
    kind?: "setting" | "credential" | "flag";
    scope?: string;
    limit?: number;
    offset?: number;
  },
): Promise<ConfigInventoryResult> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const search = options?.search?.toLowerCase();

  const keys = await kvStore.keys("config-inventory:");
  const allEntries: ConfigInventoryEntry[] = [];

  for (const key of keys) {
    const repoName = key.slice("config-inventory:".length);
    if (options?.repo && repoName !== options.repo) continue;

    const raw = await kvStore.get(key);
    if (!raw) continue;

    let inventory: ConfigInventory;
    try {
      inventory = JSON.parse(raw) as ConfigInventory;
    } catch {
      continue;
    }

    for (const param of inventory.parameters) {
      if (search && !param.name.toLowerCase().includes(search)) continue;
      if (options?.kind && param.kind !== options.kind) continue;
      if (options?.scope && param.scope !== options.scope) continue;

      allEntries.push({
        repo: repoName,
        name: param.name,
        kind: param.kind,
        locationCount: param.locations.length,
        modules: [...new Set(param.locations.map((l) => l.module))],
        valueType: param.valueType,
        defaultValue: param.defaultValue,
        source: param.source,
        scope: param.scope,
      });
    }
  }

  const page = allEntries.slice(offset, offset + limit);
  return {
    total: allEntries.length,
    returned: page.length,
    offset,
    hasMore: offset + limit < allEntries.length,
    parameters: page,
  };
}

/**
 * Retrieve the persisted feature/config model for a repository.
 * The model includes constraints inferred from both flags and settings.
 */
export async function getConfigModel(
  kvStore: KVStore,
  repo: string,
): Promise<FeatureModel | null> {
  const raw = await kvStore.get(`config-model:${repo}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FeatureModel;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Integrator config map
// ---------------------------------------------------------------------------

const UTILITY_SEGMENTS = new Set([
  "shared", "utils", "__tests__", "test", "tests",
  "index", "base", "types", "mock", "mocks", "fixtures",
]);

function extractIntegratorType(modulePath: string): string | null {
  const parts = modulePath.split("/");
  const idx = parts.indexOf("clients");
  if (idx === -1 || idx + 1 >= parts.length) return null;
  const segment = parts[idx + 1] ?? "";
  const type = segment.replace(/\.[jt]sx?$/, "");
  if (!type || UTILITY_SEGMENTS.has(type)) return null;
  return type;
}

export interface IntegratorConfigEntry {
  readonly type: string;
  readonly credentials: ConfigInventoryEntry[];
  readonly settings: ConfigInventoryEntry[];
  readonly modules: string[];
}

export interface IntegratorConfigMapResult {
  readonly repo: string;
  readonly total: number;
  readonly returned: number;
  readonly types: IntegratorConfigEntry[];
}

export async function getIntegratorConfigMap(
  kvStore: KVStore,
  options?: {
    repo?: string;
    type?: string;
    search?: string;
  },
): Promise<IntegratorConfigMapResult> {
  const repo = options?.repo ?? "integrator-service-clients";
  const raw = await kvStore.get(`config-inventory:${repo}`);
  if (!raw) {
    return { repo, total: 0, returned: 0, types: [] };
  }
  let inventory: ConfigInventory;
  try {
    inventory = JSON.parse(raw) as ConfigInventory;
  } catch {
    return { repo, total: 0, returned: 0, types: [] };
  }

  // Build per-type grouping
  const typeMap = new Map<string, { credentials: ConfigInventoryEntry[]; settings: ConfigInventoryEntry[]; modules: Set<string> }>();

  for (const param of inventory.parameters) {
    const modules = param.locations.map(l => l.module);
    const types = new Set<string>();
    for (const mod of modules) {
      const t = extractIntegratorType(mod);
      if (t) types.add(t);
    }

    if (types.size === 0) continue;

    for (const t of types) {
      const typeModules = modules.filter(m => extractIntegratorType(m) === t);
      const entry: ConfigInventoryEntry = {
        repo,
        name: param.name,
        kind: param.kind ?? "setting",
        locationCount: typeModules.length,
        modules: typeModules,
        ...(param.valueType ? { valueType: param.valueType } : {}),
        ...(param.defaultValue !== undefined ? { defaultValue: param.defaultValue } : {}),
        ...(param.scope ? { scope: param.scope } : {}),
      };

      let group = typeMap.get(t);
      if (!group) {
        group = { credentials: [], settings: [], modules: new Set() };
        typeMap.set(t, group);
      }
      if (param.kind === "credential") {
        group.credentials.push(entry);
      } else {
        group.settings.push(entry);
      }
      for (const mod of typeModules) group.modules.add(mod);
    }
  }

  const total = typeMap.size;

  // Apply type filter
  const entries: IntegratorConfigEntry[] = [];
  const sortedTypes = [...typeMap.keys()].sort();
  const typeFilter = options?.type?.toLowerCase();
  const searchFilter = options?.search?.toLowerCase();

  for (const t of sortedTypes) {
    if (typeFilter && !t.toLowerCase().includes(typeFilter)) continue;
    const group = typeMap.get(t)!;

    let creds = group.credentials;
    let settings = group.settings;

    if (searchFilter) {
      // If the type name matches, include all its params; otherwise filter params by name
      if (!t.toLowerCase().includes(searchFilter)) {
        creds = creds.filter(c => c.name.toLowerCase().includes(searchFilter));
        settings = settings.filter(s => s.name.toLowerCase().includes(searchFilter));
        if (creds.length === 0 && settings.length === 0) continue;
      }
    }

    creds.sort((a, b) => a.name.localeCompare(b.name));
    settings.sort((a, b) => a.name.localeCompare(b.name));

    entries.push({
      type: t,
      credentials: creds,
      settings: settings,
      modules: [...group.modules].sort(),
    });
  }

  return { repo, total, returned: entries.length, types: entries };
}
