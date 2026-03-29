import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js"; // source: prompts.ts
import { runWakeUpCheck } from "./wake-up.js";

export interface IndexRepoResult {
  readonly hadChanges: boolean;
  readonly totalFiles: number;
  readonly totalSarifResults: number;
}

export interface ServerOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly transport?: "stdio" | "http"; // default: "stdio"
  readonly port?: number; // default: 3001
  readonly host?: string; // default: "127.0.0.1"
  readonly token?: string; // bearer token for HTTP auth
  readonly mirrorDir?: string; // directory for bare clones (default: "./mirrors")
  /** Optional callback to run the full indexing pipeline for a single repo. */
  readonly indexRepo?: (repoConfig: { name: string; localPath: string; bare: boolean }) => Promise<IndexRepoResult>;
}

function createMcpServer(opts: ServerOptions, { enableWelcome = false } = {}): McpServer {
  const server = new McpServer({
    name: "mma",
    version: "0.1.0",
  });

  registerTools(server, opts, { welcomeOnFirstCall: enableWelcome });
  registerResources(server, opts.kvStore);
  registerPrompts(server);

  return server;
}

function fireWakeUpCheck(kvStore: ServerOptions["kvStore"]): void {
  void runWakeUpCheck(kvStore).then(result => {
    if (result.totalNewRepos > 0) {
      console.error(`[wake-up] Found ${result.totalNewRepos} new repo(s) across ${result.orgsChecked} org(s)`);
      for (const r of result.results) {
        if (r.newRepos.length > 0) {
          console.error(`  ${r.org}: +${r.newRepos.length} (${r.newRepos.map(n => n.name).join(", ")})`);
        }
      }
    }
  }).catch(err => {
    console.error("[wake-up] Check failed:", err instanceof Error ? err.message : err);
  });
}

async function startStdioServer(opts: ServerOptions): Promise<void> {
  const server = createMcpServer(opts, { enableWelcome: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  fireWakeUpCheck(opts.kvStore);

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

export interface HttpServerHandle {
  /** Close the HTTP server and resolve when all connections are drained. */
  close(): Promise<void>;
  readonly port: number;
  readonly host: string;
}

async function startHttpServer(opts: ServerOptions): Promise<HttpServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3001;

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async handler with internal error handling
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

  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;

  console.log(`MCP HTTP server listening on http://${host}:${actualPort}/mcp`);
  fireWakeUpCheck(opts.kvStore);

  return {
    port: actualPort,
    host,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function startServer(opts: ServerOptions): Promise<void> {
  if (opts.transport === "http") {
    const handle = await startHttpServer(opts);
    // Block until SIGINT/SIGTERM for the CLI use-case
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        void handle.close().then(resolve);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } else {
    await startStdioServer(opts);
  }
}

/**
 * Start the HTTP server and return a handle for programmatic use (e.g. tests).
 * The caller is responsible for calling `handle.close()` when done.
 */
export async function startHttpServerForTest(opts: ServerOptions): Promise<HttpServerHandle> {
  return startHttpServer(opts);
}
