/**
 * Shared Kuzu database setup for all store implementations.
 *
 * Opens a single database + connection and returns a factory that creates
 * all three stores sharing that connection. Mirrors the createSqliteStores()
 * pattern from @mma/storage.
 */

import type { GraphStore } from "@mma/storage";
import type { SearchStore } from "@mma/storage";
import type { KVStore } from "@mma/storage";
import kuzu from "kuzu";
import { KuzuKVStore } from "./kuzu-kv.js";
import { KuzuGraphStore } from "./kuzu-graph.js";
import { KuzuSearchStore } from "./kuzu-search.js";

export interface KuzuStores {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  close(): void;
}

export interface KuzuStoreOptions {
  /** Path to database directory, or ":memory:" for in-memory Kuzu */
  readonly dbPath: string;
  /** Open database in read-only mode (default: false) */
  readonly readonly?: boolean;
}

/**
 * Initialize the Kuzu schema — creates the node tables required by all stores.
 * Must be called before constructing any store instances.
 */
function initSchema(conn: InstanceType<typeof kuzu.Connection>): void {
  // KVStore table
  conn.querySync(
    "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
  );

  // GraphStore table (Phase 1: flat-edge emulation)
  conn.querySync(`
    CREATE NODE TABLE IF NOT EXISTS Edge(
      id       SERIAL PRIMARY KEY,
      source   STRING,
      target   STRING,
      kind     STRING,
      metadata STRING,
      repo     STRING
    )
  `);

  // SearchStore table + FTS extension
  conn.querySync(
    "CREATE NODE TABLE IF NOT EXISTS SearchDoc(id STRING PRIMARY KEY, content STRING, metadata STRING, repo STRING)",
  );
  conn.querySync("LOAD EXTENSION fts");
}

export function createKuzuStores(options: KuzuStoreOptions): KuzuStores {
  const isReadonly = options.readonly ?? false;
  const db = new kuzu.Database(
    options.dbPath,
    /* bufferManagerSize */ 0, // default
    /* enableCompression */ true,
    /* readOnly */ isReadonly,
  );
  db.initSync();
  const conn = new kuzu.Connection(db);
  conn.initSync();

  if (!isReadonly) {
    initSchema(conn);
  }

  const kvStore = new KuzuKVStore(conn);
  const graphStore = new KuzuGraphStore(conn);
  const searchStore = new KuzuSearchStore(conn);

  return {
    graphStore,
    searchStore,
    kvStore,
    close() {
      // Use process.exit-safe approach: avoid closeSync which segfaults.
      // The database will be cleaned up when the process exits.
      try {
        conn.closeSync();
      } catch {
        // Ignore errors during close
      }
      try {
        db.closeSync();
      } catch {
        // Ignore errors during close
      }
    },
  };
}
