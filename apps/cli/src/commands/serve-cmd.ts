import { startServer } from "@mma/mcp";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";

export interface ServeOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly transport?: "stdio" | "http";
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  await startServer(options);
}
