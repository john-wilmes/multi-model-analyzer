/**
 * Tests for KuzuSearchStore: FTS indexing, BM25 search, repo filtering,
 * query sanitization, deletion, and clear.
 *
 * Mirrors the contract verified by sqlite-search.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKuzuStores } from "./kuzu-common.js";
import type { SearchStore } from "@mma/storage";
import type { KuzuStores } from "./kuzu-common.js";

describe("KuzuSearchStore", () => {
  let stores: KuzuStores;
  let searchStore: SearchStore;

  beforeEach(() => {
    stores = createKuzuStores({ dbPath: ":memory:" });
    searchStore = stores.searchStore;
  });

  afterEach(() => {
    stores.close();
  });

  describe("index and search", () => {
    it("indexes documents and finds them by keyword", async () => {
      await searchStore.index([
        { id: "auth.ts", content: "authentication login handler", metadata: { repo: "r1" } },
        { id: "db.ts",   content: "database connection pool",    metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("authentication");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("auth.ts");
    });

    it("returns results with positive BM25 scores", async () => {
      await searchStore.index([
        { id: "a.ts", content: "important function handler", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("important");
      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it("respects the limit parameter", async () => {
      await searchStore.index([
        { id: "a.ts", content: "module utility helper",   metadata: { repo: "r1" } },
        { id: "b.ts", content: "module utility class",    metadata: { repo: "r1" } },
        { id: "c.ts", content: "module utility function", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("module", 2);
      expect(results).toHaveLength(2);
    });

    it("filters results by repo", async () => {
      await searchStore.index([
        { id: "a.ts", content: "shared module export", metadata: { repo: "r1" } },
        { id: "b.ts", content: "shared module import", metadata: { repo: "r2" } },
      ]);

      const results = await searchStore.search("shared", 10, "r1");
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("a.ts");
    });

    it("returns empty array when no documents match", async () => {
      await searchStore.index([
        { id: "a.ts", content: "hello world", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("nonexistent");
      expect(results).toEqual([]);
    });

    it("returns empty array for empty query", async () => {
      await searchStore.index([
        { id: "a.ts", content: "test content", metadata: { repo: "r1" } },
      ]);

      const results = await searchStore.search("");
      expect(results).toEqual([]);
    });

    it("handles special characters in query without throwing (sanitization)", async () => {
      await searchStore.index([
        { id: "a.ts", content: "handle user input", metadata: { repo: "r1" } },
      ]);

      // FTS operators and punctuation should be sanitized rather than cause an error
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

  describe("re-indexing (upsert behavior)", () => {
    it("updates existing document when re-indexed with same id", async () => {
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
    it("removes specified documents by id", async () => {
      await searchStore.index([
        { id: "a.ts", content: "alpha function", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta function",  metadata: { repo: "r1" } },
      ]);

      await searchStore.delete(["a.ts"]);

      const alphaResults = await searchStore.search("alpha");
      expect(alphaResults).toEqual([]);

      const betaResults = await searchStore.search("beta");
      expect(betaResults).toHaveLength(1);
    });

    it("is a no-op for ids that do not exist", async () => {
      await searchStore.index([
        { id: "a.ts", content: "stays here", metadata: { repo: "r1" } },
      ]);

      await expect(searchStore.delete(["nonexistent.ts"])).resolves.toBeUndefined();

      const results = await searchStore.search("stays");
      expect(results).toHaveLength(1);
    });

    it("handles empty delete array without error", async () => {
      await expect(searchStore.delete([])).resolves.toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all documents when no repo specified", async () => {
      await searchStore.index([
        { id: "a.ts", content: "alpha", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta",  metadata: { repo: "r2" } },
      ]);

      await searchStore.clear();

      expect(await searchStore.search("alpha")).toEqual([]);
      expect(await searchStore.search("beta")).toEqual([]);
    });

    it("removes only documents for the specified repo", async () => {
      await searchStore.index([
        { id: "a.ts", content: "alpha shared", metadata: { repo: "r1" } },
        { id: "b.ts", content: "beta shared",  metadata: { repo: "r2" } },
      ]);

      await searchStore.clear("r1");

      const r1Results = await searchStore.search("alpha");
      expect(r1Results).toEqual([]);

      const r2Results = await searchStore.search("beta");
      expect(r2Results).toHaveLength(1);
      expect(r2Results[0]!.id).toBe("b.ts");
    });

    it("is a no-op on an already-empty store", async () => {
      await expect(searchStore.clear()).resolves.toBeUndefined();
    });
  });

  describe("index edge cases", () => {
    it("handles empty document array without error", async () => {
      await expect(searchStore.index([])).resolves.toBeUndefined();
    });

    it("handles bulk insert of many documents", async () => {
      const docs = Array.from({ length: 50 }, (_, i) => ({
        id: `file-${i}.ts`,
        content: `module ${i} with unique content xyzfile${i}`,
        metadata: { repo: "r1" },
      }));

      await searchStore.index(docs);

      // All 50 documents share the word "module"; retrieve up to 50 and confirm all are present.
      const results = await searchStore.search("module", 50);
      expect(results.length).toBe(50);
      const ids = new Set(results.map((r) => r.id));
      expect(ids.has("file-0.ts")).toBe(true);
      expect(ids.has("file-25.ts")).toBe(true);
      expect(ids.has("file-49.ts")).toBe(true);
    });
  });
});
