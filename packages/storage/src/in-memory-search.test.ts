/**
 * Tests for InMemorySearchStore: BM25 ranking, tokenization, repo filtering,
 * index/delete/clear, and upsert behavior.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySearchStore } from "./search.js";

describe("InMemorySearchStore", () => {
  let store: InMemorySearchStore;

  beforeEach(() => {
    store = new InMemorySearchStore();
  });

  describe("index and search", () => {
    it("finds documents by keyword", async () => {
      await store.index([
        { id: "auth.ts", content: "authentication login handler", metadata: { repo: "r1" } },
        { id: "db.ts", content: "database connection pool", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("authentication");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("auth.ts");
    });

    it("returns positive BM25 scores", async () => {
      await store.index([
        { id: "a.ts", content: "important function module", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("important");
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("ranks documents with more term occurrences higher", async () => {
      await store.index([
        { id: "low.ts", content: "error handling once", metadata: { repo: "r1" } },
        { id: "high.ts", content: "error error error handling", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("error");
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe("high.ts");
    });

    it("respects limit parameter", async () => {
      await store.index([
        { id: "a.ts", content: "shared module code", metadata: { repo: "r1" } },
        { id: "b.ts", content: "shared module logic", metadata: { repo: "r1" } },
        { id: "c.ts", content: "shared module helper", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("shared", 2);
      expect(results).toHaveLength(2);
    });

    it("filters by repo", async () => {
      await store.index([
        { id: "a.ts", content: "shared utility function", metadata: { repo: "r1" } },
        { id: "b.ts", content: "shared utility class", metadata: { repo: "r2" } },
      ]);

      const results = await store.search("shared", 10, "r1");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("a.ts");
    });

    it("returns empty for no matches", async () => {
      await store.index([
        { id: "a.ts", content: "hello world program", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("nonexistent");
      expect(results).toEqual([]);
    });

    it("handles empty query", async () => {
      await store.index([
        { id: "a.ts", content: "test content here", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("");
      expect(results).toEqual([]);
    });

    it("preserves metadata through cycle", async () => {
      await store.index([
        { id: "a.ts", content: "config parser module", metadata: { repo: "r1", tier: "1" } },
      ]);

      const results = await store.search("config");
      expect(results[0]!.metadata).toEqual({ repo: "r1", tier: "1" });
    });

    it("handles multi-token queries", async () => {
      await store.index([
        { id: "a.ts", content: "database connection pool handler", metadata: { repo: "r1" } },
        { id: "b.ts", content: "http request handler middleware", metadata: { repo: "r1" } },
      ]);

      const results = await store.search("database connection");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("a.ts");
    });
  });

  describe("upsert behavior", () => {
    it("updates document content on re-index", async () => {
      await store.index([
        { id: "a.ts", content: "old alpha content", metadata: { repo: "r1" } },
      ]);

      await store.index([
        { id: "a.ts", content: "new beta content", metadata: { repo: "r1" } },
      ]);

      const oldResults = await store.search("alpha");
      expect(oldResults).toEqual([]);

      const newResults = await store.search("beta");
      expect(newResults).toHaveLength(1);
    });
  });

  describe("delete", () => {
    it("removes documents and cleans inverted index", async () => {
      await store.index([
        { id: "a.ts", content: "alpha function", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta function", metadata: { repo: "r1" } },
      ]);

      await store.delete(["a.ts"]);

      const results = await store.search("alpha");
      expect(results).toEqual([]);

      const remaining = await store.search("beta");
      expect(remaining).toHaveLength(1);
    });

    it("is safe for non-existent ids", async () => {
      await expect(store.delete(["ghost.ts"])).resolves.toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all documents", async () => {
      await store.index([
        { id: "a.ts", content: "alpha", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta", metadata: { repo: "r2" } },
      ]);

      await store.clear();

      const results = await store.search("alpha");
      expect(results).toEqual([]);
    });

    it("removes only documents for specified repo", async () => {
      await store.index([
        { id: "a.ts", content: "alpha shared", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta shared", metadata: { repo: "r2" } },
      ]);

      await store.clear("r1");

      expect(await store.search("alpha")).toEqual([]);
      expect(await store.search("beta")).toHaveLength(1);
    });
  });

  describe("close", () => {
    it("empties the store", async () => {
      await store.index([
        { id: "a.ts", content: "test data", metadata: { repo: "r1" } },
      ]);

      await store.close();

      const results = await store.search("test");
      expect(results).toEqual([]);
    });
  });
});
