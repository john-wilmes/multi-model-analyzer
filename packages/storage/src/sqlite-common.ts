/**
 * Shared SQLite database setup for all store implementations.
 *
 * Opens a single database connection with WAL mode and returns
 * a factory that creates all three stores sharing that connection.
 */

import Database from "better-sqlite3";
import type { GraphStore } from "./graph.js";
import type { SearchStore } from "./search.js";
import type { KVStore } from "./kv.js";
import { SqliteGraphStore } from "./sqlite-graph.js";
import { SqliteSearchStore } from "./sqlite-search.js";
import { SqliteKVStore } from "./sqlite-kv.js";

export interface SqliteStores {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  close(): void;
}

export interface SqliteStoreOptions {
  /** Path to .db file, or ":memory:" for in-memory SQLite */
  readonly dbPath: string;
  /** Enable WAL mode (default: true, set false for :memory:) */
  readonly wal?: boolean;
  /** Open database in read-only mode (default: false) */
  readonly readonly?: boolean;
}

export function openDatabase(dbPath: string, wal = true, readonly = false): Database.Database {
  const db = new Database(dbPath, { readonly });
  if (!readonly && wal) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    -- GraphStore
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges (kind);
    CREATE INDEX IF NOT EXISTS idx_edges_source_repo ON edges (source, json_extract(metadata, '$.repo'));
    CREATE INDEX IF NOT EXISTS idx_edges_target_repo ON edges (target, json_extract(metadata, '$.repo'));
    CREATE INDEX IF NOT EXISTS idx_edges_kind_repo ON edges (kind, json_extract(metadata, '$.repo'));

    -- KVStore
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- SearchStore
    CREATE TABLE IF NOT EXISTS search_docs (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
  `);

  // FTS5 virtual table -- CREATE VIRTUAL TABLE doesn't support IF NOT EXISTS
  // in all SQLite versions, so check manually
  const hasFts = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='search_fts'",
    )
    .get();
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE search_fts
        USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
    `);
  }
}

export function createSqliteStores(options: SqliteStoreOptions): SqliteStores {
  const useWal = options.wal ?? options.dbPath !== ":memory:";
  const isReadonly = options.readonly ?? false;
  const db = openDatabase(options.dbPath, useWal, isReadonly);
  if (!isReadonly) {
    initSchema(db);
  }

  const graphStore = new SqliteGraphStore(db);
  const searchStore = new SqliteSearchStore(db);
  const kvStore = new SqliteKVStore(db);

  return {
    graphStore,
    searchStore,
    kvStore,
    close() {
      if (db.open) {
        db.close();
      }
    },
  };
}
