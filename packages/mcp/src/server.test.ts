import { describe, it, expect, afterEach } from "vitest";
import {
  InMemoryGraphStore,
  InMemorySearchStore,
  InMemoryKVStore,
} from "@mma/storage";
import { startHttpServerForTest, type HttpServerHandle } from "./server.js";
import type { ServerOptions } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStores() {
  return {
    graphStore: new InMemoryGraphStore(),
    searchStore: new InMemorySearchStore(),
    kvStore: new InMemoryKVStore(),
  };
}

function baseOpts(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    ...makeStores(),
    transport: "http",
    host: "127.0.0.1",
    port: 0, // OS assigns a free port; read back from handle.port
    ...overrides,
  };
}

/** Minimal MCP initialize request body (JSON-RPC 2.0). */
function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    },
  });
}

/** POST /mcp with the given options and return the Response. */
async function postMcp(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      // MCP Streamable HTTP spec requires Accept to include both types
      "Accept": "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle: track servers started per test so we can always close them
// ---------------------------------------------------------------------------

const openHandles: HttpServerHandle[] = [];

afterEach(async () => {
  // Close all servers opened during the test, swallowing errors (already closed)
  await Promise.allSettled(openHandles.map((h) => h.close()));
  openHandles.length = 0;
});

async function startServer(opts: ServerOptions): Promise<HttpServerHandle> {
  const handle = await startHttpServerForTest(opts);
  openHandles.push(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Parse the first JSON payload from an SSE stream.
 * SSE lines look like: `data: {"jsonrpc":"2.0",...}\n\n`
 */
async function parseSseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  // Find first data: line and parse it
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice("data:".length).trim());
    }
  }
  // Fallback: try to parse whole text as JSON (direct JSON response)
  return JSON.parse(text);
}

describe("MCP HTTP transport — basic routing", () => {
  it("responds 200 to a valid initialize request and returns a JSON-RPC result", async () => {
    const opts = baseOpts();
    const handle = await startServer(opts);

    const res = await postMcp(handle.port, initializeBody());
    expect(res.status).toBe(200);

    // The MCP SDK responds via SSE stream; parse the first data line
    const json = await parseSseJson(res) as { jsonrpc?: string; result?: unknown; id?: number };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result).toBeDefined();
  });

  it("returns 404 for a path other than /mcp", async () => {
    const opts = baseOpts();
    const handle = await startServer(opts);

    const res = await fetch(`http://127.0.0.1:${handle.port}/other`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initializeBody(),
    });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Not Found");
  });

  it("returns 405 for GET /mcp in stateless mode", async () => {
    const opts = baseOpts();
    const handle = await startServer(opts);

    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "GET",
    });
    expect(res.status).toBe(405);
    const json = await res.json() as { error?: { message: string } };
    expect(json.error?.message).toContain("stateless");
  });

  it("returns 415 when Content-Type is not application/json", async () => {
    const opts = baseOpts();
    const handle = await startServer(opts);

    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: initializeBody(),
    });
    expect(res.status).toBe(415);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const opts = baseOpts();
    const handle = await startServer(opts);

    const res = await postMcp(handle.port, "not-json{{{");
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Invalid JSON");
  });
});

describe("MCP HTTP transport — authentication", () => {
  it("returns 401 when no Authorization header is sent and a token is configured", async () => {
    const opts = baseOpts({ token: "secret-token" });
    const handle = await startServer(opts);

    const res = await postMcp(handle.port, initializeBody());
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 401 when an incorrect bearer token is sent", async () => {
    const opts = baseOpts({ token: "secret-token" });
    const handle = await startServer(opts);

    const res = await postMcp(handle.port, initializeBody(), {
      Authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("accepts a correct bearer token and returns 200", async () => {
    const opts = baseOpts({ token: "secret-token" });
    const handle = await startServer(opts);

    const res = await postMcp(handle.port, initializeBody(), {
      Authorization: "Bearer secret-token",
    });
    expect(res.status).toBe(200);
  });

  it("allows all requests through when no token is configured", async () => {
    // No token field → isAuthorized always returns true
    const opts = baseOpts({ token: undefined });
    const handle = await startServer(opts);

    const res = await postMcp(handle.port, initializeBody());
    expect(res.status).toBe(200);
  });
});

describe("MCP HTTP transport — handle lifecycle", () => {
  it("exposes the correct port on the returned handle", async () => {
    const handle = await startServer(baseOpts());
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.host).toBe("127.0.0.1");
  });

  it("stops accepting connections after close() is called", async () => {
    const opts = baseOpts();
    const handle = await startServer(opts);
    // Verify the server is up
    const before = await postMcp(handle.port, initializeBody());
    expect(before.status).toBe(200);

    // Remove from openHandles so afterEach doesn't double-close
    const idx = openHandles.indexOf(handle);
    if (idx !== -1) openHandles.splice(idx, 1);

    await handle.close();

    // After close, fetch should throw (connection refused)
    await expect(postMcp(handle.port, initializeBody())).rejects.toThrow();
  });
});
