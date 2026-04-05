import { describe, it, expect, vi } from "vitest";
import { InMemoryGraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";

// Mock git operations — computeAffected calls getChangedFilesInRange and parseRevisionRange
vi.mock("@mma/ingestion", () => ({
  getChangedFilesInRange: vi.fn(),
  parseRevisionRange: vi.fn((range: string) => {
    const [from, to] = range.split("..");
    return { from: from ?? "HEAD~1", to: to ?? "HEAD" };
  }),
}));

import { computeAffected } from "./affected-cmd.js";
import { getChangedFilesInRange } from "@mma/ingestion";

const mockGetChangedFiles = vi.mocked(getChangedFilesInRange);

function importEdge(source: string, target: string, repo = ""): GraphEdge {
  return { source, target, kind: "imports", repo, metadata: { repo } };
}

describe("computeAffected", () => {
  it("returns changed and affected files", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("consumer.ts", "changed.ts"),
      importEdge("indirect.ts", "consumer.ts"),
    ]);

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "HEAD~1", to: "HEAD",
      added: [],
      modified: ["changed.ts"],
      deleted: [],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "HEAD~1..HEAD",
      graphStore: store,
    });

    expect(result.changed.modified).toEqual(["changed.ts"]);
    expect(result.affected.map(f => f.path)).toContain("consumer.ts");
    expect(result.affected.map(f => f.path)).toContain("indirect.ts");
    expect(result.totalAffected).toBeGreaterThanOrEqual(2);
  });

  it("returns empty results when no files changed", async () => {
    const store = new InMemoryGraphStore();

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "HEAD~1", to: "HEAD",
      added: [],
      modified: [],
      deleted: [],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "HEAD~1..HEAD",
      graphStore: store,
    });

    expect(result.changed.added).toHaveLength(0);
    expect(result.changed.modified).toHaveLength(0);
    expect(result.changed.deleted).toHaveLength(0);
    expect(result.affected).toHaveLength(0);
    expect(result.totalAffected).toBe(0);
  });

  it("includes added files in changed output", async () => {
    const store = new InMemoryGraphStore();

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "main", to: "feature",
      added: ["new-file.ts"],
      modified: [],
      deleted: [],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "main..feature",
      graphStore: store,
    });

    expect(result.changed.added).toEqual(["new-file.ts"]);
    expect(result.range).toBe("main..feature");
  });

  it("uses deleted files as blast radius roots", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("consumer.ts", "deleted.ts"),
    ]);

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "HEAD~1", to: "HEAD",
      added: [],
      modified: [],
      deleted: ["deleted.ts"],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "HEAD~1..HEAD",
      graphStore: store,
    });

    // deleted.ts itself won't be in changedFiles (only added+modified)
    expect(result.changed.deleted).toEqual(["deleted.ts"]);
    // But consumer.ts should be affected
    expect(result.affected.map(f => f.path)).toContain("consumer.ts");
  });

  it("respects maxDepth option", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "c.ts"),
      importEdge("c.ts", "d.ts"),
    ]);

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "HEAD~1", to: "HEAD",
      added: [],
      modified: ["d.ts"],
      deleted: [],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "HEAD~1..HEAD",
      graphStore: store,
      maxDepth: 1,
    });

    // depth 1 from d.ts: only c.ts
    expect(result.affected.map(f => f.path)).toContain("c.ts");
    expect(result.affected.map(f => f.path)).not.toContain("a.ts");
  });

  it("computes highRisk from PageRank when edges exist", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "hub.ts"),
      importEdge("b.ts", "hub.ts"),
      importEdge("c.ts", "hub.ts"),
      importEdge("hub.ts", "changed.ts"),
    ]);

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "HEAD~1", to: "HEAD",
      added: [],
      modified: ["changed.ts"],
      deleted: [],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "HEAD~1..HEAD",
      graphStore: store,
    });

    expect(result.highRisk.length).toBeGreaterThan(0);
    // hub.ts should rank highly — many incoming edges
    const hubEntry = result.highRisk.find(f => f.path === "hub.ts");
    expect(hubEntry).toBeDefined();
  });

  it("filters by repo when specified", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      importEdge("a.ts", "b.ts", "repo-a"),
      importEdge("x.ts", "y.ts", "repo-b"),
    ]);

    mockGetChangedFiles.mockResolvedValueOnce({
      from: "HEAD~1", to: "HEAD",
      added: [],
      modified: ["b.ts"],
      deleted: [],
    });

    const result = await computeAffected({
      repoPath: "/tmp/repo",
      range: "HEAD~1..HEAD",
      graphStore: store,
      repo: "repo-a",
    });

    // Only repo-a edges should be in the blast radius
    expect(result.affected.map(f => f.path)).toContain("a.ts");
    expect(result.affected.map(f => f.path)).not.toContain("x.ts");
  });
});
