import type { GraphStore } from "./graph.js";
import type { SearchStore } from "./search.js";
import type { KVStore } from "./kv.js";
import { createSqliteStores as _createSqliteStores } from "./sqlite-common.js";

export type { GraphStore, GraphStoreOptions, TraversalOptions, EdgeQueryOptions } from "./graph.js";
export { InMemoryGraphStore } from "./graph.js";

export type { SearchDocument, SearchResult, SearchStore } from "./search.js";
export { InMemorySearchStore } from "./search.js";

export type { KVStore, TypedKVStore } from "./kv.js";
export { InMemoryKVStore, createTypedKVStore, discoverRepos } from "./kv.js";

export { SqliteGraphStore } from "./sqlite-graph.js";
export { SqliteSearchStore } from "./sqlite-search.js";
export { SqliteKVStore } from "./sqlite-kv.js";
export type { SqliteStores, SqliteStoreOptions } from "./sqlite-common.js";
export { createSqliteStores } from "./sqlite-common.js";

export { getSarifResultsForRepo, getSarifResultsPaginated } from "./sarif-helpers.js";
export type { SarifLatestIndex, PaginatedSarifResults } from "./sarif-helpers.js";

export type StorageBackend = "sqlite" | "kuzu";

export interface StoreOptions {
  readonly backend: StorageBackend;
  readonly dbPath: string;
  readonly readonly?: boolean;
}

export interface Stores {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  close(): void;
}

/**
 * Create stores for the given backend. Uses dynamic import for kuzu
 * to avoid requiring the kuzu native binary when using sqlite.
 */
export async function createStores(options: StoreOptions): Promise<Stores> {
  if (options.backend === "kuzu") {
    // Dynamic import avoids circular tsconfig reference (storage-kuzu depends on storage).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = await import("@mma/storage-kuzu" as string);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return mod.createKuzuStores({ dbPath: options.dbPath, readonly: options.readonly }) as Stores;
  }
  // Default: sqlite
  return _createSqliteStores({
    dbPath: options.dbPath,
    readonly: options.readonly,
  });
}
