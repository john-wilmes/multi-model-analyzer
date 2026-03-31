/**
 * Tests for SqliteGraphStore: bulk inserts, queries by source/target/kind,
 * BFS traversal with recursive CTE, repo filtering, and clear.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSqliteStores } from "./sqlite-common.js";
import type { GraphStore } from "./graph.js";
import type { GraphEdge } from "@mma/core";

function edge(source: string, target: string, kind: string, repo?: string): GraphEdge {
  return {
    source,
    target,
    kind: kind as GraphEdge["kind"],
    ...(repo ? { metadata: { repo } } : {}),
  };
}

describe("SqliteGraphStore", () => {
  let graphStore: GraphStore;
  let cleanup: () => void;

  beforeEach(() => {
    const stores = createSqliteStores({ dbPath: ":memory:" });
    graphStore = stores.graphStore;
    cleanup = () => stores.close();
  });

  afterEach(() => {
    cleanup();
  });

  describe("addEdges", () => {
    it("inserts edges in a transaction", async () => {
      await graphStore.addEdges([
        edge("a.ts", "b.ts", "imports", "r1"),
        edge("b.ts", "c.ts", "imports", "r1"),
      ]);

      const result = await graphStore.getEdgesFrom("a.ts");
      expect(result).toHaveLength(1);
      expect(result[0]!.target).toBe("b.ts");
    });

    it("handles empty array without error", async () => {
      await expect(graphStore.addEdges([])).resolves.toBeUndefined();
    });

    it("preserves metadata through insert/query cycle", async () => {
      await graphStore.addEdges([{
        source: "a.ts",
        target: "b.ts",
        kind: "imports",
        metadata: { repo: "myrepo", weight: 42 },
      }]);

      const result = await graphStore.getEdgesFrom("a.ts");
      expect(result[0]!.metadata).toEqual({ repo: "myrepo", weight: 42 });
    });

    it("handles edges without metadata", async () => {
      await graphStore.addEdges([{
        source: "a.ts",
        target: "b.ts",
        kind: "imports",
      }]);

      const result = await graphStore.getEdgesFrom("a.ts");
      expect(result).toHaveLength(1);
      expect(result[0]!.metadata).toBeUndefined();
    });

    it("propagates top-level repo into metadata so repo-filtered queries find it", async () => {
      // Edge has repo set at top level but no metadata.repo — repo-filtered
      // queries use json_extract(metadata, '$.repo') so without propagation
      // they silently miss this edge.
      await graphStore.addEdges([{
        source: "x.ts",
        target: "y.ts",
        kind: "imports",
        repo: "my-repo",
      }]);

      const byRepo = await graphStore.getEdgesFrom("x.ts", "my-repo");
      expect(byRepo).toHaveLength(1);
      expect(byRepo[0]!.target).toBe("y.ts");

      const byKindAndRepo = await graphStore.getEdgesByKind("imports", "my-repo");
      expect(byKindAndRepo).toHaveLength(1);
    });
  });

  describe("getEdgesFrom / getEdgesTo", () => {
    it("queries edges by source with repo filter", async () => {
      await graphStore.addEdges([
        edge("a.ts", "b.ts", "imports", "r1"),
        edge("a.ts", "c.ts", "imports", "r2"),
      ]);

      const r1Only = await graphStore.getEdgesFrom("a.ts", "r1");
      expect(r1Only).toHaveLength(1);
      expect(r1Only[0]!.target).toBe("b.ts");
    });

    it("queries edges by target with repo filter", async () => {
      await graphStore.addEdges([
        edge("x.ts", "shared.ts", "imports", "r1"),
        edge("y.ts", "shared.ts", "imports", "r2"),
      ]);

      const r2Only = await graphStore.getEdgesTo("shared.ts", "r2");
      expect(r2Only).toHaveLength(1);
      expect(r2Only[0]!.source).toBe("y.ts");
    });

    it("returns empty for non-existent source", async () => {
      const result = await graphStore.getEdgesFrom("ghost.ts");
      expect(result).toEqual([]);
    });
  });

  describe("getEdgesByKind", () => {
    it("filters by edge kind", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("a", "b", "calls", "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const imports = await graphStore.getEdgesByKind("imports");
      expect(imports).toHaveLength(2);

      const calls = await graphStore.getEdgesByKind("calls");
      expect(calls).toHaveLength(1);
    });

    it("filters by kind and repo", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r2"),
      ]);

      const result = await graphStore.getEdgesByKind("imports", "r1");
      expect(result).toHaveLength(1);
      expect(result[0]!.source).toBe("a");
    });
  });

  describe("getEdgesByKind with limit", () => {
    it("respects limit parameter", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r1"),
      ]);

      const result = await graphStore.getEdgesByKind("imports", undefined, { limit: 2 });
      expect(result).toHaveLength(2);
    });

    it("combines repo filter with limit", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r2"),
      ]);

      const result = await graphStore.getEdgesByKind("imports", "r1", { limit: 1 });
      expect(result).toHaveLength(1);
    });
  });

  describe("getEdgeCountsByKindAndRepo", () => {
    it("returns counts grouped by repo via SQL aggregation", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r2"),
        edge("g", "h", "calls", "r1"),
      ]);

      const counts = await graphStore.getEdgeCountsByKindAndRepo("imports");
      expect(counts.get("r1")).toBe(2);
      expect(counts.get("r2")).toBe(1);
      // calls should not be counted
      expect(counts.has("r1")).toBe(true);
    });

    it("returns empty map for non-existent kind", async () => {
      await graphStore.addEdges([edge("a", "b", "calls", "r1")]);
      const counts = await graphStore.getEdgeCountsByKindAndRepo("imports");
      expect(counts.size).toBe(0);
    });
  });

  describe("traverseBFS", () => {
    it("traverses a linear chain via recursive CTE", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 3);
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).toContain("d");
    });

    it("respects maxDepth limit", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("d", "e", "imports", "r1"),
      ]);

      // maxDepth=1: visits start (depth 0) + one hop (depth 1)
      const result = await graphStore.traverseBFS("a", 1);
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).not.toContain("d");
      expect(targets).not.toContain("e");
    });

    it("handles cycles without infinite recursion", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("c", "a", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 10);
      // CTE UNION deduplicates (node, depth) pairs; should not explode
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.length).toBeLessThanOrEqual(4);
    });

    it("filters by repo with TraversalOptions", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("a", "c", "imports", "r2"),
        edge("b", "d", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", { maxDepth: 5, repo: "r1" });
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("d");
      expect(targets).not.toContain("c");
    });

    it("deduplicates edges from multiple depth paths", async () => {
      // Diamond: a->b, a->c, b->d, c->d
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("a", "c", "imports", "r1"),
        edge("b", "d", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 3);
      // b->d and c->d should each appear once
      const bdEdges = result.filter((e) => e.source === "b" && e.target === "d");
      expect(bdEdges).toHaveLength(1);
      const cdEdges = result.filter((e) => e.source === "c" && e.target === "d");
      expect(cdEdges).toHaveLength(1);
    });

    it("returns empty for isolated node", async () => {
      const result = await graphStore.traverseBFS("nobody", 5);
      expect(result).toEqual([]);
    });
  });

  describe("clear", () => {
    it("removes all edges", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r2"),
      ]);

      await graphStore.clear();

      const result = await graphStore.getEdgesByKind("imports");
      expect(result).toEqual([]);
    });

    it("removes only edges for the specified repo", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r2"),
      ]);

      await graphStore.clear("r1");

      const remaining = await graphStore.getEdgesByKind("imports");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.metadata?.["repo"]).toBe("r2");
    });
  });

  describe("deleteEdgesForFiles", () => {
    it("deletes exact-path edges (imports)", async () => {
      await graphStore.addEdges([
        edge("myrepo:src/a.ts", "myrepo:src/c.ts", "imports", "myrepo"),
        edge("myrepo:src/b.ts", "myrepo:src/c.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("myrepo:src/b.ts");
    });

    it("deletes sub-symbol edges (calls via # prefix)", async () => {
      await graphStore.addEdges([
        edge("myrepo:src/a.ts#Foo.bar", "myrepo:src/c.ts", "calls", "myrepo"),
        edge("myrepo:src/a.ts#baz",     "myrepo:src/d.ts", "calls", "myrepo"),
        edge("myrepo:src/b.ts#Other",   "myrepo:src/c.ts", "calls", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await graphStore.getEdgesByKind("calls", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("myrepo:src/b.ts#Other");
    });

    it("does not delete edges from other repos", async () => {
      await graphStore.addEdges([
        edge("repo-a:src/a.ts", "repo-a:src/c.ts", "imports", "repo-a"),
        edge("repo-b:src/a.ts", "repo-b:src/d.ts", "imports", "repo-b"),
      ]);

      await graphStore.deleteEdgesForFiles("repo-a", ["src/a.ts"]);

      const repoBEdges = await graphStore.getEdgesByKind("imports", "repo-b");
      expect(repoBEdges).toHaveLength(1);
      expect(repoBEdges[0]!.source).toBe("repo-b:src/a.ts");
    });

    it("is a no-op for empty file list", async () => {
      await graphStore.addEdges([
        edge("myrepo:src/a.ts", "myrepo:src/b.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", []);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
    });

    it("also deletes edges where the deleted file is the target (stale inbound refs)", async () => {
      await graphStore.addEdges([
        edge("myrepo:src/other.ts", "myrepo:src/a.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      // Inbound edges to a deleted file are stale and must be removed
      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(0);
    });

    it("handles multiple files in a single call", async () => {
      await graphStore.addEdges([
        edge("myrepo:src/a.ts",    "myrepo:src/c.ts", "imports", "myrepo"),
        edge("myrepo:src/b.ts",    "myrepo:src/c.ts", "imports", "myrepo"),
        edge("myrepo:src/keep.ts", "myrepo:src/c.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts", "src/b.ts"]);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("myrepo:src/keep.ts");
    });
  });
});
