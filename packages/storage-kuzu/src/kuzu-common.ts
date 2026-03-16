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

/** v3 typed relationship table names (one per EdgeKind). */
export const V3_REL_TABLES = [
  "Calls", "Imports", "Extends", "Implements",
  "DependsOn", "Contains", "ServiceCall",
];

/** DDL for the Symbol node table. */
const DDL_SYMBOL = "CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING PRIMARY KEY)";

/** DDL template for a typed relationship table. */
function ddlRelTable(table: string): string {
  return `CREATE REL TABLE IF NOT EXISTS ${table}(FROM Symbol TO Symbol, metadata STRING, repo STRING)`;
}

/** Maps EdgeKind string values to v3 table names (for migration). */
const KIND_TO_TABLE: Record<string, string> = {
  "calls": "Calls",
  "imports": "Imports",
  "extends": "Extends",
  "implements": "Implements",
  "depends-on": "DependsOn",
  "contains": "Contains",
  "service-call": "ServiceCall",
};

/**
 * Detect the current schema version of the Kuzu database by probing tables.
 * Returns 3 for v3 (typed rel tables), 2 for v2 (Symbol node + generic Edge rel),
 * 1 for v1 (flat Edge node), 0 for fresh.
 *
 * Detection is based on table existence:
 * - Typed Imports rel table exists → v3
 * - Symbol node table exists (but no typed rels) → v2
 * - Edge node table with `source` column exists → v1
 * - Neither → fresh (v0)
 */
export function detectSchemaVersion(
  conn: InstanceType<typeof kuzu.Connection>,
): number {
  // Check for v3: typed rel tables (probe Imports)
  try {
    single(
      conn.querySync("MATCH (s:Symbol)-[:Imports]->(t) RETURN s.id LIMIT 0"),
    ).getAllSync();
    return 3;
  } catch {
    // Imports rel table doesn't exist
  }

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
  conn.querySync(DDL_SYMBOL);
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
      throw new Error("Kuzu migration v1→v2 failed", { cause: e });
    }
  }

}

/**
 * Migrate from v2 (Symbol nodes + generic Edge rel) to v3 (Symbol nodes + 7 typed rels).
 * Reads all edges from the generic Edge rel table, drops it, creates typed tables,
 * re-inserts edges dispatched by kind.
 */
export function migrateV2ToV3(
  conn: InstanceType<typeof kuzu.Connection>,
): void {
  // 1. Read all edges from generic Edge rel table
  const result = single(
    conn.querySync(
      "MATCH (s:Symbol)-[r:Edge]->(t:Symbol) RETURN s.id AS source, t.id AS target, " +
        "r.kind AS kind, r.metadata AS metadata, r.repo AS repo",
    ),
  );
  const rows = result.getAllSync() as Array<Record<string, unknown>>;

  // 2. Drop generic Edge rel table
  conn.querySync("DROP TABLE Edge");

  // 3. Create 7 typed rel tables
  for (const table of V3_REL_TABLES) {
    conn.querySync(ddlRelTable(table));
  }

  // 4. Re-insert edges dispatched by kind
  if (rows.length > 0) {
    conn.querySync("BEGIN TRANSACTION");
    try {
      const stmts = new Map<string, InstanceType<typeof kuzu.PreparedStatement>>();
      for (const table of V3_REL_TABLES) {
        stmts.set(
          table,
          conn.prepareSync(
            `MATCH (s:Symbol {id: $s}), (t:Symbol {id: $t}) CREATE (s)-[:${table} {metadata: $m, repo: $r}]->(t)`,
          ),
        );
      }

      for (const row of rows) {
        const kind = row["kind"] as string;
        const table = KIND_TO_TABLE[kind];
        if (!table) continue;
        conn.executeSync(stmts.get(table)!, {
          s: row["source"] as string,
          t: row["target"] as string,
          m: (row["metadata"] as string) ?? "",
          r: (row["repo"] as string) ?? "",
        });
      }
      conn.querySync("COMMIT");
    } catch (e) {
      conn.querySync("ROLLBACK");
      throw new Error("Kuzu migration v2→v3 failed", { cause: e });
    }
  }
}

/**
 * Initialize the Kuzu schema — version-aware.
 * Fresh: creates v3 schema directly. V1: migrates v1→v2→v3. V2: migrates v2→v3. V3+: no-op.
 */
function initSchema(conn: InstanceType<typeof kuzu.Connection>): void {
  // KV table always needed (used for version tracking + KVStore)
  conn.querySync(
    "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
  );

  const version = detectSchemaVersion(conn);

  if (version === 0) {
    // Fresh database — create v3 schema directly
    conn.querySync(DDL_SYMBOL);
    for (const table of V3_REL_TABLES) {
      conn.querySync(ddlRelTable(table));
    }
  } else if (version === 1) {
    migrateV1ToV2(conn);
    migrateV2ToV3(conn);
  } else if (version === 2) {
    migrateV2ToV3(conn);
  }
  // version >= 3: schema is current

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
