import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { GraphStore } from "./graph.js";
import type { KVStore } from "./kv.js";
import type { SearchStore } from "./search.js";
import { InMemoryGraphStore } from "./graph.js";
import { InMemoryKVStore } from "./kv.js";
import { InMemorySearchStore } from "./search.js";
import { createSqliteStores } from "./sqlite-common.js";
import type { SqliteStores } from "./sqlite-common.js";
import type { GraphEdge } from "@mma/core";

interface StoreFactory {
  name: string;
  createGraphStore: () => GraphStore;
  createKVStore: () => KVStore;
  createSearchStore: () => SearchStore;
  teardown: () => void;
}

function inMemoryFactory(): StoreFactory {
  return {
    name: "InMemory",
    createGraphStore: () => new InMemoryGraphStore(),
    createKVStore: () => new InMemoryKVStore(),
    createSearchStore: () => new InMemorySearchStore(),
    teardown: () => {},
  };
}

function sqliteFactory(): StoreFactory {
  let stores: SqliteStores | undefined;
  return {
    name: "SQLite",
    createGraphStore: () => {
      if (!stores) stores = createSqliteStores({ dbPath: ":memory:" });
      return stores.graphStore;
    },
    createKVStore: () => {
      if (!stores) stores = createSqliteStores({ dbPath: ":memory:" });
      return stores.kvStore;
    },
    createSearchStore: () => {
      if (!stores) stores = createSqliteStores({ dbPath: ":memory:" });
      return stores.searchStore;
    },
    teardown: () => {
      stores?.close();
      stores = undefined;
    },
  };
}

const factories = [inMemoryFactory, sqliteFactory];

for (const makeFactory of factories) {
  const factory = makeFactory();

  describe(`GraphStore (${factory.name})`, () => {
    let store: GraphStore;

    beforeEach(async () => {
      store = factory.createGraphStore();
      await store.clear();
    });

    afterEach(async () => {
      await store.close();
      factory.teardown();
    });

    it("adds and retrieves edges by source", async () => {
      const edges: GraphEdge[] = [
        { source: "a", target: "b", kind: "calls" },
        { source: "a", target: "c", kind: "imports" },
        { source: "b", target: "c", kind: "calls" },
      ];
      await store.addEdges(edges);

      const fromA = await store.getEdgesFrom("a");
      expect(fromA).toHaveLength(2);
      expect(fromA.map((e) => e.target).sort()).toEqual(["b", "c"]);
    });

    it("retrieves edges by target", async () => {
      await store.addEdges([
        { source: "a", target: "c", kind: "calls" },
        { source: "b", target: "c", kind: "imports" },
      ]);

      const toC = await store.getEdgesTo("c");
      expect(toC).toHaveLength(2);
    });

    it("retrieves edges by kind", async () => {
      await store.addEdges([
        { source: "a", target: "b", kind: "calls" },
        { source: "a", target: "c", kind: "imports" },
        { source: "b", target: "c", kind: "calls" },
      ]);

      const calls = await store.getEdgesByKind("calls");
      expect(calls).toHaveLength(2);
    });

    it("preserves metadata", async () => {
      await store.addEdges([
        { source: "a", target: "b", kind: "calls", metadata: { repo: "test", weight: 5 } },
      ]);

      const edges = await store.getEdgesFrom("a");
      expect(edges[0]!.metadata).toEqual({ repo: "test", weight: 5 });
    });

    it("traverses BFS up to maxDepth", async () => {
      await store.addEdges([
        { source: "a", target: "b", kind: "calls" },
        { source: "b", target: "c", kind: "calls" },
        { source: "c", target: "d", kind: "calls" },
      ]);

      const depth1 = await store.traverseBFS("a", 1);
      const targets = depth1.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).not.toContain("d");
    });

    it("handles BFS cycles", async () => {
      await store.addEdges([
        { source: "a", target: "b", kind: "calls" },
        { source: "b", target: "a", kind: "calls" },
      ]);

      const result = await store.traverseBFS("a", 10);
      expect(result).toHaveLength(2);
    });

    it("clears by repo", async () => {
      await store.addEdges([
        { source: "a", target: "b", kind: "calls", metadata: { repo: "r1" } },
        { source: "c", target: "d", kind: "calls", metadata: { repo: "r2" } },
      ]);

      await store.clear("r1");
      const fromA = await store.getEdgesFrom("a");
      const fromC = await store.getEdgesFrom("c");
      expect(fromA).toHaveLength(0);
      expect(fromC).toHaveLength(1);
    });

    it("clears all", async () => {
      await store.addEdges([
        { source: "a", target: "b", kind: "calls" },
      ]);
      await store.clear();
      const edges = await store.getEdgesFrom("a");
      expect(edges).toHaveLength(0);
    });

    it("handles empty addEdges", async () => {
      await store.addEdges([]);
      const edges = await store.getEdgesFrom("a");
      expect(edges).toHaveLength(0);
    });
  });

  describe(`KVStore (${factory.name})`, () => {
    let store: KVStore;

    beforeEach(async () => {
      store = factory.createKVStore();
      await store.clear();
    });

    afterEach(async () => {
      await store.close();
      factory.teardown();
    });

    it("sets and gets values", async () => {
      await store.set("key1", "value1");
      expect(await store.get("key1")).toBe("value1");
    });

    it("returns undefined for missing keys", async () => {
      expect(await store.get("missing")).toBeUndefined();
    });

    it("overwrites existing values", async () => {
      await store.set("key1", "v1");
      await store.set("key1", "v2");
      expect(await store.get("key1")).toBe("v2");
    });

    it("deletes keys", async () => {
      await store.set("key1", "value1");
      await store.delete("key1");
      expect(await store.get("key1")).toBeUndefined();
    });

    it("checks existence with has()", async () => {
      await store.set("key1", "value1");
      expect(await store.has("key1")).toBe(true);
      expect(await store.has("missing")).toBe(false);
    });

    it("lists all keys", async () => {
      await store.set("b", "1");
      await store.set("a", "2");
      const keys = await store.keys();
      expect(keys).toContain("a");
      expect(keys).toContain("b");
    });

    it("lists keys by prefix", async () => {
      await store.set("repo:a:hash", "h1");
      await store.set("repo:b:hash", "h2");
      await store.set("other:x", "ox");

      const repoKeys = await store.keys("repo:");
      expect(repoKeys).toHaveLength(2);
      expect(repoKeys.every((k) => k.startsWith("repo:"))).toBe(true);
    });

    it("clears all", async () => {
      await store.set("a", "1");
      await store.set("b", "2");
      await store.clear();
      expect(await store.keys()).toHaveLength(0);
    });
  });

  describe(`SearchStore (${factory.name})`, () => {
    let store: SearchStore;

    beforeEach(async () => {
      store = factory.createSearchStore();
      await store.clear();
    });

    afterEach(async () => {
      await store.close();
      factory.teardown();
    });

    it("indexes and searches documents", async () => {
      await store.index([
        { id: "1", content: "hello world greeting function", metadata: { type: "function" } },
        { id: "2", content: "database connection pool manager", metadata: { type: "class" } },
      ]);

      const results = await store.search("greeting");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe("1");
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("respects limit", async () => {
      await store.index([
        { id: "1", content: "hello world", metadata: { type: "a" } },
        { id: "2", content: "hello earth", metadata: { type: "b" } },
        { id: "3", content: "hello universe", metadata: { type: "c" } },
      ]);

      const results = await store.search("hello", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("preserves metadata", async () => {
      await store.index([
        { id: "1", content: "test content", metadata: { repo: "myrepo", kind: "function" } },
      ]);

      const results = await store.search("test");
      expect(results[0]!.metadata).toEqual({ repo: "myrepo", kind: "function" });
    });

    it("deletes documents", async () => {
      await store.index([
        { id: "1", content: "alpha beta", metadata: { type: "a" } },
        { id: "2", content: "alpha gamma", metadata: { type: "b" } },
      ]);

      await store.delete(["1"]);
      const results = await store.search("alpha");
      expect(results.every((r) => r.id !== "1")).toBe(true);
    });

    it("clears all documents", async () => {
      await store.index([
        { id: "1", content: "something searchable", metadata: { type: "a" } },
      ]);
      await store.clear();
      const results = await store.search("something");
      expect(results).toHaveLength(0);
    });

    it("handles empty query gracefully", async () => {
      await store.index([
        { id: "1", content: "hello world", metadata: { type: "a" } },
      ]);
      const results = await store.search("");
      expect(results).toHaveLength(0);
    });

    it("handles empty index", async () => {
      await store.index([]);
      const results = await store.search("anything");
      expect(results).toHaveLength(0);
    });

    it("re-indexes same doc ID without stale tokens", async () => {
      await store.index([
        { id: "doc1", content: "alpha beta gamma", metadata: { repo: "r1" } },
      ]);
      // Re-index with different content
      await store.index([
        { id: "doc1", content: "delta epsilon zeta", metadata: { repo: "r1" } },
      ]);

      // Old tokens should not match
      const oldResults = await store.search("alpha");
      expect(oldResults).toHaveLength(0);

      // New tokens should match
      const newResults = await store.search("delta");
      expect(newResults).toHaveLength(1);
      expect(newResults[0]!.id).toBe("doc1");
    });

    it("clears documents by repo", async () => {
      await store.index([
        { id: "r1-1", content: "hello world", metadata: { repo: "repo-a" } },
        { id: "r1-2", content: "hello earth", metadata: { repo: "repo-a" } },
        { id: "r2-1", content: "hello mars", metadata: { repo: "repo-b" } },
      ]);

      await store.clear("repo-a");

      const results = await store.search("hello");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("r2-1");
    });
  });
}
