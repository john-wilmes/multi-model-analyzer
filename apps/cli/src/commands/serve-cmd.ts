import { startServer } from "@mma/mcp";
import type { IndexRepoResult } from "@mma/mcp";
import type { GraphStore, SearchStore, KVStore } from "@mma/storage";

export interface ServeOptions {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly transport?: "stdio" | "http";
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly mirrorDir?: string;
  readonly indexRepo?: (repoConfig: { name: string; localPath: string; bare: boolean }) => Promise<IndexRepoResult>;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  await startServer(options);
}
