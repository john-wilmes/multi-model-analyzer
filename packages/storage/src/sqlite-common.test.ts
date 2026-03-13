/**
 * Tests for shared SQLite database setup and schema initialization.
 */

import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, initSchema, createSqliteStores } from "./sqlite-common.js";

describe("openDatabase", () => {
  const dbs: ReturnType<typeof openDatabase>[] = [];
  const cleanup = (db: ReturnType<typeof openDatabase>) => {
    dbs.push(db);
    return db;
  };

  afterEach(() => {
    for (const db of dbs) {
      if (db.open) db.close();
    }
    dbs.length = 0;
  });

  it("opens an in-memory database", () => {
    const db = cleanup(openDatabase(":memory:", false));

    expect(db.open).toBe(true);
  });

  it("sets synchronous=NORMAL pragma", () => {
    const db = cleanup(openDatabase(":memory:", false));
    const row = db.pragma("synchronous") as Array<{ synchronous: number }>;

    // NORMAL = 1
    expect(row[0]!.synchronous).toBe(1);
  });

  it("enables foreign keys", () => {
    const db = cleanup(openDatabase(":memory:", false));
    const row = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;

    expect(row[0]!.foreign_keys).toBe(1);
  });

  it("sets cache_size to 128MB", () => {
    const db = cleanup(openDatabase(":memory:", false));
    const row = db.pragma("cache_size") as Array<{ cache_size: number }>;

    // -131072 = 128MB in KiB pages
    expect(row[0]!.cache_size).toBe(-131072);
  });

  it("sets temp_store to MEMORY", () => {
    const db = cleanup(openDatabase(":memory:", false));
    const row = db.pragma("temp_store") as Array<{ temp_store: number }>;

    // MEMORY = 2
    expect(row[0]!.temp_store).toBe(2);
  });
});

describe("initSchema", () => {
  it("creates expected tables", () => {
    const db = openDatabase(":memory:", false);
    initSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("edges");
    expect(names).toContain("kv");
    expect(names).toContain("search_docs");
    expect(names).toContain("search_fts");

    db.close();
  });

  it("creates indexes on edges table", () => {
    const db = openDatabase(":memory:", false);
    initSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='edges'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain("idx_edges_source");
    expect(names).toContain("idx_edges_target");
    expect(names).toContain("idx_edges_kind");

    db.close();
  });

  it("is idempotent (can run twice without error)", () => {
    const db = openDatabase(":memory:", false);
    initSchema(db);

    expect(() => initSchema(db)).not.toThrow();

    db.close();
  });
});

describe("createSqliteStores", () => {
  it("creates all three stores from a single connection", () => {
    const stores = createSqliteStores({ dbPath: ":memory:" });

    expect(stores.graphStore).toBeDefined();
    expect(stores.searchStore).toBeDefined();
    expect(stores.kvStore).toBeDefined();

    stores.close();
  });

  it("close() is safe to call multiple times", () => {
    const stores = createSqliteStores({ dbPath: ":memory:" });

    stores.close();
    expect(() => stores.close()).not.toThrow();
  });

  it("stores share the same database (KV write visible to raw query)", async () => {
    const stores = createSqliteStores({ dbPath: ":memory:" });

    await stores.kvStore.set("test-key", "test-value");
    const value = await stores.kvStore.get("test-key");

    expect(value).toBe("test-value");

    stores.close();
  });
});
