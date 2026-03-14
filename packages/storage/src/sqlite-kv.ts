/**
 * SQLite-backed key-value store.
 *
 * Uses UPSERT (INSERT OR REPLACE) for set operations.
 * All queries use prepared statements for performance.
 */

import type Database from "better-sqlite3";
import type { KVStore } from "./kv.js";

export class SqliteKVStore implements KVStore {
  private readonly db: Database.Database;
  private readonly stmtGet: Database.Statement;
  private readonly stmtSet: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtHas: Database.Statement;
  private readonly stmtKeysAll: Database.Statement;
  private readonly stmtKeysPrefix: Database.Statement;
  private readonly stmtClear: Database.Statement;
  private readonly stmtDeleteByPrefix: Database.Statement;
  private readonly stmtGetByPrefix: Database.Statement;
  private readonly stmtIsEmpty: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
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
    this.stmtDeleteByPrefix = db.prepare(
      "DELETE FROM kv WHERE key >= ? AND key < ?",
    );
    this.stmtGetByPrefix = db.prepare(
      "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key",
    );
    this.stmtIsEmpty = db.prepare("SELECT 1 FROM kv LIMIT 1");
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

  async deleteByPrefix(prefix: string): Promise<number> {
    if (prefix === "") {
      const result = this.stmtClear.run();
      return result.changes;
    }
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const result = this.stmtDeleteByPrefix.run(prefix, upper);
    return result.changes;
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

  async getByPrefix(prefix: string): Promise<Map<string, string>> {
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = this.stmtGetByPrefix.all(prefix, upper) as Array<{ key: string; value: string }>;
    const result = new Map<string, string>();
    for (const row of rows) {
      result.set(row.key, row.value);
    }
    return result;
  }

  async setMany(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
    const runInTransaction = this.db.transaction((items: ReadonlyArray<readonly [string, string]>) => {
      for (const [key, value] of items) {
        this.stmtSet.run(key, value);
      }
    });
    runInTransaction(entries);
  }

  async isEmpty(): Promise<boolean> {
    return this.stmtIsEmpty.get() === undefined;
  }

  async clear(): Promise<void> {
    this.stmtClear.run();
  }

  async close(): Promise<void> {
    // No-op: lifecycle managed by createSqliteStores()
  }
}
