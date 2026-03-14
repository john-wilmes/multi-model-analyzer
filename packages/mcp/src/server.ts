import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

export interface ServerOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const server = new McpServer({
    name: "mma",
    version: "0.1.0",
  });

  registerTools(server, opts);
  registerResources(server, opts.kvStore);

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
