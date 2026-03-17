/**
 * Kuzu-backed graph store.
 *
 * Uses native Kuzu graph schema: Symbol node table + 7 typed relationship
 * tables (one per EdgeKind). Enables native Cypher recursive traversal for BFS.
 */

import type { GraphEdge, EdgeKind } from "@mma/core";
import type { GraphStore, TraversalOptions, EdgeQueryOptions } from "@mma/storage";
import kuzu from "kuzu";
import { single } from "./kuzu-common.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps EdgeKind to its Kuzu relationship table name. */
const EDGE_TABLE: Record<EdgeKind, string> = {
  "calls": "Calls",
  "imports": "Imports",
  "extends": "Extends",
  "implements": "Implements",
  "depends-on": "DependsOn",
  "contains": "Contains",
  "service-call": "ServiceCall",
};

/** All EdgeKind values in a stable order. */
const ALL_EDGE_KINDS: EdgeKind[] = [
  "calls", "imports", "extends", "implements",
  "depends-on", "contains", "service-call",
];

/** Reverse mapping: table name → EdgeKind. */
const TABLE_TO_KIND: Record<string, EdgeKind> = Object.fromEntries(
  ALL_EDGE_KINDS.map((k) => [EDGE_TABLE[k], k]),
) as Record<string, EdgeKind>;

/** Multi-label pattern for matching all edge types in Cypher. */
const ALL_LABELS = ALL_EDGE_KINDS.map((k) => EDGE_TABLE[k]).join("|");

/** Base return columns (kind is added per-query as a literal). */
const RETURN_BASE = "s.id AS source, t.id AS target, r.metadata AS metadata";

// ---------------------------------------------------------------------------
// Helpers
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
  const rawKind = row["kind"] as string;
  return {
    source: row["source"] as string,
    target: row["target"] as string,
    kind: (TABLE_TO_KIND[rawKind] ?? rawKind) as EdgeKind,
    ...(metadata ? { metadata } : {}),
  };
}

function buildUnionAll(
  template: (table: string, kind: EdgeKind) => string,
): string {
  return ALL_EDGE_KINDS
    .map((k) => template(EDGE_TABLE[k], k))
    .join(" UNION ALL ");
}

// ---------------------------------------------------------------------------
// KuzuGraphStore
// ---------------------------------------------------------------------------

export class KuzuGraphStore implements GraphStore {
  private readonly conn: InstanceType<typeof kuzu.Connection>;

  // Prepared statements cached at construction time.
  private readonly stmtMergeSymbol: InstanceType<typeof kuzu.PreparedStatement>;

  // Per-kind prepared statements
  private readonly stmtInsertEdge: Map<EdgeKind, InstanceType<typeof kuzu.PreparedStatement>>;
  private readonly stmtByKind: Map<EdgeKind, InstanceType<typeof kuzu.PreparedStatement>>;
  private readonly stmtByKindAndRepo: Map<EdgeKind, InstanceType<typeof kuzu.PreparedStatement>>;
  private readonly stmtCountByKindAndRepo: Map<EdgeKind, InstanceType<typeof kuzu.PreparedStatement>>;
  private readonly stmtClearKind: Map<EdgeKind, InstanceType<typeof kuzu.PreparedStatement>>;

  // Lazily-cached prepared statements for getEdgesByKind with LIMIT
  private readonly stmtByKindLimited: Map<string, InstanceType<typeof kuzu.PreparedStatement>>;

  // Cross-kind UNION ALL statements
  private readonly stmtBySource: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtBySourceAndRepo: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByTarget: InstanceType<typeof kuzu.PreparedStatement>;
  private readonly stmtByTargetAndRepo: InstanceType<typeof kuzu.PreparedStatement>;

  // Clear all (DETACH DELETE)
  private readonly stmtClearAll: InstanceType<typeof kuzu.PreparedStatement>;

  // Delete edges sourced from a specific file (by exact id or id# prefix), per kind
  private readonly stmtDeleteByFileAndRepo: Map<EdgeKind, InstanceType<typeof kuzu.PreparedStatement>>;

  constructor(conn: InstanceType<typeof kuzu.Connection>) {
    this.conn = conn;

    // Schema is owned by initSchema() in kuzu-common.ts — no DDL here.

    this.stmtMergeSymbol = conn.prepareSync(
      "MERGE (s:Symbol {id: $id})",
    );

    // Per-kind maps
    this.stmtInsertEdge = new Map();
    this.stmtByKind = new Map();
    this.stmtByKindAndRepo = new Map();
    this.stmtCountByKindAndRepo = new Map();
    this.stmtClearKind = new Map();
    this.stmtDeleteByFileAndRepo = new Map();
    this.stmtByKindLimited = new Map();

    for (const kind of ALL_EDGE_KINDS) {
      const table = EDGE_TABLE[kind];

      this.stmtInsertEdge.set(
        kind,
        conn.prepareSync(
          `MATCH (s:Symbol {id: $s}), (t:Symbol {id: $t}) CREATE (s)-[:${table} {metadata: $m, repo: $r}]->(t)`,
        ),
      );

      this.stmtByKind.set(
        kind,
        conn.prepareSync(
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) RETURN ${RETURN_BASE}, '${kind}' AS kind`,
        ),
      );

      this.stmtByKindAndRepo.set(
        kind,
        conn.prepareSync(
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) WHERE r.repo = $r RETURN ${RETURN_BASE}, '${kind}' AS kind`,
        ),
      );

      this.stmtCountByKindAndRepo.set(
        kind,
        conn.prepareSync(
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) RETURN r.repo AS repo, count(r) AS cnt`,
        ),
      );

      this.stmtClearKind.set(
        kind,
        conn.prepareSync(
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) WHERE r.repo = $r DELETE r`,
        ),
      );

      this.stmtDeleteByFileAndRepo.set(
        kind,
        conn.prepareSync(
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) WHERE r.repo = $r AND (s.id = $fp OR s.id STARTS WITH $pfx) DELETE r`,
        ),
      );
    }

    // UNION ALL statements for cross-kind queries
    this.stmtBySource = conn.prepareSync(
      buildUnionAll(
        (table, kind) =>
          `MATCH (s:Symbol {id: $s})-[r:${table}]->(t:Symbol) RETURN ${RETURN_BASE}, '${kind}' AS kind`,
      ),
    );

    this.stmtBySourceAndRepo = conn.prepareSync(
      buildUnionAll(
        (table, kind) =>
          `MATCH (s:Symbol {id: $s})-[r:${table}]->(t:Symbol) WHERE r.repo = $r RETURN ${RETURN_BASE}, '${kind}' AS kind`,
      ),
    );

    this.stmtByTarget = conn.prepareSync(
      buildUnionAll(
        (table, kind) =>
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol {id: $t}) RETURN ${RETURN_BASE}, '${kind}' AS kind`,
      ),
    );

    this.stmtByTargetAndRepo = conn.prepareSync(
      buildUnionAll(
        (table, kind) =>
          `MATCH (s:Symbol)-[r:${table}]->(t:Symbol {id: $t}) WHERE r.repo = $r RETURN ${RETURN_BASE}, '${kind}' AS kind`,
      ),
    );

    this.stmtClearAll = conn.prepareSync(
      "MATCH (s:Symbol) DETACH DELETE s",
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

      // Pass 2: CREATE relationships dispatched by kind
      for (const edge of edges) {
        const repo =
          typeof edge.metadata?.["repo"] === "string"
            ? edge.metadata["repo"]
            : "";
        const meta = edge.metadata ? JSON.stringify(edge.metadata) : "";
        const stmt = this.stmtInsertEdge.get(edge.kind)!;
        this.conn.executeSync(stmt, {
          s: edge.source,
          t: edge.target,
          m: meta,
          r: repo,
        });
      }
      this.conn.querySync("COMMIT");
    } catch (e) {
      this.conn.querySync("ROLLBACK");
      throw new Error("Kuzu addEdges failed", { cause: e });
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
    const table = EDGE_TABLE[kind];

    if (options?.limit !== undefined) {
      // Kuzu does not support parameterised LIMIT; interpolate the number
      // directly. `limit` is always a number (type-enforced), so this is safe.
      const cacheKey = `${kind}:${repo ?? ""}:${options.limit}`;
      let stmt = this.stmtByKindLimited.get(cacheKey);
      if (!stmt) {
        const limitClause = `LIMIT ${options.limit}`;
        const cypher = repo
          ? `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) WHERE r.repo = $r RETURN ${RETURN_BASE}, '${kind}' AS kind ${limitClause}`
          : `MATCH (s:Symbol)-[r:${table}]->(t:Symbol) RETURN ${RETURN_BASE}, '${kind}' AS kind ${limitClause}`;
        stmt = this.conn.prepareSync(cypher);
        this.stmtByKindLimited.set(cacheKey, stmt);
      }
      const result = repo
        ? this.conn.executeSync(stmt, { r: repo })
        : this.conn.executeSync(stmt, {});
      return single(result).getAllSync().map(toGraphEdge);
    }

    const result = repo
      ? this.conn.executeSync(this.stmtByKindAndRepo.get(kind)!, { r: repo })
      : this.conn.executeSync(this.stmtByKind.get(kind)!, {});
    return single(result).getAllSync().map(toGraphEdge);
  }

  // -------------------------------------------------------------------------
  // getEdgeCountsByKindAndRepo
  // -------------------------------------------------------------------------

  async getEdgeCountsByKindAndRepo(kind: EdgeKind): Promise<Map<string, number>> {
    const result = this.conn.executeSync(this.stmtCountByKindAndRepo.get(kind)!, {});
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
   * Uses multi-label pattern to traverse all 7 typed edge tables.
   * label(rs[i]) returns the table name, which toGraphEdge maps to EdgeKind.
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
        `-[e:${ALL_LABELS}*1..${maxDepth} (r, _ | WHERE r.repo = '${safeRepo}')]->` +
        `(end:Symbol) ` +
        `WITH nodes(path) AS ns, rels(path) AS rs ` +
        `UNWIND range(0, size(rs)-1) AS i ` +
        `RETURN DISTINCT ns[i].id AS source, ns[i+1].id AS target, ` +
        `label(rs[i]) AS kind, rs[i].metadata AS metadata`;
    } else {
      cypher =
        `MATCH path = (start:Symbol {id: $start})` +
        `-[:${ALL_LABELS}*1..${maxDepth}]->` +
        `(end:Symbol) ` +
        `WITH nodes(path) AS ns, rels(path) AS rs ` +
        `UNWIND range(0, size(rs)-1) AS i ` +
        `RETURN DISTINCT ns[i].id AS source, ns[i+1].id AS target, ` +
        `label(rs[i]) AS kind, rs[i].metadata AS metadata`;
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
      for (const kind of ALL_EDGE_KINDS) {
        this.conn.executeSync(this.stmtClearKind.get(kind)!, { r: repo });
      }
    } else {
      this.conn.executeSync(this.stmtClearAll, {});
    }
  }

  // -------------------------------------------------------------------------
  // deleteEdgesForFiles
  // -------------------------------------------------------------------------

  async deleteEdgesForFiles(repo: string, filePaths: readonly string[]): Promise<void> {
    if (filePaths.length === 0) return;
    this.conn.querySync("BEGIN TRANSACTION");
    try {
      for (const fp of filePaths) {
        const canonicalFile = repo + ":" + fp;
        const pfx = canonicalFile + "#";
        for (const kind of ALL_EDGE_KINDS) {
          this.conn.executeSync(this.stmtDeleteByFileAndRepo.get(kind)!, { r: repo, fp: canonicalFile, pfx });
        }
      }
      this.conn.querySync("COMMIT");
    } catch (e) {
      this.conn.querySync("ROLLBACK");
      throw new Error("Kuzu deleteEdgesForFiles failed", { cause: e });
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
