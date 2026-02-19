/**
 * SQLite-backed graph store.
 *
 * Bulk inserts use transactions (74k edges = one fsync).
 * BFS is application-level with indexed source lookups and a JS visited Set.
 */

import type Database from "better-sqlite3";
import type { GraphEdge, EdgeKind } from "@mma/core";
import type { GraphStore, TraversalOptions } from "./graph.js";

export class SqliteGraphStore implements GraphStore {
  private readonly stmtInsert: Database.Statement;
  private readonly stmtBySource: Database.Statement;
  private readonly stmtBySourceAndRepo: Database.Statement;
  private readonly stmtByTarget: Database.Statement;
  private readonly stmtByTargetAndRepo: Database.Statement;
  private readonly stmtByKind: Database.Statement;
  private readonly stmtClearAll: Database.Statement;
  private readonly stmtClearRepo: Database.Statement;
  private readonly stmtBfsNoRepo: Database.Statement;
  private readonly stmtBfsWithRepo: Database.Statement;
  private readonly insertMany: Database.Transaction<
    (edges: readonly GraphEdge[]) => void
  >;

  constructor(db: Database.Database) {
    this.stmtInsert = db.prepare(
      "INSERT INTO edges (source, target, kind, metadata) VALUES (?, ?, ?, ?)",
    );
    this.stmtBySource = db.prepare(
      "SELECT source, target, kind, metadata FROM edges WHERE source = ?",
    );
    this.stmtBySourceAndRepo = db.prepare(
      "SELECT source, target, kind, metadata FROM edges WHERE source = ? AND json_extract(metadata, '$.repo') = ?",
    );
    this.stmtByTarget = db.prepare(
      "SELECT source, target, kind, metadata FROM edges WHERE target = ?",
    );
    this.stmtByTargetAndRepo = db.prepare(
      "SELECT source, target, kind, metadata FROM edges WHERE target = ? AND json_extract(metadata, '$.repo') = ?",
    );
    this.stmtByKind = db.prepare(
      "SELECT source, target, kind, metadata FROM edges WHERE kind = ?",
    );
    this.stmtClearAll = db.prepare("DELETE FROM edges");
    this.stmtClearRepo = db.prepare(
      "DELETE FROM edges WHERE json_extract(metadata, '$.repo') = ?",
    );

    // Recursive CTE for BFS traversal without repo filter
    // Params: (start, maxDepth, maxDepth)
    this.stmtBfsNoRepo = db.prepare(`
      WITH RECURSIVE bfs(node, depth) AS (
        VALUES (?, 0)
        UNION
        SELECT e.target, bfs.depth + 1
        FROM edges e
        JOIN bfs ON e.source = bfs.node
        WHERE bfs.depth < ?
      )
      SELECT DISTINCT e.source, e.target, e.kind, e.metadata
      FROM edges e
      JOIN bfs ON e.source = bfs.node
      WHERE bfs.depth <= ?
    `);

    // Recursive CTE for BFS traversal with repo filter
    // INDEXED BY forces SQLite to use the composite (source, repo) index
    // rather than the single-column repo index, which is 20x faster.
    // Params: (start, maxDepth, repoName, maxDepth, repoName)
    this.stmtBfsWithRepo = db.prepare(`
      WITH RECURSIVE bfs(node, depth) AS (
        VALUES (?, 0)
        UNION
        SELECT e.target, bfs.depth + 1
        FROM edges e INDEXED BY idx_edges_source_repo
        JOIN bfs ON e.source = bfs.node
        WHERE bfs.depth < ?
          AND json_extract(e.metadata, '$.repo') = ?
      )
      SELECT DISTINCT e.source, e.target, e.kind, e.metadata
      FROM edges e INDEXED BY idx_edges_source_repo
      JOIN bfs ON e.source = bfs.node
      WHERE bfs.depth <= ?
        AND json_extract(e.metadata, '$.repo') = ?
    `);

    this.insertMany = db.transaction((edges: readonly GraphEdge[]) => {
      for (const edge of edges) {
        const meta = edge.metadata ? JSON.stringify(edge.metadata) : null;
        this.stmtInsert.run(edge.source, edge.target, edge.kind, meta);
      }
    });
  }

  async addEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    this.insertMany(edges);
  }

  async getEdgesFrom(source: string, repo?: string): Promise<GraphEdge[]> {
    const rows = repo
      ? this.stmtBySourceAndRepo.all(source, repo) as RawEdgeRow[]
      : this.stmtBySource.all(source) as RawEdgeRow[];
    return rows.map(toGraphEdge);
  }

  async getEdgesTo(target: string, repo?: string): Promise<GraphEdge[]> {
    const rows = repo
      ? this.stmtByTargetAndRepo.all(target, repo) as RawEdgeRow[]
      : this.stmtByTarget.all(target) as RawEdgeRow[];
    return rows.map(toGraphEdge);
  }

  async getEdgesByKind(kind: EdgeKind): Promise<GraphEdge[]> {
    const rows = this.stmtByKind.all(kind) as RawEdgeRow[];
    return rows.map(toGraphEdge);
  }

  async traverseBFS(start: string, options: number | TraversalOptions): Promise<GraphEdge[]> {
    const { maxDepth, repo } = typeof options === "number"
      ? { maxDepth: options, repo: undefined }
      : options;

    const rows = repo
      ? this.stmtBfsWithRepo.all(start, maxDepth, repo, maxDepth, repo) as RawEdgeRow[]
      : this.stmtBfsNoRepo.all(start, maxDepth, maxDepth) as RawEdgeRow[];

    // Deduplicate edges by (source, target, kind) since the CTE UNION deduplicates
    // nodes by (node, depth) but the same edge can appear from different depth paths
    const seen = new Set<string>();
    const result: GraphEdge[] = [];
    for (const row of rows) {
      const key = `${row.source}\0${row.target}\0${row.kind}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(toGraphEdge(row));
      }
    }

    return result;
  }

  async clear(repo?: string): Promise<void> {
    if (repo) {
      this.stmtClearRepo.run(repo);
    } else {
      this.stmtClearAll.run();
    }
  }

  async close(): Promise<void> {
    // No-op: lifecycle managed by createSqliteStores()
  }
}

interface RawEdgeRow {
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
}

function toGraphEdge(row: RawEdgeRow): GraphEdge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    ...(row.metadata ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> } : {}),
  };
}
