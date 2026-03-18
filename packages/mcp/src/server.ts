import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

export interface ServerOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly transport?: "stdio" | "http"; // default: "stdio"
  readonly port?: number; // default: 3001
  readonly host?: string; // default: "127.0.0.1"
  readonly token?: string; // bearer token for HTTP auth
}

function createMcpServer(opts: ServerOptions): McpServer {
  const server = new McpServer({
    name: "mma",
    version: "0.1.0",
  });

  registerTools(server, opts);
  registerResources(server, opts.kvStore);

  return server;
}

async function startStdioServer(opts: ServerOptions): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Block until stdin closes (stdio transport lifecycle)
  await new Promise<void>((resolve) => {
    if (process.stdin.readableEnded) {
      resolve();
      return;
    }
    process.stdin.on("end", () => resolve());
  });
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const auth = req.headers["authorization"];
  return auth === `Bearer ${token}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function startHttpServer(opts: ServerOptions): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3001;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    // Route: only /mcp is handled
    if (url !== "/mcp") {
      sendJson(res, 404, { error: "Not Found" });
      return;
    }

    // Auth check
    if (!isAuthorized(req, opts.token)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "POST") {
      // Content-Type must be application/json
      const ct = req.headers["content-type"] ?? "";
      if (!ct.includes("application/json")) {
        sendJson(res, 415, { error: "Unsupported Media Type" });
        return;
      }

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }

      const server = createMcpServer(opts);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless mode: GET and DELETE are not supported
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed in stateless mode" },
        id: null,
      });
      return;
    }

    sendJson(res, 405, { error: "Method Not Allowed" });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.once("error", reject);
  });

  console.log(`MCP HTTP server listening on http://${host}:${port}/mcp`);

  // Graceful shutdown
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      httpServer.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function startServer(opts: ServerOptions): Promise<void> {
  if (opts.transport === "http") {
    await startHttpServer(opts);
  } else {
    await startStdioServer(opts);
  }
}
