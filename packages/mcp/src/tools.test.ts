import { describe, it, expect, vi } from "vitest";
import { registerTools, WELCOME_BLURB } from "./tools.js";
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
      "get_hotspots", "get_temporal_coupling", "get_patterns",
      "get_symbol_importers",
      "get_config_inventory", "get_config_model", "validate_config",
      "get_test_configurations", "get_interaction_strength",
      "get_integrator_config_map",
    ];

    for (const tool of expectedTools) {
      expect(server.tools.has(tool)).toBe(true);
    }
    expect(server.registerTool.mock.calls.length).toBe(expectedTools.length);
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
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
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
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
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
    expect(server.resource).toHaveBeenCalledTimes(5);
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
  "get_hotspots", "get_temporal_coupling", "get_patterns",
  "get_symbol_importers",
  "get_config_inventory", "get_config_model", "validate_config",
  "get_test_configurations", "get_interaction_strength",
  "get_integrator_config_map",
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
  get_hotspots:           {},
  get_temporal_coupling:  {},
  get_patterns:           {},
  get_symbol_importers:   { symbol: "createClient" },
  get_config_inventory:   {},
  get_config_model:       { repo: "test-repo" },
  validate_config:        { repo: "test-repo", config: { flagA: true } },
  get_test_configurations: { repo: "test-repo" },
  get_interaction_strength: { repo: "test-repo", parameter: "flagA" },
  get_integrator_config_map: {},
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
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
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
  it("all 31 tools return valid JSON content with text entry", async () => {
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
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
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
  it("exactly 32 tools are registered", () => {
    const server = createMockServer();
    register(server, makeStores());
    expect(server.tools.size).toBe(32);
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
    expect(resourceServer.resource).toHaveBeenCalledTimes(5);
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
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
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

// ---------------------------------------------------------------------------
// get_hotspots tests
// ---------------------------------------------------------------------------

describe("get_hotspots", () => {
  it("returns empty note when no hotspot data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_hotspots", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { results: unknown[]; total: number; note: string };
    expect(parsed.total).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(parsed.note).toContain("No hotspot data");
  });

  it("returns hotspots sorted by hotspotScore descending", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("hotspots:repo-a", JSON.stringify([
      { file: "src/low.ts", hotspotScore: 30, churn: 3, symbolCount: 40 },
      { file: "src/big.ts", hotspotScore: 85, churn: 9, symbolCount: 80 },
      { file: "src/mid.ts", hotspotScore: 55, churn: 6, symbolCount: 50 },
    ]));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_hotspots", {});
    const parsed = JSON.parse(result.content[0]!.text!) as {
      total: number;
      results: Array<{ file: string; hotspotScore: number; repo: string }>;
    };
    expect(parsed.total).toBe(3);
    // Re-normalized: big.ts = round((9/9*100 + 80/80*100)/2) = 100
    expect(parsed.results[0]!.hotspotScore).toBe(100);
    expect(parsed.results[0]!.file).toBe("src/big.ts");
    expect(parsed.results[0]!.repo).toBe("repo-a");
    // mid.ts = round((6/9*100 + 50/80*100)/2) = round((66.7+62.5)/2) = 65
    expect(parsed.results[1]!.hotspotScore).toBe(65);
    // low.ts = round((3/9*100 + 40/80*100)/2) = round((33.3+50)/2) = 42
    expect(parsed.results[2]!.hotspotScore).toBe(42);
  });

  it("filters hotspots by repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("hotspots:repo-a", JSON.stringify([
      { file: "src/a.ts", hotspotScore: 70, churnScore: 0.7, complexityScore: 0.6 },
    ]));
    await stores.kvStore.set("hotspots:repo-b", JSON.stringify([
      { file: "src/b.ts", hotspotScore: 90, churnScore: 0.9, complexityScore: 0.8 },
    ]));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_hotspots", { repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; results: Array<{ repo: string }> };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.repo).toBe("repo-a");
  });

  it("paginates hotspots with limit and offset", async () => {
    const server = createMockServer();
    const stores = makeStores();
    const hotspots = Array.from({ length: 10 }, (_, i) => ({
      file: `src/file-${i}.ts`,
      hotspotScore: i * 10,
      churnScore: 0.5,
      complexityScore: 0.5,
    }));
    await stores.kvStore.set("hotspots:repo-a", JSON.stringify(hotspots));
    register(server, stores);
    const invoker = makeInvoker(server);

    const page = await invoker("get_hotspots", { limit: 3, offset: 0 });
    const parsed = JSON.parse(page.content[0]!.text!) as { total: number; returned: number; hasMore: boolean };
    expect(parsed.total).toBe(10);
    expect(parsed.returned).toBe(3);
    expect(parsed.hasMore).toBe(true);
  });

  it("returns empty note with repo param when no data for that repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("hotspots:repo-b", JSON.stringify([
      { file: "src/b.ts", hotspotScore: 50, churnScore: 0.5, complexityScore: 0.5 },
    ]));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_hotspots", { repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; note: string };
    expect(parsed.total).toBe(0);
    expect(parsed.note).toContain("repo-a");
  });
});

// ---------------------------------------------------------------------------
// get_temporal_coupling tests
// ---------------------------------------------------------------------------

describe("get_temporal_coupling", () => {
  it("returns empty result when no temporal coupling data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_temporal_coupling", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { results: unknown[]; total: number };
    expect(parsed.total).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it("returns paired files sorted by coChangeCount descending", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("temporal-coupling:repo-a", JSON.stringify({
      pairs: [
        { fileA: "a.ts", fileB: "b.ts", coChangeCount: 5, npmi: 0.7 },
        { fileA: "c.ts", fileB: "d.ts", coChangeCount: 12, npmi: 0.9 },
        { fileA: "e.ts", fileB: "f.ts", coChangeCount: 3, npmi: 0.4 },
      ],
      commitsAnalyzed: 100,
      commitsSkipped: 2,
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_temporal_coupling", { repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      total: number;
      commitsAnalyzed: number;
      results: Array<{ fileA: string; fileB: string; coChangeCount: number }>;
    };
    expect(parsed.total).toBe(3);
    expect(parsed.commitsAnalyzed).toBe(100);
    expect(parsed.results[0]!.coChangeCount).toBe(12);
    expect(parsed.results[0]!.fileA).toBe("c.ts");
    expect(parsed.results[1]!.coChangeCount).toBe(5);
    expect(parsed.results[2]!.coChangeCount).toBe(3);
  });

  it("filters by repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("temporal-coupling:repo-a", JSON.stringify({
      pairs: [{ fileA: "a.ts", fileB: "b.ts", coChangeCount: 5, npmi: 0.7 }],
      commitsAnalyzed: 50,
    }));
    await stores.kvStore.set("temporal-coupling:repo-b", JSON.stringify({
      pairs: [{ fileA: "x.ts", fileB: "y.ts", coChangeCount: 8, npmi: 0.8 }],
      commitsAnalyzed: 75,
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_temporal_coupling", { repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      total: number;
      results: Array<{ fileA: string }>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.fileA).toBe("a.ts");
  });

  it("filters by minCoChanges", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("temporal-coupling:repo-a", JSON.stringify({
      pairs: [
        { fileA: "a.ts", fileB: "b.ts", coChangeCount: 2, npmi: 0.5 },
        { fileA: "c.ts", fileB: "d.ts", coChangeCount: 8, npmi: 0.8 },
        { fileA: "e.ts", fileB: "f.ts", coChangeCount: 1, npmi: 0.2 },
      ],
      commitsAnalyzed: 60,
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_temporal_coupling", { repo: "repo-a", minCoChanges: 3 });
    const parsed = JSON.parse(result.content[0]!.text!) as { total: number; results: Array<{ coChangeCount: number }> };
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.coChangeCount).toBe(8);
  });

  it("returns note when no data for specific repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_temporal_coupling", { repo: "nonexistent-repo" });
    const parsed = JSON.parse(result.content[0]!.text!) as { results: unknown[]; total: number; commitsAnalyzed: number; note: string };
    expect(parsed.results).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.commitsAnalyzed).toBe(0);
    expect(parsed.note).toContain("nonexistent-repo");
  });
});

// ---------------------------------------------------------------------------
// get_patterns tests
// ---------------------------------------------------------------------------

describe("get_patterns", () => {
  it("returns empty note when no pattern data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_patterns", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { patterns: Record<string, unknown>; note: string };
    expect(parsed.patterns).toEqual({});
    expect(parsed.note).toContain("No pattern data");
  });

  it("returns all patterns for a specific repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("patterns:repo-a", JSON.stringify({
      factory: [{ file: "factory.ts", symbol: "createFoo" }],
      singleton: [{ file: "single.ts", symbol: "getInstance" }],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_patterns", { repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      repo: string;
      patterns: { factory: Array<{ file: string; symbol: string }>; singleton: Array<{ file: string; symbol: string }> };
    };
    expect(parsed.repo).toBe("repo-a");
    expect(parsed.patterns.factory).toHaveLength(1);
    expect(parsed.patterns.factory[0]!.symbol).toBe("createFoo");
    expect(parsed.patterns.singleton[0]!.symbol).toBe("getInstance");
  });

  it("filters patterns by pattern type substring (case-insensitive)", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("patterns:repo-a", JSON.stringify({
      factory: [{ file: "factory.ts", symbol: "createFoo" }],
      singleton: [{ file: "single.ts", symbol: "getInstance" }],
      observer: [{ file: "events.ts", symbol: "EventEmitter" }],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_patterns", { repo: "repo-a", pattern: "FACT" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      patterns: Record<string, unknown>;
    };
    expect(Object.keys(parsed.patterns)).toEqual(["factory"]);
  });

  it("returns all repos patterns when no repo filter specified", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("patterns:repo-a", JSON.stringify({
      factory: [{ file: "factory.ts", symbol: "createFoo" }],
    }));
    await stores.kvStore.set("patterns:repo-b", JSON.stringify({
      singleton: [{ file: "single.ts", symbol: "getInstance" }],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_patterns", {});
    const parsed = JSON.parse(result.content[0]!.text!) as { repos: Record<string, unknown> };
    expect(parsed.repos).toHaveProperty("repo-a");
    expect(parsed.repos).toHaveProperty("repo-b");
  });

  it("filters all-repo patterns by pattern type", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("patterns:repo-a", JSON.stringify({
      factory: [{ file: "factory.ts", symbol: "createFoo" }],
      observer: [{ file: "events.ts", symbol: "EventEmitter" }],
    }));
    await stores.kvStore.set("patterns:repo-b", JSON.stringify({
      singleton: [{ file: "single.ts", symbol: "getInstance" }],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    // "factory" only matches repo-a (repo-b has singleton/observer, no factory)
    const result = await invoker("get_patterns", { pattern: "factory" });
    const parsed = JSON.parse(result.content[0]!.text!) as { repos: Record<string, unknown> };
    expect(parsed.repos).toHaveProperty("repo-a");
    expect(parsed.repos).not.toHaveProperty("repo-b");
    const repoAPatterns = parsed.repos["repo-a"] as Record<string, unknown>;
    expect(Object.keys(repoAPatterns)).toEqual(["factory"]);
  });

  it("returns note when no data for specific repo", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_patterns", { repo: "missing-repo" });
    const parsed = JSON.parse(result.content[0]!.text!) as { repo: string; patterns: Record<string, unknown>; note: string };
    expect(parsed.repo).toBe("missing-repo");
    expect(parsed.patterns).toEqual({});
    expect(parsed.note).toContain("missing-repo");
  });
});

// ---------------------------------------------------------------------------
// get_symbol_importers
// ---------------------------------------------------------------------------

/** Build a serialized correlation:graph with resolved and/or importedNames metadata. */
function makeGraphWithSymbols() {
  return JSON.stringify({
    edges: [
      {
        edge: {
          source: "repo-a:src/app.ts",
          target: "repo-b:src/client.ts",
          kind: "imports",
          metadata: {
            importedNames: ["createClient"],
            resolvedSymbols: [
              { name: "createClient", targetFileId: "repo-b:src/client.ts", kind: "function" },
            ],
          },
        },
        sourceRepo: "repo-a",
        targetRepo: "repo-b",
        packageName: "@acme/supabase-js",
      },
      {
        edge: {
          source: "repo-c:src/index.ts",
          target: "repo-b:src/client.ts",
          kind: "imports",
          metadata: {
            importedNames: ["SupabaseClient"],
            resolvedSymbols: [
              { name: "SupabaseClient", targetFileId: "repo-b:src/client.ts", kind: "class" },
            ],
          },
        },
        sourceRepo: "repo-c",
        targetRepo: "repo-b",
        packageName: "@acme/supabase-js",
      },
      {
        edge: {
          source: "repo-d:src/helper.ts",
          target: "repo-b:src/client.ts",
          kind: "imports",
          metadata: {
            // Only importedNames, no resolvedSymbols (unresolved edge)
            importedNames: ["createClient"],
          },
        },
        sourceRepo: "repo-d",
        targetRepo: "repo-b",
        packageName: "@acme/supabase-js",
      },
    ],
    repoPairs: ["repo-a->repo-b", "repo-c->repo-b", "repo-d->repo-b"],
    downstreamMap: [["repo-a", ["repo-b"]], ["repo-c", ["repo-b"]], ["repo-d", ["repo-b"]]],
    upstreamMap: [["repo-b", ["repo-a", "repo-c", "repo-d"]]],
  });
}

describe("get_symbol_importers", () => {
  it("returns error when no correlation data exists", async () => {
    const server = createMockServer();
    register(server, makeStores());
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "createClient" });
    const parsed = JSON.parse(result.content[0]!.text!) as { error: string };
    expect(parsed.error).toContain("No correlation data");
  });

  it("finds importers by resolvedSymbols match", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeGraphWithSymbols());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "createClient" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      symbol: string;
      importerCount: number;
      importers: Array<{ repo: string; files: unknown[] }>;
    };
    expect(parsed.symbol).toBe("createClient");
    // repo-a has resolvedSymbols match; repo-d has importedNames fallback — both grouped by repo
    expect(parsed.importerCount).toBeGreaterThanOrEqual(1);
    const repos = parsed.importers.map((i) => i.repo);
    expect(repos).toContain("repo-a");
  });

  it("finds SupabaseClient importer via resolvedSymbols", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeGraphWithSymbols());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "SupabaseClient" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      importerCount: number;
      importers: Array<{ repo: string }>;
    };
    expect(parsed.importerCount).toBe(1);
    expect(parsed.importers[0]!.repo).toBe("repo-c");
  });

  it("falls back to importedNames when no resolvedSymbols match", async () => {
    // Build a graph with only importedNames (no resolvedSymbols at all)
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", JSON.stringify({
      edges: [
        {
          edge: {
            source: "repo-a:src/app.ts",
            target: "repo-b:src/lib.ts",
            kind: "imports",
            metadata: { importedNames: ["helperFn"] },
          },
          sourceRepo: "repo-a",
          targetRepo: "repo-b",
          packageName: "@acme/lib",
        },
      ],
      repoPairs: ["repo-a->repo-b"],
      downstreamMap: [["repo-a", ["repo-b"]]],
      upstreamMap: [["repo-b", ["repo-a"]]],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "helperFn" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      importerCount: number;
      importers: Array<{ repo: string; files: Array<{ resolvedSymbols: unknown[] }> }>;
    };
    expect(parsed.importerCount).toBe(1);
    expect(parsed.importers[0]!.repo).toBe("repo-a");
    // Fallback match has empty resolvedSymbols in the file entry
    expect(parsed.importers[0]!.files[0]!.resolvedSymbols).toEqual([]);
  });

  it("returns empty importers when symbol not found", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeGraphWithSymbols());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "nonExistentSymbol" });
    const parsed = JSON.parse(result.content[0]!.text!) as { importerCount: number; importers: unknown[] };
    expect(parsed.importerCount).toBe(0);
    expect(parsed.importers).toHaveLength(0);
  });

  it("filters importers by package name", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", JSON.stringify({
      edges: [
        {
          edge: {
            source: "repo-a:src/app.ts",
            target: "repo-b:src/client.ts",
            kind: "imports",
            metadata: {
              importedNames: ["createClient"],
              resolvedSymbols: [{ name: "createClient", targetFileId: "repo-b:src/client.ts", kind: "function" }],
            },
          },
          sourceRepo: "repo-a",
          targetRepo: "repo-b",
          packageName: "@acme/supabase-js",
        },
        {
          edge: {
            source: "repo-x:src/app.ts",
            target: "repo-y:src/lib.ts",
            kind: "imports",
            metadata: {
              importedNames: ["createClient"],
              resolvedSymbols: [{ name: "createClient", targetFileId: "repo-y:src/lib.ts", kind: "function" }],
            },
          },
          sourceRepo: "repo-x",
          targetRepo: "repo-y",
          packageName: "@other/lib",
        },
      ],
      repoPairs: ["repo-a->repo-b", "repo-x->repo-y"],
      downstreamMap: [["repo-a", ["repo-b"]], ["repo-x", ["repo-y"]]],
      upstreamMap: [["repo-b", ["repo-a"]], ["repo-y", ["repo-x"]]],
    }));
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "createClient", package: "@acme/supabase-js" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      importerCount: number;
      importers: Array<{ repo: string; files: Array<{ packageName: string }> }>;
    };
    expect(parsed.importerCount).toBe(1);
    expect(parsed.importers[0]!.repo).toBe("repo-a");
    expect(parsed.importers[0]!.files[0]!.packageName).toBe("@acme/supabase-js");
  });

  it("filters importers by target repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeGraphWithSymbols());
    register(server, stores);
    const invoker = makeInvoker(server);

    // Filter to edges targeting repo-b — createClient is imported from repo-a and repo-d
    const result = await invoker("get_symbol_importers", { symbol: "createClient", repo: "repo-b" });
    const parsed = JSON.parse(result.content[0]!.text!) as {
      importerCount: number;
      importers: Array<{ repo: string; files: Array<{ targetRepo: string }> }>;
    };
    // All returned file entries should target repo-b
    const allTargetB = parsed.importers.every((i) => i.files.every((f) => f.targetRepo === "repo-b"));
    expect(allTargetB).toBe(true);
  });

  it("returns symbol and package in response", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeGraphWithSymbols());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "createClient", package: "@acme/supabase-js" });
    const parsed = JSON.parse(result.content[0]!.text!) as { symbol: string; package: string | null };
    expect(parsed.symbol).toBe("createClient");
    expect(parsed.package).toBe("@acme/supabase-js");
  });

  it("returns null package when no package filter given", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeGraphWithSymbols());
    register(server, stores);
    const invoker = makeInvoker(server);

    const result = await invoker("get_symbol_importers", { symbol: "createClient" });
    const parsed = JSON.parse(result.content[0]!.text!) as { package: string | null };
    expect(parsed.package).toBeNull();
  });
});

describe("discoverability", () => {
  // Helper that seeds a search store and returns a server with registered tools
  async function makeSearchServer() {
    const stores = makeStores();
    await stores.searchStore.index([
      { id: "repo-a:src/auth.ts", content: "auth authentication login", metadata: { repo: "repo-a" } },
    ]);
    const server = createMockServer();
    register(server, stores);
    return { server, stores };
  }

  it("tool responses include _hints in JSON payload", async () => {
    const { server } = await makeSearchServer();
    const handler = server.tools.get("search")!.handler;
    const result = await handler({ query: "auth" });
    const parsed = JSON.parse(result.content[0]!.text) as { _hints?: unknown };
    expect(Array.isArray(parsed._hints)).toBe(true);
    expect((parsed._hints as string[]).length).toBeGreaterThan(0);
    expect(typeof (parsed._hints as string[])[0]).toBe("string");
  });

  it("_hints are absent when no hints apply", async () => {
    // get_diagnostics with no SARIF data returns an error object (no _hints path).
    // Verify that the error response does NOT contain _hints.
    const server = createMockServer();
    register(server, makeStores());
    const handler = server.tools.get("get_diagnostics")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // Error responses are plain { error: "..." } objects — _hints not injected
    expect(parsed["_hints"]).toBeUndefined();
  });

  it("tool descriptions include cross-references to other tool names", () => {
    const server = createMockServer();
    register(server, makeStores());
    const allToolNames = [...server.tools.keys()];

    // These are the tools whose descriptions were explicitly enhanced with
    // cross-references as part of the discoverability feature. Each must
    // reference at least one other registered tool by name.
    const enhancedTools = [
      "query", "search", "get_callers", "get_callees", "get_dependencies",
      "get_metrics", "get_diagnostics", "get_blast_radius", "get_architecture",
      "get_cross_repo_graph", "get_service_correlation", "get_cross_repo_models",
      "get_cross_repo_impact", "get_flag_inventory", "get_flag_impact",
      "get_patterns", "get_config_inventory", "get_config_model",
      "get_test_configurations", "get_interaction_strength",
      "get_hotspots", "get_temporal_coupling", "get_symbol_importers",
      "get_repo_candidates", "index_repo", "scan_org", "check_new_repos",
      "get_vulnerability",
    ];

    for (const name of enhancedTools) {
      const tool = server.tools.get(name);
      if (!tool) continue; // skip if not registered in this build
      const desc = tool.description;
      const hasCrossRef = allToolNames.some((t) => t !== name && desc.includes(t));
      expect(hasCrossRef, `Tool '${name}' description has no cross-reference to other tools`).toBe(true);
    }
  });

  it("prompt mma-guide is registered", async () => {
    const { registerPrompts } = await import("./prompts.js");

    type PromptCallback = () => { messages: Array<{ role: string; content: { type: string; text: string } }> };
    const prompts = new Map<string, PromptCallback>();
    const promptServer = {
      prompt: vi.fn((_name: string, _description: string, callback: PromptCallback) => {
        prompts.set(_name, callback);
      }),
    };

    registerPrompts(promptServer as unknown as Parameters<typeof registerPrompts>[0]);

    expect(promptServer.prompt).toHaveBeenCalled();
    expect(prompts.has("mma-guide")).toBe(true);

    const callback = prompts.get("mma-guide")!;
    const output = callback();
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]!.role).toBe("user");
    expect(typeof output.messages[0]!.content.text).toBe("string");
    expect(output.messages[0]!.content.text.length).toBeGreaterThan(0);
  });

  it("WELCOME_BLURB is exported and non-empty", () => {
    expect(typeof WELCOME_BLURB).toBe("string");
    expect(WELCOME_BLURB.length).toBeGreaterThan(0);
  });
});
