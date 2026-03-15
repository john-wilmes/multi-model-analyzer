/**
 * Kuzu-backed graph store.
 *
 * Phase 1: flat-edge emulation via a single NODE TABLE (Edge).
 * Kuzu's typed relationship tables require distinct source/target node tables,
 * so we store edges as node rows to keep schema-free flexibility identical to
 * the SQLite adapter.
 *
 * BFS is application-level because Kuzu's recursive traversal syntax only
 * works on typed relationship tables, not flat node tables.
 */

import type { GraphEdge, EdgeKind } from "@mma/core";
import type { GraphStore, TraversalOptions, EdgeQueryOptions } from "@mma/storage";
import kuzu from "kuzu";

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

const DDL = `
CREATE NODE TABLE IF NOT EXISTS Edge(
  id    SERIAL PRIMARY KEY,
  source   STRING,
  target   STRING,
  kind     STRING,
  metadata STRING,
  repo     STRING
)
`.trim();

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

/** Normalize executeSync's union return to a single QueryResult. */
function single(
  result: kuzu.QueryResult | kuzu.QueryResult[],
): kuzu.QueryResult {
  return Array.isArray(result) ? (result[0] as kuzu.QueryResult) : result;
}

const RETURN_COLS =
  "e.source AS source, e.target AS target, e.kind AS kind, e.metadata AS metadata";

// ---------------------------------------------------------------------------
// KuzuGraphStore
// ---------------------------------------------------------------------------

export class KuzuGraphStore implements GraphStore {
  private readonly conn: InstanceType<typeof kuzu.Connection>;

  // Prepared statements cached at construction time.
  private readonly stmtInsert: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtBySource: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtBySourceAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByTarget: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByTargetAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByKind: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByKindAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtCountByKindAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtClearAll: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtClearRepo: InstanceType<typeof kuzu.PreparedStatement>;
  // BFS per-node lookup (application-level traversal)
  private readonly stmtBfsStep: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtBfsStepWithRepo: InstanceType<typeof kuzu.PreparedStatement>;

  constructor(conn: InstanceType<typeof kuzu.Connection>) {
    this.conn = conn;

    // Ensure table exists
    conn.querySync(DDL);

    this.stmtInsert = conn.prepareSync(
      `CREATE (e:Edge {source: $s, target: $t, kind: $k, metadata: $m, repo: $r})`,
    );

    this.stmtBySource = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.source = $s RETURN ${RETURN_COLS}`,
    );
    this.stmtBySourceAndRepo = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.source = $s AND e.repo = $r RETURN ${RETURN_COLS}`,
    );

    this.stmtByTarget = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.target = $t RETURN ${RETURN_COLS}`,
    );
    this.stmtByTargetAndRepo = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.target = $t AND e.repo = $r RETURN ${RETURN_COLS}`,
    );

    this.stmtByKind = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.kind = $k RETURN ${RETURN_COLS}`,
    );
    this.stmtByKindAndRepo = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.kind = $k AND e.repo = $r RETURN ${RETURN_COLS}`,
    );

    this.stmtCountByKindAndRepo = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.kind = $k RETURN e.repo AS repo, count(e) AS cnt`,
    );

    this.stmtClearAll = conn.prepareSync(`MATCH (e:Edge) DELETE e`);
    this.stmtClearRepo = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.repo = $r DELETE e`,
    );

    // BFS step: fetch all outgoing edges from a single source node
    this.stmtBfsStep = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.source = $s RETURN ${RETURN_COLS}`,
    );
    this.stmtBfsStepWithRepo = conn.prepareSync(
      `MATCH (e:Edge) WHERE e.source = $s AND e.repo = $r RETURN ${RETURN_COLS}`,
    );
  }

  // -------------------------------------------------------------------------
  // addEdges
  // -------------------------------------------------------------------------

  async addEdges(edges: readonly GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    for (const edge of edges) {
      const repo = typeof edge.metadata?.["repo"] === "string"
        ? edge.metadata["repo"]
        : "";
      const meta = edge.metadata ? JSON.stringify(edge.metadata) : "";
      this.conn.executeSync(this.stmtInsert, {
        s: edge.source,
        t: edge.target,
        k: edge.kind,
        m: meta,
        r: repo,
      });
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
    // Kuzu does not support parameterised LIMIT, so we apply it in JS.
    // For very large result sets callers should apply their own pagination.
    const result = repo
      ? this.conn.executeSync(this.stmtByKindAndRepo, { k: kind, r: repo })
      : this.conn.executeSync(this.stmtByKind, { k: kind });

    const rows = single(result).getAllSync().map(toGraphEdge);
    return options?.limit !== undefined ? rows.slice(0, options.limit) : rows;
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
  // traverseBFS  (application-level, flat-table edition)
  // -------------------------------------------------------------------------

  async traverseBFS(
    start: string,
    options: number | TraversalOptions,
  ): Promise<GraphEdge[]> {
    const { maxDepth, repo } =
      typeof options === "number"
        ? { maxDepth: options, repo: undefined }
        : options;

    const visitedNodes = new Set<string>();
    const seenEdgeKeys = new Set<string>();
    const collected: GraphEdge[] = [];

    // Each entry is a node to expand at a given depth.
    let frontier: string[] = [start];
    visitedNodes.add(start);

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const node of frontier) {
        const result = repo
          ? this.conn.executeSync(this.stmtBfsStepWithRepo, { s: node, r: repo })
          : this.conn.executeSync(this.stmtBfsStep, { s: node });

        const edges = single(result).getAllSync().map(toGraphEdge);

        for (const edge of edges) {
          // Deduplicate edges
          const edgeKey = `${edge.source}\0${edge.target}\0${edge.kind}`;
          if (!seenEdgeKeys.has(edgeKey)) {
            seenEdgeKeys.add(edgeKey);
            collected.push(edge);
          }

          // Enqueue unvisited targets for next depth
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
