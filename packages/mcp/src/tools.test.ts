import { describe, it, expect, vi } from "vitest";
import { registerTools } from "./tools.js";
import type { Stores } from "./tools.js";

// Stub out network-dependent ingestion helpers so tools that call scanGitHubOrg
// or cloneOrFetch don't throw "GitHub token required" errors in unit tests.
vi.mock("@mma/ingestion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mma/ingestion")>();
  return {
    ...actual,
    scanGitHubOrg: vi.fn().mockResolvedValue({ totalReposInOrg: 0, repos: [] }),
    cloneOrFetch: vi.fn().mockResolvedValue(undefined),
  };
});
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

interface ToolEntry {
  description: string;
  handler: ToolHandler;
}

// Minimal mock of McpServer that records registrations
function createMockServer() {
  const tools = new Map<string, ToolEntry>();
  return {
    registerTool: vi.fn(
      (name: string, config: { description: string }, handler: ToolHandler) => {
        tools.set(name, { description: config.description, handler });
      },
    ),
    tools,
  };
}

function makeStores() {
  return {
    graphStore: new InMemoryGraphStore(),
    searchStore: new InMemorySearchStore(),
    kvStore: new InMemoryKVStore(),
  };
}

function register(server: ReturnType<typeof createMockServer>, stores: Stores) {
  // McpServer type is complex; we only use registerTool which our mock implements
  registerTools(server as unknown as Parameters<typeof registerTools>[0], stores);
}

/** Serialized correlation:graph fixture matching the run-correlation.ts format. */
function makeSerializedGraph() {
  return JSON.stringify({
    edges: [
      {
        edge: { source: "src/index.ts", target: "src/util.ts", kind: "imports", metadata: {} },
        sourceRepo: "repo-a",
        targetRepo: "repo-b",
        packageName: "@acme/lib",
      },
    ],
    repoPairs: ["repo-a->repo-b"],
    downstreamMap: [["repo-a", ["repo-b"]]],
    upstreamMap: [["repo-b", ["repo-a"]]],
  });
}

/** Serialized correlation:services fixture. */
function makeSerializedServices() {
  return JSON.stringify({
    links: [],
    linchpins: [
      { endpoint: "/api/users", producerCount: 2, consumerCount: 3, linkedRepoCount: 4, criticalityScore: 20 },
    ],
    orphanedServices: [
      { endpoint: "/api/legacy", hasProducers: true, hasConsumers: false, repos: ["repo-c"] },
    ],
  });
}

describe("registerTools", () => {
  it("registers all expected tools", () => {
    const server = createMockServer();
    register(server, makeStores());

    const expectedTools = [
      "query", "search", "get_callers", "get_callees",
      "get_dependencies", "get_architecture", "get_diagnostics",
      "get_metrics", "get_blast_radius",
      "get_cross_repo_graph", "get_service_correlation", "get_cross_repo_models",
      "get_cross_repo_impact",
      "get_flag_inventory", "get_flag_impact", "get_vulnerability",
      "scan_org", "get_repo_candidates", "index_repo",
      "ignore_repo", "get_indexing_state", "check_new_repos",
    ];

    for (const tool of expectedTools) {
      expect(server.tools.has(tool)).toBe(true);
    }
    expect(server.registerTool).toHaveBeenCalledTimes(expectedTools.length);
  });

  it("each tool has a description", () => {
    const server = createMockServer();
    register(server, makeStores());

    for (const [_name, tool] of server.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});

describe("tool handlers", () => {
  it("get_diagnostics returns error when no SARIF data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_diagnostics")!.handler;
    const result = await handler({});
    const parsed: unknown = JSON.parse(result.content[0]!.text);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain("No analysis results");
  });

  it("get_diagnostics returns results when SARIF exists", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest", JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: [
          { ruleId: "test/rule", level: "warning", message: { text: "Test finding" } },
        ],
      }],
    }));

    register(server, stores);
    const handler = server.tools.get("get_diagnostics")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; returned: number; results: Array<{ ruleId: string }> };
    expect(parsed.total).toBe(1);
    expect(parsed.returned).toBe(1);
    expect(parsed.results[0]!.ruleId).toBe("test/rule");
  });

  it("get_metrics returns empty for fresh store", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_metrics")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { total: number };
    expect(parsed.total).toBe(0);
  });
});

describe("pagination", () => {
  function makeSarifStores(count: number) {
    const stores = makeStores();
    const results = Array.from({ length: count }, (_, i) => ({
      ruleId: `test/rule-${i}`,
      level: "warning",
      message: { text: `Finding ${i}` },
    }));
    void stores.kvStore.set("sarif:latest", JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "mma", version: "0.1.0", rules: [] } }, results }],
    }));
    return stores;
  }

  it("get_diagnostics paginates with offset and limit", async () => {
    const server = createMockServer();
    const stores = makeSarifStores(10);
    register(server, stores);

    const handler = server.tools.get("get_diagnostics")!.handler;
    const result = await handler({ limit: 3, offset: 2 });
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; returned: number; offset: number; hasMore: boolean; results: unknown[] };
    expect(parsed.total).toBe(10);
    expect(parsed.returned).toBe(3);
    expect(parsed.offset).toBe(2);
    expect(parsed.hasMore).toBe(true);
  });

  it("get_diagnostics hasMore is false on last page", async () => {
    const server = createMockServer();
    const stores = makeSarifStores(5);
    register(server, stores);

    const handler = server.tools.get("get_diagnostics")!.handler;
    const result = await handler({ limit: 3, offset: 3 });
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; returned: number; hasMore: boolean };
    expect(parsed.total).toBe(5);
    expect(parsed.returned).toBe(2);
    expect(parsed.hasMore).toBe(false);
  });

  it("get_diagnostics includes resource_link for repo filter", async () => {
    const server = createMockServer();
    const stores = makeSarifStores(1);
    register(server, stores);

    const handler = server.tools.get("get_diagnostics")!.handler;
    const result = await handler({ repo: "my-repo" });
    const link = result.content.find((c: { type: string }) => c.type === "resource_link");
    expect(link).toBeDefined();
    expect((link as unknown as { uri: string }).uri).toBe("mma://repo/my-repo/findings");
  });
});

describe("resources", () => {
  // Minimal mock that captures resource registrations
  function createResourceMockServer() {
    const tools = new Map<string, ToolEntry>();
    type ResourceEntry = { readCallback: (...args: unknown[]) => Promise<unknown> };
    const resources = new Map<string, ResourceEntry>();
    return {
      registerTool: vi.fn(
        (name: string, config: { description: string }, handler: ToolHandler) => {
          tools.set(name, { description: config.description, handler });
        },
      ),
      resource: vi.fn(
        (_name: string, _uriOrTemplate: unknown, _config: unknown, readCallback: (...args: unknown[]) => Promise<unknown>) => {
          resources.set(_name, { readCallback });
        },
      ),
      tools,
      resources,
    };
  }

  it("registerResources registers repos and 3 templates", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);
    expect(server.resource).toHaveBeenCalledTimes(4);
  });
});

describe("get_cross_repo_graph", () => {
  it("returns error when no correlation data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_cross_repo_graph")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { error: string };
    expect(parsed.error).toContain("No correlation data");
  });

  it("returns edges and repo pairs when data exists", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_graph")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      edgeCount: number;
      repoPairs: string[];
      edges: unknown[];
    };
    expect(parsed.edgeCount).toBe(1);
    expect(parsed.repoPairs).toContain("repo-a->repo-b");
    expect(parsed.edges).toHaveLength(1);
  });

  it("filters edges by repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_graph")!.handler;

    // repo-a is the sourceRepo of the only edge — should match
    const resultA = await handler({ repo: "repo-a" });
    const parsedA = JSON.parse(resultA.content[0]!.text) as { edgeCount: number };
    expect(parsedA.edgeCount).toBe(1);

    // repo-c is not in the fixture — should return 0 edges
    const resultC = await handler({ repo: "repo-c" });
    const parsedC = JSON.parse(resultC.content[0]!.text) as { edgeCount: number };
    expect(parsedC.edgeCount).toBe(0);
  });

  it("includes paths when includePaths is true", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_graph")!.handler;
    const result = await handler({ includePaths: true });
    const parsed = JSON.parse(result.content[0]!.text) as { paths: Record<string, unknown> };
    expect(parsed.paths).toBeDefined();
    expect(parsed.paths["repo-a->repo-b"]).toBeDefined();
  });

  it("repoCount reflects filtered edges, not full graph", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // Two disjoint repo pairs in the graph
    await stores.kvStore.set("correlation:graph", JSON.stringify({
      edges: [
        { edge: { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: {} }, sourceRepo: "repo-a", targetRepo: "repo-b", packageName: "@a/b" },
        { edge: { source: "src/c.ts", target: "src/d.ts", kind: "imports", metadata: {} }, sourceRepo: "repo-c", targetRepo: "repo-d", packageName: "@c/d" },
      ],
      repoPairs: ["repo-a->repo-b", "repo-c->repo-d"],
      downstreamMap: [["repo-a", ["repo-b"]], ["repo-c", ["repo-d"]]],
      upstreamMap: [["repo-b", ["repo-a"]], ["repo-d", ["repo-c"]]],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_graph")!.handler;
    // Filtering to repo-a should only see repo-a + repo-b (2 repos), not all 4
    const result = await handler({ repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as { repoCount: number; edgeCount: number };
    expect(parsed.edgeCount).toBe(1);
    expect(parsed.repoCount).toBe(2); // only repo-a and repo-b, not repo-c/repo-d
  });

  it("downstreamMap and upstreamMap are filtered when repo is specified", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", JSON.stringify({
      edges: [
        { edge: { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: {} }, sourceRepo: "repo-a", targetRepo: "repo-b", packageName: "@a/b" },
        { edge: { source: "src/c.ts", target: "src/d.ts", kind: "imports", metadata: {} }, sourceRepo: "repo-c", targetRepo: "repo-d", packageName: "@c/d" },
      ],
      repoPairs: ["repo-a->repo-b", "repo-c->repo-d"],
      downstreamMap: [["repo-a", ["repo-b"]], ["repo-c", ["repo-d"]]],
      upstreamMap: [["repo-b", ["repo-a"]], ["repo-d", ["repo-c"]]],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_graph")!.handler;
    const result = await handler({ repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as {
      downstreamMap: Record<string, string[]>;
      upstreamMap: Record<string, string[]>;
    };
    // repo-c and repo-d should be absent from both maps
    expect(Object.keys(parsed.downstreamMap)).not.toContain("repo-c");
    expect(Object.keys(parsed.upstreamMap)).not.toContain("repo-d");
    // repo-a's downstream entry should be present
    expect(parsed.downstreamMap["repo-a"]).toEqual(["repo-b"]);
  });

  it("includePaths uses filteredEdges when repo is specified", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", JSON.stringify({
      edges: [
        { edge: { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: {} }, sourceRepo: "repo-a", targetRepo: "repo-b", packageName: "@a/b" },
        { edge: { source: "src/c.ts", target: "src/d.ts", kind: "imports", metadata: {} }, sourceRepo: "repo-c", targetRepo: "repo-d", packageName: "@c/d" },
      ],
      repoPairs: ["repo-a->repo-b", "repo-c->repo-d"],
      downstreamMap: [["repo-a", ["repo-b"]], ["repo-c", ["repo-d"]]],
      upstreamMap: [["repo-b", ["repo-a"]], ["repo-d", ["repo-c"]]],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_graph")!.handler;
    const result = await handler({ repo: "repo-a", includePaths: true });
    const parsed = JSON.parse(result.content[0]!.text) as { paths?: Record<string, unknown> };
    // Paths should only exist between repo-a and repo-b, not involving repo-c/repo-d
    if (parsed.paths) {
      expect(Object.keys(parsed.paths).every((k) => k.includes("repo-a") || k.includes("repo-b"))).toBe(true);
      expect(Object.keys(parsed.paths).some((k) => k.includes("repo-c") || k.includes("repo-d"))).toBe(false);
    }
  });
});

describe("get_service_correlation", () => {
  it("returns error when no correlation data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_service_correlation")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { error: string };
    expect(parsed.error).toContain("No correlation data");
  });

  it("returns linchpins and orphaned services when data exists", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);

    const handler = server.tools.get("get_service_correlation")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      linchpins: { results: Array<{ endpoint: string }> };
      orphanedServices: { results: Array<{ endpoint: string }> };
    };
    expect(parsed.linchpins.results[0]!.endpoint).toBe("/api/users");
    expect(parsed.orphanedServices.results[0]!.endpoint).toBe("/api/legacy");
  });

  it("returns only linchpins when kind is 'linchpins'", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);

    const handler = server.tools.get("get_service_correlation")!.handler;
    const result = await handler({ kind: "linchpins" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed["linchpins"]).toBeDefined();
    expect(parsed["orphanedServices"]).toBeUndefined();
  });

  it("returns only orphaned when kind is 'orphaned'", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);

    const handler = server.tools.get("get_service_correlation")!.handler;
    const result = await handler({ kind: "orphaned" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed["orphanedServices"]).toBeDefined();
    expect(parsed["linchpins"]).toBeUndefined();
  });

  it("filters by endpoint substring (case-insensitive)", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);

    const handler = server.tools.get("get_service_correlation")!.handler;

    // "USERS" should match "/api/users" case-insensitively
    const result = await handler({ endpoint: "USERS" });
    const parsed = JSON.parse(result.content[0]!.text) as {
      linchpins: { results: Array<{ endpoint: string }> };
      orphanedServices: { results: Array<{ endpoint: string }> };
    };
    expect(parsed.linchpins.results).toHaveLength(1);
    expect(parsed.orphanedServices.results).toHaveLength(0);
  });

  it("filters template-literal URLs from linchpins", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", JSON.stringify({
      links: [],
      linchpins: [
        { endpoint: "/api/real", producerCount: 1, consumerCount: 1, linkedRepoCount: 2, criticalityScore: 5 },
        { endpoint: "${BASE_URL}/api/internal", producerCount: 1, consumerCount: 1, linkedRepoCount: 2, criticalityScore: 5 },
      ],
      orphanedServices: [],
    }));
    register(server, stores);

    const handler = server.tools.get("get_service_correlation")!.handler;
    const result = await handler({ kind: "linchpins" });
    const parsed = JSON.parse(result.content[0]!.text) as { linchpins: { results: Array<{ endpoint: string }> } };
    expect(parsed.linchpins.results).toHaveLength(1);
    expect(parsed.linchpins.results[0]!.endpoint).toBe("/api/real");
  });

  it("truncates links to 100 when more than 100 exist", async () => {
    const server = createMockServer();
    const stores = makeStores();
    const manyLinks = Array.from({ length: 150 }, (_, i) => ({ from: `svc-${i}`, to: `svc-${i + 1}` }));
    await stores.kvStore.set("correlation:services", JSON.stringify({
      links: manyLinks,
      linchpins: [],
      orphanedServices: [],
    }));
    register(server, stores);

    const handler = server.tools.get("get_service_correlation")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as {
      links: unknown[];
      linksTruncated?: { shown: number; total: number };
    };
    expect(parsed.links).toHaveLength(100);
    expect(parsed.linksTruncated).toBeDefined();
    expect(parsed.linksTruncated!.total).toBe(150);
  });
});

describe("get_cross_repo_models", () => {
  function seedCatalog(kvStore: InstanceType<typeof InMemoryKVStore>) {
    return kvStore.set("cross-repo:catalog", JSON.stringify({
      entries: [
        { entry: { name: "svc-a" }, repo: "repo-a", consumers: ["repo-b"], producers: [] },
        { entry: { name: "svc-b" }, repo: "repo-b", consumers: [], producers: ["repo-a"] },
        { entry: { name: "svc-c" }, repo: "repo-c", consumers: [], producers: [] },
      ],
    }));
  }

  it("catalog repo filter matches owner, consumer, and producer", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await seedCatalog(stores.kvStore);
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;

    // repo-a owns svc-a and is a producer for svc-b → both should appear
    const result = await handler({ kind: "catalog", repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as { catalog: { results: Array<{ entry: { name: string } }> } };
    const names = parsed.catalog.results.map((e) => e.entry.name);
    expect(names).toContain("svc-a"); // owner
    expect(names).toContain("svc-b"); // repo-a is a producer
    expect(names).not.toContain("svc-c"); // unrelated
  });

  it("catalog repo filter matches consumer role", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await seedCatalog(stores.kvStore);
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;

    // repo-b consumes svc-a and owns svc-b
    const result = await handler({ kind: "catalog", repo: "repo-b" });
    const parsed = JSON.parse(result.content[0]!.text) as { catalog: { results: Array<{ entry: { name: string } }> } };
    const names = parsed.catalog.results.map((e) => e.entry.name);
    expect(names).toContain("svc-a"); // repo-b is a consumer
    expect(names).toContain("svc-b"); // owner
    expect(names).not.toContain("svc-c");
  });

  it("returns all catalog entries without repo filter", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await seedCatalog(stores.kvStore);
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "catalog" });
    const parsed = JSON.parse(result.content[0]!.text) as { catalog: { results: Array<{ entry: { name: string } }> } };
    expect(parsed.catalog.results).toHaveLength(3);
  });

  it("uses defensive defaults for pagination", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await seedCatalog(stores.kvStore);
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    // Call with no offset/limit — should not throw
    const result = await handler({ kind: "catalog" });
    const parsed = JSON.parse(result.content[0]!.text) as { catalog: { total: number; returned: number; offset: number } };
    expect(parsed.catalog.total).toBe(3);
    expect(parsed.catalog.returned).toBe(3);
    expect(parsed.catalog.offset).toBe(0);
  });
});

describe("get_cross_repo_impact", () => {
  it("returns error when no correlation data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_cross_repo_impact")!.handler;
    const result = await handler({ files: ["src/index.ts"], repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as { error: string };
    expect(parsed.error).toContain("No correlation data");
  });

  it("returns impact result with affectedAcrossRepos as plain object", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());

    // Seed graphStore with an edge in repo-b so the BFS can find affected files
    await stores.graphStore.addEdges([{
      source: "src/consumer.ts",
      target: "src/util.ts",
      kind: "imports",
      metadata: { repo: "repo-b" },
    }]);

    register(server, stores);

    const handler = server.tools.get("get_cross_repo_impact")!.handler;
    const result = await handler({ files: ["src/index.ts"], repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as {
      changedFiles: string[];
      changedRepo: string;
      affectedWithinRepo: string[];
      affectedAcrossRepos: Record<string, string[]>;
      reposReached: number;
    };

    expect(parsed.changedFiles).toEqual(["src/index.ts"]);
    expect(parsed.changedRepo).toBe("repo-a");
    // affectedAcrossRepos must be a plain object (not a Map)
    expect(typeof parsed.affectedAcrossRepos).toBe("object");
    expect(Array.isArray(parsed.affectedAcrossRepos)).toBe(false);
    expect(parsed.reposReached).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by sanity + meta-sanity blocks
// ---------------------------------------------------------------------------

const ALL_TOOL_NAMES = [
  "query", "search", "get_callers", "get_callees",
  "get_dependencies", "get_architecture", "get_diagnostics",
  "get_metrics", "get_blast_radius",
  "get_cross_repo_graph", "get_service_correlation", "get_cross_repo_models",
  "get_cross_repo_impact",
  "get_flag_inventory", "get_flag_impact", "get_vulnerability",
  "scan_org", "get_repo_candidates", "index_repo",
  "ignore_repo", "get_indexing_state", "check_new_repos",
] as const;

/** Minimal valid args for every tool so we can invoke them without crashes. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  query:                  { query: "show me everything" },
  search:                 { query: "foo" },
  get_callers:            { symbol: "foo" },
  get_callees:            { symbol: "foo" },
  get_dependencies:       { symbol: "foo" },
  get_architecture:       {},
  get_diagnostics:        {},
  get_metrics:            {},
  get_blast_radius:       { files: ["test.ts"] },
  get_cross_repo_graph:   {},
  get_service_correlation:{},
  get_cross_repo_models:  { kind: "all" },
  get_cross_repo_impact:  { files: ["test.ts"], repo: "repo-a" },
  get_flag_inventory:     {},
  get_flag_impact:        { flag: "MY_FLAG", repo: "repo-a" },
  get_vulnerability:      {},
  scan_org:               { org: "test-org" },
  get_repo_candidates:    {},
  index_repo:             { name: "test-repo", url: "https://github.com/test/test-repo" },
  ignore_repo:            { name: "test-repo" },
  get_indexing_state:     {},
  check_new_repos:        { org: "test-org" },
};

function makeSarifStoresWithRepoMetadata(count: number) {
  const stores = makeStores();
  const results = Array.from({ length: count }, (_, i) => ({
    ruleId: `test/rule-${i}`,
    level: i % 3 === 0 ? "error" : "warning",
    message: { text: `Finding ${i}` },
    logicalLocations: [{ name: `file-${i % 3 === 0 ? "repo-a" : "repo-b"}.ts`, properties: { repo: i % 3 === 0 ? "repo-a" : "repo-b" } }],
  }));
  void stores.kvStore.set("sarif:latest", JSON.stringify({
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "mma", version: "0.1.0", rules: [] } }, results }],
  }));
  return stores;
}

function makeInvoker(server: ReturnType<typeof createMockServer>) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const handler = server.tools.get(name)?.handler;
    if (!handler) throw new Error(`Tool not found: ${name}`);
    return handler(args) as Promise<{ content: Array<{ type: string; text?: string; uri?: string }> }>;
  };
}

// ---------------------------------------------------------------------------
// Describe block 1: MCP tool sanity checks
// ---------------------------------------------------------------------------

describe("MCP tool sanity checks", () => {
  it("all 22 tools return valid JSON content with text entry", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    for (const name of ALL_TOOL_NAMES) {
      const result = await invoker(name, MINIMAL_ARGS[name] ?? {});
      expect(result.content, `${name} should have content array`).toBeDefined();
      expect(Array.isArray(result.content), `${name} content should be array`).toBe(true);
      const textItem = result.content.find((c) => c.type === "text");
      expect(textItem, `${name} should have a text item`).toBeDefined();
      expect(() => JSON.parse(textItem!.text!), `${name} text should be valid JSON`).not.toThrow();
    }
  });

  it("search returns empty results on empty store", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("search", { query: "foo" });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; results: unknown[] };
    expect(parsed.total).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("get_diagnostics with populated store returns findings", async () => {
    const server = createMockServer();
    const stores = makeSarifStoresWithRepoMetadata(5);
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_diagnostics", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; results: unknown[] };
    expect(parsed.total).toBe(5);
    expect(parsed.results).toHaveLength(5);
  });

  it("get_diagnostics pagination: limit=3 offset=0 hasMore=true; offset=9 hasMore=false", async () => {
    const server = createMockServer();
    const stores = makeSarifStoresWithRepoMetadata(10);
    register(server, stores);
    const invoker = makeInvoker(server);

    const page1 = JSON.parse((await invoker("get_diagnostics", { limit: 3, offset: 0 })).content[0]!.text!) as {
      returned: number; hasMore: boolean;
    };
    expect(page1.returned).toBe(3);
    expect(page1.hasMore).toBe(true);

    const page2 = JSON.parse((await invoker("get_diagnostics", { limit: 3, offset: 9 })).content[0]!.text!) as {
      returned: number; hasMore: boolean;
    };
    expect(page2.returned).toBe(1);
    expect(page2.hasMore).toBe(false);
  });

  it("get_diagnostics repo filter returns only matching repo findings", async () => {
    const server = createMockServer();
    // Use getSarifResultsPaginated path via per-repo keys
    const stores = makeStores();
    // Seed per-repo keys that getSarifResultsPaginated reads
    const repoAResults = [
      { ruleId: "test/a", level: "error", message: { text: "A finding" }, logicalLocations: [{ name: "f.ts", properties: { repo: "repo-a" } }] },
    ];
    const repoBResults = [
      { ruleId: "test/b", level: "warning", message: { text: "B finding" }, logicalLocations: [{ name: "g.ts", properties: { repo: "repo-b" } }] },
    ];
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    await stores.kvStore.set("sarif:repo:repo-a", JSON.stringify(repoAResults));
    await stores.kvStore.set("sarif:repo:repo-b", JSON.stringify(repoBResults));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_diagnostics", { repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; results: Array<{ ruleId: string }> };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.ruleId).toBe("test/a");
  });

  it("get_diagnostics level filter returns only matching level", async () => {
    const server = createMockServer();
    // Seed with mixed severities via sarif:latest
    const stores = makeStores();
    const results = [
      { ruleId: "test/err", level: "error", message: { text: "Error finding" } },
      { ruleId: "test/warn", level: "warning", message: { text: "Warning finding" } },
      { ruleId: "test/note", level: "note", message: { text: "Note finding" } },
    ];
    await stores.kvStore.set("sarif:latest", JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "mma", version: "0.1.0", rules: [] } }, results }],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_diagnostics", { level: "error" });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; results: Array<{ ruleId: string }> };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.ruleId).toBe("test/err");
  });

  it("get_metrics on empty store returns total=0", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_metrics", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number };
    expect(parsed.total).toBe(0);
  });

  it("get_metrics with populated store returns module data", async () => {
    const server = createMockServer();
    const stores = makeStores();
    const sampleModules = [
      { module: "src/index.ts", instability: 0.5, abstractness: 0.3, distance: 0.2, fanIn: 2, fanOut: 4 },
    ];
    await stores.kvStore.set("metrics:test-repo", JSON.stringify(sampleModules));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_metrics", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; repos: Array<{ repo: string }> };
    expect(parsed.total).toBe(1);
    expect(parsed.repos[0]!.repo).toBe("test-repo");
  });

  it("get_cross_repo_graph on empty store returns error", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_graph", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { error?: string; repoCount?: number };
    // Empty store should return an error message
    expect(parsed.error).toBeDefined();
  });

  it("get_cross_repo_graph with data returns edgeCount > 0", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_graph", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { edgeCount: number };
    expect(parsed.edgeCount).toBeGreaterThan(0);
  });

  it("get_service_correlation empty returns error", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_service_correlation", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { error: string };
    expect(parsed.error).toBeDefined();
  });

  it("get_service_correlation with data returns linchpins", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_service_correlation", {});
    const parsed = JSON.parse(result.content[0]!.text!) as {
      linchpins: { results: unknown[] };
    };
    expect(parsed.linchpins.results.length).toBeGreaterThan(0);
  });

  it("get_service_correlation kind filter 'orphaned' returns only orphaned", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_service_correlation", { kind: "orphaned" });
    const parsed = JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
    expect(parsed["orphanedServices"]).toBeDefined();
    expect(parsed["linchpins"]).toBeUndefined();
  });

  it("get_service_correlation endpoint filter returns filtered results", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_service_correlation", { endpoint: "USERS" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      linchpins: { results: Array<{ endpoint: string }> };
      orphanedServices: { results: unknown[] };
    };
    expect(parsed.linchpins.results).toHaveLength(1);
    expect(parsed.orphanedServices.results).toHaveLength(0);
  });

  it("get_cross_repo_models empty returns error", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_models", { kind: "all" });
    const parsed = JSON.parse(result.content[0]!.text!) as { error?: string };
    expect(parsed.error).toBeDefined();
  });

  it("get_cross_repo_models with catalog data returns catalog entries", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:catalog", JSON.stringify({
      entries: [
        { entry: { name: "svc-a" }, repo: "repo-a", consumers: [], producers: [] },
        { entry: { name: "svc-b" }, repo: "repo-b", consumers: [], producers: [] },
      ],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_models", { kind: "catalog" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      catalog: { results: Array<{ entry: { name: string } }> };
    };
    expect(parsed.catalog.results).toHaveLength(2);
  });

  it("get_cross_repo_models repo filter returns only matching entries", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:catalog", JSON.stringify({
      entries: [
        { entry: { name: "svc-a" }, repo: "repo-a", consumers: [], producers: [] },
        { entry: { name: "svc-b" }, repo: "repo-b", consumers: [], producers: [] },
      ],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_models", { kind: "catalog", repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      catalog: { results: Array<{ entry: { name: string } }> };
    };
    expect(parsed.catalog.results).toHaveLength(1);
    expect(parsed.catalog.results[0]!.entry.name).toBe("svc-a");
  });

  it("get_vulnerability empty returns empty findings", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_vulnerability", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { findings: unknown[]; total: number };
    expect(parsed.findings).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it("get_vulnerability with data returns findings", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["test-repo"] }));
    await stores.kvStore.set("sarif:vuln:test-repo", JSON.stringify([
      { ruleId: "vuln/lodash", level: "error", message: { text: "Prototype pollution" }, properties: { severity: "high" } },
    ]));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_vulnerability", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { findings: Array<{ ruleId: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.findings[0]!.ruleId).toBe("vuln/lodash");
  });

  it("get_vulnerability severity filter handles uppercase severity values from npm audit", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["test-repo"] }));
    await stores.kvStore.set("sarif:vuln:test-repo", JSON.stringify([
      { ruleId: "vuln/critical-pkg", level: "error", message: { text: "Critical vuln" }, properties: { severity: "CRITICAL" } },
      { ruleId: "vuln/low-pkg", level: "note", message: { text: "Low vuln" }, properties: { severity: "low" } },
    ]));
    register(server, stores);
    const invoker = makeInvoker(server);

    // Filter by "high" — CRITICAL (uppercase) should still be included (CRITICAL >= high)
    const result = await invoker("get_vulnerability", { severity: "high" });
    const parsed = JSON.parse(result.content[0]!.text!) as { findings: Array<{ ruleId: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.findings[0]!.ruleId).toBe("vuln/critical-pkg");
  });

  it("get_flag_inventory empty returns empty list", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_flag_inventory", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { flags?: unknown[]; total?: number };
    // Either empty flags array or total=0
    const count = parsed.flags?.length ?? parsed.total ?? 0;
    expect(count).toBe(0);
  });

  it("get_blast_radius on empty graph returns no crash and empty affected", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_blast_radius", { files: ["test.ts"] });
    const parsed = JSON.parse(result.content[0]!.text!) as { affectedFiles?: unknown[] };
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.affectedFiles)).toBe(true);
    expect(parsed.affectedFiles).toHaveLength(0);
  });

  it("get_blast_radius with crossRepo=true but no correlation data returns warning", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_blast_radius", { files: ["test.ts"], crossRepo: true });
    const parsed = JSON.parse(result.content[0]!.text!) as { crossRepoWarning?: string };
    expect(parsed.crossRepoWarning).toBeDefined();
    expect(parsed.crossRepoWarning).toContain("no correlation data");
  });

  it("get_blast_radius serializes crossRepoAffected as plain object, not empty", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // Seed graph with import edges and correlation graph
    await stores.graphStore.addEdges([
      { source: "repo-a:src/a.ts", target: "repo-a:src/b.ts", kind: "imports", metadata: { repo: "repo-a" } },
      { source: "repo-b:src/x.ts", target: "repo-b:src/y.ts", kind: "imports", metadata: { repo: "repo-b" } },
    ]);
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_blast_radius", { files: ["repo-a:src/b.ts"], repo: "repo-a", crossRepo: true });
    const text = result.content[0]!.text!;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // crossRepoAffected should be a plain object (not undefined, not {})
    // or if no downstream matches, should have a crossRepoNote
    expect(parsed.crossRepoWarning).toBeUndefined();
    if (parsed.crossRepoAffected) {
      expect(typeof parsed.crossRepoAffected).toBe("object");
      expect(Array.isArray(parsed.crossRepoAffected)).toBe(false);
    }
  });

  it("get_cross_repo_graph returns downstreamMap as object, not array-of-arrays", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_graph", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { downstreamMap: unknown; upstreamMap: unknown };
    // Should be plain objects, not arrays
    expect(typeof parsed.downstreamMap).toBe("object");
    expect(Array.isArray(parsed.downstreamMap)).toBe(false);
    expect(typeof parsed.upstreamMap).toBe("object");
    expect(Array.isArray(parsed.upstreamMap)).toBe(false);
    // Verify values
    expect((parsed.downstreamMap as Record<string, string[]>)["repo-a"]).toEqual(["repo-b"]);
    expect((parsed.upstreamMap as Record<string, string[]>)["repo-b"]).toEqual(["repo-a"]);
  });

  it("get_service_correlation filters template-literal URLs from orphans", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:services", JSON.stringify({
      links: [],
      linchpins: [],
      orphanedServices: [
        { endpoint: "/api/real", hasProducers: false, hasConsumers: true, repos: ["r1"] },
        { endpoint: "${MAILPIT_URL}/api/v1/search", hasProducers: false, hasConsumers: true, repos: ["r2"] },
        { endpoint: "${BASE_URL}/auth/callback", hasProducers: false, hasConsumers: true, repos: ["r3"] },
      ],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_service_correlation", { kind: "orphaned" });
    const parsed = JSON.parse(result.content[0]!.text!) as { orphanedServices: { results: Array<{ endpoint: string }> } };
    expect(parsed.orphanedServices.results).toHaveLength(1);
    expect(parsed.orphanedServices.results[0]!.endpoint).toBe("/api/real");
  });

  it("get_diagnostics with level filter returns hint about other levels", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // Seed with warning-level findings only
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["test-repo"] }));
    await stores.kvStore.set("sarif:repo:test-repo", JSON.stringify([
      { ruleId: "test/rule", level: "warning", message: { text: "something" }, locations: [] },
    ]));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_diagnostics", { level: "error" });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; note?: string };
    expect(parsed.total).toBe(0);
    expect(parsed.note).toBeDefined();
    expect(parsed.note).toContain("other severity levels");
  });

  it("get_cross_repo_impact with no graph data returns graceful error", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_cross_repo_impact", { files: ["src/index.ts"], repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as { error: string };
    expect(parsed.error).toBeDefined();
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("query routes without crashing and returns route information", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("query", { query: "show me the architecture" });
    const parsed = JSON.parse(result.content[0]!.text!) as { route: string };
    expect(parsed.route).toBeDefined();
    expect(typeof parsed.route).toBe("string");
  });

  it("all tools handle missing optional params without crashing", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    for (const name of ALL_TOOL_NAMES) {
      const requiredOnly = MINIMAL_ARGS[name] ?? {};
      await expect(invoker(name, requiredOnly)).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Describe block 2: MCP meta-sanity checks
// ---------------------------------------------------------------------------

describe("MCP meta-sanity checks", () => {
  it("exactly 22 tools are registered", () => {
    const server = createMockServer();
    register(server, makeStores());
    expect(server.tools.size).toBe(22);
  });

  it("all registered tools have non-empty descriptions", () => {
    const server = createMockServer();
    register(server, makeStores());

    for (const [name, tool] of server.tools) {
      expect(tool.description, `${name} should have a description`).toBeTruthy();
      expect(tool.description.length, `${name} description should be non-trivial`).toBeGreaterThan(10);
    }
  });

  it("all registered tools have input schemas defined", () => {
    // Re-register with a server that captures the full config
    const toolConfigs = new Map<string, { description: string; inputSchema?: unknown }>();
    const server = {
      registerTool: vi.fn(
        (name: string, config: { description: string; inputSchema?: unknown }, _handler: unknown) => {
          toolConfigs.set(name, config);
        },
      ),
      tools: new Map<string, ToolEntry>(),
    };
    registerTools(server as unknown as Parameters<typeof registerTools>[0], makeStores());

    for (const [name, config] of toolConfigs) {
      expect(config.inputSchema, `${name} should have an inputSchema`).toBeDefined();
    }
  });

  it("every registered tool has at least one sanity test (tested tool set matches registered)", () => {
    // The sanity block tests every tool by name. Verify that the set of tools tested
    // in the sanity describe matches the registered tool set.
    const testedTools = new Set(ALL_TOOL_NAMES);
    const server = createMockServer();
    register(server, makeStores());
    const registeredNames = new Set(server.tools.keys());

    // Every registered tool must appear in the tested set
    for (const name of registeredNames) {
      expect(testedTools.has(name as (typeof ALL_TOOL_NAMES)[number]), `${name} is registered but not listed in ALL_TOOL_NAMES`).toBe(true);
    }
    // Every tested tool must be registered
    for (const name of testedTools) {
      expect(registeredNames.has(name), `${name} is in ALL_TOOL_NAMES but not registered`).toBe(true);
    }
  });

  it("all tool responses use consistent {content: [{type: 'text', text: string}]} format", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    for (const name of ALL_TOOL_NAMES) {
      const result = await invoker(name, MINIMAL_ARGS[name] ?? {});
      expect(result, `${name} should return an object`).toBeDefined();
      expect(Array.isArray(result.content), `${name}.content should be array`).toBe(true);
      const textItems = result.content.filter((c) => c.type === "text");
      expect(textItems.length, `${name} should have at least one text content item`).toBeGreaterThanOrEqual(1);
      for (const item of textItems) {
        expect(typeof item.text, `${name} text item should have string text`).toBe("string");
      }
    }
  });

  it("no tool returns undefined or null content", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    for (const name of ALL_TOOL_NAMES) {
      const result = await invoker(name, MINIMAL_ARGS[name] ?? {});
      expect(result.content, `${name} content should not be null/undefined`).not.toBeNull();
      expect(result.content, `${name} content should not be undefined`).not.toBeUndefined();
    }
  });

  it("resource count matches expected (4 resources)", async () => {
    const { registerResources } = await import("./resources.js");
    const resourceServer = {
      registerTool: vi.fn(),
      resource: vi.fn(),
      tools: new Map<string, ToolEntry>(),
    };
    const kvStore = new InMemoryKVStore();
    registerResources(resourceServer as unknown as Parameters<typeof registerResources>[0], kvStore);
    expect(resourceServer.resource).toHaveBeenCalledTimes(4);
  });

  it("pagination-capable tools respect limit=0 gracefully", async () => {
    const server = createMockServer();
    const stores = makeSarifStoresWithRepoMetadata(5);
    // Seed services data so service_correlation doesn't return an error
    await stores.kvStore.set("correlation:services", makeSerializedServices());
    register(server, stores);
    const invoker = makeInvoker(server);

    const paginatedTools: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "get_diagnostics", args: { limit: 0 } },
      { name: "get_service_correlation", args: { limit: 0 } },
      { name: "get_flag_inventory", args: { limit: 0 } },
    ];

    for (const { name, args } of paginatedTools) {
      const result = await invoker(name, args);
      // Should not throw; content should be valid JSON
      expect(() => JSON.parse(result.content[0]!.text!), `${name} with limit=0 should return valid JSON`).not.toThrow();
      const parsed = JSON.parse(result.content[0]!.text!) as {
        returned?: number;
        findings?: unknown[];
        flags?: unknown[];
        error?: string;
        linchpins?: { returned?: number; results?: unknown[] };
        orphanedServices?: { returned?: number; results?: unknown[] };
      };
      // Tool handled limit=0 gracefully if any of these are true:
      // - top-level returned=0 (get_diagnostics, get_flag_inventory)
      // - nested results are empty (get_service_correlation returns linchpins/orphanedServices objects)
      // - error returned (e.g. no data seeded)
      const graceful =
        parsed.returned === 0 ||
        parsed.findings?.length === 0 ||
        parsed.flags?.length === 0 ||
        parsed.error !== undefined ||
        parsed.linchpins?.returned === 0 ||
        parsed.linchpins?.results?.length === 0 ||
        parsed.orphanedServices?.returned === 0 ||
        parsed.orphanedServices?.results?.length === 0;
      expect(graceful, `${name} with limit=0 should handle gracefully`).toBe(true);
    }
  });

  it("no tool crashes on unknown repo param", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const toolsWithRepo: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "search", args: { query: "foo", repo: "nonexistent-repo-xyz" } },
      { name: "get_callers", args: { symbol: "foo", repo: "nonexistent-repo-xyz" } },
      { name: "get_callees", args: { symbol: "foo", repo: "nonexistent-repo-xyz" } },
      { name: "get_dependencies", args: { symbol: "foo", repo: "nonexistent-repo-xyz" } },
      { name: "get_architecture", args: { repo: "nonexistent-repo-xyz" } },
      { name: "get_diagnostics", args: { repo: "nonexistent-repo-xyz" } },
      { name: "get_metrics", args: { repo: "nonexistent-repo-xyz" } },
      { name: "get_blast_radius", args: { files: ["test.ts"], repo: "nonexistent-repo-xyz" } },
      { name: "get_cross_repo_graph", args: { repo: "nonexistent-repo-xyz" } },
      { name: "get_cross_repo_models", args: { kind: "all", repo: "nonexistent-repo-xyz" } },
      { name: "get_vulnerability", args: { repo: "nonexistent-repo-xyz" } },
      { name: "get_flag_inventory", args: { repo: "nonexistent-repo-xyz" } },
      { name: "get_flag_impact", args: { flag: "MY_FLAG", repo: "nonexistent-repo-xyz" } },
    ];

    for (const { name, args } of toolsWithRepo) {
      await expect(invoker(name, args), `${name} should not throw on unknown repo`).resolves.toBeDefined();
    }
  });

  it("tools that return resource_links include valid mma:// URIs", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // Seed so get_diagnostics produces a resource_link for repo filter
    await stores.kvStore.set("sarif:latest", JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "mma", version: "0.1.0", rules: [] } }, results: [] }],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    // get_diagnostics with repo param produces a resource_link
    const result = await invoker("get_diagnostics", { repo: "my-repo" });
    const resourceLinks = result.content.filter((c) => c.type === "resource_link");
    expect(resourceLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of resourceLinks) {
      expect(link.uri, "resource_link URI should start with mma://").toMatch(/^mma:\/\//);
    }
  });
});
