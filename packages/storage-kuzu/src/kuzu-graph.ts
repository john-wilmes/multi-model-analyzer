/**
 * Kuzu-backed graph store.
 *
 * Uses native Kuzu graph schema: Symbol node table + Edge relationship table.
 * Enables native Cypher recursive traversal for BFS.
 */

import type { GraphEdge, EdgeKind } from "@mma/core";
import type { GraphStore, TraversalOptions, EdgeQueryOptions } from "@mma/storage";
import kuzu from "kuzu";
import { single } from "./kuzu-common.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function toGraphEdge(row: Record<string, unknown>): GraphEdge {
  let metadata: Record<string, unknown> | undefined;
  if (row["metadata"] && typeof row["metadata"] === "string") {
    try {
      metadata = JSON.parse(row["metadata"]) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    source: row["source"] as string,
    target: row["target"] as string,
    kind: row["kind"] as EdgeKind,
    ...(metadata ? { metadata } : {}),
  };
}

const RETURN_COLS =
  "s.id AS source, t.id AS target, r.kind AS kind, r.metadata AS metadata";

// ---------------------------------------------------------------------------
// KuzuGraphStore
// ---------------------------------------------------------------------------

export class KuzuGraphStore implements GraphStore {
  private readonly conn: InstanceType<typeof kuzu.Connection>;

  // Prepared statements cached at construction time.
  private readonly stmtMergeSymbol: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtInsertEdge: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtBySource: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtBySourceAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByTarget: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByTargetAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByKind: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByKindAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtCountByKindAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtClearAll: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtClearRepo: InstanceType<typeof kuzu.PreparedStatement>;

  constructor(conn: InstanceType<typeof kuzu.Connection>) {
    this.conn = conn;

    // Schema is owned by initSchema() in kuzu-common.ts — no DDL here.

    this.stmtMergeSymbol = conn.prepareSync(
      "MERGE (s:Symbol {id: $id})",
    );

    this.stmtInsertEdge = conn.prepareSync(
      "MATCH (s:Symbol {id: $s}), (t:Symbol {id: $t}) " +
        "CREATE (s)-[:Edge {kind: $k, metadata: $m, repo: $r}]->(t)",
    );

    this.stmtBySource = conn.prepareSync(
      `MATCH (s:Symbol {id: $s})-[r:Edge]->(t:Symbol) RETURN ${RETURN_COLS}`,
    );
    this.stmtBySourceAndRepo = conn.prepareSync(
      `MATCH (s:Symbol {id: $s})-[r:Edge]->(t:Symbol) WHERE r.repo = $r RETURN ${RETURN_COLS}`,
    );

    this.stmtByTarget = conn.prepareSync(
      `MATCH (s:Symbol)-[r:Edge]->(t:Symbol {id: $t}) RETURN ${RETURN_COLS}`,
    );
    this.stmtByTargetAndRepo = conn.prepareSync(
      `MATCH (s:Symbol)-[r:Edge]->(t:Symbol {id: $t}) WHERE r.repo = $r RETURN ${RETURN_COLS}`,
    );

    this.stmtByKind = conn.prepareSync(
      `MATCH (s:Symbol)-[r:Edge]->(t:Symbol) WHERE r.kind = $k RETURN ${RETURN_COLS}`,
    );
    this.stmtByKindAndRepo = conn.prepareSync(
      `MATCH (s:Symbol)-[r:Edge]->(t:Symbol) WHERE r.kind = $k AND r.repo = $r RETURN ${RETURN_COLS}`,
    );

    this.stmtCountByKindAndRepo = conn.prepareSync(
      "MATCH (s:Symbol)-[r:Edge]->(t:Symbol) WHERE r.kind = $k " +
        "RETURN r.repo AS repo, count(r) AS cnt",
    );

    this.stmtClearAll = conn.prepareSync(
      "MATCH (s:Symbol) DETACH DELETE s",
    );
    this.stmtClearRepo = conn.prepareSync(
      "MATCH (s:Symbol)-[r:Edge]->(t:Symbol) WHERE r.repo = $r DELETE r",
    );
  }

  // -------------------------------------------------------------------------
  // addEdges
  // -------------------------------------------------------------------------

  async addEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    this.conn.querySync("BEGIN TRANSACTION");
    try {
      // Pass 1: MERGE all unique symbol IDs
      const symbolIds = new Set<string>();
      for (const edge of edges) {
        symbolIds.add(edge.source);
        symbolIds.add(edge.target);
      }
      for (const id of symbolIds) {
        this.conn.executeSync(this.stmtMergeSymbol, { id });
      }

      // Pass 2: CREATE relationships
      for (const edge of edges) {
        const repo =
          typeof edge.metadata?.["repo"] === "string"
            ? edge.metadata["repo"]
            : "";
        const meta = edge.metadata ? JSON.stringify(edge.metadata) : "";
        this.conn.executeSync(this.stmtInsertEdge, {
          s: edge.source,
          t: edge.target,
          k: edge.kind,
          m: meta,
          r: repo,
        });
      }
      this.conn.querySync("COMMIT");
    } catch (e) {
      this.conn.querySync("ROLLBACK");
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // getEdgesFrom
  // -------------------------------------------------------------------------

  async getEdgesFrom(source: string, repo?: string): Promise<GraphEdge[]> {
    const result = repo
      ? this.conn.executeSync(this.stmtBySourceAndRepo, { s: source, r: repo })
      : this.conn.executeSync(this.stmtBySource, { s: source });
    return single(result).getAllSync().map(toGraphEdge);
  }

  // -------------------------------------------------------------------------
  // getEdgesTo
  // -------------------------------------------------------------------------

  async getEdgesTo(target: string, repo?: string): Promise<GraphEdge[]> {
    const result = repo
      ? this.conn.executeSync(this.stmtByTargetAndRepo, { t: target, r: repo })
      : this.conn.executeSync(this.stmtByTarget, { t: target });
    return single(result).getAllSync().map(toGraphEdge);
  }

  // -------------------------------------------------------------------------
  // getEdgesByKind
  // -------------------------------------------------------------------------

  async getEdgesByKind(
    kind: EdgeKind,
    repo?: string,
    options?: EdgeQueryOptions,
  ): Promise<GraphEdge[]> {
    if (options?.limit !== undefined) {
      // Kuzu does not support parameterised LIMIT; interpolate the number
      // directly. `limit` is always a number (type-enforced), so this is safe.
      const limitClause = `LIMIT ${options.limit}`;
      const cypher = repo
        ? `MATCH (s:Symbol)-[r:Edge]->(t:Symbol) WHERE r.kind = $k AND r.repo = $r RETURN ${RETURN_COLS} ${limitClause}`
        : `MATCH (s:Symbol)-[r:Edge]->(t:Symbol) WHERE r.kind = $k RETURN ${RETURN_COLS} ${limitClause}`;
      const stmt = this.conn.prepareSync(cypher);
      const result = repo
        ? this.conn.executeSync(stmt, { k: kind, r: repo })
        : this.conn.executeSync(stmt, { k: kind });
      return single(result).getAllSync().map(toGraphEdge);
    }

    const result = repo
      ? this.conn.executeSync(this.stmtByKindAndRepo, { k: kind, r: repo })
      : this.conn.executeSync(this.stmtByKind, { k: kind });
    return single(result).getAllSync().map(toGraphEdge);
  }

  // -------------------------------------------------------------------------
  // getEdgeCountsByKindAndRepo
  // -------------------------------------------------------------------------

  async getEdgeCountsByKindAndRepo(kind: EdgeKind): Promise<Map<string, number>> {
    const result = this.conn.executeSync(this.stmtCountByKindAndRepo, { k: kind });
    const rows = single(result).getAllSync() as Array<Record<string, unknown>>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const repo = typeof row["repo"] === "string" && row["repo"].length > 0
        ? row["repo"]
        : "unknown";
      const cnt = typeof row["cnt"] === "number" ? row["cnt"] : Number(row["cnt"]);
      counts.set(repo, cnt);
    }
    return counts;
  }

  // -------------------------------------------------------------------------
  // traverseBFS  (native recursive Cypher with application-level fallback)
  // -------------------------------------------------------------------------

  async traverseBFS(
    start: string,
    options: number | TraversalOptions,
  ): Promise<GraphEdge[]> {
    const { maxDepth, repo } =
      typeof options === "number"
        ? { maxDepth: options, repo: undefined }
        : options;

    if (maxDepth <= 0) return [];

    try {
      return this.traverseBFSNative(start, maxDepth, repo);
    } catch {
      // Fall back to application-level BFS if native recursive traversal
      // fails (e.g., Kuzu version doesn't support the path syntax).
      return this.traverseBFSFallback(start, maxDepth, repo);
    }
  }

  /**
   * Native recursive BFS via Kuzu's variable-length relationship patterns.
   * Single Cypher query replaces the N+1 application-level loop.
   */
  private traverseBFSNative(
    start: string,
    maxDepth: number,
    repo?: string,
  ): GraphEdge[] {
    let cypher: string;
    if (repo) {
      const safeRepo = repo.replace(/'/g, "''");
      cypher =
        `MATCH path = (start:Symbol {id: $start})` +
        `-[e:Edge*1..${maxDepth} (r, _ | WHERE r.repo = '${safeRepo}')]->` +
        `(end:Symbol) ` +
        `WITH nodes(path) AS ns, rels(path) AS rs ` +
        `UNWIND range(0, size(rs)-1) AS i ` +
        `RETURN DISTINCT ns[i].id AS source, ns[i+1].id AS target, ` +
        `rs[i].kind AS kind, rs[i].metadata AS metadata`;
    } else {
      cypher =
        `MATCH path = (start:Symbol {id: $start})` +
        `-[:Edge*1..${maxDepth}]->` +
        `(end:Symbol) ` +
        `WITH nodes(path) AS ns, rels(path) AS rs ` +
        `UNWIND range(0, size(rs)-1) AS i ` +
        `RETURN DISTINCT ns[i].id AS source, ns[i+1].id AS target, ` +
        `rs[i].kind AS kind, rs[i].metadata AS metadata`;
    }

    const stmt = this.conn.prepareSync(cypher);
    const result = this.conn.executeSync(stmt, { start });
    return single(result).getAllSync().map(toGraphEdge);
  }

  /** Application-level BFS fallback using single-hop queries. */
  private traverseBFSFallback(
    start: string,
    maxDepth: number,
    repo?: string,
  ): GraphEdge[] {
    const visitedNodes = new Set<string>();
    const seenEdgeKeys = new Set<string>();
    const collected: GraphEdge[] = [];

    let frontier: string[] = [start];
    visitedNodes.add(start);

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const node of frontier) {
        const result = repo
          ? this.conn.executeSync(this.stmtBySourceAndRepo, {
              s: node,
              r: repo,
            })
          : this.conn.executeSync(this.stmtBySource, { s: node });

        const edges = single(result).getAllSync().map(toGraphEdge);

        for (const edge of edges) {
          const edgeKey = `${edge.source}\0${edge.target}\0${edge.kind}`;
          if (!seenEdgeKeys.has(edgeKey)) {
            seenEdgeKeys.add(edgeKey);
            collected.push(edge);
          }

          if (!visitedNodes.has(edge.target)) {
            visitedNodes.add(edge.target);
            nextFrontier.push(edge.target);
          }
        }
      }

      frontier = nextFrontier;
    }

    return collected;
  }

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  async clear(repo?: string): Promise<void> {
    if (repo) {
      this.conn.executeSync(this.stmtClearRepo, { r: repo });
    } else {
      this.conn.executeSync(this.stmtClearAll, {});
    }
  }

  // -------------------------------------------------------------------------
  // close  (no-op — lifecycle owned by factory / caller)
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    // No-op: the Kuzu Database and Connection objects are owned by the factory
    // that constructed this store. Closing them here would invalidate shared
    // connections in multi-store setups.
  }
}
