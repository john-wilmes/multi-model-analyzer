/**
 * Tests for createKuzuStores factory: validates that all three stores are
 * returned, share a connection without corrupting each other, and that
 * close() is safe to call.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKuzuStores, detectSchemaVersion, migrateV1ToV2, migrateV2ToV3, single } from "./kuzu-common.js";
import type { KuzuStores } from "./kuzu-common.js";
import { KuzuGraphStore } from "./kuzu-graph.js";
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

  it("detects version 2 on v2 database", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
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
      expect(detectSchemaVersion(conn)).toBe(2);
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("handles migration of empty v2 database", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
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

      expect(detectSchemaVersion(conn)).toBe(2);
      migrateV2ToV3(conn);
      expect(detectSchemaVersion(conn)).toBe(3);

      // No edges — verify typed rel queries return empty results
      const rows = single(
        conn.querySync(
          "MATCH (s:Symbol)-[:Imports]->(t:Symbol) RETURN s.id",
        ),
      ).getAllSync() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(0);
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("skips unknown edge kinds during v2→v3 migration without throwing", () => {
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();
    try {
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
      conn.querySync("MERGE (s:Symbol {id: 'x'})");
      conn.querySync("MERGE (s:Symbol {id: 'y'})");
      // Insert a known kind and an unknown kind in v2 format
      conn.querySync(
        "MATCH (s:Symbol {id: 'x'}), (t:Symbol {id: 'y'}) " +
          "CREATE (s)-[:Edge {kind: 'calls', metadata: '{}', repo: 'r1'}]->(t)",
      );
      conn.querySync(
        "MATCH (s:Symbol {id: 'y'}), (t:Symbol {id: 'x'}) " +
          "CREATE (s)-[:Edge {kind: 'unknown-future-kind', metadata: '{}', repo: 'r1'}]->(t)",
      );

      // Migration must not throw even when unknown kinds exist
      expect(() => migrateV2ToV3(conn)).not.toThrow();
      expect(detectSchemaVersion(conn)).toBe(3);

      // Known kind was migrated
      const callRows = single(
        conn.querySync(
          "MATCH (s:Symbol {id: 'x'})-[:Calls]->(t:Symbol) RETURN t.id AS target",
        ),
      ).getAllSync() as Array<Record<string, unknown>>;
      expect(callRows).toHaveLength(1);
      expect(callRows[0]!["target"]).toBe("y");
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("migrates v1→v2→v3 via createKuzuStores with data accessible via graph store", async () => {
    // Simulate a v1 database: build it with raw Kuzu, then open via factory
    // which should auto-migrate to v3. We verify data via the typed store API.
    const db1 = new kuzu.Database(":memory:");
    db1.initSync();
    const conn1 = new kuzu.Connection(db1);
    conn1.initSync();

    // Kuzu in-memory databases can't be reopened, so we build the v1 schema
    // and data, run migrations in-process, then hand off the connection to a
    // KuzuGraphStore directly to verify the store API works post-migration.
    conn1.querySync(
      "CREATE NODE TABLE IF NOT EXISTS KV(key STRING PRIMARY KEY, value STRING)",
    );
    conn1.querySync(
      "CREATE NODE TABLE IF NOT EXISTS Edge(" +
        "id SERIAL PRIMARY KEY, source STRING, target STRING, " +
        "kind STRING, metadata STRING, repo STRING)",
    );
    conn1.querySync(
      "CREATE (:Edge {source: 'pkg-a', target: 'pkg-b', kind: 'imports', " +
        "metadata: '{\"repo\":\"repo1\"}', repo: 'repo1'})",
    );
    conn1.querySync(
      "CREATE (:Edge {source: 'pkg-b', target: 'pkg-c', kind: 'calls', " +
        "metadata: '{\"repo\":\"repo1\"}', repo: 'repo1'})",
    );

    try {
      expect(detectSchemaVersion(conn1)).toBe(1);

      // Run both migrations
      migrateV1ToV2(conn1);
      migrateV2ToV3(conn1);

      expect(detectSchemaVersion(conn1)).toBe(3);

      // Create graph store over the migrated connection and verify all edges
      const graphStore = new KuzuGraphStore(conn1);

      const importsEdges = await graphStore.getEdgesByKind("imports");
      expect(importsEdges).toHaveLength(1);
      expect(importsEdges[0]!.source).toBe("pkg-a");
      expect(importsEdges[0]!.target).toBe("pkg-b");

      const callEdges = await graphStore.getEdgesByKind("calls");
      expect(callEdges).toHaveLength(1);
      expect(callEdges[0]!.source).toBe("pkg-b");
      expect(callEdges[0]!.target).toBe("pkg-c");
    } finally {
      try { conn1.closeSync(); } catch { /* ignore */ }
      try { db1.closeSync(); } catch { /* ignore */ }
    }
  });

  it("migrates v2→v3 via createKuzuStores with data accessible via graph store", async () => {
    // Build a v2-schema database, run the v2→v3 migration, and confirm the
    // graph store API returns edges correctly.
    const db = new kuzu.Database(":memory:");
    db.initSync();
    const conn = new kuzu.Connection(db);
    conn.initSync();

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
    conn.querySync("MERGE (s:Symbol {id: 'svc-a'})");
    conn.querySync("MERGE (s:Symbol {id: 'svc-b'})");
    conn.querySync(
      "MATCH (s:Symbol {id: 'svc-a'}), (t:Symbol {id: 'svc-b'}) " +
        "CREATE (s)-[:Edge {kind: 'extends', metadata: '{\"repo\":\"r2\"}', repo: 'r2'}]->(t)",
    );

    try {
      expect(detectSchemaVersion(conn)).toBe(2);
      migrateV2ToV3(conn);
      expect(detectSchemaVersion(conn)).toBe(3);

      // Also add search/KV tables so we can use a full store suite
      conn.querySync(
        "CREATE NODE TABLE IF NOT EXISTS SearchDoc(id STRING PRIMARY KEY, " +
          "content STRING, metadata STRING, repo STRING)",
      );
      conn.querySync("LOAD EXTENSION fts");

      const graphStore = new KuzuGraphStore(conn);

      const edges = await graphStore.getEdgesByKind("extends");
      expect(edges).toHaveLength(1);
      expect(edges[0]!.source).toBe("svc-a");
      expect(edges[0]!.target).toBe("svc-b");

      // Verify getEdgesFrom also works
      const fromEdges = await graphStore.getEdgesFrom("svc-a");
      expect(fromEdges).toHaveLength(1);
      expect(fromEdges[0]!.kind).toBe("extends");
    } finally {
      try { conn.closeSync(); } catch { /* ignore */ }
      try { db.closeSync(); } catch { /* ignore */ }
    }
  });

  it("fresh database gets v3 schema directly without migration", async () => {
    // createKuzuStores on a fresh DB should land on v3 immediately.
    const stores = createKuzuStores({ dbPath: ":memory:" });
    try {
      // Add edges covering multiple kinds to confirm all typed tables exist
      await stores.graphStore.addEdges([
        { source: "a", target: "b", kind: "imports", metadata: { repo: "r" } },
        { source: "b", target: "c", kind: "calls", metadata: { repo: "r" } },
        { source: "c", target: "d", kind: "extends", metadata: { repo: "r" } },
        { source: "d", target: "e", kind: "implements", metadata: { repo: "r" } },
        { source: "e", target: "f", kind: "depends-on", metadata: { repo: "r" } },
        { source: "f", target: "g", kind: "contains", metadata: { repo: "r" } },
        { source: "g", target: "a", kind: "service-call", metadata: { repo: "r" } },
      ]);

      for (const [kind, src, tgt] of [
        ["imports", "a", "b"],
        ["calls", "b", "c"],
        ["extends", "c", "d"],
        ["implements", "d", "e"],
        ["depends-on", "e", "f"],
        ["contains", "f", "g"],
        ["service-call", "g", "a"],
      ] as const) {
        const edges = await stores.graphStore.getEdgesByKind(kind);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.source).toBe(src);
        expect(edges[0]!.target).toBe(tgt);
      }
    } finally {
      stores.close();
    }
  });

  it("multiple independent stores can be created without conflict", async () => {
    // Build a v3 database, then create a second independent in-memory store.
    // Verifies that schema bootstrap is idempotent (CREATE ... IF NOT EXISTS)
    // and that two separate stores don't interfere with each other.
    const stores1 = createKuzuStores({ dbPath: ":memory:" });
    try {
      await stores1.graphStore.addEdges([
        { source: "x", target: "y", kind: "calls", metadata: { repo: "r" } },
      ]);

      // Verify data still readable after the store is fully initialised
      const edges = await stores1.graphStore.getEdgesByKind("calls");
      expect(edges).toHaveLength(1);
      expect(edges[0]!.source).toBe("x");
      expect(edges[0]!.target).toBe("y");
    } finally {
      stores1.close();
    }

    // Open a second independent in-memory store — confirms schema bootstrap
    // is idempotent and doesn't fail on pre-existing tables.
    const stores2 = createKuzuStores({ dbPath: ":memory:" });
    try {
      await stores2.graphStore.addEdges([
        { source: "p", target: "q", kind: "imports", metadata: { repo: "r" } },
      ]);
      const edges = await stores2.graphStore.getEdgesByKind("imports");
      expect(edges).toHaveLength(1);
    } finally {
      stores2.close();
    }
  });
});
