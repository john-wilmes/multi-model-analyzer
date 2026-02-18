/**
 * SQLite-backed key-value store.
 *
 * Uses UPSERT (INSERT OR REPLACE) for set operations.
 * All queries use prepared statements for performance.
 */

import type Database from "better-sqlite3";
import type { KVStore } from "./kv.js";

export class SqliteKVStore implements KVStore {
  private readonly stmtGet: Database.Statement;
  private readonly stmtSet: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtHas: Database.Statement;
  private readonly stmtKeysAll: Database.Statement;
  private readonly stmtKeysPrefix: Database.Statement;
  private readonly stmtClear: Database.Statement;

  constructor(db: Database.Database) {
    this.stmtGet = db.prepare("SELECT value FROM kv WHERE key = ?");
    this.stmtSet = db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.stmtDelete = db.prepare("DELETE FROM kv WHERE key = ?");
    this.stmtHas = db.prepare("SELECT 1 FROM kv WHERE key = ?");
    this.stmtKeysAll = db.prepare("SELECT key FROM kv ORDER BY key");
    this.stmtKeysPrefix = db.prepare(
      "SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key",
    );
    this.stmtClear = db.prepare("DELETE FROM kv");
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.stmtGet.get(key) as { value: string } | undefined;
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.stmtSet.run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.stmtDelete.run(key);
  }

  async has(key: string): Promise<boolean> {
    return this.stmtHas.get(key) !== undefined;
  }

  async keys(prefix?: string): Promise<string[]> {
    if (!prefix) {
      const rows = this.stmtKeysAll.all() as Array<{ key: string }>;
      return rows.map((r) => r.key);
    }
    // Range scan: prefix <= key < prefix with last char incremented
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = this.stmtKeysPrefix.all(prefix, upper) as Array<{
      key: string;
    }>;
    return rows.map((r) => r.key);
  }

  async clear(): Promise<void> {
    this.stmtClear.run();
  }

  async close(): Promise<void> {
    // No-op: lifecycle managed by createSqliteStores()
  }
}
