/**
 * Tests for SqliteSearchStore: FTS5 indexing, BM25 search, repo filtering,
 * query sanitization, deletion, and clear.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteStores } from "./sqlite-common.js";
import type { SearchStore } from "./search.js";

describe("SqliteSearchStore", () => {
  let searchStore: SearchStore;
  let cleanup: () => void;

  beforeEach(() => {
    const stores = createSqliteStores({ dbPath: ":memory:" });
    searchStore = stores.searchStore;
    cleanup = () => stores.close();
  });

  afterEach(() => {
    cleanup();
  });

  describe("index and search", () => {
    it("indexes documents and finds them by keyword", async () => {
      await searchStore.index([
        { id: "auth.ts", content: "authentication login handler", metadata: { repo: "r1" } },
        { id: "db.ts", content: "database connection pool", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("authentication");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("auth.ts");
    });

    it("returns results with positive scores (negated bm25)", async () => {
      await searchStore.index([
        { id: "a.ts", content: "important function handler", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("important");
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("respects limit parameter", async () => {
      await searchStore.index([
        { id: "a.ts", content: "module utility helper", metadata: { repo: "r1" } },
        { id: "b.ts", content: "module utility class", metadata: { repo: "r1" } },
        { id: "c.ts", content: "module utility function", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("module", 2);
      expect(results).toHaveLength(2);
    });

    it("filters by repo", async () => {
      await searchStore.index([
        { id: "a.ts", content: "shared module export", metadata: { repo: "r1" } },
        { id: "b.ts", content: "shared module import", metadata: { repo: "r2" } },
      ]);

      const results = await searchStore.search("shared", 10, "r1");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("a.ts");
    });

    it("returns empty for no matches", async () => {
      await searchStore.index([
        { id: "a.ts", content: "hello world", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("nonexistent");
      expect(results).toEqual([]);
    });

    it("handles empty query gracefully", async () => {
      await searchStore.index([
        { id: "a.ts", content: "test content", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("");
      expect(results).toEqual([]);
    });

    it("handles special characters in query (sanitization)", async () => {
      await searchStore.index([
        { id: "a.ts", content: "handle user input", metadata: { repo: "r1" } },
      ]);

      // FTS5 operators like AND, OR, NOT should not cause errors
      const results = await searchStore.search("handle (user) OR [input]");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("preserves metadata through index/search cycle", async () => {
      await searchStore.index([
        { id: "a.ts", content: "config parser", metadata: { repo: "r1", tier: "1" } },
      ]);

      const results = await searchStore.search("config");
      expect(results[0]!.metadata).toEqual({ repo: "r1", tier: "1" });
    });
  });

  describe("upsert behavior", () => {
    it("updates existing document on re-index", async () => {
      await searchStore.index([
        { id: "a.ts", content: "old content alpha", metadata: { repo: "r1" } },
      ]);

      await searchStore.index([
        { id: "a.ts", content: "new content beta", metadata: { repo: "r1" } },
      ]);

      const oldResults = await searchStore.search("alpha");
      expect(oldResults).toEqual([]);

      const newResults = await searchStore.search("beta");
      expect(newResults).toHaveLength(1);
      expect(newResults[0]!.id).toBe("a.ts");
    });
  });

  describe("delete", () => {
    it("removes documents by id", async () => {
      await searchStore.index([
        { id: "a.ts", content: "alpha function", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta function", metadata: { repo: "r1" } },
      ]);

      await searchStore.delete(["a.ts"]);

      const results = await searchStore.search("alpha");
      expect(results).toEqual([]);

      const remaining = await searchStore.search("beta");
      expect(remaining).toHaveLength(1);
    });

    it("handles empty delete array", async () => {
      await expect(searchStore.delete([])).resolves.toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all documents when no repo specified", async () => {
      await searchStore.index([
        { id: "a.ts", content: "alpha", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta", metadata: { repo: "r2" } },
      ]);

      await searchStore.clear();

      const results = await searchStore.search("alpha");
      expect(results).toEqual([]);
    });

    it("removes only documents for specified repo", async () => {
      await searchStore.index([
        { id: "a.ts", content: "alpha shared", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta shared", metadata: { repo: "r2" } },
      ]);

      await searchStore.clear("r1");

      const r1Results = await searchStore.search("alpha");
      expect(r1Results).toEqual([]);

      const r2Results = await searchStore.search("beta");
      expect(r2Results).toHaveLength(1);
    });
  });

  describe("index edge cases", () => {
    it("handles empty document array", async () => {
      await expect(searchStore.index([])).resolves.toBeUndefined();
    });

    it("handles bulk insert of many documents", async () => {
      const docs = Array.from({ length: 100 }, (_, i) => ({
        id: `file-${i}.ts`,
        content: `module ${i} with unique content token${i}`,
        metadata: { repo: "r1" },
      }));

      await searchStore.index(docs);

      const results = await searchStore.search("token50");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("file-50.ts");
    });
  });
});
