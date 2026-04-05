import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGraphStore } from "@mma/storage";
import type { GraphStore } from "@mma/storage";
import type { RepoConfig } from "@mma/core";
import { buildCrossRepoGraph } from "./graph-builder.js";

// Synthetic repos for testing
const repoA: RepoConfig = {
  name: "repo-a",
  url: "https://example.com/repo-a",
  branch: "main",
  localPath: "/repos/repo-a",
};
const repoB: RepoConfig = {
  name: "repo-b",
  url: "https://example.com/repo-b",
  branch: "main",
  localPath: "/repos/repo-b",
};
const repoC: RepoConfig = {
  name: "repo-c",
  url: "https://example.com/repo-c",
  branch: "main",
  localPath: "/repos/repo-c",
};

const repos = [repoA, repoB, repoC] as const;

// packageRoots maps package names to directory paths (which have repo localPath as prefix)
const packageRoots = new Map<string, string>([
  ["@org/auth", "/repos/repo-b/packages/auth"],
  ["@org/shared", "/repos/repo-c/packages/shared"],
  ["lodash", "/repos/repo-b/node_modules/lodash"],
]);

describe("buildCrossRepoGraph", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new InMemoryGraphStore();
  });

  it("returns an empty graph when there are no edges", async () => {
    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(0);
    expect(graph.repoPairs.size).toBe(0);
    expect(graph.downstreamMap.size).toBe(0);
    expect(graph.upstreamMap.size).toBe(0);
  });

  it("resolves cross-repo edge via metadata.targetRepo", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/index.ts",
        target: "@org/auth/src/index.ts",
        kind: "imports",
        metadata: { repo: "repo-a", targetRepo: "repo-b" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0]!;
    expect(edge.sourceRepo).toBe("repo-a");
    expect(edge.targetRepo).toBe("repo-b");
    expect(edge.packageName).toBe("@org/auth");
  });

  it("resolves cross-repo edge via packageRoots lookup", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/service.ts",
        target: "@org/auth/src/client.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0]!;
    expect(edge.sourceRepo).toBe("repo-a");
    expect(edge.targetRepo).toBe("repo-b");
    expect(edge.packageName).toBe("@org/auth");
  });

  it("resolves depends-on edges as well as imports", async () => {
    await store.addEdges([
      {
        source: "repo-a/package.json",
        target: "@org/shared",
        kind: "depends-on",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.targetRepo).toBe("repo-c");
  });

  it("filters out self-edges (sourceRepo === targetRepo)", async () => {
    await store.addEdges([
      {
        // repo-b imports something that resolves back to repo-b
        source: "repo-b/src/a.ts",
        target: "@org/auth/src/b.ts",
        kind: "imports",
        metadata: { repo: "repo-b" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(0);
  });

  it("skips relative-path targets", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/a.ts",
        target: "./utils/helper.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(0);
  });

  it("skips packages not in packageRoots", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/a.ts",
        target: "some-unknown-package/index.js",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(0);
  });

  it("builds correct downstream and upstream maps", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/index.ts",
        target: "@org/auth/src/index.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-a/src/index.ts",
        target: "@org/shared/src/index.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-b/src/index.ts",
        target: "@org/shared/src/types.ts",
        kind: "imports",
        metadata: { repo: "repo-b" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    // repo-a depends on repo-b and repo-c
    expect(graph.downstreamMap.get("repo-a")).toEqual(
      new Set(["repo-b", "repo-c"]),
    );
    // repo-b depends on repo-c
    expect(graph.downstreamMap.get("repo-b")).toEqual(new Set(["repo-c"]));

    // repo-b is depended upon by repo-a
    expect(graph.upstreamMap.get("repo-b")).toEqual(new Set(["repo-a"]));
    // repo-c is depended upon by repo-a and repo-b
    expect(graph.upstreamMap.get("repo-c")).toEqual(
      new Set(["repo-a", "repo-b"]),
    );
  });

  it("builds correct repoPairs set", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/index.ts",
        target: "@org/auth/src/index.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      // Duplicate pair — should only appear once in repoPairs
      {
        source: "repo-a/src/other.ts",
        target: "@org/auth/src/utils.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.repoPairs.size).toBe(1);
    expect(graph.repoPairs.has("repo-a->repo-b")).toBe(true);
    // Two resolved edges, but only one unique pair
    expect(graph.edges).toHaveLength(2);
  });

  it("handles unscoped package names via packageRoots", async () => {
    // lodash resolves to /repos/repo-b/node_modules/lodash which starts with /repos/repo-b
    await store.addEdges([
      {
        source: "repo-a/src/utils.ts",
        target: "lodash/cloneDeep",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.packageName).toBe("lodash");
    expect(graph.edges[0]!.targetRepo).toBe("repo-b");
  });

  it("resolves cross-repo edge from canonical ID target without packageRoots", async () => {
    // repoA imports something from repoB via canonical ID — no packageRoots entry needed
    await store.addEdges([
      {
        source: "src/service.ts",
        target: "repo-b:src/index.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, new Map());

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.sourceRepo).toBe("repo-a");
    expect(graph.edges[0]!.targetRepo).toBe("repo-b");
    expect(graph.repoPairs.has("repo-a->repo-b")).toBe(true);
    expect(graph.downstreamMap.get("repo-a")?.has("repo-b")).toBe(true);
    expect(graph.upstreamMap.get("repo-b")?.has("repo-a")).toBe(true);
  });

  it("skips self-edges where canonical target repo matches source repo", async () => {
    await store.addEdges([
      {
        source: "src/a.ts",
        target: "repo-a:src/b.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, new Map());

    expect(graph.edges).toHaveLength(0);
  });

  it("canonical ID takes precedence over metadata.targetRepo", async () => {
    // graph-builder.ts resolveTargetRepo checks canonical ID first (line 56),
    // then falls back to metadata.targetRepo (line 63). Canonical ID wins.
    await store.addEdges([
      {
        source: "src/a.ts",
        target: "repo-b:src/lib.ts",
        kind: "imports",
        metadata: { repo: "repo-a", targetRepo: "repo-c" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, new Map());

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.targetRepo).toBe("repo-b");
  });

  it("resolves symbol-level canonical ID (repo:path#symbol) to correct target repo", async () => {
    await store.addEdges([
      {
        source: "src/controller.ts#AppController",
        target: "repo-b:src/auth.ts#AuthService",
        kind: "calls",
        metadata: { repo: "repo-a" },
      },
    ]);

    // buildCrossRepoGraph only queries imports and depends-on, not calls
    const graph = await buildCrossRepoGraph(store, repos, new Map());

    expect(graph.edges).toHaveLength(0);
  });

  it("skips Node.js built-in module targets (node: prefix)", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/utils.ts",
        target: "node:path",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-a/src/server.ts",
        target: "node:fs",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-a/src/stream.ts",
        target: "node:stream/promises",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    // node: built-ins must never appear as cross-repo edges
    expect(graph.edges).toHaveLength(0);
    expect(graph.repoPairs.size).toBe(0);
  });

  it("skips URL and registry specifier targets (https:, npm:, bun:, jsr:)", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/server.ts",
        target: "https://deno.land/std/http/server.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-a/src/db.ts",
        target: "npm:postgres",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-a/src/test.ts",
        target: "bun:test",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
      {
        source: "repo-a/src/lib.ts",
        target: "jsr:@supabase/ssr",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(0);
    expect(graph.repoPairs.size).toBe(0);
  });

  it("skips canonical-looking targets whose repo prefix is not a known repo", async () => {
    await store.addEdges([
      {
        source: "repo-a/src/index.ts",
        target: "unknown-repo:src/lib.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    const graph = await buildCrossRepoGraph(store, repos, packageRoots);

    expect(graph.edges).toHaveLength(0);
  });

  it("does not match a repo whose localPath is a prefix of another repo name", async () => {
    // Regression test for the prefix-ambiguity bug: a bare startsWith check would
    // incorrectly match /repos/repo-b against /repos/repo-b-extra/src/file.ts.
    const repoShort: RepoConfig = {
      name: "repo-b",
      url: "https://example.com/repo-b",
      branch: "main",
      localPath: "/repos/repo-b",
    };
    const repoLong: RepoConfig = {
      name: "repo-b-extra",
      url: "https://example.com/repo-b-extra",
      branch: "main",
      localPath: "/repos/repo-b-extra",
    };
    // packageRoots maps @org/extra to a path under /repos/repo-b-extra
    const ambiguousRoots = new Map<string, string>([
      ["@org/extra", "/repos/repo-b-extra/packages/extra"],
    ]);

    await store.addEdges([
      {
        source: "repo-a/src/index.ts",
        target: "@org/extra/src/index.ts",
        kind: "imports",
        metadata: { repo: "repo-a" },
      },
    ]);

    // Build with all three repos so repo-a exists and self-edge filtering works
    const threeRepos = [repoA, repoShort, repoLong] as const;
    const graph = await buildCrossRepoGraph(store, threeRepos, ambiguousRoots);

    // Without the separator guard, /repos/repo-b-extra/... would match repo-b
    // (because "/repos/repo-b-extra".startsWith("/repos/repo-b") is true).
    // With the fix it correctly resolves to repo-b-extra.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.targetRepo).toBe("repo-b-extra");
  });
});
