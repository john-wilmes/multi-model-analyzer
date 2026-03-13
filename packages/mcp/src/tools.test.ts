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
    const parsed = JSON.parse(result.content[0]!.text) as { total: number; results: Array<{ ruleId: string }> };
    expect(parsed.total).toBe(1);
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
