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

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Normalize executeSync's union return to a single QueryResult. */
export function single(
  result: kuzu.QueryResult | kuzu.QueryResult[],
): kuzu.QueryResult {
  return Array.isArray(result) ? (result[0] as kuzu.QueryResult) : result;
}
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

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

/**
 * Detect the current schema version of the Kuzu database by probing tables.
 * Returns 2 for v2 (Symbol node + Edge rel), 1 for v1 (flat Edge node), 0 for fresh.
 *
 * Detection is based on table existence:
 * - Symbol node table exists → v2
 * - Edge node table with `source` column exists → v1
 * - Neither → fresh (v0)
 */
export function detectSchemaVersion(
  conn: InstanceType<typeof kuzu.Connection>,
): number {
  // Check for v2: Symbol node table exists
  try {
    single(
      conn.querySync("MATCH (s:Symbol) RETURN s.id LIMIT 0"),
    ).getAllSync();
    return 2;
  } catch {
    // Symbol table doesn't exist
  }

  // Probe for v1 flat Edge node table (has a 'source' column on node rows)
  try {
    single(
      conn.querySync("MATCH (e:Edge) RETURN e.source LIMIT 0"),
    ).getAllSync();
    return 1;
  } catch {
    // No Edge node table
  }

  return 0;
}

/**
 * Migrate from v1 (flat Edge node table) to v2 (Symbol nodes + Edge rels).
 * Reads all flat edges, drops old table, creates new schema, re-inserts data.
 */
export function migrateV1ToV2(
  conn: InstanceType<typeof kuzu.Connection>,
): void {
  // 1. Read all v1 edges
  const result = single(
    conn.querySync(
      "MATCH (e:Edge) RETURN e.source AS source, e.target AS target, " +
        "e.kind AS kind, e.metadata AS metadata, e.repo AS repo",
    ),
  );
  const rows = result.getAllSync() as Array<Record<string, unknown>>;

  // 2. Drop old flat Edge node table
  conn.querySync("DROP TABLE Edge");

  // 3. Create v2 schema
  conn.querySync(
    "CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING PRIMARY KEY)",
  );
  conn.querySync(
    "CREATE REL TABLE IF NOT EXISTS Edge(FROM Symbol TO Symbol, " +
      "kind STRING, metadata STRING, repo STRING)",
  );

  if (rows.length > 0) {
    // 4. MERGE unique symbols + CREATE relationships
    const symbolIds = new Set<string>();
    for (const row of rows) {
      symbolIds.add(row["source"] as string);
      symbolIds.add(row["target"] as string);
    }

    conn.querySync("BEGIN TRANSACTION");
    try {
      const stmtMerge = conn.prepareSync("MERGE (s:Symbol {id: $id})");
      for (const id of symbolIds) {
        conn.executeSync(stmtMerge, { id });
      }

      const stmtInsert = conn.prepareSync(
        "MATCH (s:Symbol {id: $s}), (t:Symbol {id: $t}) " +
          "CREATE (s)-[:Edge {kind: $k, metadata: $m, repo: $r}]->(t)",
      );
      for (const row of rows) {
        conn.executeSync(stmtInsert, {
          s: row["source"] as string,
          t: row["target"] as string,
          k: row["kind"] as string,
          m: (row["metadata"] as string) ?? "",
          r: (row["repo"] as string) ?? "",
        });
      }

      conn.querySync("COMMIT");
    } catch (e) {
      conn.querySync("ROLLBACK");
      throw e;
    }
  }

}

/**
 * Initialize the Kuzu schema — version-aware.
 * Fresh: creates v2 schema. V1: migrates. V2: no-op.
 */
function initSchema(conn: InstanceType<typeof kuzu.Connection>): void {
  // KV table always needed (used for version tracking + KVStore)
  conn.querySync(
    "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
  );

  const version = detectSchemaVersion(conn);

  if (version === 0) {
    // Fresh database — create v2 schema directly
    conn.querySync(
      "CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING PRIMARY KEY)",
    );
    conn.querySync(
      "CREATE REL TABLE IF NOT EXISTS Edge(FROM Symbol TO Symbol, " +
        "kind STRING, metadata STRING, repo STRING)",
    );
  } else if (version === 1) {
    migrateV1ToV2(conn);
  }
  // version >= 2: schema is current

  // SearchStore table + FTS extension
  conn.querySync(
    "CREATE NODE TABLE IF NOT EXISTS SearchDoc(id STRING PRIMARY KEY, " +
      "content STRING, metadata STRING, repo STRING)",
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
