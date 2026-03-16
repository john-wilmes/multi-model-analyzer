/**
 * Tests for InMemoryGraphStore: addEdges, getEdgesFrom/To, getEdgesByKind,
 * traverseBFS, clear (full and per-repo), and close.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGraphStore } from "./graph.js";
import type { GraphEdge } from "@mma/core";

function edge(source: string, target: string, kind: string, repo?: string): GraphEdge {
  return {
    source,
    target,
    kind: kind as GraphEdge["kind"],
    ...(repo ? { metadata: { repo } } : {}),
  };
}

describe("InMemoryGraphStore", () => {
  let store: InMemoryGraphStore;

  beforeEach(() => {
    store = new InMemoryGraphStore();
  });

  describe("addEdges / getEdgesFrom / getEdgesTo", () => {
    it("stores and retrieves edges by source", async () => {
      await store.addEdges([edge("a.ts", "b.ts", "imports", "r1")]);

      const result = await store.getEdgesFrom("a.ts");
      expect(result).toHaveLength(1);
      expect(result[0]!.target).toBe("b.ts");
    });

    it("stores and retrieves edges by target", async () => {
      await store.addEdges([edge("a.ts", "b.ts", "imports")]);

      const result = await store.getEdgesTo("b.ts");
      expect(result).toHaveLength(1);
      expect(result[0]!.source).toBe("a.ts");
    });

    it("returns empty array for non-existent source", async () => {
      const result = await store.getEdgesFrom("nonexistent");
      expect(result).toEqual([]);
    });

    it("filters by repo when specified", async () => {
      await store.addEdges([
        edge("a.ts", "b.ts", "imports", "r1"),
        edge("a.ts", "c.ts", "imports", "r2"),
      ]);

      const r1Edges = await store.getEdgesFrom("a.ts", "r1");
      expect(r1Edges).toHaveLength(1);
      expect(r1Edges[0]!.target).toBe("b.ts");

      const r2Edges = await store.getEdgesTo("c.ts", "r2");
      expect(r2Edges).toHaveLength(1);
    });
  });

  describe("getEdgesByKind", () => {
    it("filters edges by kind", async () => {
      await store.addEdges([
        edge("a.ts", "b.ts", "imports"),
        edge("a.ts", "b.ts", "calls"),
        edge("c.ts", "d.ts", "imports"),
      ]);

      const imports = await store.getEdgesByKind("imports");
      expect(imports).toHaveLength(2);

      const calls = await store.getEdgesByKind("calls");
      expect(calls).toHaveLength(1);
    });

    it("filters by kind and repo", async () => {
      await store.addEdges([
        edge("a.ts", "b.ts", "imports", "r1"),
        edge("c.ts", "d.ts", "imports", "r2"),
      ]);

      const result = await store.getEdgesByKind("imports", "r1");
      expect(result).toHaveLength(1);
      expect(result[0]!.source).toBe("a.ts");
    });
  });

  describe("getEdgesByKind with limit", () => {
    it("returns all edges when no limit", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r1"),
      ]);

      const result = await store.getEdgesByKind("imports", undefined, {});
      expect(result).toHaveLength(3);
    });

    it("respects limit parameter", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r1"),
      ]);

      const result = await store.getEdgesByKind("imports", undefined, { limit: 2 });
      expect(result).toHaveLength(2);
    });

    it("combines repo filter with limit", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r2"),
      ]);

      const result = await store.getEdgesByKind("imports", "r1", { limit: 1 });
      expect(result).toHaveLength(1);
    });
  });

  describe("getEdgeCountsByKindAndRepo", () => {
    it("returns counts grouped by repo", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r2"),
        edge("g", "h", "calls", "r1"),
      ]);

      const counts = await store.getEdgeCountsByKindAndRepo("imports");
      expect(counts.get("r1")).toBe(2);
      expect(counts.get("r2")).toBe(1);
    });

    it("returns empty map when no edges of kind", async () => {
      await store.addEdges([edge("a", "b", "calls", "r1")]);
      const counts = await store.getEdgeCountsByKindAndRepo("imports");
      expect(counts.size).toBe(0);
    });

    it("uses 'unknown' for edges without repo metadata", async () => {
      await store.addEdges([{ source: "a", target: "b", kind: "imports" as any }]);
      const counts = await store.getEdgeCountsByKindAndRepo("imports");
      expect(counts.get("unknown")).toBe(1);
    });
  });

  describe("traverseBFS", () => {
    it("traverses a linear chain", async () => {
      await store.addEdges([
        edge("a", "b", "imports"),
        edge("b", "c", "imports"),
        edge("c", "d", "imports"),
      ]);

      const result = await store.traverseBFS("a", 3);
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).toContain("d");
    });

    it("respects maxDepth limit", async () => {
      await store.addEdges([
        edge("a", "b", "imports"),
        edge("b", "c", "imports"),
        edge("c", "d", "imports"),
        edge("d", "e", "imports"),
      ]);

      // maxDepth=1: visits start (depth 0) + one hop (depth 1)
      // Edges from depth 0 (a) and depth 1 (b) are returned
      const result = await store.traverseBFS("a", 1);
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).not.toContain("d");
      expect(targets).not.toContain("e");
    });

    it("handles cycles without infinite loop", async () => {
      await store.addEdges([
        edge("a", "b", "imports"),
        edge("b", "c", "imports"),
        edge("c", "a", "imports"),
      ]);

      const result = await store.traverseBFS("a", 10);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it("accepts TraversalOptions object", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("a", "c", "imports", "r2"),
        edge("b", "d", "imports", "r1"),
      ]);

      const result = await store.traverseBFS("a", { maxDepth: 3, repo: "r1" });
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("d");
      expect(targets).not.toContain("c");
    });

    it("returns empty array for isolated node", async () => {
      const result = await store.traverseBFS("isolated", 5);
      expect(result).toEqual([]);
    });
  });

  describe("clear", () => {
    it("clears all edges when no repo specified", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r2"),
      ]);

      await store.clear();

      const result = await store.getEdgesByKind("imports");
      expect(result).toEqual([]);
    });

    it("clears only edges for specified repo", async () => {
      await store.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r2"),
      ]);

      await store.clear("r1");

      const remaining = await store.getEdgesByKind("imports");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.metadata?.["repo"]).toBe("r2");
    });
  });

  describe("close", () => {
    it("empties all edges", async () => {
      await store.addEdges([edge("a", "b", "imports")]);
      await store.close();

      const result = await store.getEdgesFrom("a");
      expect(result).toEqual([]);
    });
  });

  describe("deleteEdgesForFiles", () => {
    it("deletes exact-path edges (imports)", async () => {
      await store.addEdges([
        edge("src/a.ts", "src/c.ts", "imports", "myrepo"),
        edge("src/b.ts", "src/c.ts", "imports", "myrepo"),
      ]);

      await store.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await store.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("src/b.ts");
    });

    it("deletes sub-symbol edges (calls via # prefix)", async () => {
      await store.addEdges([
        edge("src/a.ts#Foo.bar", "src/c.ts", "calls", "myrepo"),
        edge("src/a.ts#baz",    "src/d.ts", "calls", "myrepo"),
        edge("src/b.ts#Other",  "src/c.ts", "calls", "myrepo"),
      ]);

      await store.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await store.getEdgesByKind("calls", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("src/b.ts#Other");
    });

    it("does not delete edges from other repos", async () => {
      await store.addEdges([
        edge("src/a.ts", "src/c.ts", "imports", "repo-a"),
        edge("src/a.ts", "src/d.ts", "imports", "repo-b"),
      ]);

      await store.deleteEdgesForFiles("repo-a", ["src/a.ts"]);

      const repoBEdges = await store.getEdgesByKind("imports", "repo-b");
      expect(repoBEdges).toHaveLength(1);
      expect(repoBEdges[0]!.source).toBe("src/a.ts");
    });

    it("is a no-op for empty file list", async () => {
      await store.addEdges([
        edge("src/a.ts", "src/b.ts", "imports", "myrepo"),
      ]);

      await store.deleteEdgesForFiles("myrepo", []);

      const remaining = await store.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
    });

    it("does not delete edges where the file is the target, not the source", async () => {
      await store.addEdges([
        edge("src/other.ts", "src/a.ts", "imports", "myrepo"),
      ]);

      await store.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await store.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.target).toBe("src/a.ts");
    });

    it("handles multiple files in a single call", async () => {
      await store.addEdges([
        edge("src/a.ts", "src/c.ts", "imports", "myrepo"),
        edge("src/b.ts", "src/c.ts", "imports", "myrepo"),
        edge("src/keep.ts", "src/c.ts", "imports", "myrepo"),
      ]);

      await store.deleteEdgesForFiles("myrepo", ["src/a.ts", "src/b.ts"]);

      const remaining = await store.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("src/keep.ts");
    });
  });
});
