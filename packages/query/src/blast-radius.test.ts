import { describe, it, expect } from "vitest";
import { computeBlastRadius } from "./blast-radius.js";
import { InMemoryGraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";

function importEdge(source: string, target: string, repo = "test"): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo } };
}

function callEdge(source: string, target: string, repo = "test"): GraphEdge {
  return { source, target, kind: "calls", metadata: { repo } };
}

describe("computeBlastRadius", () => {
  it("finds direct dependents of a single file", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "target.ts"),
      importEdge("b.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store);

    expect(result.totalAffected).toBe(2);
    expect(result.affectedFiles.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.affectedFiles.every((f) => f.depth === 1)).toBe(true);
    expect(result.affectedFiles.every((f) => f.via === "imports")).toBe(true);
  });

  it("finds transitive chain (A -> B -> C, change C -> both A and B affected)", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ]);

    const result = await computeBlastRadius(["c.ts"], store);

    expect(result.totalAffected).toBe(2);
    const b = result.affectedFiles.find((f) => f.path === "b.ts")!;
    const a = result.affectedFiles.find((f) => f.path === "a.ts")!;
    expect(b.depth).toBe(1);
    expect(a.depth).toBe(2);
  });

  it("respects maxDepth limiting", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
      importEdge("c.ts", "d.ts"),
    ]);

    const result = await computeBlastRadius(["d.ts"], store, { maxDepth: 1 });

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("c.ts");
  });

  it("includes call graph edges when enabled", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      callEdge("caller.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store, { includeCallGraph: true });

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("caller.ts");
    expect(result.affectedFiles[0]!.via).toBe("calls");
  });

  it("marks 'both' when reached via imports AND calls", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("consumer.ts", "target.ts"),
      callEdge("consumer.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store, { includeCallGraph: true });

    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.via).toBe("both");
  });

  it("handles multiple changed files (union)", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "x.ts"),
      importEdge("b.ts", "y.ts"),
    ]);

    const result = await computeBlastRadius(["x.ts", "y.ts"], store);

    expect(result.totalAffected).toBe(2);
    expect(result.changedFiles.sort()).toEqual(["x.ts", "y.ts"]);
  });

  it("handles cycles without infinite loop", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "a.ts"),
    ]);

    const result = await computeBlastRadius(["a.ts"], store);

    // b.ts imports a.ts, so it's affected. a.ts imports b.ts but a.ts is the changed file.
    expect(result.totalAffected).toBe(1);
    expect(result.affectedFiles[0]!.path).toBe("b.ts");
  });

  it("returns empty result when no dependents exist", async () => {
    const store = new InMemoryGraphStore();
    // isolated.ts has no incoming edges
    await store.addEdges([importEdge("isolated.ts", "dep.ts")]);

    const result = await computeBlastRadius(["isolated.ts"], store);

    expect(result.totalAffected).toBe(0);
    expect(result.affectedFiles).toHaveLength(0);
  });

  it("excludes call graph when includeCallGraph is false", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      callEdge("caller.ts", "target.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store, { includeCallGraph: false });
    expect(result.totalAffected).toBe(0);
  });

  it("returns empty result for empty changed files list", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius([], store);
    expect(result.totalAffected).toBe(0);
    expect(result.changedFiles).toHaveLength(0);
    expect(result.affectedFiles).toHaveLength(0);
  });

  it("handles file with no graph edges (isolated)", async () => {
    const store = new InMemoryGraphStore();
    // No edges at all
    const result = await computeBlastRadius(["orphan.ts"], store);
    expect(result.totalAffected).toBe(0);
    expect(result.changedFiles).toEqual(["orphan.ts"]);
  });

  it("diamond dependency: affected files are not duplicated", async () => {
    // a -> b, a -> c, b -> d, c -> d. Change d → b, c at depth 1, a at depth 2
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("a.ts", "c.ts"),
      importEdge("b.ts", "d.ts"),
      importEdge("c.ts", "d.ts"),
    ]);

    const result = await computeBlastRadius(["d.ts"], store);
    expect(result.totalAffected).toBe(3);
    const paths = result.affectedFiles.map(f => f.path).sort();
    expect(paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("sorts affected files by depth then path", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("z.ts", "target.ts"),
      importEdge("a.ts", "target.ts"),
      importEdge("m.ts", "z.ts"),
    ]);

    const result = await computeBlastRadius(["target.ts"], store);
    // depth 1: a.ts, z.ts (alphabetical). depth 2: m.ts
    expect(result.affectedFiles.map(f => f.path)).toEqual(["a.ts", "z.ts", "m.ts"]);
  });

  it("description string reflects counts and maxDepth", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius(["b.ts"], store, { maxDepth: 3 });
    expect(result.description).toContain("1 files affected");
    expect(result.description).toContain("1 file(s)");
    expect(result.description).toContain("max depth 3");
  });

  it("maxDepth 0 means no traversal at all", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([importEdge("a.ts", "b.ts")]);

    const result = await computeBlastRadius(["b.ts"], store, { maxDepth: 0 });
    expect(result.totalAffected).toBe(0);
  });
});
