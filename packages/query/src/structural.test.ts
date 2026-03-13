import { describe, it, expect, beforeEach } from "vitest";
import { executeCallersQuery, executeCalleesQuery, executeDependencyQuery } from "./structural.js";
import { InMemoryGraphStore, InMemorySearchStore } from "@mma/storage";
import type { GraphStore, SearchStore } from "@mma/storage";

describe("structural queries", () => {
  let graphStore: GraphStore;
  let searchStore: SearchStore;

  beforeEach(async () => {
    graphStore = new InMemoryGraphStore();
    searchStore = new InMemorySearchStore();

    await graphStore.addEdges([
      { source: "src/user.service.ts#UserService", target: "src/db.ts#Database", kind: "calls", metadata: { repo: "myrepo" } },
      { source: "src/auth.ts#AuthHandler", target: "src/user.service.ts#UserService", kind: "calls", metadata: { repo: "myrepo" } },
    ]);

    await searchStore.index([
      { id: "src/user.service.ts#UserService", content: "src/user.service.ts#UserService handles user CRUD operations", metadata: { repo: "myrepo" } },
      { id: "src/db.ts#Database", content: "src/db.ts#Database manages database connections", metadata: { repo: "myrepo" } },
    ]);
  });

  describe("executeCallersQuery", () => {
    it("returns edges for exact FQN match without fallback", async () => {
      const result = await executeCallersQuery("src/user.service.ts#UserService", graphStore);
      expect(result.edges).toHaveLength(1);
      expect(result.nodes).toContain("src/auth.ts#AuthHandler");
      expect(result.description).not.toContain("resolved from");
    });

    it("resolves short name via BM25 fallback", async () => {
      const result = await executeCallersQuery("UserService", graphStore, undefined, searchStore);
      expect(result.edges).toHaveLength(1);
      expect(result.nodes).toContain("src/auth.ts#AuthHandler");
      expect(result.description).toContain("resolved from");
    });

    it("resolves via file path when FQN has no edges but file does", async () => {
      // Simulate import edges targeting file paths (not FQN with #symbol)
      await graphStore.addEdges([
        { source: "src/app.ts", target: "src/user.service.ts", kind: "imports", metadata: { repo: "myrepo" } },
      ]);
      // Search still returns the FQN with #symbol
      const result = await executeCallersQuery("UserService", graphStore, undefined, searchStore);
      // Should find edges via the file path fallback (src/user.service.ts)
      expect(result.edges.length).toBeGreaterThanOrEqual(1);
      expect(result.description).toContain("resolved from");
    });

    it("returns helpful hint when no match in graph or search", async () => {
      const result = await executeCallersQuery("NonExistent", graphStore, undefined, searchStore);
      expect(result.edges).toHaveLength(0);
      expect(result.description).toContain("No matches found");
      expect(result.description).toContain("fully qualified name");
    });

    it("returns helpful hint when no searchStore provided and no match", async () => {
      const result = await executeCallersQuery("UserService", graphStore);
      expect(result.edges).toHaveLength(0);
      expect(result.description).toContain("No matches found");
    });
  });

  describe("executeCalleesQuery", () => {
    it("returns edges for exact FQN match", async () => {
      const result = await executeCalleesQuery("src/user.service.ts#UserService", graphStore);
      expect(result.edges).toHaveLength(1);
      expect(result.nodes).toContain("src/db.ts#Database");
    });

    it("resolves short name via BM25 fallback", async () => {
      const result = await executeCalleesQuery("UserService", graphStore, undefined, searchStore);
      expect(result.edges).toHaveLength(1);
      expect(result.nodes).toContain("src/db.ts#Database");
      expect(result.description).toContain("resolved from");
    });
  });

  describe("executeDependencyQuery", () => {
    it("returns dependency tree for exact match", async () => {
      const result = await executeDependencyQuery("src/user.service.ts#UserService", graphStore);
      expect(result.edges.length).toBeGreaterThan(0);
      expect(result.nodes).toContain("src/db.ts#Database");
    });

    it("resolves short name via BM25 fallback", async () => {
      const result = await executeDependencyQuery("UserService", graphStore, 3, searchStore);
      expect(result.edges.length).toBeGreaterThan(0);
      expect(result.description).toContain("resolved from");
    });

    it("returns helpful hint when no match found", async () => {
      const result = await executeDependencyQuery("NonExistent", graphStore, 3, searchStore);
      expect(result.edges).toHaveLength(0);
      expect(result.description).toContain("No matches found");
    });
  });
});
