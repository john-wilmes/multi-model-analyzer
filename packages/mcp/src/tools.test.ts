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
      "get_cross_repo_graph", "get_service_correlation", "get_cross_repo_impact",
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
