import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { GraphStore } from "@mma/storage";
import type { GraphEdge } from "@mma/core";
import type { PackageMap, RepoPackages } from "@mma/ingestion";
import { RepoStateManager } from "./repo-state.js";
import {
  discoverConnections,
  extractPackageName,
} from "./connection-discovery.js";
import type { ConnectionDiscoveryOptions } from "./connection-discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePackageMap(
  entries: Array<{ pkg: string; repo: string }>,
  repoPackages: RepoPackages[] = [],
): PackageMap {
  const packageToRepo = new Map<string, string>(
    entries.map(({ pkg, repo }) => [pkg, repo]),
  );
  const repoToPackages = new Map<string, readonly string[]>();
  for (const rp of repoPackages) {
    const names = rp.packages.map((p) => p.name).filter((n) => n.length > 0);
    if (names.length > 0) repoToPackages.set(rp.repo, names);
  }
  return { packageToRepo, repoToPackages, builtAt: new Date().toISOString() };
}

function makeEdge(
  source: string,
  target: string,
  kind: GraphEdge["kind"],
): GraphEdge {
  return { source, target, kind };
}

function makeMockGraphStore(
  edgesByKindAndRepo: Map<string, GraphEdge[]>,
): GraphStore {
  return {
    getEdgesByKind: vi.fn(
      async (kind: string, repo?: string): Promise<GraphEdge[]> => {
        const key = repo !== undefined ? `${kind}:${repo}` : kind;
        return edgesByKindAndRepo.get(key) ?? [];
      },
    ),
    addEdges: vi.fn().mockResolvedValue(undefined),
    getEdgesFrom: vi.fn().mockResolvedValue([]),
    getEdgesTo: vi.fn().mockResolvedValue([]),
    getAllEdges: vi.fn().mockResolvedValue([]),
    countEdgesByKindGroupedByRepo: vi.fn().mockResolvedValue(new Map()),
    clearRepo: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphStore;
}

async function makeStateManager(
  indexed: string[] = [],
  ignored: string[] = [],
): Promise<RepoStateManager> {
  const kv = new InMemoryKVStore();
  const mgr = new RepoStateManager(kv);

  for (const name of indexed) {
    await mgr.addCandidate(
      { name, url: `https://github.com/org/${name}` },
      "org-scan",
    );
    await mgr.startIndexing(name);
    await mgr.markIndexed(name);
  }
  for (const name of ignored) {
    await mgr.addCandidate(
      { name, url: `https://github.com/org/${name}` },
      "org-scan",
    );
    await mgr.markIgnored(name);
  }

  return mgr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverConnections", () => {
  let stateManager: RepoStateManager;

  beforeEach(async () => {
    stateManager = await makeStateManager();
  });

  // -------------------------------------------------------------------------
  it("discovers forward connections via imports edges from indexed repo", async () => {
    // indexed-repo imports a file from target-repo (canonical ID)
    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [makeEdge("my-repo:src/a.ts", "target-repo:src/b.ts", "imports")],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);
    const packageMap = makePackageMap([]);

    const opts: ConnectionDiscoveryOptions = {
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages: [],
    };

    const results = await discoverConnections(opts);
    expect(results).toHaveLength(1);
    expect(results[0]?.repo).toBe("target-repo");
    expect(results[0]?.connectionType).toBe("imports");
    expect(results[0]?.fromRepo).toBe("my-repo");
    expect(results[0]?.edgeCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  it("discovers forward connections via package-name resolution in imports edges", async () => {
    // indexed-repo has an import edge whose target is an npm package name
    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [makeEdge("my-repo:src/a.ts", "@supabase/storage-js", "imports")],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);
    const packageMap = makePackageMap([
      { pkg: "@supabase/storage-js", repo: "storage-repo" },
    ]);

    const opts: ConnectionDiscoveryOptions = {
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages: [],
    };

    const results = await discoverConnections(opts);
    expect(results).toHaveLength(1);
    expect(results[0]?.repo).toBe("storage-repo");
    expect(results[0]?.connectionType).toBe("imports");
  });

  // -------------------------------------------------------------------------
  it("discovers forward depends-on connections", async () => {
    const edgeMap = new Map<string, GraphEdge[]>([
      ["imports:my-repo", []],
      [
        "depends-on:my-repo",
        [makeEdge("my-repo:src/a.ts", "dep-repo:src/b.ts", "depends-on")],
      ],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);
    const packageMap = makePackageMap([]);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.connectionType).toBe("depends-on");
    expect(results[0]?.repo).toBe("dep-repo");
  });

  // -------------------------------------------------------------------------
  it("discovers reverse connections via package deps of unindexed repos", async () => {
    // "my-repo" publishes "@org/my-pkg"; "other-repo" depends on it
    const graphStore = makeMockGraphStore(new Map());

    const allRepoPackages: RepoPackages[] = [
      {
        repo: "my-repo",
        packages: [
          {
            name: "@org/my-pkg",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
      {
        repo: "other-repo",
        packages: [
          {
            name: "@org/other",
            path: "package.json",
            dependencies: ["@org/my-pkg"],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ];

    const packageMap = makePackageMap(
      [{ pkg: "@org/my-pkg", repo: "my-repo" }],
      allRepoPackages,
    );

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.repo).toBe("other-repo");
    expect(results[0]?.connectionType).toBe("reverse-import");
    expect(results[0]?.fromRepo).toBe("my-repo");
  });

  // -------------------------------------------------------------------------
  it("classifies devDependencies as reverse-depends-on", async () => {
    const graphStore = makeMockGraphStore(new Map());

    const allRepoPackages: RepoPackages[] = [
      {
        repo: "my-repo",
        packages: [
          {
            name: "@org/my-pkg",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
      {
        repo: "consumer-repo",
        packages: [
          {
            name: "@org/consumer",
            path: "package.json",
            dependencies: [],
            devDependencies: ["@org/my-pkg"],
            peerDependencies: [],
          },
        ],
      },
    ];

    const packageMap = makePackageMap(
      [{ pkg: "@org/my-pkg", repo: "my-repo" }],
      allRepoPackages,
    );

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.connectionType).toBe("reverse-depends-on");
  });

  // -------------------------------------------------------------------------
  it("classifies peerDependencies as reverse-depends-on", async () => {
    const graphStore = makeMockGraphStore(new Map());

    const allRepoPackages: RepoPackages[] = [
      {
        repo: "my-repo",
        packages: [
          {
            name: "@org/core",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
      {
        repo: "plugin-repo",
        packages: [
          {
            name: "@org/plugin",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: ["@org/core"],
          },
        ],
      },
    ];

    const packageMap = makePackageMap(
      [{ pkg: "@org/core", repo: "my-repo" }],
      allRepoPackages,
    );

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.connectionType).toBe("reverse-depends-on");
  });

  // -------------------------------------------------------------------------
  it("filters out already-indexed repos", async () => {
    stateManager = await makeStateManager(["already-indexed"]);

    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [
          makeEdge(
            "my-repo:src/a.ts",
            "already-indexed:src/b.ts",
            "imports",
          ),
        ],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);
    const packageMap = makePackageMap([]);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("filters out ignored repos", async () => {
    stateManager = await makeStateManager([], ["ignored-repo"]);

    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [makeEdge("my-repo:src/a.ts", "ignored-repo:src/b.ts", "imports")],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);
    const packageMap = makePackageMap([]);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap,
      stateManager,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("filters out repos currently being indexed", async () => {
    const kv = new InMemoryKVStore();
    const mgr = new RepoStateManager(kv);
    await mgr.addCandidate(
      { name: "in-progress", url: "https://github.com/org/in-progress" },
      "org-scan",
    );
    await mgr.startIndexing("in-progress");

    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [makeEdge("my-repo:src/a.ts", "in-progress:src/b.ts", "imports")],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap: makePackageMap([]),
      stateManager: mgr,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("returns results sorted by edge count descending", async () => {
    // repo-a has 1 edge, repo-b has 2 edges, repo-c has 3 edges
    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [
          makeEdge("my-repo:src/a.ts", "repo-c:src/1.ts", "imports"),
          makeEdge("my-repo:src/a.ts", "repo-c:src/2.ts", "imports"),
          makeEdge("my-repo:src/a.ts", "repo-c:src/3.ts", "imports"),
          makeEdge("my-repo:src/a.ts", "repo-b:src/1.ts", "imports"),
          makeEdge("my-repo:src/a.ts", "repo-b:src/2.ts", "imports"),
          makeEdge("my-repo:src/a.ts", "repo-a:src/1.ts", "imports"),
        ],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap: makePackageMap([]),
      stateManager,
      allRepoPackages: [],
    });

    expect(results.map((r) => r.repo)).toEqual(["repo-c", "repo-b", "repo-a"]);
    expect(results.map((r) => r.edgeCount)).toEqual([3, 2, 1]);
  });

  // -------------------------------------------------------------------------
  it("does not create self-connections for the indexed repo", async () => {
    // Edge where source and target are both in my-repo
    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [makeEdge("my-repo:src/a.ts", "my-repo:src/b.ts", "imports")],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap: makePackageMap([]),
      stateManager,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("returns empty results when no connections are found", async () => {
    const graphStore = makeMockGraphStore(new Map());

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap: makePackageMap([]),
      stateManager,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  it("accumulates edge counts across multiple edges to the same target+type", async () => {
    const edgeMap = new Map<string, GraphEdge[]>([
      [
        "imports:my-repo",
        [
          makeEdge("my-repo:src/a.ts", "target-repo:src/1.ts", "imports"),
          makeEdge("my-repo:src/b.ts", "target-repo:src/2.ts", "imports"),
        ],
      ],
      ["depends-on:my-repo", []],
    ]);

    const graphStore = makeMockGraphStore(edgeMap);

    const results = await discoverConnections({
      indexedRepo: "my-repo",
      graphStore,
      packageMap: makePackageMap([]),
      stateManager,
      allRepoPackages: [],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.edgeCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// extractPackageName unit tests
// ---------------------------------------------------------------------------

describe("extractPackageName", () => {
  it("extracts unscoped package name", () => {
    expect(extractPackageName("lodash")).toBe("lodash");
  });

  it("strips subpath from unscoped package", () => {
    expect(extractPackageName("lodash/fp")).toBe("lodash");
  });

  it("extracts scoped package name", () => {
    expect(extractPackageName("@supabase/supabase-js")).toBe(
      "@supabase/supabase-js",
    );
  });

  it("strips subpath from scoped package", () => {
    expect(extractPackageName("@supabase/supabase-js/dist/main")).toBe(
      "@supabase/supabase-js",
    );
  });

  it("returns null for relative paths", () => {
    expect(extractPackageName("./utils")).toBeNull();
    expect(extractPackageName("../shared")).toBeNull();
  });

  it("returns null for absolute paths", () => {
    expect(extractPackageName("/usr/local/lib")).toBeNull();
  });

  it("returns null for node: protocol", () => {
    expect(extractPackageName("node:fs")).toBeNull();
    expect(extractPackageName("node:path")).toBeNull();
  });

  it("returns null for https: protocol", () => {
    expect(extractPackageName("https://deno.land/x/oak/mod.ts")).toBeNull();
  });

  it("returns null for npm: protocol", () => {
    expect(extractPackageName("npm:lodash")).toBeNull();
  });

  it("returns null for bun: protocol", () => {
    expect(extractPackageName("bun:test")).toBeNull();
  });

  it("returns null for jsr: protocol", () => {
    expect(extractPackageName("jsr:@std/assert")).toBeNull();
  });

  it("returns null for incomplete scoped specifier", () => {
    expect(extractPackageName("@scope")).toBeNull();
  });
});
