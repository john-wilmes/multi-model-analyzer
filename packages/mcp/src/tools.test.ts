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

describe("registerTools", () => {
  it("registers all expected tools", () => {
    const server = createMockServer();
    register(server, makeStores());

    const expectedTools = [
      "query", "search", "get_callers", "get_callees",
      "get_dependencies", "get_architecture", "get_diagnostics",
      "get_metrics", "get_blast_radius",
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
