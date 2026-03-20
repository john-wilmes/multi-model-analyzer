import { describe, it, expect, vi } from "vitest";
import { registerTools } from "./tools.js";
import type { Stores } from "./tools.js";
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
// search tool
// ---------------------------------------------------------------------------

describe("search", () => {
  it("returns empty results for fresh store", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("search")!.handler;
    const result = await handler({ query: "nonexistent" });
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; results: unknown[] };
    expect(parsed.total).toBe(0);
    expect(parsed.results).toHaveLength(0);
  });

  it("respects limit and offset for pagination", async () => {
    const server = createMockServer();
    register(server, makeStores());

    // Even on empty store, pagination metadata should be correct
    const handler = server.tools.get("search")!.handler;
    const result = await handler({ query: "foo", limit: 5, offset: 0 });
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; returned: number; offset: number };
    expect(parsed.total).toBe(0);
    expect(parsed.returned).toBe(0);
    expect(parsed.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// get_callers / get_callees
// ---------------------------------------------------------------------------

describe("get_callers", () => {
  it("returns an empty callers list when graph has no call edges", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_callers")!.handler;
    const result = await handler({ symbol: "MyService" });
    const parsed = JSON.parse(result.content[0]!.text) as { callers?: unknown[]; results?: unknown[] };
    // Handler may return callers array or results array — neither should be undefined
    const callers = parsed.callers ?? parsed.results ?? [];
    expect(Array.isArray(callers)).toBe(true);
    expect(callers).toHaveLength(0);
  });

  it("finds callers via graph edges", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.graphStore.addEdges([{
      source: "src/a.ts#callA",
      target: "src/b.ts#targetFn",
      kind: "calls",
      metadata: { repo: "repo-x" },
    }]);
    register(server, stores);

    const handler = server.tools.get("get_callers")!.handler;
    const result = await handler({ symbol: "targetFn", repo: "repo-x" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // The response should have some content (not an error object)
    expect(parsed).not.toHaveProperty("error");
  });
});

describe("get_callees", () => {
  it("returns an empty callees list when graph has no call edges", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_callees")!.handler;
    const result = await handler({ symbol: "MyService" });
    const parsed = JSON.parse(result.content[0]!.text) as { callees?: unknown[]; results?: unknown[] };
    const callees = parsed.callees ?? parsed.results ?? [];
    expect(Array.isArray(callees)).toBe(true);
    expect(callees).toHaveLength(0);
  });

  it("finds callees via graph edges", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.graphStore.addEdges([{
      source: "src/a.ts#callerFn",
      target: "src/b.ts#calleeFn",
      kind: "calls",
      metadata: { repo: "repo-x" },
    }]);
    register(server, stores);

    const handler = server.tools.get("get_callees")!.handler;
    const result = await handler({ symbol: "callerFn", repo: "repo-x" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// get_dependencies
// ---------------------------------------------------------------------------

describe("get_dependencies", () => {
  it("returns empty graph for unknown symbol", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_dependencies")!.handler;
    const result = await handler({ symbol: "nonexistent" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // Should not throw; returns something (empty edges, etc.)
    expect(parsed).toBeDefined();
  });

  it("traverses import edges up to maxDepth", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // A -> B -> C chain
    await stores.graphStore.addEdges([
      { source: "src/a.ts", target: "src/b.ts", kind: "imports", metadata: { repo: "repo-x" } },
      { source: "src/b.ts", target: "src/c.ts", kind: "imports", metadata: { repo: "repo-x" } },
    ]);
    register(server, stores);

    const handler = server.tools.get("get_dependencies")!.handler;
    const result = await handler({ symbol: "src/a.ts", repo: "repo-x", maxDepth: 2 });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// get_architecture
// ---------------------------------------------------------------------------

describe("get_architecture", () => {
  it("returns architecture data for empty stores without error", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_architecture")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // Should not throw; returns some kind of summary object
    expect(parsed).toBeDefined();
  });

  it("filters by repo when specified", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("correlation:graph", makeSerializedGraph());
    register(server, stores);

    const handler = server.tools.get("get_architecture")!.handler;
    const result = await handler({ repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// get_blast_radius
// ---------------------------------------------------------------------------

describe("get_blast_radius", () => {
  it("returns empty blast radius for unknown files", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_blast_radius")!.handler;
    const result = await handler({ files: ["src/nonexistent.ts"] });
    const parsed = JSON.parse(result.content[0]!.text) as { affectedFiles?: unknown[] };
    expect(Array.isArray(parsed.affectedFiles)).toBe(true);
    expect(parsed.affectedFiles).toHaveLength(0);
  });

  it("finds affected files via import edges", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // changed.ts is imported by downstream.ts
    await stores.graphStore.addEdges([{
      source: "src/downstream.ts",
      target: "src/changed.ts",
      kind: "imports",
      metadata: { repo: "repo-x" },
    }]);
    register(server, stores);

    const handler = server.tools.get("get_blast_radius")!.handler;
    const result = await handler({ files: ["src/changed.ts"], repo: "repo-x", maxDepth: 2 });
    const parsed = JSON.parse(result.content[0]!.text) as { affectedFiles: Array<{ path: string }> };
    expect(Array.isArray(parsed.affectedFiles)).toBe(true);
    // downstream.ts should appear in affected files
    const paths = parsed.affectedFiles.map((f) => f.path);
    expect(paths).toContain("src/downstream.ts");
  });

  it("expands cross-repo when crossRepo flag is true and no correlation data", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_blast_radius")!.handler;
    // Should not throw when crossRepo=true but no correlation data stored
    const result = await handler({ files: ["src/index.ts"], crossRepo: true });
    const parsed = JSON.parse(result.content[0]!.text) as { affectedFiles?: unknown[] };
    expect(Array.isArray(parsed.affectedFiles)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_vulnerability
// ---------------------------------------------------------------------------

describe("get_vulnerability", () => {
  it("returns empty findings when no index exists", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_vulnerability")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { findings: unknown[]; total: number };
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it("returns vulnerability findings when data exists", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["repo-vuln"] }));
    await stores.kvStore.set("sarif:vuln:repo-vuln", JSON.stringify([
      {
        ruleId: "vuln/lodash",
        level: "warning",
        message: { text: "lodash is vulnerable to prototype pollution" },
        properties: { severity: "high", packageName: "lodash", installedVersion: "4.17.15" },
      },
    ]));
    register(server, stores);

    const handler = server.tools.get("get_vulnerability")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { findings: Array<{ ruleId: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.findings[0]!.ruleId).toBe("vuln/lodash");
  });

  it("filters by minimum severity", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["repo-vuln"] }));
    await stores.kvStore.set("sarif:vuln:repo-vuln", JSON.stringify([
      {
        ruleId: "vuln/low-pkg",
        level: "note",
        message: { text: "low severity issue" },
        properties: { severity: "low" },
      },
      {
        ruleId: "vuln/high-pkg",
        level: "warning",
        message: { text: "high severity issue" },
        properties: { severity: "high" },
      },
    ]));
    register(server, stores);

    const handler = server.tools.get("get_vulnerability")!.handler;
    const result = await handler({ severity: "high" });
    const parsed = JSON.parse(result.content[0]!.text) as { findings: Array<{ ruleId: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.findings[0]!.ruleId).toBe("vuln/high-pkg");
  });

  it("filters by repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["repo-a", "repo-b"] }));
    await stores.kvStore.set("sarif:vuln:repo-a", JSON.stringify([
      { ruleId: "vuln/a", level: "warning", message: { text: "vuln in a" }, properties: { severity: "high" } },
    ]));
    await stores.kvStore.set("sarif:vuln:repo-b", JSON.stringify([
      { ruleId: "vuln/b", level: "warning", message: { text: "vuln in b" }, properties: { severity: "moderate" } },
    ]));
    register(server, stores);

    const handler = server.tools.get("get_vulnerability")!.handler;
    const result = await handler({ repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as { findings: Array<{ ruleId: string }>; total: number };
    expect(parsed.total).toBe(1);
    expect(parsed.findings[0]!.ruleId).toBe("vuln/a");
  });

  it("paginates results", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("sarif:latest:index", JSON.stringify({ repos: ["repo-vuln"] }));
    const findings = Array.from({ length: 5 }, (_, i) => ({
      ruleId: `vuln/pkg-${i}`,
      level: "warning",
      message: { text: `finding ${i}` },
      properties: { severity: "moderate" },
    }));
    await stores.kvStore.set("sarif:vuln:repo-vuln", JSON.stringify(findings));
    register(server, stores);

    const handler = server.tools.get("get_vulnerability")!.handler;
    const result = await handler({ limit: 2, offset: 1 });
    const parsed = JSON.parse(result.content[0]!.text) as { findings: unknown[]; total: number; offset: number; limit: number };
    expect(parsed.total).toBe(5);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.offset).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// get_flag_inventory
// ---------------------------------------------------------------------------

describe("get_flag_inventory", () => {
  it("returns empty when no flags are indexed", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_flag_inventory")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; flags?: unknown[] };
    expect(parsed.total).toBe(0);
  });

  it("returns flags when flags inventory data exists", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // getFlagInventory reads flags:* keys with FlagInventory format
    await stores.kvStore.set("flags:repo-flags", JSON.stringify({
      repo: "repo-flags",
      flags: [
        {
          name: "ENABLE_DARK_MODE",
          sdk: "custom",
          locations: [{ repo: "repo-flags", module: "src/theme.ts" }],
        },
      ],
    }));
    register(server, stores);

    const handler = server.tools.get("get_flag_inventory")!.handler;
    const result = await handler({});
    const parsed = JSON.parse(result.content[0]!.text) as { total: number };
    expect(parsed.total).toBeGreaterThan(0);
  });

  it("filters by repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    // getFlagInventory reads flags:* keys with FlagInventory format
    await stores.kvStore.set("flags:repo-a", JSON.stringify({
      repo: "repo-a",
      flags: [
        { name: "FLAG_A", locations: [{ repo: "repo-a", module: "src/a.ts" }] },
      ],
    }));
    await stores.kvStore.set("flags:repo-b", JSON.stringify({
      repo: "repo-b",
      flags: [
        { name: "FLAG_B", locations: [{ repo: "repo-b", module: "src/b.ts" }] },
      ],
    }));
    register(server, stores);

    const handler = server.tools.get("get_flag_inventory")!.handler;
    const result = await handler({ repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as { total: number };
    expect(parsed.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// get_flag_impact
// ---------------------------------------------------------------------------

describe("get_flag_impact", () => {
  it("returns empty impact for unknown flag", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_flag_impact")!.handler;
    const result = await handler({ flag: "UNKNOWN_FLAG", repo: "repo-x" });
    const parsed = JSON.parse(result.content[0]!.text) as {
      flagLocations: unknown[];
      affectedFiles: unknown[];
    };
    expect(Array.isArray(parsed.flagLocations)).toBe(true);
    expect(Array.isArray(parsed.affectedFiles)).toBe(true);
  });

  it("includes crossRepo error when crossRepo=true and no correlation data", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_flag_impact")!.handler;
    const result = await handler({ flag: "MY_FLAG", repo: "repo-x", crossRepo: true });
    const parsed = JSON.parse(result.content[0]!.text) as {
      flagLocations: unknown[];
      crossRepo?: { error: string };
    };
    // With no correlation data and crossRepo=true, should include crossRepo error field
    expect(parsed.crossRepo?.error).toContain("No correlation data");
  });
});

// ---------------------------------------------------------------------------
// get_metrics extended
// ---------------------------------------------------------------------------

describe("get_metrics extended", () => {
  it("returns resource_link for repo filter", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("metrics:repo-x", JSON.stringify([
      { module: "src/a.ts", instability: 0.5, abstractness: 0.3, distance: 0.2, afferentCoupling: 2, efferentCoupling: 2 },
    ]));
    register(server, stores);

    const handler = server.tools.get("get_metrics")!.handler;
    const result = await handler({ repo: "repo-x" });
    const link = result.content.find((c: { type: string }) => c.type === "resource_link");
    expect(link).toBeDefined();
    expect((link as unknown as { uri: string }).uri).toBe("mma://repo/repo-x/metrics");
  });

  it("filters by module path substring", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("metrics:repo-x", JSON.stringify([
      { module: "src/auth/login.ts", instability: 0.1, abstractness: 0.2, distance: 0.7, afferentCoupling: 5, efferentCoupling: 1 },
      { module: "src/utils/helper.ts", instability: 0.9, abstractness: 0.0, distance: 0.1, afferentCoupling: 0, efferentCoupling: 9 },
    ]));
    register(server, stores);

    const handler = server.tools.get("get_metrics")!.handler;
    const result = await handler({ module: "auth" });
    // The handler spreads paginated() which uses 'results' key (not 'modules')
    const parsed = JSON.parse(result.content[0]!.text) as { moduleFilter: string; total: number; results: Array<{ module: string }> };
    expect(parsed.moduleFilter).toBe("auth");
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.module).toContain("auth");
  });

  it("paginates repo list when limit/offset provided", async () => {
    const server = createMockServer();
    const stores = makeStores();
    for (const r of ["repo-a", "repo-b", "repo-c"]) {
      await stores.kvStore.set(`metrics:${r}`, JSON.stringify([
        { module: "src/index.ts", instability: 0.5, abstractness: 0.5, distance: 0.0, afferentCoupling: 1, efferentCoupling: 1 },
      ]));
    }
    register(server, stores);

    const handler = server.tools.get("get_metrics")!.handler;
    const result = await handler({ limit: 2, offset: 0 });
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; returned: number };
    expect(parsed.total).toBe(3);
    expect(parsed.returned).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// get_cross_repo_models — features and faults branches
// ---------------------------------------------------------------------------

describe("get_cross_repo_models features and faults", () => {
  it("returns features when cross-repo:features key is seeded", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:features", JSON.stringify({
      sharedFlags: [
        { name: "ENABLE_PAYMENTS", repos: ["repo-a", "repo-b"], coordinated: true },
        { name: "ENABLE_DARK_MODE", repos: ["repo-c"], coordinated: false },
      ],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "features" });
    const parsed = JSON.parse(result.content[0]!.text) as { features: { results: Array<{ name: string }> } };
    expect(parsed.features.results).toHaveLength(2);
  });

  it("filters features by repo", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:features", JSON.stringify({
      sharedFlags: [
        { name: "ENABLE_PAYMENTS", repos: ["repo-a", "repo-b"], coordinated: true },
        { name: "ENABLE_DARK_MODE", repos: ["repo-c"], coordinated: false },
      ],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "features", repo: "repo-a" });
    const parsed = JSON.parse(result.content[0]!.text) as { features: { results: Array<{ name: string }> } };
    expect(parsed.features.results).toHaveLength(1);
    expect(parsed.features.results[0]!.name).toBe("ENABLE_PAYMENTS");
  });

  it("returns faults when cross-repo:faults key is seeded", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:faults", JSON.stringify({
      faultLinks: [
        { endpoint: "/api/users", sourceRepo: "repo-a", targetRepo: "repo-b" },
        { endpoint: "/api/orders", sourceRepo: "repo-b", targetRepo: "repo-c" },
      ],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "faults" });
    const parsed = JSON.parse(result.content[0]!.text) as { faults: { results: Array<{ endpoint: string }> } };
    expect(parsed.faults.results).toHaveLength(2);
  });

  it("filters faults by repo (source or target)", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:faults", JSON.stringify({
      faultLinks: [
        { endpoint: "/api/users", sourceRepo: "repo-a", targetRepo: "repo-b" },
        { endpoint: "/api/orders", sourceRepo: "repo-b", targetRepo: "repo-c" },
        { endpoint: "/api/other", sourceRepo: "repo-x", targetRepo: "repo-y" },
      ],
    }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "faults", repo: "repo-b" });
    const parsed = JSON.parse(result.content[0]!.text) as { faults: { results: Array<{ endpoint: string }> } };
    // repo-b is targetRepo of /api/users and sourceRepo of /api/orders
    expect(parsed.faults.results).toHaveLength(2);
  });

  it("returns error when no model data exists at all", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "all" });
    const parsed = JSON.parse(result.content[0]!.text) as { error: string };
    expect(parsed.error).toContain("No cross-repo model data");
  });

  it("returns all three sections with kind=all", async () => {
    const server = createMockServer();
    const stores = makeStores();
    await stores.kvStore.set("cross-repo:features", JSON.stringify({ sharedFlags: [] }));
    await stores.kvStore.set("cross-repo:faults", JSON.stringify({ faultLinks: [] }));
    await stores.kvStore.set("cross-repo:catalog", JSON.stringify({ entries: [] }));
    register(server, stores);

    const handler = server.tools.get("get_cross_repo_models")!.handler;
    const result = await handler({ kind: "all" });
    const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(parsed).toHaveProperty("features");
    expect(parsed).toHaveProperty("faults");
    expect(parsed).toHaveProperty("catalog");
  });
});

// ---------------------------------------------------------------------------
// query (natural language routing)
// ---------------------------------------------------------------------------

describe("query tool", () => {
  it("returns a routed result with route, confidence, and result fields", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("query")!.handler;
    const result = await handler({ query: "show me all diagnostics" });
    const parsed = JSON.parse(result.content[0]!.text) as {
      route: string;
      confidence: number;
      result: unknown;
    };
    expect(typeof parsed.route).toBe("string");
    expect(typeof parsed.confidence).toBe("number");
    expect(parsed.result).toBeDefined();
  });

  it("passes repo filter through to the routed handler", async () => {
    const server = createMockServer();
    register(server, makeStores());

    const handler = server.tools.get("query")!.handler;
    const result = await handler({ query: "find patterns", repo: "repo-z" });
    const parsed = JSON.parse(result.content[0]!.text) as { repo: string | null };
    expect(parsed.repo).toBe("repo-z");
  });
});

// ---------------------------------------------------------------------------
// resource callbacks
// ---------------------------------------------------------------------------

describe("resource callbacks", () => {
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

  it("repos resource returns empty list for fresh store", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const reposEntry = server.resources.get("repos");
    expect(reposEntry).toBeDefined();
    const fakeUri = new URL("mma://repos");
    const res = await reposEntry!.readCallback(fakeUri, {}) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { total: number; repos: string[] };
    expect(parsed.total).toBe(0);
    expect(parsed.repos).toHaveLength(0);
  });

  it("repos resource lists repos that have metrics", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    await kvStore.set("metrics:my-repo", JSON.stringify([]));
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const reposEntry = server.resources.get("repos");
    const fakeUri = new URL("mma://repos");
    const res = await reposEntry!.readCallback(fakeUri, {}) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { total: number; repos: string[] };
    expect(parsed.total).toBe(1);
    expect(parsed.repos).toContain("my-repo");
  });

  it("repo-findings resource returns error when no SARIF data", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const findingsEntry = server.resources.get("repo-findings");
    expect(findingsEntry).toBeDefined();
    const fakeUri = new URL("mma://repo/my-repo/findings");
    const res = await findingsEntry!.readCallback(fakeUri, { name: "my-repo" }) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { error: string };
    expect(parsed.error).toContain("No analysis results");
  });

  it("repo-findings resource returns filtered findings for a repo", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    await kvStore.set("sarif:latest", JSON.stringify({
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "mma", version: "0.1.0", rules: [] } },
        results: [
          {
            ruleId: "test/rule",
            level: "warning",
            message: { text: "Finding for repo-x" },
            locations: [{ logicalLocations: [{ fullyQualifiedName: "src/a.ts", properties: { repo: "repo-x" } }] }],
          },
          {
            ruleId: "other/rule",
            level: "note",
            message: { text: "Finding for repo-y" },
            locations: [{ logicalLocations: [{ fullyQualifiedName: "src/b.ts", properties: { repo: "repo-y" } }] }],
          },
        ],
      }],
    }));
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const findingsEntry = server.resources.get("repo-findings");
    const fakeUri = new URL("mma://repo/repo-x/findings");
    const res = await findingsEntry!.readCallback(fakeUri, { name: "repo-x" }) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { repo: string; total: number; results: Array<{ ruleId: string }> };
    expect(parsed.repo).toBe("repo-x");
    expect(parsed.total).toBe(1);
    expect(parsed.results[0]!.ruleId).toBe("test/rule");
  });

  it("repo-metrics resource returns error for unknown repo", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const metricsEntry = server.resources.get("repo-metrics");
    expect(metricsEntry).toBeDefined();
    const fakeUri = new URL("mma://repo/unknown/metrics");
    const res = await metricsEntry!.readCallback(fakeUri, { name: "unknown" }) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { error: string };
    expect(parsed.error).toContain("No metrics");
  });

  it("repo-metrics resource returns modules and summary when seeded", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    await kvStore.set("metrics:repo-x", JSON.stringify([
      { module: "src/index.ts", instability: 0.5, abstractness: 0.3, distance: 0.2, afferentCoupling: 2, efferentCoupling: 2 },
    ]));
    await kvStore.set("metricsSummary:repo-x", JSON.stringify({ avgInstability: 0.5, avgAbstractness: 0.3 }));
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const metricsEntry = server.resources.get("repo-metrics");
    const fakeUri = new URL("mma://repo/repo-x/metrics");
    const res = await metricsEntry!.readCallback(fakeUri, { name: "repo-x" }) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { repo: string; moduleCount: number; summary: unknown; modules: unknown[] };
    expect(parsed.repo).toBe("repo-x");
    expect(parsed.moduleCount).toBe(1);
    expect(parsed.summary).toBeDefined();
  });

  it("repo-patterns resource returns error for unknown repo", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const patternsEntry = server.resources.get("repo-patterns");
    expect(patternsEntry).toBeDefined();
    const fakeUri = new URL("mma://repo/unknown/patterns");
    const res = await patternsEntry!.readCallback(fakeUri, { name: "unknown" }) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { error: string };
    expect(parsed.error).toContain("No patterns");
  });

  it("repo-patterns resource returns patterns when seeded", async () => {
    const { registerResources } = await import("./resources.js");
    const server = createResourceMockServer();
    const kvStore = new InMemoryKVStore();
    await kvStore.set("patterns:repo-x", JSON.stringify([
      { kind: "singleton", location: "src/db.ts", confidence: 0.9 },
      { kind: "factory", location: "src/factory.ts", confidence: 0.8 },
    ]));
    registerResources(server as unknown as Parameters<typeof registerResources>[0], kvStore);

    const patternsEntry = server.resources.get("repo-patterns");
    const fakeUri = new URL("mma://repo/repo-x/patterns");
    const res = await patternsEntry!.readCallback(fakeUri, { name: "repo-x" }) as { contents: Array<{ text: string }> };
    const parsed = JSON.parse(res.contents[0]!.text) as { repo: string; total: number; patterns: unknown[] };
    expect(parsed.repo).toBe("repo-x");
    expect(parsed.total).toBe(2);
    expect(parsed.patterns).toHaveLength(2);
  });
});
