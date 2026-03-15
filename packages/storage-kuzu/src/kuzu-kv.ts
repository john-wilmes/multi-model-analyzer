/**
 * Kuzu-backed key-value store.
 *
 * Uses a KV node table with STRING primary key.
 * All queries use prepared statements for performance.
 * Sync Kuzu APIs are wrapped in async methods to satisfy the KVStore interface.
 */

import type { KVStore } from "@mma/storage";
import kuzu from "kuzu";
import { single } from "./kuzu-common.js";

/** Extract all rows from a QueryResult | QueryResult[], guarding the array case. */
function allRows(
  result: kuzu.QueryResult | kuzu.QueryResult[],
): Record<string, kuzu.KuzuValue>[] {
  return single(result).getAllSync();
}

export class KuzuKVStore implements KVStore {
  private readonly conn: kuzu.Connection;

  private readonly stmtGet: kuzu.PreparedStatement;
  private readonly stmtSet: kuzu.PreparedStatement;
  private readonly stmtDelete: kuzu.PreparedStatement;
  private readonly stmtHas: kuzu.PreparedStatement;
  private readonly stmtKeysAll: kuzu.PreparedStatement;
  private readonly stmtKeysPrefix: kuzu.PreparedStatement;
  private readonly stmtGetByPrefix: kuzu.PreparedStatement;
  private readonly stmtCountByPrefix: kuzu.PreparedStatement;
  private readonly stmtDeleteByPrefix: kuzu.PreparedStatement;
  private readonly stmtCountAll: kuzu.PreparedStatement;
  private readonly stmtClear: kuzu.PreparedStatement;

  constructor(conn: kuzu.Connection) {
    this.conn = conn;

    this.stmtGet = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key = $k RETURN n.value AS value",
    );
    this.stmtSet = conn.prepareSync(
      "MERGE (n:KV {key: $k}) SET n.value = $v",
    );
    this.stmtDelete = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key = $k DELETE n",
    );
    this.stmtHas = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key = $k RETURN count(n) AS cnt",
    );
    this.stmtKeysAll = conn.prepareSync(
      "MATCH (n:KV) RETURN n.key AS key ORDER BY n.key",
    );
    this.stmtKeysPrefix = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key STARTS WITH $p RETURN n.key AS key ORDER BY n.key",
    );
    this.stmtGetByPrefix = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key STARTS WITH $p RETURN n.key AS key, n.value AS value ORDER BY n.key",
    );
    this.stmtCountByPrefix = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key STARTS WITH $p RETURN count(n) AS cnt",
    );
    this.stmtDeleteByPrefix = conn.prepareSync(
      "MATCH (n:KV) WHERE n.key STARTS WITH $p DELETE n",
    );
    this.stmtCountAll = conn.prepareSync(
      "MATCH (n:KV) RETURN count(n) AS cnt",
    );
    this.stmtClear = conn.prepareSync(
      "MATCH (n:KV) DELETE n",
    );
  }

  async get(key: string): Promise<string | undefined> {
    const rows = allRows(this.conn.executeSync(this.stmtGet, { k: key }));
    const row = rows[0];
    if (row === undefined) return undefined;
    const v = row["value"];
    return v == null ? undefined : String(v as string | number);
  }

  async set(key: string, value: string): Promise<void> {
    this.conn.executeSync(this.stmtSet, { k: key, v: value });
  }

  async delete(key: string): Promise<void> {
    this.conn.executeSync(this.stmtDelete, { k: key });
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    if (prefix === "") {
      // Empty prefix — delete all: count first, then clear.
      const count = this._countAll();
      this.conn.executeSync(this.stmtClear, {});
      return count;
    }
    const count = this._countByPrefix(prefix);
    this.conn.executeSync(this.stmtDeleteByPrefix, { p: prefix });
    return count;
  }

  async has(key: string): Promise<boolean> {
    const rows = allRows(this.conn.executeSync(this.stmtHas, { k: key }));
    const row = rows[0];
    if (row === undefined) return false;
    const cnt = row["cnt"];
    return typeof cnt === "number" ? cnt > 0 : typeof cnt === "bigint" ? cnt > 0n : false;
  }

  async keys(prefix?: string): Promise<string[]> {
    if (!prefix) {
      const rows = allRows(this.conn.executeSync(this.stmtKeysAll, {}));
      return rows.map((r) => String(r["key"] as string));
    }
    const rows = allRows(this.conn.executeSync(this.stmtKeysPrefix, { p: prefix }));
    return rows.map((r) => String(r["key"] as string));
  }

  async getByPrefix(prefix: string): Promise<Map<string, string>> {
    const rows = allRows(
      this.conn.executeSync(this.stmtGetByPrefix, { p: prefix }),
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(String(row["key"] as string), String(row["value"] as string));
    }
    return map;
  }

  async isEmpty(): Promise<boolean> {
    return this._countAll() === 0;
  }

  async clear(): Promise<void> {
    this.conn.executeSync(this.stmtClear, {});
  }

  async setMany(
    entries: ReadonlyArray<readonly [key: string, value: string]>,
  ): Promise<void> {
    if (entries.length === 0) return;
    this.conn.querySync("BEGIN TRANSACTION");
    try {
      for (const [key, value] of entries) {
        this.conn.executeSync(this.stmtSet, { k: key, v: value });
      }
      this.conn.querySync("COMMIT");
    } catch (e) {
      this.conn.querySync("ROLLBACK");
      throw e;
    }
  }

  async close(): Promise<void> {
    // No-op: lifecycle managed by createKuzuStores()
  }

  // ---- private helpers ----

  private _countAll(): number {
    const rows = allRows(this.conn.executeSync(this.stmtCountAll, {}));
    const row = rows[0];
    if (row === undefined) return 0;
    const cnt = row["cnt"];
    if (typeof cnt === "number") return cnt;
    if (typeof cnt === "bigint") return Number(cnt);
    return 0;
  }

  private _countByPrefix(prefix: string): number {
    const rows = allRows(
      this.conn.executeSync(this.stmtCountByPrefix, { p: prefix }),
    );
    const row = rows[0];
    if (row === undefined) return 0;
    const cnt = row["cnt"];
    if (typeof cnt === "number") return cnt;
    if (typeof cnt === "bigint") return Number(cnt);
    return 0;
  }
}
