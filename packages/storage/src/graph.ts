/**
 * Graph store adapter.
 *
 * POC: SQLite with adjacency list tables.
 * Scale: Neo4j cluster.
 *
 * Stores: call graphs, dependency graphs, CFGs, fault trees, feature model relationships.
 */

import type { GraphEdge, EdgeKind } from "@mma/core";

export interface TraversalOptions {
  readonly maxDepth: number;
  readonly repo?: string;
}

export interface EdgeQueryOptions {
  readonly limit?: number;
}

export interface GraphStore {
  addEdges(edges: readonly GraphEdge[]): Promise<void>;
  getEdgesFrom(source: string, repo?: string): Promise<GraphEdge[]>;
  getEdgesTo(target: string, repo?: string): Promise<GraphEdge[]>;
  getEdgesByKind(kind: EdgeKind, repo?: string, options?: EdgeQueryOptions): Promise<GraphEdge[]>;
  /** Aggregate edge counts grouped by repo for a given kind, without loading edges into memory. */
  getEdgeCountsByKindAndRepo(kind: EdgeKind): Promise<Map<string, number>>;
  traverseBFS(start: string, options: number | TraversalOptions): Promise<GraphEdge[]>;
  clear(repo?: string): Promise<void>;
  close(): Promise<void>;
}

export interface GraphStoreOptions {
  readonly dbPath: string;
}

/**
 * In-memory graph store for POC and testing.
 * Replace with SQLite adapter for persistent POC, Neo4j for scale.
 */
export class InMemoryGraphStore implements GraphStore {
  private edges: GraphEdge[] = [];

  async addEdges(edges: readonly GraphEdge[]): Promise<void> {
    this.edges.push(...edges);
  }

  async getEdgesFrom(source: string, repo?: string): Promise<GraphEdge[]> {
    return this.edges.filter((e) =>
      e.source === source && (!repo || e.metadata?.["repo"] === repo),
    );
  }

  async getEdgesTo(target: string, repo?: string): Promise<GraphEdge[]> {
    return this.edges.filter((e) =>
      e.target === target && (!repo || e.metadata?.["repo"] === repo),
    );
  }

  async getEdgesByKind(kind: EdgeKind, repo?: string, options?: EdgeQueryOptions): Promise<GraphEdge[]> {
    const filtered = this.edges.filter((e) =>
      e.kind === kind && (!repo || e.metadata?.["repo"] === repo),
    );
    return options?.limit ? filtered.slice(0, options.limit) : filtered;
  }

  async getEdgeCountsByKindAndRepo(kind: EdgeKind): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const e of this.edges) {
      if (e.kind !== kind) continue;
      const repo = (e.metadata?.["repo"] as string) ?? "unknown";
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    return counts;
  }

  async traverseBFS(start: string, options: number | TraversalOptions): Promise<GraphEdge[]> {
    const { maxDepth, repo } = typeof options === "number"
      ? { maxDepth: options, repo: undefined }
      : options;
    const visited = new Set<string>();
    const result: GraphEdge[] = [];
    const queue: Array<{ node: string; depth: number }> = [
      { node: start, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.node) || current.depth > maxDepth) continue;
      visited.add(current.node);

      const outEdges = this.edges.filter((e) =>
        e.source === current.node && (!repo || e.metadata?.["repo"] === repo),
      );
      for (const edge of outEdges) {
        result.push(edge);
        if (!visited.has(edge.target)) {
          queue.push({ node: edge.target, depth: current.depth + 1 });
        }
      }
    }

    return result;
  }

  async clear(repo?: string): Promise<void> {
    if (repo) {
      this.edges = this.edges.filter(
        (e) => e.metadata?.["repo"] !== repo,
      );
    } else {
      this.edges = [];
    }
  }

  async close(): Promise<void> {
    this.edges = [];
  }
}
