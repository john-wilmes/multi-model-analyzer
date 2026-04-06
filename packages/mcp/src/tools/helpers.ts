import type { GraphStore, SearchStore, KVStore } from "@mma/storage";
import type { CrossRepoGraph } from "@mma/correlation";

export interface IndexRepoResult {
  readonly hadChanges: boolean;
  readonly totalFiles: number;
  readonly totalSarifResults: number;
}

export interface Stores {
  readonly graphStore: GraphStore;
  readonly searchStore: SearchStore;
  readonly kvStore: KVStore;
  readonly mirrorDir?: string;
  readonly indexRepo?: (repoConfig: { name: string; localPath: string; bare: boolean }) => Promise<IndexRepoResult>;
}

export type ContentItem =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; description?: string };
export type ToolResult = { content: ContentItem[] };

export function jsonResult(data: unknown, resourceLinks?: Array<{ uri: string; name: string; description?: string }>, hints?: string[]): ToolResult {
  let payload: unknown = data;
  if (hints && hints.length > 0) {
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      payload = { ...(data as Record<string, unknown>), _hints: hints };
    } else {
      payload = { result: data, _hints: hints };
    }
  }
  const content: ContentItem[] = [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }];
  if (resourceLinks) {
    for (const link of resourceLinks) {
      content.push({ type: "resource_link" as const, ...link });
    }
  }
  return { content };
}

export function paginated<T>(items: readonly T[], offset: number, limit: number): { total: number; returned: number; offset: number; hasMore: boolean; results: T[] } {
  const page = items.slice(offset, offset + limit);
  return { total: items.length, returned: page.length, offset, hasMore: offset + limit < items.length, results: page };
}

export function deserializeGraph(raw: {
  edges: CrossRepoGraph["edges"];
  repoPairs: string[];
  downstreamMap: [string, string[]][];
  upstreamMap: [string, string[]][];
}): CrossRepoGraph {
  return {
    edges: raw.edges,
    repoPairs: new Set(raw.repoPairs),
    downstreamMap: new Map(raw.downstreamMap.map(([k, v]) => [k, new Set(v)])),
    upstreamMap: new Map(raw.upstreamMap.map(([k, v]) => [k, new Set(v)])),
  };
}
