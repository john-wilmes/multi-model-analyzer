/**
 * Tests for KuzuGraphStore: bulk inserts, queries by source/target/kind,
 * BFS traversal, repo filtering, edge deduplication, and clear.
 *
 * Mirrors the contract verified by sqlite-graph.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createKuzuStores } from "./kuzu-common.js";
import type { GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import type { KuzuStores } from "./kuzu-common.js";

function edge(source: string, target: string, kind: string, repo?: string): GraphEdge {
  return {
    source,
    target,
    kind: kind as GraphEdge["kind"],
    ...(repo ? { metadata: { repo } } : {}),
  };
}

const FIXTURE_EDGES: GraphEdge[] = [
  { source: "a", target: "b", kind: "imports", metadata: { repo: "r1" } },
  { source: "b", target: "c", kind: "calls",   metadata: { repo: "r1" } },
  { source: "a", target: "c", kind: "imports", metadata: { repo: "r1" } },
  { source: "x", target: "y", kind: "imports", metadata: { repo: "r2" } },
];

describe("KuzuGraphStore", () => {
  let stores: KuzuStores;
  let graphStore: GraphStore;

  beforeEach(() => {
    stores = createKuzuStores({ dbPath: ":memory:" });
    graphStore = stores.graphStore;
  });

  afterEach(() => {
    stores.close();
  });

  describe("addEdges", () => {
    it("inserts edges and they are queryable", async () => {
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
      // metadata may be undefined or an empty object depending on implementation
      const meta = result[0]!.metadata;
      expect(meta === undefined || Object.keys(meta).length === 0).toBe(true);
    });
  });

  describe("getEdgesFrom", () => {
    it("returns all edges from a source across repos", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);

      const result = await graphStore.getEdgesFrom("a");
      expect(result).toHaveLength(2);
      const targets = result.map((e) => e.target).sort();
      expect(targets).toEqual(["b", "c"]);
    });

    it("filters by repo", async () => {
      await graphStore.addEdges([
        edge("a.ts", "b.ts", "imports", "r1"),
        edge("a.ts", "c.ts", "imports", "r2"),
      ]);

      const r1Only = await graphStore.getEdgesFrom("a.ts", "r1");
      expect(r1Only).toHaveLength(1);
      expect(r1Only[0]!.target).toBe("b.ts");
    });

    it("returns empty array for non-existent source", async () => {
      const result = await graphStore.getEdgesFrom("ghost.ts");
      expect(result).toEqual([]);
    });
  });

  describe("getEdgesTo", () => {
    it("returns all edges pointing at a target", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);

      const result = await graphStore.getEdgesTo("c");
      expect(result).toHaveLength(2);
      const sources = result.map((e) => e.source).sort();
      expect(sources).toEqual(["a", "b"]);
    });

    it("filters by repo", async () => {
      await graphStore.addEdges([
        edge("x.ts", "shared.ts", "imports", "r1"),
        edge("y.ts", "shared.ts", "imports", "r2"),
      ]);

      const r2Only = await graphStore.getEdgesTo("shared.ts", "r2");
      expect(r2Only).toHaveLength(1);
      expect(r2Only[0]!.source).toBe("y.ts");
    });

    it("returns empty array for non-existent target", async () => {
      const result = await graphStore.getEdgesTo("nobody.ts");
      expect(result).toEqual([]);
    });
  });

  describe("getEdgesByKind", () => {
    it("filters by edge kind across all repos", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);

      const imports = await graphStore.getEdgesByKind("imports");
      expect(imports).toHaveLength(3);

      const calls = await graphStore.getEdgesByKind("calls");
      expect(calls).toHaveLength(1);
    });

    it("filters by kind and repo", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);

      const result = await graphStore.getEdgesByKind("imports", "r1");
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.metadata?.["repo"] === "r1")).toBe(true);
    });

    it("returns empty array for non-existent kind", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);
      const result = await graphStore.getEdgesByKind("extends");
      expect(result).toEqual([]);
    });

    it("respects limit option", async () => {
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
      expect(result[0]!.metadata?.["repo"]).toBe("r1");
    });
  });

  describe("getEdgeCountsByKindAndRepo", () => {
    it("returns counts grouped by repo", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
        edge("e", "f", "imports", "r2"),
        edge("g", "h", "calls",   "r1"),
      ]);

      const counts = await graphStore.getEdgeCountsByKindAndRepo("imports");
      expect(counts.get("r1")).toBe(2);
      expect(counts.get("r2")).toBe(1);
    });

    it("does not include other kinds in the count", async () => {
      await graphStore.addEdges([
        edge("a", "b", "calls",   "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const callCounts = await graphStore.getEdgeCountsByKindAndRepo("calls");
      expect(callCounts.get("r1")).toBe(1);
      // "imports" edges should not appear in the calls count
      expect(callCounts.size).toBe(1);
    });

    it("returns empty map for non-existent kind", async () => {
      await graphStore.addEdges([edge("a", "b", "calls", "r1")]);
      const counts = await graphStore.getEdgeCountsByKindAndRepo("imports");
      expect(counts.size).toBe(0);
    });
  });

  describe("traverseBFS", () => {
    it("traverses a linear chain at depth 1 (one hop)", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 1);
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).not.toContain("c");
      expect(targets).not.toContain("d");
    });

    it("traverses a linear chain at depth 2 (two hops)", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 2);
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).not.toContain("d");
    });

    it("traverses full chain when depth is sufficient", async () => {
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

    it("filters by repo using TraversalOptions", async () => {
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

    it("deduplicates edges when the same edge is reachable from multiple paths (diamond)", async () => {
      // Diamond: a->b, a->c, b->d, c->d
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("a", "c", "imports", "r1"),
        edge("b", "d", "imports", "r1"),
        edge("c", "d", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 3);
      const bdEdges = result.filter((e) => e.source === "b" && e.target === "d");
      expect(bdEdges).toHaveLength(1);
      const cdEdges = result.filter((e) => e.source === "c" && e.target === "d");
      expect(cdEdges).toHaveLength(1);
    });

    it("handles cycles without infinite looping", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("c", "a", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 10);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.length).toBeLessThanOrEqual(4);
    });

    it("returns empty array for isolated node", async () => {
      const result = await graphStore.traverseBFS("nobody", 5);
      expect(result).toEqual([]);
    });

    it("returns empty array when maxDepth is 0", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 0);
      expect(result).toEqual([]);
    });

    it("traverses multi-repo graph with repo filter on deeper paths", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "imports", "r1"),
        edge("b", "d", "imports", "r2"),
        edge("c", "e", "imports", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", { maxDepth: 5, repo: "r1" });
      const targets = result.map((e) => e.target);
      expect(targets).toContain("b");
      expect(targets).toContain("c");
      expect(targets).toContain("e");
      expect(targets).not.toContain("d");
    });
  });

  describe("hyphenated edge kinds", () => {
    it("round-trips hyphenated edge kinds (depends-on, service-call)", async () => {
      await graphStore.addEdges([
        edge("a", "b", "depends-on", "r1"),
        edge("c", "d", "service-call", "r1"),
      ]);

      const depEdges = await graphStore.getEdgesByKind("depends-on");
      expect(depEdges).toHaveLength(1);
      expect(depEdges[0]!.kind).toBe("depends-on");

      const svcEdges = await graphStore.getEdgesByKind("service-call");
      expect(svcEdges).toHaveLength(1);
      expect(svcEdges[0]!.kind).toBe("service-call");

      // Also verify cross-kind queries return correct kinds
      const fromA = await graphStore.getEdgesFrom("a");
      expect(fromA).toHaveLength(1);
      expect(fromA[0]!.kind).toBe("depends-on");
    });
  });

  describe("BFS mixed kinds", () => {
    it("traverses edges of mixed kinds", async () => {
      await graphStore.addEdges([
        edge("a", "b", "imports", "r1"),
        edge("b", "c", "calls", "r1"),
        edge("c", "d", "extends", "r1"),
      ]);

      const result = await graphStore.traverseBFS("a", 3);
      expect(result).toHaveLength(3);
      const kinds = result.map((e) => e.kind).sort();
      expect(kinds).toEqual(["calls", "extends", "imports"]);
    });
  });

  describe("clear", () => {
    it("removes all edges", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);
      await graphStore.clear();

      const result = await graphStore.getEdgesByKind("imports");
      expect(result).toEqual([]);
    });

    it("removes only edges for the specified repo", async () => {
      await graphStore.addEdges(FIXTURE_EDGES);
      await graphStore.clear("r1");

      const remaining = await graphStore.getEdgesByKind("imports");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.metadata?.["repo"]).toBe("r2");
    });

    it("is a no-op on an empty store", async () => {
      await expect(graphStore.clear()).resolves.toBeUndefined();
    });

    it("clears by repo that has no edges without error", async () => {
      await graphStore.addEdges([edge("a", "b", "imports", "r1")]);
      await expect(graphStore.clear("nonexistent-repo")).resolves.toBeUndefined();

      // r1 edges must still be present
      const result = await graphStore.getEdgesByKind("imports", "r1");
      expect(result).toHaveLength(1);
    });
  });

  describe("deleteEdgesForFiles", () => {
    it("deletes exact-path edges (imports)", async () => {
      await graphStore.addEdges([
        edge("src/a.ts", "src/c.ts", "imports", "myrepo"),
        edge("src/b.ts", "src/c.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("src/b.ts");
    });

    it("deletes sub-symbol edges (calls via # prefix)", async () => {
      await graphStore.addEdges([
        edge("src/a.ts#Foo.bar", "src/c.ts", "calls", "myrepo"),
        edge("src/a.ts#baz",    "src/d.ts", "calls", "myrepo"),
        edge("src/b.ts#Other",  "src/c.ts", "calls", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await graphStore.getEdgesByKind("calls", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("src/b.ts#Other");
    });

    it("does not delete edges from other repos", async () => {
      await graphStore.addEdges([
        edge("src/a.ts", "src/c.ts", "imports", "repo-a"),
        edge("src/a.ts", "src/d.ts", "imports", "repo-b"),
      ]);

      await graphStore.deleteEdgesForFiles("repo-a", ["src/a.ts"]);

      const repoBEdges = await graphStore.getEdgesByKind("imports", "repo-b");
      expect(repoBEdges).toHaveLength(1);
      expect(repoBEdges[0]!.source).toBe("src/a.ts");
    });

    it("is a no-op for empty file list", async () => {
      await graphStore.addEdges([
        edge("src/a.ts", "src/b.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", []);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
    });

    it("does not delete edges where the file is the target, not the source", async () => {
      await graphStore.addEdges([
        edge("src/other.ts", "src/a.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts"]);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.target).toBe("src/a.ts");
    });

    it("handles multiple files in a single call", async () => {
      await graphStore.addEdges([
        edge("src/a.ts", "src/c.ts", "imports", "myrepo"),
        edge("src/b.ts", "src/c.ts", "imports", "myrepo"),
        edge("src/keep.ts", "src/c.ts", "imports", "myrepo"),
      ]);

      await graphStore.deleteEdgesForFiles("myrepo", ["src/a.ts", "src/b.ts"]);

      const remaining = await graphStore.getEdgesByKind("imports", "myrepo");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source).toBe("src/keep.ts");
    });
  });
});
