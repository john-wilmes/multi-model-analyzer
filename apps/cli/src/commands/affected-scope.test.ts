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
  return { source, target, kind: "imports", repo, metadata: { repo } };
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

  it("deduplicates allScopedFiles when a changed file is also affected", async () => {
    const store = new InMemoryGraphStore();
    // a.ts imports b.ts, b.ts imports c.ts
    // Change both b.ts and c.ts → b.ts appears as both changed and affected
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
    ]);

    const cs = makeChangeSet("test", [], ["b.ts", "c.ts"]);
    const scopes = await computeAffectedScope([cs], store);

    const scope = scopes.get("test")!;
    // b.ts is in changedFiles AND affected by c.ts change, but allScopedFiles should deduplicate
    const bCount = scope.allScopedFiles.filter(f => f === "b.ts").length;
    expect(bCount).toBe(1);
    expect(scope.allScopedFiles).toContain("a.ts");
  });

  it("handles multiple repos in separate changesets", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("dep.ts", "src.ts", "repo-a"),
    ]);

    const cs1 = makeChangeSet("repo-a", ["src.ts"]);
    const cs2 = makeChangeSet("repo-b", ["other.ts"]);
    const scopes = await computeAffectedScope([cs1, cs2], store);

    expect(scopes.size).toBe(2);
    expect(scopes.get("repo-a")).toBeDefined();
    expect(scopes.get("repo-b")).toBeDefined();
    expect(scopes.get("repo-b")!.affectedFiles).toHaveLength(0);
  });

  it("includes deleted files in blast radius roots", async () => {
    const store = new InMemoryGraphStore();
    // dep.ts imports deleted.ts
    await store.addEdges([
      importEdge("dep.ts", "deleted.ts"),
    ]);

    const cs: ChangeSet = {
      repo: "test",
      commitHash: "abc",
      previousCommitHash: "def",
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: ["deleted.ts"],
      timestamp: new Date(),
    };
    const scopes = await computeAffectedScope([cs], store);

    const scope = scopes.get("test")!;
    // deleted.ts is not in changedFiles (only added+modified go there)
    expect(scope.changedFiles).toHaveLength(0);
    // But dep.ts should be affected since it imports deleted.ts
    expect(scope.affectedFiles).toContain("dep.ts");
    // allScopedFiles should include the affected file
    expect(scope.allScopedFiles).toContain("dep.ts");
  });

  it("respects maxBlastDepth option", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
      importEdge("c.ts", "d.ts"),
    ]);

    const cs = makeChangeSet("test", [], ["d.ts"]);
    const scopes = await computeAffectedScope([cs], store, { maxBlastDepth: 1 });

    const scope = scopes.get("test")!;
    // depth 1 from d.ts: only c.ts
    expect(scope.affectedFiles).toContain("c.ts");
    expect(scope.affectedFiles).not.toContain("a.ts");
  });

  it("repo field is set correctly on scope output", async () => {
    const store = new InMemoryGraphStore();
    const cs = makeChangeSet("my-repo", ["file.ts"]);
    const scopes = await computeAffectedScope([cs], store);

    expect(scopes.get("my-repo")!.repo).toBe("my-repo");
  });

  it("handles empty changeset list", async () => {
    const store = new InMemoryGraphStore();
    const scopes = await computeAffectedScope([], store);
    expect(scopes.size).toBe(0);
  });
});
