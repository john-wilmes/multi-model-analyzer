import { describe, it, expect } from "vitest";
import { findCrossRepoDependencies, executeMultiRepoQuery } from "./multi-repo.js";
import { routeQuery } from "./router.js";
import type { GraphEdge } from "@mma/core";
import { InMemoryGraphStore } from "@mma/storage";
import { InMemorySearchStore } from "@mma/storage";

function edge(source: string, target: string, kind: GraphEdge["kind"], repo: string, targetRepo?: string): GraphEdge {
  const metadata: Record<string, unknown> = { repo };
  if (targetRepo) metadata.targetRepo = targetRepo;
  return { source, target, kind, metadata };
}

describe("findCrossRepoDependencies", () => {
  it("finds edges that cross repo boundaries via metadata", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      edge("src/app.ts", "@novu/shared/utils", "imports", "novu-api", "novu-libs"),
      edge("src/api.ts", "@novu/shared/types", "imports", "novu-api", "novu-libs"),
      edge("src/svc.ts", "src/helper.ts", "imports", "novu-api"), // intra-repo
    ]);

    const result = await findCrossRepoDependencies(store);

    expect(result.totalCrossRepoEdges).toBe(2);
    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.sourceRepo).toBe("novu-api");
    expect(result.dependencies[0]!.targetRepo).toBe("novu-libs");
  });

  it("filters by sourceRepo", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      edge("src/a.ts", "@lib/core", "imports", "repo-a", "repo-lib"),
      edge("src/b.ts", "@lib/core", "imports", "repo-b", "repo-lib"),
    ]);

    const result = await findCrossRepoDependencies(store, { sourceRepo: "repo-a" });

    expect(result.totalCrossRepoEdges).toBe(1);
    expect(result.dependencies[0]!.sourceRepo).toBe("repo-a");
  });

  it("filters by targetRepo", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      edge("src/a.ts", "@lib/core", "imports", "repo-a", "repo-lib"),
      edge("src/a.ts", "@other/pkg", "imports", "repo-a", "repo-other"),
    ]);

    const result = await findCrossRepoDependencies(store, { targetRepo: "repo-lib" });

    expect(result.totalCrossRepoEdges).toBe(1);
    expect(result.dependencies[0]!.targetRepo).toBe("repo-lib");
  });

  it("returns empty when no cross-repo edges exist", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      edge("src/a.ts", "src/b.ts", "imports", "repo-a"),
    ]);

    const result = await findCrossRepoDependencies(store);

    expect(result.totalCrossRepoEdges).toBe(0);
    expect(result.dependencies).toHaveLength(0);
  });

  it("infers target repo from node_modules path", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      edge("src/app.ts", "node_modules/@novu/shared/dist/index.js", "imports", "novu-api"),
    ]);

    const result = await findCrossRepoDependencies(store);

    expect(result.totalCrossRepoEdges).toBe(1);
    expect(result.dependencies[0]!.targetRepo).toBe("@novu/shared");
  });

  it("sorts dependencies by count descending", async () => {
    const store = new InMemoryGraphStore();
    await store.addEdges([
      edge("src/a.ts", "@lib/core", "imports", "repo-a", "repo-lib"),
      edge("src/b.ts", "@other/x", "imports", "repo-a", "repo-other"),
      edge("src/c.ts", "@other/y", "imports", "repo-a", "repo-other"),
      edge("src/d.ts", "@other/z", "imports", "repo-a", "repo-other"),
    ]);

    const result = await findCrossRepoDependencies(store);

    expect(result.dependencies[0]!.targetRepo).toBe("repo-other");
    expect(result.dependencies[0]!.count).toBe(3);
    expect(result.dependencies[1]!.targetRepo).toBe("repo-lib");
    expect(result.dependencies[1]!.count).toBe(1);
  });
});

describe("executeMultiRepoQuery", () => {
  it("dispatches callers query across multiple repos", async () => {
    const graphStore = new InMemoryGraphStore();
    const searchStore = new InMemorySearchStore();
    await graphStore.addEdges([
      edge("src/a.ts#foo", "src/b.ts#UserService", "calls", "repo-a"),
      edge("src/x.ts#bar", "src/y.ts#UserService", "calls", "repo-b"),
    ]);

    const result = await executeMultiRepoQuery(
      "callers", "UserService", ["repo-a", "repo-b"], graphStore, searchStore,
    );

    expect(result.perRepo.size).toBe(2);
    expect(result.mergedDescription).toContain("repo-a");
    expect(result.mergedDescription).toContain("repo-b");
  });

  it("dispatches search query across multiple repos", async () => {
    const graphStore = new InMemoryGraphStore();
    const searchStore = new InMemorySearchStore();
    await searchStore.index([
      { id: "a#Foo", content: "authentication handler", metadata: { repo: "repo-a" } },
      { id: "b#Bar", content: "authentication service", metadata: { repo: "repo-b" } },
      { id: "c#Baz", content: "unrelated module", metadata: { repo: "repo-c" } },
    ]);

    const result = await executeMultiRepoQuery(
      "search", "authentication", ["repo-a", "repo-b"], graphStore, searchStore,
    );

    expect(result.perRepo.size).toBe(2);
    const repoA = result.perRepo.get("repo-a") as { returnedCount: number };
    const repoB = result.perRepo.get("repo-b") as { returnedCount: number };
    expect(repoA.returnedCount).toBe(1);
    expect(repoB.returnedCount).toBe(1);
  });
});

describe("routeQuery — multi-repo prefix", () => {
  it("extracts repos:A,B,C prefix into repos array", () => {
    const result = routeQuery("repos:api,web,shared what depends on Logger");
    expect(result.repos).toEqual(["api", "web", "shared"]);
    expect(result.repo).toBeUndefined();
    expect(result.strippedQuery).toBe("what depends on Logger");
    expect(result.route).toBe("structural");
  });

  it("collapses single-element repos to repo", () => {
    const result = routeQuery("repos:api what depends on Logger");
    expect(result.repo).toBe("api");
    expect(result.repos).toBeUndefined();
    expect(result.route).toBe("structural");
  });

  it("preserves existing repo: prefix behavior", () => {
    const result = routeQuery("repo:twenty what calls UserService");
    expect(result.repo).toBe("twenty");
    expect(result.repos).toBeUndefined();
    expect(result.route).toBe("structural");
  });

  it("returns undefined repos when no prefix", () => {
    const result = routeQuery("dependencies of UserService");
    expect(result.repo).toBeUndefined();
    expect(result.repos).toBeUndefined();
  });
});
