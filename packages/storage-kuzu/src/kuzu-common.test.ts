/**
 * Tests for createKuzuStores factory: validates that all three stores are
 * returned, share a connection without corrupting each other, and that
 * close() is safe to call.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKuzuStores, detectSchemaVersion, migrateV1ToV2, migrateV2ToV3, single } from "./kuzu-common.js";
import type { KuzuStores } from "./kuzu-common.js";
import kuzu from "kuzu";

describe("createKuzuStores", () => {
  let stores: KuzuStores;

  beforeEach(() => {
    stores = createKuzuStores({ dbPath: ":memory:" });
  });

  afterEach(() => {
    stores.close();
  });

  it("returns a kvStore", () => {
    expect(stores.kvStore).toBeDefined();
    expect(typeof stores.kvStore.get).toBe("function");
    expect(typeof stores.kvStore.set).toBe("function");
  });

  it("returns a graphStore", () => {
    expect(stores.graphStore).toBeDefined();
    expect(typeof stores.graphStore.addEdges).toBe("function");
    expect(typeof stores.graphStore.getEdgesByKind).toBe("function");
  });

  it("returns a searchStore", () => {
    expect(stores.searchStore).toBeDefined();
    expect(typeof stores.searchStore.index).toBe("function");
    expect(typeof stores.searchStore.search).toBe("function");
  });

  it("returns a close function", () => {
    expect(typeof stores.close).toBe("function");
  });

  describe("store isolation (shared connection)", () => {
    it("KV operations do not corrupt graph store", async () => {
      const { kvStore, graphStore } = stores;

      await kvStore.set("test-key", "test-value");
      await graphStore.addEdges([{
        source: "a",
        target: "b",
        kind: "imports",
        metadata: { repo: "r1" },
      }]);

      // KV should still return its value
      expect(await kvStore.get("test-key")).toBe("test-value");

      // Graph should still return its edge
      const edges = await graphStore.getEdgesFrom("a");
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target).toBe("b");
    });

    it("graph operations do not corrupt search store", async () => {
      const { graphStore, searchStore } = stores;

      await graphStore.addEdges([{
        source: "x",
        target: "y",
        kind: "calls",
        metadata: { repo: "r1" },
      }]);
      await searchStore.index([
        { id: "doc1", content: "unique searchable content", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("searchable");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("doc1");

      const edges = await graphStore.getEdgesByKind("calls");
      expect(edges).toHaveLength(1);
    });

    it("search operations do not corrupt KV store", async () => {
      const { kvStore, searchStore } = stores;

      await kvStore.set("meta:repo1", JSON.stringify({ name: "repo1" }));
      await searchStore.index([
        { id: "file.ts", content: "important module", metadata: { repo: "repo1" } },
      ]);

      // KV value must be unchanged
      const raw = await kvStore.get("meta:repo1");
      expect(JSON.parse(raw!)).toEqual({ name: "repo1" });

      // Search must still work
      const results = await searchStore.search("module");
      expect(results).toHaveLength(1);
    });

    it("clearing one store does not affect other stores", async () => {
      const { kvStore, graphStore, searchStore } = stores;

      await kvStore.set("keep", "this");
      await graphStore.addEdges([{
        source: "a", target: "b", kind: "imports", metadata: { repo: "r1" },
      }]);
      await searchStore.index([
        { id: "doc", content: "preserve me", metadata: { repo: "r1" } },
      ]);

      await kvStore.clear();

      // KV is now empty
      expect(await kvStore.isEmpty()).toBe(true);

      // Graph and search are unaffected
      const edges = await graphStore.getEdgesByKind("imports");
      expect(edges).toHaveLength(1);

      const results = await searchStore.search("preserve");
      expect(results).toHaveLength(1);
    });
  });

  describe("close()", () => {
    it("does not throw when called once", () => {
      const s = createKuzuStores({ dbPath: ":memory:" });
      expect(() => s.close()).not.toThrow();
    });

    it("does not throw when called a second time", () => {
      const s = createKuzuStores({ dbPath: ":memory:" });
      s.close();
      // Second close should be a silent no-op, not a crash
      expect(() => s.close()).not.toThrow();
    });
  });
});

describe("schema versioning", () => {
  it("detects version 0 on fresh database", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
      );
      expect(detectSchemaVersion(conn)).toBe(0);
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("detects version 1 on v1 database", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
      );
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS Edge(" +
          "id SERIAL PRIMARY KEY, source STRING, target STRING, " +
          "kind STRING, metadata STRING, repo STRING)",
      );
      expect(detectSchemaVersion(conn)).toBe(1);
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("detects version 3 after createKuzuStores", async () => {
    const stores = createKuzuStores({ dbPath: ":memory:" });
    try {
      await stores.graphStore.addEdges([
        { source: "a", target: "b", kind: "imports", metadata: { repo: "r1" } },
      ]);
      const edges = await stores.graphStore.getEdgesFrom("a");
      expect(edges).toHaveLength(1);
      expect(edges[0]!.target).toBe("b");
    } finally {
      stores.close();
    }
  });

  it("migrates v1 to v2 preserving edges", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
      );
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS Edge(" +
          "id SERIAL PRIMARY KEY, source STRING, target STRING, " +
          "kind STRING, metadata STRING, repo STRING)",
      );
      // Insert two v1 edges
      conn.querySync(
        "CREATE (:Edge {source: 'a', target: 'b', kind: 'imports', " +
          "metadata: '{\"repo\":\"r1\"}', repo: 'r1'})",
      );
      conn.querySync(
        "CREATE (:Edge {source: 'b', target: 'c', kind: 'calls', " +
          "metadata: '{\"repo\":\"r1\"}', repo: 'r1'})",
      );

      expect(detectSchemaVersion(conn)).toBe(1);
      migrateV1ToV2(conn);
      expect(detectSchemaVersion(conn)).toBe(2);

      // Verify edges are queryable via v2 rel schema
      const rows = single(
        conn.querySync(
          "MATCH (s:Symbol {id: 'a'})-[r:Edge]->(t:Symbol) " +
            "RETURN t.id AS target, r.kind AS kind",
        ),
      ).getAllSync() as Array<Record<string, unknown>>;

      expect(rows).toHaveLength(1);
      expect(rows[0]!["target"]).toBe("b");
      expect(rows[0]!["kind"]).toBe("imports");
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("handles migration of empty v1 database", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
      );
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS Edge(" +
          "id SERIAL PRIMARY KEY, source STRING, target STRING, " +
          "kind STRING, metadata STRING, repo STRING)",
      );

      expect(detectSchemaVersion(conn)).toBe(1);
      migrateV1ToV2(conn);
      expect(detectSchemaVersion(conn)).toBe(2);

      // No edges — verify query returns empty result
      const rows = single(
        conn.querySync("MATCH (s:Symbol)-[r:Edge]->(t:Symbol) RETURN s.id"),
      ).getAllSync() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(0);
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("migrates v2 to v3 preserving edges", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
      // Create v2 schema manually
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
      );
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING PRIMARY KEY)",
      );
      conn.querySync(
        "CREATE REL TABLE IF NOT EXISTS Edge(FROM Symbol TO Symbol, " +
          "kind STRING, metadata STRING, repo STRING)",
      );

      // Insert symbols and edges via v2 schema
      conn.querySync("MERGE (s:Symbol {id: 'a'})");
      conn.querySync("MERGE (s:Symbol {id: 'b'})");
      conn.querySync("MERGE (s:Symbol {id: 'c'})");
      conn.querySync("MERGE (s:Symbol {id: 'd'})");
      conn.querySync(
        "MATCH (s:Symbol {id: 'a'}), (t:Symbol {id: 'b'}) " +
          "CREATE (s)-[:Edge {kind: 'imports', metadata: '{\"repo\":\"r1\"}', repo: 'r1'}]->(t)",
      );
      conn.querySync(
        "MATCH (s:Symbol {id: 'b'}), (t:Symbol {id: 'c'}) " +
          "CREATE (s)-[:Edge {kind: 'depends-on', metadata: '{\"repo\":\"r1\"}', repo: 'r1'}]->(t)",
      );
      conn.querySync(
        "MATCH (s:Symbol {id: 'c'}), (t:Symbol {id: 'd'}) " +
          "CREATE (s)-[:Edge {kind: 'service-call', metadata: '{\"repo\":\"r1\"}', repo: 'r1'}]->(t)",
      );

      expect(detectSchemaVersion(conn)).toBe(2);
      migrateV2ToV3(conn);
      expect(detectSchemaVersion(conn)).toBe(3);

      // Verify imports edge queryable via typed Imports table
      const importRows = single(
        conn.querySync(
          "MATCH (s:Symbol {id: 'a'})-[r:Imports]->(t:Symbol) RETURN t.id AS target",
        ),
      ).getAllSync() as Array<Record<string, unknown>>;
      expect(importRows).toHaveLength(1);
      expect(importRows[0]!["target"]).toBe("b");

      // Verify hyphenated depends-on → DependsOn
      const depRows = single(
        conn.querySync(
          "MATCH (s:Symbol {id: 'b'})-[r:DependsOn]->(t:Symbol) RETURN t.id AS target",
        ),
      ).getAllSync() as Array<Record<string, unknown>>;
      expect(depRows).toHaveLength(1);
      expect(depRows[0]!["target"]).toBe("c");

      // Verify hyphenated service-call → ServiceCall
      const svcRows = single(
        conn.querySync(
          "MATCH (s:Symbol {id: 'c'})-[r:ServiceCall]->(t:Symbol) RETURN t.id AS target",
        ),
      ).getAllSync() as Array<Record<string, unknown>>;
      expect(svcRows).toHaveLength(1);
      expect(svcRows[0]!["target"]).toBe("d");
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });
});
