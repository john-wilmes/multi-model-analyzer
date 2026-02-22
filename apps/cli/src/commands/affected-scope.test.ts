import { describe, it, expect } from "vitest";
import { computeAffectedScope } from "./affected-scope.js";
import { InMemoryGraphStore } from "@mma/storage";
import type { ChangeSet, GraphEdge } from "@mma/core";

function makeChangeSet(repo: string, added: string[] = [], modified: string[] = []): ChangeSet {
  return {
    repo,
    commitHash: "abc123",
    previousCommitHash: "def456",
    addedFiles: added,
    modifiedFiles: modified,
    deletedFiles: [],
    timestamp: new Date(),
  };
}

function importEdge(source: string, target: string, repo = "test"): GraphEdge {
  return { source, target, kind: "imports", metadata: { repo } };
}

describe("computeAffectedScope", () => {
  it("includes transitive dependents in scope", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ]);

    const cs = makeChangeSet("test", [], ["c.ts"]);
    const scopes = await computeAffectedScope([cs], store);

    const scope = scopes.get("test")!;
    expect(scope.changedFiles).toEqual(["c.ts"]);
    expect(scope.affectedFiles).toContain("b.ts");
    expect(scope.affectedFiles).toContain("a.ts");
    expect(scope.allScopedFiles).toContain("c.ts");
    expect(scope.allScopedFiles).toContain("b.ts");
    expect(scope.allScopedFiles).toContain("a.ts");
  });

  it("returns empty scope for no changes", async () => {
    const store = new InMemoryGraphStore();
    const cs = makeChangeSet("test");
    const scopes = await computeAffectedScope([cs], store);

    const scope = scopes.get("test")!;
    expect(scope.changedFiles).toHaveLength(0);
    expect(scope.affectedFiles).toHaveLength(0);
    expect(scope.allScopedFiles).toHaveLength(0);
  });

  it("unions multiple changed files", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("dep-of-x.ts", "x.ts"),
      importEdge("dep-of-y.ts", "y.ts"),
    ]);

    const cs = makeChangeSet("test", ["x.ts"], ["y.ts"]);
    const scopes = await computeAffectedScope([cs], store);

    const scope = scopes.get("test")!;
    expect(scope.changedFiles).toEqual(["x.ts", "y.ts"]);
    expect(scope.affectedFiles).toContain("dep-of-x.ts");
    expect(scope.affectedFiles).toContain("dep-of-y.ts");
  });
});
