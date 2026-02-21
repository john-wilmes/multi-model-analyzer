import { startServer } from "@mma/mcp";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";

export interface ServeOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  await startServer(options);
}
